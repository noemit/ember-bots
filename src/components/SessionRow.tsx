import { useAvatarSize } from '../blob/size';
import ProcessIndicator from './ProcessIndicator';
import * as React from 'react';
import { motion } from 'motion/react';
import { AlarmClock, AlarmClockOff, Eye, Bell, BellOff, CalendarClock, CheckCheck, Layers, Loader2, Palette, Play, Plus, RefreshCw, Sparkles, EyeOff } from 'lucide-react';
import Blob from '../blob/Blob';
import ProjectCleanupMenu from './ProjectCleanupMenu';
import RailDescription from './RailDescription';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { sessionKey } from '../types';
import type { ScheduledTask } from '../api';
import type { AvatarIdentity, BallMood, BlobStyle, Session } from '../types';

export { RelativeTime } from './RailDescription';

const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;

export type SessionRowProps = {
  session: Session;
  onArchiveMany?: (sessions: Session[]) => void;
  instanceLabel: string | undefined;
  projectName: string | undefined;
  preview: string | undefined;
  selected: boolean;
  /** True while the session is a workspace column; an underline under the blob marks it. */
  visibleColumn?: boolean;
  mood: BallMood;
  reloading: boolean;
  archiving: boolean;
  markerColor: number | undefined;
  identity: AvatarIdentity | undefined;
  blobStyle: BlobStyle;
  /** Compact rail row: smaller blob, no preview line. */
  compact?: boolean;
  /**
   * The rail is widened: retain descriptions even when compact rows are enabled.
   */
  expanded?: boolean;
  /** Overrides the title text; used by a one-session project row to show the project name. */
  titleOverride?: string;
  /** Shown as a small line above the title (e.g. "Project · instance"); moves it out of the meta row. */
  topMeta?: React.ReactNode;
  /** When set, renders a `+` that starts a new session in the row's project. */
  onNewAgent?: () => void;
  /** The scheduled task this session is the latest run of, when the row is in the scheduled view. */
  scheduledTask?: ScheduledTask;
  scheduledRunning?: boolean;
  onRunScheduledTask?: (task: ScheduledTask) => void;
  onChangeScheduledTaskModel?: (task: ScheduledTask) => void;
  onSelect: (session: Session) => void;
  onReload: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  onCustomizeAppearance: (session: Session) => void;
  /** Start or extend a group with this session (right-click menu). */
  onGroupWith?: (session: Session) => void;
  /** Right-click "Mark all as read": offered for a session Home says has unread messages. */
  onMarkAllRead?: (session: Session) => void;
  hasUnread?: boolean;
  /** Rail placement only: never changes reading, notifications or host state. */
  snoozed?: boolean;
  onSnooze?: (session: Session, snoozed: boolean) => void;
  /** True when the session is set to "New Messages: Don't Notify" (`readMark.quiet`). */
  quiet?: boolean;
  /** Toggle "New Messages: Don't Notify" vs "Notify" for this session. */
  onQuietChange?: (session: Session, quiet: boolean) => void;
};

type SessionMenuProps = {
  session: Session;
  reloading: boolean;
  archiving: boolean;
  scheduledTask?: ScheduledTask;
  scheduledRunning?: boolean;
  onRunScheduledTask?: (task: ScheduledTask) => void;
  onChangeScheduledTaskModel?: (task: ScheduledTask) => void;
  onReload: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  onCustomizeAppearance: (session: Session) => void;
  /** Start or extend a group with this session (right-click menu). */
  onGroupWith?: (session: Session) => void;
  onMarkAllRead?: (session: Session) => void;
  hasUnread?: boolean;
  snoozed?: boolean;
  onSnooze?: (session: Session, snoozed: boolean) => void;
  quiet?: boolean;
  onQuietChange?: (session: Session, quiet: boolean) => void;
};

