/**
 * When to stop asking for a full transcript read.
 *
 * A full read is the whole conversation in one response. Ember refuses any response over 32 MB
 * (`MAX_RESPONSE_BYTES` in `electron/piClient.ts`), on the `content-length` header, so the request is
 * cheap to make — and can never succeed for a session whose history is larger than the cap. Nothing
 * used to stop it asking: opening the column, a reconnect catch-up, a periodic repair and an event
 * that asks for a full read all landed in the same dead end, so one oversized session kept a futile
 * repair alive for as long as it was open, against a host that was answering every small request
 * quickly.
 *
 * This is the breaker. It is *not* a timer and never a doubt about what is on screen: it only counts
 * consecutive full reads that failed, for one session, and after a small number it stops starting
 * them on its own. Two things still get through — the reader's own Refresh, because asking again is
 * asking again, and any repair that would have been triggered by new information about the
 * conversation rather than by a schedule — and one success clears the count, so a session that
 * was merely having a bad minute is back to normal reads immediately.
 *
 * The reason is recorded per session rather than inferred later: "the body was too large" and "the
 * transport timed out" look identical from the transcript, and only the first is worth telling the
 * reader about, because only the first will not fix itself.
 */
import type { SessionRef } from '../types';
import { sessionKey } from '../types';

/** Consecutive failures before Ember stops repairing a session by itself. */
export const FULL_REPAIR_MAX_FAILURES = 3;

/** The two shapes a full read fails in, as far as the breaker cares. */
export type FullReadFailure =
  /** The host answered, with a body larger than this client will read (`MAX_RESPONSE_BYTES`). */
  | 'too-large'
  /** The request failed, or carried no body the client could use. Retried by the poller as before. */
  | 'error';

const TOO_LARGE = /body is too large/i;

/**
 * Classify a thrown full read. The transport's message is the only thing that distinguishes the two
 * (see `readResponseText`), and it is deliberately the same sentence on both of its paths.
 */
export const classifyFullReadFailure = (error: unknown): FullReadFailure => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return TOO_LARGE.test(message) ? 'too-large' : 'error';
};

/** What the breaker knows about a session it has stopped repairing. */
export type RepairHalt = {
  failures: number;
  reason: FullReadFailure;
};

/** A bounded map of session key → consecutive failures, plus the last reason seen. */
export class RepairBudget {
  private readonly counts = new Map<string, { failures: number; reason: FullReadFailure }>();

  /** Whether a full read may start on its own for this session. */
  allows(ref: SessionRef): boolean {
    const entry = this.counts.get(sessionKey(ref));
    return !entry || entry.failures < FULL_REPAIR_MAX_FAILURES;
  }

  /** Whether the breaker is holding this session back (i.e. there is something to tell the reader). */
  halt(ref: SessionRef): RepairHalt | null {
    const entry = this.counts.get(sessionKey(ref));
    if (!entry || entry.failures < FULL_REPAIR_MAX_FAILURES) return null;
    return { failures: entry.failures, reason: entry.reason };
  }

  /** Record a failed full read. Returns how many consecutive failures that makes. */
  failed(ref: SessionRef, reason: FullReadFailure): number {
    const key = sessionKey(ref);
    const failures = (this.counts.get(key)?.failures ?? 0) + 1;
    this.counts.set(key, { failures, reason });
    return failures;
  }

  succeeded(ref: SessionRef): void {
    this.counts.delete(sessionKey(ref));
  }

  /** Drop sessions that are no longer being read, so the map cannot grow with every session seen. */
  retain(refs: readonly SessionRef[]): void {
    if (this.counts.size === 0) return;
    const keep = new Set(refs.map(sessionKey));
    for (const key of [...this.counts.keys()]) if (!keep.has(key)) this.counts.delete(key);
  }
}
