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

/** Seed both period and offset by full host/session identity. Each phase lasts 6–10s;
 * the shared 1s cadence does not synchronize identities or restart on ordinary polls.
 */
export const crewActivityPhase = (key: string, visibleSeconds: number): 'busy' | 'thinking' => {
  const seed = hashString(key);
  const duration = 6 + seed % 5;
  const offset = (seed >>> 8) % (duration * 2);
  return Math.floor((visibleSeconds + offset) / duration) % 2 === 0 ? 'busy' : 'thinking';
};

export const shouldAlternateCrew = (hasActiveCrew: boolean, visible: boolean, reduced: boolean): boolean =>
  hasActiveCrew && visible && !reduced;
