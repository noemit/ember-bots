import type { BallMood, BallState, Session } from '../types';
import { sessionKey } from '../types';
import { threadDescendants, workerStateLabel } from './crew';

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
    (worker) => workerStateLabel(worker, { state: states[sessionKey(worker)] }) === 'working'
  ) ? 'busy' : ownMood;
};
