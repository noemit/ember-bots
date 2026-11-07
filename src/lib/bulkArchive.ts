import { sessionKey } from '../types';
import type { BallMood, Session } from '../types';

/**
 * Moods where the agent is working or blocked on the user. Bulk archive must never touch these,
 * so a running turn isn't interrupted and a pending question/approval isn't thrown away.
 */
export const isSessionBusy = (mood: BallMood): boolean =>
  mood === 'busy' || mood === 'thinking' || mood === 'input' || mood === 'question';

/**
 * The status poll's answer for one session.
 *
 * `unknown` is an answer, not a value to fill in: the poll has not reported this session yet (Ember
 * just started, the host is restarting, or the last read failed), so the session may well be
 * working. Nothing may archive it on that guess, and there is deliberately no `?? 'idle'` anywhere
 * in this module to turn the absence into one.
 */
export type SessionStatusAnswer =
  /** The status poll has reported this session: `mood` is what it said. */
  | { known: true; mood: BallMood }
  /** No status has arrived for this session, so it is not a candidate for anything destructive. */
  | { known: false };

/**
 * What Ember actually knows about a session's status. A missing entry in `moods` means *unknown* —
 * never idle — because the map is only filled in for sessions the poll has answered for. The
 * explicit `'unknown'` mood means the same thing, so a caller that builds a total map (App does,
 * for the rail) cannot smuggle a guess in through a present key.
 */
export const sessionStatusAnswer = (
  moods: Readonly<Record<string, BallMood | undefined>>,
  session: Session
): SessionStatusAnswer => {
  const mood = moods[sessionKey(session)];
  return mood === undefined || mood === 'unknown' ? { known: false } : { known: true, mood };
};

/**
 * Whether a session is safe to archive without a human looking at it: its status is known *and* the
 * agent is neither working nor blocked. Unknown is never safe — the whole point is that the app
 * cannot tell a session it has no status for from one that is mid-turn.
 */
export const isQuietlyArchivable = (answer: SessionStatusAnswer): boolean =>
  answer.known && !isSessionBusy(answer.mood);

/** Age buckets offered by the card's "older than…" menu. */
export const ARCHIVE_AGE_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 24 * 7 },
  { label: '2 weeks', hours: 24 * 14 },
  { label: '1 month', hours: 24 * 30 },
];

/**
 * The sessions a bulk archive would hit: everything whose status is known and isn't busy/blocked,
 * optionally narrowed to those whose last activity is older than `olderThanHours`. A session whose
 * status is unknown is never included, whatever its age: archiving it would close a column that
 * may be running a turn.
 */
export const bulkArchiveTargets = (
  sessions: Session[],
  moods: Readonly<Record<string, BallMood | undefined>>,
  options: { olderThanHours?: number; now: number }
): Session[] => {
  const cutoff =
    options.olderThanHours === undefined ? null : options.now - options.olderThanHours * 3_600_000;
  return sessions.filter((session) => {
    if (!isQuietlyArchivable(sessionStatusAnswer(moods, session))) return false;
    if (cutoff !== null && (session.updated === undefined || session.updated >= cutoff)) return false;
    return true;
  });
};

/**
 * Scheduled-task runs that are safe to auto-archive: bound to a task, past the age limit, not
 * open in the workspace, explicitly read, and not working or waiting on the user. Bindings accumulate as each
 * run becomes the task's `lastSessionId`, so this covers every run Ember has observed — and an
 * archived run still shows in the scheduled view through that same binding.
 *
 * Runs with an unknown status are left alone: this runs unattended, so a guess here would archive a
 * working run with nobody watching.
 */
export const staleScheduledRuns = (
  sessions: Session[],
  bindings: Record<string, string>,
  moods: Readonly<Record<string, BallMood | undefined>>,
  openKeys: ReadonlySet<string>,
  now: number,
  readKeys: ReadonlySet<string>,
  olderThanHours = 24
): Session[] => {
  const cutoff = now - olderThanHours * 3_600_000;
  return sessions.filter((session) => {
    const key = sessionKey(session);
    if (!bindings[key] || session.archived || openKeys.has(key) || !readKeys.has(key)) return false;
    if (session.updated === undefined || session.updated >= cutoff) return false;
    return isQuietlyArchivable(sessionStatusAnswer(moods, session));
  });
};
