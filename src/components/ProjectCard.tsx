import * as React from 'react';
import { motion } from 'motion/react';
import { Box, Plus, Trash2 } from 'lucide-react';
import { blobStripLayout } from '@/lib/projectGroups';
import { ARCHIVE_AGE_OPTIONS, bulkArchiveTargets } from '@/lib/bulkArchive';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionContextMenuContent } from './SessionRow';
import ProjectCleanupMenu from './ProjectCleanupMenu';
import { SessionBlob, SessionBlobStrip } from './SessionBlobStrip';
import { sessionKey } from '../types';
import type { AvatarIdentity, BallMood, BlobStyle, Project, Session } from '../types';

// The rail is 320px wide; strip sits inside px-1.5 rail + px-2 card padding.
const STRIP_WIDTH = 280;
// Each blob carries its title as a two-line chip beneath it (hard-clipped — no ellipsis).
const LABEL_WIDTH = 56;

type Props = {
  project: Project;
  instanceId: string;
  instanceLabel: string | undefined;
  markerColor: number | undefined;
  sessions: Session[];
  moods: Record<string, BallMood>;
  /** Session keys shown as workspace columns; each visible blob gets an underline. */
  visibleKeys: Set<string>;
  avatarIdentities: Record<string, AvatarIdentity>;
  blobStyle: BlobStyle;
  reloadingKeys: Set<string>;
  archivingKeys: Set<string>;
  /** Opens every session in this project (most recent as columns, the rest as tabs). */
  onOpenProject: () => void;
  /** Opens just the clicked session, adding it to the current workspace. */
  onOpenSession: (session: Session) => void;
  onNewAgent: (instanceId: string, directory?: string) => void;
  onReload: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  /** Bulk archive from the `+N` menu; one notice/undo covers the whole batch. */
  onArchiveMany: (sessions: Session[]) => void;
  onCustomizeAppearance: (session: Session) => void;
  /** Right-click "Mark all as read" on a blob's session. */
  onMarkAllRead?: (session: Session) => void;
  /** Session keys Home says have unread messages; enables that menu item. */
  unreadKeys?: Set<string>;
  /** Width the blob strip may use: wider when the rail is expanded, so the blobs spread out. */
  stripWidth?: number;
};

const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;

/**
 * A project with two or more sessions: its name, a `+` that starts a session in that project's
 * directory, and a strip of mood-carrying blobs. Clicking the project name/body opens every
 * session (most recent as columns, the rest as tabs); clicking an individual blob opens just that
 * session, adding it to the current workspace. Right-clicking a blob still offers the per-session
 * menu. One-session projects use a plain row.
 */
export default function ProjectCard({
  project,
  instanceId,
  instanceLabel,
  markerColor,
  sessions,
  moods,
  visibleKeys,
  avatarIdentities,
  blobStyle,
  reloadingKeys,
  archivingKeys,
  onOpenProject,
  onOpenSession,
  onNewAgent,
  onReload,
  onArchive,
  onArchiveMany,
  onCustomizeAppearance,
  onMarkAllRead,
  unreadKeys,
  stripWidth = STRIP_WIDTH,
}: Props) {
  const layout = blobStripLayout(sessions.length, stripWidth, 48, 30, 4, LABEL_WIDTH);
  const visible = sessions.slice(0, layout.visible);
  // Recomputed per render so the menu's counts stay current with the session list.
  const inactiveTargets = bulkArchiveTargets(sessions, moods, { now: Date.now() });

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.16 } }}
      transition={spring}
      role="button"
      tabIndex={0}
      aria-label={`Open ${project.name}`}
      onClick={onOpenProject}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenProject();
        }
      }}
      className="cursor-pointer rounded-lg border bg-card/40 px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-highlight"
    >
      <div className="flex items-center gap-1.5 px-1">
        <span
          className="min-w-0 truncate text-[11.5px] font-semibold text-foreground"
          style={markerColor === undefined ? undefined : {
            textDecoration: 'underline',
            textDecorationColor: `var(--instance-marker-${markerColor})`,
            textDecorationThickness: '2px',
            textUnderlineOffset: '3px',
          }}
        >
          {project.name}
        </span>
        {instanceLabel ? (
          <span className="flex min-w-0 items-center gap-0.5 text-[10px] text-muted-foreground">
            <Box className="size-2.5 flex-none" aria-hidden="true" />
            <span className="truncate">{instanceLabel}</span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onNewAgent(instanceId, project.path);
              }}
              aria-label={`New session in ${project.name}`}
              className="ml-auto flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">New session in {project.name}</TooltipContent>
        </Tooltip>
        <ProjectCleanupMenu name={project.name} sessions={sessions} moods={moods} onArchiveMany={onArchiveMany} />
      </div>
      <SessionBlobStrip>
        {visible.map((session) => {
          const key = sessionKey(session);
          return (
            <ContextMenu key={key}>
              <ContextMenuTrigger asChild>
                <SessionBlob
                  session={session}
                  size={layout.size}
                  blobStyle={blobStyle}
                  identity={avatarIdentities[key]}
                  mood={moods[key] ?? 'unknown'}
                  active={visibleKeys.has(key)}
                  onOpen={() => onOpenSession(session)}
                />
              </ContextMenuTrigger>
              <SessionContextMenuContent
                session={session}
                reloading={reloadingKeys.has(key)}
                archiving={archivingKeys.has(key)}
                onReload={onReload}
                onArchive={onArchive}
                onCustomizeAppearance={onCustomizeAppearance}
                onMarkAllRead={onMarkAllRead}
                hasUnread={unreadKeys?.has(key)}
              />
            </ContextMenu>
          );
        })}

        {layout.overflow > 0 ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <span
                className="flex-none cursor-context-menu text-[12px] tabular-nums text-muted-foreground"
                title={`${layout.overflow} more — right-click to tidy up`}
                aria-label={`${layout.overflow} more sessions`}
              >
                +{layout.overflow}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel className="text-[11px] text-muted-foreground">
                Tidy up {project.name}
              </ContextMenuLabel>
              <ContextMenuItem
                disabled={inactiveTargets.length === 0}
                onSelect={() => onArchiveMany(inactiveTargets)}
              >
                <Trash2 />
                Archive {inactiveTargets.length} inactive
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuLabel className="text-[11px] text-muted-foreground">Older than…</ContextMenuLabel>
              {ARCHIVE_AGE_OPTIONS.map((option) => {
                const targets = bulkArchiveTargets(sessions, moods, {
                  olderThanHours: option.hours,
                  now: Date.now(),
                });
                return (
                  <ContextMenuItem
                    key={option.label}
                    disabled={targets.length === 0}
                    onSelect={() => onArchiveMany(targets)}
                  >
                    <span>{option.label}</span>
                    <span className="ml-auto pl-3 tabular-nums text-muted-foreground">{targets.length}</span>
                  </ContextMenuItem>
                );
              })}
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        {sessions.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No sessions</span>
        ) : null}
      </SessionBlobStrip>
    </motion.div>
  );
}
