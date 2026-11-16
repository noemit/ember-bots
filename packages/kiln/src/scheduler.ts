/**
 * The Hearth scheduler: due-times in a session-scoped document, a tick loop that submits due
 * tasks to fresh independent conversations, and a small wire surface (`/scheduled-tasks`).
 *
 * Durability: the schedule lives in a session doc, so it survives restarts; a run's submit
 * carries a `requestId` derived from the task id and the scheduled instant, and `requestId` is
 * natively idempotent across restarts, so a crash between "due" and "submitted" cannot double-run
 * a task. Missed occurrences run once on the next tick (catch-up). Times are wall-clock in the
 * task's `timezone` (default: the process timezone), so a container in UTC and a Mac in CEST can
 * still both say "09:00".
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { setAutoAccept } from "./approvals";
import { MetaDoc } from "./meta";
import {
  defineDoc,
  LiveDoc,
  type AgentChange,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";

export type ScheduleSpec =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string; timezone?: string }
  | { kind: "weekly"; time: string; weekdays: number[]; timezone?: string };

export type ScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  /** Legacy target, retained for history and busy checks only; never submitted to again. */
  conversationId?: number;
  /** Creation parameters applied independently to every fresh run. */
  cwd?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  createdAt: number;
  /** The scheduled instant that last ran (not "now"), so cadence stays stable. */
  lastRunAt?: number;
  lastSessionId?: number;
  /** All run conversations, including legacy targets; never a transcript/context source. */
  runSessionIds?: number[];
  /** Persisted before submission so crash recovery retries in the SAME fresh run, not another. */
  pendingRun?: { occurrence: number; sessionId: number };
  lastStatus?: "ok" | "error";
  lastError?: string;
};

export type SchedulerState = { tasks: ScheduledTask[]; sequence: number };

/** One Hearth's schedule; a session-scoped singleton (global to this storage). */
export const SchedulerDoc = defineDoc<SchedulerState>({
  kind: "hearth.scheduler",
  version: 1,
  scope: "session",
  initial: () => ({ tasks: [], sequence: 0 }),
  checkpointWhen: () => true,
});

// ---- Time helpers (exported for tests) ------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_MS = 24 * 60 * 60 * 1000;

const formatterFor = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });

/** The wall-clock reading of an instant in a zone. */
export const wallClock = (
  epochMs: number,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } => {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
};

/** The instant of a wall-clock time in a zone (two passes settle DST offsets). */
export const wallClockToEpoch = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number => {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = wallClock(guess, timeZone);
  const firstDelta = Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute, first.second) - guess;
  const second = wallClock(guess - firstDelta, timeZone);
  const secondDelta = Date.UTC(second.year, second.month - 1, second.day, second.hour, second.minute, second.second) - (guess - firstDelta);
  return guess - secondDelta;
};

const parseHhMm = (time: string): { hour: number; minute: number } | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
};

/**
 * The most recent instant this task was scheduled for at or before `now` (undefined for a future
 * `once`). A task is due when that instant is newer than its `lastRunAt`.
 */
export const mostRecentOccurrence = (schedule: ScheduleSpec, now: number): number | undefined => {
  if (schedule.kind === "once") return schedule.at <= now ? schedule.at : undefined;
  const parsed = parseHhMm(schedule.time);
  if (!parsed) return undefined;
  const timeZone = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (schedule.kind === "daily") {
    const today = wallClock(now, timeZone);
    const todayAt = wallClockToEpoch(today.year, today.month, today.day, parsed.hour, parsed.minute, timeZone);
    return todayAt <= now ? todayAt : todayAt - DAY_MS;
  }
  // weekly: walk back up to a week for the most recent listed weekday.
  for (let back = 0; back < 7; back += 1) {
    const clock = wallClock(now - back * DAY_MS, timeZone);
    if (!schedule.weekdays.includes(clock.weekday)) continue;
    const at = wallClockToEpoch(clock.year, clock.month, clock.day, parsed.hour, parsed.minute, timeZone);
    if (at <= now) return at;
  }
  return undefined;
};

export const isDue = (task: ScheduledTask, now: number): boolean => {
  if (!task.enabled) return false;
  const occurrence = mostRecentOccurrence(task.schedule, now);
  return occurrence !== undefined && occurrence > (task.lastRunAt ?? 0);
};

