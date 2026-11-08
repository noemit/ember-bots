import type { Context } from "@earendil-works/chord";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineTool, section, type DocumentReader, type Harness, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { TaskRunner } from "./scheduler";
import {
  createScheduledTask,
  deleteScheduledTask,
  updateScheduledTask,
  listScheduledTasks,
  mostRecentOccurrence,
  runScheduledTaskNow,
  wallClock,
  wallClockToEpoch,
  type ScheduleSpec,
  type ScheduledTask,
} from "./scheduler";

export { type ScheduleSpec };

/**
 * `schedule` — let a conversation keep a task on a wall-clock schedule.
 *
 * Hearth has had a scheduler and an HTTP surface (`/scheduled-tasks`) since the Scheduled view, but
 * nothing a model could call, so "check the deploy every morning at nine" was a thing only a human
 * could set up. This is that missing tool: a dedicated `schedule` tool rather than a `session`
 * action, because it is not about spawning anything — it edits one small document and reports the
 * next run in the same words the person would say it in.
 *
 * The rules it lives by:
 *
 * - **One Hearth's list, honestly described.** `SchedulerDoc` is a per-Hearth singleton, not a
 *   per-conversation list: every chat on this host sees the same tasks, and so does the Scheduled
 *   view. The tool says "this Hearth", never "this conversation", because a model that believed the
 *   narrower thing would promise a privacy the storage does not provide.
 * - **Validate with the wire's own parsers.** `parseSchedule`/`parseScheduledTaskInput` are what
 *   `POST /scheduled-tasks` already uses; duplicating the rules here would let the two drift. What
 *   this file adds is the part a model needs: *which field* is wrong, in words, and what the
 *   accepted shapes are.
 * - **Never store a schedule that cannot be evaluated.** An unknown timezone would make every later
 *   `isDue()` throw, which the tick loop skips forever — a task that silently never runs. It is
 *   refused at creation, where the person who typed it can still be told.
 * - **A bounded list.** Eight tasks per Hearth is enough for anyone's real cadence and keeps the
 *   tool's answer short enough to read: the cap is enforced on create and said out loud.
 * - **Runs get their own session.** A task stores a prompt, not a transcript slot: the first run
 *   creates the conversation it will keep using, so somebody's working chat is never interrupted by
 *   a scheduled prompt. The answer says which session ran.
 */
export type ScheduleToolName = "list" | "create" | "update" | "remove" | "run";

/** The most tasks one Hearth may own. Each one is a prompt that runs without anyone watching. */
export const MAX_SCHEDULES = 8;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** How a schedule reads to a person: "daily 09:00 Europe/Berlin", "weekly Mon,Thu 18:30", "once …". */
export const describeSchedule = (schedule: ScheduleSpec, fallbackZone: string): string => {
  if (schedule.kind === "once") {
    return `once ${new Date(schedule.at).toISOString().replace("T", " ").slice(0, 16)}`;
  }
  const zone = schedule.timezone ?? fallbackZone;
  if (schedule.kind === "daily") return `daily ${schedule.time} ${zone}`;
  const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day]).join(",");
  return `weekly ${days} ${schedule.time} ${zone}`;
};

/**
 * The next instant a schedule will run, or `undefined` for a `once` already past.
 *
 * Deliberately independent of `lastRunAt`: this answers "when would it fire next if nothing else
 * changes", which is the sentence a person wants back, not a scheduler-internal judgement.
 */
export const nextRunAt = (schedule: ScheduleSpec, now: number): number | undefined => {
  if (schedule.kind === "once") return schedule.at > now ? schedule.at : undefined;
  const zone = schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [hour, minute] = schedule.time.split(":").map(Number);
  if (schedule.kind === "daily") {
    const today = wallClock(now, zone);
    const todayAt = wallClockToEpoch(today.year, today.month, today.day, hour, minute, zone);
    return todayAt > now ? todayAt : todayAt + 24 * 60 * 60 * 1000;
  }
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const clock = wallClock(now + ahead * 24 * 60 * 60 * 1000, zone);
    if (!schedule.weekdays.includes(clock.weekday)) continue;
    const at = wallClockToEpoch(clock.year, clock.month, clock.day, hour, minute, zone);
    if (at > now) return at;
  }
  return undefined;
};

