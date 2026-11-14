/** A request receipt and a transient flag cannot prove a compaction's outcome.
 * New Kilns expose task-scoped status, including whether the summary write actually landed.
 * Older hosts remain unknown rather than being called a no-op after a short timeout.
 */
export type CompactionTaskStatus = 'running' | 'pending' | 'landed' | 'nothing' | 'failed' | 'aborted';
export type CompactionTaskResult = { status: CompactionTaskStatus; error?: string };
export type CompactionTrace = {
  /** The host answered the request at all (a 2xx rather than a refusal). */
  accepted: boolean;
  /** The session summary reported a running compaction inside the watch window. */
  sawCompacting: boolean;
  /** The transcript's length before the request, for the log line. */
  entriesBefore: number;
  /** …and after the read that follows it. */
  entriesAfter: number;
  /** When the compaction task itself failed (`pi.live.compactionFailure.error`). */
  error?: string;
  /** Task-scoped evidence, when the host supports it. */
  taskStatus?: CompactionTaskStatus;
};

/**
 * Only terminal task evidence proves a no-op. A running flag or a deadline never proves success.
 */
export type CompactionOutcome = 'failed' | 'landed' | 'nothing' | 'pending' | 'unknown' | 'aborted';

export const compactionOutcome = (trace: CompactionTrace): CompactionOutcome => {
  if (trace.taskStatus === 'aborted') return 'aborted';
  if (!trace.accepted || (trace.error && trace.error.trim()) || trace.taskStatus === 'failed') return 'failed';
  if (trace.taskStatus === 'landed' || trace.taskStatus === 'nothing') return trace.taskStatus;
  if (trace.taskStatus === 'pending' || trace.taskStatus === 'running') return 'pending';
  if (trace.entriesAfter < trace.entriesBefore) return 'landed';
  return trace.sawCompacting ? 'pending' : 'unknown';
};

/**
 * The one line a person needs when a compaction did nothing, or when the task failed after 202.
 */
export const compactionNotice = (outcome: CompactionOutcome): string | null =>
  outcome === 'nothing'
    ? 'Nothing to compact — the host left the current context unchanged.'
    : outcome === 'pending'
      ? 'The host is still compacting or waiting for the turn to pause. Its status will refresh here.'
      : outcome === 'unknown'
        ? 'The host accepted compaction but has not confirmed the result. Refresh this session to check its context.'
        : outcome === 'aborted'
          ? 'The host stopped compaction before it finished. You can try again.'
          : null;

/** Format a post-202 compaction task failure so the error banner names what failed and what to do. */
export const compactionFailureMessage = (error: string | undefined, target?: string): string => {
  const subject = target?.trim() ? `Compaction for ${target.trim()}` : 'Compaction';
  const detail = error?.trim();
  if (!detail) return `${subject} didn't finish. Try again.`;
  const cleaned = detail.replace(/\.$/, '');
  return `${subject} didn't finish (${cleaned}). Try again.`;
};

/** The line written to `ember-compact.log`, one per attempt. */
export const compactionLogLine = (
  trace: CompactionTrace,
  ids: { instanceId: string; sessionId: string },
  at: number = Date.now()
): string =>
  [
    new Date(at).toISOString(),
    `instance=${ids.instanceId}`,
    `session=${ids.sessionId}`,
    `outcome=${compactionOutcome(trace)}`,
    `accepted=${trace.accepted}`,
    `compacting=${trace.sawCompacting}`,
    ...(trace.taskStatus ? [`task=${trace.taskStatus}`] : []),
    `entries=${trace.entriesBefore}->${trace.entriesAfter}`,
    ...(trace.error ? [`error=${JSON.stringify(trace.error)}`] : []),
  ].join(' ');

/** Bounded task observer. A transient flag is progress, never terminal evidence. */
export const watchCompaction = async (options: {
  taskId?: number;
  previousFailureTaskId?: number;
  readTask: (taskId: number) => Promise<CompactionTaskResult | null>;
  readSummary: () => Promise<{ compacting?: boolean; compactionFailure?: { taskId?: number; error?: string } } | undefined>;
  delay: () => Promise<void>;
  maxPolls?: number;
  now?: () => number;
  maxWaitMs?: number;
}): Promise<{ sawCompacting: boolean; taskStatus?: CompactionTaskStatus; error?: string }> => {
  let sawCompacting = false;
  let taskStatus: CompactionTaskStatus | undefined;
  let supportsTask = options.taskId !== undefined;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxWaitMs ?? 20_000);
  for (let attempt = 0; attempt < (options.maxPolls ?? 50); attempt += 1) {
    if (now() >= deadline) break;
    await options.delay();
    if (now() >= deadline) break;
    if (supportsTask && options.taskId !== undefined) {
      const task = await options.readTask(options.taskId);
      if (task) {
        taskStatus = task.status;
        if (task.status !== 'running' && task.status !== 'pending') {
          // Refresh the summary after terminal evidence so applied context/epoch reaches the UI.
          await options.readSummary();
          return { sawCompacting, taskStatus, error: task.error };
        }
      } else supportsTask = false;
    }
    const summary = await options.readSummary();
    sawCompacting ||= summary?.compacting === true;
    const failure = summary?.compactionFailure;
    if (failure?.error && (options.taskId !== undefined
      ? failure.taskId === options.taskId
      : failure.taskId !== options.previousFailureTaskId)) {
      return { sawCompacting, taskStatus: 'failed', error: failure.error };
    }
    // Old hosts cannot prove success/no-op. Observe a brief window, then say unconfirmed.
    if (!supportsTask && attempt >= 4) break;
  }
  return { sawCompacting, taskStatus };
};

/** In-memory receipts belong to this Ember run, never historical failures discovered on startup. */
export type ObservedCompactions = Readonly<Record<string, readonly number[]>>;
export const rememberCompactionTask = (state: ObservedCompactions, key: string, taskId: number): ObservedCompactions => ({
  ...state, [key]: [...new Set([...(state[key] ?? []), taskId])],
});
export const forgetCompactionTask = (state: ObservedCompactions, key: string, taskId: number): ObservedCompactions => {
  if (!state[key]?.includes(taskId)) return state;
  const remaining = state[key].filter((id) => id !== taskId);
  const next = { ...state };
  if (remaining.length) next[key] = remaining;
  else delete next[key];
  return next;
};
/** Atomically claim one matching failure so the bounded watcher and summary refresh cannot repeat it. */
export const consumeCompactionFailure = (state: ObservedCompactions, key: string,
  failure: { taskId?: number; error?: string } | undefined
): { state: ObservedCompactions; error?: string } => {
  if (failure?.taskId === undefined || !failure.error?.trim() || !state[key]?.includes(failure.taskId)) return { state };
  return { state: forgetCompactionTask(state, key, failure.taskId), error: failure.error };
};
