/**
 * `ServerWebSocket.send()` has three outcomes, and confusing two of them is what made a slow client
 * expensive. Measured against Bun 1.4.2 with a client that stops reading (`backpressureLimit` 1 MB,
 * 2,000 frames of 64 KB): **40** returned bytes sent, **17** returned `-1`, **1,943** returned `0`,
 * and the client received exactly **57** frames — 40 + 17. So:
 *
 *  - **positive** — queued and written;
 *  - **`-1`** — *backpressure*: the frame **is queued**, the socket is merely over its buffer. There
 *    is no gap;
 *  - **`0`** — *dropped*: the frame is gone, and the stream has no sequence number, so nothing later
 *    can reveal the hole.
 *
 * The old behaviour treated `-1` as "not queued" and answered it by building a full snapshot and
 * retrying it with backoff for a minute. That made a slow client *more* expensive: each retry pushed
 * more bytes into a buffer that was already full, and the snapshot was the value captured when the
 * stream attached — replaying history the client had already moved past. Under Bun's default 16 MB
 * per socket, ~200 sockets stalled at once could pin gigabytes this way.
 *
 * So the two answers are now different:
 *
 *  - `-1` pauses the stream (frames are skipped, nothing is owed) until Bun reports `drain`, and a
 *    socket that never drains is closed after `STALL_GIVE_UP_MS`;
 *  - `0` closes the socket (1013, "try again later") after a jittered delay, so the client
 *    reconnects and attaches to a **fresh** snapshot. A stale snapshot would be worse than a
 *    reconnect: it looks like data, and it silently rewinds the client.
 */
export const RESYNC_CLOSE_CODE = 1013;
export const RESYNC_CLOSE_REASON = "send buffer full; resync";

/**
 * How long a paused stream is given before the socket is closed for a resync.
 *
 * A socket that cannot take a frame for this long is not slow, it is stuck — the client may be
 * asleep, or gone. Closing is what lets it reconnect rather than waiting out the 960 s idle timeout.
 */
export const STALL_GIVE_UP_MS = 60_000;

export type FrameState = {
  /** Set once the socket is being torn down: nothing else may be written to it. */
  lost?: boolean;
  /** Backpressure: the last frame was queued, and no more may be written until `drain`. */
  paused?: boolean;
  /** When the current pause began, for the give-up deadline. */
  pausedSince?: number;
};

export type SendFrameOptions = {
  /** Injectable for tests; production closes after a short random delay. */
  closeDelayMs?: () => number;
  now?: () => number;
  giveUpMs?: number;
};

const closeForResync = (
  socket: { close(code?: number, reason?: string): void },
  state: FrameState,
  what: string,
  options: SendFrameOptions,
  reason: string
): void => {
  state.lost = true;
  state.paused = false;
  const delay = (options.closeDelayMs ?? (() => 200 + Math.random() * 800))();
  console.error(`[hearth] ${what} ${reason}; closing in ${Math.round(delay)}ms so the client reconnects and resyncs`);
  const timer = setTimeout(() => {
    try {
      socket.close(RESYNC_CLOSE_CODE, RESYNC_CLOSE_REASON);
    } catch {
      // Already closed; the client is finding out on its own.
    }
  }, delay);
  timer.unref?.();
};

/**
 * Send one frame and decide what its status means (see the top of this file).
 *
 * Returns true when the frame reached the socket's buffer — including under backpressure, because a
 * queued frame is not a gap. Returns false when it was skipped (paused or lost) or dropped.
 */
export const sendFrame = (
  socket: { send(frame: string): number; close(code?: number, reason?: string): void },
  state: FrameState,
  frame: string,
  what = "stream frame",
  options: SendFrameOptions = {}
): boolean => {
  if (state.lost) return false;
  const now = options.now ?? Date.now;
  const giveUpMs = options.giveUpMs ?? STALL_GIVE_UP_MS;
  // A paused socket is checked even for a frame that would be skipped, so one that never drains
  // cannot be kept alive indefinitely by traffic it cannot take.
  if (state.paused) {
    if (state.pausedSince !== undefined && now() - state.pausedSince > giveUpMs) {
      closeForResync(socket, state, what, options, `could not be written for ${Math.round((now() - state.pausedSince) / 1000)}s`);
    }
    return false;
  }

  let status: number;
  try {
    status = socket.send(frame);
  } catch {
    // A send that throws is a socket that is already gone: a dropped frame, not a crash.
    status = 0;
  }
  if (status > 0) {
    state.paused = false;
    state.pausedSince = undefined;
    return true;
  }
  if (status === -1) {
    // Queued, and the socket is over its buffer: stop writing until Bun says it drained. One log
    // line per pause, not per skipped frame — a slow stream is not a per-token event.
    const first = !state.paused;
    state.paused = true;
    state.pausedSince = now();
    if (first) console.warn(`[hearth] ${what} is over the send buffer (backpressure); pausing this stream until it drains`);
    return true;
  }
  // Dropped: the frame is gone and the protocol cannot show where. Only a fresh attach repairs it,
  // and the snapshot this host holds was captured when the stream attached — stale, so it must not
  // be sent in place of the gap.
  closeForResync(socket, state, what, options, "was dropped (the client is too far behind)");
  return false;
};
