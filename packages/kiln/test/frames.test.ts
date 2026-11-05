import { describe, expect, test } from "bun:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Op } from "@earendil-works/chord/delta";
import { framesOf } from "../src/frames";

/**
 * The stream's wire shape, which is the one thing both sides must agree on.
 *
 * pi-durable 1.5.0 removed the event protocol (`message_update`, `turn_end`, …) and hands a watcher a
 * `ConversationView` plus the Chord ops that moved it. These cases pin what Hearth makes of that: the
 * live view on attach, text appends as the only per-token frame, entries that landed, and a hint for
 * everything else.
 */
const view = (overrides: Partial<ConversationView> = {}): ConversationView => ({
  conversation: { id: 7 } as ConversationView["conversation"],
  entries: [],
  docs: {
    "pi.live": { run: undefined } as never,
    "pi.inbox": { items: {}, revision: 0 } as never,
    "pi.agent": {} as never,
    // Not streamed: a client reads documents it can fetch itself.
    "pi.notes": {} as never,
  },
  ...overrides,
});

describe("the attach frame", () => {
  test("it carries the live documents and the conversation, never the transcript", () => {
    const frames = framesOf(undefined, view({ entries: [{ id: 1 } as never] }), []);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { type: string; docs: Record<string, unknown>; conversation: { id: number }; entries?: unknown };
    expect(frame.type).toBe("view");
    expect(frame.conversation.id).toBe(7);
    // History is `GET /entries`: a window of entries here is the megabyte-per-reconnect the
    // pi-durable window exists to remove.
    expect(frame.entries).toBeUndefined();
    expect(Object.keys(frame.docs).sort()).toEqual(["pi.agent", "pi.inbox", "pi.live"]);
  });

  test("a replacement op re-sends the view, because the ops no longer describe the change", () => {
    const frames = framesOf(view(), view({ docs: { "pi.live": {} as never } }), [["r", {} as never]]);
    expect(frames.map((frame) => frame.type)).toEqual(["view"]);
  });
});

describe("per-commit frames", () => {
  test("streamed text is a delta, with the block index and whether it is thinking", () => {
    const ops: Op[] = [
      ["a", ["docs", "pi.live", "generation", "message", "content", 2, "text"], "hello"],
      ["a", ["docs", "pi.live", "generation", "message", "content", 0, "thinking"], "hmm"],
    ];
    const frames = framesOf(view(), view(), ops);
    expect(frames).toEqual([
      {
        type: "text",
        deltas: [
          { index: 2, text: "hello", kind: "text" },
          { index: 0, text: "hmm", kind: "thinking" },
        ],
      },
    ]);
  });

  test("entries that landed are handed over, so a client can append without re-reading", () => {
    const entries = [{ id: 11 }, { id: 12 }];
    const ops: Op[] = [["p", ["entries"], 0, 0, entries as never]];
    const frames = framesOf(view(), view(), ops);
    expect(frames).toEqual([{ type: "appended", entries }]);
  });

  test("a tool slot's output and an inbox edit are changes, not streaming text", () => {
    const ops: Op[] = [
      ["a", ["docs", "pi.live", "tools", 0, "output"], "compiling…"],
      ["s", ["docs", "pi.inbox", "revision"], 3 as never],
    ];
    const frames = framesOf(view(), view(), ops);
    expect(frames).toEqual([{ type: "changed", kinds: ["inbox", "live"] }]);
  });

  test("the parts of pi.live that mean something different are named", () => {
    // A run starting or ending is a status change (and at the end a transcript read), a compaction
    // can rewrite history so a client needs a full read, and a failed run needs to be visible
    // rather than inferred from silence.
    expect(framesOf(view(), view(), [["s", ["docs", "pi.live", "run"], { taskId: 1 } as never]])).toEqual([
      { type: "changed", kinds: ["run_start"] },
    ]);
    expect(framesOf(view(), view(), [["d", ["docs", "pi.live", "run"]]])).toEqual([
      { type: "changed", kinds: ["run_end"] },
    ]);
    expect(framesOf(view(), view(), [["s", ["docs", "pi.live", "runFailure"], { reason: "model_error" } as never]])).toEqual([
      { type: "changed", kinds: ["run_failure"] },
    ]);
    expect(framesOf(view(), view(), [["p", ["docs", "pi.live", "compactions"], 0, 0, [{} as never]]])).toEqual([
      { type: "changed", kinds: ["compaction"] },
    ]);
    expect(framesOf(view(), view(), [["s", ["docs", "pi.provider", "failure"], {} as never]])).toEqual([
      { type: "changed", kinds: ["provider"] },
    ]);
  });

  test("a commit this host cannot describe still says something changed", () => {
    // Dropping it would show the client a transcript that stopped, which is the failure the whole
    // stream exists to avoid; "look again" costs one tail read.
    const frames = framesOf(view(), view(), [["s", ["conversation", "title"], "renamed" as never]]);
    expect(frames).toEqual([{ type: "changed", kinds: ["conversation"] }]);
    expect(framesOf(view(), view(), [["m", ["entries"], [0]]])).toEqual([{ type: "changed", kinds: ["entries"] }]);
    expect(framesOf(view(), view(), [])).toEqual([]);
  });
});
