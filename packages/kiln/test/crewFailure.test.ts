/**
 * Two failure-shaped gaps, pinned so they cannot come back.
 *
 * 1. **A failed worker is a message, not a wait state.** `session wait` polls the crew doc, which
 *    only the background supervisor tick updates. If a worker died, and the tick had not yet marked
 *    it (or never would, because it looked like it was still starting), the leader sat on the clock
 *    instead of being told. And when the tick *had* marked it, the leader was answered "Crew
 *    settled." — a success-shaped sentence over a crew in which nothing succeeded.
 *
 * 2. **A stop must not swallow the queue.** `Conversation.abort()` withdraws every queued input,
 *    so pressing stop with a message in the queue used to destroy the message silently: no entry,
 *    no trace, `{ ok: true }`. That is also why the outcome felt unpredictable — an explicit stop
 *    is the one action where the user is watching to see what happens next.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import {
  InboxDoc,
  LiveDoc,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type Harness as HarnessType,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";
import { withAbortRace } from "../src/interrupt";
import { Sessions, SessionsDoc, SessionTool, type CrewEntry } from "../src/sessions";
import { MetaDoc } from "../src/meta";
import { tick, wakeKeyOf } from "../src/crew";
import { createAgentsTool } from "../src/agents";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" } as const;

const Slow = defineExtension({
  name: "slow",
  tools: [
    withAbortRace(
      defineTool({
        name: "slowecho",
        description: "Echo after a pause",
        parameters: obj({ text: str() }),
        replay: "safe",
        execute: async ({ text }) => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return { output: [{ type: "text" as const, text: `echo: ${text}` }] };
        },
      })
    ),
  ],
});

const toolCall = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const openHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-crewfail-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Sessions);
  registry.install(Slow);
  const storage = await openNodeSqliteStorage(join(directory, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  harness.resume();
  return { harness, storage, faux, directory };
};

/** A conversation with `meta`, configured to run. */
const agent = async (harness: HarnessType, cwd: string, meta: Record<string, unknown> = {}) => {
  const record = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await harness.commit(async (tx) => {
    await configure(tx, record.id, { model, cwd });
    Object.assign(await tx.doc(MetaDoc, record.id), meta);
  }, context);
  return record;
};

/** The `session` tool as the leader's task would see it. */
const toolApi = (harness: HarnessType, conversationId: number, directory: string) => ({
  conversationId: conversationId as never,
  snapshot: (...args: unknown[]) => (harness.snapshot as any)(...args),
  conversation: (...args: unknown[]) => (harness.conversation as any)(...args),
  commit: (...args: unknown[]) => (harness.commit as any)(...args),
  agent: async () => ({ cwd: directory, model }),
  taskId: "test-task",
});

const session = async (
  harness: HarnessType,
  conversationId: number,
  directory: string,
  args: Record<string, unknown>
): Promise<string> => {
  const result = await (SessionTool as any).execute(args, toolApi(harness, conversationId, directory), context);
  return result.output[0].text as string;
};

const crewEntry = (workerId: number, state: CrewEntry["state"], overrides: Partial<CrewEntry> = {}): CrewEntry => ({
  kind: "worker",
  conversationId: workerId as never,
  title: "Researcher #1",
  role: "Researcher",
  roleIndex: 1,
  spawnedAt: Date.now() - 60_000,
  state,
  generation: 1,
  briefRequestId: "brief",
  ...overrides,
});

/** The `[crew] Crew report` wakes this leader received, oldest first. */
const crewWakes = async (harness: HarnessType, leaderId: number): Promise<string[]> => {
  const entries = await (await harness.conversation(leaderId as never, context))!.entries({}, 50, undefined, context);
  return entries.items
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) => {
      const content = (entry.model as any)?.[0]?.content;
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    })
    .filter((text) => text.startsWith("[crew] Crew report"))
    .reverse();
};

/** The text of an assistant turn the worker produced. */
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

/** Wait (bounded) until `done()` holds; returns whether it did. */
const until = async (done: () => Promise<boolean>, attempts = 400, pause = 25): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await done()) return true;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  return false;
};

