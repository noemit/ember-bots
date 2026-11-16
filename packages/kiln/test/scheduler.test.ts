import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MetaDoc } from "../src/meta";
import { AutoAcceptDoc } from "../src/approvals";
import {
  createScheduledTask,
  deleteScheduledTask,
  isDue,
  listScheduledTasks,
  mostRecentOccurrence,
  parseScheduledTaskInput,
  parseScheduledTaskPatch,
  parseSchedule as parseScheduleOf,
  runScheduledTaskNow,
  SchedulerDoc,
  tick,
  updateScheduledTask,
} from "../src/scheduler";

const context = BACKGROUND_CONTEXT;
let home: string;
let harness: Harness;
let faux: ReturnType<typeof fauxProvider>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-scheduler-"));
  faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxText("scheduled answer")]),
    fauxAssistantMessage([fauxText("scheduled answer")]),
    fauxAssistantMessage([fauxText("scheduled answer")]),
    fauxAssistantMessage([fauxText("scheduled answer")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  harness.resume();
});

afterAll(async () => {
  await harness.close(context);
  // Windows holds the sqlite handle for a moment after close; a leftover temp dir is not a failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe("scheduler time", () => {
  test("daily resolves the most recent wall-clock occurrence in a timezone", () => {
    const noon = Date.UTC(2026, 9, 8, 12, 0, 0);
    expect(mostRecentOccurrence({ kind: "daily", time: "09:00", timezone: "UTC" }, noon)).toBe(
      Date.UTC(2026, 9, 8, 9, 0, 0)
    );
    expect(mostRecentOccurrence({ kind: "daily", time: "18:00", timezone: "UTC" }, noon)).toBe(
      Date.UTC(2026, 9, 7, 18, 0, 0)
    );
    // 09:00 in New York (UTC-4 in October) is 13:00Z; at 14:00Z that occurrence has passed.
    const afternoon = Date.UTC(2026, 9, 8, 14, 0, 0);
    expect(mostRecentOccurrence({ kind: "daily", time: "09:00", timezone: "America/New_York" }, afternoon)).toBe(
      Date.UTC(2026, 9, 8, 13, 0, 0)
    );
  });

  test("weekly picks the most recent listed weekday", () => {
    // 2026-10-08 is a Thursday; the previous Monday is 2026-10-05.
    const noon = Date.UTC(2026, 9, 8, 12, 0, 0);
    expect(mostRecentOccurrence({ kind: "weekly", time: "08:00", weekdays: [1], timezone: "UTC" }, noon)).toBe(
      Date.UTC(2026, 9, 5, 8, 0, 0)
    );
  });

  test("a future once is not due; isDue respects lastRunAt and enabled", () => {
    const now = Date.now();
    expect(mostRecentOccurrence({ kind: "once", at: now + 60_000 }, now)).toBeUndefined();
    const task = {
      id: "t",
      name: "n",
      prompt: "p",
      schedule: { kind: "once" as const, at: now - 1 },
      enabled: true,
      createdAt: now,
    };
    expect(isDue(task, now)).toBe(true);
    expect(isDue({ ...task, lastRunAt: now - 1 }, now)).toBe(false);
    expect(isDue({ ...task, enabled: false }, now)).toBe(false);
  });
});

describe("scheduler wire parsing", () => {
  test("parseScheduledTaskInput validates required fields and schedule", () => {
    expect(parseScheduledTaskInput({})).toBeNull();
    expect(parseScheduledTaskInput({ name: "x", prompt: "y", schedule: { kind: "daily", time: "nope" } })).toBeNull();
    const ok = parseScheduledTaskInput({
      name: "Nightly brief",
      prompt: "Write it",
      schedule: { kind: "daily", time: "09:00" },
    });
    expect(ok?.enabled).toBe(true);
    expect(ok?.schedule).toEqual({ kind: "daily", time: "09:00" });
  });

  test("parseScheduledTaskPatch applies only present fields", () => {
    expect(parseScheduledTaskPatch({ enabled: false })).toEqual({ enabled: false });
    expect(parseScheduledTaskPatch({ schedule: { kind: "weekly", time: "10:30", weekdays: [1, 3] } }).schedule).toEqual({
      kind: "weekly",
      time: "10:30",
      weekdays: [1, 3],
    });
  });
});

