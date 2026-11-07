/**
 * Pure derivations for the Scheduled view and its top-bar notification counter.
 *
 * A run is an ordinary session whose key is bound to a scheduled task (`settings.scheduledSessionBindings`),
 * plus any session currently named as a task's `state.lastSessionId`. The Scheduled tab shows:
 * 1. Runs across every configured instance, newest first (`lastRunAt`, falling back to `session.updated`),
 *    with the task that produced each run, its status, and when it ran.
 * 2. Plans (triggers) kept in their own section apart from the runs, with their schedule text and
 *    derived next run when the schedule is understood.
 */
import type { ScheduledTask } from '../api';
import {
   sessionKey,
  type BallState,
  type Instance,
  type Session,
  type SessionReadMark,
} from '../types';
import { describeSchedule } from './scheduleText';

export type ScheduledRunStatus = 'running' | 'failed' | 'succeeded';

export type ScheduledRunRow = {
  /** Session key (`instanceId::sessionId`), or `task:<taskKey>` when the session record is not loaded yet. */
  key: string;
  task: ScheduledTask;
  session: Session | null;
  instanceLabel?: string;
  status: ScheduledRunStatus;
  error?: string;
  /** Epoch ms the run happened (`state.lastRunAt` for the latest run, else `session.updated`). */
  at: number;
  /** Whether this run finished after the reader's mark and is worth a look. */
  unseen: boolean;
};

/**
 * Whether a finished run has not been looked at yet.
 *
 * A run is unseen when it is not currently running and:
 * - its session has a `lastEntryId` newer than the session's `readMark.through`, or
 * - it has no `readMark` and its timestamp (`at`) is newer than `seenBaselineAt` (such as `readSince`
 *   or `scheduledSeenAt`), or
 * - it is the task's latest run and `task.state.lastStatus === 'error'` after `seenBaselineAt`.
 */
export const isRunUnseen = (input: {
  status: ScheduledRunStatus;
  session: Session | null;
  at: number;
  mark?: SessionReadMark;
  muted?: boolean;
  seenBaselineAt?: number;
}): boolean => {
  const { status, session, at, mark, seenBaselineAt = 0 } = input;
  if (status === 'running') return false;
  if (input.muted) return false;
  if (at > 0 && seenBaselineAt > 0 && at <= seenBaselineAt) return false;
  if (session?.lastEntryId !== undefined && mark) {
    return session.lastEntryId > mark.through;
  }
  if (mark?.readAt !== undefined && at > 0) {
    return at > mark.readAt;
  }
  return at > seenBaselineAt;
};

/**
 * Build the chronological (newest-first) list of scheduled runs across all configured tasks and
 * bound sessions.
 */