/** Seed a leader's crew doc with one worker in `state`, already past its spawn window. */
const seedCrew = async (
  harness: HarnessType,
  leaderId: number,
  workerId: number,
  state: CrewEntry["state"],
  overrides: Partial<CrewEntry> = {}
) => {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SessionsDoc, leaderId as never);
    doc.generation = 1;
    doc.deadlineAt = Date.now() + 60_000;
    doc.items["researcher"] = crewEntry(workerId, state, overrides);
  }, context);
};

describe("a failed worker ends the wait instead of outlasting it", () => {
  test("a worker that failed to start is settled by the supervisor, not left 'starting'", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      // A worker with an empty transcript: the brief never produced a turn.
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await seedCrew(isolated.harness, leader.id as unknown as number, worker.id as unknown as number, "starting", {
        spawnedAt: Date.now() - 1_000, // still inside the start grace
      });

      // The grace window must not keep a dead worker "starting" until it expires: with nothing in
      // the transcript and no live submission it can never run, so the tick settles it now.
      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);
      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(state?.items["researcher"]?.state).toBe("failed");
      expect(state?.items["researcher"]?.report?.text).toContain("never started");
      // And the failure is a message: the leader was woken with a failure-shaped digest, once.
      expect(state?.woke).toBe(true);
      const entries = await (await isolated.harness.conversation(leader.id, context))!.entries({}, 20, undefined, context);
      const wake = entries.items.find((entry) => entry.kind === "pi.user");
      expect(JSON.stringify(wake?.model?.[0])).toContain("FINISHED WITH FAILURES");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("wait returns at once, with the failure labelled, when the crew has already failed", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await seedCrew(isolated.harness, leader.id as unknown as number, worker.id as unknown as number, "failed", {
        report: {
          status: "failed",
          text: "This worker failed: upstream 500",
          at: Date.now(),
          requestId: "r1",
        },
      });

      const started = Date.now();
      const waited = await session(isolated.harness, leader.id as unknown as number, isolated.directory, {
        action: "wait",
      });
      // It must not sit on the ten-minute deadline for a worker that has already failed.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(waited).toContain("failures");
      expect(waited).toContain("upstream 500");
      // The success-shaped sentence over a failed crew was the bug.
      expect(waited).not.toContain("Crew settled.");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("a stopped worker also ends the wait, and is reported as stopped", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await seedCrew(isolated.harness, leader.id as unknown as number, worker.id as unknown as number, "stopped");

      const started = Date.now();
      const waited = await session(isolated.harness, leader.id as unknown as number, isolated.directory, {
        action: "wait",
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(waited).toContain("STOPPED");
      expect(waited).not.toContain("Crew settled.");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("a still-running worker keeps the wait going, and the deadline names it", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await seedCrew(isolated.harness, leader.id as unknown as number, worker.id as unknown as number, "running");

      // A genuinely active crew is still a wait — but the wait is bounded and cancels cleanly.
      const controller = new AbortController();
      const pending = (SessionTool as any).execute(
        { action: "wait" },
        toolApi(isolated.harness, leader.id as unknown as number, isolated.directory),
        { ...context, abortSignal: controller.signal }
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      const result = await pending;
      expect(result.output[0].text).toBe("Stopped while waiting for the crew.");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("results labels a failure instead of leaving it as '(no report yet)'", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await seedCrew(isolated.harness, leader.id as unknown as number, worker.id as unknown as number, "failed");
      const results = await session(isolated.harness, leader.id as unknown as number, isolated.directory, {
        action: "results",
      });
      expect(results).toContain("FAILED");
      expect(results).not.toContain("no report yet");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("a reported crew still reads 'Crew settled.'", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await seedCrew(isolated.harness, leader.id as unknown as number, worker.id as unknown as number, "reported", {
        report: { status: "ok", text: "all done", at: Date.now(), requestId: "r1" },
      });
      const waited = await session(isolated.harness, leader.id as unknown as number, isolated.directory, {
        action: "wait",
      });
      expect(waited).toContain("Crew settled.");
      expect(waited).toContain("all done");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});

describe("a stop keeps the queue instead of swallowing it", () => {
  let server: HearthServer;
  let harness: HarnessType;
  let faux: ReturnType<typeof fauxProvider>;
  let directory: string;
  const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hearth-park-"));
    faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText("ready")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(Sessions);
    registry.install(Slow);
    const storage = await openNodeSqliteStorage(join(directory, "hearth.sqlite"));
    harness = await Harness.open(
      storage,
      { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
      context
    );
    server = startHearthServer({
      config: hearthConfig({ home: directory, port: 0, workspace: directory }),
      token: TOKEN,
      storage,
      harness,
      models,
      defaultAgent: { model },
      store: new FileCredentialStore(join(directory, "auth.json")),
      version: "9.9.9",
      build: "test",
      restart: () => {},
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    await harness.close(context);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
  });

  const api = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const body = async (response: Response): Promise<any> => response.json();

  const waitBusy = async (id: number) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === id)?.busy) return;
      if (Date.now() > deadline) throw new Error("conversation never became busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const userTexts = async (id: number): Promise<string[]> => {
    const entries = await (await harness.conversation(id as never, context))!.entries({}, 50, undefined, context);
    return entries.items
      .filter((entry) => entry.kind === "pi.user")
      .map((entry) => String((entry.model as any)?.[0]?.content ?? ""));
  };

  test("abort keeps queued messages queued, in order, and says how many", async () => {
    faux.setResponses([toolCall("slowecho", { text: "busy" }), fauxAssistantMessage([fauxText("after")])]);
    const conversation = await body(
      await api("/conversations", { method: "POST", body: JSON.stringify({ model }) })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    await waitBusy(conversation.id);
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "first queued", whenBusy: "followUp" }),
    });
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "second queued", whenBusy: "followUp" }),
    });

    const aborted = await body(await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" }));
    expect(aborted.ok).toBe(true);
    // The response is legible: a client can tell the user their message was kept.
    expect(aborted.parked).toBe(2);
    expect(aborted.parkedText).toEqual(["first queued", "second queued"]);

    // Wait for the parking commit (it runs after the abort settles, off the response path).
    const deadline = Date.now() + 5_000;
    let inbox: any[] = [];
    for (;;) {
      const snapshot = await harness.snapshot(InboxDoc, conversation.id, context);
      inbox = (snapshot?.items ?? []) as any[];
      if (inbox.length === 2) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Preserved, in the order they were queued.
    expect(inbox.map((item) => item.content)).toEqual(["first queued", "second queued"]);
    // And still visible to a client as the conversation's queue.
    const queue = await body(await api("/queue"));
    expect(
      queue.sessions.find((session: any) => Number(session.sessionId) === conversation.id)?.items.map((item: any) => item.text)
    ).toEqual(["first queued", "second queued"]);

    // The crucial half: a stop is a stop. Nothing was auto-sent, so the conversation stayed idle.
    expect(await userTexts(conversation.id)).toEqual(["go slow"]);
    const list = await body(await api("/conversations"));
    expect(list.conversations.find((entry: any) => entry.id === conversation.id)?.busy).toBe(false);
  }, 30_000);

  test("the kept messages drain normally on the next submission, oldest first", async () => {
    faux.setResponses([
      toolCall("slowecho", { text: "busy" }),
      fauxAssistantMessage([fauxText("answering")]),
      fauxAssistantMessage([fauxText("answering")]),
      fauxAssistantMessage([fauxText("answering")]),
    ]);
    const conversation = await body(
      await api("/conversations", { method: "POST", body: JSON.stringify({ model }) })
    );
    // Queued behind a running turn, then stopped: the queue a stop has to keep.
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    await waitBusy(conversation.id);
    for (const text of ["parked one", "parked two"]) {
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: text, whenBusy: "followUp" }),
      });
    }
    const aborted = await body(await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" }));
    expect(aborted.parked).toBe(2);
    // Let the parking commit land; nothing has been sent, so this is the whole transcript.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await userTexts(conversation.id)).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await userTexts(conversation.id)).toEqual(["go slow"]);

    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "new message" }),
    });
    const deadline = Date.now() + 10_000;
    let texts: string[] = [];
    for (;;) {
      texts = await userTexts(conversation.id);
      if (texts.length >= 4 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Every message runs exactly once, the queued ones ahead of the new arrival. That ordering is
    // pi-durable's own rule for a queue, and a parked message is an ordinary queued message, so a
    // stop needs no special case here.
    expect(texts.sort()).toEqual(["go slow", "new message", "parked one", "parked two"]);
  }, 30_000);

  test("an abort with an empty queue reports nothing parked", async () => {
    const conversation = await body(
      await api("/conversations", { method: "POST", body: JSON.stringify({ model }) })
    );
    const aborted = await body(await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" }));
    // The old response shape, so a client that ignores `parked` is unchanged.
    expect(aborted).toEqual({ ok: true });
  }, 30_000);
});

