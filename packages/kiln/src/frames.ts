import type { ConversationView, JsonObject } from "@earendil-works/pi-durable";
import type { Op } from "@earendil-works/chord/delta";

/**
 * What a conversation's stream sends, derived from pi-durable's **state** (1.5.0) instead of its
 * removed event protocol.
 *
 * 1.4.0 emitted `message_update`, `tool_execution_update`, `turn_end` and a dozen more; 1.5.0 asks a
 * renderer to render a `ConversationView` and hands it the operations that moved it. Hearth keeps the
 * same *job* — tell a client what changed, cheaply, without making it re-read a transcript per token —
 * with four frames:
 *
 * - `view` — the conversation record and its documents (the live state a client draws: run,
 *   generation, tools, inbox, agent, usage). Sent on attach and after an overflow, never per commit.
 * - `text` — appends to the in-flight answer's text or thinking, exactly what the old
 *   `message_update.changes` carried and what Ember's `applyLiveDeltas` already consumes. This is the
 *   only frame sent once per token, so it is the only one that must stay tiny.
 * - `appended` — entries that landed in the window (an answer, a tool result, a compaction summary).
 *   A client appends them, or re-reads its tail, as it does today.
 * - `changed` — anything else that moved (a tool slot starting or settling, the run starting or
 *   ending, the inbox, a document, the conversation record). A hint: the client's existing tail read
 *   is the correction, which is what it already does for every non-streaming event.
 *
 * **No history in the stream.** The window's entries are deliberately not sent: history is
 * `GET /conversations/:id/entries`, which is paged and byte-bounded, and duplicating a 100-entry
 * window in the attach frame is the kind of megabyte-per-reconnect the window exists to remove.
 */

export type TextDelta = {
  /** Index of the content block in `pi.live.generation.message.content`. */
  index: number;
  text: string;
  kind: "text" | "thinking";
};

export type ViewFrame = { type: "view"; conversation: ConversationView["conversation"]; docs: Record<string, JsonObject> };
export type TextFrame = { type: "text"; deltas: TextDelta[] };
export type AppendedFrame = { type: "appended"; entries: readonly unknown[] };
export type ChangedFrame = { type: "changed"; kinds: string[] };

export type StreamFrame = ViewFrame | TextFrame | AppendedFrame | ChangedFrame;

/** The documents a stream carries: the live state a client draws, and nothing it can read itself. */
const STREAMED_DOCS = new Set(["pi.live", "pi.inbox", "pi.agent", "pi.usage", "pi.provider"]);

const viewFrame = (view: ConversationView): ViewFrame => {
  const docs: Record<string, JsonObject> = {};
  for (const [kind, value] of Object.entries(view.docs ?? {})) {
    if (STREAMED_DOCS.has(kind)) docs[kind] = value as JsonObject;
  }
  return { type: "view", conversation: view.conversation, docs };
};

/**
 * An append op on the in-flight answer's text, as a delta.
 *
 * The path is `docs.pi.live.generation.message.content.<i>.<text|thinking>`; anything else is not
 * streaming text, and is reported as a change instead.
 */
const textDeltaOf = (op: Op): TextDelta | undefined => {
  if (op[0] !== "a" || op.length !== 3) return undefined;
  const path = op[1];
  if (
    path.length === 7 &&
    path[0] === "docs" &&
    path[1] === "pi.live" &&
    path[2] === "generation" &&
    path[3] === "message" &&
    path[4] === "content" &&
    typeof path[5] === "number" &&
    (path[6] === "text" || path[6] === "thinking")
  ) {
    return { index: path[5], text: op[2], kind: path[6] };
  }
  return undefined;
};

/** Entries an op put into the window: a splice of new items into `entries`. */
const appendedOf = (op: Op): readonly unknown[] | undefined => {
  if (op[0] === "p" && op.length === 5 && op[1].length === 1 && op[1][0] === "entries" && op[4].length > 0) {
    return op[4];
  }
  return undefined;
};

/**
 * The document or field an op touched, as a word a client can log and act on.
 *
 * `pi.live` is split finer than the document because its parts mean different things to a client:
 * a run starting or ending is a status change (and, at the end, a transcript read), a compaction can
 * rewrite history (so it needs a full read), and everything else in it is "look again".
 */
const kindOf = (op: Op): string | undefined => {
  if (op[0] === "r") return undefined;
  const path = op[1];
  if (path[0] === "docs" && typeof path[1] === "string") {
    if (path[1] === "pi.live") {
      switch (path[2]) {
        case "run":
          return op[0] === "d" ? "run_end" : "run_start";
        case "runFailure":
          return "run_failure";
        case "compactions":
        case "compactionFailure":
          return "compaction";
        default:
          return "live";
      }
    }
    return path[1].replace(/^pi\./, "");
  }
  if (path[0] === "conversation") return "conversation";
  if (path[0] === "entries") return "entries";
  return undefined;
};

/**
 * The frames one watch call produces. `previous` is undefined for the attach call; `ops` come from
 * Chord with the new value, and a batch that begins with `["r", …]` is a replacement (an overflow),
 * which is the one case that re-sends the whole view.
 */
export const framesOf = (
  previous: ConversationView | undefined,
  current: ConversationView,
  ops: readonly Op[]
): StreamFrame[] => {
  if (previous === undefined || ops.some((op) => op[0] === "r")) return [viewFrame(current)];
  const deltas: TextDelta[] = [];
  const appended: unknown[] = [];
  const kinds = new Set<string>();
  for (const op of ops) {
    const delta = textDeltaOf(op);
    if (delta !== undefined) {
      deltas.push(delta);
      continue;
    }
    const entries = appendedOf(op);
    if (entries !== undefined) {
      appended.push(...entries);
      continue;
    }
    const kind = kindOf(op);
    if (kind !== undefined) kinds.add(kind);
  }
  const frames: StreamFrame[] = [];
  if (deltas.length > 0) frames.push({ type: "text", deltas });
  if (appended.length > 0) frames.push({ type: "appended", entries: appended });
  // A tool slot's output also appends, and an inbox edit sets a field; both only need the hint that
  // the client's next tail read is worth making.
  if (kinds.size > 0) frames.push({ type: "changed", kinds: [...kinds].sort() });
  // Nothing recognised but something did move (a shape this host does not model yet): say so rather
  // than silently dropping the commit, which a client would show as a transcript that stopped.
  if (frames.length === 0 && ops.length > 0) frames.push({ type: "changed", kinds: ["unknown"] });
  return frames;
};

/** A view document as a frame, for tests and for the attach call. */
export const attachFrames = (view: ConversationView): StreamFrame[] => [viewFrame(view)];
