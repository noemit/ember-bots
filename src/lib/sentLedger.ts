/**
 * The sent-message ledger: a bounded, per-session record of what Ember sent, so a message that
 * vanishes from a later transcript fetch is *noticed* instead of silently lost.
 *
 * Ember already keeps unreconciled optimistic sends alive; this closes the other half — a send
 * that reconciled to a server copy and then disappeared from a refresh (a bad full fetch, a race,
 * a compaction). On each transcript commit we check the ledger and surface a notice + a console
 * warning for anything missing. The record is client-side only; it never fights the server.
 */
import type { ChatMessage } from '../types';
import { outgoingMessageSignature } from './transcriptReconciliation';

export type SentRecord = { id: string; text: string; at: number };
export type SentLedger = Map<string, SentRecord[]>;

/** How long a send is watched before it's assumed stable and dropped from the ledger. */
export const SENT_LEDGER_TTL_MS = 5 * 60_000;
/** Ignore a send for this long so a normal fetch race isn't flagged. */
export const SENT_LEDGER_GRACE_MS = 8_000;
/**
 * How long a *pending* send is trusted.
 *
 * Pending means "the transcript's echo of this is still on its way". A placed send's echo lands on
 * the next read; a steer's waits for a turn boundary, which is why this is generous rather than
 * tight. Past it the record is reported like any other, because a bubble that never reconciled may
 * be the only trace of the message that was ever shown.
 */
export const PENDING_SEND_TTL_MS = 2 * 60_000;
const MAX_PER_SESSION = 50;

export const recordSent = (ledger: SentLedger, key: string, record: SentRecord): void => {
  const list = ledger.get(key) ?? [];
  list.push(record);
  while (list.length > MAX_PER_SESSION) list.shift();
  ledger.set(key, list);
};

/** The outgoing signature of a text-only user message, for matching a server copy. */
const signatureOfText = (text: string): string => JSON.stringify([text, []]);

/**
 * Sent messages that are past the grace period and no longer present in the transcript — by id or
 * by outgoing shape — so nothing on the wire corroborates them any more. Prunes records older than
 * the TTL as a side effect.
 *
 * A pending id no longer hides a record for ever: pending is only trusted while the echo could still
 * be on its way (`PENDING_SEND_TTL_MS`). The message that spent its life as an optimistic bubble
 * with no server copy is exactly the one this exists to notice.
 */
export const missingSent = (
  ledger: SentLedger,
  key: string,
  messages: readonly ChatMessage[],
  pendingIds: ReadonlySet<string>,
  now: number
): SentRecord[] => {
  const list = ledger.get(key);
  if (!list || list.length === 0) return [];
  const fresh = list.filter((record) => now - record.at <= SENT_LEDGER_TTL_MS);
  if (fresh.length !== list.length) ledger.set(key, fresh);
  if (fresh.length === 0) return [];

  const ids = new Set(messages.map((message) => message.id));
  const signatures = new Set(
    messages.map((message) => outgoingMessageSignature(message)).filter((value): value is string => value !== null)
  );
  return fresh.filter((record) => {
    const age = now - record.at;
    if (age < SENT_LEDGER_GRACE_MS) return false;
    // Still pending, and young enough that its echo is plausibly on the way.
    if (pendingIds.has(record.id) && age < PENDING_SEND_TTL_MS) return false;
    if (ids.has(record.id)) return false;
    if (signatures.has(signatureOfText(record.text))) return false;
    return true;
  });
};