/** A next run in the terms the task is written in: "Tue 10 Nov, 09:00 (Europe/Berlin)". */
export const describeNextRun = (schedule: ScheduleSpec, at: number | undefined, fallbackZone: string): string => {
  if (at === undefined) return "no future run (this one has already passed)";
  const zone = schedule.kind === "once" ? fallbackZone : schedule.timezone ?? fallbackZone;
  const clock = wallClock(at, zone);
  const month = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const weekday = WEEKDAY_NAMES[clock.weekday];
  const hhmm = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
  return `${weekday} ${month}, ${hhmm} (${zone})`;
};

/** True when the name is already used by another task in this document (case-insensitive). */
export const duplicateName = (tasks: readonly ScheduledTask[], name: string, exceptId?: string): boolean =>
  tasks.some((task) => task.id !== exceptId && task.name.trim().toLowerCase() === name.trim().toLowerCase());

/** The task a call names: by id, or by a name that must be unique in this document. */
export type TaskLookup =
  | { task: ScheduledTask }
  | { error: string }
  | { ambiguous: string[] };

export const findTask = (tasks: readonly ScheduledTask[], ref: string | undefined): TaskLookup => {
  const wanted = (ref ?? "").trim();
  if (!wanted) return { error: "Name or id the task to change (see `list`)." };
  const byId = tasks.find((task) => task.id === wanted);
  if (byId) return { task: byId };
  const matches = tasks.filter((task) => task.name.trim().toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return { task: matches[0] };
  if (matches.length > 1) return { ambiguous: matches.map((task) => `${task.id} (${task.name})`) };
  return { error: `There is no scheduled task called "${wanted.slice(0, 80)}". Use \`list\` to see the ids.` };
};

/**
 * The shapes a schedule accepts, spelled out for a refusal. This is the sentence a model has to be
 * able to act on: the wire's parser says "null", and that teaches nothing.
 */
export const SCHEDULE_SHAPES =
  'schedule: {"kind":"daily","time":"09:00","timezone":"Europe/Berlin"} | ' +
  '{"kind":"weekly","time":"18:30","weekdays":[1,4],"timezone":"Europe/Berlin"} | ' +
  '{"kind":"once","at":<epoch ms>}. Times are 24-hour HH:MM; weekdays are 0=Sun…6=Sat; ' +
  "timezone is an IANA zone name (omit it to use this host's zone).";

type TimezoneProblem = "unknown" | "invalid";

const timezoneProblem = (timezone: unknown): TimezoneProblem | undefined => {
  if (timezone === undefined) return undefined;
  if (typeof timezone !== "string" || timezone.trim() === "") return "invalid";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return undefined;
  } catch {
    return "unknown";
  }
};

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Check a create/update schedule and return either the validated spec or a refusal that names the
 * field. `now` is passed in so a test can pin "the past" without waiting.
 */