describe("scheduler loop", () => {
  test("tick submits a due task once, records the outcome, and does not repeat", async () => {
    const created = await createScheduledTask(harness, {
      name: "Due now",
      prompt: "scheduled hello",
      schedule: { kind: "once", at: Date.now() - 1000 },
      enabled: true,
      cwd: home,
    });
    expect(await tick(harness, context)).toBe(1);
    const stored = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id);
    expect(stored?.lastStatus).toBe("ok");
    expect(stored?.lastRunAt).toBe(created.schedule.kind === "once" ? created.schedule.at : undefined);
    expect(stored?.lastSessionId).toBeGreaterThan(0);
    // The requestId makes the scheduled instant idempotent, so it is no longer due.
    expect(await tick(harness, context)).toBe(0);
    await harness.waitForIdle(context);
  });

  test("run now submits immediately and updates the task", async () => {
    const created = await createScheduledTask(harness, {
      name: "Manual",
      prompt: "run now",
      schedule: { kind: "daily", time: "23:59" },
      enabled: true,
      cwd: home,
    });
    const outcome = await runScheduledTaskNow(harness, created.id, context);
    expect(outcome?.status).toBe("ok");
    const stored = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id);
    expect(stored?.lastStatus).toBe("ok");
    await harness.waitForIdle(context);
  });

  test("a second run now is refused while the first is still working", async () => {
    const created = await createScheduledTask(harness, {
      name: "Stack",
      prompt: "slow",
      schedule: { kind: "daily", time: "23:59" },
      enabled: true,
      cwd: home,
    });
    const first = await runScheduledTaskNow(harness, created.id, context);
    expect(first?.status).toBe("ok");
    const ranAt = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id)?.lastRunAt;
    // The first run is still in flight, so a manual run must not queue a second copy of it.
    const second = await runScheduledTaskNow(harness, created.id, context);
    expect(second?.refused).toBe(true);
    expect(second?.status).toBe("error");
    // A refusal is not a run: it must not consume an occurrence or overwrite the recorded status.
    const stored = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id);
    expect(stored?.lastRunAt).toBe(ranAt);
    expect(stored?.lastStatus).toBe("ok");
    await harness.waitForIdle(context);
  });

  test("update and delete round-trip", async () => {
    const created = await createScheduledTask(harness, {
      name: "Toggle",
      prompt: "p",
      schedule: { kind: "daily", time: "08:00" },
      enabled: true,
    });
    expect((await updateScheduledTask(harness, created.id, { enabled: false }))?.enabled).toBe(false);
    expect(await deleteScheduledTask(harness, created.id, context)).toBe(true);
    expect((await listScheduledTasks(harness, context)).tasks.some((task) => task.id === created.id)).toBe(false);
  });
});

