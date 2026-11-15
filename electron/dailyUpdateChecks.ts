import type { UpdateSnapshot } from './updates';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_JITTER_MS = 15 * 60 * 1000;
export function updateCheckDue(last: unknown, now: number, next?: unknown): boolean {
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0 || last > now) return true;
  const earliest = last + UPDATE_CHECK_INTERVAL_MS;
  const due = typeof next === 'number' && Number.isFinite(next) && next >= earliest && next <= earliest + UPDATE_CHECK_JITTER_MS ? next : earliest;
  return now >= due;
}

/** Main-process only. Persist attempts before contacting GitHub, including failed attempts, so
 * reopening Ember or waking a laptop cannot cause repeated network requests or failure notices. */
export class DailyUpdateChecks {
  private running: Promise<UpdateSnapshot | undefined> | undefined;
  private disposed = false;
  private runningManual = false;
  constructor(private readonly options: {
    enabled: () => boolean;
    lastAttempt: () => unknown;
    nextAttempt?: () => unknown;
    recordAttempt: (at: number, next: number) => Promise<void>;
    random?: () => number;
    check: (quiet: boolean) => Promise<UpdateSnapshot>;
    now?: () => number;
  }) {}
  check(manual = false): Promise<UpdateSnapshot | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (this.running) return manual && !this.runningManual ? this.running.then(() => this.check(true), () => this.check(true)) : this.running;
    const now = (this.options.now ?? Date.now)();
    if (!manual && (!this.options.enabled() || !updateCheckDue(this.options.lastAttempt(), now, this.options.nextAttempt?.()))) return Promise.resolve(undefined);
    this.runningManual = manual;
    this.running = (async () => {
      // Failure to record an automatic attempt must not turn restarts into a request loop.
      try {
        const random = (this.options.random ?? Math.random)();
        const jitter = Number.isFinite(random) ? Math.floor(Math.max(0, Math.min(1, random)) * UPDATE_CHECK_JITTER_MS) : 0;
        await this.options.recordAttempt(now, now + UPDATE_CHECK_INTERVAL_MS + jitter);
      } catch { if (!manual) return undefined; }
      if (this.disposed || (!manual && !this.options.enabled())) return undefined;
      return this.options.check(!manual);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  dispose() { this.disposed = true; }
}