export const validateSchedule = (
  raw: unknown,
  now: number
): { schedule: ScheduleSpec } | { error: string } => {
  if (raw === undefined || raw === null) return { error: `A schedule is required. ${SCHEDULE_SHAPES}` };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: `\`schedule\` must be an object. ${SCHEDULE_SHAPES}` };
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "once" && kind !== "daily" && kind !== "weekly") {
    return {
      error: `\`schedule.kind\` must be "daily", "weekly" or "once" (got ${JSON.stringify(kind ?? null)}). ${SCHEDULE_SHAPES}`,
    };
  }
  const zoneProblem = timezoneProblem(record.timezone);
  if (zoneProblem === "invalid") {
    return { error: `\`schedule.timezone\` must be an IANA zone name such as "Europe/Berlin"; leave it out to use this host's zone.` };
  }
  if (zoneProblem === "unknown") {
    return {
      error: `\`schedule.timezone\` "${String(record.timezone).slice(0, 60)}" is not a timezone this host knows. Use an IANA name such as "Europe/Berlin".`,
    };
  }
  if (kind === "once") {
    if (typeof record.at !== "number" || !Number.isFinite(record.at)) {
      return { error: `\`schedule.at\` must be an epoch-millisecond number (got ${JSON.stringify(record.at ?? null)}).` };
    }
    if (record.at <= now) {
      const zone = typeof record.timezone === "string" ? record.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
      const clock = wallClock(now, zone);
      const hhmm = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
      return {
        error: `\`schedule.at\` is in the past. It is ${hhmm} on ${String(clock.day).padStart(2, "0")}/${String(clock.month).padStart(2, "0")}/${clock.year} in ${zone} right now, and a one-off run must be later than that.`,
      };
    }
    return { schedule: { kind: "once", at: record.at } };
  }
  if (typeof record.time !== "string" || !HH_MM.test(record.time)) {
    return { error: `\`schedule.time\` must be 24-hour "HH:MM" such as "09:00" (got ${JSON.stringify(record.time ?? null)}).` };
  }
  if (kind === "daily") {
    return {
      schedule: {
        kind: "daily",
        time: record.time,
        ...(typeof record.timezone === "string" ? { timezone: record.timezone } : {}),
      },
    };
  }
  const weekdaysRaw = record.weekdays;
  if (!Array.isArray(weekdaysRaw) || weekdaysRaw.length === 0) {
    return { error: `\`schedule.weekdays\` must be a non-empty array of 0=Sun…6=Sat (got ${JSON.stringify(weekdaysRaw ?? null)}).` };
  }
  const bad = weekdaysRaw.find((day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6);
  if (bad !== undefined) {
    return { error: `\`schedule.weekdays\` takes integers 0=Sun…6=Sat; ${JSON.stringify(bad)} is not one.` };
  }
  return {
    schedule: {
      kind: "weekly",
      time: record.time,
      weekdays: [...new Set(weekdaysRaw as number[])].sort((a, b) => a - b),
      ...(typeof record.timezone === "string" ? { timezone: record.timezone } : {}),
    },
  };
};

/** A host default model ref, as the tool accepts it, or a refusal naming the shape. */
const parseModelRef = (raw: unknown): { model?: { provider: string; modelId: string } } | { error: string } => {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: '`model` must be an object like {"provider":"anthropic","modelId":"claude-sonnet-4-5"}.' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.provider !== "string" || !record.provider || typeof record.modelId !== "string" || !record.modelId) {
    return { error: '`model` needs both "provider" and "modelId" strings.' };
  }
  return { model: { provider: record.provider, modelId: record.modelId } };
};

const describeTask = (task: ScheduledTask, now: number, fallbackZone: string): string => {
  const schedule = describeSchedule(task.schedule, fallbackZone);
  const next = nextRunAt(task.schedule, now);
  const target = [task.cwd ? `cwd ${task.cwd}` : undefined, task.model ? `${task.model.provider}/${task.model.modelId}` : undefined]
    .filter(Boolean)
    .join(", ");
  const status = task.enabled ? "enabled" : "paused";
  return [
    `${task.id} · ${task.name}`,
    `  ${status} · ${schedule} · next ${describeNextRun(task.schedule, next, fallbackZone)}${target ? ` · ${target}` : ""}`,
  ].join("\n");
};

export type ScheduleHandlers = {
  list: (query?: string) => Promise<string>;
  create: (args: {
    name?: string;
    prompt?: string;
    schedule?: unknown;
    cwd?: string;
    model?: unknown;
    enabled?: boolean;
  }) => Promise<{ text: string; isError?: boolean }>;
  update: (args: {
    name?: string;
    task?: string;
    prompt?: string;
    schedule?: unknown;
    enabled?: boolean;
    cwd?: string;
    model?: unknown;
  }) => Promise<{ text: string; isError?: boolean }>;
  remove: (args: { task?: string }) => Promise<{ text: string; isError?: boolean }>;
  run: (args: { task?: string }) => Promise<{ text: string; isError?: boolean }>;
};

/**
 * The document surface every scheduler helper needs: reads plus one commit. Both a `Harness` (in
 * tests) and a tool's `api` (in the model's path) satisfy it, which is how the same code is exercised
 * without a model in the loop.
 */
export type ScheduleStore = {
  snapshot: DocumentReader["snapshot"];
  commit: Harness["commit"];
};

/**
 * Every action over one store. `now` is injected so a test can say "the past" without waiting; no
 * conversation id is involved because the scheduler document is a per-Hearth singleton — reading it
 * through this store reads every task this Hearth knows about.
 */
