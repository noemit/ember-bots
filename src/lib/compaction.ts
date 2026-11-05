/**
 * What a manual compaction actually did, and what to say when the answer is "nothing".
 *
 * The host accepts every compaction request with `202` and a task id, then pi-durable's
 * `selectCut` returns `undefined` when the whole transcript already fits inside the kept window
 * (`keepRecentTokens`, 20k). That path calls `complete()` and posts no summary entry, no event and
 * no log line — verified against a live host: `POST /conversations/<id>/compact` on an empty
 * conversation answers `{"taskId":…}` and leaves the compaction flag false for ever. From the client
 * that is indistinguishable from a click that never left, which is the complaint this answers.
 *
 * The signal is the session summary's compaction flag: a real compaction sets it while it runs, and
 * the silent path never does. So the rule needs no second request and no host change.
 */
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
};

/**
 * `failed`: the host refused, or the compaction task itself recorded a failure. `landed`: it is
 * running (or already ran). `nothing`: it accepted and did nothing at all.
 */
export type CompactionOutcome = 'failed' | 'landed' | 'nothing';

export const compactionOutcome = (trace: CompactionTrace): CompactionOutcome => {
  if (!trace.accepted || (trace.error && trace.error.trim())) return 'failed';
  // A flag (or a transcript that already shrunk before the first poll) means the host really
  // compacted: the transcript re-reads when it ends, so saying nothing here is the honest answer.
  if (trace.sawCompacting || trace.entriesAfter < trace.entriesBefore) return 'landed';
  return 'nothing';
};

/**
 * The one line a person needs when a compaction did nothing, or when the task failed after 202.
 */
export const compactionNotice = (outcome: CompactionOutcome): string | null =>
  outcome === 'nothing'
    ? 'Nothing to compact — the recent turns already fit.'
    : null;

/** Format a post-202 compaction task failure so the error banner names what failed and what to do. */
export const compactionFailureMessage = (error: string | undefined): string => {
  const detail = error?.trim();
  if (!detail) return 'Could not compact this session — try again.';
  const cleaned = detail.replace(/\.$/, '');
  return `Compaction didn't finish (${cleaned}). Try again.`;
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
    `entries=${trace.entriesBefore}->${trace.entriesAfter}`,
    ...(trace.error ? [`error=${JSON.stringify(trace.error)}`] : []),
  ].join(' ');
