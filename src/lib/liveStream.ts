/**
 * Applying the stream's message deltas instead of refetching for every one of them.
 *
 * Hearth's stream is state-based since 0.41.0 (pi-durable 1.5.0): the
 * host derives the appends from the watch's operations and sends them as `{ index, kind, text }`
 * deltas, which the transport passes through (`PiDelta`) and this folds into the live message already
 * on screen. The REST read is not removed — it becomes correction
 * rather than delivery, and every read replaces the live message outright, so drift cannot survive
 * one. A lost frame (the wire has no sequence number) therefore costs at most the tail of one turn's
 * streaming text, never the committed transcript: `turn_end` still reads.
 *
 * Off means every hint takes the REST path exactly as 0.53.x did.
 */
import { LIVE_MESSAGE_ID } from './piMapping';
import type { ChatMessage, LiveDelta, MessagePart } from '../types';

export const APPLY_STREAM_DELTAS = true;

/** The part id a content block maps to; `liveGenerationMessage` builds them in block order. */
const partId = (index: number): string => `${LIVE_MESSAGE_ID}-${index}`;

/** Reasoning parts render as `reasoning`; the wire calls the block `thinking`. */
const partTypeOf = (kind: LiveDelta['kind']): MessagePart['type'] =>
  kind === 'text' ? 'text' : 'reasoning';

const indexOfPart = (id: string): number | null => {
  const match = /^pi-live-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
};

/**
 * Fold streamed appends into the live message, returning the array unchanged when there is nothing
 * to apply (so a no-op cannot re-render the column) and `null` when there is no live message to
 * apply them to — the caller's cue to take the REST path, which is also the only way the first
 * chunk of a turn reaches the screen.
 */
export const applyLiveDeltas = (
  messages: readonly ChatMessage[],
  deltas: readonly LiveDelta[]
): ChatMessage[] | null => {
  if (deltas.length === 0) return messages as ChatMessage[];
  const at = messages.findIndex((message) => message.live === true);
  if (at < 0) return null;
  const live = messages[at];

  const parts = [...live.parts];
  let changed = false;
  for (const delta of deltas) {
    if (!delta.text) continue;
    const id = partId(delta.index);
    const existing = parts.findIndex((part) => part.id === id);
    if (existing < 0) {
      // A block that has not appeared yet (the first token of a new paragraph or of the reasoning).
      const part: MessagePart =
        delta.kind === 'text'
          ? { type: 'text', id, text: delta.text }
          : { type: 'reasoning', id, text: delta.text };
      parts.push(part);
      changed = true;
      continue;
    }
    const part = parts[existing];
    // A kind mismatch means the block changed shape under us (a tool call where text was): stop
    // guessing and let the read settle it.
    if (part.type !== partTypeOf(delta.kind)) return null;
    if (part.type === 'text') parts[existing] = { ...part, text: part.text + delta.text };
    else if (part.type === 'reasoning') parts[existing] = { ...part, text: part.text + delta.text };
    else return null;
    changed = true;
  }
  if (!changed) return messages as ChatMessage[];

  // Parts are indexed by content block, but streamed blocks can arrive out of order once a tool
  // call interleaves; keep the rendered order stable and predictable.
  parts.sort((left, right) => (indexOfPart(left.id) ?? 0) - (indexOfPart(right.id) ?? 0));
  // `text` is the concatenation of the text parts (that is what `liveGenerationMessage` sets), so
  // anything reading it — the summary, search, the stall clock — sees the same content as a read.
  const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  const next = [...messages];
  next[at] = { ...live, text, parts };
  return next;
};
