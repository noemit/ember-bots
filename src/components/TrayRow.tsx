import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One item in the composer tray: a single line, and nothing drawn around it.
 *
 * The three trays above the composer used to be three different things — a card with per-row
 * "Queue:" prefixes, a card with "For Later:" prefixes, and a bordered strip of bordered chips —
 * so the band above the composer grew a border for every item and two lines for every queued
 * message. A row here is text on one line; the muted metadata at the end gives way to the row's
 * actions on hover or focus, so an idle tray is just words.
 *
 * The whole row is a control that *reads* the item (a modal, never an editor — the queue's editor
 * rewrites the row, which is the wrong thing to land in when you only wanted to see it). The
 * actions are siblings, not children: a button inside a button is not a thing, and the actions have
 * to stay reachable by keyboard, which is why they are always in the DOM and only faded out.
 *
 * A row that is *waiting* rather than working — a steer message held for the turn to pause — gets a
 * spinner at its trailing edge instead of a sentence in its metadata: the one line belongs to the
 * message, and the spinner says the rest.
 */
export type TrayRowProps = {
  /** The row's text, and the accessible name of the control that opens it. */
  text: string;
  /** Muted end-of-line note: the model, when it was queued. Hidden while the actions show. */
  meta?: React.ReactNode;
  /** Opens the read-only view. */
  onOpen: () => void;
  /** Accessible name for that control, e.g. `Read queued message: …`. */
  openLabel: string;
  /** The row's own controls, shown in place of `meta` on hover and on keyboard focus. */
  actions?: React.ReactNode;
  /** A second line, only for a row that has something to explain (a failed enqueue). */
  detail?: React.ReactNode;
  /** Sets a spinner at the row's leading edge: the row is being created or sent right now. */
  busy?: boolean;
  /**
   * A spinner at the far right instead, for a row that is waiting on something rather than doing
   * it — a steer message the host holds until the running turn pauses. It says "in hand, not idle"
   * without a sentence, and leaves the one line of text to the message itself.
   */
  waiting?: boolean;
  /** Spoken description of what the trailing spinner means, for the row's status. */
  waitingLabel?: string;
  className?: string;
};

const TrayRow = ({
  text,
  meta,
  onOpen,
  openLabel,
  actions,
  detail,
  busy,
  waiting,
  waitingLabel,
  className,
}: TrayRowProps) => (
  <div
    className={cn(
      'group/row flex min-w-0 flex-col rounded-md px-1.5 transition-colors hover:bg-muted/60 focus-within:bg-muted/50',
      className
    )}
  >
    <div className="flex h-[26px] min-w-0 items-center gap-1.5">
      {busy ? <Loader2 className="size-3 flex-none animate-spin text-highlight" /> : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={text}
        className="min-w-0 flex-1 truncate text-left text-[12.5px] text-foreground focus-visible:outline-none"
      >
        {text}
      </button>
      {meta ? (
        <span className="flex-none text-[10.5px] text-muted-foreground group-hover/row:hidden group-focus-within/row:hidden">
          {meta}
        </span>
      ) : null}
      {waiting ? (
        <span className="flex flex-none items-center" role="status" title={waitingLabel} aria-label={waitingLabel}>
          <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
        </span>
      ) : null}
      {actions ? (
        <span className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          {actions}
        </span>
      ) : null}
    </div>
    {detail ? <span className="min-w-0 truncate pb-1 pl-0.5 text-[10.5px] text-destructive">{detail}</span> : null}
  </div>
);

export default React.memo(TrayRow);
