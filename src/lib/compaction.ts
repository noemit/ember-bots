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
};

/**
 * `failed`: the host refused. `landed`: it is running (or already ran). `nothing`: it accepted and
 * did nothing at all.
 */
export type CompactionOutcome = 'failed' | 'landed' | 'nothing';

export const compactionOutcome = (trace: CompactionTrace): CompactionOutcome => {
  if (!trace.accepted) return 'failed';
  // A flag means the host really started: the transcript re-reads when it ends, so saying nothing
  // here is the honest answer even if the entries have not shrunk yet.
  return trace.sawCompacting ? 'landed' : 'nothing';
};

/**
 * The one line a person needs when a compaction did nothing.
 *
 * It names what happened and why, and it is not an alarm: nothing is wrong with the conversation,
 * there was simply nothing to fold up. There is no next step to point at, which is exactly what the
 * sentence says.
 */
export const compactionNotice = (outcome: CompactionOutcome): string | null =>
  outcome === 'nothing'
    ? 'Nothing to compact — the recent turns already fit.'
    : null;

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
  ].join(' ');
