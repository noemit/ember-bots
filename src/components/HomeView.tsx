import * as React from 'react';
import { ArrowLeft, ChevronDown, Inbox, Plus } from 'lucide-react';
import HomeLinks from './HomeLinks';
import HomeSessionCard from './HomeSessionCard';
import ActivityTimeline from './ActivityTimeline';
import { projectForSession } from '../blob/seed';
import { endpointState } from '../lib/instanceHealth';
import { linksFromItems, type SharedLink } from '../lib/sharedLinks';
import { unreadItemsFor, type UnreadDigest, type UnreadItem } from '../lib/unreadDigest';
import { mayHaveUnread } from '../hooks/useUnreadDigests';
import { sessionKey } from '../types';
import type {
  ActivityEntry,
  AvatarIdentity,
  BallMood,
  BlobStyle,
  EmberSettings,
  Instance,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from '../types';

/** Sessions drawn before "Show more": enough to fill a screen without turning Home into a scroll. */
const INITIAL_SESSIONS = 6;
/** How many more each press reveals. */
const MORE_SESSIONS = 10;

type ActivitySection = {
  entries: ActivityEntry[];
  loading: boolean;
  error: string | null;
  historyUnavailable: boolean;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
};

type Props = {
  /** Active sessions across every instance; workers and archived ones are already excluded. */
  sessions: Session[];
  everySession: Session[];
  digests: Record<string, UnreadDigest>;
  pending: Record<string, true>;
  /** Prompts in state, so a blocked agent shows on Home without answering anything. */
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  marks: EmberSettings['readMarks'];
  notes: EmberSettings['sessionNotes'];
  /** Only sessions active within this many hours; 0 means no limit. */
  sessionWindowHours: number;
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  moods: Record<string, BallMood>;
  avatarIdentities: Record<string, AvatarIdentity>;
  blobStyle: BlobStyle;
  showBackButton: boolean;
  onClose: () => void;
  onOpenSession: (session: Session) => void;
  /** Open a session with one message highlighted and scrolled to (a link's context bar). */
  onOpenSessionAt?: (sessionKey: string, messageId: string) => void;
  /** Read one message in full over Home; marking happens there. */
  onReadItem: (session: Session, item: UnreadItem) => void;
  onMarkAllRead: (session: Session) => void;
  onQuietChange?: (session: Session, quiet: boolean) => void;
  onNewAgent: (instanceId?: string) => void;
  /** The archived sessions dialog — the rail owned it, and Home must not be a dead end. */
  onOpenArchive?: () => void;
  activity: ActivitySection;
};

type Row = {
  session: Session;
  items: UnreadItem[];
  /** A read is in flight for a session the list says has new entries. */
  pending: boolean;
  /** Unread messages only: a pending request is not a message. */
  unread: number;
};

const withinWindow = (session: Session, hours: number, now: number): boolean =>
  hours <= 0 || !session.updated || now - session.updated <= hours * 3_600_000;

/**
 * Home: every session in one list, the ones with something to read at the top.
 *
 * There are no Read/Unread sections and no cards. Sessions run together as alternating bands (no
 * borders, no radii), ordered by unread messages first and then by recency, and a session you are
 * caught up on is simply the same row with no dots. Nothing is marked read by opening a session or
 * by scrolling: the dot on one message marks that message, and right-clicking a session marks all
 * of them. A pending approval or question is answered, not read, so it survives both.
 */
export default function HomeView({
  sessions,
  everySession,
  digests,
  pending,
  permissions,
  questions,
  marks,
  notes,
  sessionWindowHours,
  instances,
  projectsByInstance,
  moods,
  avatarIdentities,
  blobStyle,
  showBackButton,
  onClose,
  onOpenSession,
  onOpenSessionAt,
  onReadItem,
  onMarkAllRead,
  onQuietChange,
  onNewAgent,
  onOpenArchive,
  activity,
}: Props) {
  const now = Date.now();
  const instanceLabel = React.useCallback(
    (instanceId: string) => instances.find((instance) => instance.id === instanceId)?.label ?? instanceId,
    [instances]
  );
  const projectOf = React.useCallback(
    (session: Session) => projectForSession(session, projectsByInstance[session.instanceId] ?? []),
    [projectsByInstance]
  );

  const permissionsBySession = React.useMemo(() => {
    const map = new Map<string, PermissionRequest[]>();
    permissions.forEach((request) => {
      const key = `${request.instanceId}::${request.sessionId}`;
      map.set(key, [...(map.get(key) ?? []), request]);
    });
    return map;
  }, [permissions]);
  const questionsBySession = React.useMemo(() => {
    const map = new Map<string, QuestionRequest[]>();
    questions.forEach((request) => {
      const key = `${request.instanceId}::${request.sessionId}`;
      map.set(key, [...(map.get(key) ?? []), request]);
    });
    return map;
  }, [questions]);

  const itemsFor = React.useCallback(
    (session: Session): UnreadItem[] => {
      const key = sessionKey(session);
      return unreadItemsFor({
        digest: digests[key],
        mark: marks[key],
        permissions: permissionsBySession.get(key) ?? [],
        questions: questionsBySession.get(key) ?? [],
        at: session.updated ?? 0,
      });
    },
    [digests, marks, permissionsBySession, questionsBySession]
  );

  /**
   * One list: sessions with something waiting first — most unread messages first, then recency —
   * followed by the ones you are caught up on, newest first.
   */
  const rows = React.useMemo(() => {
    const waiting: Row[] = [];
    const rest: Row[] = [];
    sessions
      .filter((session) => !session.archived && withinWindow(session, sessionWindowHours, now))
      .forEach((session) => {
        const key = sessionKey(session);
        const items = itemsFor(session);
        if (items.length > 0) {
          waiting.push({
            session,
            items,
            pending: false,
            unread: items.filter((item) => !item.sticky).length,
          });
          return;
        }
        // No digest yet but the session list says there are new entries: hold its place with a
        // loader rather than letting it saunter down the list a moment later.
        const loading = Boolean(pending[key]) || (!digests[key] && mayHaveUnread(session, marks[key]));
        rest.push({ session, items, pending: loading, unread: 0 });
      });
    const byRecency = (a: Row, b: Row): number => (b.session.updated ?? 0) - (a.session.updated ?? 0);
    waiting.sort((a, b) => b.unread - a.unread || byRecency(a, b));
    // A session still being read certainly has new entries, so it belongs after the waiting ones
    // but above the settled history.
    const loadingRows = rest.filter((row) => row.pending);
    const readRows = rest.filter((row) => !row.pending).sort(byRecency);
    return [...waiting, ...loadingRows, ...readRows];
    // `now` is deliberately not a dependency: the window is a coarse filter, and re-deriving the
    // whole screen every second to age a session out would cost more than it is worth.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reason: the window is coarse by design
  }, [sessions, sessionWindowHours, itemsFor, digests, marks, pending]);

  const [limit, setLimit] = React.useState(INITIAL_SESSIONS);
  const shown = rows.slice(0, limit);
  const remaining = rows.length - shown.length;

  const unreadSessions = rows.filter((row) => row.items.length > 0).length;
  const unreadMessages = rows.reduce((total, row) => total + row.unread, 0);

  // Links come from the rows on screen — messages and pending questions alike — so a link the
  // agent offered in a question is still one click away.
  const links = React.useMemo(
    () =>
      linksFromItems(
        rows
          .filter((row) => row.items.length > 0)
          .map((row) => ({ sessionKey: sessionKey(row.session), at: row.session.updated ?? 0, items: row.items }))
      ),
    [rows]
  );

  const sessionLabel = React.useCallback(
    (key: string) => {
      const session = everySession.find((entry) => sessionKey(entry) === key);
      if (!session) return key;
      return session.title?.trim() || projectOf(session)?.name || session.id;
    },
    [everySession, projectOf]
  );

  const connection = React.useMemo(() => endpointState(instances), [instances]);

  return (
    <div
      data-testid="home-view"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <header className="flex flex-none items-center gap-3 border-b px-4 py-2">
        <h1 className="text-[14px] font-semibold tracking-wide text-highlight">Home</h1>
        <p className="min-w-0 truncate text-[12px] text-muted-foreground">
          {unreadSessions === 0
            ? "You're caught up. New replies land here as your agents finish them."
            : unreadMessages === 0
              // Only requests are left: say what is being waited on rather than "0 unread".
              ? `${unreadSessions} ${unreadSessions === 1 ? 'session is' : 'sessions are'} waiting for your reply`
              : `${unreadSessions} ${unreadSessions === 1 ? 'session' : 'sessions'} · ${unreadMessages} unread ${unreadMessages === 1 ? 'message' : 'messages'}`}
        </p>
        <div className="flex-1" />
        {onOpenArchive ? (
          <button
            type="button"
            onClick={onOpenArchive}
            className="flex h-7 items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Archived
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onNewAgent()}
          className="flex h-7 items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
          New agent
        </button>
        {showBackButton ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to workspace
            <kbd className="rounded bg-background px-1 text-[10px]">Esc</kbd>
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden @container/home">
        <div
          className={
            links.length > 0
              ? 'grid min-h-0 flex-1 grid-cols-1 overflow-hidden @[900px]/home:grid-cols-[minmax(0,4fr)_minmax(200px,1fr)]'
              : 'grid min-h-0 flex-1 grid-cols-1 overflow-hidden'
          }
        >
          <div className="min-h-0 overflow-y-auto pb-10">
            {rows.length === 0 ? (
              <p
                data-testid="home-empty"
                className="flex items-center gap-2 px-4 py-6 text-[12px] text-muted-foreground"
              >
                <Inbox className="size-4 flex-none" />
                No sessions in this window. Start one with New agent, or widen the window in Settings.
              </p>
            ) : null}

            {shown.map((row, index) => {
              const key = sessionKey(row.session);
              return (
                <HomeSessionCard
                  key={key}
                  session={row.session}
                  mood={moods[key] ?? 'unknown'}
                  identity={avatarIdentities[key]}
                  blobStyle={blobStyle}
                  projectName={projectOf(row.session)?.name}
                  instanceLabel={instanceLabel(row.session.instanceId)}
                  items={row.items}
                  pending={row.pending}
                  comments={marks[key]?.comments ?? 0}
                  notes={(notes[key] ?? []).length}
                  striped={index % 2 === 1}
                  onOpen={() => onOpenSession(row.session)}
                  onReadItem={(item) => onReadItem(row.session, item)}
                  onMarkAllRead={() => onMarkAllRead(row.session)}
                  quiet={marks[key]?.quiet === true}
                  onQuietChange={
                    onQuietChange ? (quiet) => onQuietChange(row.session, quiet) : undefined
                  }
                />
              );
            })}

            {remaining > 0 ? (
              <button
                type="button"
                data-testid="home-show-more"
                onClick={() => setLimit((current) => current + MORE_SESSIONS)}
                className="flex w-full items-center justify-center gap-1.5 py-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className="size-3.5" />
                Show {remaining} more {remaining === 1 ? 'session' : 'sessions'}
              </button>
            ) : null}

            <details className="group mt-6 border-t" data-testid="home-activity">
              <summary className="cursor-pointer select-none px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Activity
                <span className="ml-2 font-normal normal-case tracking-normal">
                  everything that happened, kept on disk
                </span>
              </summary>
              <div className="px-4 pb-3 pt-1">
                <ActivityTimeline
                  entries={activity.entries}
                  loading={activity.loading}
                  error={activity.error}
                  historyUnavailable={activity.historyUnavailable}
                  canLoadEarlier={activity.canLoadEarlier}
                  loadingEarlier={activity.loadingEarlier}
                  onLoadEarlier={activity.onLoadEarlier}
                  onOpenSession={onOpenSession}
                  sessions={everySession}
                  instances={instances}
                  projectsByInstance={projectsByInstance}
                  avatarIdentities={avatarIdentities}
                  blobStyle={blobStyle}
                  connection={connection}
                />
              </div>
            </details>
          </div>

          {links.length > 0 ? (
            <div className="hidden min-h-0 border-l @[900px]/home:block">
              <HomeLinks
                links={links}
                sessionLabel={sessionLabel}
                onOpenContext={(link: SharedLink) => {
                  if (link.messageId && onOpenSessionAt) {
                    onOpenSessionAt(link.sessionKey, link.messageId);
                    return;
                  }
                  // A link from a pending question has no message to land on: open the session.
                  const session = everySession.find((entry) => sessionKey(entry) === link.sessionKey);
                  if (session) onOpenSession(session);
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