export const buildScheduledRuns = (input: {
  tasks: readonly ScheduledTask[];
  sessions: readonly Session[];
  bindings: Readonly<Record<string, string>>;
  states?: Readonly<Record<string, BallState>>;
  failedKeys?: ReadonlySet<string>;
  readMarks?: Readonly<Record<string, SessionReadMark>>;
  mutedSessions?: readonly string[];
  seenBaselineAt?: number;
  instances?: readonly Instance[];
}): ScheduledRunRow[] => {
  const {
    tasks,
    sessions,
    bindings,
    states = {},
    failedKeys = new Set<string>(),
    readMarks = {},
    mutedSessions = [],
    seenBaselineAt = 0,
    instances = [],
  } = input;

  const taskByKey = new Map(tasks.map((task) => [task.key, task]));
  const sessionByKey = new Map(sessions.map((session) => [sessionKey(session), session]));
  const instanceLabels = new Map(instances.map((instance) => [instance.id, instance.label]));
  const rowsByKey = new Map<string, ScheduledRunRow>();

  // 1. Every session bound to a known scheduled task in `scheduledSessionBindings`.
  for (const [sKey, tKey] of Object.entries(bindings)) {
    const task = taskByKey.get(tKey);
    const session = sessionByKey.get(sKey) ?? null;
    if (!task || !session) continue;
    const isLatest = task.state.lastSessionId === session.id;
    const ball = states[sKey];
    const running = ball === 'active' || ball === 'needs-input';
    const failed =
      !running &&
      (failedKeys.has(sKey) || (isLatest && (task.state.lastStatus === 'error' || Boolean(task.state.lastError))));
    const status: ScheduledRunStatus = running ? 'running' : failed ? 'failed' : 'succeeded';
    const at = (isLatest ? task.state.lastRunAt : undefined) ?? session.updated ?? 0;
    const error = isLatest && failed ? task.state.lastError : undefined;
    rowsByKey.set(sKey, {
      key: sKey,
      task,
      session,
      instanceLabel: instanceLabels.get(task.instanceId),
      status,
      ...(error ? { error } : {}),
      at,
      unseen: isRunUnseen({
        status,
        session,
        at,
        mark: readMarks[sKey],
        muted: mutedSessions.includes(sKey),
        seenBaselineAt,
      }),
    });
  }

  // 2. Tasks whose `lastSessionId` or `lastRunAt` is known even if the session wasn't in `bindings`.
  for (const task of tasks) {
    const lastId = task.state.lastSessionId;
    const sKey = lastId ? `${task.instanceId}::${lastId}` : undefined;
    if (sKey && rowsByKey.has(sKey)) continue;
    const session = sKey ? (sessionByKey.get(sKey) ?? null) : null;
    const hasRunRecord = Boolean(lastId || task.state.lastRunAt || task.state.lastStatus || task.state.lastError);
    if (!hasRunRecord) continue;
    const ball = sKey ? states[sKey] : undefined;
    const running = ball === 'active' || ball === 'needs-input';
    const failed =
      !running &&
      ((sKey ? failedKeys.has(sKey) : false) ||
        task.state.lastStatus === 'error' ||
        Boolean(task.state.lastError));
    const status: ScheduledRunStatus = running ? 'running' : failed ? 'failed' : 'succeeded';
    const at = task.state.lastRunAt ?? session?.updated ?? 0;
    const rowKey = sKey ?? `run:${task.key}`;
    rowsByKey.set(rowKey, {
      key: rowKey,
      task,
      session,
      instanceLabel: instanceLabels.get(task.instanceId),
      status,
      ...(failed && task.state.lastError ? { error: task.state.lastError } : {}),
      at,
      unseen: isRunUnseen({
        status,
        session,
        at,
        mark: sKey ? readMarks[sKey] : undefined,
        muted: sKey ? mutedSessions.includes(sKey) : false,
        seenBaselineAt,
      }),
    });
  }

  return [...rowsByKey.values()].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
};

/**
 * The notification counter for the top-bar Scheduled tab: runs that finished since you last looked
 * and are worth a look (succeeded or failed), never "tasks that exist" and never a run still in flight.
 */
export const countUnseenScheduledRuns = (runs: readonly ScheduledRunRow[]): number =>
  runs.reduce((count, run) => (run.unseen ? count + 1 : count), 0);

/** Tooltip for the Scheduled tab's counter badge. */
export const scheduledBadgeTitle = (count: number): string =>
  `${count} scheduled ${count === 1 ? 'run' : 'runs'} finished since you last looked`;

/**
 * Derive the next run timestamp (epoch ms) from a task's state or its `schedule` object when
 * possible, or `null` when the task is paused or the schedule has no future occurrence.
 */
export const deriveNextRunAt = (task: ScheduledTask, now: number = Date.now()): number | null => {
  if (!task.enabled) return null;
  if (typeof task.state.nextRunAt === 'number' && Number.isFinite(task.state.nextRunAt) && task.state.nextRunAt > now) {
    return task.state.nextRunAt;
  }
  const raw = task.raw?.schedule;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  if (spec.kind === 'once' && typeof spec.at === 'number' && Number.isFinite(spec.at)) {
    return spec.at > now ? spec.at : null;
  }
  if ((spec.kind === 'daily' || spec.kind === 'weekly') && typeof spec.time === 'string') {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(spec.time.trim());
    if (!match) return null;
    const targetHour = Number(match[1]);
    const targetMinute = Number(match[2]);
    const weekdays =
      spec.kind === 'weekly' && Array.isArray(spec.weekdays)
        ? new Set(spec.weekdays.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6))
        : null;
    if (weekdays && weekdays.size === 0) return null;

    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(targetHour, targetMinute, 0, 0);
    for (let offset = 0; offset < 8; offset += 1) {
      const check = new Date(candidate.getTime() + offset * 24 * 60 * 60 * 1000);
      if (check.getTime() <= now) continue;
      if (!weekdays || weekdays.has(check.getDay())) {
        return check.getTime();
      }
    }
  }
  return null;
};

/** Summary line for a plan row in the Scheduled view. */
export const formatPlanSummary = (task: ScheduledTask): string => {
  const schedule = describeSchedule(task.raw?.schedule);
  return schedule ?? 'Schedule managed by host';
};
