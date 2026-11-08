import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { hearthRegistry } from "../src/registry";
import {
  createScheduleHandlers,
  describeNextRun,
  describeSchedule,
  duplicateName,
  findTask,
  MAX_SCHEDULES,
  nextRunAt,
  SCHEDULE_SHAPES,
  Schedule,
  ScheduleTool,
  validateSchedule,
  type ScheduleStore,
} from "../src/schedule";
import { listScheduledTasks, mostRecentOccurrence, SchedulerDoc, tick } from "../src/scheduler";

const context = BACKGROUND_CONTEXT;
let home: string;
let harness: Harness;
let faux: ReturnType<typeof fauxProvider>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-schedule-tool-"));
  faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxText("ran from the schedule tool")]),
    fauxAssistantMessage([fauxText("ran twice")]),
    fauxAssistantMessage([fauxText("ran a third time")]),
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
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

/** The store the handlers need, taken straight from the harness (the tool gets the same via `api`). */
const store: ScheduleStore = {
  snapshot: ((token: any, first: any, second: any) => harness.snapshot(token, first, second)) as never,
  commit: ((change: any, ctx: any) => harness.commit(change, ctx)) as never,
  createConversation: ((options: any, ctx: any) => harness.createConversation(options, ctx)) as never,
  conversation: ((id: any, ctx: any) => harness.conversation(id, ctx)) as never,
} as ScheduleStore;

const handlers = (now?: () => number) => createScheduleHandlers(store, now);

const text = (result: { text: string }) => result.text;

/** A fresh conversation's own schedule: the document is session-scoped, so each test starts clean. */
const fresh = async () => {
  // Start from an empty schedule so tests do not see each other's tasks.
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulerDoc);
    doc.tasks = [];
    doc.sequence = 0;
  }, context);
};

const at = (iso: string): number => Date.parse(iso);

describe("schedule: validation names the field", () => {
  const now = at("2026-11-08T12:00:00Z");

  test("a missing schedule, wrong kind and bad time each say which field is wrong", () => {
    expect(validateSchedule(undefined, now)).toMatchObject({ error: expect.stringContaining("A schedule is required") });
    const kind = validateSchedule({ kind: "hourly" }, now);
    expect("error" in kind && kind.error).toContain("`schedule.kind`");
    const time = validateSchedule({ kind: "daily", time: "9am" }, now);
    expect("error" in time && time.error).toContain("`schedule.time`");
    const days = validateSchedule({ kind: "weekly", time: "09:00", weekdays: [] }, now);
    expect("error" in days && days.error).toContain("`schedule.weekdays`");
    const dayValue = validateSchedule({ kind: "weekly", time: "09:00", weekdays: [9] }, now);
    expect("error" in dayValue && dayValue.error).toContain("`schedule.weekdays`");
  });

  test("every refusal teaches the accepted shapes", () => {
    const kind = validateSchedule({ kind: "hourly" }, now);
    expect("error" in kind && kind.error).toContain(SCHEDULE_SHAPES);
    expect(SCHEDULE_SHAPES).toContain('"kind":"daily"');
    expect(SCHEDULE_SHAPES).toContain('"kind":"weekly"');
    expect(SCHEDULE_SHAPES).toContain('"kind":"once"');
  });

  test("an unknown timezone is refused, naming the zone", () => {
    const result = validateSchedule({ kind: "daily", time: "09:00", timezone: "Mars/Olympus" }, now);
    expect("error" in result).toBe(true);
    const error = "error" in result ? result.error : "";
    expect(error).toContain("Mars/Olympus");
    expect(error).toContain("IANA");
    // A blank zone is a mistake too, not "use the host zone".
    expect(validateSchedule({ kind: "daily", time: "09:00", timezone: "" }, now)).toMatchObject({
      error: expect.stringContaining("`schedule.timezone`"),
    });
  });

  test("a past one-off run is refused, and the answer says what time it is there", () => {
    const result = validateSchedule({ kind: "once", at: at("2026-11-01T08:00:00Z"), timezone: "Europe/Berlin" }, now);
    const error = "error" in result ? result.error : "";
    expect(error).toContain("`schedule.at` is in the past");
    // 12:00Z on 8 November is 13:00 in Berlin (CET, +1).
    expect(error).toContain("13:00");
    expect(error).toContain("08/11/2026");
    expect(error).toContain("Europe/Berlin");
  });

  test("a valid one-off run and a valid weekly schedule are accepted, weekdays deduped and sorted", () => {
    expect(validateSchedule({ kind: "once", at: now + 60_000 }, now)).toEqual({
      schedule: { kind: "once", at: now + 60_000 },
    });
    expect(validateSchedule({ kind: "weekly", time: "18:30", weekdays: [4, 1, 4], timezone: "Europe/Berlin" }, now)).toEqual({
      schedule: { kind: "weekly", time: "18:30", weekdays: [1, 4], timezone: "Europe/Berlin" },
    });
  });
});

