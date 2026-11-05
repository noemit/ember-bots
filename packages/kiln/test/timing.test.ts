import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

/**
 * A provider that streams the way the real chat APIs do (`api/openai-completions.ts` and every
 * sibling): it opens an `AssistantMessageEventStream`, stamps `timestamp: Date.now()` at request
 * start, pushes deltas, then pushes `done` and `end()`s with the same message.
 *
 * That message shape is what Hearth's timing rests on, and it is already there — nothing in Hearth
 * writes these fields:
 * - `AssistantMessage.timestamp` is *request start*, not completion (pi-ai `types.d.ts`).
 * - `AssistantMessage.durationMs` is the monotonic span to the response's end, stamped by
 *   `AssistantMessageEventStream` (`utils/event-stream.js`) on `done`/`error`/`end`.
 * - `Models.streamSimple` wraps every provider in `lazyStream`, whose `forwardStream` re-pushes the
 *   final event into a second `AssistantMessageEventStream`. So the outer stream re-times the
 *   message even if a provider does not: a message that arrives untimed still leaves the provider
 *   with `durationMs`. (Verified: writing `durationMs = -1` after `end()` is overwritten.)
 *
 * The faux provider alone is not faithful here: `fauxAssistantMessage` stamps `timestamp` when the
 * *script* is built, before the stream exists, so `#time` declines on `message.timestamp <
 * startedAt` and the message is untimed unless the script uses a response factory.
 */
const timedStream = (model: any, chunks: readonly string[], delayMs: number) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const message: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: chunks.length,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10 + chunks.length,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    let text = "";
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      text = text === "" ? chunk : `${text} ${chunk}`;
      message.content = [{ type: "text", text }];
      stream.push({ type: "text_delta", contentIndex: 0, delta: ` ${chunk}`, partial: { ...message } });
    }
    message.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  })();
  return stream;
};

/** A harness whose provider streams with the real API's timing contract. */
const openTimedHarness = async (
  chunks: readonly string[],
  delayMs: number
): Promise<{ harness: Harness; providerId: string; modelId: string; faux: ReturnType<typeof fauxProvider> }> => {
  const faux = fauxProvider();
  const providerId = faux.provider.id;
  const modelId = "faux-1";
  const models = createModels();
  models.setProvider({ ...faux.provider, streamSimple: (model: any) => timedStream(model, chunks, delayMs) } as any);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  return { harness, providerId, modelId, faux };
};

const assistantEntries = async (conversation: any): Promise<any[]> => {
  const page = await conversation.entries({}, 100, undefined, context);
  return page.items.filter((entry: any) => AssistantEntry.is(entry));
};

describe("assistant entry timing", () => {
  test("a streamed turn persists a start time and a non-zero duration", async () => {
    const chunks = "a streamed answer that takes measurable time to arrive".split(" ");
    const { harness, providerId, modelId } = await openTimedHarness(chunks, 20);
    try {
      const root = await harness.root(context, { agent: { model: { provider: providerId, modelId } } });
      const wallStart = Date.now();
      const submission = await root.submit({ type: "input", content: "say something" }, context);
      await submission.wait(context);
      const wallMs = Date.now() - wallStart;

      const [entry] = await assistantEntries(root);
      expect(entry).toBeDefined();
      const message = entry.model[0];

      // The start time is the request start, not the completion moment: it must be at or before the
      // wall clock began and far enough back that it precedes the answer.
      expect(typeof message.timestamp).toBe("number");
      expect(message.timestamp).toBeGreaterThanOrEqual(wallStart);
      expect(message.timestamp).toBeLessThanOrEqual(wallStart + wallMs);

      // The duration is the provider's own monotonic measure of the response, persisted alongside it.
      expect(typeof message.durationMs).toBe("number");
      expect(message.durationMs).toBeGreaterThan(0);
      // Plausible: no longer than the whole turn, and at least the scripted stream time.
      expect(message.durationMs).toBeLessThanOrEqual(wallMs + 50);
      expect(message.durationMs).toBeGreaterThanOrEqual((chunks.length - 1) * 20 - 50);

      // What Ember computes: completedAt - createdAt > 0, so tok/s and the duration chip can fire.
      explicitDuration(message);
    } finally {
      await harness.close(context);
    }
  }, 20_000);

  test("an entry written without timing carries none, and nothing throws", async () => {
    // Historical entries predate provider timing: they have no `durationMs`. Reading one must stay
    // quiet — no duration, no tok/s — rather than inventing a value.
    const { harness, providerId, modelId } = await openTimedHarness(["legacy"], 5);
    try {
      const root = await harness.root(context, { agent: { model: { provider: providerId, modelId } } });
      await root.commit(async (tx: any) => {
        const legacy = {
          role: "assistant",
          content: [{ type: "text", text: "an old answer" }],
          api: "faux",
          provider: providerId,
          model: modelId,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1_700_000_000_000,
        };
        await tx.appendEntry(root.id, { kind: "pi.assistant", model: [legacy] });
      }, context);

      const entries = await assistantEntries(root);
      const legacy = entries.find((entry: any) => entry.model[0].content[0]?.text === "an old answer");
      expect(legacy).toBeDefined();
      const message = legacy.model[0];
      expect(typeof message.timestamp).toBe("number");
      expect(message.durationMs).toBeUndefined();
      expect(durationMs(message)).toBeUndefined();
    } finally {
      await harness.close(context);
    }
  }, 20_000);

  test("a duration from a response factory reaches the entry too", async () => {
    // The documented way to get a timed faux response: build the message when the request is made.
    // This is the same contract through pi-ai's own provider, with no test-side stream at all.
    const faux = fauxProvider({ tokensPerSecond: 40 });
    const models = createModels();
    const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai/providers/faux");
    faux.setResponses([
      () => fauxAssistantMessage([fauxText("a factored response that also takes time to stream out")]),
    ]);
    models.setProvider(faux.provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
    try {
      const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: "faux-1" } } });
      const submission = await root.submit({ type: "input", content: "go" }, context);
      await submission.wait(context);
      const [entry] = await assistantEntries(root);
      const message = entry.model[0];
      expect(message.durationMs).toBeGreaterThan(0);
      // Ember's tok/s needs both a start and a positive span.
      explicitDuration(message);
    } finally {
      await harness.close(context);
    }
  }, 20_000);
});

/** The span Ember would compute, mirroring its mapper (`completedAt - createdAt`). */
const durationMs = (message: any): number | undefined =>
  typeof message.durationMs === "number" &&
  typeof message.timestamp === "number" &&
  message.durationMs > 0
    ? message.durationMs
    : undefined;

const explicitDuration = (message: any): void => {
  expect(durationMs(message)).toBeGreaterThan(0);
};