describe("scheduler conversations and zones", () => {
  test("manual and automatic runs start fresh top-level sessions, preserve configuration and history", async () => {
    const seen: string[] = [];
    const freshAnswer = (label: string) => (input: { messages: readonly unknown[] }) => {
      seen.push(JSON.stringify(input.messages));
      return fauxAssistantMessage(label);
    };
    faux.setResponses([freshAnswer("FIRST_PRIVATE_ANSWER"), freshAnswer("SECOND_PRIVATE_ANSWER"), freshAnswer("THIRD_PRIVATE_ANSWER")]);
    const model = faux.getModel();
    const created = await createScheduledTask(harness, {
      name: "Fresh brief", prompt: "Self-contained scheduled prompt",
      schedule: { kind: "once", at: Date.now() - 10_000 }, enabled: true,
      cwd: home, model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off",
    });
    const stored = async () => (await listScheduledTasks(harness, context)).tasks.find((entry) => entry.id === created.id)!;
    expect(await tick(harness, context)).toBe(1);
    const first = (await stored()).lastSessionId!;
    await harness.waitForIdle(context);
    const firstConversation = (await harness.conversation(first as ConversationId, context))!;
    const firstEntries = (await firstConversation.entries({}, 100, undefined, context)).items;
    await updateScheduledTask(harness, created.id, { schedule: { kind: "once", at: Date.now() - 1000 } });
    expect(await tick(harness, context)).toBe(1);
    const second = (await stored()).lastSessionId!;
    await harness.waitForIdle(context);
    // Manual runs use precisely the same fresh-session path, including paused plans.
    await updateScheduledTask(harness, created.id, { enabled: false });
    const third = await runScheduledTaskNow(harness, created.id, context);
    await harness.waitForIdle(context);
    expect(new Set([first, second, third?.sessionId]).size).toBe(3);
    expect((await stored()).runSessionIds).toEqual([first, second, third!.sessionId!]);
    expect((await stored()).conversationId).toBeUndefined();
    expect((await stored()).pendingRun).toBeUndefined();
    expect(seen).toHaveLength(3);
    for (const input of seen) {
      expect(input).toContain("Self-contained scheduled prompt");
      expect(input).not.toContain("FIRST_PRIVATE_ANSWER");
      expect(input).not.toContain("SECOND_PRIVATE_ANSWER");
    }
    for (const id of [first, second, third!.sessionId!]) {
      const conversation = (await harness.conversation(id as ConversationId, context))!;
      const agent = await conversation.agent(context);
      expect(agent.cwd).toBe(home);
      expect(agent.model).toEqual({ provider: model.provider, modelId: model.id });
      expect(agent.thinkingLevel).toBe("off");
      expect((await harness.snapshot(AutoAcceptDoc, id as ConversationId, context))?.enabled).toBe(true);
      expect((await harness.snapshot(MetaDoc, id as ConversationId, context))?.title).toBe("Fresh brief");
      await harness.commit(async (tx) => {
        const record = await tx.conversation(id as ConversationId);
        expect(record?.parent).toBeUndefined();
        expect(record?.owner).toBeUndefined();
      }, context);
    }
    expect((await firstConversation.entries({}, 100, undefined, context)).items).toEqual(firstEntries);
    await deleteScheduledTask(harness, created.id, context);
  }, 20_000);

  test("legacy targets remain readable history, including archived sessions, and are not reused", async () => {
    const legacy = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await legacy.submit({ type: "write", entry: { kind: "legacy-note", model: [{ role: "user", content: "DO_NOT_INHERIT", timestamp: 1 }] } }, context);
    await harness.commit(async (tx) => { (await tx.doc(MetaDoc, legacy.id)).archived = 123; }, context);
    const before = (await legacy.entries({}, 100, undefined, context)).items;
    const created = await createScheduledTask(harness, {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      name: "Legacy plan", prompt: "New independent input", enabled: false,
      schedule: { kind: "daily", time: "09:00", timezone: "Europe/Berlin" },
      conversationId: legacy.id, lastSessionId: legacy.id, cwd: home,
    });
    let input = "";
    faux.setResponses([(context) => { input = JSON.stringify(context.messages); return fauxAssistantMessage("fresh"); }]);
    const outcome = await runScheduledTaskNow(harness, created.id, context);
    await harness.waitForIdle(context);
    expect(outcome?.status).toBe("ok");
    expect(outcome?.sessionId).not.toBe(legacy.id);
    expect(input).toContain("New independent input");
    expect(input).not.toContain("DO_NOT_INHERIT");
    const stored = (await listScheduledTasks(harness, context)).tasks.find((entry) => entry.id === created.id)!;
    expect(stored.runSessionIds).toEqual([legacy.id, outcome!.sessionId!]);
    expect(stored.schedule).toEqual(created.schedule);
    expect((await legacy.entries({}, 100, undefined, context)).items).toEqual(before);
    expect((await harness.snapshot(MetaDoc, legacy.id, context))?.archived).toBe(123);
    await deleteScheduledTask(harness, created.id, context);
  });

  test("racing manual and automatic calls admit one run; busy automatic runs defer without queueing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => { await gate; return fauxAssistantMessage("done"); }, fauxAssistantMessage("caught up")]);
    const created = await createScheduledTask(harness, {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      name: "Racing", prompt: "One at a time", enabled: true, cwd: home,
      schedule: { kind: "once", at: Date.now() - 10_000 },
    });
    try {
      const results = await Promise.all([tick(harness, context), runScheduledTaskNow(harness, created.id, context), runScheduledTaskNow(harness, created.id, context)]);
      expect(Number(results[0]) + results.slice(1).filter((result) => typeof result === "object" && result?.status === "ok").length).toBe(1);
      const first = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id)!;
      expect(first.runSessionIds).toHaveLength(1);
      // Make another occurrence due while the first is running.
      await updateScheduledTask(harness, created.id, { schedule: { kind: "once", at: Date.now() - 1 }, lastRunAt: 0 });
      expect(await tick(harness, context)).toBe(0);
      const refused = await runScheduledTaskNow(harness, created.id, context);
      expect(refused?.refused).toBe(true);
      const busy = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id)!;
      expect(busy.lastRunAt).toBe(0);
      expect(busy.runSessionIds).toHaveLength(1);
      expect((await harness.snapshot(InboxDoc, first.lastSessionId as ConversationId, context))?.items).toHaveLength(0);
      release();
      await harness.waitForIdle(context);
      expect(await tick(harness, context)).toBe(1);
      await harness.waitForIdle(context);
      const after = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id)!;
      expect(after.runSessionIds).toHaveLength(2);
      expect(after.lastSessionId).not.toBe(first.lastSessionId);
      expect(await tick(harness, context)).toBe(0);
    } finally { release(); await harness.waitForIdle(context); await deleteScheduledTask(harness, created.id, context); }
  });

  test("a crash after creation recovers the reserved run once, even with racing recovery ticks", async () => {
    faux.setResponses([fauxAssistantMessage("recovered")]);
    const created = await createScheduledTask(harness, {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      name: "Recovery", prompt: "Recover one run", enabled: false, cwd: home,
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    });
    // Fault at the exact durable boundary: creation committed, but the caller never got its ID.
    const creator = { ...harness, createConversation: async (...args: Parameters<Harness["createConversation"]>) => {
      await harness.createConversation(...args);
      throw new Error("simulated crash after creation");
    } } as Harness;
    const interrupted = await runScheduledTaskNow(harness, created.id, context, creator);
    expect(interrupted?.status).toBe("error");
    // Reopen the actual SQLite store: recovery is durable, not an in-memory reservation.
    await harness.close(context);
    const models = createModels();
    models.setProvider(faux.provider);
    harness = await Harness.open(await openNodeSqliteStorage(join(home, "hearth.sqlite")), {
      models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? home }),
    }, context);
    harness.resume();
    const pending = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id)!;
    expect(pending.pendingRun).toBeDefined();
    const id = pending.pendingRun!.sessionId;
    const manual = await runScheduledTaskNow(harness, created.id, context);
    expect(manual?.refused).toBe(true);
    await Promise.all([tick(harness, context), tick(harness, context)]);
    await harness.waitForIdle(context);
    const stored = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id)!;
    expect(stored.runSessionIds).toEqual([id]);
    expect(stored.lastSessionId).toBe(id);
    expect(stored.pendingRun).toBeUndefined();
    const conversation = (await harness.conversation(id as ConversationId, context))!;
    expect((await conversation.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    expect(await tick(harness, context)).toBe(0);
    await deleteScheduledTask(harness, created.id, context);
  });

  test("stopping a run leaves the next manual run fresh rather than reviving the stopped transcript", async () => {
    const created = await createScheduledTask(harness, {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      name: "Stop", prompt: "Run independently", enabled: false, cwd: home,
      schedule: { kind: "daily", time: "09:00" },
    });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const first = await runScheduledTaskNow(harness, created.id, context);
    const previous = (await harness.conversation(first!.sessionId as ConversationId, context))!;
    await previous.abort(context);
    await previous.waitForIdle(context);
    const before = (await previous.entries({}, 100, undefined, context)).items;
    const second = await runScheduledTaskNow(harness, created.id, context);
    expect(second?.sessionId).not.toBe(first?.sessionId);
    await harness.waitForIdle(context);
    expect((await previous.entries({}, 100, undefined, context)).items).toEqual(before);
    await deleteScheduledTask(harness, created.id, context);
  });

  test("an unknown timezone is refused when it is typed, not when it is due", () => {
    // `Intl.DateTimeFormat` throws on this zone, so storing it would make every later tick throw.
    expect(parseScheduleOf({ kind: "daily", time: "09:00", timezone: "Mars/Olympus_Mons" })).toBeNull();
    expect(parseScheduleOf({ kind: "weekly", time: "09:00", weekdays: [1], timezone: "Nowhere/Land" })).toBeNull();
    // A real zone is kept, and none means the host's own.
    expect(parseScheduleOf({ kind: "daily", time: "09:00", timezone: "Europe/Berlin" })).toEqual({
      kind: "daily",
      time: "09:00",
      timezone: "Europe/Berlin",
    });
    expect(parseScheduledTaskInput({
      name: "n",
      prompt: "p",
      schedule: { kind: "daily", time: "09:00", timezone: "Bad/Zone" },
    })).toBeNull();
  });

  test("a stored task with a bad zone does not stop the tick for the others", async () => {
    // Storage can predate the validation above; the loop must still run everything else.
    const broken = await createScheduledTask(harness, {
      name: "Broken zone",
      prompt: "never runs",
      schedule: { kind: "once", at: Date.now() - 1000 },
      enabled: true,
    });
    // Rewrite it into the shape an older host could have stored.
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SchedulerDoc);
      const task = doc.tasks.find((entry) => entry.id === broken.id);
      if (task) task.schedule = { kind: "daily", time: "09:00", timezone: "Bad/Zone" } as never;
    }, context);
    const good = await createScheduledTask(harness, {
      name: "Still runs",
      prompt: "run despite the broken one",
      schedule: { kind: "once", at: Date.now() - 1000 },
      enabled: true,
      cwd: home,
    });
    faux.setResponses([fauxAssistantMessage([fauxText("the good one ran")])]);
    expect(await tick(harness, context)).toBeGreaterThanOrEqual(1);
    const stored = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === good.id);
    expect(stored?.lastStatus).toBe("ok");
    // …and the broken task is untouched rather than consuming its occurrence.
    const untouched = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === broken.id);
    expect(untouched?.lastRunAt).toBeUndefined();
    await deleteScheduledTask(harness, broken.id, context);
    await harness.waitForIdle(context);
  }, 20_000);
});
