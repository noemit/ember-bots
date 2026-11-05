import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  DELEGATION_OFF,
  Sessions,
  SessionsDoc,
  spawnRefusal,
  spawnRefusalText,
  CREW_SPAWN_MIN_GAP_MS,
  SPAWN_BUDGET,
} from "../src/sessions";
import { SPAWN_GUARD, spawnGuard, tick } from "../src/crew";
import { MetaDoc } from "../src/meta";

/**
 * Spawn loops. A model that reads "delegate where it helps" as "spawn another worker" could keep a
 * crew growing for ever, because no prompt-level cap stops an agent from *calling* the tool. These
 * pin the guards that make one crew a bounded, single event.
 */

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" } as const;

const WORKER_SPAWN = fauxAssistantMessage(
  [fauxToolCall("session", { action: "spawn", name: "helper", role: "Researcher", brief: "Do it." })],
  { stopReason: "toolUse" }
);

const open = async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-loop-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Sessions);
  const storage = await openNodeSqliteStorage(join(directory, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  harness.resume();
  return { harness, storage, faux, directory };
};

/** A conversation in `meta`, with a resolved model so a turn actually runs. */
const agent = async (harness: Harness, cwd: string, meta: Record<string, unknown> = {}) => {
  const record = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await harness.commit(async (tx) => {
    await configure(tx, record.id, { model, cwd });
    Object.assign(await tx.doc(MetaDoc, record.id), meta);
  }, context);
  return record;
};

const toolTextOf = async (harness: Harness, id: number): Promise<string> => {
  const conversation = await harness.conversation(id as never, context);
  const entries = await conversation!.entries({}, 50, undefined, context);
  return entries.items
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => JSON.stringify(entry.model?.[0] ?? ""))
    .join("\n");
};

const conversationsOf = async (storage: Awaited<ReturnType<typeof open>>["storage"]) =>
  (await storage.scanConversations({}, 50, undefined, context)).items;

