import type { ChatMessage, ToolCall } from '../types';
import { messageSignature } from './messageSignature';
import { sameRenderedContent } from './piMapping';

export type TranscriptReconciliation = {
  messages: ChatMessage[];
  reconciledOptimisticIds: string[];
  needsFullFetch: boolean;
};

/**
 * Every field of a tool call the transcript can render.
 *
 * `messageSignature` lives in `messageSignature.ts` and digests the call's scalar fields, input,
 * output and diff. Two things it cannot see are the ones that change *without* any of those moving:
 * a `codemode` script's `nestedCalls` (each nested call settles on its own, while the outer call's
 * status and input stay identical) and the `fullOutputPath` the host hands over once a long output
 * has been written to disk. Both are compared here so a call that changed only in those fields is
 * not structurally shared back into the old object — which would leave the row frozen mid-flight.
 */
export const toolCallEqual = (a: ToolCall, b: ToolCall): boolean => {
  if (a === b) return true;
  if (a.fullOutputPath !== b.fullOutputPath) return false;
  const before = a.nestedCalls ?? [];
  const after = b.nestedCalls ?? [];
  if (before.length !== after.length) return false;
  return after.every((call, index) => {
    const previous = before[index];
    return (
      previous.id === call.id &&
      previous.name === call.name &&
      previous.args === call.args &&
      previous.status === call.status &&
      previous.durationMs === call.durationMs &&
      previous.error === call.error
    );
  });
};

/** Every tool part of `a` matches the one at the same position in `b`, nested calls included. */
const toolPartsEqual = (a: ChatMessage, b: ChatMessage): boolean => {
  if (a.parts.length !== b.parts.length) return false;
  return a.parts.every((part, index) => {
    const other = b.parts[index];
    if (part.type !== 'tool' || other.type !== 'tool') return true;
    return toolCallEqual(part.call, other.call);
  });
};

/** Same renderer-observable content, so the previous object can be reused. */
export const equalMessage = (a: ChatMessage, b: ChatMessage): boolean =>
  a === b || (messageSignature(a) === messageSignature(b) && toolPartsEqual(a, b));

/**
 * A sent-but-not-yet-indexed user turn. The server copy may reuse our client id (modern builds) or
 * get a fresh one (legacy); matching on the outgoing shape lets both reconcile to the same bubble.
 */
export const outgoingMessageSignature = (message: ChatMessage): string | null => {
  if (message.role !== 'user') return null;
  const files = message.parts
    .filter((part) => part.type === 'file')
    .map((part) => [part.file.mime, part.file.filename]);
  return JSON.stringify([message.text, files]);
};

/**
 * Reuses previous message objects for records a fresh fetch left unchanged. Returns the previous
 * array itself when length, order and every reference are unchanged, so React.memo rows skip work.
 */
export function shareMessageReferences(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): ChatMessage[] {
  if (previous.length === 0) return next as ChatMessage[];
  const byId = new Map(previous.map((message) => [message.id, message]));
  const shared = next.map((message) => {
    const old = byId.get(message.id);
    return old && equalMessage(old, message) ? old : message;
  });
  if (shared.length === previous.length && shared.every((message, index) => message === previous[index])) {
    return previous as ChatMessage[];
  }
  return shared;
}

type OptimisticReconciliation = {
  unmatched: ChatMessage[];
  reconciledIds: string[];
};

/**
 * Pairs pending optimistic turns against a fetched server list. A message is reconciled when the
 * server either preserves its id or returns a *new* record with the same outgoing shape; matching
 * only against records absent from the current transcript keeps an older identical turn from
 * swallowing the match.
 */
