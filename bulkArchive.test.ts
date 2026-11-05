import { describe, expect, test } from 'bun:test';
import {
  ARCHIVE_AGE_OPTIONS,
  bulkArchiveTargets,
  isQuietlyArchivable,
  isSessionBusy,
  sessionStatusAnswer,
  staleScheduledRuns,
} from './src/lib/bulkArchive';
import { sessionKey } from './src/types';
import type { BallMood, Session } from './src/types';

const session = (id: string, updated: number): Session => ({ id, instanceId: 'local', updated });

const moods = (entries: Record<string, BallMood>): Record<string, BallMood> =>
  Object.fromEntries(Object.entries(entries).map(([id, mood]) => [`local::${id}`, mood]));

describe('bulk archive targets', () => {
  const now = 1_000_000_000_000;
  const list = [
    session('busy', now - 1000),
    session('idle', now - 1000),
    session('unread', now - 1000),
    session('failed', now - 1000),
    session('asked', now - 1000),
    session('approval', now - 1000),
    session('thinking', now - 1000),
  ];
  const moodMap = moods({
    busy: 'busy',
    idle: 'idle',
    unread: 'unread',
    failed: 'error',
    asked: 'question',
    approval: 'input',
    thinking: 'thinking',
  });

  test('never targets a busy, thinking, or waiting session', () => {
    const targets = bulkArchiveTargets(list, moodMap, { now });
    expect(targets.map((s) => s.id).sort()).toEqual(['failed', 'idle', 'unread']);
  });

  test('older-than narrows by last activity and still skips busy or untimestamped sessions', () => {
    const aged = [
      session('old-idle', now - 2 * 86_400_000),
      session('fresh-idle', now - 60_000),
      session('old-busy', now - 2 * 86_400_000),
      { id: 'untimestamped-idle', instanceId: 'local' } satisfies Session,
    ];
    const targets = bulkArchiveTargets(
      aged,
      moods({ 'old-idle': 'idle', 'fresh-idle': 'idle', 'old-busy': 'busy', 'untimestamped-idle': 'idle' }),
      {
        olderThanHours: 24,
        now,
      }
    );
    expect(targets.map((s) => s.id)).toEqual(['old-idle']);
  });

  test('a session whose status is unknown is never a target, however old it is', () => {
    const old = 3 * 86_400_000;
    const list = [session('unknown', now - old), session('idle', now - old)];
    // `unknown` has no mood entry: the poll has not answered for its instance (still starting, or
    // the last read failed). It may be mid-turn, so it is not a candidate — age does not make it one.
    expect(bulkArchiveTargets(list, moods({ idle: 'idle' }), { now }).map((s) => s.id)).toEqual(['idle']);
    expect(
      bulkArchiveTargets(list, moods({ idle: 'idle' }), { olderThanHours: 24, now }).map((s) => s.id)
    ).toEqual(['idle']);
  });

  test('a map that says "unknown" for a session means unknown, not quiet', () => {
    // App's mood map is total (it feeds the rail), so it carries `'unknown'` rather than omitting
    // the key. A present key with no answer must be exactly as ineligible as an absent one.
    const list = [session('unknown-mood', now - 3 * 86_400_000), session('idle', now - 3 * 86_400_000)];
    const map = moods({ 'unknown-mood': 'unknown', idle: 'idle' });
    expect(bulkArchiveTargets(list, map, { now }).map((s) => s.id)).toEqual(['idle']);
    expect(bulkArchiveTargets(list, map, { olderThanHours: 24, now }).map((s) => s.id)).toEqual(['idle']);
    expect(sessionStatusAnswer(map, list[0])).toEqual({ known: false });
  });

  test('unknown is an explicit answer, not a coerced idle', () => {
    const unknown = sessionStatusAnswer({}, session('x', now));
    expect(unknown).toEqual({ known: false });
    expect(isQuietlyArchivable(unknown)).toBe(false);
    // A known mood is read as itself; only a missing one means unknown.
    expect(sessionStatusAnswer(moods({ x: 'idle' }), session('x', now))).toEqual({ known: true, mood: 'idle' });
    expect(isQuietlyArchivable(sessionStatusAnswer(moods({ x: 'idle' }), session('x', now)))).toBe(true);
    expect(isQuietlyArchivable(sessionStatusAnswer(moods({ x: 'busy' }), session('x', now)))).toBe(false);
    expect(isQuietlyArchivable(sessionStatusAnswer(moods({ x: 'question' }), session('x', now)))).toBe(false);
  });

  test('exposes ordered age buckets and identifies busy moods', () => {
    expect(ARCHIVE_AGE_OPTIONS.map((option) => option.label)).toEqual([
      '1 day',
      '3 days',
      '1 week',
      '2 weeks',
      '1 month',
    ]);
    expect(isSessionBusy('busy')).toBe(true);
    expect(isSessionBusy('input')).toBe(true);
    expect(isSessionBusy('idle')).toBe(false);
    expect(isSessionBusy('error')).toBe(false);
    expect(isSessionBusy('unread')).toBe(false);
  });
});

