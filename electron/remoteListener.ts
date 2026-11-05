import type { Server } from 'node:http';

/**
 * The remote listener's life, kept as an explicit state instead of a `console.warn`.
 *
 * The bug this replaces: if Ember started before Tailscale (the normal case at login), the one
 * attempt to bind returned null and the app went on showing "remote access: On" over a socket
 * that never existed. The only clue was a line in a terminal the user does not have.
 *
 * So the state is tracked, retried with a bounded backoff, and reported to the renderer through
 * the settings it already reads.
 */
export type RemoteStatus = 'off' | 'starting' | 'listening' | 'no-tailscale' | 'error';

export type RemoteState = {
  status: RemoteStatus;
  /** The address actually bound, once `listening`. */
  address?: string;
  port?: number;
  /** A short, human-readable reason when the status is not `listening`. */
  detail?: string;
  /** How many automatic attempts have been made since the last success. */
  attempts: number;
  /** When this status was entered (epoch ms). */
  changedAt: number;
};

export type StartOutcome = { server: Server; address?: string } | { server: null; reason: 'no-tailscale' | 'disabled' };
export type StartFn = () => StartOutcome;

/** Bounded: after the last delay the listener waits for a settings change, a resume, or a retry. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 120_000] as const;
export const MAX_AUTO_ATTEMPTS = RETRY_DELAYS_MS.length;

export const retryDelayFor = (attempts: number): number | null =>
  attempts < 1 || attempts > RETRY_DELAYS_MS.length ? null : RETRY_DELAYS_MS[attempts - 1];

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A pending retry must not hold the process open after the last window closes.
    if (typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RemoteListener {
  private state: RemoteState;
  private server: Server | null = null;
  private timer: unknown = null;
  private enabled = false;

  constructor(
    private readonly start: StartFn,
    private readonly onChange: (state: RemoteState) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = defaultTimers
  ) {
    this.state = { status: 'off', attempts: 0, changedAt: this.now() };
  }

  snapshot(): RemoteState {
    return { ...this.state };
  }

  /** Idempotent: called on boot, on every settings save, and on wake. */
  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stop();
      return;
    }
    if (this.state.status === 'listening' && this.server) return;
    if (this.state.status === 'starting') return;
    this.attempt(false);
  }

  /** A resume or a manual retry: always tries, even after the backoff gave up. */
  retryNow(): void {
    if (!this.enabled) return;
    if (this.server) return;
    this.clearTimer();
    this.attempt(true);
  }

  dispose(): void {
    this.enabled = false;
    this.stop();
  }

  private stop(): void {
    this.clearTimer();
    const server = this.server;
    this.server = null;
    if (server) {
      server.close();
      server.closeAllConnections?.();
    }
    this.setState({ status: 'off', attempts: 0, detail: undefined, address: undefined, port: undefined });
  }

  private attempt(manual: boolean): void {
    this.clearTimer();
    this.setState({ status: 'starting', attempts: manual ? this.state.attempts : this.state.attempts });
    let outcome: StartOutcome;
    try {
      outcome = this.start();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not start the remote listener');
      return;
    }
    if (!outcome.server) {
      if (outcome.reason === 'disabled') {
        this.setState({ status: 'off', attempts: 0, detail: undefined, address: undefined, port: undefined });
        return;
      }
      this.fail('No Tailscale IPv4 address — is Tailscale connected?', 'no-tailscale');
      return;
    }
    const server = outcome.server;
    this.server = server;
    server.once('listening', () => {
      if (this.server !== server) return;
      const address = server.address();
      const boundAddress = address && typeof address === 'object' ? address.address : outcome.address;
      const port = address && typeof address === 'object' ? address.port : undefined;
      this.setState({
        status: 'listening',
        address: boundAddress,
        port,
        detail: undefined,
        attempts: 0,
      });
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (this.server !== server) return;
      this.server = null;
      try { server.close(); } catch { /* already closing */ }
      const code = error.code ?? error.message;
      this.fail(code === 'EADDRINUSE'
        ? `Port ${outcome.address ?? ''} is already in use — another Ember is probably serving remote access`
        : `Could not listen: ${code}`);
    });
  }

  private fail(detail: string, status: RemoteStatus = 'error'): void {
    const attempts = this.state.attempts + 1;
    this.setState({ status, detail, attempts, address: undefined, port: undefined });
    this.scheduleRetry(attempts);
  }

  private scheduleRetry(attempts: number): void {
    if (!this.enabled) return;
    const delay = retryDelayFor(attempts);
    if (delay === null) return;
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (!this.enabled || this.server) return;
      this.attempt(false);
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(patch: Partial<RemoteState> & { status: RemoteStatus }): void {
    const changed = this.state.status !== patch.status ||
      this.state.address !== patch.address ||
      this.state.port !== patch.port ||
      this.state.detail !== patch.detail;
    this.state = { ...this.state, ...patch, changedAt: this.now() };
    // Every settings save calls `configure`, and a save while remote access is off must not look
    // like the listener did something.
    if (changed) this.onChange(this.snapshot());
  }
}