// ---- Running --------------------------------------------------------------------------

export type RunOutcome = {
  status: "ok" | "error";
  sessionId?: number;
  error?: string;
  /** A manual run was refused because the target conversation is still working. */
  refused?: boolean;
};

/** The scheduler needs independent creation as well as document reads and commits. */
export type TaskRunner = Pick<Harness, "createConversation" | "conversation" | "snapshot" | "commit">;

class RunRefused extends Error {}

/**
 * Admit a new run atomically with its conversation binding. A restart may resume a pending
 * admission in that run only. Earlier completed conversations are history, never context.
 */
export const runTask = async (
  harness: TaskRunner,
  task: ScheduledTask,
  occurrence: number,
  context: Context = BACKGROUND_CONTEXT,
  creator: TaskRunner = harness,
  manual = false
): Promise<RunOutcome> => {
  let conversationId: ConversationId | undefined;
  let runOccurrence = occurrence;
  try {
    // Only automatic recovery reuses an unfinished admission, never a previous run.
    if (!manual && task.pendingRun) {
      conversationId = task.pendingRun.sessionId as ConversationId;
      runOccurrence = task.pendingRun.occurrence;
    } else {
      const change: AgentChange = {
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.thinkingLevel
          ? { thinkingLevel: task.thinkingLevel as NonNullable<AgentChange["thinkingLevel"]> }
          : {}),
      };
      const conversation = await creator.createConversation({
        ownership: { kind: "ownerless" },
        ...(Object.keys(change).length > 0 ? { agent: change } : {}),
        // Creation and reservation share a commit: a racing manual call/tick cannot start
        // another run, and a crash cannot leave a submitted but unrecorded conversation.
        init: async (tx, id) => {
          const doc = await tx.doc(SchedulerDoc);
          const stored = doc.tasks.find((entry) => entry.id === task.id);
          if (!stored) throw new RunRefused("Kiln no longer has this scheduled task. Refresh Scheduled to see the current plans.");
          if (stored.pendingRun || (!manual && (!stored.enabled || occurrence <= (stored.lastRunAt ?? 0)))) {
            throw new RunRefused("Kiln is already starting this task. Wait for that run before trying again.");
          }
          const previous = stored.lastSessionId ?? stored.conversationId;
          if (previous !== undefined && (await tx.doc(LiveDoc, previous as ConversationId)).run) {
            throw new RunRefused("Kiln is still running this task. Wait for it to finish or stop its session before running again.");
          }
          stored.runSessionIds = [...new Set([
            ...(stored.runSessionIds ?? []),
            ...(stored.conversationId === undefined ? [] : [stored.conversationId]),
            ...(stored.lastSessionId === undefined ? [] : [stored.lastSessionId]),
            id,
          ])];
          stored.pendingRun = { occurrence, sessionId: id };
          (await tx.doc(MetaDoc, id)).title = task.name;
        },
      }, context);
      conversationId = conversation.id;
    }
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) throw new Error("Kiln's new scheduled session is no longer available. Run the task again from Scheduled.");
    // Nobody is watching to approve tools. Fresh sessions retain the scheduler's YOLO policy.
    await setAutoAccept(harness, conversationId, true, context);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SchedulerDoc);
      const stored = doc.tasks.find((entry) => entry.id === task.id);
      // A racing recovery already settled it, or the human removed the plan. Never
      // re-place a stopped old submission when a stale tick finally catches up.
      if (!stored || stored.pendingRun?.sessionId !== conversationId) return;
      await conversation.submit(tx, {
        type: "input", content: task.prompt, requestId: `${task.id}:${runOccurrence}`,
      });
      stored.lastRunAt = runOccurrence;
      stored.lastSessionId = conversationId;
      stored.lastStatus = "ok";
      delete stored.lastError;
      delete stored.pendingRun;
    }, context);
    return { status: "ok", sessionId: conversationId };
  } catch (error) {
    return {
      status: "error",
      ...(conversationId === undefined ? {} : { sessionId: conversationId }),
      ...(error instanceof RunRefused ? { refused: true } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const recordOutcome = async (
  harness: TaskRunner, id: string, occurrence: number, outcome: RunOutcome, context: Context
): Promise<void> => {
  if (outcome.refused) return;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulerDoc);
    const task = doc.tasks.find((entry) => entry.id === id);
    if (!task) return;
    // A racing recovery may already have recorded this admission. Never overwrite a later run.
    if (outcome.sessionId !== undefined && task.pendingRun?.sessionId !== outcome.sessionId) return;
    // Creation may have committed before its caller saw an error. Keep that durable
    // admission for recovery rather than abandoning it and starting another session.
    if (outcome.sessionId === undefined && task.pendingRun) return;
    task.lastRunAt = task.pendingRun?.occurrence ?? occurrence;
    task.lastStatus = outcome.status;
    if (outcome.sessionId !== undefined) task.lastSessionId = outcome.sessionId;
    if (outcome.error) task.lastError = outcome.error;
    else delete task.lastError;
    delete task.pendingRun;
  }, context);
};