export const createScheduleHandlers = (store: ScheduleStore, now: () => number = Date.now): ScheduleHandlers => {
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const state = () => listScheduledTasks(store as never);

  /**
   * `run` needs one capability the document reader does not have: creating the target conversation
   * on first use. A tool's `api` creates *tasks*, not conversations, so when pidu-rable offers no
   * factory the run is refused in words rather than crashing halfway through. The full harness
   * (tests, and any future host path) supplies `createConversation` directly.
   */
  const canCreate = typeof (store as { createConversation?: unknown }).createConversation === "function";

  return {
    list: async (query) => {
      const current = now();
      const { tasks } = await state();
      if (tasks.length === 0) {
        return `Nothing is scheduled on this Hearth. Use \`create\` to add one (up to ${MAX_SCHEDULES}).`;
      }
      const needle = query?.trim().toLowerCase();
      const matching = needle
        ? tasks.filter((task) => task.name.toLowerCase().includes(needle) || task.id.toLowerCase() === needle)
        : tasks;
      if (matching.length === 0) {
        return `No scheduled task here matches "${(query ?? "").trim().slice(0, 60)}". ${tasks.length} ${tasks.length === 1 ? "task is" : "tasks are"} scheduled; call \`list\` without a filter to see them.`;
      }
      const shown = matching.slice(0, 10);
      const rows = shown.map((task) => describeTask(task, current, zone())).join("\n");
      const more = matching.length > shown.length ? `\n(${matching.length - shown.length} more — narrow the filter.)` : "";
      return `${shown.length} of ${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"} on this Hearth:\n${rows}${more}\nTimes are wall-clock in the zone shown; a run submits the task's prompt to its own session, not to the chat that created it.`;
    },

    create: async (args) => {
      const current = now();
      const name = args.name?.trim();
      if (!name) return { text: "`name` is required: a short title such as \"Morning deploy check\".", isError: true };
      const prompt = args.prompt?.trim();
      if (!prompt) return { text: "`prompt` is required: what the scheduled run should do when it fires.", isError: true };
      const checked = validateSchedule(args.schedule, current);
      if ("error" in checked) return { text: checked.error, isError: true };
      const model = parseModelRef(args.model);
      if ("error" in model) return { text: model.error, isError: true };

      const { tasks } = await state();
      if (tasks.length >= MAX_SCHEDULES) {
        return {
          text: `This Hearth already has ${tasks.length} scheduled tasks, the maximum. Remove one with \`remove\` before adding another.`,
          isError: true,
        };
      }
      if (duplicateName(tasks, name)) {
        return {
          text: `This Hearth already has a scheduled task called "${name.slice(0, 80)}". Choose another name, or use \`update\` to change that one.`,
          isError: true,
        };
      }
      // Built through the wire's own validator so a task made here is exactly a task made by the
      // Scheduled view: same clamping, same defaults, same stored shape.
      const created = await createScheduledTask(store as never, {
        name: name.slice(0, 120),
        prompt: prompt.slice(0, 20_000),
        schedule: checked.schedule,
        enabled: args.enabled !== false,
        ...(args.cwd ? { cwd: args.cwd.slice(0, 2048) } : {}),
        ...(model.model ? { model: model.model } : {}),
      });
      const next = nextRunAt(created.schedule, current);
      return {
        text:
          `Scheduled "${created.name}" (${created.id}): ${describeSchedule(created.schedule, zone())}. ` +
          `Next run: ${describeNextRun(created.schedule, next, zone())}. ` +
          "Its first run creates the session it will keep using, so this chat is not interrupted.",
      };
    },

    update: async (args) => {
      const current = now();
      const { tasks } = await state();
      const lookup = findTask(tasks, args.task);
      if ("error" in lookup) return { text: lookup.error, isError: true };
      if ("ambiguous" in lookup) {
        return {
          text: `More than one scheduled task is called "${(args.task ?? "").trim().slice(0, 60)}": ${lookup.ambiguous.join(", ")}. Pass the id instead.`,
          isError: true,
        };
      }
      const task = lookup.task;
      const name = args.name?.trim();
      if (name && duplicateName(tasks, name, task.id)) {
        return { text: `Another scheduled task here is already called "${name.slice(0, 80)}".`, isError: true };
      }
      const patch: Partial<ScheduledTask> = {};
      if (name) patch.name = name.slice(0, 120);
      if (args.prompt !== undefined) {
        if (!args.prompt.trim()) return { text: "`prompt` cannot be empty; pass the text the run should use.", isError: true };
        patch.prompt = args.prompt.slice(0, 20_000);
      }
      if (args.schedule !== undefined) {
        const checked = validateSchedule(args.schedule, current);
        if ("error" in checked) return { text: checked.error, isError: true };
        patch.schedule = checked.schedule;
      }
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.cwd !== undefined) patch.cwd = args.cwd.slice(0, 2048);
      const model = parseModelRef(args.model);
      if ("error" in model) return { text: model.error, isError: true };
      if (model.model) patch.model = model.model;
      if (Object.keys(patch).length === 0) {
        return { text: "Nothing to change: pass prompt, schedule, enabled, cwd, model, or name.", isError: true };
      }
      const updated = await invokeUpdate(store, task.id, patch);
      if (!updated) return { text: `Scheduled task ${task.id} disappeared before it could be updated.`, isError: true };
      const next = nextRunAt(updated.schedule, current);
      return {
        text:
          `Updated "${updated.name}" (${updated.id}): ${describeSchedule(updated.schedule, zone())}, ${updated.enabled ? "enabled" : "paused"}. ` +
          `Next run: ${describeNextRun(updated.schedule, next, zone())}.`,
      };
    },

    remove: async (args) => {
      const { tasks } = await state();
      const lookup = findTask(tasks, args.task);
      if ("error" in lookup) return { text: lookup.error, isError: true };
      if ("ambiguous" in lookup) {
        return {
          text: `More than one scheduled task is called "${(args.task ?? "").trim().slice(0, 60)}": ${lookup.ambiguous.join(", ")}. Pass the id instead.`,
          isError: true,
        };
      }
      const removed = await deleteScheduledTask(store as never, lookup.task.id);
      return removed
        ? { text: `Removed "${lookup.task.name}" (${lookup.task.id}). It will not run again.` }
        : { text: `Scheduled task ${lookup.task.id} was already gone.` };
    },

    run: async (args) => {
      const { tasks } = await state();
      const lookup = findTask(tasks, args.task);
      if ("error" in lookup) return { text: lookup.error, isError: true };
      if ("ambiguous" in lookup) {
        return {
          text: `More than one scheduled task is called "${(args.task ?? "").trim().slice(0, 60)}": ${lookup.ambiguous.join(", ")}. Pass the id instead.`,
          isError: true,
        };
      }
      if (!canCreate) {
        // A tool's api creates tasks, not conversations. Refusing in words beats a crash part-way
        // through a submit, and the schedule itself is untouched.
        return {
          text: `${lookup.task.name} has no session yet, and this tool cannot create one; it will run when it next comes due.`,
          isError: true,
        };
      }
      const outcome = await runScheduledTaskNow(store as never, lookup.task.id, undefined, store as unknown as TaskRunner);
      if (!outcome) return { text: `Scheduled task ${lookup.task.id} disappeared before it could run.`, isError: true };
      if (outcome.refused) {
        return {
          text: `"${lookup.task.name}" did not run: its session is still working. Wait for it to finish, then run it again.`,
          isError: true,
        };
      }
      if (outcome.status === "error") {
        return { text: `"${lookup.task.name}" was due but could not be submitted: ${(outcome.error ?? "unknown error").slice(0, 300)}`, isError: true };
      }
      return { text: `Ran "${lookup.task.name}" now; its prompt was submitted to conversation ${outcome.sessionId}.` };
    },
  };
};

