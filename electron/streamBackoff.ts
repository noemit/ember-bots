/**
 * Reconnect timing for a stream socket.
 *
 * The bug this exists to prevent: a server that accepts a WebSocket and then closes it immediately
 * (Hearth does, when the first frame hits backpressure) turned into a connection storm because the
 * client **forgave the backoff on open**. Every retry opened, reset to attempt 0, was closed a
 * moment later, and reopened at the base delay — on a host watching 25 conversations that is 25 new
 * connections a second, forever, each one answered with a full snapshot.
 *
 * So a connection is forgiven only after it has been **stable** for a while, not merely accepted.
 * A socket that opens and dies young counts as a failure and grows the delay; one that carried a
 * conversation for fifteen seconds and then dropped starts again at the base delay.
 */

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** How long a connection must survive before its history stops counting against it. */
export const STABLE_AFTER_MS = 15_000;

export type StreamBackoff = {
  /** Consecutive young closes. 0 means "no failure on record". */
  attempt: number;
  /** When the current socket opened, or null when it is not open. */
  openedAt: number | null;
};

export const freshBackoff = (): StreamBackoff => ({ attempt: 0, openedAt: null });

export const noteOpened = (state: StreamBackoff, at = Date.now()): StreamBackoff => ({
  ...state,
  openedAt: at,
});

/**
 * Record a close and return the state the next delay is computed from.
 *
 * `stable` is the whole point: a socket that lived past `STABLE_AFTER_MS` resets the count to 1
 * (one base delay, as if the connection had just started), while a young one increments it.
 */
export const noteClosed = (state: StreamBackoff, at = Date.now()): StreamBackoff => {
  const stable = state.openedAt !== null && at - state.openedAt >= STABLE_AFTER_MS;
  return { attempt: stable ? 1 : state.attempt + 1, openedAt: null };
};

/**
 * Delay before the next attempt: exponential in the failure count, jittered ±25% so a fleet of
 * sockets (or several devices) never retries in lockstep, and capped so a long outage costs one
 * attempt per half minute rather than a hot loop.
 */
export const reconnectDelay = (state: StreamBackoff, random: () => number = Math.random): number => {
  const fails = Math.max(1, state.attempt);
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(fails - 1, 16));
  return Math.round(ceiling * (0.75 + random() * 0.5));
};
