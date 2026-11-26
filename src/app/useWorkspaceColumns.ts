import * as React from 'react';
import { isWorker } from '../lib/crew';
import { projectForSession, projectIdentityKey } from '../blob/seed';
import { useStableCallback } from '../lib/useStableCallback';
import {
  MAX_OPEN_SESSIONS,
  MIN_COLUMN_WIDTH,
  numberShortcutSlot,
  parseSessionKey,
  pruneWorkspace,
  sameWorkspace,
  visibleColumns,
  type Workspace,
} from '../lib/workspace';
import type {
  DraftAppearance,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  Project,
  RailMode,
  Session,
  SessionRef,
} from '../types';
import { sessionKey } from '../types';

type Options = {
  openSessions: string[];
  setOpenSessions: React.Dispatch<React.SetStateAction<string[]>>;
  activeSession: string | null;
  setActiveSession: React.Dispatch<React.SetStateAction<string | null>>;
  minimizedSessions: Set<string>;
  setMinimizedSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  threadModalKey: string | null;
  setThreadModalKey: React.Dispatch<React.SetStateAction<string | null>>;
  setNewSessionInstanceId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewSessionDirectory: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftPendingId: (id: string | null) => void;
  setDraftAppearance: React.Dispatch<React.SetStateAction<DraftAppearance | null>>;
  setUsageOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setScheduledOpen: React.Dispatch<React.SetStateAction<boolean>>;
  instances: Instance[];
  instancesLoaded: boolean;
  sessionsByInstance: Record<string, Session[]>;
  sessionsByInstanceRef: React.RefObject<Record<string, Session[]>>;
  projectsByInstanceRef: React.RefObject<Record<string, Project[]>>;
  splitView: boolean;
  settingsRef: React.RefObject<EmberSettings>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  showActionError: (message: string | null, retry?: () => void, retryLabel?: string, onDismiss?: () => void) => void;
  navigateWithAnnotations: (action: () => void) => void;
};

/**
 * Manages workspace columns, active selection, minimized tabs, per-project saved layouts,
 * resize measurement, keyboard navigation (`Cmd+B`, `Cmd+1-9`), and workspace persistence/pruning.
 */
