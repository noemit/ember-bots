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
import { QueueConfigDoc, type QueueSendConfig } from "./queueConfig";

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
  /** Isolated per-submission model/effort config to carry onto the replacement submission id. */
  readonly sendConfig?: QueueSendConfig;
};

/**
 * The queued items in `items` that a stop must keep: user inputs only (`steer`/`followUp`).
 * Queued `write` items are not withdrawn by an abort in the first place, so they are not ours to
 * re-place — re-submitting one would duplicate a write.
 */
export const parkedInputs = (
  items: readonly InboxItem[],
  queueConfigs?: Readonly<Record<string, QueueSendConfig>>
): ParkedInput[] =>
  items.flatMap((item) => {
    // Internal Question answers have their own correlated retry/hold lifecycle. Re-parking
    // them as plain human input would discard provenance and bypass explicit Question resume.
    if (item.mode === "write" || item.entry?.kind === "hearth.question-answer") return [];
    const id = String(item.id);
    const sendConfig = queueConfigs && Object.hasOwn(queueConfigs, id) ? queueConfigs[id] : undefined;
    return [
      {
        mode: item.mode,
        content: item.content as unknown,
        id,
        ...(sendConfig !== undefined ? { sendConfig } : {}),
      } as const,
    ];
  });

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
    const queueConfig = await tx.doc(QueueConfigDoc, conversationId);
    const savedConfigs = parked.map((item) =>
      item.sendConfig !== undefined
        ? item.sendConfig
        : Object.hasOwn(queueConfig.items, item.id)
          ? queueConfig.items[item.id]
          : undefined
    );
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
      const cfg = savedConfigs[index];
      if (existing[index] !== undefined) {
        const existingId = String(existing[index].id);
        if (existingId !== item.id) delete queueConfig.items[item.id];
        if (cfg !== undefined) queueConfig.items[existingId] = cfg;
        kept += 1;
        continue;
      }
      const created = await tx.createSubmission({
        conversationId,
        requestId: parkRequestId(conversationId as unknown as number, item.id, item.token),
        type: "input",
        status: "queued",
      });
      delete queueConfig.items[item.id];
      if (cfg !== undefined) {
        queueConfig.items[String(created.id)] = cfg;
      }
      items.push({ id: created.id, mode: item.mode, content: item.content as JsonValue } as InboxItem);
      kept += 1;
    }
    return kept;
  });
};

export type ReorderResult =
  | { readonly ok: true; readonly replacements: Record<string, string> }
  | { readonly ok: false; readonly status: 400; readonly error: string };

/**
 * Atomically reorder all queued input items (`steer` and `followUp`) in a single durable
 * transaction. Validates `orderedIds` against the live `InboxDoc`, settles the original queued
 * submissions as aborted, creates replacement queued submissions in the requested order (since
 * `pi-durable` drains inbox items by ascending submission ID), migrates `QueueConfigDoc` entries,
 * and leaves non-input inbox items (`write`) untouched.
 *
 * Because withdrawal and replacement share one commit, a crash leaves either the exact old order
 * or the exact new order, and a concurrent turn boundary that already placed an item rejects the
 * stale reorder instead of re-parking a duplicate.
 */
export const reorderQueuedInputs = async (
  commit: <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>,
  conversationId: ConversationId,
  orderedIds: readonly string[]
): Promise<ReorderResult> =>
  commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, conversationId);
    const queueConfig = await tx.doc(QueueConfigDoc, conversationId);
    const queued = inbox.items.filter(
      (item): item is Extract<InboxItem, { mode: "steer" | "followUp" }> =>
        item.mode === "steer" || item.mode === "followUp"
    );
    const byId = new Map(queued.map((item) => [String(item.id), item]));
    if (
      orderedIds.length !== queued.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !byId.has(id))
    ) {
      return { ok: false, status: 400, error: "itemIds must list every queued message, once" };
    }

    // All table reads must precede the commit's first table write.
    const existing = await Promise.all(
      orderedIds.map((id) =>
        tx.submissionByRequest(conversationId, parkRequestId(conversationId as unknown as number, id))
      )
    );

    const keptOther = inbox.items.filter((item) => item.mode !== "steer" && item.mode !== "followUp");
    const savedConfigs = orderedIds.map((id) =>
      Object.hasOwn(queueConfig.items, id) ? queueConfig.items[id] : undefined
    );

    const nextQueued: InboxItem[] = [];
    const replacements: Record<string, string> = {};

    for (const [index, id] of orderedIds.entries()) {
      const item = byId.get(id)!;
      const cfg = savedConfigs[index];
      let replacementId = existing[index]?.id;
      if (replacementId === undefined) {
        const created = await tx.createSubmission({
          conversationId,
          requestId: parkRequestId(conversationId as unknown as number, id),
          type: "input",
          status: "queued",
        });
        replacementId = created.id;
      }
      const nextIdStr = String(replacementId);
      if (nextIdStr !== id) delete queueConfig.items[id];
      if (cfg !== undefined) queueConfig.items[nextIdStr] = cfg;
      replacements[id] = nextIdStr;
      nextQueued.push({ id: replacementId, mode: item.mode, content: item.content as JsonValue } as InboxItem);
    }

    for (const item of queued) {
      tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
    }

    inbox.items.splice(0, inbox.items.length, ...keptOther, ...nextQueued);
    return { ok: true, replacements };
  });
