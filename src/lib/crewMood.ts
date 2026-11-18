import type { BallMood, BallState, Session } from '../types';
import { sessionKey } from '../types';
import { threadDescendants, workerStateLabel } from './crew';
import { hashString } from '../blob/seed';

/**
 * Appearance only: a resting leader is still working while a descendant has an active turn.
 * Never feed this mood back into operational state (send, queue, stop or the waiting status).
 * Own thinking, requests, failures and unknown host status keep their existing meaning; an
 * unknown or failed worker alone is not evidence of work. Worker thinking is an active turn too.
 */
export const crewAppearanceMood = (
  session: Session,
  ownMood: BallMood,
  crews: ReadonlyMap<string, readonly Session[]>,
  states: Readonly<Record<string, BallState>>
): BallMood => {
  if (ownMood !== 'idle' && ownMood !== 'unread') return ownMood;
  return threadDescendants(session, crews).some(
    (worker) => workerStateLabel(worker, { state: states[sessionKey(worker)] }) === 'working' &&
      (!worker.task || worker.task.status === 'working')
  ) ? 'busy' : ownMood;
};

const crewPhaseWindow = (key: string): { duration: number; offset: number } => {
  const seed = hashString(key);
  const duration = 6 + seed % 5;
  const offset = (seed >>> 8) % (duration * 2);
  return { duration, offset };
};

/** Small timer cushion so a boundary wake lands inside the new phase rather than 1ms early. */
export const CREW_PHASE_BUFFER_MS = 5;

/** Seed both period and offset by full host/session identity. Each phase lasts 6–10s;
 * boundary wakeups do not synchronize identities or restart on ordinary polls.
 */
export const crewActivityPhase = (key: string, visibleSeconds: number): 'busy' | 'thinking' => {
  const { duration, offset } = crewPhaseWindow(key);
  return Math.floor((visibleSeconds + offset) / duration) % 2 === 0 ? 'busy' : 'thinking';
};

/** Exact milliseconds until the earliest resting crew key crosses its next `crewActivityPhase` boundary. */
export const nextCrewPhaseDelayMs = (
  crewKeys: ReadonlySet<string>,
  elapsedMs: number
): number | null => {
  if (crewKeys.size === 0) return null;
  const clampedElapsedMs = Math.max(0, Math.floor(elapsedMs));
  let earliest = Infinity;
  for (const key of crewKeys) {
    const { duration, offset } = crewPhaseWindow(key);
    const durationMs = duration * 1000;
    const totalMs = clampedElapsedMs + offset * 1000;
    const remainingMs = durationMs - (totalMs % durationMs);
    if (remainingMs < earliest) earliest = remainingMs;
  }
  return Number.isFinite(earliest) ? earliest : null;
};

export const sameMoodMap = (
  a: Readonly<Record<string, BallMood>>,
  b: Readonly<Record<string, BallMood>>
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in b) || a[key] !== b[key]) return false;
  }
  return true;
};

/** Apply resting-crew phase moods and preserve `previous` when every session's mood matches. */
export const resolveCrewMoods = (
  baseMoods: Readonly<Record<string, BallMood>>,
  crewKeys: ReadonlySet<string>,
  elapsedMs: number,
  reduced: boolean,
  previous?: Record<string, BallMood>
): Record<string, BallMood> => {
  const next: Record<string, BallMood> = { ...baseMoods };
  const visibleSeconds = Math.max(0, elapsedMs) / 1000;
  for (const key of crewKeys) {
    next[key] = reduced ? 'busy' : crewActivityPhase(key, visibleSeconds);
  }
  if (previous && sameMoodMap(previous, next)) return previous;
  return next;
};

export const shouldAlternateCrew = (hasActiveCrew: boolean, visible: boolean, reduced: boolean): boolean =>
  hasActiveCrew && visible && !reduced;