const invokeUpdate = async (store: ScheduleStore, id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | undefined> =>
  updateScheduledTask(store as never, id, patch);

const toolText = (text: string, isError?: boolean): { output: Array<{ type: "text"; text: string }>; isError?: boolean } => ({
  output: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * The model-facing tool.
 *
 * `replay: "unsafe"` (the default) is honest: a rerun after a crash must not silently add a second
 * task. The handlers are still written to be safe where they can be — a duplicate name is refused
 * rather than created twice, updates and removals are idempotent, and `run` is the one action whose
 * repetition is visible as a second run.
 */
export const ScheduleTool = defineTool({
  name: "schedule",
  description:
    "Create and manage tasks that run on a wall-clock schedule: list them, create one, " +
    "change its prompt or schedule, pause it, remove it, or run it now. Use this when a person asks for " +
    "something to happen regularly or at a particular time; do not promise a schedule you have not created.",
  parameters: obj({
    action: oneOf(["list", "create", "update", "remove", "run"] as const, {
      description: "list: this Hearth's scheduled tasks (shared by every chat here). create/update/remove/run act on one task, named by `task` (id or unique name).",
    }),
    task: opt(str({ description: "update/remove/run: the task's id, or its name when that name is unique here." })),
    name: opt(str({ description: "create: a short title. update: a new title. Must be unique on this Hearth." })),
    prompt: opt(str({ description: "create/update: what the run should do. It is submitted to the task's own session, where nobody is watching — write it so it still makes sense later." })),
    schedule: opt(
      obj({
        kind: oneOf(["daily", "weekly", "once"] as const, { description: "daily: every day at `time`. weekly: on `weekdays` at `time`. once: at the epoch-ms instant `at`." }),
        time: opt(str({ description: "daily/weekly: 24-hour \"HH:MM\", wall-clock in `timezone`." })),
        weekdays: opt(arr(num(), { description: "weekly: day numbers, 0=Sun … 6=Sat." })),
        at: opt(num({ description: "once: epoch milliseconds, later than now." })),
        timezone: opt(str({ description: "IANA zone such as \"Europe/Berlin\". Omit to use this host's zone." })),
      }, { description: "The wall-clock schedule. Validation explains each field it refuses." })
    ),
    enabled: opt(bool({ description: "create/update: false starts the task paused." })),
    cwd: opt(str({ description: "create/update: working directory the run's session starts in." })),
    model: opt(
      obj({
        provider: str({ description: "Provider id." }),
        modelId: str({ description: "Model id." }),
      }, { description: "create/update: model for the run's session. Omit to inherit the default." })
    ),
    query: opt(str({ description: "list: case-insensitive filter on the task name." })),
  }),
  replay: "unsafe",
  execute: async (args, api: ToolExecutionApi, context: Context) => {
    const store = api as unknown as ScheduleStore;
    const handlers = createScheduleHandlers(store, () => api.now());
    switch (args.action) {
      case "list":
        return toolText(await handlers.list(args.query));
      case "create": {
        const result = await handlers.create({
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
        });
        return toolText(result.text, result.isError);
      }
      case "update": {
        const result = await handlers.update({
          ...(args.task === undefined ? {} : { task: args.task }),
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.model === undefined ? {} : { model: args.model }),
        });
        return toolText(result.text, result.isError);
      }
      case "remove": {
        const result = await handlers.remove({ ...(args.task === undefined ? {} : { task: args.task }) });
        return toolText(result.text, result.isError);
      }
      case "run": {
        const result = await handlers.run({ ...(args.task === undefined ? {} : { task: args.task }) });
        return toolText(result.text, result.isError);
      }
    }
  },
});

/**
 * What a model needs to know before it reaches for the tool: what it is for, that schedules are
 * wall-clock in a named zone, where a run's prompt goes, and the one habit that makes it useful —
 * saying the next run back in plain words. Three sentences, on purpose.
 */
export const scheduleSection = section(
  "schedule",
  () =>
    "Use the schedule tool when someone wants something to happen on a clock (every morning, on weekdays, once next " +
    "Tuesday) rather than in this turn: list, create, update, remove or run a scheduled task. Tasks belong to this Hearth, " +
    "not to one chat, and the Scheduled view shows the same list. Times are wall-clock in the task's timezone, and a run " +
    "submits the stored prompt to the task's own session — so write the prompt so it still makes sense when nobody is " +
    "watching. After creating or changing a schedule, tell the person the next run in plain words and check it is what they meant.",
  { tag: false }
);

/** The `schedule` tool as its own extension, so a conversation can deselect it. */
export const Schedule = { name: "schedule", tools: [ScheduleTool], sections: [scheduleSection] } as const;