describe("spawn loop guards", () => {
  test("the window and the budget are pure and say what to do instead", () => {
    const now = 1_000_000;
    expect(spawnRefusal({}, now)).toBeUndefined();
    // A crew that just reported back: no new crew yet.
    const justWoke = spawnRefusal({ woke: true, wokeAt: now - 30_000, spawnedAt: [] }, now);
    expect(justWoke).toEqual({ minutes: Math.ceil((CREW_SPAWN_MIN_GAP_MS - 30_000) / 60_000) });
    expect(spawnRefusalText(justWoke!)).toContain("reported back");
    // After the window it is allowed again…
    expect(spawnRefusal({ woke: true, wokeAt: now - CREW_SPAWN_MIN_GAP_MS }, now)).toBeUndefined();
    // …until the conversation has asked for its hour's worth of workers.
    const spent = Array.from({ length: SPAWN_BUDGET }, (_, index) => now - index * 1_000);
    expect(spawnRefusal({ spawnedAt: spent }, now)).toEqual({ budget: true });
    expect(spawnRefusalText({ budget: true })).toContain(`${SPAWN_BUDGET} workers in the last hour`);
  });

  test("the tool refuses a conversation whose meta says no delegation", async () => {
    const isolated = await open();
    try {
      isolated.faux.setResponses([WORKER_SPAWN, fauxAssistantMessage([fauxText("understood")])]);
      const record = await agent(isolated.harness, isolated.directory, { delegates: false });
      await (await isolated.harness.conversation(record.id, context))!.submit(
        { type: "input", content: "Spawn a helper." },
        context
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await toolTextOf(isolated.harness, record.id as unknown as number)).includes("Refused")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await toolTextOf(isolated.harness, record.id as unknown as number)).toContain("not to delegate");
      expect(await conversationsOf(isolated.storage)).toHaveLength(1);
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }
  }, 30_000);

  test("the guard hook blocks a spawn before the tool runs", async () => {
    const isolated = await open();
    try {
      const record = await agent(isolated.harness, isolated.directory, { delegates: true });
      expect(SPAWN_GUARD).toBe("hearth-spawn-guard");
      // Delegation off: a plain chat cannot spawn at all.
      await isolated.harness.commit(async (tx) => {
        (await tx.doc(MetaDoc, record.id)).delegates = false;
      }, context);
      const api = {
        conversationId: record.id,
        snapshot: (token: unknown, id: never, ctx: typeof context) =>
          isolated.harness.snapshot(token as typeof MetaDoc, id, ctx),
      };
      const worker = { name: "session", arguments: { action: "spawn", brief: "x" } };
      const beforeTool = spawnGuard.hooks![0].handlers as unknown as {
        beforeTool(call: { name: string; arguments?: unknown }, api: unknown, ctx: typeof context): Promise<
          { block?: string } | undefined
        >;
      };
      const blocked = await beforeTool.beforeTool(worker, api, context);
      expect(blocked?.block).toBe(DELEGATION_OFF);
      // Another tool passes straight through.
      expect(await beforeTool.beforeTool({ name: "bash", arguments: {} }, api, context)).toBeUndefined();
      // With delegation on, a peer is explicit and never counted against the loop guards.
      await isolated.harness.commit(async (tx) => {
        (await tx.doc(MetaDoc, record.id)).delegates = true;
      }, context);
      // A peer is explicit and never counted against the loop guards.
      expect(
        await beforeTool.beforeTool({ name: "session", arguments: { action: "spawn", kind: "peer" } }, api, context)
      ).toBeUndefined();
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }
  }, 30_000);

  test("a leader is not woken into a second crew right after its crew reported", async () => {
    const isolated = await open();
    try {
      isolated.faux.setResponses([WORKER_SPAWN, fauxAssistantMessage([fauxText("understood")])]);
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(worker.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage([fauxText("did the thing")])],
        });
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.generation = 1;
        doc.deadlineAt = Date.now() + 60_000;
        doc.items["wk"] = {
          kind: "worker",
          conversationId: worker.id,
          title: "wk",
          spawnedAt: Date.now() - 1_000,
          state: "starting",
          generation: 1,
          briefRequestId: "brief",
        };
      }, context);
      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);
      const woke = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(woke?.woke).toBe(true);
      expect(typeof woke?.wokeAt).toBe("number");

      // The leader answers the wake by delegating again. That would start a new generation, and a
      // new generation waits out the window, so no second worker appears.
      await (await isolated.harness.conversation(leader.id, context))!.submit(
        { type: "input", content: "plenty to do?" },
        context
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(Object.keys(after?.items ?? {})).toEqual(["wk"]);
      expect(await toolTextOf(isolated.harness, leader.id as unknown as number)).toContain("reported back");
      // Still one conversation beyond the leader and its one worker.
      expect(await conversationsOf(isolated.storage)).toHaveLength(2);
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }
  }, 30_000);

  test("a worker at the depth cap does not get the crew tool, and a spawn there is refused", async () => {
    const isolated = await open();
    try {
      isolated.faux.setResponses([WORKER_SPAWN, fauxAssistantMessage([fauxText("understood")])]);
      const parent = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      // Give it a lead chain two deep, so the spawn it attempts would be depth 3.
      const root = await agent(isolated.harness, isolated.directory);
      const middle = await agent(isolated.harness, isolated.directory);
      await isolated.harness.commit(async (tx) => {
        (await tx.doc(MetaDoc, middle.id)).lead = { conversationId: root.id, host: "local" };
        (await tx.doc(MetaDoc, parent.id)).lead = { conversationId: middle.id, host: "local" };
      }, context);
      isolated.faux.setResponses([WORKER_SPAWN, fauxAssistantMessage([fauxText("understood")])]);
      await (await isolated.harness.conversation(parent.id, context))!.submit(
        { type: "input", content: "Go." },
        context
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await toolTextOf(isolated.harness, parent.id as unknown as number)).includes("Refused")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await toolTextOf(isolated.harness, parent.id as unknown as number)).toContain("depth 3");
      expect(await conversationsOf(isolated.storage)).toHaveLength(3);
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }
  }, 30_000);
});
