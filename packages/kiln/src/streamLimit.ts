/**
 * Admission control for stream upgrades.
 *
 * Hearth's streams are cheap to open and expensive to keep: every attach sends a snapshot, and a
 * client that reconnects in a loop (the 0.35.x client forgave its backoff on connect, so a host
 * closing a socket at once produced ~27 new connections a second) costs the tunnel, the kernel's
 * socket table and the host's outbound bandwidth. The client side is fixed where it can be, but a
 * server cannot rely on every client behaving: this bounds the damage at the upgrade.
 *
 * Two rules per peer:
 *  - a **token bucket** for new streams (a burst, then a refill rate), so a reconnect storm is
 *    throttled rather than multiplied;
 *  - a **ceiling on concurrent streams**, so one device cannot fill the host's descriptor table.
 *
 * A refusal is a 429 the client can retry (with the jittered backoff it should already have), not
 * a dropped TCP connection, and it says which of the two limits was hit.
 */

export type StreamLimitVerdict = "ok" | "rate" | "concurrent";

/**
 * The shipped limits, in one place so the refusal copy and the limiter cannot disagree.
 *
 * The concurrency ceiling has to clear the client's own design: Ember watches up to **200**
 * conversations, one socket each (`MAX_WATCHED_CONVERSATIONS`), plus the task graph. A 96 ceiling
 * was therefore not a storm defence but a permanent refusal of ~100 legitimate streams — and their
 * retries looked like a (smaller) storm from the host's side. 256 leaves room for the 200, the tasks
 * stream, and a second window, while still bounding a client that leaks sockets.
 *
 * The burst is what stops a resume-after-sleep turning into a spike; the rate is what bounds a
 * storm. Both are much stricter than the ceiling, which only has to catch runaway accumulation.
 */
export const STREAM_LIMITS = { burst: 48, perSecond: 6, maxConcurrent: 256 } as const;

export type StreamLimiterOptions = {
  /** Streams a peer may open back-to-back before the bucket has to refill. */
  burst?: number;
  /** Tokens added per second, per peer. */
  perSecond?: number;
  /** Live streams one peer may hold at once. */
  maxConcurrent?: number;
  /** Peers with no live streams are forgotten after this long, so the map cannot grow forever. */
  idleMs?: number;
  /** Hard ceiling on remembered peers, for a host that is scanned from many addresses. */
  maxPeers?: number;
  now?: () => number;
};

export type StreamLimiter = {
  admit(peer: string): StreamLimitVerdict;
  release(peer: string): void;
  /** Remembered peers; exposed for the tests and for a future status line. */
  size(): number;
};

type PeerEntry = { tokens: number; updatedAt: number; active: number };

export const createStreamLimiter = (options: StreamLimiterOptions = {}): StreamLimiter => {
  const burst = Math.max(1, options.burst ?? STREAM_LIMITS.burst);
  const perSecond = Math.max(0, options.perSecond ?? STREAM_LIMITS.perSecond);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? STREAM_LIMITS.maxConcurrent);
  const idleMs = Math.max(1_000, options.idleMs ?? 10 * 60_000);
  const maxPeers = Math.max(1, options.maxPeers ?? 4096);
  const now = options.now ?? Date.now;
  const peers = new Map<string, PeerEntry>();

  const forgetIdle = (at: number): void => {
    if (peers.size <= maxPeers) return;
    for (const [peer, entry] of peers) {
      if (entry.active > 0) continue;
      if (at - entry.updatedAt < idleMs) continue;
      peers.delete(peer);
      if (peers.size <= maxPeers) return;
    }
  };

  return {
    admit(peer) {
      const at = now();
      forgetIdle(at);
      const entry = peers.get(peer) ?? { tokens: burst, updatedAt: at, active: 0 };
      // Refill for the time that has passed, capped at the burst so an idle peer cannot bank credit.
      entry.tokens = Math.min(burst, entry.tokens + ((at - entry.updatedAt) / 1000) * perSecond);
      entry.updatedAt = at;
      peers.set(peer, entry);
      if (entry.active >= maxConcurrent) return "concurrent";
      if (entry.tokens < 1) return "rate";
      entry.tokens -= 1;
      entry.active += 1;
      return "ok";
    },
    release(peer) {
      const entry = peers.get(peer);
      if (!entry) return;
      entry.active = Math.max(0, entry.active - 1);
      entry.updatedAt = now();
    },
    size: () => peers.size,
  };
};