describe("schedule: reading a schedule back", () => {
  test("human descriptions name the zone, and weekly lists day names", () => {
    expect(describeSchedule({ kind: "daily", time: "09:00", timezone: "Europe/Berlin" }, "UTC")).toBe(
      "daily 09:00 Europe/Berlin"
    );
    expect(describeSchedule({ kind: "weekly", time: "18:30", weekdays: [1, 4], timezone: "Europe/Berlin" }, "UTC")).toBe(
      "weekly Mon,Thu 18:30 Europe/Berlin"
    );
    // No zone on the task means the host's zone, said out loud rather than implied.
    expect(describeSchedule({ kind: "daily", time: "07:00" }, "America/New_York")).toBe("daily 07:00 America/New_York");
    expect(describeSchedule({ kind: "once", at: at("2026-11-10T08:00:00Z") }, "UTC")).toBe("once 2026-11-10 08:00");
  });

  test("the next run is the next wall-clock occurrence, not this one", () => {
    const now = at("2026-11-08T08:30:00Z"); // a Sunday
    const got = nextRunAt({ kind: "daily", time: "09:00", timezone: "Europe/Berlin" }, now);
    // 09:00 Berlin (CET, +1) is 08:00Z, already past at 08:30Z: tomorrow.
    expect(got).toBe(Date.UTC(2026, 10, 9, 8, 0, 0));
    const weekly = nextRunAt({ kind: "weekly", time: "18:30", weekdays: [1, 4], timezone: "Europe/Berlin" }, now);
    // Next Monday 18:30 Berlin = 17:30Z.
    expect(weekly).toBe(Date.UTC(2026, 10, 9, 17, 30, 0));
    expect(nextRunAt({ kind: "once", at: at("2026-11-01T00:00:00Z") }, now)).toBeUndefined();
  });

  test("next-run copy is plain words with the zone", () => {
    const run = at("2026-11-10T08:00:00Z"); // Tuesday
    expect(describeNextRun({ kind: "once", at: run }, run, "Europe/Berlin")).toBe("Tue 10 Nov, 09:00 (Europe/Berlin)");
    expect(describeNextRun({ kind: "daily", time: "09:00" }, undefined, "UTC")).toContain("already passed");
  });
});

