import * as React from 'react';
import type { Session } from '../types';

/** A landed summary is success evidence; a 202, shorter page or a disappearing spinner is not. */
export default function ContextCompactionStatus({
  session,
  host,
  onCompact,
  turnBusy = false,
  compacting = false,
}: {
  session: Session;
  host: string;
  onCompact: () => void;
  turnBusy?: boolean;
  compacting?: boolean;
}) {
  const seen = React.useRef(session.contextCompaction?.entryId);
  // Historical summaries present on initial mount are baseline, not newly observed compactions.
  const anchored = React.useRef(false);
  const [landed, setLanded] = React.useState<{ entryId: number; automatic: boolean }>();
  const [dismissedTaskId, setDismissedTaskId] = React.useState<number>();
  const receipt = session.contextCompaction;
  React.useEffect(() => {
    if (receipt && receipt.entryId !== seen.current) {
      seen.current = receipt.entryId;
      if (anchored.current) setLanded({ entryId: receipt.entryId, automatic: ['threshold', 'overflow'].includes(receipt.reason) });
    } else if (session.compacting || session.compactionFailure || session.currentContextEpoch === 'initial') {
      setLanded(undefined);
    }
    anchored.current = true;
  }, [receipt, session.compacting, session.compactionFailure, session.currentContextEpoch]);
  if (session.compacting) return <p role="status" className="px-3 py-1 text-xs text-muted-foreground">{host} is compacting context… Older messages will stay in the transcript.</p>;
  if (session.compactionFailure && !(session.compactionFailure.taskId !== undefined && dismissedTaskId === session.compactionFailure.taskId)) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-2 px-3 py-1 text-xs text-destructive">
        <span>
          {host} did not finish compaction.{' '}
          <button type="button" disabled={turnBusy || compacting} className="underline disabled:opacity-50" onClick={onCompact}>
            Try compacting again
          </button>
          {turnBusy ? ' when the turn finishes.' : '.'}
        </span>
        <button type="button" className="text-muted-foreground underline hover:text-foreground" onClick={() => setDismissedTaskId(session.compactionFailure?.taskId)}>
          Dismiss
        </button>
      </p>
    );
  }
  if (!landed) return null;
  return <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Context compacted{landed.automatic ? ' automatically' : ''}. Older messages remain in the transcript.</p>;
}
