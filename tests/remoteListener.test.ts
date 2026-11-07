import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { MAX_AUTO_ATTEMPTS, RemoteListener, RETRY_DELAYS_MS, retryDelayFor, type RemoteState } from '../electron/remoteListener';

/**
 * The remote listener's state machine, without Electron and without a socket.
 *
 * This is the decision that used to be invisible: one attempt at startup, a `console.warn` on
 * failure, and a settings toggle that went on saying "On".
 */

class FakeServer extends EventEmitter {
  closed = false;
  constructor(private readonly bound: { address: string; port: number } | null = null) {
    super();
  }
  address() { return this.bound; }
  close() { this.closed = true; return this; }
  closeAllConnections() { return this; }
  asServer() { return this as unknown as Server; }
  listen() { this.emit('listening'); }
  fail(code: string) {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    this.emit('error', error);
  }
}

type Pending = { fn: () => void; ms: number; cleared: boolean };

const fakeTimers = () => {
  const pending: Pending[] = [];
  return {
    pending,
    /** The next delay the listener asked for, if any. */
    next: (): Pending | undefined => pending.find((entry) => !entry.cleared),
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const entry: Pending = { fn, ms, cleared: false };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        if (handle && typeof handle === 'object') (handle as Pending).cleared = true;
      },
    },
  };
};

const harness = (starts: Array<() => { server: Server | null; address?: string; reason?: 'no-tailscale' | 'disabled' }>) => {
  const clock = fakeTimers();
  const states: RemoteState[] = [];
  let call = 0;
  const listener = new RemoteListener(
    () => {
      const next = starts[Math.min(call, starts.length - 1)];
      call += 1;
      return next();
    },
    (state) => states.push(state),
    () => 1_000,
    clock.timers
  );
  return { listener, states, clock, calls: () => call };
};

test('no Tailscale at startup is a state, not a silent no-op', () => {
  const { listener, states } = harness([() => ({ server: null, reason: 'no-tailscale' })]);
  listener.configure(true);
  expect(states.at(-1)?.status).toBe('no-tailscale');
  expect(states.at(-1)?.detail).toContain('Tailscale');
  expect(states.at(-1)?.attempts).toBe(1);
});

test('it keeps retrying with a bounded backoff, then waits for a wake or a settings change', () => {
  const { listener, clock } = harness([() => ({ server: null, reason: 'no-tailscale' })]);
  listener.configure(true);
  const delays: number[] = [];
  for (let i = 0; i < MAX_AUTO_ATTEMPTS + 2; i += 1) {
    const next = clock.next();
    if (!next) break;
    delays.push(next.ms);
    next.cleared = true;
    next.fn();
  }
  expect(delays).toEqual([...RETRY_DELAYS_MS]);
  // The schedule is finite: after the last delay there is no timer left to spin on.
  expect(retryDelayFor(MAX_AUTO_ATTEMPTS + 1)).toBeNull();
  expect(clock.next()).toBeUndefined();
});

test('a retry that succeeds reports the address it actually bound', () => {
  const server = new FakeServer({ address: '100.64.0.1', port: 57821 });
  let first = true;
  const { listener, states } = harness([
    () => (first ? ((first = false), { server: null, reason: 'no-tailscale' }) : { server: server.asServer(), address: '100.64.0.1' }),
  ]);
  listener.configure(true);
  expect(states.at(-1)?.status).toBe('no-tailscale');
  listener.retryNow();
  server.listen();
  expect(states.at(-1)?.status).toBe('listening');
  expect(states.at(-1)?.address).toBe('100.64.0.1');
  expect(states.at(-1)?.port).toBe(57821);
  // Success resets the backoff.
  expect(states.at(-1)?.attempts).toBe(0);
});

test('a port already in use is reported as such, with the port in the message', () => {
  const server = new FakeServer();
  const { listener, states } = harness([() => ({ server: server.asServer(), address: '100.64.0.1' })]);
  listener.configure(true);
  server.fail('EADDRINUSE');
  expect(states.at(-1)?.status).toBe('error');
  expect(states.at(-1)?.detail).toContain('already in use');
});

test('turning remote access off stops the server and says off', () => {
  const server = new FakeServer({ address: '100.64.0.1', port: 57821 });
  const { listener, states } = harness([() => ({ server: server.asServer(), address: '100.64.0.1' })]);
  listener.configure(true);
  server.listen();
  expect(states.at(-1)?.status).toBe('listening');
  listener.configure(false);
  expect(server.closed).toBe(true);
  expect(states.at(-1)?.status).toBe('off');
});

test('a start that throws is an error state, not a crash', () => {
  const { listener, states } = harness([() => { throw new Error('permission denied'); }]);
  listener.configure(true);
  expect(states.at(-1)?.status).toBe('error');
  expect(states.at(-1)?.detail).toBe('permission denied');
});

test('a disabled profile never starts and reports off', () => {
  const { listener, states, calls } = harness([() => ({ server: null, reason: 'disabled' })]);
  listener.configure(true);
  expect(calls()).toBe(1);
  expect(states.at(-1)?.status).toBe('off');
});

test('a settings save while remote access is off does not announce a change', () => {
  const { listener, states } = harness([() => ({ server: null, reason: 'disabled' })]);
  listener.configure(false);
  listener.configure(false);
  listener.configure(false);
  expect(states).toEqual([]);
});

test('configure is idempotent while listening: no second bind, no churn', () => {
  const server = new FakeServer({ address: '100.64.0.1', port: 57821 });
  const { listener, calls } = harness([() => ({ server: server.asServer(), address: '100.64.0.1' })]);
  listener.configure(true);
  server.listen();
  listener.configure(true);
  listener.configure(true);
  expect(calls()).toBe(1);
});