const reconcileOptimistic = (
  current: readonly ChatMessage[],
  fetched: readonly ChatMessage[],
  pendingIds: ReadonlySet<string>
): OptimisticReconciliation => {
  const pending = current.filter((message) => pendingIds.has(message.id));
  if (pending.length === 0) return { unmatched: [], reconciledIds: [] };

  const fetchedIds = new Set(fetched.map((message) => message.id));
  const knownIds = new Set(
    current.filter((message) => !pendingIds.has(message.id)).map((message) => message.id)
  );
  const candidates = fetched.filter((message) => !knownIds.has(message.id));
  const consumed = new Set<number>();
  const unmatched: ChatMessage[] = [];
  const reconciledIds: string[] = [];

  pending.forEach((message) => {
    if (fetchedIds.has(message.id)) {
      reconciledIds.push(message.id);
      return;
    }
    const signature = outgoingMessageSignature(message);
    if (signature === null) {
      unmatched.push(message);
      return;
    }
    const index = candidates.findIndex(
      (candidate, candidateIndex) =>
        !consumed.has(candidateIndex) && outgoingMessageSignature(candidate) === signature
    );
    if (index < 0) {
      unmatched.push(message);
      return;
    }
    consumed.add(index);
    reconciledIds.push(message.id);
  });

  return { unmatched, reconciledIds };
};

/**
 * A complete response is authoritative: it replaces the transcript and keeps unmatched sends.
 *
 * It keeps the in-flight generation too, when it does not carry one itself. A full repair can land
 * mid-turn — a compaction ends, a reconnect catches up, a switch-in fixes a gap — and blanking the
 * streaming answer while the turn is still writing it is the worst possible moment to look empty.
 * The held slot is carried only while nothing in the fetched transcript supersedes it
 * (`survivingLive`), so a repair that does carry the settled entry still retires it.
 */
export function reconcileFullTranscript(
  current: readonly ChatMessage[],
  fetched: readonly ChatMessage[],
  pendingIds: ReadonlySet<string>
): TranscriptReconciliation {
  const { unmatched, reconciledIds } = reconcileOptimistic(current, fetched, pendingIds);
  const settled = unmatched.length > 0 ? [...fetched, ...unmatched] : (fetched as ChatMessage[]);
  // A read that carries `pi.live` (or a message the slot has since become) has the newest word on
  // the generation; only a read without one needs the held slot carried over.
  const live = fetched.some((message) => message.live === true)
    ? []
    : survivingLive(
        current.filter((message) => message.live === true),
        settled
      );
  const final = live.length > 0 ? [...settled, ...live] : settled;
  return {
    messages: shareMessageReferences(current, final),
    reconciledOptimisticIds: reconciledIds,
    needsFullFetch: false,
  };
}

/**
 * A bounded tail is not authoritative. Preserve the current prefix up to the earliest overlapping
 * message, replace the suffix with the fetched tail, and keep unmatched sends. With no overlap the
 * server may have compacted or rewritten history — unless the tail is newer than everything held,
 * which is an ordinary append past our window (`tailIsPastHeld`), so only a genuinely unreconcilable
 * one asks the caller for a full repair instead of gluing on a discontinuous tail.
 *
 * The tail asks for Hearth's documents too (`docs=1`), so it carries the in-flight generation's
 * message (`pi.live`) and reasoning is shown as it streams rather than at the end of the turn.
 * A tail that does *not* carry one (an older Hearth, a background read) keeps the live message the
 * caller already holds: it is carried over until a settled message for that turn arrives, so a
 * routine refresh never blanks text the user is watching, and never leaves it behind once its
 * entry lands.
 */
