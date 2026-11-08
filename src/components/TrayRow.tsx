import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A readable preview, quiet metadata below, and sibling actions — never a button in a button. */
export type TrayRowProps = {
  text: string;
  /** Metadata remains below the preview even while the actions are revealed. */
  meta?: React.ReactNode;
  onOpen: () => void;
  openLabel: string;
  actions?: React.ReactNode;
  /** Diagnostics wrap independently; they must never disappear behind the preview clamp. */
  detail?: React.ReactNode;
  busy?: boolean;
  /** A held steer waits at the trailing edge; pending/sending progress is leading. */
  waiting?: boolean;
  waitingLabel?: string;
  className?: string;
};

const TrayRow = ({ text, meta, onOpen, openLabel, actions, detail, busy, waiting, waitingLabel, className }: TrayRowProps) => (
  <div
    data-tray-row=""
    className={cn('group/row flex min-w-0 flex-col gap-1 px-1.5 py-2', className)}
  >
    <div className="flex min-w-0 items-start gap-2">
      {busy ? <Loader2 aria-hidden="true" className="mt-1 size-3 flex-none animate-spin text-highlight" /> : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={text}
        className="min-w-0 flex-1 text-left text-[12.5px] leading-5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span data-tray-preview="" className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      </button>
      {waiting ? (
        <span className="mt-1 flex flex-none items-center" role="status" title={waitingLabel} aria-label={waitingLabel}>
          <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
        </span>
      ) : null}
    </div>
    {/* Actions have their own reserved lane. Revealing them never narrows the preview or metadata. */}
    {meta || actions ? (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {meta ? <div data-tray-meta="" className="min-w-0 flex-1 basis-24 text-[10.5px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">{meta}</div> : null}
        {actions ? (
          <div data-tray-actions="" className="ml-auto flex max-w-full flex-none flex-wrap items-center gap-0.5 opacity-100 transition-opacity [@media(min-width:640px)_and_(hover:hover)_and_(pointer:fine)]:opacity-0 max-sm:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
            {actions}
          </div>
        ) : null}
      </div>
    ) : null}
    {detail ? <div data-tray-error="" className="text-[10.5px] leading-4 whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">{detail}</div> : null}
  </div>
);

export default React.memo(TrayRow);
