import * as React from 'react';
import Blob from '../blob/Blob';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RAIL_STRIP_GAP,
  RAIL_STRIP_LABEL_HEIGHT,
  RAIL_STRIP_LABEL_WIDTH,
} from '@/lib/railStrip';
import { sessionKey } from '../types';
import type { AvatarIdentity, BallMood, BlobStyle, Session } from '../types';

/**
 * The rail's session strip. Both cards in the rail that show sessions — the project card and the
 * group card — draw their bodies through these two pieces, so the two read as the same species of
 * card: one blob per session with its title as a two-line chip beneath it, a 30px minimum row that
 * keeps its height as blobs shrink, and a `+N` chip instead of reflowing. Sizes come from
 * `railStripLayout` (`lib/railStrip`); nothing here does the arithmetic.
 */

/** The `+N` chip that stands in for the sessions the strip doesn't draw. */
export const stripOverflowChipClass =
  'flex-none cursor-context-menu rounded-full border px-1.5 text-[10px] font-medium leading-[15px] tabular-nums text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground';

/** Toggle the row: a card whose whole body is a button (the group card) passes nothing. */
const CardToggle: React.FC<{ title: string; children: React.ReactElement }> = ({ title, children }) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top">{title}</TooltipContent>
  </Tooltip>
);

/** A session as the rail draws it inside a card: blob, title chip, pin badge, column underline. */
export function SessionBlob({
  session,
  size,
  blobStyle,
  identity,
  mood,
  active,
  onOpen,
}: {
  session: Session;
  /** Blob diameter in px, from `blobStripLayout`. */
  size: number;
  blobStyle: BlobStyle;
  identity: AvatarIdentity | undefined;
  mood: BallMood;
  /** The session is a workspace column, so its blob carries an underline. */
  active: boolean;
  /**
   * Omit for a blob the enclosing card opens itself (the group card opens every member as a
   * column): the blob then drops its button role, focus stop and key handling — but keeps its title
   * chip and tooltip, because the chip is the session's identity, not an affordance.
   */
  onOpen?: () => void;
}) {
  const key = sessionKey(session);
  const title = session.title?.trim() || session.id;
  const clickable = onOpen !== undefined;
  return (
    <CardToggle title={title}>
      <span
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        data-session-key={key}
        data-visible-column={active ? 'true' : undefined}
        className={[
          'relative flex flex-none flex-col items-center rounded-md',
          clickable
            ? 'cursor-pointer outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-highlight focus-visible:ring-offset-1 focus-visible:ring-offset-card'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ width: Math.max(size, RAIL_STRIP_LABEL_WIDTH) }}
        aria-label={clickable ? title : undefined}
        onClick={
          clickable
            ? (event) => {
                event.stopPropagation();
                onOpen();
              }
            : undefined
        }
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation();
                  event.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
      >
        <span className="relative">
          <Blob style={blobStyle} seed={key} identity={identity} size={size} mood={mood} />
        </span>
        <span
          data-blob-label
          style={{ maxHeight: RAIL_STRIP_LABEL_HEIGHT }}
          className="mt-0.5 block w-full overflow-hidden text-center"
        >
          <span className="rounded-sm bg-muted px-1 py-px text-[10px] leading-[13px] break-words text-muted-foreground [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
            {title}
          </span>
        </span>
        {active ? (
          <span
            data-column-underline
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-1 left-1/2 h-[3px] w-[55%] min-w-3 -translate-x-1/2 rounded-full bg-highlight"
          />
        ) : null}
      </span>
    </CardToggle>
  );
}

/** The strip row: a laid-out, height-stable band of `SessionBlob`s plus whatever trails them. */
export function SessionBlobStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 flex min-h-[30px] items-center px-1" style={{ gap: RAIL_STRIP_GAP }}>
      {children}
    </div>
  );
}
