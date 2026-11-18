import * as React from 'react';
import { cn } from '@/lib/utils';
import { ExpansionContext, panelClass } from './expansion';

export const DIFF_INITIAL_LINE_CAP = 300;

export const DiffView = ({ diff, storageKey }: { diff: string; storageKey?: string }) => {
  const saved = React.useContext(ExpansionContext);
  const [expandedFor, setExpandedFor] = React.useState<string | null>(() =>
    storageKey && saved?.get(storageKey) ? diff : null
  );
  const lines = React.useMemo(() => diff.split('\n'), [diff]);
  const capped = lines.length > DIFF_INITIAL_LINE_CAP && expandedFor !== diff;
  const visibleLines = capped ? lines.slice(0, DIFF_INITIAL_LINE_CAP) : lines;
  const content = (
    <pre className={panelClass}>
      {visibleLines.map((line, index) => (
        <span
          key={index}
          className={cn(
            'block',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/15 text-diff-add',
            line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/15 text-diff-del',
            line.startsWith('@@') && 'text-muted-foreground'
          )}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
  if (!capped) return content;
  return (
    <div className="flex flex-col gap-1">
      {content}
      <button
        type="button"
        onClick={() => {
          if (storageKey) saved?.set(storageKey, true);
          setExpandedFor(diff);
        }}
        className="self-start rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        Show all {lines.length} lines
      </button>
    </div>
  );
};
