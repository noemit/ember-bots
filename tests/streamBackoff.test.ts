import { describe, expect, test } from 'bun:test';
import {
  freshBackoff,
  noteClosed,
  noteOpened,
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STABLE_AFTER_MS,
} from '../electron/streamBackoff';

const noJitter = () => 0.5;

describe('reconnect backoff', () => {
  test('an accepted-then-closed socket escalates instead of resetting', () => {
    // The storm this prevents: Hearth accepts the upgrade, hits backpressure on the first frame and
    // closes with 1013. The client used to forgive its backoff on *open*, so every retry came back
    // at the base delay — 25 watched conversations became 25 new connections a second.
    let state = freshBackoff();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = noteOpened(state, 0);
      state = noteClosed(state, 20); // died 20ms after opening
      delays.push(reconnectDelay(state, noJitter));
    }
    expect(delays).toEqual([
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS * 2,
      RECONNECT_BASE_MS * 4,
      RECONNECT_BASE_MS * 8,
      RECONNECT_BASE_MS * 16,
    ]);
  });

  test('a connection that was stable is forgiven: one base delay, not the old ceiling', () => {
    let state = freshBackoff();
    // Six young failures, so the delay is deep into the curve…
    for (let attempt = 0; attempt < 6; attempt += 1) {
      state = noteOpened(state, 0);
      state = noteClosed(state, 10);
    }
    expect(reconnectDelay(state, noJitter)).toBeGreaterThan(RECONNECT_BASE_MS * 8);
    // …then one that carried traffic past the stability window and dropped.
    state = noteOpened(state, 0);
    state = noteClosed(state, STABLE_AFTER_MS + 1);
    expect(reconnectDelay(state, noJitter)).toBe(RECONNECT_BASE_MS);
  });

  test('the delay is capped, so a long outage costs one attempt per half minute', () => {
    let state = freshBackoff();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      state = noteOpened(state, 0);
      state = noteClosed(state, 1);
    }
    expect(reconnectDelay(state, noJitter)).toBe(RECONNECT_MAX_MS);
  });

  test('jitter keeps a fleet from retrying in lockstep, within ±25%', () => {
    const state = noteClosed(noteOpened(freshBackoff(), 0), 1);
    expect(reconnectDelay(state, () => 0)).toBe(RECONNECT_BASE_MS * 0.75);
    expect(reconnectDelay(state, () => 1)).toBe(RECONNECT_BASE_MS * 1.25);
    expect(reconnectDelay(state, noJitter)).toBe(RECONNECT_BASE_MS);
  });

  test('a close with no recorded open still counts as a failure', () => {
    const state = noteClosed(freshBackoff(), 0);
    expect(state.attempt).toBe(1);
    expect(state.openedAt).toBeNull();
  });
});
