import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MetaDoc } from "../src/meta";
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
  test("a task reuses the conversation it created, and names it", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("scheduled answer")])]);
    const created = await createScheduledTask(harness, {
      name: "Reused conversation",
      prompt: "hello once",
      schedule: { kind: "daily", time: "23:59" },
      enabled: true,
      cwd: home,
    });
    const first = await runScheduledTaskNow(harness, created.id, context);
    expect(first?.status).toBe("ok");
    const afterFirst = (await listScheduledTasks(harness, context)).tasks.find((task) => task.id === created.id);
    // The conversation the run created is recorded as the task's own, not only as "the last session".
    expect(afterFirst?.conversationId).toBe(first?.sessionId);
    expect(afterFirst?.lastSessionId).toBe(first?.sessionId);
    const meta = await harness.snapshot(MetaDoc, afterFirst?.conversationId as ConversationId, context);
    expect(meta?.title).toBe("Reused conversation");
    await harness.waitForIdle(context);

    // A second run lands in the same conversation rather than starting another one.
    faux.setResponses([fauxAssistantMessage([fauxText("scheduled answer again")])]);
    const second = await runScheduledTaskNow(harness, created.id, context);
    expect(second?.sessionId).toBe(first?.sessionId);
    await harness.waitForIdle(context);
  }, 20_000);

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
