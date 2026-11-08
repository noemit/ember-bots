import * as React from 'react';
import { normalizeDirectory } from '../blob/seed';

const relativeTime = (timestamp: number | undefined, now: number): string => {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Owns its own clock so the 30s tick re-renders one span, not every rail row. */
export const RelativeTime = ({ timestamp, className }: { timestamp: number | undefined; className?: string }) => {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={className}>{relativeTime(timestamp, now)}</span>;
};

/** Keep the time beside the final description line, never competing with the bot's title. */
export default function RailDescription({ preview, timestamp, directory, compact = false }: {
  preview: string | undefined;
  timestamp: number | undefined;
  directory?: string;
  compact?: boolean;
}) {
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  const description = preview?.trim();
  const time = <span data-rail-time="" data-session-time=""
    className="flex-none whitespace-nowrap text-[10.5px] leading-4 tabular-nums text-muted-foreground"
    title={timestamp ? new Date(timestamp).toLocaleString() : undefined}>
    <RelativeTime timestamp={timestamp} />
  </span>;
  if (!compact && description) return <span data-rail-preview-time="" data-session-description="" className="flex min-w-0 items-end gap-2">
    <span data-testid="session-preview" title={preview}
      className="min-w-0 flex-1 line-clamp-2 text-[11.5px] leading-4 [overflow-wrap:anywhere]">
      {description}
    </span>
    {time}
  </span>;
  return <>
    {!compact && preview === undefined && !settled ? (
      // Startup previews are still loading, not missing; time remains on its own metadata line.
      <span aria-hidden="true" className="my-0.5 block h-2.5 w-3/4 animate-pulse rounded bg-muted" />
    ) : null}
    <span data-session-time-meta="" className="flex min-w-0 items-baseline gap-2 text-[11.5px] leading-4">
      {!compact && (preview !== undefined || settled) && directory ? <span className="min-w-0 truncate" title={directory}>
        {normalizeDirectory(directory).split(/[\\/]/).pop()}
      </span> : null}
      {time}
    </span>
  </>;
}
