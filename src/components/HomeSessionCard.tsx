import * as React from 'react';
import { ArrowRight, CheckCheck, Loader2 } from 'lucide-react';
import Blob from '../blob/Blob';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { RelativeTime } from './SessionRow';
import type { UnreadItem } from '../lib/unreadDigest';
import type { AvatarIdentity, BallMood, BlobStyle, Session } from '../types';

type Props = {
  session: Session;
  mood: BallMood;
  identity: AvatarIdentity | undefined;
  blobStyle: BlobStyle;
  projectName?: string;
  instanceLabel: string;
  /**
   * What this session has waiting: unread messages plus any pending approval or question. Empty
   * for a session that is fully read, which is the only difference between the two states — a read
   * session simply draws no dots.
   */
  items: UnreadItem[];
  /** The first read is in flight, so the rows say so instead of the session looking read. */
  pending?: boolean;
  /** Comment sets sent from Ember on this session; the row's own tally, not the queue's. */
  comments: number;
  notes: number;
  /** Alternating band, so the eye can follow one session down a long list. */
  striped?: boolean;
  onOpen: () => void;
  /** Read one message in full, in the reading view. Marking happens there, after the words. */
  onReadItem: (item: UnreadItem) => void;
  /** Right-click: read everything up to the newest entry on the host. */
  onMarkAllRead: () => void;
};

/** Rows shown before the row summarises the rest; three keeps one session about a screen tall. */
const VISIBLE_ROWS = 3;

const metaLine = (session: Session, projectName: string | undefined, instanceLabel: string): string =>
  [projectName, instanceLabel, session.model?.modelID].filter(Boolean).join(' · ');

const formatTime = (at: number): string =>
  at > 0 ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

/**
 * One session in Home's list.
 *
 * There is no card here: sessions are separated by a zebra band, not a border, a radius or a
 * shadow, so a long list reads as one column of conversations rather than a stack of boxes. Each
 * row inside is one unread message — mostly a reply, sometimes a question — and nothing names the
 * agent, because everything under a session came from that one conversation. A fully read session
 * is the same block with no dots, no count and no rows.
 */
const HomeSessionCard = React.memo(function HomeSessionCard({
  session,
  mood,
  identity,
  blobStyle,
  projectName,
  instanceLabel,
  items,
  pending,
  comments,
  notes,
  striped = false,
  onOpen,
  onReadItem,
  onMarkAllRead,
}: Props) {
  const title = session.title?.trim() || projectName || session.id;
  const unread = items.filter((item) => !item.sticky).length;
  const requests = items.filter((item) => item.sticky).length;
  // Derived, never stored: the session is unread while anything in it is waiting (a message you
  // haven't marked, or a request you haven't answered). Nothing is loaded yet → no claim either way.
  const readState: 'unread' | 'read' | null =
    items.length > 0 ? 'unread' : pending ? null : 'read';
  const shown = items.slice(0, VISIBLE_ROWS);
  const hidden = items.length - shown.length;
  const key = `${session.instanceId}::${session.id}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          data-testid="home-session-card"
          data-session-key={key}
          data-unread={items.length > 0 ? 'true' : 'false'}
          data-read-state={readState ?? 'unknown'}
          className={cn(
            'flex min-w-0 flex-col px-3.5 py-2.5 transition-colors',
            striped ? 'bg-foreground/[0.035]' : 'bg-transparent'
          )}
        >
          <div className="flex w-full max-w-[980px] min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2.5">
            <Blob style={blobStyle} seed={key} identity={identity} mood={mood} size={26} />
            <span className="flex min-w-0 flex-1 flex-col">
              {/* The title is the "open this session" control, so a session is reachable by name
                  from the keyboard and from anything looking one up by role. */}
              <button
                type="button"
                onClick={onOpen}
                data-testid="home-session-title"
                title={`Open ${title}`}
                className="truncate rounded text-left text-[13px] font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {title}
              </button>
              <span className="truncate text-[11px] text-muted-foreground">
                {metaLine(session, projectName, instanceLabel)}
              </span>
            </span>
            <span className="flex flex-none items-center gap-2">
              {readState ? (
                <span
                  data-testid="home-read-state"
                  data-read-state={readState}
                  className={cn(
                    'text-[10.5px] font-medium uppercase tracking-wide',
                    readState === 'unread' ? 'text-highlight' : 'text-muted-foreground/70'
                  )}
                >
                  {readState === 'unread' ? 'Unread' : 'Read'}
                </span>
              ) : null}
              {unread > 0 ? (
                <span
                  title={`${unread} unread ${unread === 1 ? 'message' : 'messages'}`}
                  className="grid min-w-5 place-items-center rounded-full bg-highlight px-1.5 text-[11px] font-semibold tabular-nums text-highlight-foreground"
                >
                  {unread}
                </span>
              ) : null}
              <RelativeTime timestamp={session.updated} className="text-[11px] text-muted-foreground" />
            </span>
          </div>

          {items.length > 0 || pending ? (
            <div className="flex flex-col gap-0.5 pb-0.5 pl-[36px] pt-1">
              {pending && items.length === 0 ? (
                <div className="flex items-center gap-2 px-2 py-1.5 text-[11.5px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Reading the new messages…
                </div>
              ) : null}
              {shown.map((item) => (
                <div
                  key={item.id}
                  data-testid="home-unread-row"
                  data-kind={item.kind}
                  className="flex min-w-0 items-start gap-2 rounded py-1"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-[5px] size-2 flex-none rounded-full',
                      // A pending approval or question is answered, never read: its dot is hollow.
                      item.sticky ? 'border-[1.5px] border-highlight' : 'bg-highlight'
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => onReadItem(item)}
                    data-testid="home-read-row"
                    title="Read this message"
                    aria-label={`Read this message: ${item.excerpt.slice(0, 80)}`}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.excerpt ? (
                      <span className="line-clamp-2 text-[12px] leading-[1.45] text-foreground/90">
                        {item.excerpt}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="text-[10.5px] tabular-nums text-muted-foreground">
                        {formatTime(item.at)}
                      </span>
                      {item.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="h-4 px-1.5 text-[9.5px] font-medium uppercase tracking-wide"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </span>
                  </button>

                </div>
              ))}
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={onOpen}
                  className="py-1 pl-6 text-left text-[11px] text-muted-foreground hover:text-foreground"
                >
                  +{hidden} more {hidden === 1 ? 'message' : 'messages'}
                  {pending ? ' · still reading' : ''}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center gap-2 pt-1 pl-[36px] text-[11px] text-muted-foreground">
            {unread > 0 ? (
              <span>
                <span className="font-medium tabular-nums text-foreground/80">{unread}</span>{' '}
                {unread === 1 ? 'message' : 'messages'}
              </span>
            ) : null}
            {requests > 0 ? (
              <span>
                <span className="font-medium tabular-nums text-foreground/80">{requests}</span>{' '}
                {requests === 1 ? 'request' : 'requests'}
              </span>
            ) : null}
            <span>
              <span className="font-medium tabular-nums text-foreground/80">{comments}</span> comments
            </span>
            <span>
              <span className="font-medium tabular-nums text-foreground/80">{notes}</span> notes
            </span>
            <button
              type="button"
              onClick={onOpen}
              className="ml-auto flex items-center gap-1 rounded font-medium text-highlight outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open
              <ArrowRight className="size-3" />
            </button>
          </div>
          </div>
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={items.length === 0} onSelect={onMarkAllRead}>
          <CheckCheck />
          Mark all as read
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export default HomeSessionCard;
