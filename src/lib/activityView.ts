/**
 * Pure derivation for the activity home: merging live events with persisted history,
 * grouping entries into day sections with collapsed tool runs, the "needs you now" strip,
 * and linking an entry back to its session. Everything here is display-only — REST stays
 * the source of truth for sessions, states and prompts; the log only describes events.
 */
import { sessionKey, type ActivityEntry, type BallMood, type EmberEvent, type Session } from '../types';

/** Newest-first in-memory log for the panel; older entries drop off as more arrive. */
export const ACTIVITY_MEMORY_LIMIT = 500;

/**
 * Local calendar day an event belongs to. Mirrors `dayKeyOf` in `electron/activity.ts` —
 * the two tsconfigs have separate roots, so the renderer keeps its own copy.
 */
export const activityDayKey = (at: number): string => {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const dayLabel = (day: string, now: number): string => {
  if (day === activityDayKey(now)) return 'Today';
  if (day === activityDayKey(now - 86_400_000)) return 'Yesterday';
  // Midday parses avoid a UTC-midnight timestamp slipping a day in an odd timezone.
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
};

const boundedText = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;

/** A trusted entry from a parsed live event; hints without a summary are not log entries. */
export const entryFromEmberEvent = (event: EmberEvent): ActivityEntry | null => {
  const summary = boundedText(event.summary, 400);
  const id = boundedText(event.id, 200);
  const instanceId = boundedText(event.instanceId, 200);
  const type = boundedText(event.type, 100);
  const at = typeof event.at === 'number' && Number.isFinite(event.at) && event.at > 0 ? event.at : Date.now();
  if (!summary || !id || !instanceId || !type) return null;
  const detailSource =
    event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
      ? (event.detail as Record<string, unknown>)
      : {};
  let detail: Record<string, string> | undefined;
  for (const [key, value] of Object.entries(detailSource).slice(0, 8)) {
    const name = boundedText(key, 40);
    const text = boundedText(value, 400);
    if (name && text) (detail ??= {})[name] = text;
  }
  return {
    id,
    at,
    instanceId,
    directory: boundedText(event.directory, 2048),
    sessionId: boundedText(event.sessionId, 200),
    type,
    summary,
    detail,
  };
};

/**
 * Merge two newest-first entry lists, de-duped by id — the incoming copy wins so a live
 * entry can refine the fetched one — sorted by time and bounded.
 */
export const mergeActivity = (
  current: ActivityEntry[],
  incoming: ActivityEntry[],
  limit = ACTIVITY_MEMORY_LIMIT
): ActivityEntry[] => {
  const byId = new Map<string, ActivityEntry>();
  for (const entry of current) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  const merged = [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  return merged.length > limit ? merged.slice(0, limit) : merged;
};

/** `sessionKey`-keyed index for O(1) entry → session resolution. */
export const sessionIndex = (sessions: Session[]): Map<string, Session> =>
  new Map(sessions.map((session) => [sessionKey(session), session]));

/**
 * The session an entry describes, or null when it is archived or no longer known — those
 * render as muted, non-linking rows (archiving or deleting must not break the timeline).
 */
export const resolveActivityTarget = (entry: ActivityEntry, index: Map<string, Session>): Session | null => {
  if (!entry.sessionId) return null;
  const session = index.get(sessionKey({ instanceId: entry.instanceId, sessionId: entry.sessionId }));
  return session && !session.archived ? session : null;
};

/** The one-line description of an entry: its summary plus its most telling detail. */
export const entryLine = (entry: ActivityEntry): string => {
  const detail = entry.detail
    ? (entry.detail.error ??
      entry.detail.command ??
      entry.detail.action ??
      entry.detail.question ??
      entry.detail.message ??
      entry.detail.title ??
      entry.detail.name ??
      entry.detail.status ??
      Object.values(entry.detail)[0])
    : undefined;
  // Older activity files retain the wire's archive wording; translate only this known milestone.
  const summary = entry.type === 'openchamber:session-archived' && entry.summary === 'session archived'
    ? 'session hidden'
    : entry.summary;
  return detail ? `${summary} · ${detail}` : summary;
};

// ---- Timeline grouping -------------------------------------------------------------

export type ActivityRow =
  | { kind: 'entry'; entry: ActivityEntry }
  /** A run of consecutive tool successes from one session, collapsed to one line. */
  | { kind: 'block'; entries: ActivityEntry[]; from: number; to: number; count: number };

export type ActivityDayGroup = { day: string; label: string; rows: ActivityRow[] };

/** Runs shorter than this stay as individual rows. */
const TOOL_BLOCK_MIN = 3;

const isToolSuccess = (entry: ActivityEntry): boolean => entry.type === 'session.tool.success';
const runKeyOf = (entry: ActivityEntry): string => `${entry.instanceId}::${entry.sessionId ?? ''}`;

/**
 * One day's entries (newest first) → rows. Consecutive `session.tool.success` entries from
 * the same session collapse into a single block row; failures, prompts and turn boundaries
 * always surface individually — the log must never hide something that needs the user.
 */
const dayRows = (entries: ActivityEntry[]): ActivityRow[] => {
  const rows: ActivityRow[] = [];
  let run: ActivityEntry[] = [];
  const flushRun = () => {
    if (run.length >= TOOL_BLOCK_MIN) {
      rows.push({ kind: 'block', entries: run, from: run[run.length - 1].at, to: run[0].at, count: run.length });
    } else {
      run.forEach((entry) => rows.push({ kind: 'entry', entry }));
    }
    run = [];
  };
  for (const entry of entries) {
    if (isToolSuccess(entry)) {
      if (run.length === 0 || runKeyOf(run[0]) === runKeyOf(entry)) {
        run.push(entry);
        continue;
      }
      flushRun();
      run = [entry];
      continue;
    }
    flushRun();
    rows.push({ kind: 'entry', entry });
  }
  flushRun();
  return rows;
};

/** Newest-first day sections for the timeline; `entries` must already be newest-first. */
export const activityDayGroups = (entries: ActivityEntry[], now = Date.now()): ActivityDayGroup[] => {
  const groups: ActivityDayGroup[] = [];
  const indexByDay = new Map<string, number>();
  const pending = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const day = activityDayKey(entry.at);
    let index = indexByDay.get(day);
    if (index === undefined) {
      index = groups.length;
      indexByDay.set(day, index);
      groups.push({ day, label: dayLabel(day, now), rows: [] });
      pending.set(day, []);
    }
    pending.get(day)!.push(entry);
  }
  groups.forEach((group) => {
    group.rows = dayRows(pending.get(group.day) ?? []);
  });
  return groups;
};

// ---- Now strip ---------------------------------------------------------------------

export type NowCard = {
  key: string;
  session: Session;
  /** Plain-language status shown on the card. */
  label: string;
  tone: 'input' | 'error' | 'working';
  urgency: number;
};

/**
 * Live cards for sessions that need the user now: prompts first (the agent is blocked on
 * us), then failures, then work in flight — the same priority the ball moods use. Derived
 * entirely from state App already holds; no extra fetches.
 */
export const nowStripCards = (sessions: Session[], moods: Record<string, BallMood>): NowCard[] => {
  const cards: NowCard[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    const key = sessionKey(session);
    const mood = moods[key] ?? 'unknown';
    if (mood === 'input' || mood === 'question') {
      cards.push({
        key,
        session,
        label: mood === 'question' ? 'asked a question' : 'waiting for approval',
        tone: 'input',
        urgency: 0,
      });
    } else if (mood === 'error') {
      cards.push({ key, session, label: 'failed', tone: 'error', urgency: 1 });
    } else if (mood === 'busy' || mood === 'thinking') {
      cards.push({
        key,
        session,
        label: mood === 'thinking' ? 'thinking' : 'working',
        tone: 'working',
        urgency: 2,
      });
    }
  }
  return cards.sort((a, b) => a.urgency - b.urgency || (b.session.updated ?? 0) - (a.session.updated ?? 0));
};
