import { NotificationSizeContext } from '../blob/overlays';
import RailItem from './RailItem';
import ComposerIdentity from './ComposerIdentity';
import { useWorkspaceConnection } from './workspaceConnection';
import { AvatarTransitionContext } from '../blob/AvatarTransition';
import { motion } from 'motion/react';
import { useAvatarSize } from '../blob/size';
import ProcessIndicator from './ProcessIndicator';
import * as React from 'react';
import { AnimatePresence, LayoutGroup } from 'motion/react';
import {
  Box,
  ChevronDown,
  Plus,
  RefreshCw,
  Search,
  Settings,
  EyeOff,
  X,
} from 'lucide-react';
import { normalizeDirectory, projectForSession, projectIdentityKey } from '../blob/seed';
import { cn } from '@/lib/utils';
import Blob from '../blob/Blob';
import { useStableCallback } from '@/lib/useStableCallback';
import { groupNewAgentTarget } from '@/lib/railStrip';
import { endpointState, instanceReady, outageCopy, railEmptyCopy, type SilentInstance } from '@/lib/instanceHealth';
import {
  buildRailEntries,
  groupDraftFromEntry,
  type GroupEntry,
  type ProjectEntry,
  type RailEntry,
} from '@/lib/projectGroups';
import { instanceMarkerColor } from '../lib/instanceMarker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ProjectCard from './ProjectCard';
import GroupRow from './GroupRow';
import SessionRow, { SessionContextMenuContent } from './SessionRow';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { sessionKey } from '../types';
import type { ScheduledTask } from '../api';
import type {
  AvatarIdentity,
  BallMood,
  BlobStyle,
  Instance,
  InstanceDefaults,
  Project,
  RailMode,
  Session,
  SessionGroup,
} from '../types';

type Props = {
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  instanceDefaults: Record<string, InstanceDefaults>;
  sessions: Session[];
  /** Every session (active and archived, ignoring the recency window) for broadened search. */
  everySession: Session[];
  moods: Record<string, BallMood>;
  previews: Record<string, string>;
  selectedKey: string | null;
  avatarIdentities: Record<string, AvatarIdentity>;
  blobStyle: BlobStyle;
  /** The session list's width: a blob dock, the familiar rail, or about half the window. */
  mode: RailMode;
  /** Compact session rows: smaller blobs, no preview line. */
  compact: boolean;
  loading: boolean;
  /**
   * The honest one-liner for a launch still coming up ("Connecting to Hearth and loading your
   * sessions…"), or null once there is nothing left to wait for. Derived by `startupNotice` so the
   * wording is testable rather than scattered through JSX.
   */
  startupMessage: string | null;
  /**
   * Configured hosts that are not answering, each with the sessions Ember still lists from its last
   * answer (`silentInstances` in `lib/instanceHealth`). One row each, above the sessions, because
   * the alternative — subtracting those sessions from the rail — is indistinguishable from deletion.
   */
  silentInstances: SilentInstance[];
  /** Reprobe every configured instance (what the outage rows' Retry button runs). */
  onRetryInstances: () => void;
  /**
   * "I know, stop telling me" for one host's outage. Only the warning goes away: that host's
   * last-known sessions stay exactly where they are, and nothing on the host is touched.
   */
  onDismissOutage: (entry: SilentInstance) => void;
  /** A probe is already in flight, so the outage rows' Retry shows a spinner instead of a second run. */
  retryingInstances: boolean;
  mobileOpen: boolean;
  reloadingKeys: Set<string>;
  archivingKeys: Set<string>;
  /** Session keys currently rendered as workspace columns; each gets an underline on its blob. */
  visibleColumnKeys: Set<string>;
  /** The currently open session, if any. Pinned to the rail when filters hide it. */
  selectedSession: Session | null;
  /** Human label for the recency window ("Last 2 days"), or null when everything is shown. */
  windowLabel: string | null;
  /** Session key → scheduled task, for the run/model actions on a task's run rows. */
  scheduledTaskBySession: Record<string, ScheduledTask>;
  runningScheduledKeys: Set<string>;
  onRunScheduledTask: (task: ScheduledTask) => void;
  onChangeScheduledTaskModel: (task: ScheduledTask) => void;
  /** Hidden sessions across instances; opens the archive screen. */
  onOpenArchive: () => void;
  onSelectSession: (session: Session) => void;
  /** Opens a project's sessions (those shown on its card) as the open list. */
  onOpenProject: (instanceId: string, project: Project, sessions: Session[]) => void;
  onOpenSession: (session: Session) => void;
  onReload: (session: Session) => void;
  onArchive: (session: Session, archived: boolean) => void;
  /** Bulk archive a project's sessions from the card's `+N` menu. */
  onArchiveMany: (sessions: Session[]) => void;
  onCustomizeAppearance: (session: Session) => void;
  /** Right-click "Mark all as read" for a session with unread messages. */
  onMarkAllRead?: (session: Session) => void;
  /** Session keys with unread messages, derived from explicit read marks. */
  unreadKeys?: Set<string>;
  /** Session keys set to "New Messages: Don't Notify". */
  quietKeys?: Set<string>;
  /** Toggle "New Messages: Don't Notify" vs "Notify" for a session. */
  onQuietChange?: (session: Session, quiet: boolean) => void;
  onNewAgent: (instanceId: string, directory?: string) => void;
  /** Agent groups, already parsed; the rail draws them above projects. */
  groups: SessionGroup[];
  onOpenGroup: (members: Session[]) => void;
  onUngroup: (groupId: string) => void;
  /** Open the group panel for a group, or start one from a session. */
  onManageGroup: (draft: { id?: string; name: string; keys: string[]; primaryKey?: string }) => void;
  onOpenSettings: () => void;
  onRenameSession: (session: Session, title: string) => void;
};

