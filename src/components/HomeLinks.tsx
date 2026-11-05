import * as React from 'react';
import { ExternalLink, FileText, FolderOpen, Link2, MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RelativeTime } from './SessionRow';
import type { SharedLink, SharedLinkKind } from '../lib/sharedLinks';

type Props = {
  links: SharedLink[];
  /** A session's title, for the "which conversation" line. */
  sessionLabel: (key: string) => string;
  /** Open the session at the message that mentioned this link. */
  onOpenContext: (link: SharedLink) => void;
};

const kindLabel: Record<SharedLinkKind, string> = {
  app: 'App',
  report: 'Report',
  page: 'Page',
  file: 'File',
};

const kindIcon: Record<SharedLinkKind, React.ComponentType<{ className?: string }>> = {
  app: ExternalLink,
  report: FileText,
  page: Link2,
  file: FolderOpen,
};

/**
 * The right column: things sessions handed over — a staging page, a report, a running app, a file.
 *
 * A link opens the same way a transcript link does (`openExternal`, which reveals a local path and
 * opens a URL in the browser), and the context bar underneath says where it came from and goes back
 * to the words: the session, a quote of the message, and a jump straight to it. Rows are draggable,
 * so a link can go into another app without a click.
 */
export default function HomeLinks({ links, sessionLabel, onOpenContext }: Props) {
  return (
    <aside
      aria-label="Links shared by sessions"
      data-testid="home-links"
      className="flex min-h-0 w-full flex-col"
    >
      <div className="flex items-baseline gap-2 px-3 pb-1.5 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Links</h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">{links.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-4">
        {links.map((link) => {
          const Icon = kindIcon[link.kind];
          const source = sessionLabel(link.sessionKey);
          return (
            <div
              key={link.url}
              data-testid="home-link"
              data-link-kind={link.kind}
              className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card/60"
            >
              <button
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/uri-list', link.url);
                  event.dataTransfer.setData('text/plain', link.url);
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => void window.ember.openExternal(link.url)}
                title={link.url}
                className="flex min-w-0 flex-col gap-1 px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
              >
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <Icon className="size-3" />
                  {kindLabel[link.kind]}
                  <RelativeTime timestamp={link.at} className="ml-auto normal-case tabular-nums" />
                </span>
                <span className="truncate text-[12px] font-medium text-foreground">{link.title}</span>
                <span className="truncate text-[11px] text-muted-foreground">{link.url}</span>
              </button>

              {/* The context bar: where it was said, and the way back to that message. */}
              <button
                type="button"
                onClick={() => onOpenContext(link)}
                data-testid="home-link-context"
                data-session-key={link.sessionKey}
                data-message-id={link.messageId}
                title={`Open ${source} at the message that shared ${link.title}`}
                className={cn(
                  'flex min-w-0 flex-col gap-0.5 border-t bg-muted/30 px-2.5 py-1.5 text-left',
                  'transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                )}
              >
                <span className="flex items-center gap-1 truncate text-[10.5px] font-medium text-muted-foreground">
                  <MessageSquareText className="size-3 flex-none" />
                  <span className="truncate">{source}</span>
                  <span className="ml-auto flex-none text-highlight">
                    {link.messageId ? 'Jump to message' : 'Open session'}
                  </span>
                </span>
                {link.context ? (
                  <span className="line-clamp-2 text-[11px] leading-[1.4] text-foreground/70">
                    {link.context}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
