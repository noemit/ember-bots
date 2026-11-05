import { describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { depthOf, digestOf, pruneSpawns, rateLimited, wakeKeyOf } from "../src/crew";
import { rearmWorker, SessionsDoc } from "../src/sessions";
import type { HearthMeta } from "../src/meta";
import type { CrewEntry, SessionsState } from "../src/sessions";

const context = BACKGROUND_CONTEXT;

describe("crew depth", () => {
  test("walks the lead chain to the root", async () => {
    const chain: Record<number, HearthMeta> = {
      1: {},
      2: { lead: { conversationId: 1, host: "local" } },
      3: { lead: { conversationId: 2, host: "local" } },
      4: { lead: { conversationId: 3, host: "local" } },
    };
    const reader = (id: ConversationId): Promise<HearthMeta | undefined> => Promise.resolve(chain[id as number]);
    expect(await depthOf(reader, 1 as ConversationId)).toBe(0);
    expect(await depthOf(reader, 2 as ConversationId)).toBe(1);
    expect(await depthOf(reader, 4 as ConversationId)).toBe(3);
    // A missing meta ends the chain rather than looping.
    expect(await depthOf(reader, 99 as ConversationId)).toBe(0);
  });
});

describe("crew rate cap", () => {
  const now = 1_000_000;
  test("allows up to ten spawns per window, then refuses", () => {
    expect(rateLimited([], now)).toBe(false);
    expect(rateLimited(Array.from({ length: 9 }, (_, index) => now - index * 100), now)).toBe(false);
    expect(rateLimited(Array.from({ length: 10 }, (_, index) => now - index * 100), now)).toBe(true);
    // Spawns older than the window do not count.
    expect(rateLimited(Array.from({ length: 10 }, (_, index) => now - 60_001 - index), now)).toBe(false);
  });

  test("pruneSpawns drops timestamps outside the window", () => {
    expect(pruneSpawns([now - 1, now - 59_999, now - 60_001], now)).toEqual([now - 1, now - 59_999]);
  });
});

describe("crew wake digest", () => {
  test("lists the current generation, caps report text at 300 chars", () => {
    const state: SessionsState = {
      generation: 2,
      spawnedAt: [],
      items: {
        alpha: {
          kind: "worker",
          conversationId: 7 as ConversationId,
          title: "Alpha",
          spawnedAt: 1,
          state: "reported",
          generation: 2,
          briefRequestId: "b",
          report: { status: "ok", text: "X".repeat(400), at: 1, requestId: "r" },
        },
        old: {
          kind: "worker",
          conversationId: 8 as ConversationId,
          title: "Old",
          spawnedAt: 1,
          state: "failed",
          generation: 1,
          briefRequestId: "b",
        },
      },
    };
    const digest = digestOf(state, 2);
    expect(digest).toContain("alpha (reported):");
    expect(digest).toContain("(conversation 7)");
    // An entry from a previous generation is not in this wake.
    expect(digest).not.toContain("old (");
    expect(digest).toContain("X".repeat(300));
    expect(digest).not.toContain("X".repeat(301));
  });
});

describe("crew wake identity", () => {
  const worker = (overrides: Partial<CrewEntry> = {}): CrewEntry => ({
    kind: "worker",
    conversationId: 7 as ConversationId,
    title: "Alpha",
    spawnedAt: 1,
    state: "reported",
    generation: 2,
    briefRequestId: "b",
    report: { status: "ok", text: "done", at: 1, requestId: "report-1" },
    ...overrides,
  });
  const state = (items: Record<string, CrewEntry>, generation = 2): SessionsState => ({
    generation,
    spawnedAt: [],
    items,
  });

  test("keys a wake on the reports it would carry, so a rerun is silent and a new report is not", () => {
    const delivered = state({ alpha: worker() });
    // The same reports always produce the same key: a tick that reruns (or a restart) sends nothing.
    expect(wakeKeyOf(delivered)).toBe(wakeKeyOf(state({ alpha: worker() })));
    // A report the leader has not been shown yet is a different wake — the re-tasked worker's new
    // answer carries a new report id, and a late report adds a name.
    expect(wakeKeyOf(state({ alpha: worker({ report: { status: "ok", text: "again", at: 2, requestId: "report-2" } }) })))
      .not.toBe(wakeKeyOf(delivered));
    expect(wakeKeyOf(state({ alpha: worker(), beta: worker({ conversationId: 8 as ConversationId }) })))
      .not.toBe(wakeKeyOf(delivered));
    // A worker still owing an answer is not part of the key: the wake waits for it.
    expect(wakeKeyOf(state({ alpha: worker({ state: "stopped", report: undefined }) }))).not.toBe(
      wakeKeyOf(delivered)
    );
    expect(wakeKeyOf(state({ alpha: worker({ state: "running", report: undefined }) }))).toBe("2|");
    // A later generation is a different wake, whatever its reports.
    expect(wakeKeyOf(state({ alpha: worker() }, 3))).not.toBe(wakeKeyOf(delivered));
  });
});

/**
 * `rearmWorker` is what the `session` tool's `message` and the `agents` tool's `send` call after they
 * hand a worker more work. The two rules it has to get right: a worker that owes an answer belongs to
 * the generation that will hear about it, and a message queued behind a *running* worker is not
 * answered by the answer that worker is already producing.
 */
describe("rearming a worker", () => {
  const openCrew = async (state: Partial<SessionsState>) => {
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
    const leader = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const workerConversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SessionsDoc, leader.id);
      Object.assign(doc, { generation: 1, items: {}, spawnedAt: [] }, state);
    }, context);
    return { harness, leader: leader.id, worker: workerConversation.id };
  };

  const entry = (overrides: Partial<CrewEntry> = {}): CrewEntry => ({
    kind: "worker",
    conversationId: 1 as ConversationId,
    title: "Worker #1",
    spawnedAt: 1,
    state: "reported",
    generation: 1,
    briefRequestId: "brief",
    ...overrides,
  });

  test("a settled worker after a wake joins the next generation, as a spawn would", async () => {
    const { harness, leader, worker } = await openCrew({
      generation: 1,
      woke: true,
      wokeAt: 1,
      wokeKey: "1|",
      items: { wk: entry({ conversationId: 1 as ConversationId }) },
    });
    await harness.commit(
      async (tx) => {
        (await tx.doc(SessionsDoc, leader)).items.wk.conversationId = worker;
      },
      context
    );
    await harness.commit((tx) => rearmWorker(tx, leader, "wk", worker, Date.now()), context);
    const doc = await harness.snapshot(SessionsDoc, leader, context);
    // The wake that named generation 1 has been delivered, so the new task is generation 2's work —
    // otherwise it is outside `digestOf` and `wakeKeyOf` and its answer is never delivered.
    expect(doc?.generation).toBe(2);
    expect(doc?.woke).toBe(false);
    expect(doc?.items.wk.generation).toBe(2);
    expect(doc?.items.wk.state).toBe("starting");
    await harness.close(context);
  });

  test("a message queued behind a running worker is remembered, not reported as its answer", async () => {
    const { harness, leader, worker } = await openCrew({
      generation: 1,
      items: {
        wk: entry({
          state: "running",
          taskAt: Date.now() - 1_000,
          report: { status: "ok", text: "the old answer", at: 1, requestId: "r" },
        }),
      },
    });
    await harness.commit(
      async (tx) => {
        (await tx.doc(SessionsDoc, leader)).items.wk.conversationId = worker;
      },
      context
    );
    expect(await harness.commit((tx) => rearmWorker(tx, leader, "wk", worker, Date.now()), context)).toBe(true);
    const doc = await harness.snapshot(SessionsDoc, leader, context);
    // Still active — the supervisor is watching — but it now knows the current answer is not the
    // reply to this message, and the stale report is gone.
    expect(doc?.items.wk.state).toBe("running");
    expect(doc?.items.wk.followUpAt).toBeGreaterThan(0);
    expect(doc?.items.wk.report).toBeUndefined();
    await harness.close(context);
  });
});