/**
 * Three gaps in the supervisor's wake, pinned so they cannot come back. All three are the same
 * mistake: the crew doc recorded *that* a wake happened, never *what* it delivered.
 *
 * 1. **The deadline was unreachable.** The tick gave up on a conversation it had not changed, and a
 *    hung worker changes nothing — so its leader waited for a deadline that was never evaluated.
 * 2. **A report that landed after the wake was written down and never delivered.** `woke` is one
 *    boolean per generation, so the second (or late) worker's report reached the doc only.
 * 3. **A new task for a settled worker was never reported.** Handing a `reported` worker more work
 *    left it `reported`: the tick watches `starting | running`, so the new answer was invisible and
 *    `session wait` called the crew settled while the worker was still working.
 */
describe("the crew deadline fires even when the tick changed nothing", () => {
  test("a worker that hangs inside its start grace still wakes the leader at the deadline", async () => {
    const isolated = await openHarness();
    try {
      isolated.faux.setResponses([answer("noted"), answer("noted"), answer("noted")]);
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      // The worker has its brief and nothing else: no run, no answer, and still inside the start
      // grace, so an honest tick changes nothing about it. That is what a hung worker looks like,
      // and it is the only case the deadline exists for.
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(worker.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
        });
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.generation = 1;
        doc.deadlineAt = Date.now() - 1_000;
        doc.items["researcher"] = crewEntry(worker.id as unknown as number, "starting", {
          spawnedAt: Date.now(),
        });
      }, context);

      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);

      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      // Nothing changed about the worker itself…
      expect(state?.items["researcher"]?.state).toBe("starting");
      // …and the leader was woken all the same, with the deadline's honest "no report yet".
      expect(state?.woke).toBe(true);
      const wakes = await crewWakes(isolated.harness, leader.id as unknown as number);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("researcher (starting)");
      expect(wakes[0]).toContain("(no report yet)");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});

