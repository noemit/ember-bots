import * as React from 'react';
import type { Session } from '../types';

/** A landed summary is success evidence; a 202, shorter page or a disappearing spinner is not. */
export default function ContextCompactionStatus({ session, host, onCompact }: { session: Session; host: string; onCompact: () => void }) {
  const seen = React.useRef(session.contextCompaction?.entryId);
  // Historical summaries present on initial mount are baseline, not newly observed compactions.
  const anchored = React.useRef(false);
  const [landed, setLanded] = React.useState<{ entryId: number; automatic: boolean }>();
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
  if (session.compactionFailure) return <p role="status" className="px-3 py-1 text-xs text-destructive">{host} did not finish compaction. <button className="underline" onClick={onCompact}>Try compacting again</button> when the turn finishes.</p>;
  if (!landed) return null;
  return <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Context compacted{landed.automatic ? ' automatically' : ''}. Older messages remain in the transcript.</p>;
}