/** Run due tasks once. Busy tasks defer without consuming their occurrence; missed runs coalesce. */
export const tick = async (harness: Harness, context: Context = BACKGROUND_CONTEXT): Promise<number> => {
  const snapshot = await harness.snapshot(SchedulerDoc, context);
  if (!snapshot || snapshot.tasks.length === 0) return 0;
  const now = Date.now();
  let ran = 0;
  for (const task of snapshot.tasks) {
    let occurrence: number | undefined;
    try {
      if (task.pendingRun) occurrence = task.pendingRun.occurrence;
      else if (isDue(task, now)) occurrence = mostRecentOccurrence(task.schedule, now);
    } catch (error) {
      console.error(`[hearth] scheduled task ${task.id} has an unusable schedule:`, error instanceof Error ? error.message : error);
      continue;
    }
    if (occurrence === undefined) continue;
    const outcome = await runTask(harness, task, occurrence, context);
    await recordOutcome(harness, task.id, occurrence, outcome, context);
    if (!outcome.refused) ran += 1;
  }
  return ran;
};

export type Scheduler = { stop(): void; runOnce(): Promise<number> };

/** Tick now (catch-up) then on an interval; overlapping ticks are skipped. */
export const startScheduler = (
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
  intervalMs = 30_000
): Scheduler => {
  let busy = false;
  const runOnce = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      return await tick(harness, context);
    } catch (error) {
      console.error("[hearth] scheduler tick failed:", error instanceof Error ? error.message : error);
      return 0;
    } finally {
      busy = false;
    }
  };
  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce };
};

// ---- Wire helpers ---------------------------------------------------------------------

export const listScheduledTasks = async (
  harness: Pick<Harness, "snapshot">,
  context: Context = BACKGROUND_CONTEXT
): Promise<SchedulerState> => (await harness.snapshot(SchedulerDoc, context)) ?? { tasks: [], sequence: 0 };

export type ScheduledTaskInput = Omit<ScheduledTask, "id" | "createdAt">;

/**
 * The `timezone` a wire schedule carries, or `undefined` for none, or `null` when this machine does
 * not know it. `Intl.DateTimeFormat` throws a `RangeError` on an unknown zone, and accepting one
 * would store a task whose every later `isDue()` throws — refusing it at creation is the only place
 * the person who typed it can still be told.
 */
const parseTimeZone = (value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    formatterFor(value);
    return value;
  } catch {
    return null;
  }
};

/** Validate a wire `schedule` object, or null when malformed. */
export const parseSchedule = (raw: unknown): ScheduleSpec | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === "once" && typeof record.at === "number" && Number.isFinite(record.at)) {
    return { kind: "once", at: record.at };
  }
  if (record.kind === "daily" && typeof record.time === "string" && parseHhMm(record.time)) {
    const timezone = parseTimeZone(record.timezone);
    if (timezone === null) return null;
    return {
      kind: "daily",
      time: record.time,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  }
  if (record.kind === "weekly" && typeof record.time === "string" && parseHhMm(record.time) && Array.isArray(record.weekdays)) {
    const weekdays = record.weekdays
      .filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)
      .slice(0, 7);
    if (weekdays.length === 0) return null;
    const timezone = parseTimeZone(record.timezone);
    if (timezone === null) return null;
    return {
      kind: "weekly",
      time: record.time,
      weekdays,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  }
  return null;
};

