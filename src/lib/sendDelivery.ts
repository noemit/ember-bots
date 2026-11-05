/**
 * What a submit told Ember, and what the transcript should say about it.
 *
 * Nothing here reads a clock. An optimistic send is `sending` while the request is in flight,
 * `queued` once the server answers that it holds the message and will dispatch it later,
 * `unconfirmed` once the server says it placed the message but its echo has not appeared in the
 * transcript yet, and `failed` only on a definite failure (a transport error, a non-2xx response,
 * or a response that names a refused submission).
 *
 * Only `unconfirmed` is ever doubted, and only by the bubble's own note after a bounded wait
 * (`UNCONFIRMED_SEND_MS`, below): a placed message whose copy never lands is the one case where a
 * 2xx is not evidence that the message is in the conversation. `queued` is never doubted — the
 * server holds it and a boundary may be an entire turn away.
 */
import type { ChatMessage } from '../types';

export type SubmitOutcome =
  /** The server took the message. `queued` means it is parked in the inbox; `steer` means it
   *  joins the running turn at the next boundary (also admitted with `status: "queued"`). */
  | { kind: 'accepted'; queued: boolean; steer: boolean; submissionId?: string }
  /** A definite refusal: a transport error, a non-2xx status, or a rejected submission. */
  | { kind: 'failed'; error?: string };

/**
 * Submission statuses that mean "the server did not take it", if a wire ever reports one.
 *
 * `unanswered` is pi-durable's terminal state for an input that settled *without reaching the
 * transcript*: a stop that withdrew it (`reason: "aborted"`), a stale drop, a provider failure
 * before placement. The server answers such a retry with the settled record — so pretending it was
 * accepted shows a bubble as sent for a message that will never run. When the record does carry an
 * `entry` (it did land, then was stopped), the message is in the conversation and the bubble must
 * stay: that case is handled below and is not a refusal.
 */
const REFUSED_STATUSES = new Set(['rejected', 'refused', 'failed', 'error', 'unanswered']);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** First non-empty sentence a refusal carried, under either of the two field names Hearth uses. */
const refusalTextOf = (body: Record<string, unknown> | null): string | undefined => {
  const error = body?.error;
  if (typeof error === 'string' && error.trim()) return error;
  const reason = body?.reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
};

/**
 * Read a submit response body. A 2xx is confirmation on its own; the body only refines it (a
 * queued message, a steer) or, for a wire that names a refused submission in a 2xx body, says
 * the message did not land. An absent or unrecognizable body is still an acceptance: the server
 * answered, which is what confirmation means.
 */
export const submitOutcomeOf = (data: unknown, options: { steer?: boolean } = {}): SubmitOutcome => {
  const body = asRecord(data);
  const status = typeof body?.status === 'string' ? body.status.toLowerCase() : undefined;
  if (status && REFUSED_STATUSES.has(status)) {
    // `unanswered` with an entry placed the message: it is in the transcript however it settled,
    // so reporting a failure would be wrong. Only a settlement with no entry is a refusal.
    const placed = status === 'unanswered' && body?.entry !== undefined && body?.entry !== null;
    if (!placed) return { kind: 'failed', error: refusalTextOf(body) };
  }
  const mode = typeof body?.mode === 'string' ? body.mode.toLowerCase() : undefined;
  const submissionId =
    body?.submissionId === undefined || body?.submissionId === null ? undefined : String(body.submissionId);
  return {
    kind: 'accepted',
    queued: status === 'queued',
    steer: options.steer === true || mode === 'steer',
    submissionId,
  };
};

/**
 * The bubble's delivery state once the request settles.
 *
 * The bubble is on screen from the moment the user sends, so this only decides what note it keeps:
 *
 * - A placed message is `unconfirmed`: the server took it, but "took it" is not "it is in the
 *   conversation". The note stays quiet until `UNCONFIRMED_SEND_MS`, and the echo — which normally
 *   lands in under a second — replaces the bubble with the server's own copy and ends it.
 * - A queued steer keeps a factual `queued` note ("Waiting for the turn to pause") until the echo
 *   lands; `reconcileOptimistic` clears the bubble when the server copy appears.
 * - A plain follow-up on Hearth is not in the transcript at all: the queue row is its home, so the
 *   caller moves the bubble there and never reaches this function with `queued` set.
 */