describe('stale scheduled runs', () => {
  const now = 1_000_000_000_000;
  const day = 24 * 3_600_000;
  const bindings = {
    'local::stale-run': 'task:local::p1::brief',
    'local::fresh-run': 'task:local::p1::brief',
    'local::open-run': 'task:local::p1::brief',
    'local::busy-run': 'task:local::p1::brief',
    'local::done-run': 'task:local::p1::brief',
  };
  const list = [
    session('stale-run', now - 2 * day),
    session('fresh-run', now - 60_000),
    session('open-run', now - 2 * day),
    session('busy-run', now - 2 * day),
    session('done-run', now - 2 * day),
    session('plain', now - 2 * day),
    { ...session('already-archived', now - 2 * day), archived: now - day },
  ];
  // Every run the test expects to be swept has a status the poll has answered for: an unknown one
  // is never swept, which `a run with no status is never swept` below covers on its own.
  const moodMap = moods({
    'stale-run': 'idle',
    'done-run': 'idle',
    'fresh-run': 'idle',
    'open-run': 'idle',
    'busy-run': 'thinking',
  });

  test('targets only bound, idle, day-old runs that are not open and have a known timestamp', () => {
    const untimestamped: Session = { id: 'untimestamped-run', instanceId: 'local' };
    const targets = staleScheduledRuns(
      [...list, untimestamped],
      { ...bindings, 'local::untimestamped-run': 'task:local::p1::brief' },
      { ...moodMap, 'local::untimestamped-run': 'idle' },
      new Set(['local::open-run']),
      now
    );
    expect(targets.map((s) => s.id).sort()).toEqual(['done-run', 'stale-run']);
  });

  test('a run whose status is unknown is never swept, while an idle one still is', () => {
    const unknownRun = session('unknown-run', now - 2 * day);
    const idleRun = session('idle-run', now - 2 * day);
    const runBindings = {
      [sessionKey(unknownRun)]: 'task:local::p1::brief',
      [sessionKey(idleRun)]: 'task:local::p1::brief',
    };
    // This sweep runs unattended every fifteen minutes: a guess here archives a working run with
    // nobody watching, so an unanswered status has to mean "leave it".
    const targets = staleScheduledRuns([unknownRun, idleRun], runBindings, moods({ 'idle-run': 'idle' }), new Set(), now);
    expect(targets.map((s) => s.id)).toEqual(['idle-run']);
  });

  test('no bindings means nothing is a scheduled run', () => {
    expect(staleScheduledRuns(list, {}, moodMap, new Set(), now)).toEqual([]);
  });
});

/**
 * The predicate this module shipped at faf1e44, copied verbatim (`moods[key] ?? 'idle'` intact).
 * It exists so the tests above have a "before": run them against this and they fail, because an
 * unanswered status was read as idle. The fix is the absence of this `??`, not a stronger guess.
 */
const preFixBulkArchiveTargets = (
  sessions: Session[],
  moods: Record<string, BallMood>,
  options: { olderThanHours?: number; now: number }
): Session[] => {
  const cutoff =
    options.olderThanHours === undefined ? null : options.now - options.olderThanHours * 3_600_000;
  return sessions.filter((session) => {
    if (isSessionBusy(moods[sessionKey(session)] ?? 'idle')) return false;
    if (cutoff !== null && (session.updated ?? 0) >= cutoff) return false;
    return true;
  });
};

const preFixStaleScheduledRuns = (
  sessions: Session[],
  bindings: Record<string, string>,
  moods: Record<string, BallMood>,
  openKeys: ReadonlySet<string>,
  now: number,
  olderThanHours = 24
): Session[] => {
  const cutoff = now - olderThanHours * 3_600_000;
  return sessions.filter((session) => {
    const key = sessionKey(session);
    if (!bindings[key] || session.archived || openKeys.has(key)) return false;
    if ((session.updated ?? 0) >= cutoff) return false;
    return !isSessionBusy(moods[key] ?? 'idle');
  });
};

describe('pre-fix witness', () => {
  const now = 1_000_000_000_000;
  const old = now - 3 * 86_400_000;
  const unbound = session('unknown', old);

  test('an unanswered status used to be offered for archive, and for the unattended sweep', () => {
    // This is what the old code did with the same inputs the new tests pass: it archived a session
    // whose status nobody had answered for.
    expect(preFixBulkArchiveTargets([unbound], {}, { now }).map((s) => s.id)).toEqual(['unknown']);
    expect(
      preFixStaleScheduledRuns([unbound], { [sessionKey(unbound)]: 'task' }, {}, new Set(), now).map((s) => s.id)
    ).toEqual(['unknown']);

    // And what the fixed module does: nothing, because unknown is not idle.
    expect(bulkArchiveTargets([unbound], {}, { now })).toEqual([]);
    expect(staleScheduledRuns([unbound], { [sessionKey(unbound)]: 'task' }, {}, new Set(), now)).toEqual([]);
  });
});