describe("a report that lands after the generation's wake still reaches the leader", () => {
  test("the late answer produces a second wake, and a rerun of the tick produces none", async () => {
    const isolated = await openHarness();
    try {
      isolated.faux.setResponses([answer("noted"), answer("noted"), answer("noted")]);
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const quick = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      const late = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(late.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "and you?", timestamp: Date.now() }],
        });
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.generation = 1;
        doc.deadlineAt = Date.now() - 1_000;
        doc.items["quick"] = crewEntry(quick.id as unknown as number, "reported", {
          report: { status: "ok", text: "the first answer", at: Date.now(), requestId: "r-quick" },
        });
        doc.items["late"] = crewEntry(late.id as unknown as number, "starting", { spawnedAt: Date.now() });
      }, context);

      // The deadline wake goes out with the late worker still owing its answer.
      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);
      let wakes = await crewWakes(isolated.harness, leader.id as unknown as number);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("late (starting): (no report yet)");

      // The answer lands afterwards. Before the fix this report was written to the crew doc and
      // never delivered: the generation had already been woken.
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(late.id, { kind: "pi.assistant", model: [answer("the late answer")] });
      }, context);
      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);

      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(state?.items["late"]?.state).toBe("reported");
      expect(state?.items["late"]?.report?.text).toBe("the late answer");
      wakes = await crewWakes(isolated.harness, leader.id as unknown as number);
      expect(wakes).toHaveLength(2);
      expect(wakes[1]).toContain("late (reported): the late answer");

      // Idempotent: the same reports never wake the leader twice, so a rerun (or a restart) is silent.
      expect(await tick(isolated.harness, isolated.storage, context)).toBe(0);
      expect(await crewWakes(isolated.harness, leader.id as unknown as number)).toHaveLength(2);
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});