export function reconcileTranscriptTail(
  current: readonly ChatMessage[],
  fetchedTail: readonly ChatMessage[],
  pendingIds: ReadonlySet<string>
): TranscriptReconciliation {
  const live = current.filter((message) => message.live === true);
  const settled = live.length > 0 ? current.filter((message) => message.live !== true) : current;
  // A tail that fetched `pi.live` carries the newest generation state itself; anything it brought
  // is fresher than what the caller holds, so the held copy must not be kept as well.
  const fetchedLive = fetchedTail.filter((message) => message.live === true);
  const fetchedSettled =
    fetchedLive.length > 0 ? fetchedTail.filter((message) => message.live !== true) : fetchedTail;
  const { unmatched, reconciledIds } = reconcileOptimistic(settled, fetchedSettled, pendingIds);

  if (settled.length === 0) {
    // Nothing held: the tail is the transcript. Keep the fetched array's identity when there is
    // nothing to add, so a first read doesn't churn every message reference.
    const parts = [...fetchedSettled, ...fetchedLive, ...unmatched];
    const final =
      parts.length === fetchedTail.length && parts.every((message, at) => message === fetchedTail[at])
        ? fetchedTail
        : (parts as ChatMessage[]);
    return {
      messages: shareMessageReferences(current, final),
      reconciledOptimisticIds: reconciledIds,
      needsFullFetch: false,
    };
  }

  const currentIds = new Set(settled.map((message) => message.id));
  const overlapIndex = fetchedSettled.findIndex((message) => currentIds.has(message.id));
  const afterWindow = overlapIndex < 0 && tailIsPastHeld(settled, fetchedSettled);
  // No overlap is *usually* a rewrite, and that is why this used to ask for a full read every time.
  // But it is also what a turn looks like when it grew past the window Ember held: a long run, a
  // busy poll that was turned away, a quiet session that woke up — the fetched tail is simply newer
  // than everything held (`afterWindow`). The full read that answered it is the whole conversation in
  // one response, which a real long session exceeds the 32 MB response cap with, so it could never
  // succeed and was asked for again on every trigger. A gluing `afterWindow` is the cheap answer and
  // the true one; genuinely unreconcilable history still asks for the full read below.
  if (overlapIndex < 0 && !afterWindow) {
    return {
      messages: current as ChatMessage[],
      reconciledOptimisticIds: reconciledIds,
      needsFullFetch: true,
    };
  }
  // `afterWindow` keeps everything held: the tail does not touch it, it only follows it.
  const overlapId = afterWindow ? undefined : fetchedSettled[overlapIndex].id;
  const currentOverlap = settled.findIndex((message) => message.id === overlapId);
  const prefix = afterWindow ? settled : settled.slice(0, currentOverlap);
  const base = [...prefix, ...fetchedSettled];
  const baseIds = new Set(base.map((message) => message.id));
  const appended = unmatched.filter((message) => !baseIds.has(message.id));
  // Keep a held live message only when this tail brought none.
  const carried = fetchedLive.length > 0 ? fetchedLive : survivingLive(live, base);
  const kept = [...base, ...appended, ...carried];
  return {
    messages: shareMessageReferences(current, kept),
    reconciledOptimisticIds: reconciledIds,
    needsFullFetch: false,
  };
}

/**
 * Whether a tail with no overlap is *newer* than everything held, rather than a different history.
 *
 * The truth wants a per-conversation sequence number on the wire, and today there is none: message
 * ids are it. `e<entry>` is Hearth's entry ordinal and it ascends by position, so a sequence of ids
 * that ascends is a sequence of positions — comparing two of them answers "is this newer?" without
 * trusting the window. A wire that names messages differently (legacy `msg_…`) gets `null` and the
 * old, cautious answer.
 */
const sequenceIds = (messages: readonly ChatMessage[]): number[] | null => {
  const ids: number[] = [];
  for (const message of messages) {
    const match = /^e(\d+)$/.exec(message.id);
    if (match === null) return null;
    ids.push(Number(match[1]));
  }
  return ids;
};

const tailIsPastHeld = (settled: readonly ChatMessage[], fetched: readonly ChatMessage[]): boolean => {
  if (fetched.length === 0) return false;
  const held = sequenceIds(settled);
  const tail = sequenceIds(fetched);
  if (held === null || tail === null) return false;
  const newestHeld = held[held.length - 1];
  // Every fetched id strictly newer than the newest held one. A read that reaches back into the
  // window would have overlapped (and is handled above); a turn that came first and reused ids
  // below our newest is a rewrite, and gluing it on would double the transcript.
  return tail[0] > newestHeld && tail.every((id) => id > newestHeld);
};

