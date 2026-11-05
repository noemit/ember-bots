import { sessionKey } from '../types';
import type { BallState, Instance, Session } from '../types';

/**
 * How long a status answer is trusted.
 *
 * Every instance that can be read is polled on a fixed cadence (3 s while its stream is down, 30 s
 * while it is up), so an answer older than three of the slow beats means the poll has stopped
 * answering — and a poll that fails keeps the previous map, which would otherwise let one `active`
 * from an hour ago keep a dead crew looking busy forever. Past this, the status is `unknown`.
 */
export const STATE_STALE_AFTER_MS = 90_000;

/**
 * The instances whose status Ember actually knows right now: it can reach them, and it has an
 * answer from their status endpoint that is still fresh. Everything else is `unknown` — not idle.
 */
export const instancesWithFreshStates = (
  instances: readonly Instance[],
  readAt: Readonly<Record<string, number | undefined>>,
  now: number,
  staleAfter = STATE_STALE_AFTER_MS
): Set<string> => {
  const fresh = new Set<string>();
  instances.forEach((instance) => {
    // `attachable` is the probe's own verdict, so an unreachable host is unknown immediately rather
    // than after the staleness window.
    if (!instance.attachable) return;
    const answeredAt = readAt[instance.id];
    if (answeredAt === undefined || now - answeredAt > staleAfter) return;
    fresh.add(instance.id);
  });
  return fresh;
};

/**
 * A state for every session Ember knows about, with `unknown` wherever its instance has not
 * answered. `reported` only ever holds the states a host listed (it omits idle sessions), so a
 * missing entry on an answered instance is a genuine idle answer; a missing *instance* is not an
 * answer at all.
 */
export const sessionStates = (
  sessionsByInstance: Readonly<Record<string, Session[]>>,
  reported: Readonly<Record<string, Record<string, BallState> | undefined>>,
  answered: ReadonlySet<string>
): Record<string, BallState> => {
  const states: Record<string, BallState> = {};
  Object.entries(sessionsByInstance).forEach(([instanceId, list]) => {
    const answeredHere = answered.has(instanceId);
    list.forEach((session) => {
      const key = sessionKey(session);
      states[key] = answeredHere ? (reported[instanceId]?.[key] ?? 'idle') : 'unknown';
    });
  });
  return states;
};