describe("a new task for a settled worker is reported like any other", () => {
  test("`session message` puts the worker back to work and the new answer is reported and woken", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      // The worker answered once; that answer was reported and its leader woken to read it.
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(worker.id, { kind: "pi.assistant", model: [answer("the first answer")] });
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.generation = 1;
        doc.deadlineAt = Date.now() + 60_000;
        doc.items["researcher"] = crewEntry(worker.id as unknown as number, "reported", {
          report: { status: "ok", text: "the first answer", at: Date.now(), requestId: "hearth.crew.report:old" },
        });
      }, context);
      const delivered = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      await isolated.harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.woke = true;
        doc.wokeAt = Date.now();
        // The wake this crew already got delivered the first answer.
        doc.wokeKey = wakeKeyOf(delivered!);
      }, context);
      expect(await tick(isolated.harness, isolated.storage, context)).toBe(0);

      // Hand it a new task. The turn runs a slow tool, so the supervisor looks at it mid-work.
      isolated.faux.setResponses([
        toolCall("slowecho", { text: "busy" }),
        answer("the second answer"),
        answer("noted"),
        answer("noted"),
      ]);
      const sent = await session(isolated.harness, leader.id as unknown as number, isolated.directory, {
        action: "message",
        name: "researcher",
        message: "do it once more",
      });
      expect(sent).toContain("Sent to");

      const rearmed = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      // Working again — so `wait` can no longer call this crew settled — and the answer to the
      // *previous* task is out of the report slot.
      expect(["starting", "running"]).toContain(rearmed?.items["researcher"]?.state ?? "");
      expect(rearmed?.items["researcher"]?.report).toBeUndefined();
      expect(typeof rearmed?.items["researcher"]?.taskAt).toBe("number");
      // The old answer sits at or behind the watermark, so it cannot be read as the new one.
      expect(rearmed?.items["researcher"]?.answerFrom).toBeGreaterThan(0);

      // Mid-turn, with the slow tool holding it, the tick must report nothing.
      await until(async () => (await isolated.harness.snapshot(LiveDoc, worker.id, context))?.run !== undefined);
      await tick(isolated.harness, isolated.storage, context);
      const midway = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(midway?.items["researcher"]?.report).toBeUndefined();
      expect(midway?.items["researcher"]?.state).not.toBe("reported");

      // Once the new answer has landed and the turn is over, the report and the wake carry it.
      await until(async () => {
        const live = await isolated.harness.snapshot(LiveDoc, worker.id, context);
        if (live?.run !== undefined) return false;
        const entries = await (await isolated.harness.conversation(worker.id, context))!.entries(
          {},
          20,
          undefined,
          context
        );
        return entries.items.some(
          (entry) =>
            entry.kind === "pi.assistant" && JSON.stringify(entry.model?.[0] ?? "").includes("the second answer")
        );
      });
      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);

      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(state?.items["researcher"]?.state).toBe("reported");
      expect(state?.items["researcher"]?.report?.text).toBe("the second answer");
      // The leader is told about the *new* answer, once.
      const wakes = await crewWakes(isolated.harness, leader.id as unknown as number);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("the second answer");
      expect(await tick(isolated.harness, isolated.storage, context)).toBe(0);
      expect(await crewWakes(isolated.harness, leader.id as unknown as number)).toHaveLength(1);
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("`agents send` to a settled crew member re-activates it too", async () => {
    const isolated = await openHarness();
    try {
      const leader = await agent(isolated.harness, isolated.directory, { delegates: true });
      const worker = await agent(isolated.harness, isolated.directory, { kind: "worker" });
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(worker.id, { kind: "pi.assistant", model: [answer("the first answer")] });
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.generation = 1;
        doc.deadlineAt = Date.now() + 60_000;
        doc.items["researcher"] = crewEntry(worker.id as unknown as number, "reported", {
          report: { status: "ok", text: "the first answer", at: Date.now(), requestId: "hearth.crew.report:old" },
        });
      }, context);
      const api = {
        taskId: 7,
        conversationId: leader.id,
        snapshot: (token: any, first: any, second?: any) =>
          second === undefined
            ? isolated.harness.snapshot(token, first)
            : isolated.harness.snapshot(token, first, second),
        conversation: (id: any, ctx: any) => isolated.harness.conversation(id, ctx),
        commit: (change: any, ctx: any) => isolated.harness.commit(change, ctx),
      } as any;
      const reply = await createAgentsTool(isolated.directory).execute(
        { action: "send", name: "Researcher #1", message: "one more thing" },
        api,
        context
      );
      expect(JSON.stringify(reply.output)).toContain("Sent to Researcher #1");
      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(["starting", "running"]).toContain(state?.items["researcher"]?.state ?? "");
      expect(state?.items["researcher"]?.report).toBeUndefined();
      expect(typeof state?.items["researcher"]?.answerFrom).toBe("number");
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