/**
 * Live messages a fetched list did not supersede.
 *
 * "Nothing in the list is newer than the generation" is the only test this can afford on the common
 * frame, but it cannot be the *only* test: a settled entry and the slot that previewed it are the
 * same provider message. pi-ai stamps `timestamp` once, when the request starts, and Hearth stores
 * the streaming partial and the committed entry from that one message, so the slot's stamp equals
 * its entry's and the ordering test reads `T >= T` -- on exactly the frame this guard exists for.
 * The answer then renders twice until some later read happens to replace the slot (the successor
 * generation's first partial, or a full read), which is why a duplicate appears and then vanishes.
 *
 * So: retire a slot whose stamp is already settled, and one that renders what the last settled
 * assistant already says (a slot that ran past an aborted partial). Both checks are cheap; the
 * content comparison runs at most once per slot.
 */
const survivingLive = (live: readonly ChatMessage[], base: readonly ChatMessage[]): ChatMessage[] => {
  if (live.length === 0) return [];
  const baseIds = new Set(base.map((message) => message.id));
  const settledStamps = new Set<number>();
  let newest = 0;
  let lastAssistant: ChatMessage | undefined;
  for (const message of base) {
    const at = message.createdAt ?? 0;
    if (at > newest) newest = at;
    if (message.role !== 'assistant') continue;
    lastAssistant = message;
    if (message.createdAt !== undefined) settledStamps.add(message.createdAt);
  }
  return live.filter((message) => {
    if (baseIds.has(message.id)) return false;
    if ((message.createdAt ?? 0) < newest) return false;
    if (message.createdAt !== undefined && settledStamps.has(message.createdAt)) return false;
    return !(lastAssistant && sameRenderedContent(lastAssistant, message.parts, message.text));
  });
};

/**
 * A delta read: the entries newer than the newest one held, and nothing else.
 *
 * The server promises nothing in between was skipped -- a `next` cursor is the caller's cue to take
 * the overlap-based tail instead -- so this appends rather than stitching, which is what makes a
 * cheap `since` read possible at all: a delta has no overlap to anchor on.
 *
 * Any id the fetched list carries wins, so a server copy of a pending send replaces the optimistic
 * one instead of appearing beside it, and a live generation is replaced rather than duplicated. When
 * the read brought no live message, the held one is kept, exactly as the tail path does.
 */
export function reconcileTranscriptAppend(
  current: readonly ChatMessage[],
  fetched: readonly ChatMessage[],
  pendingIds: ReadonlySet<string>
): TranscriptReconciliation {
  const settled = current.filter((message) => message.live !== true);
  const heldLive = current.filter((message) => message.live === true);
  const fetchedLive = fetched.filter((message) => message.live === true);
  const fetchedSettled = fetchedLive.length > 0 ? fetched.filter((message) => message.live !== true) : fetched;
  const { unmatched, reconciledIds } = reconcileOptimistic(settled, fetchedSettled, pendingIds);
  const fetchedIds = new Set(fetchedSettled.map((message) => message.id));
  // Pending sends are re-appended from `unmatched`, and anything the server returned is replaced by
  // its copy below, so neither may stay in the kept prefix.
  const kept = settled.filter((message) => !pendingIds.has(message.id) && !fetchedIds.has(message.id));
  // The held live slot survives only while it is still the newest thing in the transcript. When a read
  // brings the settled entry for the generation the slot was drawing, it carries no live -- and
  // keeping the slot anyway renders the same answer twice: once as the entry, once as the slot. A
  // later read then drops the slot, which is the message "disappearing". `survivingLive` is the tail
  // path's rule for exactly this, reused rather than re-derived.
  const carried = fetchedLive.length > 0 ? fetchedLive : survivingLive(heldLive, [...kept, ...fetchedSettled]);
  return {
    messages: shareMessageReferences(current, [...kept, ...fetchedSettled, ...unmatched, ...carried]),
    reconciledOptimisticIds: reconciledIds,
    needsFullFetch: false,
  };
}
