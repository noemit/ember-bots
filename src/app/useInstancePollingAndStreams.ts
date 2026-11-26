import * as React from 'react';
import {
  isPartialSessionList,
  listInstances,
  loadAllAutoAcceptPolicies,
  loadAllMessageQueues,
  loadAllPermissions,
  loadAllProjects,
  loadAllQuestions,
  loadAllSessions,
  loadAllSessionStates,
  loadMessageTail,
  loadModels,
  loadScheduledIdentityData,
  mergePolledSessions,
  refreshInstanceModels,
  type AutoAcceptPolicy,
  type ModelList,
  type ScheduledTask,
} from '../api';
import { mergePolledQueues } from '../hooks/useMessageQueue';
import { usePoll } from '../hooks/usePoll';
import { crewByLeader, threadDescendants } from '../lib/crew';
import { InvalidationQueue, invalidationsFor, parseEmberEvent, sessionIsLoaded, type Invalidation } from '../lib/invalidation';
import { APPLY_STREAM_DELTAS, isTerminalStreamEvent, StreamDeltaCoalescer } from '../lib/liveStream';
import { summarizeMessages, type SessionMessageSummary } from '../lib/messageSummary';
import type { PendingCreate } from '../lib/pendingCreate';
import type { LiveToolOutput, ToolResultSettlement } from '../lib/piMapping';
import { ReadCoordinator } from '../lib/readCoordinator';
import { mergeScheduledSessionBindings } from '../lib/scheduledBindings';
import { observeSessionDiscovery, type SessionDiscoveryState } from '../lib/sessionDiscovery';
import { shareValue } from '../lib/structuralSharing';
import type { TranscriptCache } from '../lib/transcriptCache';
import { useStableCallback } from '../lib/useStableCallback';
import { parseSessionKey } from '../lib/workspace';
import { isPiInstance, piLoadModels, piRefreshModels } from '../piApi';
import { sessionKey } from '../types';
import type {
  AvatarAssignment,
  AvatarOverride,
  BallState,
  ChatMessage,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  LiveDelta,
  MessageQueueSession,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionRef,
} from '../types';
import {
  MESSAGES_POLL_LIVE_MS,
  PREVIEW_CONCURRENCY,
  PREVIEW_COUNT,
  PREVIEW_LIMITS,
  PROMPT_POLL_MS,
  sameStringRecord,
  sameSummary,
  SCHEDULE_POLL_LIVE_MS,
  SCHEDULE_POLL_MS,
  SESSION_POLL_LIVE_MS,
  SESSION_POLL_MS,
  STATE_POLL_LIVE_MS,
  STATE_POLL_MS,
} from './appHelpers';

type Options = {
  instances: Instance[];
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setInstancesLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  projectsByInstance: Record<string, Project[]>;
  setProjectsByInstance: React.Dispatch<React.SetStateAction<Record<string, Project[]>>>;
  projectsByInstanceRef: React.RefObject<Record<string, Project[]>>;
  setSessionsByInstance: React.Dispatch<React.SetStateAction<Record<string, Session[]>>>;
  sessionsByInstance: Record<string, Session[]>;
  sessionsByInstanceRef: React.RefObject<Record<string, Session[]>>;
  statesByInstance: Record<string, Record<string, BallState>>;
  setStatesByInstance: React.Dispatch<React.SetStateAction<Record<string, Record<string, BallState>>>>;
  setStateReadAt: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  permissionsByInstance: Record<string, PermissionRequest[]>;
  setPermissionsByInstance: React.Dispatch<React.SetStateAction<Record<string, PermissionRequest[]>>>;
  questionsByInstance: Record<string, QuestionRequest[]>;
  setQuestionsByInstance: React.Dispatch<React.SetStateAction<Record<string, QuestionRequest[]>>>;
  queuesByInstance: Record<string, MessageQueueSession[]>;
  setQueuesByInstance: React.Dispatch<React.SetStateAction<Record<string, MessageQueueSession[]>>>;
  setModelsByInstance: React.Dispatch<React.SetStateAction<Record<string, ModelList>>>;
  setAutoAcceptByInstance: React.Dispatch<React.SetStateAction<Record<string, AutoAcceptPolicy>>>;
  liveInstances: Record<string, boolean>;
  setLiveInstances: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setSummaries: React.Dispatch<React.SetStateAction<Record<string, SessionMessageSummary>>>;
  setHistoryIncomplete: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setScheduledTaskNames: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setScheduledTasksByKey: React.Dispatch<React.SetStateAction<Record<string, ScheduledTask>>>;
  setOpenSessions: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveSession: React.Dispatch<React.SetStateAction<string | null>>;
  setMinimizedSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  workspaceHydratedRef: React.RefObject<boolean>;
  settings: EmberSettings;
  settingsLoaded: boolean;
  settingsRef: React.RefObject<EmberSettings>;
  hydrateSettings: (stored: Partial<EmberSettings>) => void;
  refreshHarnessSettings: () => Promise<EmberSettings>;
  markSettingsLoaded: () => void;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  showActionError: (message: string | null, retry?: () => void, retryLabel?: string, onDismiss?: () => void) => void;
  hidden: Set<string>;
  readyIds: string[];
  readyKey: string;
  sessions: Session[];
  states: Record<string, BallState>;
  crewNeedsInputKeys: Set<string>;
  selected: SessionRef | null;
  selectedSession: Session | null;
  selectedSessionRef: React.RefObject<Session | null>;
  watchedSessionKeys: string[];
  watchedSessionKeysRef: React.RefObject<string[]>;
  activeSessionRef: React.RefObject<string | null>;
  openSessionsRef: React.RefObject<string[]>;
  threadModalKey: string | null;
  threadModalKeyRef: React.RefObject<string | null>;
  pendingCreatesRef: React.RefObject<PendingCreate[]>;
  allocateFor: (session: Session, arriving?: readonly Session[]) => AvatarAssignment;
  reserveIdentity: (
    session: Session,
    assignment: AvatarAssignment,
    reservationKey?: string,
    appearance?: AvatarOverride
  ) => void;
  messageCacheRef: React.RefObject<TranscriptCache>;
  summariesRef: React.RefObject<Record<string, SessionMessageSummary>>;
  transcriptVersion: React.RefObject<Map<string, number>>;
  streamDeltaCoalescerRef: React.RefObject<StreamDeltaCoalescer | null>;
  commitFetchedTranscript: (
    key: string,
    fetched: ChatMessage[],
    mode: 'full' | 'tail' | 'append',
    version?: number,
    repair?: boolean,
    settlements?: readonly ToolResultSettlement[],
    liveOutputs?: readonly LiveToolOutput[]
  ) => void;
  canBufferStreamDeltas: (instanceId: string, sessionId: string) => boolean;
  applyStreamDeltas: (instanceId: string, sessionId: string, deltas: LiveDelta[]) => boolean;
  refreshMessages: (ref: SessionRef, afterCurrent?: boolean) => Promise<void>;
  refreshMessageTail: (ref: SessionRef) => Promise<void>;
  refreshMessageSummary: (ref: SessionRef) => Promise<void>;
};

