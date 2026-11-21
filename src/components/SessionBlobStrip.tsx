import ProcessIndicator from './ProcessIndicator';
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

const CardToggle: React.FC<{ title: string; children: React.ReactElement }> = ({ title, children }) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top">{title}</TooltipContent>
  </Tooltip>
);

/** A session as the rail draws it inside a card: blob, title chip, column underline. */
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
  onOpen: () => void;
}) {
  const key = sessionKey(session);
  const title = session.title?.trim() || session.id;
  return (
    <CardToggle title={title}>
      <span
        role="button"
        tabIndex={0}
        data-session-key={key}
        data-visible-column={active ? 'true' : undefined}
        className="relative flex flex-none flex-col items-center rounded-md cursor-pointer outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-highlight focus-visible:ring-offset-1 focus-visible:ring-offset-card"
        style={{ width: Math.max(size, RAIL_STRIP_LABEL_WIDTH) }}
        aria-label={title}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation();
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <span className="relative">
          <Blob style={blobStyle} seed={key} identity={identity} size={size} mood={mood} />
          <ProcessIndicator session={session} overlay />
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