/** The reload/customize/archive menu shared by full rows and project-card blobs. */
export const SessionContextMenuContent = ({
  session,
  reloading,
  archiving,
  scheduledTask,
  scheduledRunning,
  onRunScheduledTask,
  onChangeScheduledTaskModel,
  onReload,
  onArchive,
  onCustomizeAppearance,
  onGroupWith,
  onMarkAllRead,
  hasUnread,
  quiet,
  onQuietChange,
  snoozed,
  onSnooze,
}: SessionMenuProps) => {
  const archived = Boolean(session.archived);
  const archiveLabel = archived ? 'Unhide session' : 'Hide session';
  const archiveBusyLabel = archived ? 'Unhiding…' : 'Hiding…';
  // Session visibility is reversible, not deletion: a closed eye hides, an open eye unhides.
  const ArchiveIcon = archived ? Eye : EyeOff;
  return (
    <ContextMenuContent onPointerUpCapture={event => {
      // A menu near the bottom edge can open upward under the pointer. Releasing the
      // right click that opened it must not silently choose the item now beneath it.
      if (event.button !== 0) { event.preventDefault(); event.stopPropagation(); }
    }}>
      {(onMarkAllRead && hasUnread) || onQuietChange ? (
        <>
          {onMarkAllRead && hasUnread ? (
            <ContextMenuItem onSelect={() => onMarkAllRead(session)}>
              <CheckCheck />
              Mark all as read
            </ContextMenuItem>
          ) : null}
          {onQuietChange ? (
            <ContextMenuItem onSelect={() => onQuietChange(session, !quiet)}>
              {quiet ? <Bell /> : <BellOff />}
              {quiet ? 'New Messages: Notify' : "New Messages: Don't Notify"}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
        </>
      ) : null}
      {onSnooze && !archived && session.kind !== 'worker' ? (
        <ContextMenuItem onSelect={() => onSnooze(session, !snoozed)}>
          {snoozed ? <AlarmClockOff /> : <AlarmClock />}
          {snoozed ? 'Unsnooze session' : 'Snooze session'}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem disabled={reloading} onSelect={() => onReload(session)}>
        <RefreshCw className={cn(reloading && 'animate-spin')} />
        {reloading ? 'Reloading…' : 'Reload session'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCustomizeAppearance(session)}>
        <Palette />
        Customize appearance…
      </ContextMenuItem>
      {onGroupWith ? (
        <ContextMenuItem onSelect={() => onGroupWith(session)}>
          <Layers />
          Group with…
        </ContextMenuItem>
      ) : null}
      {scheduledTask ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={scheduledRunning}
            onSelect={() => onRunScheduledTask?.(scheduledTask)}
          >
            {scheduledRunning ? <Loader2 className="animate-spin" /> : <Play />}
            {scheduledRunning ? 'Starting…' : 'Run scheduled task now'}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onChangeScheduledTaskModel?.(scheduledTask)}>
            <Sparkles />
            Change model &amp; run…
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={archiving} onSelect={() => onArchive(session, !archived)}>
        {archiving ? <Loader2 className="animate-spin" /> : <ArchiveIcon />}
        {archiving ? archiveBusyLabel : archiveLabel}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};

/** One rail row. Memoized: the rail re-renders on every poll, most rows don't change. */
const SessionRow = React.memo(function SessionRow({
  session,
  onArchiveMany,
  instanceLabel,
  projectName,
  preview,
  selected,
  visibleColumn,
  mood,
  reloading,
  archiving,
  markerColor,
  identity,
  blobStyle,
  compact = false,
  expanded = false,
  titleOverride,
  topMeta,
  onNewAgent,
  scheduledTask,
  scheduledRunning,
  onRunScheduledTask,
  onChangeScheduledTaskModel,
  onSelect,
  onReload,
  onArchive,
  onCustomizeAppearance,
  onGroupWith,
  onMarkAllRead,
  hasUnread,
  quiet,
  onQuietChange,
  snoozed,
  onSnooze,
}: SessionRowProps) {
  const key = sessionKey(session);
  // Blank is not a title: a `''` (or whitespace) title used to win the `??` chain and render an
  // empty row, which reads as a broken session rather than an untitled one.
  const title = titleOverride?.trim() || session.title?.trim() || session.id;
  // Per row, not per view: the selected session is pinned into the active list even when
  // it's archived, and its button must offer "Unhide" rather than hiding it again.
  const avatarSize = useAvatarSize(compact ? 40 : 55);
  const archived = Boolean(session.archived);
  const archiveLabel = archived ? 'Unhide session' : 'Hide session';
  const archiveBusyLabel = archived ? 'Unhiding…' : 'Hiding…';
  const ArchiveIcon = archived ? Eye : EyeOff;
  const actionsAlwaysVisible = Boolean(archiving || scheduledRunning || onArchiveMany);
  const actionSpace = 26 * (1 + Number(Boolean(onNewAgent)) + Number(Boolean(scheduledTask)) + Number(Boolean(onArchiveMany)) + Number(Boolean(onSnooze && !archived))) + 8;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.16 } }}
      transition={spring}
      className="group relative"
      style={{ '--rail-action-space': `${actionSpace}px` } as React.CSSProperties}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <motion.button
            type="button"
            whileTap={{ scale: 0.985 }}
            data-selected={selected}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(session)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-150',
              compact ? 'py-1.5' : 'py-2',
              selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <div
              className="relative mt-[7px]"
              data-session-key={key}
              data-visible-column={visibleColumn ? 'true' : undefined}
            >
              {/* Project/task/session identity is resolved once in App so every surface stays aligned,
                  including across instances that reuse session ids. */}
              <Blob style={blobStyle} seed={key} identity={identity} size={avatarSize} mood={mood} />
              <ProcessIndicator session={session} overlay />
              {visibleColumn ? (
                <span
                  data-column-underline
                  aria-hidden="true"
                  className="pointer-events-none absolute -bottom-1.5 left-1/2 h-[3px] w-7 -translate-x-1/2 rounded-full bg-highlight"
                />
              ) : null}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* Actions share only the metadata band. Its reserved height also protects rows
                  without metadata, while the title and description keep their full width on hover. */}
              <div data-rail-heading="" className="flex min-h-[30px] min-w-0 items-center pr-[var(--rail-action-space)]">
                {topMeta ? (
                  <span className="flex min-w-0 items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground">
                    {topMeta}
                  </span>
                ) : null}
              </div>
              <div data-rail-title-row="" className="flex min-w-0 items-baseline gap-2">
                {snoozed ? <span className="flex-none text-[10px] text-muted-foreground">Snoozed</span> : null}
                {/* A run the scheduler started is an ordinary session; this mark is the only thing
                    that says so, and the tooltip names the task so it can be found in the rail's
                    own Scheduled section. */}
                {scheduledTask ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CalendarClock
                        className="size-3 flex-none text-muted-foreground"
                        aria-label={`Started by the scheduled task ${scheduledTask.name}`}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[240px]">
                      <span className="block">This was triggered by a scheduled task.</span>
                      <span className="block text-muted-foreground">{scheduledTask.name}</span>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <span
                  data-session-title=""
                  data-instance-marker={markerColor}
                  title={title}
                  className="min-w-0 flex-1 line-clamp-2 text-[13px] leading-[18px] font-medium text-foreground [overflow-wrap:anywhere]"
                  style={markerColor === undefined ? undefined : {
                    textDecoration: 'underline',
                    textDecorationColor: `var(--instance-marker-${markerColor})`,
                    textDecorationThickness: '2px',
                    textUnderlineOffset: '3px',
                  }}
                >
                  {title}
                </span>
              </div>
              <RailDescription preview={preview} timestamp={session.updated} directory={session.directory} compact={compact && !expanded} />
              {mood === 'input' || mood === 'question' || mood === 'error' || (!topMeta && (projectName || instanceLabel)) ? (
                <span className="flex items-center gap-1 truncate text-[10.5px] text-muted-foreground">
                  {mood === 'input' || mood === 'question' ? (
                    <Badge variant="outline" className="flex-none border-highlight/40 px-1 py-0 text-[10px] font-medium text-highlight">
                      Needs input
                    </Badge>
                  ) : mood === 'error' ? (
                    <Badge variant="outline" className="flex-none border-destructive/40 px-1 py-0 text-[10px] font-medium text-destructive">
                      Failed
                    </Badge>
                  ) : null}
                  {!topMeta &&
                  (mood === 'input' || mood === 'question' || mood === 'error') &&
                  (projectName || instanceLabel) ? (
                    <span aria-hidden>·</span>
                  ) : null}
                  {!topMeta && instanceLabel ? (
                    <>
                      <span className="truncate">{instanceLabel}</span>
                      {projectName ? <span aria-hidden>·</span> : null}
                    </>
                  ) : null}
                  {!topMeta && projectName ? <span className="truncate">{projectName}</span> : null}
                </span>
              ) : null}
            </div>
          </motion.button>
        </ContextMenuTrigger>
        <SessionContextMenuContent
          session={session}
          reloading={reloading}
          archiving={archiving}
          scheduledTask={scheduledTask}
          scheduledRunning={scheduledRunning}
          onRunScheduledTask={onRunScheduledTask}
          onChangeScheduledTaskModel={onChangeScheduledTaskModel}
          onReload={onReload}
          onArchive={onArchive}
          onCustomizeAppearance={onCustomizeAppearance}
          onGroupWith={onGroupWith}
          onMarkAllRead={onMarkAllRead}
          hasUnread={hasUnread}
          quiet={quiet}
          onQuietChange={onQuietChange}
          snoozed={snoozed}
          onSnooze={onSnooze}
        />
      </ContextMenu>

      <div
        data-rail-actions=""
        className={cn(
          'absolute top-1.5 right-2 z-20 flex items-center gap-0.5 rounded-md border bg-card p-0.5 shadow-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
          actionsAlwaysVisible ? 'opacity-100' : 'opacity-0 [@media(pointer:coarse)]:opacity-100 [@media(hover:none)]:opacity-100'
        )}
      >
        {onSnooze && !archived && session.kind !== 'worker' ? (
          <Button variant="ghost" size="icon-xs" aria-label={snoozed ? 'Unsnooze session' : 'Snooze session'}
            title={snoozed ? 'Unsnooze session' : 'Snooze session'}
            onClick={() => onSnooze(session, !snoozed)}>
            {snoozed ? <AlarmClockOff /> : <AlarmClock />}
          </Button>
        ) : null}
        {onArchiveMany ? <ProjectCleanupMenu name={title} sessions={[session]} moods={{ [key]: mood }} onArchiveMany={onArchiveMany} /> : null}
        {onNewAgent ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New session in ${titleOverride ?? 'project'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onNewAgent();
                }}
                className="text-muted-foreground"
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">New session in {titleOverride ?? 'project'}</TooltipContent>
          </Tooltip>
        ) : null}

        {scheduledTask ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={scheduledRunning}
                aria-label={scheduledRunning ? 'Starting scheduled task…' : 'Run scheduled task now'}
                onClick={(event) => {
                  event.stopPropagation();
                  onRunScheduledTask?.(scheduledTask);
                }}
                className="text-muted-foreground"
              >
                {scheduledRunning ? <Loader2 className="animate-spin" /> : <Play />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {scheduledRunning ? 'Starting…' : `Run ${scheduledTask.name} now`}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={archiving}
              aria-label={archiving ? archiveBusyLabel : archiveLabel}
              onClick={(event) => {
                event.stopPropagation();
                onArchive(session, !archived);
              }}
            >
              {archiving ? <Loader2 className="animate-spin" /> : <ArchiveIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{archiving ? archiveBusyLabel : archiveLabel}</TooltipContent>
        </Tooltip>
      </div>
    </motion.div>
  );
});

export default SessionRow;