/**
 * Owns instance discovery & probing, startup settings hydration, REST resource refreshers,
 * the coalescing `InvalidationQueue`, `StreamDeltaCoalescer`, event stream subscription,
 * live/dead safety polling, rail preview warming, and visible-column transcript refresh/polling.
 */
export function useInstancePollingAndStreams({
  instances,
  setInstances,
  setRefreshing,
  setLoading,
  setInstancesLoaded,
  projectsByInstance,
  setProjectsByInstance,
  projectsByInstanceRef,
  sessionsByInstance,
  setSessionsByInstance,
  sessionsByInstanceRef,
  statesByInstance,
  setStatesByInstance,
  setStateReadAt,
  permissionsByInstance,
  setPermissionsByInstance,
  questionsByInstance,
  setQuestionsByInstance,
  queuesByInstance,
  setQueuesByInstance,
  setModelsByInstance,
  setAutoAcceptByInstance,
  liveInstances,
  setLiveInstances,
  setSummaries,
  setHistoryIncomplete,
  setScheduledTaskNames,
  setScheduledTasksByKey,
  setOpenSessions,
  setActiveSession,
  setMinimizedSessions,
  workspaceHydratedRef,
  settings,
  settingsLoaded,
  settingsRef,
  hydrateSettings,
  refreshHarnessSettings,
  markSettingsLoaded,
  handleSettings,
  showActionError,
  hidden,
  readyIds,
  readyKey,
  sessions,
  states,
  crewNeedsInputKeys,
  selected,
  selectedSession,
  selectedSessionRef,
  watchedSessionKeys,
  watchedSessionKeysRef,
  activeSessionRef,
  openSessionsRef,
  threadModalKey,
  threadModalKeyRef,
  pendingCreatesRef,
  allocateFor,
  reserveIdentity,
  messageCacheRef,
  summariesRef,
  transcriptVersion,
  streamDeltaCoalescerRef,
  commitFetchedTranscript,
  canBufferStreamDeltas,
  applyStreamDeltas,
  refreshMessages,
  refreshMessageTail,
  refreshMessageSummary,
}: Options) {
  const instanceSnapshotRevision = React.useRef(0);
  const readInstances = useStableCallback(async (refresh: boolean = true) => {
    const revision = ++instanceSnapshotRevision.current;
    const list = await listInstances(refresh);
    if (revision !== instanceSnapshotRevision.current) return;
    setInstances((previous) => shareValue(previous, list));
    setInstancesLoaded(true);
  });

  const refreshInstances = React.useCallback(async function refreshInstances(purpose?: 'versions') {
    setRefreshing(true);
    showActionError(null);
    // A connection retry re-arms dismissed outages. Reading versions is not a request to
    // bring those warnings back (or write settings from the remote browser).
    if (purpose !== 'versions' && settingsRef.current.dismissedOutages.length > 0) {
      void handleSettings({ dismissedOutages: [] });
    }
    try {
      await readInstances();
    } catch (err) {
      showActionError(
        err instanceof Error ? err.message : 'Could not reprobe instances.',
        () => void refreshInstances(purpose)
      );
    } finally {
      setRefreshing(false);
    }
  }, [showActionError, readInstances, handleSettings, settingsRef, setRefreshing]);

  // Startup: probe instances and hydrate persisted settings + workspace once.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const instanceRequest = readInstances();
        void instanceRequest.catch(() => {});
        const stored = await window.ember.getSettings();
        if (cancelled) return;
        hydrateSettings(stored);
        // Restore the workspace before the persistence effect can fire, so the first open
        // session list isn't overwritten with the empty defaults.
        setOpenSessions(stored.openSessions ?? []);
        setActiveSession(stored.activeSession ?? null);
        setMinimizedSessions(new Set(stored.minimizedSessions ?? []));
        workspaceHydratedRef.current = true;
        await instanceRequest;
      } catch (err) {
        if (cancelled) return;
        markSettingsLoaded();
        setLoading(false);
        showActionError(
          err instanceof Error ? err.message : 'Ember could not finish starting.',
          () => window.location.reload()
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    hydrateSettings,
    markSettingsLoaded,
    showActionError,
    readInstances,
    setActiveSession,
    setLoading,
    setMinimizedSessions,
    setOpenSessions,
    workspaceHydratedRef,
  ]);

  const scheduledBindingsRef = React.useRef<Record<string, string>>(settings.scheduledSessionBindings);
  scheduledBindingsRef.current = settings.scheduledSessionBindings;

  const refreshScheduled = useStableCallback(async (instanceIds: string[]) => {
    const projects = projectsByInstanceRef.current;
    // A Hearth serves every task in one aggregate request and has no project list, so it is a target
    // as soon as it is ready; an OpenChamber instance needs its projects to ask per project.
    const targets = instanceIds.filter(
      (instanceId) => isPiInstance(instanceId) || (projects[instanceId] ?? []).length > 0
    );
    if (targets.length === 0) return;
    try {
      const results = await Promise.all(
        targets.map((instanceId) => loadScheduledIdentityData(instanceId, projects[instanceId] ?? []))
      );
      const discovered: Record<string, string> = Object.assign({}, ...results.map((result) => result.bindings));
      const names: Record<string, string> = Object.assign({}, ...results.map((result) => result.taskNames));
      setScheduledTaskNames((prev) => ({ ...prev, ...names }));
      // Replace each refreshed instance's tasks wholesale so a deleted task can't linger; other
      // instances keep their last good snapshot.
      const refreshed = new Set(targets);
      setScheduledTasksByKey((prev) => {
        const next: Record<string, ScheduledTask> = {};
        for (const [key, task] of Object.entries(prev)) {
          if (!refreshed.has(task.instanceId)) next[key] = task;
        }
        results.forEach((result) =>
          result.tasks.forEach((task) => {
            next[task.key] = task;
          })
        );
        return next;
      });
      const merged = mergeScheduledSessionBindings(scheduledBindingsRef.current, discovered);
      if (!sameStringRecord(merged, scheduledBindingsRef.current)) {
        scheduledBindingsRef.current = merged;
        void handleSettings({ scheduledSessionBindings: merged });
      }
    } catch (err) {
      console.warn('Failed to load scheduled task identities', err);
    }
  });

  // Per-instance data that rarely changes: projects, models.
  React.useEffect(() => {
    if (readyIds.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        await Promise.all(
          readyIds.map(async (id) => {
            const [projects, models] = await Promise.all([loadAllProjects([id]), loadModels(id)]);
            if (cancelled) return;
            // An instance that failed to answer is absent from these maps; keep its previous data.
            if (Object.keys(projects).length > 0) {
              projectsByInstanceRef.current = { ...projectsByInstanceRef.current, ...projects };
              setProjectsByInstance((prev) => ({ ...prev, ...projects }));
              if (!isPiInstance(id) && (projects[id]?.length ?? 0) > 0) {
                void refreshScheduled([id]);
              }
            }
            if (models) setModelsByInstance((prev) => ({ ...prev, [id]: models }));
          })
        );
      } catch (err) {
        if (!cancelled) {
          showActionError(err instanceof Error ? err.message : 'Could not load instance metadata.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readyKey is the stable string form of readyIds; refs carry the rest
  }, [readyKey]);

  const refreshModels = useStableCallback(
    async (instanceId: string, options?: { upstream?: boolean; providers?: readonly string[] }) => {
      const knownPi = isPiInstance(instanceId) || settings.piEndpoints.some((endpoint) => endpoint.id === instanceId);
      const loader =
        options?.upstream === false
          ? () => (knownPi ? piLoadModels(instanceId) : loadModels(instanceId))
          : () => (knownPi ? piRefreshModels(instanceId, options?.providers) : refreshInstanceModels(instanceId, options?.providers));
      const next = await loader().catch(() => null);
      if (next) setModelsByInstance((previous) => shareValue(previous, { ...previous, [instanceId]: next }));
      else if (options?.upstream !== false) showActionError('Could not refresh models. Your model selection has not changed.');
    }
  );

  // ---- Refreshers: one per REST resource. Timers and event hints both call these. ----
  // Each takes the instance ids to refresh and merges the result into state, leaving other
  // instances untouched. Failure preserves prior state (the loaders return null / omit keys).

  // Directories named by prompt events (question/permission). OpenCode scopes prompts by directory,
  // and the event's directory is authoritative, so keep asking for it even when it isn't the
  // session folder we already know.
  const promptDirectoriesRef = React.useRef<Record<string, string[]>>({});
  const directoryHintsFor = React.useCallback(
    (instanceIds: string[]): Record<string, string[]> => {
      const hints: Record<string, string[]> = {};
      const add = (instanceId: string | undefined, directory: string | undefined) => {
        if (!instanceId || !directory || !instanceIds.includes(instanceId)) return;
        const list = hints[instanceId] ?? (hints[instanceId] = []);
        if (!list.includes(directory)) list.push(directory);
      };
      // Every open session (columns and tabs), not just the active one: OpenCode scopes prompts by
      // directory, so a question in a background column must still be listed for its card to appear.
      add(selectedSessionRef.current?.instanceId, selectedSessionRef.current?.directory);
      [...openSessionsRef.current, ...(threadModalKeyRef.current ? [threadModalKeyRef.current] : [])].forEach((key) => {
        const ref = parseSessionKey(key);
        if (!ref) return;
        const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find(
          (entry) => entry.id === ref.sessionId
        );
        add(ref.instanceId, session?.directory);
        if (session) {
          const all = Object.values(sessionsByInstanceRef.current).flat();
          threadDescendants(session, crewByLeader(all)).forEach((worker) => add(worker.instanceId, worker.directory));
        }
      });
      // The exact directory a pending prompt event reported, when it differs from the session folder.
      instanceIds.forEach((instanceId) => {
        (promptDirectoriesRef.current[instanceId] ?? []).forEach((directory) => add(instanceId, directory));
      });
      return hints;
    },
    [openSessionsRef, selectedSessionRef, sessionsByInstanceRef, threadModalKeyRef]
  );

  /**
   * OpenCode scopes pending prompts by project, so a refresh only sees the directories it asks for.
   * Keep asking for every directory that already holds a pending permission/question; otherwise
   * browsing to another session drops the old directory and the prompt vanishes from the UI.
   */
  const promptHintsFor = React.useCallback(
    (
      instanceIds: string[],
      known: Record<string, Array<{ directory?: string }>>
    ): Record<string, string[]> => {
      const hints = directoryHintsFor(instanceIds);
      instanceIds.forEach((instanceId) => {
        const directories = new Set(hints[instanceId] ?? []);
        (known[instanceId] ?? []).forEach((entry) => {
          if (entry.directory) directories.add(entry.directory);
        });
        if (directories.size > 0) hints[instanceId] = [...directories];
      });
      return hints;
    },
    [directoryHintsFor]
  );

  const pendingCreatedSessions = React.useRef(new Map<string, { session: Session; expiresAt: number }>());
  // Snapshot the entries first: deleting from a Map while `forEach`-ing it can skip entries.
  const prunePendingCreated = React.useCallback(
    (shouldDrop: (pending: { session: Session; expiresAt: number }) => boolean) => {
      [...pendingCreatedSessions.current.entries()].forEach(([key, pending]) => {
        if (shouldDrop(pending)) pendingCreatedSessions.current.delete(key);
      });
    },
    []
  );
  const identityDiscovery = React.useRef<SessionDiscoveryState>({});
  const sessionReads = React.useRef(new ReadCoordinator());
  const sessionFullReadAt = React.useRef(new Map<string, number>());

  const refreshSessions = useStableCallback(async (instanceIds: string[], deep = false): Promise<void> => {
    if (instanceIds.length > 1) {
      await Promise.all(instanceIds.map((id) => refreshSessions([id], deep)));
      return;
    }
    const id = instanceIds[0];
    if (!id) return;
    return sessionReads.current.run(id, deep ? 'full' : 'tail', async () => {
      try {
        const full = deep || Date.now() - (sessionFullReadAt.current.get(id) ?? 0) > 300_000;
        const next = await loadAllSessions(instanceIds, directoryHintsFor(instanceIds), deep ? 1000 : full ? 10 : 1);
        if (next[id] && full) {
          sessionFullReadAt.current.set(id, Date.now());
          setHistoryIncomplete((prev) => ({ ...prev, [id]: isPartialSessionList(next[id]) }));
        }
        const now = Date.now();
        if (next[id]) {
          const discovered = observeSessionDiscovery(identityDiscovery.current, id, next[id], {
            // Kiln's route scans every conversation, including archived chats and workers. Legacy
            // directory-scoped pages cannot prove absence, even when their own cursor is exhausted.
            completeSnapshot: isPiInstance(id) && !isPartialSessionList(next[id]),
          });
          identityDiscovery.current = discovered.state;
          if (settingsLoaded && !hidden.has(id)) {
            const assignments: Record<string, AvatarAssignment> = {};
            const arriving = [...discovered.eligible].sort((a, b) => sessionKey(a).localeCompare(sessionKey(b)));
            for (const session of arriving) {
              if (settingsRef.current.avatarAssignments[sessionKey(session)]) continue;
              // A local create owns its draft reservation, including an ambiguous lost response.
              // Discovery offers it again on the next poll if this was merely a concurrent request.
              if (
                pendingCreatesRef.current.some(
                  (pending) =>
                    pending.options.instanceId === id &&
                    (pending.phase === 'creating' ||
                      (pending.title === session.title && pending.options.directory === session.directory))
                )
              ) {
                continue;
              }
              const assignment = allocateFor(session, arriving);
              reserveIdentity(session, assignment);
              assignments[sessionKey(session)] = assignment;
            }
            // One settings write for a whole arriving batch, with synchronous reservations between
            // choices so later members compare against the colours already chosen for earlier ones.
            if (Object.keys(assignments).length) {
              void handleSettings(
                { avatarAssignments: { ...settingsRef.current.avatarAssignments, ...assignments } },
                { preserveActionError: true }
              );
            }
          }
        }
        prunePendingCreated(
          (pending) =>
            pending.expiresAt <= now ||
            Boolean(next[pending.session.instanceId]?.some((session) => session.id === pending.session.id))
        );
        const preserved = [
          ...(selectedSessionRef.current ? [selectedSessionRef.current] : []),
          ...[...pendingCreatedSessions.current.values()].map((pending) => pending.session),
        ];
        setSessionsByInstance((prev) => mergePolledSessions(prev, next, preserved));
        setLoading(false);
      } catch (err) {
        console.error('Failed to load sessions', err);
      }
    });
  });

  const refreshAutoAccept = useStableCallback(async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return;
    const policies = await loadAllAutoAcceptPolicies(instanceIds).catch(() => ({}));
    setAutoAcceptByInstance((prev) => shareValue(prev, { ...prev, ...policies }));
  });

  const refreshStates = useStableCallback(async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return;
    const next = await loadAllSessionStates(instanceIds).catch(() => ({}));
    // Only instances that actually answered are in `next`; a failed one is left out, so its
    // timestamp ages and its sessions fall to `unknown` instead of keeping a stale verdict.
    const answered = Object.keys(next);
    if (answered.length > 0) {
      const at = Date.now();
      setStateReadAt((prev) => {
        const updated = { ...prev };
        answered.forEach((id) => {
          updated[id] = at;
        });
        return updated;
      });
    }
    setStatesByInstance((prev) => shareValue(prev, { ...prev, ...next }));
  });

  const refreshPermissions = useStableCallback(async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return;
    const next = await loadAllPermissions(instanceIds, promptHintsFor(instanceIds, permissionsByInstance)).catch(() => ({}));
    setPermissionsByInstance((prev) => shareValue(prev, { ...prev, ...next }));
  });

  const refreshQuestions = useStableCallback(async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return;
    const next = await loadAllQuestions(instanceIds, promptHintsFor(instanceIds, questionsByInstance)).catch(() => ({}));
    setQuestionsByInstance((prev) => shareValue(prev, { ...prev, ...next }));
  });

  const refreshQueues = useStableCallback(async (instanceIds: string[]) => {
    if (instanceIds.length === 0) return;
    const next = await loadAllMessageQueues(instanceIds).catch(() => ({}));
    setQueuesByInstance((prev) => mergePolledQueues(prev, next));
  });

  // ---- Event streams: hints invalidate, refreshers refetch. ----
  const liveInstancesRef = React.useRef(liveInstances);
  liveInstancesRef.current = liveInstances;
  const bootstrappedReadyIdsRef = React.useRef(new Map<string, number>());
  const disconnectedStreamsRef = React.useRef(new Set<string>());

  const refetch = useStableCallback(async ({ instanceId, resource, sessionId, messageMode }: Invalidation) => {
    switch (resource) {
      case 'sessions':
        await refreshSessions([instanceId]);
        break;
      case 'states':
        await refreshStates([instanceId]);
        break;
      case 'permissions':
        await refreshPermissions([instanceId]);
        break;
      case 'questions':
        await refreshQuestions([instanceId]);
        break;
      case 'queues':
        await refreshQueues([instanceId]);
        break;
      case 'autoAccept':
        await refreshAutoAccept([instanceId]);
        break;
      case 'scheduled':
        await refreshScheduled([instanceId]);
        break;
      case 'messages':
        if (sessionId) {
          if (messageMode === 'full') await refreshMessages({ instanceId, sessionId }, true);
          else await refreshMessageTail({ instanceId, sessionId });
        }
        break;
      case 'messageSummary':
        if (sessionId) await refreshMessageSummary({ instanceId, sessionId });
        break;
    }
  });
  const invalidationQueue = React.useMemo(() => new InvalidationQueue(refetch), [refetch]);
  const deltaCoalescer = React.useMemo(
    () =>
      new StreamDeltaCoalescer((instanceId, sessionId, deltas) => {
        if (applyStreamDeltas(instanceId, sessionId, deltas)) return;
        const loaded = (instId: string, sessId: string) =>
          sessionIsLoaded(
            { instanceId: instId, sessionId: sessId },
            watchedSessionKeysRef.current,
            activeSessionRef.current,
            document.hidden
          );
        invalidationsFor({ instanceId, type: 'pi:message_update', sessionId }, loaded).forEach(
          (invalidation) => invalidationQueue.push(invalidation)
        );
      }),
    [activeSessionRef, applyStreamDeltas, invalidationQueue, watchedSessionKeysRef]
  );
  streamDeltaCoalescerRef.current = deltaCoalescer;

  React.useEffect(() => {
    const bridge = window.ember;
    if (!bridge.onEvent) return;
    const readySet = new Set(readyIds);
    // A message hint is worth a transcript fetch only for a session the user is looking at; other
    // sessions (tabs, minimized) fall back to refreshing the session list. `sessionIsLoaded` also
    // counts the active session when it is not a column, which is what keeps streaming reasoning
    // visible in a sticky-minimized active session.
    const isLoaded = (instanceId: string, sessionId: string) =>
      sessionIsLoaded(
        { instanceId, sessionId },
        watchedSessionKeysRef.current,
        activeSessionRef.current,
        document.hidden
      );

    const catchUp = (instanceId: string) => {
      // The stream just (re)connected; anything that changed while it was down was missed.
      (['sessions', 'states', 'permissions', 'questions', 'queues', 'autoAccept', 'scheduled'] as const).forEach((resource) =>
        invalidationQueue.push({ instanceId, resource })
      );
      watchedSessionKeysRef.current.forEach((key) => {
        const ref = parseSessionKey(key);
        if (ref?.instanceId === instanceId) {
          invalidationQueue.push({
            instanceId,
            resource: 'messages',
            sessionId: ref.sessionId,
            messageMode: 'tail',
          });
        }
      });
    };

    const unsubscribe = bridge.onEvent((raw) => {
      const event = parseEmberEvent(raw);
      if (event?.type === 'ember:instances-updated') {
        void readInstances(false).catch(() => {});
        void refreshHarnessSettings().catch(() => {});
        return;
      }
      if (!event) return;
      // Liveness is recorded before the ready check. A Hearth endpoint opens its sockets as soon as
      // the settings are read, which can be before the instance is in `readyIds`; a status dropped
      // there left that instance on the fast cadence until its next reconnect.
      if (event.type === 'ember:stream-status') {
        const connected = event.connected === true;
        const wasConnected = liveInstancesRef.current[event.instanceId] === true;
        if (wasConnected === connected) return;
        if (!connected && wasConnected) disconnectedStreamsRef.current.add(event.instanceId);
        liveInstancesRef.current = { ...liveInstancesRef.current, [event.instanceId]: connected };
        setLiveInstances(liveInstancesRef.current);
        if (connected && readySet.has(event.instanceId)) {
          const reconnected = disconnectedStreamsRef.current.delete(event.instanceId);
          const bootstrappedAt = bootstrappedReadyIdsRef.current.get(event.instanceId) ?? 0;
          if (reconnected || Date.now() - bootstrappedAt >= 1_000) {
            catchUp(event.instanceId);
          }
        }
        return;
      }
      if (!readySet.has(event.instanceId)) return;
      // Whitelisted milestones carry a bounded summary; those become live activity entries.
      // Flush any buffered rAF deltas synchronously before terminal boundaries so settled reads
      // and idle states never lag behind a pending animation frame.
      if (isTerminalStreamEvent(event.type)) {
        if (event.sessionId) deltaCoalescer.flushSession(event.instanceId, event.sessionId);
        else deltaCoalescer.flushInstance(event.instanceId);
      }
      // A streamed chunk carries the append itself, so a watching column can coalesce deltas per
      // animation frame instead of re-rendering per token or reading the transcript again. Anything
      // this cannot buffer or apply falls through to the invalidation below.
      if (
        APPLY_STREAM_DELTAS &&
        event.type === 'pi:message_update' &&
        event.deltas &&
        event.deltas.length > 0 &&
        event.sessionId &&
        canBufferStreamDeltas(event.instanceId, event.sessionId)
      ) {
        deltaCoalescer.push(event.instanceId, event.sessionId, event.deltas);
        return;
      }
      if (event.directory && (event.type.startsWith('question.') || event.type.startsWith('permission.'))) {
        const list =
          promptDirectoriesRef.current[event.instanceId] ??
          (promptDirectoriesRef.current[event.instanceId] = []);
        if (!list.includes(event.directory)) {
          list.push(event.directory);
          if (list.length > 40) list.splice(0, list.length - 40);
        }
      }
      invalidationsFor(event, isLoaded).forEach((invalidation) => invalidationQueue.push(invalidation));
    });
    void bridge.eventStatus?.().then((status) => {
      liveInstancesRef.current = { ...liveInstancesRef.current, ...status };
      setLiveInstances(liveInstancesRef.current);
    }).catch(() => {});

    const resume = () => {
      if (!document.hidden) {
        void readInstances().catch(() => {});
        readyIds.forEach(catchUp);
      }
    };
    const online = () => {
      // Resume also reprobes, so unreachable hosts reattach without waiting for the watchdog.
      resume();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', online);
    window.addEventListener('pageshow', resume);
    window.addEventListener('ember:remote-resume', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', online);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('ember:remote-resume', resume);
      unsubscribe();
      deltaCoalescer.flushAll();
      invalidationQueue.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readyKey is the stable string form of readyIds; refs carry the rest
  }, [readyKey, invalidationQueue, deltaCoalescer]);

  // ---- Polling: the safety net. Instances with a live stream poll slowly; the rest fast. ----
  // Split by liveness so one instance that can't stream (older OpenChamber, flaky tunnel)
  // doesn't drag the others back to the fast cadence.
  const liveIds = React.useMemo(() => readyIds.filter((id) => liveInstances[id]), [readyIds, liveInstances]);
  const deadIds = React.useMemo(() => readyIds.filter((id) => !liveInstances[id]), [readyIds, liveInstances]);
  const liveIdsRef = React.useRef(liveIds);
  liveIdsRef.current = liveIds;
  const deadIdsRef = React.useRef(deadIds);
  deadIdsRef.current = deadIds;
  const readyIdsRef = React.useRef(readyIds);
  readyIdsRef.current = readyIds;

  const refreshListFor = useStableCallback(async (ids: string[]) => {
    await Promise.all([refreshSessions(ids), refreshAutoAccept(ids)]);
  });
  const refreshStateFor = useStableCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => Promise.all([refreshStates([id]), refreshQueues([id])])));
  });
  /** Prompts keep their own cadence: parked approvals and questions are poll-only. */
  const refreshPromptsFor = useStableCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => Promise.all([refreshPermissions([id]), refreshQuestions([id])])));
  });

  React.useEffect(() => {
    const activeReady = new Set(readyIds);
    for (const id of bootstrappedReadyIdsRef.current.keys()) {
      if (!activeReady.has(id)) bootstrappedReadyIdsRef.current.delete(id);
    }
    const newlyReady = readyIds.filter((id) => !bootstrappedReadyIdsRef.current.has(id));
    if (newlyReady.length === 0) return;
    const at = Date.now();
    newlyReady.forEach((id) => {
      bootstrappedReadyIdsRef.current.set(id, at);
      void refreshListFor([id]);
      void refreshStateFor([id]);
      void refreshPromptsFor([id]);
    });
    // Hearth scheduled tasks are one aggregate request, so load them as soon as a pi instance
    // is ready (the OpenChamber path loads once projects arrive, then stays on its rare poll).
    const piIds = newlyReady.filter((id) => isPiInstance(id));
    if (piIds.length > 0) void refreshScheduled(piIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readyKey is the stable string form of readyIds
  }, [readyKey, refreshListFor, refreshStateFor, refreshPromptsFor, refreshScheduled]);

  usePoll(() => refreshListFor(deadIdsRef.current), SESSION_POLL_MS, deadIds.length > 0, { immediate: false });
  usePoll(() => refreshListFor(liveIdsRef.current), SESSION_POLL_LIVE_MS, liveIds.length > 0, { immediate: false });
  usePoll(() => refreshStateFor(deadIdsRef.current), STATE_POLL_MS, deadIds.length > 0, { immediate: false });
  usePoll(() => refreshStateFor(liveIdsRef.current), STATE_POLL_LIVE_MS, liveIds.length > 0, { immediate: false });
  usePoll(() => refreshPromptsFor(readyIdsRef.current), PROMPT_POLL_MS, readyIds.length > 0, { immediate: false });

  // Scheduled-task identity is one request per project (70+ on a busy instance), so it polls
  // rarely; the `scheduled-task-ran` event covers the moment it actually matters. Hearth serves
  // one aggregate request and has no project list, so pi instances count as known too.
  const projectsKnown =
    Object.keys(projectsByInstance).length > 0 || instances.some((instance) => instance.kind === 'pi');
  usePoll(() => refreshScheduled(deadIdsRef.current), SCHEDULE_POLL_MS, projectsKnown && deadIds.length > 0, {
    immediate: false,
  });
  usePoll(() => refreshScheduled(liveIdsRef.current), SCHEDULE_POLL_LIVE_MS, projectsKnown && liveIds.length > 0, {
    immediate: false,
  });

  // Reads for a session the user just brought on screen. Preview warming waits for them so a burst
  // of background tails can't queue ahead of the transcript being looked at.
  const priorityReads = React.useRef(new Set<Promise<void>>());
  const statesRef = React.useRef(states);
  statesRef.current = states;
  const statesByInstanceRef = React.useRef(statesByInstance);
  statesByInstanceRef.current = statesByInstance;
  // The rail's "needs input" keys (a session's own flag, plus a blocked crew rolled up to its
  // leader), read through a ref so a poll that flips one mid-batch only re-ranks the next batch.
  const needsInputRef = React.useRef(crewNeedsInputKeys);
  needsInputRef.current = crewNeedsInputKeys;
  // Whether an instance's prompt lists are loaded, through a ref: the prompts poll re-renders every
  // few seconds and must not cancel a preview batch in flight (the transcript deps are the only
  // reason this effect re-runs).
  const loadedPromptsRef = React.useRef({ permissions: permissionsByInstance, questions: questionsByInstance });
  loadedPromptsRef.current = { permissions: permissionsByInstance, questions: questionsByInstance };
  // Prompt warm requests already in flight, so repeated session polls can't multiply them.
  const promptWarmInFlight = React.useRef(new Set<string>());
  // Read from callbacks that must not re-create on every poll.
  const queuesRef = React.useRef(queuesByInstance);
  queuesRef.current = queuesByInstance;

  // Preview warming refreshes compact summaries, and folds the tail into a transcript that is
  // already cached (never inserting one). The effect reads summaries through a ref so a poll that
  // lands mid-batch doesn't cancel it.
  //
  // A blocked session outranks a working one. An `active` agent is making progress on its own; a
  // `needsInput` one has stopped until a human answers, so that is the click that matters and the
  // card behind it should already be painted. The order is the only thing that changed: the window
  // is still the newest PREVIEW_COUNT sessions (picked by recency *before* the re-rank, so no warm
  // can reach past it) and it still runs PREVIEW_CONCURRENCY at a time through PREVIEW_LIMITS, held
  // behind `priorityReads` — so a burst of blocked sessions can never queue ahead of the column
  // being read.
  React.useEffect(() => {
    if (document.hidden) return;
    const rank = (session: Session) =>
      needsInputRef.current.has(sessionKey(session)) ? 2 : statesRef.current[sessionKey(session)] === 'active' ? 1 : 0;
    // A blocked column needs its prompt lists as well as its transcript, and those are per
    // *instance*, not per session: one fetch per instance holding a blocked session, whatever the
    // size of its crew or its rail. Skipped once both lists are loaded, because from then on the
    // prompts poll owns them and the card is already in state — so this only ever pays for a cold
    // instance. Cost is bounded by the instance count, never by PREVIEW_COUNT.
    const promptInstances = new Set<string>();
    sessions.forEach((session) => {
      if (needsInputRef.current.has(sessionKey(session))) promptInstances.add(session.instanceId);
    });
    promptInstances.forEach((instanceId) => {
      const loaded = loadedPromptsRef.current;
      if (loaded.permissions[instanceId] !== undefined && loaded.questions[instanceId] !== undefined) return;
      if (promptWarmInFlight.current.has(instanceId)) return;
      promptWarmInFlight.current.add(instanceId);
      void refreshPromptsFor([instanceId]).finally(() => promptWarmInFlight.current.delete(instanceId));
    });
    const targets = [...sessions]
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, PREVIEW_COUNT)
      .sort((a, b) => rank(b) - rank(a))
      .filter((session) => {
        const summary = summariesRef.current[sessionKey(session)];
        return !summary || summary.version !== session.updated;
      });
    if (targets.length === 0) return;
    let cancelled = false;

    void (async () => {
      const results: Array<readonly [string, SessionMessageSummary]> = [];
      let cursor = 0;
      const loadNext = async (): Promise<void> => {
        while (!cancelled && cursor < targets.length) {
          const session = targets[cursor];
          cursor += 1;
          const key = sessionKey(session);
          const previous = summariesRef.current[key];
          let summary: SessionMessageSummary | null = null;
          let lastTail: ChatMessage[] | null = null;
          for (const limit of PREVIEW_LIMITS) {
            if (priorityReads.current.size > 0) await Promise.allSettled([...priorityReads.current]);
            if (cancelled) break;
            const tail = await loadMessageTail(
              session.instanceId,
              session.id,
              session.directory,
              limit
            ).catch(() => null);
            // A failed request leaves the prior summary in place.
            if (!tail || cancelled) break;
            lastTail = tail;
            summary = summarizeMessages(tail, { previous, complete: false, version: session.updated });
            // Stop once a previewable turn is found, or once the transcript is exhausted; otherwise
            // expand through 32 and 128. A tool-only tail at the largest limit retains `previous`.
            if (summary.preview || summary.failed || tail.length < limit) break;
          }
          if (lastTail && !cancelled && messageCacheRef.current.has(key)) {
            commitFetchedTranscript(key, lastTail, 'tail', session.updated, false);
          }
          if (summary) results.push([key, summary]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PREVIEW_CONCURRENCY, targets.length) }, () => loadNext())
      );
      if (cancelled || results.length === 0) return;
      setSummaries((prev) => {
        let changed = false;
        const next = { ...prev };
        results.forEach(([key, summary]) => {
          const existing = prev[key];
          if (existing && sameSummary(existing, summary)) return;
          next[key] = summary;
          changed = true;
        });
        return changed ? next : prev;
      });
    })();

    return () => {
      cancelled = true;
    };
    // `refreshPromptsFor` is a stable callback; listing it keeps the lint honest without re-running.
  }, [sessions, commitFetchedTranscript, refreshPromptsFor, messageCacheRef, setSummaries, summariesRef]);

  /**
   * Bring an on-screen transcript up to date via a bounded tail/append read.
   *
   * Opening a session must stay fast even when its JSONL file is tens of megabytes: a real long
   * session can carry 45MB of tool output where the tail page is ~24KB and paints immediately.
   * When older messages remain on the host (`historyComplete` is false), Transcript renders the
   * sticky "Earlier messages aren't loaded yet" strip above the scroller and loads the full history
   * lazily on demand ("Load them", Find, or quote jumps).
   */
  const shownTranscriptThisTick = React.useRef(new Set<string>());
  const showTranscript = useStableCallback((ref: SessionRef) => {
    const key = sessionKey(ref);
    if (shownTranscriptThisTick.current.has(key)) return;
    shownTranscriptThisTick.current.add(key);
    queueMicrotask(() => shownTranscriptThisTick.current.delete(key));
    const read = refreshMessageTail(ref);
    priorityReads.current.add(read);
    void read.finally(() => priorityReads.current.delete(read));
    // A prompt raised while this column was off screen would otherwise not appear until the next
    // poll or reload: the question list is fetched per directory on hints, and switching to a
    // session is not a hint. Ask for it as the column comes on screen.
    void refreshQuestions([ref.instanceId]);
  });

  // Selecting a column refreshes it immediately; the poll below (and message events) keep it
  // fresh while the agent is working.
  const selectedMetadataKey = selectedSession
    ? `${sessionKey(selectedSession)}\u0000${selectedSession.directory ?? ''}`
    : null;
  React.useEffect(() => {
    if (selected && selectedMetadataKey) showTranscript(selected);
  }, [selected, selectedMetadataKey, showTranscript]);

  // Every column that just came on screen refreshes, however recently it was read. One already on
  // screen refreshes when the session list says it moved past the version its transcript reflects,
  // which also covers stream events lost to a dropped connection.
  const previouslyVisible = React.useRef(new Set<string>());
  React.useEffect(() => {
    const known = new Set<string>();
    for (const key of watchedSessionKeys) {
      const ref = parseSessionKey(key);
      const session = ref && (sessionsByInstance[ref.instanceId] ?? []).find((entry) => entry.id === ref.sessionId);
      if (!ref || (!session && key !== threadModalKey)) continue;
      known.add(key);
      const behind = (session?.updated ?? 0) > (transcriptVersion.current.get(key) ?? -1);
      if (!previouslyVisible.current.has(key) || behind) showTranscript(ref);
    }
    previouslyVisible.current = known;
  }, [watchedSessionKeys, sessionsByInstance, showTranscript, threadModalKey, transcriptVersion]);

  // Only the columns actually on screen poll their transcripts; overflow/minimized tabs rely on
  // the preview cache and the session list's `updated`.
  const columnIsLive = React.useCallback(
    (ref: SessionRef | null): boolean => (ref ? liveInstances[ref.instanceId] === true : false),
    [liveInstances]
  );
  const columnsLive =
    watchedSessionKeys.length > 0 && watchedSessionKeys.every((key) => columnIsLive(parseSessionKey(key)));
  // A turn in flight is the one case where a single dropped hint leaves a reply unseen, and the
  // wire has no sequence number that would let a reader notice the gap. So a busy column keeps the
  // fast cadence even when its instance streams: the safety net's job is to miss less, and that is
  // when it matters. Idle sessions -- the common case -- take the slow cadence.
  const anyColumnBusy = watchedSessionKeys.some((key) => states[key] === 'active');
  usePoll(
    async () => {
      await Promise.all(
        watchedSessionKeysRef.current.map((key) => {
          const ref = parseSessionKey(key);
          if (
            !ref ||
            document.hidden ||
            !(sessionsByInstanceRef.current[ref.instanceId] ?? []).some((session) => session.id === ref.sessionId)
          ) {
            return Promise.resolve();
          }
          // Bounded incremental/tail refresh (`loadMessageAppend` / `reconcileTranscriptTail`);
          // `commitFetchedTranscript` requests a full repair only when a tail cannot safely overlap.
          return refreshMessageTail(ref);
        })
      );
    },
    anyColumnBusy || !columnsLive ? STATE_POLL_MS : MESSAGES_POLL_LIVE_MS,
    watchedSessionKeys.length > 0,
    { immediate: false }
  );

  return {
    readInstances,
    refreshInstances,
    refreshModels,
    promptHintsFor,
    pendingCreatedSessions,
    prunePendingCreated,
    refreshSessions,
    refreshAutoAccept,
    refreshStates,
    refreshPermissions,
    refreshQuestions,
    refreshQueues,
    refreshScheduled,
    refreshPromptsFor,
    statesRef,
    statesByInstanceRef,
    queuesRef,
  };
}