/** No-op for callers that render the rail without read state (tests, the archive screen). */
const NO_MARKS = (_session: Session): void => {};

const matchesQuery = (haystack: Array<string | undefined>, query: string): boolean =>
  haystack.some((value) => value?.toLowerCase().includes(query));

export default function LeftRail({
  instances,
  projectsByInstance,
  instanceDefaults,
  sessions,
  everySession,
  moods,
  previews,
  selectedKey,
  avatarIdentities,
  blobStyle,
  compact,
  mode,
  loading,
  startupMessage,
  silentInstances,
  onRetryInstances,
  onDismissOutage,
  retryingInstances,
  mobileOpen,
  reloadingKeys,
  archivingKeys,
  visibleColumnKeys,
  selectedSession,
  windowLabel,
  scheduledTaskBySession,
  runningScheduledKeys,
  onRunScheduledTask,
  onChangeScheduledTaskModel,
  onOpenArchive,
  onSelectSession,
  onOpenProject,
  onOpenSession,
  onReload,
  onArchive,
  onArchiveMany,
  onCustomizeAppearance,
  onMarkAllRead,
  unreadKeys,
  quietKeys,
  onQuietChange,
  onNewAgent,
  groups,
  onOpenGroup,
  onUngroup,
  onManageGroup,
  onOpenSettings,
  onRenameSession,
}: Props) {
  const composerConnection = useWorkspaceConnection();
  const docked = Boolean(composerConnection.activeKey && selectedSession);
  const scroller = React.useRef<HTMLDivElement>(null);
  const dockElement = React.useRef<HTMLDivElement>(null);
  const focusDock = React.useRef(false);
  const followBottom = React.useRef(true);
  React.useLayoutEffect(() => {
    if (docked && focusDock.current) { dockElement.current?.focus({ preventScroll: true }); focusDock.current = false; }
  }, [docked, selectedKey]);
  const [query, setQuery] = React.useState('');
  // Search starts scoped to the current view; the empty state can widen it to all time/archived.
  const [searchAllTime, setSearchAllTime] = React.useState(false);
  const [searchArchived, setSearchArchived] = React.useState(false);

  React.useEffect(() => {
    if (query) return;
    // Clearing the box returns the next search to the default scope.
    setSearchAllTime(false);
    setSearchArchived(false);
  }, [query]);

  const instanceById = React.useMemo(
    () => Object.fromEntries(instances.map((instance) => [instance.id, instance])),
    [instances]
  );
  const ready = React.useMemo(() => instances.filter(instanceReady), [instances]);
  const multiInstance = ready.length > 1;
  const connection = React.useMemo(() => endpointState(instances), [instances]);
  const needle = query.trim().toLowerCase();

  const activeEverywhere = React.useMemo(
    () => everySession.filter((session) => !session.archived),
    [everySession]
  );
  const archivedEverywhere = React.useMemo(
    () => everySession.filter((session) => session.archived),
    [everySession]
  );

  // The selected session is pinned into the rail even when a filter would hide it.
  const itemSessions = React.useMemo(
    () =>
      selectedSession && !sessions.some((session) => sessionKey(session) === sessionKey(selectedSession))
        ? [...sessions, selectedSession]
        : sessions,
    [sessions, selectedSession]
  );

  const entries = React.useMemo(
    () => buildRailEntries(itemSessions.filter(session => !docked || sessionKey(session) !== selectedKey), projectsByInstance, groups).sort((a, b) => a.updated - b.updated || a.id.localeCompare(b.id)),
    [itemSessions, projectsByInstance, groups, docked, selectedKey]
  );

  const matchesSession = React.useCallback(
    (session: Session) => {
      // A session is also found by its group's name: the group is what the user named, and a
      // search for "release" that hides the group's sessions makes the group look empty.
      const groupName = groups.find((group) => group.keys.includes(sessionKey(session)))?.name;
      return matchesQuery(
        [
          session.title,
          session.id,
          previews[sessionKey(session)],
          session.directory,
          instanceById[session.instanceId]?.label,
          projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name,
          groupName,
        ],
        needle
      );
    },
    [previews, instanceById, projectsByInstance, needle, groups]
  );

  // Search pools: active matches keep the project grouping; archived matches stay individual rows.
  const activeMatches = React.useMemo(() => {
    if (!needle) return [];
    const pool = searchAllTime ? activeEverywhere : itemSessions;
    return pool.filter(matchesSession);
  }, [needle, searchAllTime, activeEverywhere, itemSessions, matchesSession]);

  const archivedMatches = React.useMemo(() => {
    if (!needle || !searchArchived) return [];
    return archivedEverywhere.filter(matchesSession);
  }, [needle, searchArchived, archivedEverywhere, matchesSession]);

  const railEntries = React.useMemo(() => {
    if (!needle) return entries;
    // `groups` in, so a matching group keeps its card and its members stay inside it (they are
    // grouped sessions: buildRailEntries would otherwise make them standalone rows).
    const withSessions = buildRailEntries(activeMatches, projectsByInstance, groups);
    const represented = new Set(
      withSessions
        .filter((entry): entry is ProjectEntry => entry.kind === 'project')
        .map((entry) => entry.id)
    );
    const emptyProjects: ProjectEntry[] = [];
    Object.entries(projectsByInstance).forEach(([instanceId, projects]) => {
      projects.forEach((project) => {
        const id = projectIdentityKey(instanceId, project.id);
        if (represented.has(id)) return;
        if (!matchesQuery([project.name, project.path], needle)) return;
        emptyProjects.push({
          kind: 'project',
          id,
          instanceId,
          project,
          sessions: [],
          updated: 0,
        });
      });
    });
    emptyProjects.sort((a, b) => a.project.name.localeCompare(b.project.name) || a.id.localeCompare(b.id));
    // A group whose name matches but whose members don't is still a real hit (the same courtesy
    // `emptyProjects` gives a project name). It is found by name, so every member must resolve —
    // otherwise the card would claim agents it cannot open.
    const matchedGroups = groups.flatMap((group) => {
      if (!matchesQuery([group.name], needle)) return [];
      const members = group.keys.flatMap((key) => activeMatches.find((session) => sessionKey(session) === key) ?? []);
      if (members.length === 0) return [];
      const sorted = [...members].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
      return [{
        kind: 'group' as const,
        id: group.id,
        name: group.name,
        keys: [...group.keys],
        members: sorted,
        instanceIds: [...new Set(sorted.map((member) => member.instanceId))],
        primaryKey:
          group.primaryKey !== undefined && group.keys.includes(group.primaryKey)
            ? group.primaryKey
            : sessionKey(sorted[0]),
        updated: sorted.length > 0 ? (sorted[0].updated ?? 0) : 0,
      }];
    });
    // Group cards found by name go first, like buildRailEntries' own ordering, then projects.
    return [...matchedGroups, ...withSessions, ...emptyProjects];
  }, [needle, entries, activeMatches, projectsByInstance, groups]);

  React.useLayoutEffect(() => {
    if (followBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [railEntries]);

  const hasItems = railEntries.length > 0 || archivedMatches.length > 0;

  /**
   * The "widen the search" actions: reachable whether or not the current scope already found
   * something. They used to render only inside the empty state, so a search for "audit" that hit
   * one recent session hid the buttons that would reveal the five older and archived matches —
   * the reader was told, by omission, that those did not exist.
   *
   * Each button is offered only when widening would actually add a row.
   */
  const canSearchAllTime =
    Boolean(needle) &&
    !searchAllTime &&
    activeEverywhere.length > activeMatches.length;
  const canSearchArchived =
    Boolean(needle) && !searchArchived && archivedEverywhere.length > 0;
  /** Set while the reader is inside a search, which is what gives these buttons room to breathe. */
  const breadthControls =
    canSearchAllTime || canSearchArchived ? (
      <div
        className={cn('flex flex-col items-stretch gap-1.5', needle ? 'mt-3' : 'mt-2')}
        data-testid="rail-search-breadth"
      >
        {canSearchAllTime ? (
          <Button size="xs" variant="outline" onClick={() => setSearchAllTime(true)}>
            Search all time
          </Button>
        ) : null}
        {canSearchArchived ? (
          <Button size="xs" variant="outline" onClick={() => setSearchArchived(true)}>
            Search hidden sessions
          </Button>
        ) : null}
      </div>
    ) : null;

  /**
   * One row per configured host that is not answering. Deliberately not a session row: no blob, no
   * preview, no archive control — this is a statement about a host, and the sessions below it are
   * the ones that host listed the last time it answered.
   */
  const renderSilentInstance = (entry: SilentInstance) => {
    const copy = outageCopy(entry);
    return (
      <div
        key={`silent:${entry.instanceId}`}
        data-testid="rail-silent-instance"
        className="mx-1 my-1 flex items-start gap-2 rounded-lg border border-dashed bg-muted/40 px-2.5 py-2"
      >
        <span
          aria-hidden="true"
          className="mt-1 size-1.5 flex-none rounded-full bg-muted-foreground/60"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">
              {entry.label}
            </span>
            <span className="flex-none text-[11px] text-muted-foreground">{copy.status}</span>
          </span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
            {copy.detail}
          </span>
        </span>
        {copy.retryable ? (
          <span className="mt-0.5 flex flex-none items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={retryingInstances}
              onClick={onRetryInstances}
              aria-label={`Retry ${entry.label}`}
            >
              {retryingInstances ? (
                <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Retry
            </Button>
            {/* Only on a plain outage: "Sessions unavailable" is a settings problem, and
                dismissing that would hide the very thing that needs fixing. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onDismissOutage(entry)}
                  aria-label={`Stop warning about ${entry.label}`}
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide this warning until this host answers again</TooltipContent>
            </Tooltip>
          </span>
        ) : null}
      </div>
    );
  };

  // Default target for "New agent": whichever instance was active most recently.
  const defaultInstanceId =
    [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).find(
      (session) => instanceById[session.instanceId]?.attachable
    )?.instanceId ??
    ready[0]?.id ??
    null;

  // App passes inline lambdas; pin their identity so the memoized rows actually hold.
  const selectSession = useStableCallback(onSelectSession);
  const openSession = useStableCallback(onOpenSession);
  const reloadSession = useStableCallback(onReload);
  const archiveSession = useStableCallback(onArchive);
  const archiveMany = useStableCallback(onArchiveMany);
  const customizeAppearance = useStableCallback(onCustomizeAppearance);
  const markAllRead = useStableCallback(onMarkAllRead ?? NO_MARKS);
  const newAgent = useStableCallback(onNewAgent);
  const runScheduledTask = useStableCallback(onRunScheduledTask);
  const changeScheduledTaskModel = useStableCallback(onChangeScheduledTaskModel);

  // The header line shown above a row's title: project/folder then instance, so every rail entry
  // is labelled the same way grouped project cards are.
  const folderNameOf = (session: Session): string | undefined =>
    projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name ??
    (session.directory
      ? normalizeDirectory(session.directory).split(/[\\/]/).filter(Boolean).pop()
      : undefined);
  const instanceLabelOf = (session: Session): string | undefined =>
    instanceById[session.instanceId]?.label;
  // Instance name, shown with the same cube glyph as the chat header's instance badge.
  const metadataCache = React.useRef(new Map<string, React.ReactNode>());
  if (metadataCache.current.size > 2000) metadataCache.current.clear();
  const instanceMeta = (label: string): React.ReactNode => {
    const key = `instance:${label}`;
    if (!metadataCache.current.has(key)) metadataCache.current.set(key, (
      <span className="flex min-w-0 items-center gap-0.5">
        <Box className="size-2.5 flex-none" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    ));
    return metadataCache.current.get(key);
  };
  const topMetaFor = (session: Session): React.ReactNode => {
    const folder = folderNameOf(session);
    const instance = instanceLabelOf(session);
    if (!folder && !instance) return undefined;
    const key = JSON.stringify([folder, instance]);
    if (!metadataCache.current.has(key)) metadataCache.current.set(key, (
      <>
        {folder ? <span className="truncate">{folder}</span> : null}
        {folder && instance ? <span aria-hidden>·</span> : null}
        {instance ? instanceMeta(instance) : null}
      </>
    ));
    return metadataCache.current.get(key);
  };

  const renderSession = (session: Session) => {
    const key = sessionKey(session);
    const instance = instanceById[session.instanceId];
    const scheduledTask = scheduledTaskBySession[key];
    return (
      <SessionRow
        key={key}
        session={session}
        instanceLabel={multiInstance ? instance?.label : undefined}
        projectName={projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name}
        topMeta={topMetaFor(session)}
        preview={previews[key]}
        selected={key === selectedKey}
        visibleColumn={visibleColumnKeys.has(key)}
        mood={moods[key] ?? 'unknown'}
        reloading={reloadingKeys.has(key)}
        archiving={archivingKeys.has(key)}
        markerColor={instanceMarkerColor(session.instanceId, instanceDefaults[session.instanceId])}
        identity={avatarIdentities[key]}
        blobStyle={blobStyle}
        compact={compact}
        expanded={mode === 'wide'}
        scheduledTask={scheduledTask}
        scheduledRunning={scheduledTask ? runningScheduledKeys.has(scheduledTask.key) : false}
        onRunScheduledTask={runScheduledTask}
        onChangeScheduledTaskModel={changeScheduledTaskModel}
        onSelect={selectSession}
        onReload={reloadSession}
        onArchive={archiveSession}
        onCustomizeAppearance={customizeAppearance}
        onMarkAllRead={markAllRead}
        hasUnread={unreadKeys?.has(key) ?? false}
        quiet={quietKeys?.has(key) ?? false}
        onQuietChange={onQuietChange}
        onGroupWith={(session) => onManageGroup({ name: '', keys: [sessionKey(session)] })}
        // Every agent gets a plus: the draft opens on this session's instance and folder, both
        // still changeable in its options row before the first message.
        onNewAgent={() => newAgent(session.instanceId, session.directory)}
      />
    );
  };

  const projectNewAgent = React.useRef(new Map<string, () => void>());
  // A group's `+` starts a session on its primary member's instance, in that member's folder — the
  // way the group panel already seeds one — and is left off when no member resolves.
  const groupNewAgent = (entry: GroupEntry): (() => void) | undefined => {
    const target = groupNewAgentTarget(entry.members, entry.primaryKey);
    return target ? () => newAgent(target.instanceId, target.directory) : undefined;
  };
  const renderEntry = (entry: RailEntry) => {
    if (entry.kind === 'session') return renderSession(entry.session);
    // Group rows are built by buildRailEntries but not drawn yet: this step adds the rail pass and
    // its tests, and the row component lands with the Manage group panel.
    if (entry.kind === 'group') {
      return (
        <GroupRow
          key={entry.id}
          entry={entry}
          previews={previews}
          compact={compact && mode !== 'wide'}
          instanceLabels={Object.fromEntries(instances.map((instance) => [instance.id, instance.label]))}
          avatarIdentities={avatarIdentities}
          moods={moods}
          visibleKeys={visibleColumnKeys}
          blobStyle={blobStyle}
          reloadingKeys={reloadingKeys}
          archivingKeys={archivingKeys}
          onOpen={() => onOpenGroup(entry.members)}
          onOpenSession={openSession}
          onNewAgent={groupNewAgent(entry)}
          onReload={reloadSession}
          onArchive={archiveSession}
          onArchiveMany={archiveMany}
          onCustomizeAppearance={customizeAppearance}
          onUngroup={() => onUngroup(entry.id)}
          // The configured keys, not the resolved members (see `groupDraftFromEntry`): a member
          // on an unreachable instance is absent from `members`, and deriving the list from it
          // made saving the panel drop that member for good.
          onManage={() => onManageGroup(groupDraftFromEntry(entry))}
        />
      );
    }
    const instance = instanceById[entry.instanceId];
    const openProject = () => onOpenProject(entry.instanceId, entry.project, entry.sessions);
    const newAgentKey = `${entry.instanceId}\u0000${entry.project.path ?? ''}`;
    if (!projectNewAgent.current.has(newAgentKey)) projectNewAgent.current.set(newAgentKey, () => newAgent(entry.instanceId, entry.project.path));
    // A lone session keeps the familiar full row (big blob, project name as the title); the
    // grouped card is only worth it once a project has several sessions to show off.
    if (entry.sessions.length === 1) {
      const session = entry.sessions[0];
      const key = sessionKey(session);
      return (
        <SessionRow
          key={entry.id}
          session={session}
          instanceLabel={multiInstance ? instance?.label : undefined}
          projectName={undefined}
          titleOverride={entry.project.name}
          onArchiveMany={archiveMany}
          topMeta={instance?.label ? instanceMeta(instance.label) : undefined}
          preview={previews[key]}
          selected={key === selectedKey}
          visibleColumn={visibleColumnKeys.has(key)}
          mood={moods[key] ?? 'unknown'}
          reloading={reloadingKeys.has(key)}
          archiving={archivingKeys.has(key)}
          markerColor={instanceMarkerColor(entry.instanceId, instanceDefaults[entry.instanceId])}
          identity={avatarIdentities[key]}
          blobStyle={blobStyle}
          compact={compact}
          expanded={mode === 'wide'}
          onSelect={openSession}
          onNewAgent={projectNewAgent.current.get(newAgentKey)}
          onReload={reloadSession}
          onArchive={archiveSession}
          onCustomizeAppearance={customizeAppearance}
          onMarkAllRead={markAllRead}
          hasUnread={unreadKeys?.has(key) ?? false}
          quiet={quietKeys?.has(key) ?? false}
          onQuietChange={onQuietChange}
          onGroupWith={(session) => onManageGroup({ name: '', keys: [sessionKey(session)] })}
        />
      );
    }
    return (
      <ProjectCard
        key={entry.id}
        project={entry.project}
        instanceId={entry.instanceId}
        instanceLabel={instance?.label}
        markerColor={instanceMarkerColor(entry.instanceId, instanceDefaults[entry.instanceId])}
        sessions={entry.sessions}
        moods={moods}
        visibleKeys={visibleColumnKeys}
        avatarIdentities={avatarIdentities}
        blobStyle={blobStyle}
        reloadingKeys={reloadingKeys}
        archivingKeys={archivingKeys}
        onOpenProject={openProject}
        onOpenSession={openSession}
        onNewAgent={newAgent}
        onReload={reloadSession}
        onArchive={archiveSession}
        onArchiveMany={archiveMany}
        onCustomizeAppearance={customizeAppearance}
        onMarkAllRead={markAllRead}
        unreadKeys={unreadKeys}
        quietKeys={quietKeys}
        onQuietChange={onQuietChange}
        // The strip gets the extra room the widened rail bought (roughly: half the window, less
        // the rail's own padding), so a project's blobs spread out instead of huddling left.
        stripWidth={mode === 'wide' ? 660 : undefined}
      />
    );
  };

  // Archived search hits are individual rows; clicking one restores it (archived can't stay open).
  const renderArchivedSession = (session: Session) => {
    const key = sessionKey(session);
    const instance = instanceById[session.instanceId];
    return (
      <SessionRow
        key={key}
        session={session}
        instanceLabel={multiInstance ? instance?.label : undefined}
        projectName={projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name}
        preview={previews[key]}
        selected={false}
        mood={moods[key] ?? 'unknown'}
        reloading={reloadingKeys.has(key)}
        archiving={archivingKeys.has(key)}
        markerColor={instanceMarkerColor(session.instanceId, instanceDefaults[session.instanceId])}
        identity={avatarIdentities[key]}
        blobStyle={blobStyle}
        compact={compact}
        expanded={mode === 'wide'}
        onSelect={() => archiveSession(session, false)}
        onReload={reloadSession}
        onArchive={archiveSession}
        onCustomizeAppearance={customizeAppearance}
        onGroupWith={(session) => onManageGroup({ name: '', keys: [sessionKey(session)] })}
      />
    );
  };

  const miniAvatarSize = useAvatarSize(40);

  return (
    <LayoutGroup id="rail-connection"><AvatarTransitionContext.Provider value={docked && !needle}>
    <NotificationSizeContext.Provider value={10}>
    <aside
      id="session-sidebar"
      style={{ '--mini-rail-width': `${miniAvatarSize + 24}px` } as React.CSSProperties}
      data-testid="session-rail"
      onPointerDownCapture={() => { focusDock.current = false; }}
      onKeyDownCapture={event => {
        if (docked && (event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('button')?.querySelector('.blob')) focusDock.current = true;
      }}
      className={cn(
        'mobile-rail fixed left-0 z-40 flex w-[min(88vw,320px)] flex-none flex-col border-r bg-card transition-transform duration-200 md:static md:z-auto md:translate-x-0',
        // Collapsible: the study’s 272px rail, a compact dock, or about half the window so a row can show the
        // latest message. The ceiling keeps the text at a readable measure.
        'md:transition-[width] md:duration-200',
        mode === 'wide' ? 'md:w-[min(50vw,760px)]' : mode === 'mini' ? 'md:w-[var(--mini-rail-width)]' : 'md:w-[272px]',
        mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
      )}
    >
      <div className={cn('flex flex-col gap-2 border-b', mode === 'mini' ? 'items-center p-1.5' : 'p-2.5')}>
        <div className={cn('flex gap-1.5', mode === 'mini' ? 'flex-col items-center' : 'items-center')}>
        {mode === 'mini' ? (
          <div className="flex flex-col items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  disabled={!defaultInstanceId}
                  onClick={() => defaultInstanceId && onNewAgent(defaultInstanceId)}
                  aria-label="New bot"
                  className="size-8"
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New bot</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {mode === 'mini' ? null : multiInstance ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" className="min-w-0 flex-1 justify-start" size="sm">
                <Plus />
                New bot
                <ChevronDown className="ml-auto opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="min-w-[220px]"
              // Picking an instance opens a draft whose composer takes focus; don't yank it back here.
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenuLabel>New bot on…</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {ready.map((instance) => (
                <DropdownMenuItem key={instance.id} onSelect={() => onNewAgent(instance.id)}>
                  <span className="size-1.5 rounded-full bg-success" />
                  {instance.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="secondary"
            className="min-w-0 flex-1 justify-start"
            size="sm"
            disabled={!defaultInstanceId}
            onClick={() => defaultInstanceId && onNewAgent(defaultInstanceId)}
          >
            <Plus />
            New bot
          </Button>
        )}

        <Button variant="ghost" size="icon-sm" onClick={onOpenSettings} aria-label="Settings" title="Settings"><Settings /></Button>
        </div>
        {mode === 'mini' ? null : (
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              placeholder="Search sessions…"
              aria-label="Search sessions"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
              className="h-8 pl-8 pr-7 text-xs shadow-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-1 -translate-y-1/2"
              >
                <X />
              </Button>
            ) : null}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenArchive}
                aria-label="Hidden sessions"
                className="w-8 justify-center px-0"
              >
                <EyeOff className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hidden sessions</TooltipContent>
          </Tooltip>

        </div>
        )}
      </div>


      <div ref={scroller} data-rail-scroll onScroll={event => { const el = event.currentTarget; followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} className={cn('min-h-0 flex-1 overflow-y-auto', mode === 'mini' ? 'px-1 py-1' : 'px-1.5 py-1.5')}>
        <div className="flex min-h-full flex-col justify-end">
        {mode === 'mini' ? (
          <div className="flex flex-col items-center gap-1">
            {[...itemSessions]
              .filter((session) => !session.archived && (!docked || sessionKey(session) !== selectedKey))
              .sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0))
              .map((session) => {
                const key = sessionKey(session);
                const label = session.title?.trim() || projectForSession(session, projectsByInstance[session.instanceId] ?? [])?.name || session.id;
                return (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => openSession(session)}
                        aria-label={label}
                        data-mini-session={key}
                        style={{ width: miniAvatarSize + 8, height: miniAvatarSize + 8 }}
                        className={cn(
                          'relative grid place-items-center rounded-lg transition-colors',
                          key === selectedKey ? 'bg-muted' : 'hover:bg-muted/60'
                        )}
                      >
                        <Blob
                          style={blobStyle}
                          seed={key}
                          identity={avatarIdentities[key]}
                          size={miniAvatarSize}
                          mood={moods[key] ?? 'unknown'}
                        />
                        <ProcessIndicator session={session} overlay />
                        {visibleColumnKeys.has(key) ? (
                          <span
                            data-column-underline
                            aria-hidden="true"
                            className="pointer-events-none absolute -bottom-0.5 left-1/2 h-[3px] w-6 -translate-x-1/2 rounded-full bg-highlight"
                          />
                        ) : null}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {label}
                      {previews[key] ? <span className="mt-1 block max-w-[280px] text-inherit">{previews[key]}</span> : null}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
          </div>
        ) : null}
        {mode === 'mini' ? null : (
          <>
        {silentInstances.length > 0 ? (
          <div className="mb-1 flex flex-col" data-testid="rail-silent-instances">
            {silentInstances.map(renderSilentInstance)}
          </div>
        ) : null}
          <AnimatePresence initial={false} mode="popLayout">
            {railEntries.map(entry => <RailItem key={entry.id}>{renderEntry(entry)}</RailItem>)}
          </AnimatePresence>

        {archivedMatches.length > 0 ? (
          <div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
            <span className="px-2.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Hidden
            </span>
            {archivedMatches.map(renderArchivedSession)}
          </div>
        ) : null}

        {!hasItems && (!docked || needle) ? (
          <div className="px-3 py-8">
            {loading ? (
              <div className="flex flex-col gap-3">
                {startupMessage ? (
                  <div className="flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted-foreground">
                    <span className="size-1.5 flex-none animate-pulse rounded-full bg-highlight" />
                    <span className="min-w-0">{startupMessage}</span>
                  </div>
                ) : null}
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <Alert variant="default" className="border-dashed">
                <AlertDescription className="text-center text-[12px]">
                  {railEmptyCopy({
                    state: connection,
                    endpointCount: instances.length,
                    query: needle ? query : null,
                    windowLabel,
                  })}
                </AlertDescription>
              </Alert>
            )}

            {breadthControls}
          </div>
        ) : null}

        {hasItems ? breadthControls : null}
          </>
        )}
        </div>
      </div>

      {docked && selectedSession ? (
        <div data-active-chat={selectedKey} aria-label={`Current chat: ${selectedSession.title?.trim() || selectedSession.id}`} className="connection-band relative flex-none border-t" style={{ height: composerConnection.metrics?.height ?? 128 }}>
          <ContextMenu><ContextMenuTrigger asChild>
            <div ref={dockElement} role="button" tabIndex={0} aria-label={selectedSession.title?.trim() || selectedSession.id} data-selected="true" aria-current="true" title={[selectedSession.title, folderNameOf(selectedSession), instanceLabelOf(selectedSession)].filter(Boolean).join(' · ')} data-mini-session={mode === 'mini' ? selectedKey : undefined}
              onClick={event => { if (!(event.target instanceof Element && event.target.closest('input'))) selectSession(selectedSession); }}
              onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectSession(selectedSession); } }}
              className="group/dock absolute inset-x-0 translate-y-1/2 rounded-md focus-visible:outline-2 focus-visible:outline-ring" style={{ bottom: composerConnection.metrics?.centre ?? 64 }}>
              <motion.div key={selectedKey} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .35 }}>
                <ComposerIdentity docked compact={mode === 'mini'} name={selectedSession.title?.trim() || selectedSession.id}
                  seed={sessionKey(selectedSession)} identity={avatarIdentities[sessionKey(selectedSession)]}
                  topMeta={topMetaFor(selectedSession)}
                  style={blobStyle} mood={moods[sessionKey(selectedSession)] ?? 'unknown'} directory={selectedSession.directory}
                  onHide={() => archiveSession(selectedSession, true)} hiding={archivingKeys.has(sessionKey(selectedSession))}
                  onNewBot={() => newAgent(selectedSession.instanceId, selectedSession.directory)}
                  onRename={title => onRenameSession(selectedSession, title)} avatarOverlay={<ProcessIndicator session={selectedSession} overlay />} />
              </motion.div>
            </div>
          </ContextMenuTrigger><SessionContextMenuContent session={selectedSession}
            reloading={reloadingKeys.has(sessionKey(selectedSession))} archiving={archivingKeys.has(sessionKey(selectedSession))}
            onReload={reloadSession} onArchive={archiveSession} onCustomizeAppearance={customizeAppearance}
            onMarkAllRead={markAllRead} hasUnread={unreadKeys?.has(sessionKey(selectedSession))}
            quiet={quietKeys?.has(sessionKey(selectedSession))} onQuietChange={onQuietChange}
            scheduledTask={scheduledTaskBySession[sessionKey(selectedSession)]}
            scheduledRunning={Boolean(scheduledTaskBySession[sessionKey(selectedSession)] && runningScheduledKeys.has(scheduledTaskBySession[sessionKey(selectedSession)].key))}
            onRunScheduledTask={runScheduledTask} onChangeScheduledTaskModel={changeScheduledTaskModel}
            onGroupWith={selectedSession.kind === 'worker' ? undefined : session => onManageGroup({ name: '', keys: [sessionKey(session)] })} /></ContextMenu>
        </div>
      ) : null}
    </aside>
    </NotificationSizeContext.Provider>
    </AvatarTransitionContext.Provider></LayoutGroup>
  );
}
