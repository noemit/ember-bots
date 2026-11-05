/**
 * Stopping a conversation while messages are still queued.
 *
 * pi-durable's `Conversation.abort()` withdraws every queued input: each settles `unanswered`
 * with reason `aborted` and leaves `pi.inbox`. That is the right default for a *task* being
 * killed, but it is the wrong answer for the user's stop button. A message the user typed and
 * queued is theirs; a stop means "stop what you are doing", not "and also delete the thing I just
 * asked for". Before this module, pressing stop with a follow-up in the queue silently destroyed
 * that follow-up — no entry, no trace — and `POST /abort` answered `{ ok: true }` as though
 * nothing else had happened.
 *
 * The policy here, chosen to be predictable rather than clever:
 *
 * - **Nothing is dropped, and nothing is auto-sent.** A stop ends the run. It must never be the
 *   case that you press stop and the conversation immediately keeps going on the queued message —
 *   that reads as "stop didn't work". And it must never silently lose the message either.
 * - **The queue is preserved, in the same order.** Whatever was queued is still queued afterwards,
 *   in the same order. It drains the normal way — the next submission places it — so there is
 *   exactly one rule for when a queued message runs, and a stop is not a special case of it.
 * - **The stop says so.** `POST /abort` reports how many messages it kept, and their text, so a
 *   client can tell the user instead of leaving them wondering where their message went.
 *
 * Re-queuing writes each preserved item straight back into `pi.inbox` as a **queued** submission,
 * in the same commit — the same shape `admitSubmission()` writes for a message queued behind a
 * busy run. That matters: `conversation.submit()` on an idle conversation with an empty inbox
 * places the message and *starts a run*, which would make a stop look like it did nothing. A
 * queued item is inert; it is placed by the next normal submission (or by the user pressing send),
 * which is the one rule for when a queued message runs.
 */
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, InboxItem, Tx } from "@earendil-works/pi-durable";
import { InboxDoc } from "@earendil-works/pi-durable";

/**
 * A queued input a stop must keep: the user's own words, in the order they were queued.
 *
 * `mode` is carried, not assumed. A steer is placed at the next *tool* boundary and a follow-up at
 * the next *turn* boundary, so re-parking a steer as a follow-up would quietly change when the
 * message lands; `id` remembers the inbox id it had so the re-queued submission can be identified.
 */
export type ParkedInput = {
  readonly mode: "steer" | "followUp";
  readonly content: unknown;
  /** The inbox id it had before the abort; used to build a stable request id. */
  readonly id: string;
  /**
   * For a re-ordered queue, the submission id is derived from this token rather than the inbox id:
   * a reorder withdraws and re-adds every item, and the inbox ids are new each time.
   */
  readonly token?: string;
};

/**
 * The queued items in `items` that a stop must keep: user inputs only (`steer`/`followUp`).
 * Queued `write` items are not withdrawn by an abort in the first place, so they are not ours to
 * re-place — re-submitting one would duplicate a write.
 */
export const parkedInputs = (items: readonly InboxItem[]): ParkedInput[] =>
  items.flatMap((item) =>
    item.mode === "write"
      ? []
      : [{ mode: item.mode, content: item.content as unknown, id: String(item.id) } as const]
  );

/**
 * The submission id for a message re-queued by a stop — or by a reorder, which passes its own token
 * because a reorder's inbox ids are fresh every time. Stable for a given (conversation, inbox id) so
 * a crash rerun of the operation returns the same submission rather than a second copy.
 */
export const parkRequestId = (conversationId: number, inboxId: string, token?: string): string =>
  `hearth.park:${conversationId}:${token ?? inboxId}`;

/**
 * Put `parked` back into a conversation's `pi.inbox` as queued submissions, in order, in one
 * commit. Queued `write` items are left exactly as they are: an abort never withdraws them.
 *
 * Returns how many were re-queued. Idempotent for a rerun: a submission whose request id already
 * exists is skipped, so a crash after the commit cannot double a message.
 */
export const parkInputs = async (
  commit: <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>,
  conversationId: ConversationId,
  parked: readonly ParkedInput[]
): Promise<number> => {
  if (parked.length === 0) return 0;
  return commit(async (tx) => {
    // Table reads must precede the commit's first table write, so resolve every request id and the
    // inbox up front. `tx.doc()` is not a table read, but keep it with the rest for clarity.
    const items = (await tx.doc(InboxDoc, conversationId)).items;
    const existing = await Promise.all(
      parked.map((item) =>
        tx.submissionByRequest(
          conversationId,
          parkRequestId(conversationId as unknown as number, item.id, item.token)
        )
      )
    );
    let kept = 0;
    for (const [index, item] of parked.entries()) {
      if (existing[index] !== undefined) {
        kept += 1;
        continue;
      }
      const created = await tx.createSubmission({
        conversationId,
        requestId: parkRequestId(conversationId as unknown as number, item.id, item.token),
        type: "input",
        status: "queued",
      });
      items.push({ id: created.id, mode: item.mode, content: item.content as JsonValue } as InboxItem);
      kept += 1;
    }
    return kept;
  });
};