export const deliveryAfterAcceptance = (
  outcome: Extract<SubmitOutcome, { kind: 'accepted' }>
): ChatMessage['delivery'] => (outcome.queued ? 'queued' : 'unconfirmed');

/**
 * How long a placed message may wait for its echo before the bubble says so.
 *
 * Longer than a transcript poll (20s while the stream is live) plus the send's own full read, so a
 * message that merely landed slowly is never accused; short enough that a message the host lost
 * says so while the person is still looking at it.
 */
export const UNCONFIRMED_SEND_MS = 25_000;

/** What a stop reported about the messages it did not throw away. */
export type AbortReceipt = {
  ok: boolean;
  /** How many unsent messages the host kept. */
  parked: number;
  /** A one-line preview of each kept message, in the host's own words. */
  parkedText: string[];
};

export const NO_ABORT_RECEIPT: AbortReceipt = { ok: true, parked: 0, parkedText: [] };

/** Read a stop's answer. An absent body means "stopped", and says nothing about what it kept. */
export const abortReceiptOf = (ok: boolean, data: unknown): AbortReceipt => {
  const body = asRecord(data);
  const parked = typeof body?.parked === 'number' && Number.isFinite(body.parked) ? body.parked : 0;
  const parkedText = Array.isArray(body?.parkedText)
    ? body.parkedText.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { ok, parked: Math.max(0, parked), parkedText };
};

/**
 * Whether a stop kept this message.
 *
 * Hearth re-parks everything the abort withdrew, in the same mode, and reports a preview of each
 * kept message — which is the only evidence a client has that a stopped send is still in the host's
 * hands. Previews are truncated on the host, so a prefix match either way is a match. A message
 * with no text (an image) cannot be told apart from another, so a stop that kept anything is treated
 * as having kept it: the bubble must never be called lost while an alternative is on the table.
 */
export const stopHeldMessage = (receipt: AbortReceipt | undefined, text: string): boolean => {
  if (!receipt || receipt.parked <= 0) return false;
  const flatten = (value: string) => value.replace(/\s+/g, ' ').trim();
  const wanted = flatten(text);
  if (wanted.length === 0) return true;
  return receipt.parkedText.some((preview) => {
    const held = flatten(preview);
    if (held.length === 0) return false;
    return wanted === held || wanted.startsWith(held) || held.startsWith(wanted);
  });
};

/**
 * How long a message may sit as `queued` with an idle session before it is called abandoned.
 *
 * `queued` means the host holds it and will place it at the turn's next boundary. A turn that is
 * *stopped* never reaches one: pi-durable settles queued inputs `unanswered` and drops them from the
 * inbox (`harness/inbox.js` — `reason: "aborted"`, or `"stale"`). So a queued bubble over an idle
 * session is a ghost — nothing will ever place it — and it also pins itself to the bottom of the
 * transcript, which is why later messages appear above it.
 *
 * The wait is deliberate: a boundary placement is a commit away, and calling a message abandoned a
 * second too early would tell someone their message failed when it landed.
 */
export const ABANDONED_STEER_MS = 10_000;

/**
 * Whether a bubble is waiting for a placement that can no longer come.
 *
 * Deliberately conservative. It fires only for `queued` (a `sending` request is still in flight, and a
 * `failed` one has already been reported), only when the session is idle, only after the grace above,
 * and never when the same text is already on the transcript or parked in the queue — a message that
 * landed from *either* is not abandoned, whatever the bubble's own state drifted to. `hostHolds`
 * covers the same ground from the other side: a stop's own receipt says whether it kept the message,
 * which is evidence the queue read has not caught up with yet.
 */
export const steerAbandoned = (state: {
  delivery: ChatMessage['delivery'] | undefined;
  createdAt?: number;
  /** The conversation has no run in flight. */
  sessionBusy: boolean;
  /** The same text is already an entry, or already sits in the queue. */
  landed: boolean;
  /**
   * The host says it still holds this message (a stop's receipt, or its inbox). Then it is waiting,
   * not lost, and offering to send it again would duplicate it.
   */
  hostHolds?: boolean;
  now: number;
}): boolean =>
  state.delivery === 'queued' &&
  state.hostHolds !== true &&
  !state.sessionBusy &&
  !state.landed &&
  state.createdAt !== undefined &&
  state.now - state.createdAt >= ABANDONED_STEER_MS;