/** Validate a wire body into a task draft, or null when malformed. */
export const parseScheduledTaskInput = (body: Record<string, unknown>): ScheduledTaskInput | null => {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!name || !prompt.trim()) return null;
  const schedule = parseSchedule(body.schedule);
  if (!schedule) return null;
  const model = body.model as { provider?: unknown; modelId?: unknown } | undefined;
  const validModel =
    model && typeof model.provider === "string" && typeof model.modelId === "string"
      ? { provider: model.provider, modelId: model.modelId }
      : undefined;
  return {
    name,
    prompt: prompt.slice(0, 20_000),
    schedule,
    enabled: body.enabled !== false,
    ...(typeof body.conversationId === "number" && Number.isInteger(body.conversationId)
      ? { conversationId: body.conversationId }
      : {}),
    ...(typeof body.cwd === "string" ? { cwd: body.cwd.slice(0, 2048) } : {}),
    ...(validModel ? { model: validModel } : {}),
    ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}),
  };
};

/** Validate a partial update (PATCH): only the fields present and well-formed are applied. */
export const parseScheduledTaskPatch = (body: Record<string, unknown>): Partial<ScheduledTaskInput> => {
  const patch: Partial<ScheduledTaskInput> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
  if (typeof body.prompt === "string" && body.prompt.trim()) patch.prompt = body.prompt.slice(0, 20_000);
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  const schedule = body.schedule === undefined ? null : parseSchedule(body.schedule);
  if (schedule) patch.schedule = schedule;
  if (typeof body.conversationId === "number" && Number.isInteger(body.conversationId)) {
    patch.conversationId = body.conversationId;
  }
  if (typeof body.cwd === "string") patch.cwd = body.cwd.slice(0, 2048);
  if (typeof body.thinkingLevel === "string") patch.thinkingLevel = body.thinkingLevel;
  const model = body.model as { provider?: unknown; modelId?: unknown } | undefined;
  if (model && typeof model.provider === "string" && typeof model.modelId === "string") {
    patch.model = { provider: model.provider, modelId: model.modelId };
  }
  return patch;
};

export const createScheduledTask = async (
  harness: Harness,
  input: ScheduledTaskInput,
  context: Context = BACKGROUND_CONTEXT
): Promise<ScheduledTask> => {
  let created: ScheduledTask | undefined;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulerDoc);
    doc.sequence += 1;
    created = { id: `task_${doc.sequence}`, createdAt: Date.now(), ...input };
    doc.tasks.push(created);
  }, context);
  return created as ScheduledTask;
};

export const updateScheduledTask = async (
  harness: Harness,
  id: string,
  patch: Partial<ScheduledTaskInput>,
  context: Context = BACKGROUND_CONTEXT
): Promise<ScheduledTask | undefined> => {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulerDoc);
    const task = doc.tasks.find((entry) => entry.id === id);
    if (task) Object.assign(task, patch);
  }, context);
  // Re-read: the draft is settled once the commit returns.
  return (await listScheduledTasks(harness, context)).tasks.find((entry) => entry.id === id);
};

export const deleteScheduledTask = async (
  harness: Harness,
  id: string,
  context: Context = BACKGROUND_CONTEXT
): Promise<boolean> => {
  let removed = false;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulerDoc);
    const next = doc.tasks.filter((entry) => entry.id !== id);
    removed = next.length !== doc.tasks.length;
    doc.tasks = next;
  }, context);
  return removed;
};

/**
 * Run now starts a fresh independent session, even on a paused plan. Busy/in-admission tasks
 * refuse rather than queue or overlap. A successful manual attempt consumes cadence through
 * now (the existing Run now policy); a refusal does not alter timing or the previous outcome.
 */
export const runScheduledTaskNow = async (
  harness: TaskRunner,
  id: string,
  context: Context = BACKGROUND_CONTEXT,
  creator: TaskRunner = harness
): Promise<RunOutcome | undefined> => {
  const state = await listScheduledTasks(harness, context);
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) return undefined;
  const occurrence = Date.now();
  const outcome = await runTask(harness, task, occurrence, context, creator, true);
  await recordOutcome(harness, id, occurrence, outcome, context);
  return outcome;
};