export function useWorkspaceColumns({
  openSessions,
  setOpenSessions,
  activeSession,
  setActiveSession,
  minimizedSessions,
  setMinimizedSessions,
  threadModalKey,
  setThreadModalKey,
  setNewSessionInstanceId,
  setNewSessionDirectory,
  setDraftPendingId,
  setDraftAppearance,
  setUsageOpen,
  setScheduledOpen,
  instances,
  instancesLoaded,
  sessionsByInstance,
  sessionsByInstanceRef,
  projectsByInstanceRef,
  splitView,
  settingsRef,
  handleSettings,
  showActionError,
  navigateWithAnnotations,
}: Options) {
  // Width of the column area, measured with a ResizeObserver; how many columns fit depends on it.
  const [workspaceWidth, setWorkspaceWidth] = React.useState(0);
  const workspaceRef = React.useRef<HTMLDivElement | null>(null);
  const workspaceHydratedRef = React.useRef(false);
  // Per-project workspace memory: leaving a project saves its columns/tabs/active so returning
  // restores the exact layout instead of re-opening every session.
  const projectLayoutsRef = React.useRef<Map<string, Workspace>>(new Map());
  const threadReturnFocusRef = React.useRef<{ element: HTMLElement; workspaceKey: string | null } | null>(null);

  const activeSessionRef = React.useRef<string | null>(activeSession);
  activeSessionRef.current = activeSession;
  const openSessionsRef = React.useRef<string[]>(openSessions);
  openSessionsRef.current = openSessions;
  const minimizedKeysRef = React.useRef<Set<string>>(minimizedSessions);
  minimizedKeysRef.current = minimizedSessions;
  const threadModalKeyRef = React.useRef<string | null>(threadModalKey);
  threadModalKeyRef.current = threadModalKey;
  /** Read by `openSession`, which is a stable callback and cannot depend on the setting. */
  const splitViewRef = React.useRef(splitView);
  splitViewRef.current = splitView;

  /** The project identity the open columns belong to, or a standalone bucket. */
  const currentContextKey = React.useCallback((): string | null => {
    const first = openSessionsRef.current[0];
    if (!first) return null;
    const ref = parseSessionKey(first);
    if (!ref) return null;
    const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find((s) => s.id === ref.sessionId);
    const project = session
      ? projectForSession(session, projectsByInstanceRef.current[ref.instanceId] ?? [])
      : null;
    return project ? projectIdentityKey(ref.instanceId, project.id) : `standalone:${ref.instanceId}`;
  }, [projectsByInstanceRef, sessionsByInstanceRef]);

  /** Remember the current workspace under its project before switching away. */
  const saveCurrentLayout = React.useCallback(() => {
    const contextKey = currentContextKey();
    if (!contextKey) return;
    projectLayoutsRef.current.set(contextKey, {
      open: [...openSessionsRef.current],
      active: activeSessionRef.current,
      minimized: [...minimizedKeysRef.current],
    });
  }, [currentContextKey]);

  /**
   * Open a session.
   *
   * Whether it joins what is already open is the split-view setting's call, and nothing else's:
   * with it on the session becomes another column beside the others; with it off it takes the view
   * over and the outgoing layout is put away under its project.
   *
   * `known` lets callers supply the session before the session list has caught up (a just-created
   * or restored one); it is not otherwise needed here, because the key alone is what gets opened.
   */
  const performOpenSession = React.useCallback((ref: SessionRef, known?: Session | null) => {
    const session = known ?? (sessionsByInstanceRef.current[ref.instanceId] ?? []).find((entry) => entry.id === ref.sessionId);
    if (session && isWorker(session)) {
      if (!session.promotedTo || session.task) {
        if (!threadModalKeyRef.current && document.activeElement instanceof HTMLElement) {
          threadReturnFocusRef.current = { element: document.activeElement, workspaceKey: activeSessionRef.current };
        }
        setThreadModalKey(sessionKey(ref));
        return;
      }
      // Promotion forks a peer; references to the old worker now open that top-level session.
      ref = { instanceId: session.instanceId, sessionId: session.promotedTo };
    }
    setThreadModalKey(null);
    const key = sessionKey(ref);
    // Split view is the answer to "how many columns", so it decides here too: with it on, opening a
    // session adds a column whether or not the session shares a project with what is already open
    // (the old same-project grouping is what *made* the columns disagree with the strip). With it
    // off the click takes the view over and the outgoing project's layout is put away.
    const keepOpen = splitViewRef.current;
    if (keepOpen) {
      setOpenSessions((prev) => {
        if (prev.includes(key)) return prev;
        const next = [...prev, key];
        return next.length > MAX_OPEN_SESSIONS ? next.slice(next.length - MAX_OPEN_SESSIONS) : next;
      });
    } else {
      // Stash the current layout so returning to its project restores it.
      saveCurrentLayout();
      setOpenSessions([key]);
    }
    setMinimizedSessions((prev) => {
      const base = keepOpen ? prev : new Set([...prev].filter((entry) => entry === key));
      if (!base.has(key)) return base;
      const next = new Set(base);
      next.delete(key);
      return next;
    });
    setActiveSession(key);
    setNewSessionInstanceId(null);
    setNewSessionDirectory(null);
    // The draft is gone; a create still in flight keeps going in the background.
    setDraftPendingId(null);
    // Opening a session exits the activity home, Usage, and Scheduled views.
    setUsageOpen(false);
    setScheduledOpen(false);
  }, [
    saveCurrentLayout,
    sessionsByInstanceRef,
    setActiveSession,
    setDraftPendingId,
    setMinimizedSessions,
    setNewSessionDirectory,
    setNewSessionInstanceId,
    setOpenSessions,
    setScheduledOpen,
    setThreadModalKey,
    setUsageOpen,
  ]);
  const performOpenSessionRef = React.useRef(performOpenSession);
  performOpenSessionRef.current = performOpenSession;
  const openSession = React.useCallback((ref: SessionRef, known?: Session | null) => {
    if (sessionKey(ref) === activeSessionRef.current && !threadModalKeyRef.current) {
      performOpenSessionRef.current(ref, known);
      return;
    }
    navigateWithAnnotations(() => performOpenSessionRef.current(ref, known));
  }, [navigateWithAnnotations]);

  /**
   * Open a project. `projectSessions` is exactly what the project's card showed, so opening it
   * never pulls in out-of-window or archived sessions that share the directory. If some of the
   * project's sessions are already open, only the missing ones are added (preserving the current
   * layout). If none are open, the remembered layout is restored; otherwise every session opens in
   * recency order. An empty set opens a draft.
   */
  const performOpenProject = React.useCallback((instanceId: string, project: Project, projectSessions: Session[]) => {
    showActionError(null);
    const owned = projectSessions.filter((session) => !session.archived && !isWorker(session));
    const ownedKeys = new Set(owned.map(sessionKey));
    const projectKey = projectIdentityKey(instanceId, project.id);
    saveCurrentLayout();
    setUsageOpen(false);
    setScheduledOpen(false);
    if (owned.length === 0) {
      projectLayoutsRef.current.delete(projectKey);
      setActiveSession(null);
      setNewSessionInstanceId(instanceId);
      setNewSessionDirectory(project.path ?? null);
      return;
    }
    const byRecency = [...owned]
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .map(sessionKey);

    const currentOpen = openSessionsRef.current.filter((key) => ownedKeys.has(key));
    if (currentOpen.length > 0) {
      // Project is already represented in the workspace: keep its current arrangement and just
      // append any sessions that aren't open yet.
      const currentSet = new Set(currentOpen);
      const missing = byRecency.filter((key) => !currentSet.has(key));
      const keys = [...currentOpen, ...missing].slice(0, MAX_OPEN_SESSIONS);
      const minimized = new Set([...minimizedKeysRef.current].filter((key) => keys.includes(key)));
      setOpenSessions(keys);
      setMinimizedSessions(minimized);
      setActiveSession(
        (current) =>
          (current && keys.includes(current) && !minimized.has(current)
            ? current
            : keys.find((key) => !minimized.has(key)) ?? keys[0] ?? null)
      );
      setNewSessionInstanceId(null);
      setNewSessionDirectory(null);
      return;
    }

    // Project not currently open: restore the saved layout if we have one, else open all by recency.
    const saved = projectLayoutsRef.current.get(projectKey);
    const savedOrder = saved ? saved.open.filter((key) => ownedKeys.has(key)) : [];
    const keys = [...savedOrder, ...byRecency.filter((key) => !savedOrder.includes(key))].slice(
      0,
      MAX_OPEN_SESSIONS
    );
    const minimized = new Set((saved?.minimized ?? []).filter((key) => keys.includes(key)));
    setOpenSessions(keys);
    setMinimizedSessions(minimized);
    setActiveSession(
      saved?.active && keys.includes(saved.active) && !minimized.has(saved.active)
        ? saved.active
        : keys.find((key) => !minimized.has(key)) ?? keys[0] ?? null
    );
    setNewSessionInstanceId(null);
    setNewSessionDirectory(null);
  }, [
    saveCurrentLayout,
    setActiveSession,
    setMinimizedSessions,
    setNewSessionDirectory,
    setNewSessionInstanceId,
    setOpenSessions,
    setScheduledOpen,
    setUsageOpen,
    showActionError,
  ]);

  const openProject = useStableCallback((instanceId: string, project: Project, projectSessions: Session[]) =>
    navigateWithAnnotations(() => performOpenProject(instanceId, project, projectSessions))
  );

  const performActivateSession = React.useCallback((key: string) => {
    setActiveSession(key);
    // Leaving the new-agent draft for an existing session discards the draft pane.
    setNewSessionInstanceId(null);
    setNewSessionDirectory(null);
    // Working on a session leaves the activity home.
    setUsageOpen(false);
    setScheduledOpen(false);
    setMinimizedSessions((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [setActiveSession, setMinimizedSessions, setNewSessionDirectory, setNewSessionInstanceId, setScheduledOpen, setUsageOpen]);
  const performActivateSessionRef = React.useRef(performActivateSession);
  performActivateSessionRef.current = performActivateSession;
  const activateSession = React.useCallback((key: string) => {
    if (key === activeSessionRef.current) return;
    navigateWithAnnotations(() => performActivateSessionRef.current(key));
  }, [navigateWithAnnotations]);

  /**
   * Close a session's column. It is not parked anywhere: with no tab strip there is nothing to
   * park it in, and the rail already lists every session, so closing simply hands the view back to
   * whatever else is open (or to the activity home when nothing is).
   */
  const performMinimizeSession = React.useCallback((key: string) => {
    const remaining = openSessionsRef.current.filter((entry) => entry !== key);
    setOpenSessions(remaining);
    setMinimizedSessions((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setActiveSession((current) => {
      if (current !== key) return current;
      return remaining.find((entry) => !minimizedKeysRef.current.has(entry)) ?? remaining[0] ?? null;
    });
  }, [setActiveSession, setMinimizedSessions, setOpenSessions]);

  const minimizeSession = useStableCallback((key: string) =>
    navigateWithAnnotations(() => performMinimizeSession(key))
  );

  const closeSession = React.useCallback((key: string) => {
    const remaining = openSessionsRef.current.filter((entry) => entry !== key);
    setOpenSessions(remaining);
    setMinimizedSessions((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setActiveSession((current) => {
      if (current !== key) return current;
      return remaining.find((entry) => !minimizedKeysRef.current.has(entry)) ?? remaining[0] ?? null;
    });
  }, [setActiveSession, setMinimizedSessions, setOpenSessions]);

  // Measure the column area so the number of side-by-side columns matches the available width.
  React.useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const update = () => setWorkspaceWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // What to draw as columns: the active session alone, or as many as fit when split view is on.
  // Nothing overflows into a tab strip any more — see `visibleColumns`.
  const columns = React.useMemo(
    () =>
      visibleColumns(activeSession, openSessions, workspaceWidth, {
        splitView,
        minWidth: MIN_COLUMN_WIDTH,
      }),
    [openSessions, workspaceWidth, activeSession, splitView]
  );
  const columnsRef = React.useRef<string[]>([]);
  columnsRef.current = columns;
  const watchedSessionKeys = React.useMemo(
    () => (threadModalKey ? [...new Set([...columns, threadModalKey])] : columns),
    [columns, threadModalKey]
  );
  const watchedSessionKeysRef = React.useRef<string[]>([]);
  watchedSessionKeysRef.current = watchedSessionKeys;
  const columnKeySet = React.useMemo(() => new Set(columns), [columns]);

  /**
   * The session list's three widths, in order. One control walks them: mini (a blob dock) → normal
   * (320px) → wide (about half the window) → mini. `Cmd/Ctrl+B` does the same from anywhere, and
   * the choice is remembered in settings.
   */
  const cycleRailMode = React.useCallback(() => {
    const order: RailMode[] = ['mini', 'normal', 'wide'];
    const current = settingsRef.current.railMode ?? 'normal';
    const next = order[(order.indexOf(current) + 1) % order.length];
    void handleSettings({ railMode: next });
  }, [handleSettings, settingsRef]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      cycleRailMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleRailMode]);

  // Cmd/Ctrl+1–9 jumps to that slot in the open list (columns and tabs share the numbering).
  // `activateSession` also clears the sticky minimized flag, so a tab restores on jump.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const slot = numberShortcutSlot(event);
      if (slot === null) return;
      if (threadModalKeyRef.current) return;
      const key = (columnsRef.current[slot] ?? openSessionsRef.current[slot]);
      if (!key) return;
      event.preventDefault();
      setUsageOpen(false);
      setScheduledOpen(false);
      activateSession(key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activateSession, setScheduledOpen, setUsageOpen]);

  // Persist the workspace after the initial restore. The guarded ref keeps the first render
  // (empty defaults) from clobbering what main just handed back.
  React.useEffect(() => {
    if (!workspaceHydratedRef.current) return;
    // Workers use a separate modal. Also drop any legacy worker column keys from saved layouts.
    const workerKey = (key: string): boolean => {
      const ref = parseSessionKey(key);
      if (!ref) return false;
      const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find(
        (entry) => entry.id === ref.sessionId
      );
      return session ? isWorker(session) : false;
    };
    void handleSettings({
      openSessions: openSessions.filter((key) => !workerKey(key)),
      activeSession: activeSession && !workerKey(activeSession) ? activeSession : null,
      minimizedSessions: [...minimizedSessions].filter((key) => !workerKey(key)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSettings is recreated per render; only the workspace values should retrigger
  }, [openSessions, activeSession, minimizedSessions]);

  // Drop persisted keys once the instance/session it names is gone, archived, or a subagent.
  // A missing session list means "not loaded yet", so those keys survive startup.
  React.useEffect(() => {
    if (!workspaceHydratedRef.current) return;
    const check = (ref: SessionRef): boolean | undefined => {
      if (instancesLoaded && !instances.some((instance) => instance.id === ref.instanceId)) return false;
      const list = sessionsByInstance[ref.instanceId];
      // An empty list is not evidence that a session is gone: an instance that is still starting (or
      // a paginated read that came back short) returns nothing, and pruning on that erased the whole
      // open workspace at every restart. Only a loaded list that actually contains other sessions
      // counts as authoritative; a vanished session is dropped on the next read that proves it.
      if (!list || list.length === 0) return undefined;
      const session = list.find((entry) => entry.id === ref.sessionId);
      if (!session) return false;
      return !session.archived && !session.parentId;
    };
    const current: Workspace = {
      open: openSessions,
      active: activeSession,
      minimized: [...minimizedSessions],
    };
    const next = pruneWorkspace(current, check);
    if (sameWorkspace(next, current)) return;
    setOpenSessions(next.open);
    setActiveSession(next.active);
    setMinimizedSessions(new Set(next.minimized));
  }, [
    sessionsByInstance,
    instances,
    instancesLoaded,
    openSessions,
    activeSession,
    minimizedSessions,
    setActiveSession,
    setMinimizedSessions,
    setOpenSessions,
  ]);

  const performBeginNewAgent = React.useCallback((instanceId: string, directory?: string) => {
    showActionError(null);
    setDraftAppearance(null);
    // Keep the open columns; the draft simply takes the active pane (no session key yet). A
    // project's `+` passes its directory so the draft starts there instead of the instance default.
    setActiveSession(null);
    setNewSessionInstanceId(instanceId);
    setNewSessionDirectory(directory ?? null);
    // Deliberately a fresh draft, even while another one is still being created: the earlier
    // attempt keeps going and reports itself when it lands.
    setDraftPendingId(null);
    setUsageOpen(false);
    setScheduledOpen(false);
  }, [
    setActiveSession,
    setDraftAppearance,
    setDraftPendingId,
    setNewSessionDirectory,
    setNewSessionInstanceId,
    setScheduledOpen,
    setUsageOpen,
    showActionError,
  ]);

  const beginNewAgent = useStableCallback((instanceId: string, directory?: string) =>
    navigateWithAnnotations(() => performBeginNewAgent(instanceId, directory))
  );

  /**
   * Back to the workspace, from the Sessions tab or Home's "Back to workspace".
   *
   * Three cases, in order: something is already on screen (just leave Home); sessions are open but
   * every one is **minimized** (restore one - otherwise Home would be a trap, since Home hides the
   * rail and the tab strip); nothing is open at all (load the most recently updated session).
   */
  const showSessions = React.useCallback(() => {
    setUsageOpen(false);
    setScheduledOpen(false);
    const open = openSessionsRef.current;
    if (open.length === 0) {
      const hidden = new Set(settingsRef.current.hiddenInstances);
      const top = Object.values(sessionsByInstanceRef.current)
        .flat()
        .filter((session) => !hidden.has(session.instanceId) && !session.archived && !isWorker(session))
        .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
      if (top) openSession({ instanceId: top.instanceId, sessionId: top.id }, top);
      return;
    }
    if (columnsRef.current.length > 0) return;
    const active = activeSessionRef.current;
    const target =
      (active && open.includes(active) ? active : undefined) ??
      open.find((entry) => minimizedKeysRef.current.has(entry)) ??
      open[0];
    // activateSession clears the sticky minimized flag, which is what brings the tab back.
    if (target) activateSession(target);
  }, [activateSession, openSession, sessionsByInstanceRef, setScheduledOpen, setUsageOpen, settingsRef]);

  return {
    openSessions,
    activeSession,
    minimizedSessions,
    projectLayoutsRef,
    workspaceHydratedRef,
    workspaceRef,
    workspaceWidth,
    threadReturnFocusRef,
    activeSessionRef,
    openSessionsRef,
    minimizedKeysRef,
    threadModalKeyRef,
    columnsRef,
    watchedSessionKeysRef,
    openSession,
    performOpenSession,
    openProject,
    activateSession,
    minimizeSession,
    closeSession,
    saveCurrentLayout,
    cycleRailMode,
    columns,
    watchedSessionKeys,
    columnKeySet,
    beginNewAgent,
    showSessions,
  };
}
