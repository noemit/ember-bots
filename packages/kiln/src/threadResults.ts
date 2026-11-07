import type { CrewEntry, SessionsState } from './sessions';

/** A task version survives replay and changes whenever the same thread is assigned new work. */
export const threadTask = (entry: CrewEntry): string => `${entry.conversationId}:${entry.taskAt ?? entry.spawnedAt}`;
export const resultRetrieved = (entry: CrewEntry): boolean =>
  entry.report !== undefined && entry.retrievedResult === entry.report.requestId;

/** Completion subscriptions concern a particular task, never a mutable thread name alone. */
export const threadCompletionDue = (entry: CrewEntry): boolean =>
  entry.delivery === 'thread' && entry.report !== undefined &&
  entry.notifiedResult !== entry.report.requestId && !resultRetrieved(entry) &&
  (entry.state === 'failed' || entry.state === 'stopped' || entry.resumeTask === threadTask(entry));

/** Bounded metadata notification; result text lives only in the worker and the result document. */
export const threadNotice = (entries: readonly [string, CrewEntry][]): string =>
  '[threads] Outcomes available:\n' + entries.map(([name, entry]) =>
    `${name}: ${entry.state}; task ${threadTask(entry)}; result ${entry.report?.requestId ?? 'pending'}; ` +
    `conversation ${entry.conversationId}`
  ).join('\n') +
  '\nUse session results with a name for the result and evidence link. Retrieved does not mean verified or incorporated. ' +
  'Continue silently when appropriate; do not acknowledge routine completion. Reply only with useful findings, a decision, a blocker or the final outcome.';

/** Mark only the versions actually returned, even if another task completes during the read. */
export const recordRetrieved = (state: SessionsState, versions: ReadonlyMap<string, string>): void => {
  for (const [name, version] of versions) {
    const entry = state.items[name];
    if (entry?.report?.requestId === version) entry.retrievedResult = version;
  }
};