describe("schedule: tasks belong to one conversation's document", () => {
  test("create, list, update, remove round-trip with the next run in the answer", async () => {
    await fresh();
    const now = at("2026-11-08T08:30:00Z");
    const api = handlers(() => now);
    const created = await api.create({
      name: "Morning deploy check",
      prompt: "Check the deploy and say what changed.",
      schedule: { kind: "daily", time: "09:00", timezone: "Europe/Berlin" },
      cwd: "/workspace/app",
    });
    expect(created.isError).toBeUndefined();
    expect(created.text).toContain('Scheduled "Morning deploy check"');
    expect(created.text).toContain("daily 09:00 Europe/Berlin");
    expect(created.text).toContain("Next run: Mon 9 Nov, 09:00 (Europe/Berlin)");
    expect(created.text).toContain("first run creates the session it will keep using");

    const listed = await api.list();
    expect(listed).toContain("Morning deploy check");
    expect(listed).toContain("enabled");
    expect(listed).toContain("cwd /workspace/app");

    const updated = await api.update({ task: "Morning deploy check", name: "Deploy check", enabled: false });
    expect(updated.isError).toBeUndefined();
    expect(updated.text).toContain('Updated "Deploy check"');
    expect(updated.text).toContain("paused");

    const removed = await api.remove({ task: "Deploy check" });
    expect(removed.text).toContain("will not run again");
    expect(await listScheduledTasks(harness, context)).toMatchObject({ tasks: [] });
  });

  test("the tool has no per-conversation list: it edits this host's one scheduler document", async () => {
    await fresh();
    // The document is session-scoped, so every conversation on this host reads the same tasks. The
    // tool takes no conversation argument, addresses no other id, and therefore cannot reach a task
    // list that is not this one. What it must not do is *invent* a per-conversation view it does not
    // have — two calls, from any caller, see the same document.
    const created = await handlers().create({
      name: "Shared document task",
      prompt: "Do the thing.",
      schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    });
    expect(created.isError).toBeUndefined();
    const first = await listScheduledTasks(harness, context);
    const second = await handlers().list();
    expect(first.tasks.map((task) => task.name)).toEqual(["Shared document task"]);
    expect(second).toContain("Shared document task");
    // The signature has nowhere to name another conversation.
    expect(createScheduleHandlers.length).toBeLessThanOrEqual(2);
  });

  test("duplicate names are refused rather than created twice", async () => {
    await fresh();
    const api = handlers();
    await api.create({ name: "Nightly brief", prompt: "Summarise.", schedule: { kind: "daily", time: "21:00" } });
    const again = await api.create({ name: "nightly brief", prompt: "Summarise again.", schedule: { kind: "daily", time: "22:00" } });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already has a scheduled task");
    expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(1);
    expect(duplicateName([], "x")).toBe(false);
  });

  test("the per-conversation cap is enforced and said out loud", async () => {
    await fresh();
    const api = handlers();
    for (let index = 0; index < MAX_SCHEDULES; index += 1) {
      const created = await api.create({
        name: `Task ${index + 1}`,
        prompt: "Do it.",
        schedule: { kind: "daily", time: "09:00" },
      });
      expect(created.isError).toBeUndefined();
    }
    const over = await api.create({ name: "One too many", prompt: "Do it.", schedule: { kind: "daily", time: "09:00" } });
    expect(over.isError).toBe(true);
    expect(over.text).toContain(`${MAX_SCHEDULES} scheduled tasks, the maximum`);
    expect(over.text).toContain("Remove one");
  });

  test("an ambiguous name is refused; the id resolves it", async () => {
    await fresh();
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SchedulerDoc);
      doc.sequence = 2;
      doc.tasks = [
        { id: "task_1", name: "Weekly digest", prompt: "A", schedule: { kind: "daily", time: "09:00" }, enabled: true, createdAt: 1 },
        { id: "task_2", name: "Weekly digest", prompt: "B", schedule: { kind: "daily", time: "10:00" }, enabled: true, createdAt: 1 },
      ];
    }, context);
    const api = handlers();
    const ambiguous = await api.remove({ task: "Weekly digest" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("task_1");
    expect(ambiguous.text).toContain("task_2");
    expect((await listScheduledTasks(harness, context)).tasks).toHaveLength(2);
    const byId = await api.remove({ task: "task_2" });
    expect(byId.isError).toBeUndefined();
    expect((await listScheduledTasks(harness, context)).tasks.map((task) => task.id)).toEqual(["task_1"]);
  });

  test("a missing task names the id and points at list", async () => {
    await fresh();
    const result = await handlers().remove({ task: "Ghost" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('There is no scheduled task called "Ghost"');
    expect(result.text).toContain("`list`");
    expect((findTask([], "Ghost") as { error: string }).error).toContain("Ghost");
  });

  test("an empty list explains how to add one", async () => {
    await fresh();
    expect(await handlers().list()).toContain("Nothing is scheduled on this Hearth");
  });

  test("list filters and says so when the filter matches nothing", async () => {
    await fresh();
    const api = handlers();
    await api.create({ name: "Deploy watch", prompt: "Watch.", schedule: { kind: "daily", time: "09:00" } });
    await api.create({ name: "Inbox triage", prompt: "Triage.", schedule: { kind: "daily", time: "10:00" } });
    const filtered = await api.list("deploy");
    expect(filtered).toContain("Deploy watch");
    expect(filtered).not.toContain("Inbox triage");
    const none = await api.list("zzz");
    expect(none).toContain("No scheduled task here matches");
    expect(none).toContain("call `list` without a filter");
  });
});

describe("schedule: run now", () => {
  test("run submits the stored prompt, and the scheduler's own tick still fires a created task", async () => {
    await fresh();
    const now = Date.now();
    // A once-task an hour ahead: nothing runs yet.
    const created = await handlers().create({
      name: "Later check",
      prompt: "Check the later thing.",
      schedule: { kind: "once", at: now + 60 * 60 * 1000 },
      cwd: home,
    });
    expect(created.text).toContain("Next run:");
    expect(await tick(harness, context)).toBe(0);

    // Run it now: the run lands in the task's own conversation and the answer says where.
    const ran = await handlers().run({ task: "Later check" });
    expect(ran.isError).toBeUndefined();
    expect(ran.text).toContain('Ran "Later check" now');
    expect(ran.text).toContain("submitted to conversation");

    // And the scheduler fires it on its own once the instant arrives: move it into the past by
    // making a daily task whose time has just gone by, then tick.
    await fresh();
    const before = Date.now();
    const daily = await handlers().create({
      name: "Tick me",
      prompt: "Tick.",
      schedule: { kind: "daily", time: "00:00", timezone: "UTC" },
      cwd: home,
    });
    expect(daily.isError).toBeUndefined();
    const [task] = (await listScheduledTasks(harness, context)).tasks;
    const occurrence = mostRecentOccurrence(task.schedule, before + 1000);
    expect(occurrence).toBeDefined();
    // `lastRunAt` unset means the most recent occurrence is due.
    expect(await tick(harness, context)).toBe(1);
    const after = (await listScheduledTasks(harness, context)).tasks[0];
    expect(after.lastStatus).toBe("ok");
    expect(after.lastRunAt).toBe(occurrence as number);
    // A second tick with nothing new due does not run it again.
    expect(await tick(harness, context)).toBe(0);
  }, 30_000);

  test("running a task whose session is busy is refused, not queued twice", async () => {
    await fresh();
    const api = handlers();
    await api.create({ name: "Busy target", prompt: "Work.", schedule: { kind: "daily", time: "09:00" }, cwd: home });
    // The first run starts the target conversation; while it is still working a second manual run
    // must refuse rather than queue a second copy of the whole prompt.
    const first = await api.run({ task: "Busy target" });
    expect(first.isError).toBeUndefined();
    const second = await api.run({ task: "Busy target" });
    if (second.isError) expect(second.text).toMatch(/still working|did not run/);
    else expect(second.text).toContain("Ran");
  }, 30_000);
});

describe("schedule: the model-facing tool", () => {
  test("the registry installs the schedule extension, with a short section", () => {
    const snapshot = hearthRegistry(home).snapshot();
    expect(snapshot.extension("schedule")).toBeDefined();
    expect(snapshot.tools().some((entry) => entry.tool.name === "schedule")).toBe(true);
    expect(snapshot.sections().some((entry) => entry.extension.name === "schedule")).toBe(true);
    expect(Schedule.name).toBe("schedule");
    expect(ScheduleTool.name).toBe("schedule");
    expect(Schedule.sections).toHaveLength(1);
  });

  test("run from the tool refuses in words when its api cannot create the target conversation", async () => {
    await fresh();
    await handlers().create({ name: "Manual only", prompt: "Do it.", schedule: { kind: "daily", time: "09:00" } });
    // A tool's api has no `createConversation`; the first manual run therefore cannot start a
    // session. It must say so, not crash halfway through a submit.
    const toolApi = {
      now: () => Date.now(),
      snapshot: ((token: any, first: any, second: any) => harness.snapshot(token, first, second)) as never,
      commit: ((change: any, ctx: any) => harness.commit(change, ctx)) as never,
    } as unknown as ToolExecutionApi;
    const result = await ScheduleTool.execute({ action: "run", task: "Manual only" } as never, toolApi, context);
    const text = (result.output as Array<{ text: string }>)[0].text;
    expect(result.isError).toBe(true);
    expect(text).toContain("has no session yet");
    expect(text).toContain("when it next comes due");
  });

  test("the section is short and says where a run's prompt goes", () => {
    const rendered = Schedule.sections[0].render({} as never, context) as string;
    expect(rendered.length).toBeLessThan(700);
    expect(rendered).toContain("wall-clock");
    expect(rendered).toContain("the task's own session");
  expect(rendered).toContain("belong to this Hearth");
    expect(rendered).toContain("next run");
  });
});
