import * as React from 'react';
import { MotionConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AutoAcceptPolicy, ModelList, ScheduledTask } from './api';
import { AppDialogs, AppRootOverlays, ModelUsagePanel, ScheduledView } from './app/AppDialogs';
import { FeedbackBanner } from './app/FeedbackBanner';
import { SessionColumn, type SessionColumnSharedProps } from './app/SessionColumn';
import { useAnnotationNavigationGuard, useAnnotationsAndNotes } from './app/useAnnotationsAndNotes';
import { useAvatarIdentities } from './app/useAvatarIdentities';
import { useInstancePollingAndStreams } from './app/useInstancePollingAndStreams';
import { usePruneRemovedInstances } from './app/usePruneRemovedInstances';
import { useSendAndLifecycle } from './app/useSendAndLifecycle';
import { useSessionSelectors } from './app/useSessionSelectors';
import { useTranscriptStore, type PendingSendInput } from './app/useTranscriptStore';
import { useWorkspaceColumns } from './app/useWorkspaceColumns';
import { blobColor } from './blob/color';
import { AvatarSizeContext } from './blob/size';
import { effectiveBlobStyle } from './blob/styles';
import ChatView from './components/ChatView';
import { ImageViewerContext, type ImageViewerApi } from './components/imageViewerContext';
import InstanceBar from './components/InstanceBar';
import { InstanceOutageToasts } from './components/InstanceOutageToasts';
import LeftRail from './components/LeftRail';
import { WorkspaceConnection } from './components/workspaceConnection';
import { useEmberSettings } from './hooks/useEmberSettings';
import { useFeedback } from './hooks/useFeedback';
import type { DelegatorChoices } from './lib/delegatorModels';
import { emptyHomeTarget } from './lib/emptyHome';
import type { ViewerImage } from './lib/gallery';
import { effectiveInstanceDefaultModel, withInstanceDefaultModel } from './lib/instanceDefaultModel';
import type { SessionMessageSummary } from './lib/messageSummary';
import { recentProjectDirectories } from './lib/newSessionDefaults';
import type { PendingCreate } from './lib/pendingCreate';
import { setRemoteActiveWork } from './lib/remoteLifecycle';
import type { RepairHalt } from './lib/repairBudget';
import type { ScheduledModelTarget } from './lib/scheduledView';
import type { SettingsView } from './lib/settingsNavigation';
import { applyTextSizes } from './lib/textSize';
import type { TranscriptState } from './lib/transcriptStatus';
import { useMotionPause } from './lib/useMotionPause';
import { SESSION_WINDOWS, sessionKey } from './types';
import type {
  BallState,
  ChatMessage,
  DraftAppearance,
  Instance,
  MessageQueueSession,
  ModelRef,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from './types';

export default function App() {
  // ---- Instance-owned & workspace state maps (grouped here for cross-cutting lifecycle / pruning) ----
  const [instances, setInstances] = React.useState<Instance[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [instancesLoaded, setInstancesLoaded] = React.useState(false);

  const [projectsByInstance, setProjectsByInstance] = React.useState<Record<string, Project[]>>({});
  const [sessionsByInstance, setSessionsByInstance] = React.useState<Record<string, Session[]>>({});
  const [statesByInstance, setStatesByInstance] = React.useState<Record<string, Record<string, BallState>>>({});
  // When each instance's status endpoint last answered. A session with no answer is `unknown`, not
  // idle, so this is what keeps "we have not heard" distinguishable from "it said nothing is
  // happening" — including after the poll starts failing, when the map above is kept as-is.
  const [stateReadAt, setStateReadAt] = React.useState<Record<string, number>>({});
  const [permissionsByInstance, setPermissionsByInstance] = React.useState<Record<string, PermissionRequest[]>>({});
  const [questionsByInstance, setQuestionsByInstance] = React.useState<Record<string, QuestionRequest[]>>({});
  const [queuesByInstance, setQueuesByInstance] = React.useState<Record<string, MessageQueueSession[]>>({});
  const [modelsByInstance, setModelsByInstance] = React.useState<Record<string, ModelList>>({});
  const [autoAcceptByInstance, setAutoAcceptByInstance] = React.useState<Record<string, AutoAcceptPolicy>>({});
  // Local fallback for instances whose OpenChamber predates server-side auto-accept.
  const [bypassOverrides, setBypassOverrides] = React.useState<Record<string, boolean>>({});
  const [liveInstances, setLiveInstances] = React.useState<Record<string, boolean>>({});

  const [summaries, setSummaries] = React.useState<Record<string, SessionMessageSummary>>({});
  // `failure` records *which path* raised the `'error'` status, because only a failed explicit
  // reload is a settled failure: everything else is retried by the poller and must not be dressed
  // up as a destructive error (see `src/lib/transcriptStatus.ts`). Dropped again on any success.
  const [transcripts, setTranscripts] = React.useState<Record<string, TranscriptState & { messages: ChatMessage[] }>>(
    {}
  );
  const [repairHalts, setRepairHalts] = React.useState<Record<string, RepairHalt>>({});
  const [historyIncomplete, setHistoryIncomplete] = React.useState<Record<string, boolean>>({});
  const [loadingHistory, setLoadingHistory] = React.useState(false);

  const [scheduledTaskNames, setScheduledTaskNames] = React.useState<Record<string, string>>({});
  const [scheduledTasksByKey, setScheduledTasksByKey] = React.useState<Record<string, ScheduledTask>>({});
  const [runningScheduledKeys, setRunningScheduledKeys] = React.useState<Set<string>>(() => new Set());
  const [scheduledModelTarget, setScheduledModelTarget] = React.useState<ScheduledModelTarget | null>(null);

  const [openSessions, setOpenSessions] = React.useState<string[]>([]);
  const [activeSession, setActiveSession] = React.useState<string | null>(null);
  const [minimizedSessions, setMinimizedSessions] = React.useState<Set<string>>(() => new Set());
  // Inspection is not workspace navigation. This key is deliberately never persisted.
  const [threadModalKey, setThreadModalKey] = React.useState<string | null>(null);
  const [newSessionInstanceId, setNewSessionInstanceId] = React.useState<string | null>(null);
  const [newSessionDirectory, setNewSessionDirectory] = React.useState<string | null>(null);

  const [pendingCreates, setPendingCreates] = React.useState<PendingCreate[]>([]);
  const pendingCreatesRef = React.useRef<PendingCreate[]>([]);
  const [draftAppearance, setDraftAppearance] = React.useState<DraftAppearance | null>(null);
  const [draftPendingId, setDraftPendingIdState] = React.useState<string | null>(null);
  const draftPendingIdRef = React.useRef<string | null>(null);
  /** Which attempt the draft pane is showing, if any. Stable so `openSession` can clear it. */
  const setDraftPendingId = React.useCallback((id: string | null) => {
    draftPendingIdRef.current = id;
    setDraftPendingIdState(id);
  }, []);

  const [sendingKeys, setSendingKeys] = React.useState<Set<string>>(() => new Set());
  const [reloadingKeys, setReloadingKeys] = React.useState<Set<string>>(() => new Set());
  // Sessions whose stop was requested but whose abort hasn't reconciled yet: the composer's
  // stop button shows a spinner and the send button stays disabled until the run settles.
  const [stoppingKeys, setStoppingKeys] = React.useState<Set<string>>(() => new Set());
  const [archivingKeys, setArchivingKeys] = React.useState<Set<string>>(() => new Set());
  const [compactingKeys, setCompactingKeys] = React.useState<Set<string>>(() => new Set());
  const [askingSideQuestionKeys, setAskingSideQuestionKeys] = React.useState<Set<string>>(() => new Set());

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsActivated, setSettingsActivated] = React.useState(false);
  const [settingsView, setSettingsView] = React.useState<SettingsView>('providers');
  /** The host whose Providers screen is open, when it was opened from a session's model picker. */
  const [providerEndpointId, setProviderEndpointId] = React.useState<string | undefined>(undefined);
  /** The Usage view, a sibling of Home rather than a dialog over it. */
  const [usageOpen, setUsageOpen] = React.useState(false);
  /** The Scheduled view: runs newest-first and recurring plans, a fourth top-bar tab. */
  const [scheduledOpen, setScheduledOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [archiveConfirmKey, setArchiveConfirmKey] = React.useState<string | null>(null);
  const [avatarPickerSession, setAvatarPickerSession] = React.useState<Session | null>(null);
  /** The crew worker the Promote-to-peer dialog is open for; null when closed. */
  const [promoteTarget, setPromoteTarget] = React.useState<Session | null>(null);
  const [promoteSubmitting, setPromoteSubmitting] = React.useState(false);
  const [promoteError, setPromoteError] = React.useState<string | null>(null);
  /** The image lightbox: a message's gallery and the open index, or null when closed. */
  const [imageViewer, setImageViewer] = React.useState<{ images: ViewerImage[]; index: number } | null>(null);
  const [mobileRailOpen, setMobileRailOpen] = React.useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);

  const sessionsByInstanceRef = React.useRef<Record<string, Session[]>>({});
  sessionsByInstanceRef.current = sessionsByInstance;
  const projectsByInstanceRef = React.useRef<Record<string, Project[]>>({});
  projectsByInstanceRef.current = projectsByInstance;
  const selectedSessionRef = React.useRef<Session | null>(null);
  const onReplayMissingSendRef = React.useRef<((replay: PendingSendInput) => void) | null>(null);

  /** Stable opener for the transcript/markdown; the modal itself lives at the app root. */
  const imageViewerApi = React.useMemo<ImageViewerApi>(
    () => ({
      open: (images, index) => setImageViewer({ images, index }),
      openOne: (image) => setImageViewer({ images: [image], index: 0 }),
    }),
    []
  );

  // Nothing on screen is being looked at; stop animating (one listener for the whole window).
  useMotionPause();

  const {
    actionError,
    actionErrorRetry,
    actionErrorRetryLabel,
    showActionError,
    clearActionErrorRetry,
    errorCopied,
    setErrorCopied,
    actionNotice,
    setActionNotice,
    setNoticePaused,
    statusAnnouncement,
    announceStatus,
  } = useFeedback();

  const clearActionError = React.useCallback(() => showActionError(null), [showActionError]);
  const handleSettingsError = React.useCallback(
    (message: string, retry: () => void, onDismiss?: () => void) => {
      showActionError(message, retry, undefined, onDismiss);
    },
    [showActionError]
  );
  const {
    settings,
    settingsLoaded,
    settingsRef,
    hydrateSettings,
    refreshHarnessSettings,
    markSettingsLoaded,
    updateSettings: handleSettings,
  } = useEmberSettings({ onError: handleSettingsError, onBeforeSave: clearActionError });

  const { annotationNavigationHandlers, navigateWithAnnotations } = useAnnotationNavigationGuard();

  // ---- Workspace columns, active selection, resize observer & shortcuts ----
  const workspace = useWorkspaceColumns({
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
    splitView: settings.splitView,
    settingsRef,
    handleSettings,
    showActionError,
    navigateWithAnnotations,
  });

  // ---- Transcript cache, reconciliation, live deltas & loaders ----
  const transcriptStore = useTranscriptStore({
    transcripts,
    setTranscripts,
    summaries,
    setSummaries,
    setRepairHalts,
    openSessions,
    activeSession,
    minimizedSessions,
    workspaceWidth: workspace.workspaceWidth,
    watchedSessionKeys: workspace.watchedSessionKeys,
    watchedSessionKeysRef: workspace.watchedSessionKeysRef,
    activeSessionRef: workspace.activeSessionRef,
    sessionsByInstanceRef,
    setActionNotice,
    onReplayMissingSendRef,
  });

  // ---- Derived selectors: sessions, crew rollups, states, prompts, unread, scheduled ----
  const selectors = useSessionSelectors({
    instances,
    instancesLoaded,
    projectsByInstance,
    sessionsByInstance,
    statesByInstance,
    stateReadAt,
    permissionsByInstance,
    questionsByInstance,
    queuesByInstance,
    modelsByInstance,
    autoAcceptByInstance,
    bypassOverrides,
    summaries,
    scheduledTasksByKey,
    settings,
    settingsLoaded,
    settingsRef,
    handleSettings,
    activeSession,
    threadModalKey,
    archiveConfirmKey,
    newSessionInstanceId,
    newSessionDirectory,
    messageCacheRef: transcriptStore.messageCacheRef,
  });
  selectedSessionRef.current = selectors.selectedSession;

  // ---- Avatar identities, crew mood alternation, allocations & dock icon ----
  const avatars = useAvatarIdentities({
    sessionsByInstance,
    projectsByInstance,
    sessions: selectors.sessions,
    openSessions,
    states: selectors.states,
    promptKinds: selectors.promptKinds,
    thinkingKeys: selectors.thinkingKeys,
    unreadKeys: selectors.unreadKeys,
    crewWorkers: selectors.crewWorkers,
    workerKeys: selectors.workerKeys,
    threadModalKey,
    selectedKey: selectors.selectedKey,
    settings,
    settingsRef,
    handleSettings,
    pendingCreates,
    draftPendingId,
    avatarPickerSession,
    scheduledTaskNames,
  });

  // ---- Instance polling, event streams, invalidation queue & preview warming ----
  const streams = useInstancePollingAndStreams({
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
    workspaceHydratedRef: workspace.workspaceHydratedRef,
    settings,
    settingsLoaded,
    settingsRef,
    hydrateSettings,
    refreshHarnessSettings,
    markSettingsLoaded,
    handleSettings,
    showActionError,
    hidden: selectors.hidden,
    readyIds: selectors.readyIds,
    readyKey: selectors.readyKey,
    sessions: selectors.sessions,
    states: selectors.states,
    crewNeedsInputKeys: selectors.crewNeedsInputKeys,
    selected: selectors.selected,
    selectedSession: selectors.selectedSession,
    selectedSessionRef,
    watchedSessionKeys: workspace.watchedSessionKeys,
    watchedSessionKeysRef: workspace.watchedSessionKeysRef,
    activeSessionRef: workspace.activeSessionRef,
    openSessionsRef: workspace.openSessionsRef,
    threadModalKey,
    threadModalKeyRef: workspace.threadModalKeyRef,
    pendingCreatesRef,
    allocateFor: avatars.allocateFor,
    reserveIdentity: avatars.reserveIdentity,
    messageCacheRef: transcriptStore.messageCacheRef,
    summariesRef: transcriptStore.summariesRef,
    transcriptVersion: transcriptStore.transcriptVersion,
    streamDeltaCoalescerRef: transcriptStore.streamDeltaCoalescerRef,
    commitFetchedTranscript: transcriptStore.commitFetchedTranscript,
    canBufferStreamDeltas: transcriptStore.canBufferStreamDeltas,
    applyStreamDeltas: transcriptStore.applyStreamDeltas,
    refreshMessages: transcriptStore.refreshMessages,
    refreshMessageTail: transcriptStore.refreshMessageTail,
    refreshMessageSummary: transcriptStore.refreshMessageSummary,
  });

  // ---- Notes, composer drafts, read marks, mute/snooze & quote links ----
  const annotations = useAnnotationsAndNotes({
    instances,
    instancesLoaded,
    sessionsByInstance,
    projectsByInstance,
    activeSession,
    settings,
    settingsLoaded,
    settingsRef,
    handleSettings,
    showActionError,
    setActionNotice,
    unreadDigests: selectors.unreadDigests,
    messageCacheRef: transcriptStore.messageCacheRef,
    transcriptsRef: transcriptStore.transcriptsRef,
    openSession: workspace.openSession,
  });

  // ---- Pending creates, prompt sends, queues & session lifecycle actions ----
  const lifecycle = useSendAndLifecycle({
    instances,
    projectsByInstance,
    projectsByInstanceRef,
    sessionsByInstance,
    setSessionsByInstance,
    sessionsByInstanceRef,
    statesByInstanceRef: streams.statesByInstanceRef,
    setStatesByInstance,
    setStateReadAt,
    setPermissionsByInstance,
    questionsByInstance,
    setQuestionsByInstance,
    queuesByInstance,
    setQueuesByInstance,
    queuesRef: streams.queuesRef,
    modelsByInstance,
    autoAcceptByInstance,
    setAutoAcceptByInstance,
    setBypassOverrides,
    setScheduledTasksByKey,
    setRunningScheduledKeys,
    setScheduledModelTarget,
    setRepairHalts,
    transcripts,
    pendingCreates,
    setPendingCreates,
    pendingCreatesRef,
    draftPendingId,
    draftPendingIdRef,
    setDraftPendingId,
    setDraftAppearance,
    setSendingKeys,
    reloadingKeys,
    setReloadingKeys,
    stoppingKeys,
    setStoppingKeys,
    archivingKeys,
    setArchivingKeys,
    compactingKeys,
    setCompactingKeys,
    askingSideQuestionKeys,
    setAskingSideQuestionKeys,
    activeSession,
    setActiveSession,
    activeSessionRef: workspace.activeSessionRef,
    openSessions,
    openSessionsRef: workspace.openSessionsRef,
    minimizedSessions,
    minimizedKeysRef: workspace.minimizedKeysRef,
    newSessionInstanceId,
    setNewSessionInstanceId,
    setNewSessionDirectory,
    usageOpen,
    setUsageOpen,
    setScheduledOpen,
    setArchiveOpen,
    setArchiveConfirmKey,
    setPromoteTarget,
    promoteSubmitting,
    setPromoteSubmitting,
    setPromoteError,
    settings,
    settingsLoaded,
    settingsRef,
    handleSettings,
    showActionError,
    setActionNotice,
    announceStatus,
    navigateWithAnnotations,
    openSession: workspace.openSession,
    closeSession: workspace.closeSession,
    beginNewAgent: workspace.beginNewAgent,
    hidden: selectors.hidden,
    readyIds: selectors.readyIds,
    states: selectors.states,
    statesRef: streams.statesRef,
    moods: avatars.moods,
    permissions: selectors.permissions,
    questions: selectors.questions,
    crewWorkers: selectors.crewWorkers,
    selected: selectors.selected,
    selectedSession: selectors.selectedSession,
    serverYolo: selectors.serverYolo,
    bypass: selectors.bypass,
    sessionByKey: selectors.sessionByKey,
    unreadDigests: selectors.unreadDigests,
    pendingAvatars: avatars.pendingAvatars,
    avatarReservations: avatars.avatarReservations,
    allocateFor: avatars.allocateFor,
    reserveIdentity: avatars.reserveIdentity,
    saveNewAvatarAssignment: avatars.saveNewAvatarAssignment,
    pendingOptimisticIds: transcriptStore.pendingOptimisticIds,
    pendingSentAt: transcriptStore.pendingSentAt,
    abortReceipts: transcriptStore.abortReceipts,
    sentLedgerRef: transcriptStore.sentLedgerRef,
    pendingInputs: transcriptStore.pendingInputs,
    heldFollowUpsByTriggerId: transcriptStore.heldFollowUpsByTriggerId,
    pendingFor: transcriptStore.pendingFor,
    releaseOptimistic: transcriptStore.releaseOptimistic,
    forgetPendingSend: transcriptStore.forgetPendingSend,
    messageCacheRef: transcriptStore.messageCacheRef,
    transcriptsRef: transcriptStore.transcriptsRef,
    repairBudget: transcriptStore.repairBudget,
    setTranscriptFor: transcriptStore.setTranscriptFor,
    updateCachedMessages: transcriptStore.updateCachedMessages,
    markSessionStepsInterrupted: transcriptStore.markSessionStepsInterrupted,
    loadAndCommitMessages: transcriptStore.loadAndCommitMessages,
    recordFullReadFailure: transcriptStore.recordFullReadFailure,
    refreshMessages: transcriptStore.refreshMessages,
    onReplayMissingSendRef,
    readInstances: streams.readInstances,
    promptHintsFor: streams.promptHintsFor,
    pendingCreatedSessions: streams.pendingCreatedSessions,
    prunePendingCreated: streams.prunePendingCreated,
    refreshSessions: streams.refreshSessions,
    refreshAutoAccept: streams.refreshAutoAccept,
    refreshStates: streams.refreshStates,
    refreshQuestions: streams.refreshQuestions,
    refreshQueues: streams.refreshQueues,
    refreshScheduled: streams.refreshScheduled,
    refreshPromptsFor: streams.refreshPromptsFor,
    handleSaveNote: annotations.handleSaveNote,
    handleComposerDraftsChange: annotations.handleComposerDraftsChange,
  });

  usePruneRemovedInstances({
    instances,
    instancesLoaded,
    settingsLoaded,
    settingsRef,
    handleSettings,
    projectsByInstance,
    setProjectsByInstance,
    sessionsByInstance,
    setSessionsByInstance,
    statesByInstance,
    setStatesByInstance,
    stateReadAt,
    setStateReadAt,
    permissionsByInstance,
    setPermissionsByInstance,
    questionsByInstance,
    setQuestionsByInstance,
    queuesByInstance,
    setQueuesByInstance,
    modelsByInstance,
    setModelsByInstance,
    autoAcceptByInstance,
    setAutoAcceptByInstance,
    liveInstances,
    setLiveInstances,
    openSessions,
    setOpenSessions,
    activeSession,
    setActiveSession,
    minimizedSessions,
    setMinimizedSessions,
    threadModalKey,
    setThreadModalKey,
    summaries,
    setSummaries,
    transcripts,
    setTranscripts,
    historyIncomplete,
    setHistoryIncomplete,
    repairHalts,
    setRepairHalts,
    bypassOverrides,
    setBypassOverrides,
    scheduledTasksByKey,
    setScheduledTasksByKey,
    scheduledTaskNames,
    setScheduledTaskNames,
    runningScheduledKeys,
    setRunningScheduledKeys,
    pendingCreates,
    setPendingCreates,
    pendingCreatesRef,
    newSessionInstanceId,
    setNewSessionInstanceId,
    newSessionDirectory,
    setNewSessionDirectory,
    draftPendingId,
    setDraftPendingId,
    setDraftAppearance,
    providerEndpointId,
    setProviderEndpointId,
    avatarPickerSession,
    setAvatarPickerSession,
    archiveConfirmKey,
    setArchiveConfirmKey,
    promoteTarget,
    setPromoteTarget,
    scheduledModelTarget,
    setScheduledModelTarget,
    sendingKeys,
    setSendingKeys,
    reloadingKeys,
    setReloadingKeys,
    stoppingKeys,
    setStoppingKeys,
    archivingKeys,
    setArchivingKeys,
    compactingKeys,
    setCompactingKeys,
    askingSideQuestionKeys,
    setAskingSideQuestionKeys,
    messageCacheRef: transcriptStore.messageCacheRef,
    transcriptVersion: transcriptStore.transcriptVersion,
    pendingOptimisticIds: transcriptStore.pendingOptimisticIds,
    pendingSentAt: transcriptStore.pendingSentAt,
    unconfirmedSends: transcriptStore.unconfirmedSends,
    abortReceipts: transcriptStore.abortReceipts,
    sentLedgerRef: transcriptStore.sentLedgerRef,
    pendingInputs: transcriptStore.pendingInputs,
    heldFollowUpsByTriggerId: transcriptStore.heldFollowUpsByTriggerId,
    projectLayoutsRef: workspace.projectLayoutsRef,
  });

  // ---- Top-level UI coordination effects & helpers ----

  // One effect owns every text-size variable, so the three settings and a theme change can't
  // disagree about who writes the root style properties.
  React.useEffect(() => {
    const apply = () =>
      applyTextSizes(document.documentElement, {
        chatPx: settings.conversationFontSize,
        composer: settings.composerSize,
        interface: settings.interfaceSize,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [settings.conversationFontSize, settings.composerSize, settings.interfaceSize]);

  React.useEffect(() => {
    if (!mobileRailOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileRailOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileRailOpen]);

  React.useEffect(() => {
    const openOnShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      navigateWithAnnotations(() => setCommandPaletteOpen(true));
    };
    window.addEventListener('keydown', openOnShortcut);
    return () => window.removeEventListener('keydown', openOnShortcut);
  }, [navigateWithAnnotations]);

  // A retry belongs to the session it failed on; the banner text may still apply.
  React.useEffect(() => {
    clearActionErrorRetry();
  }, [selectors.selectedKey, clearActionErrorRetry]);

  const {
    columns: workspaceColumns,
    openSession: workspaceOpenSession,
    beginNewAgent: workspaceBeginNewAgent,
    performOpenSession: workspacePerformOpenSession,
  } = workspace;
  const {
    selectedKey,
    selectedSession,
    selectedState,
    selectedPermissions,
    selectedQuestions,
    selectedQueue,
    inspectedThread,
    sessionByKey,
    sessions: selectorSessions,
    onboardingOpen,
  } = selectors;
  const { setQuoteNavigation } = annotations;

  // Startup auto-selection: open the most recent session or a new-agent draft on an empty install.
  const initialWorkspaceChosen = React.useRef(false);
  const defaultEmptyHomeTarget =
    settingsLoaded && instancesLoaded
      ? emptyHomeTarget(instances, sessionsByInstance, selectorSessions.length, selectors.hidden)
      : null;
  React.useEffect(() => {
    if (initialWorkspaceChosen.current || !settingsLoaded || !instancesLoaded || onboardingOpen) return;
    if (workspaceColumns.length > 0 || newSessionInstanceId) {
      initialWorkspaceChosen.current = true;
      return;
    }
    if (usageOpen || scheduledOpen || archiveOpen) return;
    const latest = [...selectorSessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    if (latest) {
      initialWorkspaceChosen.current = true;
      workspaceOpenSession({ instanceId: latest.instanceId, sessionId: latest.id }, latest);
    } else if (defaultEmptyHomeTarget) {
      initialWorkspaceChosen.current = true;
      workspaceBeginNewAgent(defaultEmptyHomeTarget);
    }
  }, [
    settingsLoaded,
    instancesLoaded,
    onboardingOpen,
    workspaceColumns.length,
    selectorSessions,
    newSessionInstanceId,
    usageOpen,
    scheduledOpen,
    archiveOpen,
    defaultEmptyHomeTarget,
    workspaceBeginNewAgent,
    workspaceOpenSession,
  ]);

  // Screen-reader status live-region announcements.
  const lastStatusAnnouncementRef = React.useRef<{
    key: string;
    state: BallState;
    signature: string;
  } | null>(null);
  React.useEffect(() => {
    if (!selectedKey) {
      lastStatusAnnouncementRef.current = null;
      announceStatus('');
      return;
    }
    const previous = lastStatusAnnouncementRef.current;
    const sessionLabel = selectedSession?.title ?? 'selected session';
    const requestSignature = [
      ...selectedPermissions.map((request) => `p:${request.id}`),
      ...selectedQuestions.map((request) => `q:${request.id}`),
      ...(selectedQueue?.items.map((item) => `m:${item.id}`) ?? []),
      selectedQueue?.sendingId ? `s:${selectedQueue.sendingId}` : '',
    ].join('|');
    let message = '';
    if (selectedPermissions.length > 0) {
      message = `Bot in ${sessionLabel} is waiting for approval.`;
    } else if (selectedQuestions.length > 0) {
      message = `Bot in ${sessionLabel} has a question.`;
    } else if (selectedQueue?.sendingId) {
      message = `Sending a queued message in ${sessionLabel}.`;
    } else if (selectedQueue?.items.length) {
      const count = selectedQueue.items.length;
      message =
        selectedState === 'active'
          ? `Bot in ${sessionLabel} is working; ${count} ${count === 1 ? 'message is' : 'messages are'} queued.`
          : `${count} queued ${count === 1 ? 'message' : 'messages'} in ${sessionLabel}.`;
    } else if (selectedState === 'active') {
      message = `Bot in ${sessionLabel} is working.`;
    } else if (selectedState === 'error') {
      message = `Bot in ${sessionLabel} stopped with an error.`;
    } else if (selectedState === 'unknown') {
      // Sighted users get the status line under the transcript; without this a screen reader would
      // never learn that the session's status became unknown.
      message = `Status unknown in ${sessionLabel} — the host has not answered.`;
    } else if (previous?.key === selectedKey && previous.state === 'active' && selectedState === 'idle') {
      message = `Bot in ${sessionLabel} finished.`;
    }
    const signature = `${selectedState}:${requestSignature}:${message}`;
    if (previous?.key !== selectedKey || previous.signature !== signature) {
      announceStatus(message);
    }
    lastStatusAnnouncementRef.current = { key: selectedKey, state: selectedState, signature };
  }, [
    selectedKey,
    selectedSession,
    selectedState,
    selectedPermissions,
    selectedQuestions,
    selectedQueue,
    announceStatus,
  ]);

  React.useEffect(() => {
    if (!inspectedThread?.promotedTo || inspectedThread.task) return;
    workspaceOpenSession({ instanceId: inspectedThread.instanceId, sessionId: inspectedThread.promotedTo });
  }, [inspectedThread, workspaceOpenSession]);

  // The column the user is working in: whichever they last clicked, focused or scrolled.
  const featuredKey = React.useMemo(() => {
    if (activeSession && workspaceColumns.includes(activeSession)) return activeSession;
    let best: string | null = null;
    let bestUpdated = -Infinity;
    for (const key of workspaceColumns) {
      const updated = sessionByKey.get(key)?.updated ?? 0;
      if (updated > bestUpdated) {
        bestUpdated = updated;
        best = key;
      }
    }
    if (best && bestUpdated > 0) return best;
    return (
      workspaceColumns.find((key) => {
        const state = selectors.states[key] ?? 'unknown';
        // Only a *known* busy/blocked/error column is worth featuring; unknown is not a reason.
        return state !== 'idle' && state !== 'unknown';
      }) ??
      workspaceColumns[0] ??
      null
    );
  }, [activeSession, workspaceColumns, sessionByKey, selectors.states]);

  // Reload safety includes closed/background sessions and unresolved optimistic messages, not
  // just the visible composer's busy flag. This never starts or retries work.
  const remoteReloadBlocked =
    sendingKeys.size > 0 ||
    transcriptStore.pendingInputs.current.size > 0 ||
    pendingCreates.length > 0 ||
    Object.values(queuesByInstance).some((queues) => queues.some((queue) => queue.items.length > 0)) ||
    Object.values(statesByInstance).some((states) =>
      Object.values(states).some((state) => state === 'active' || state === 'needs-input')
    );
  React.useLayoutEffect(() => {
    setRemoteActiveWork(remoteReloadBlocked);
  }, [remoteReloadBlocked]);

  const rememberDelegatorModels = React.useCallback(
    (instanceId: string, choices: DelegatorChoices) => {
      void handleSettings({ delegatorModels: { ...settingsRef.current.delegatorModels, [instanceId]: choices } });
    },
    [handleSettings, settingsRef]
  );

  const setInstanceDefaultModel = React.useCallback(
    (instanceId: string, model: ModelRef) => {
      const current = settingsRef.current.instanceDefaults;
      void handleSettings({
        instanceDefaults: { ...current, [instanceId]: withInstanceDefaultModel(current[instanceId], model) },
      });
    },
    [handleSettings, settingsRef]
  );

  const handleOpenProviders = React.useCallback((instanceId: string) => {
    setProviderEndpointId(instanceId);
    setSettingsView('providers');
    setSettingsActivated(true);
    setSettingsOpen(true);
  }, []);

  const handleOpenWorker = React.useCallback(
    (worker: Session, messageId?: string) =>
      navigateWithAnnotations(() => {
        const known = sessionByKey.get(sessionKey(worker)) ?? worker;
        workspacePerformOpenSession({ instanceId: worker.instanceId, sessionId: worker.id }, known);
        if (messageId) {
          setQuoteNavigation((previous) => ({
            key: sessionKey(worker),
            messageId,
            token: (previous?.token ?? 0) + 1,
            source: null,
            destination: null,
          }));
        }
      }),
    [navigateWithAnnotations, sessionByKey, setQuoteNavigation, workspacePerformOpenSession]
  );

  const columnSharedProps: SessionColumnSharedProps = {
    instances,
    sessionsByInstance,
    projectsByInstance,
    modelsByInstance,
    autoAcceptByInstance,
    bypassOverrides,
    transcripts,
    messageCacheRef: transcriptStore.messageCacheRef,
    settings,
    settingsLoaded,
    viewSettings: selectors.viewSettings,
    activeSession,
    featuredKey,
    sessionByKey: selectors.sessionByKey,
    permissions: selectors.permissions,
    questions: selectors.questions,
    states: selectors.states,
    moods: avatars.moods,
    avatarIdentities: avatars.avatarIdentities,
    resolveDraftIdentity: avatars.resolveDraftIdentity,
    mentionNamesFor: selectors.mentionNamesFor,
    crewWorkers: selectors.crewWorkers,
    crewCostByKey: selectors.crewCostByKey,
    workerKeys: selectors.workerKeys,
    quietKeys: selectors.quietKeys,
    repairHalts,
    sendingKeys,
    stoppingKeys,
    reloadingKeys,
    compactingKeys,
    askingSideQuestionKeys,
    processExtensions: lifecycle.processExtensions,
    quoteNavigation: annotations.quoteNavigation,
    annotationQueueMutations: annotations.annotationQueueMutations,
    annotationNavigationHandlers,
    queue: lifecycle.queue,
    queueTargetFor: lifecycle.queueTargetFor,
    refreshModels: streams.refreshModels,
    setInstanceDefaultModel,
    handleSettings,
    rememberDelegatorModels,
    handleComposerDraftsChange: annotations.handleComposerDraftsChange,
    handleRetryPendingSend: lifecycle.handleRetryPendingSend,
    handleDiscardPendingSend: lifecycle.handleDiscardPendingSend,
    handleSaveNote: annotations.handleSaveNote,
    handleUpdateNote: annotations.handleUpdateNote,
    handleDeleteNote: annotations.handleDeleteNote,
    sendAnnotation: lifecycle.sendAnnotation,
    saveAnnotationNote: annotations.saveAnnotationNote,
    navigateQuote: annotations.navigateQuote,
    loadInstructionsFor: lifecycle.loadInstructionsFor,
    saveInstructionsFor: lifecycle.saveInstructionsFor,
    setYolo: lifecycle.setYolo,
    handleStopProcesses: lifecycle.handleStopProcesses,
    handleMarkMessageReadInColumn: annotations.handleMarkMessageReadInColumn,
    handleUndoMarkMessageReadInColumn: annotations.handleUndoMarkMessageReadInColumn,
    handleMarkMessageUnreadInColumn: annotations.handleMarkMessageUnreadInColumn,
    handleMarkAllRead: annotations.handleMarkAllRead,
    handleQuietChange: annotations.handleQuietChange,
    extendProcesses: lifecycle.extendProcesses,
    handleCreateAndSend: lifecycle.handleCreateAndSend,
    cancelNewAgent: lifecycle.cancelNewAgent,
    sendTo: lifecycle.sendTo,
    handleReloadSession: lifecycle.handleReloadSession,
    handleAbort: lifecycle.handleAbort,
    handlePermission: lifecycle.handlePermission,
    handleQuestion: lifecycle.handleQuestion,
    handleCompact: lifecycle.handleCompact,
    handleAskSideQuestion: lifecycle.handleAskSideQuestion,
    minimizeSession: workspace.minimizeSession,
    activateSession: workspace.activateSession,
    onOpenProviders: handleOpenProviders,
    handleSnooze: annotations.handleSnooze,
    requestArchive: lifecycle.requestArchive,
    beginNewAgent: workspace.beginNewAgent,
    renameByHuman: lifecycle.renameByHuman,
    onOpenWorker: handleOpenWorker,
    openPromoteDialog: lifecycle.openPromoteDialog,
  };

  const feedbackBanner = (
    <FeedbackBanner
      actionError={actionError}
      actionErrorRetry={actionErrorRetry}
      actionErrorRetryLabel={actionErrorRetryLabel}
      showActionError={showActionError}
      errorCopied={errorCopied}
      setErrorCopied={setErrorCopied}
      actionNotice={actionNotice}
      setActionNotice={setActionNotice}
      setNoticePaused={setNoticePaused}
    />
  );

  return (
    <AvatarSizeContext.Provider value={settings.blobSize}>
      <ImageViewerContext.Provider value={imageViewerApi}>
        <MotionConfig reducedMotion="user">
          <WorkspaceConnection
            activeKey={!newSessionInstanceId && !usageOpen && !scheduledOpen ? selectors.selectedKey : null}
            color={blobColor(effectiveBlobStyle(settings.blobStyle), avatars.selectedIdentity)}
          >
            <TooltipProvider delayDuration={300}>
              <div className="flex h-full flex-col">
                <div className="sr-only" aria-live="polite" aria-atomic="true">
                  {statusAnnouncement}
                </div>
                <InstanceBar
                  instances={instances}
                  hidden={selectors.hidden}
                  live={liveInstances}
                  refreshing={refreshing}
                  banner={feedbackBanner}
                  onToggle={lifecycle.toggleInstance}
                  // Forget = hide, permanently. It is not a delete: an OpenChamber host lives in
                  // OpenChamber's own settings file, which Ember must not rewrite, and a Hearth endpoint
                  // has its own Remove in Settings → Endpoints.
                  onForget={lifecycle.forgetInstance}
                  onToggleNavigation={() => setMobileRailOpen((open) => !open)}
                  mobileNavigationOpen={mobileRailOpen}
                  railMode={settings.railMode}
                  onCycleRailMode={workspace.cycleRailMode}
                  onOpenCommandPalette={() => navigateWithAnnotations(() => setCommandPaletteOpen(true))}
                  onRefresh={() => void streams.refreshInstances()}
                  onShowSessions={workspace.showSessions}
                  onShowUsage={() =>
                    navigateWithAnnotations(() => {
                      setScheduledOpen(false);
                      setUsageOpen(true);
                    })
                  }
                  usageActive={usageOpen}
                  onShowScheduled={() =>
                    navigateWithAnnotations(() => {
                      setUsageOpen(false);
                      setScheduledOpen(true);
                    })
                  }
                  scheduledActive={scheduledOpen}
                  unseenScheduledRuns={selectors.unseenScheduledRunsCount}
                  hideNavigation={usageOpen || scheduledOpen}
                  onOpenSettings={() =>
                    navigateWithAnnotations(() => {
                      setMobileRailOpen(false);
                      setProviderEndpointId(undefined);
                      setSettingsView('providers');
                      setSettingsActivated(true);
                      setSettingsOpen(true);
                    })
                  }
                  onOpenInstanceSettings={() => {
                    setProviderEndpointId(undefined);
                    setSettingsView('computers');
                    setSettingsActivated(true);
                    setSettingsOpen(true);
                  }}
                />

                <InstanceOutageToasts
                  entries={selectors.silentInstancesList}
                  retrying={refreshing}
                  protectDecisions={workspace.columns.some(
                    (key) => avatars.moods[key] === 'input' || avatars.moods[key] === 'question'
                  )}
                  onRetry={() => void streams.refreshInstances()}
                  onDismiss={lifecycle.dismissOutage}
                  onSettings={() => {
                    setMobileRailOpen(false);
                    setProviderEndpointId(undefined);
                    setSettingsView('computers');
                    setSettingsActivated(true);
                    setSettingsOpen(true);
                  }}
                />

                <div className="relative flex min-h-0 flex-1">
                  {/* The workspace keeps its rail available even when every column is closed. */}
                  {mobileRailOpen ? (
                    <button
                      type="button"
                      className="fixed inset-x-0 bottom-0 top-[calc(2.75rem+env(safe-area-inset-top))] z-30 bg-black/35 backdrop-blur-[1px] md:hidden"
                      onClick={() => setMobileRailOpen(false)}
                      aria-label="Close sessions sidebar"
                    />
                  ) : null}
                  {!usageOpen && !scheduledOpen ? (
                    <LeftRail
                      onRenameSession={(session, title) => void lifecycle.renameByHuman(session, title)}
                      mode={settings.railMode}
                      instances={instances}
                      projectsByInstance={selectors.railProjectsByInstance}
                      instanceDefaults={settings.instanceDefaults}
                      sessions={selectors.sessions}
                      everySession={selectors.everySession}
                      moods={avatars.moods}
                      previews={selectors.previews}
                      selectedKey={selectors.selectedKey}
                      selectedSession={selectors.selectedSession}
                      avatarIdentities={avatars.avatarIdentities}
                      blobStyle={effectiveBlobStyle(settings.blobStyle)}
                      compact={settings.compactRail}
                      loading={loading}
                      startupMessage={selectors.startupMessage}
                      mobileOpen={mobileRailOpen}
                      reloadingKeys={reloadingKeys}
                      archivingKeys={archivingKeys}
                      visibleColumnKeys={workspace.columnKeySet}
                      windowLabel={
                        SESSION_WINDOWS.find(
                          (option) => option.hours === settings.sessionWindowHours && option.hours > 0
                        )?.label ?? null
                      }
                      scheduledTaskBySession={selectors.scheduledTaskBySession}
                      runningScheduledKeys={runningScheduledKeys}
                      onRunScheduledTask={(task) => void lifecycle.handleRunScheduledTask(task)}
                      onChangeScheduledTaskModel={lifecycle.handleChangeAndRunScheduledTaskModel}
                      onOpenArchive={() => navigateWithAnnotations(() => setArchiveOpen(true))}
                      onSelectSession={(session) => {
                        if (session.archived) void lifecycle.handleRestoreAndOpen(session);
                        else workspace.openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                        setMobileRailOpen(false);
                      }}
                      onOpenProject={(instanceId, project, projectSessions) => {
                        workspace.openProject(instanceId, project, projectSessions);
                        setMobileRailOpen(false);
                      }}
                      onOpenSession={(session) => {
                        workspace.openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                        setMobileRailOpen(false);
                      }}
                      onReload={(session) => void lifecycle.handleReloadSession(session)}
                      onArchive={(session, archived) =>
                        archived ? lifecycle.requestArchive(session) : void lifecycle.handleArchive(session, false)
                      }
                      onArchiveMany={(sessions) => void lifecycle.handleArchiveMany(sessions, true)}
                      onCustomizeAppearance={setAvatarPickerSession}
                      onMarkAllRead={annotations.handleMarkAllRead}
                      unreadKeys={selectors.unreadKeys}
                      quietKeys={selectors.quietKeys}
                      snoozedSessions={settings.snoozedSessions}
                      onSnooze={annotations.handleSnooze}
                      onQuietChange={annotations.handleQuietChange}
                      onNewAgent={(instanceId, directory) => {
                        workspace.beginNewAgent(instanceId, directory);
                        setMobileRailOpen(false);
                      }}
                    />
                  ) : null}

                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div ref={workspace.workspaceRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                      {scheduledOpen ? (
                        <React.Suspense fallback={null}>
                          <ScheduledView
                            tasks={selectors.scheduledTaskList}
                            runs={selectors.scheduledRuns}
                            instances={instances}
                            silentInstances={selectors.silentInstancesList}
                            runningTaskKeys={runningScheduledKeys}
                            onOpenSession={(session) => {
                              if (session.archived) void lifecycle.handleRestoreAndOpen(session);
                              else {
                                workspace.openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                              }
                            }}
                            onRunTask={(task) => void lifecycle.handleRunScheduledTask(task)}
                            onChangeTaskModel={lifecycle.handleChangeScheduledTaskModel}
                            onRetryInstances={() => void streams.refreshInstances()}
                            retryingInstances={refreshing}
                          />
                        </React.Suspense>
                      ) : usageOpen ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background px-4 py-3">
                          <React.Suspense fallback={null}>
                            <ModelUsagePanel instances={instances} modelsByInstance={modelsByInstance} />
                          </React.Suspense>
                        </div>
                      ) : newSessionInstanceId || workspace.columns.length === 0 ? (
                        <ChatView
                          session={null}
                          instance={selectors.selectedInstance}
                          instanceMarkerColor={undefined}
                          newSessionInstanceId={newSessionInstanceId}
                          newSessionPrefill={selectors.newSessionPrefill}
                          recentDirectories={recentProjectDirectories(
                            sessionsByInstance[newSessionInstanceId ?? ''] ?? []
                          )}
                          projectUsage={selectors.projectUsageByInstance[newSessionInstanceId ?? '']}
                          workspaceDirectory={
                            newSessionInstanceId
                              ? settings.instanceDefaults[newSessionInstanceId]?.workspaceDirectory
                              : undefined
                          }
                          onWorkspaceChange={(id, directory) =>
                            handleSettings({
                              instanceDefaults: {
                                ...settings.instanceDefaults,
                                [id]: { ...settings.instanceDefaults[id], workspaceDirectory: directory },
                              },
                            })
                          }
                          instances={instances}
                          projectsByInstance={projectsByInstance}
                          seed={selectors.selectedKey ?? (newSessionInstanceId ? `new:${newSessionInstanceId}` : '')}
                          identity={avatars.selectedIdentity}
                          resolveDraftIdentity={avatars.resolveDraftIdentity}
                          state="idle"
                          mood={avatars.selectedMood}
                          blobStyle={effectiveBlobStyle(settings.blobStyle)}
                          messages={[]}
                          messagesStatus="ready"
                          permissions={[]}
                          questions={[]}
                          models={selectors.selectedModels?.models ?? []}
                          onModelsRefresh={(options) =>
                            newSessionInstanceId ? streams.refreshModels(newSessionInstanceId, options) : undefined
                          }
                          defaultModelId={selectors.selectedModels?.defaultModelId ?? null}
                          instanceDefaultModelId={effectiveInstanceDefaultModel(
                            selectors.modelInstanceId
                              ? settings.instanceDefaults[selectors.modelInstanceId]
                              : undefined,
                            selectors.selectedModels?.defaultModelId
                          )}
                          onSetInstanceDefault={
                            selectors.modelInstanceId
                              ? (model) => setInstanceDefaultModel(selectors.modelInstanceId!, model)
                              : undefined
                          }
                          recentModels={selectors.recentModels}
                          sending={lifecycle.draftPendingCreate?.phase === 'creating'}
                          pendingCreate={lifecycle.draftPendingCreate}
                          draftAppearance={
                            lifecycle.draftPendingCreate
                              ? lifecycle.draftPendingCreate.options.appearance ?? null
                              : draftAppearance
                          }
                          onDraftAppearanceChange={setDraftAppearance}
                          draftAppearanceTheme={settings.theme}
                          onRetryCreate={lifecycle.handleRetryCreate}
                          onEditCreate={lifecycle.handleEditCreate}
                          onSaveDraftNote={(text) => {
                            if (lifecycle.draftPendingCreate) {
                              lifecycle.handleSaveDraftNote(lifecycle.draftPendingCreate.id, text);
                            }
                          }}
                          queue={null}
                          reloading={false}
                          bypass={false}
                          view={selectors.viewSettings}
                          sessionNotes={[]}
                          notesKey=""
                          savedComposerDrafts={settings.composerDrafts}
                          composerDraftsHydrated={settingsLoaded}
                          onComposerDraftsChange={annotations.handleComposerDraftsChange}
                          onSaveNote={annotations.handleSaveNote}
                          onUpdateNote={annotations.handleUpdateNote}
                          onDeleteNote={annotations.handleDeleteNote}
                          onViewChange={handleSettings}
                          delegatorModels={settings.delegatorModels}
                          onDelegatorModelsChange={rememberDelegatorModels}
                          onLoadInstructions={lifecycle.loadInstructionsFor}
                          onSaveInstructions={lifecycle.saveInstructionsFor}
                          onBypassChange={() => {}}
                          onNewSessionInstanceChange={(instanceId) => {
                            setNewSessionInstanceId(instanceId);
                            setNewSessionDirectory(null);
                          }}
                          onCreateAndSend={lifecycle.handleCreateAndSend}
                          onCancelNewSession={lifecycle.cancelNewAgent}
                          onSend={lifecycle.handleSend}
                          quoteLinks={[]}
                          onAnnotate={async () => false}
                          onSaveAnnotationNote={async () => false}
                          onNavigateQuote={() => {}}
                          onQueue={async () => false}
                          onSendQueued={async () => false}
                          onMoveQueued={async () => false}
                          onRemoveQueued={async () => false}
                          onReplaceQueued={async () => false}
                          onRetryQueued={async () => false}
                          onDiscardQueued={() => false}
                          onReload={() => {}}
                          onAbort={() => {}}
                          onPermission={lifecycle.handlePermission}
                          onQuestion={lifecycle.handleQuestion}
                          compacting={false}
                          onCompact={() => {}}
                        />
                      ) : (
                        workspace.columns.map((key) => (
                          <SessionColumn key={key} columnKey={key} {...columnSharedProps} />
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <AppDialogs
                  commandPaletteOpen={commandPaletteOpen}
                  setCommandPaletteOpen={setCommandPaletteOpen}
                  historyIncomplete={historyIncomplete}
                  loadingHistory={loadingHistory}
                  setLoadingHistory={setLoadingHistory}
                  readyIds={selectors.readyIds}
                  refreshSessions={streams.refreshSessions}
                  allSessions={selectors.allSessions}
                  states={selectors.states}
                  instances={instances}
                  projectsByInstance={projectsByInstance}
                  settings={settings}
                  handleRestoreAndOpen={lifecycle.handleRestoreAndOpen}
                  openSession={workspace.openSession}
                  beginNewAgent={workspace.beginNewAgent}
                  setMobileRailOpen={setMobileRailOpen}
                  archiveConfirmSession={selectors.archiveConfirmSession}
                  archiveConfirmKey={archiveConfirmKey}
                  setArchiveConfirmKey={setArchiveConfirmKey}
                  crewWorkers={selectors.crewWorkers}
                  moods={avatars.moods}
                  handleArchive={lifecycle.handleArchive}
                  threadModalKey={threadModalKey}
                  setThreadModalKey={setThreadModalKey}
                  navigateWithAnnotations={navigateWithAnnotations}
                  threadReturnFocusRef={workspace.threadReturnFocusRef}
                  activeSessionRef={workspace.activeSessionRef}
                  inspectedThread={selectors.inspectedThread}
                  columnSharedProps={columnSharedProps}
                  promoteTarget={promoteTarget}
                  statesAnswered={selectors.statesAnswered}
                  statesByInstance={statesByInstance}
                  promoteSubmitting={promoteSubmitting}
                  promoteError={promoteError}
                  closePromoteDialog={lifecycle.closePromoteDialog}
                  handlePromoteWorker={lifecycle.handlePromoteWorker}
                  archiveOpen={archiveOpen}
                  setArchiveOpen={setArchiveOpen}
                  archivedSessions={selectors.archivedSessions}
                  previews={selectors.previews}
                  avatarIdentities={avatars.avatarIdentities}
                  reloadingKeys={reloadingKeys}
                  archivingKeys={archivingKeys}
                  handleReloadSession={lifecycle.handleReloadSession}
                  setAvatarPickerSession={setAvatarPickerSession}
                  settingsActivated={settingsActivated}
                  settingsOpen={settingsOpen}
                  setSettingsOpen={setSettingsOpen}
                  settingsView={settingsView}
                  setSettingsView={setSettingsView}
                  providerEndpointId={providerEndpointId}
                  setProviderEndpointId={setProviderEndpointId}
                  modelsByInstance={modelsByInstance}
                  recentModelsByInstance={selectors.recentModelsByInstance}
                  projectUsageByInstance={selectors.projectUsageByInstance}
                  handleSettings={handleSettings}
                  refreshInstances={streams.refreshInstances}
                  refreshModels={streams.refreshModels}
                  onboardingOpen={selectors.onboardingOpen}
                  onboardingState={selectors.onboardingState}
                  onboardingProblem={selectors.onboardingProblem}
                  dismissOnboarding={lifecycle.dismissOnboarding}
                  refreshHarnessSettings={refreshHarnessSettings}
                  showActionError={showActionError}
                  avatarPickerSession={avatarPickerSession}
                  avatarPickerIdentity={avatars.avatarPickerIdentity}
                  avatarPickerScopes={avatars.avatarPickerScopes}
                  handleAvatarOverride={avatars.handleAvatarOverride}
                  scheduledModelTarget={scheduledModelTarget}
                  setScheduledModelTarget={setScheduledModelTarget}
                  setInstanceDefaultModel={setInstanceDefaultModel}
                  handleScheduledModelSelect={lifecycle.handleScheduledModelSelect}
                />
              </div>
            </TooltipProvider>
          </WorkspaceConnection>
        </MotionConfig>
        <AppRootOverlays imageViewer={imageViewer} setImageViewer={setImageViewer} />
      </ImageViewerContext.Provider>
    </AvatarSizeContext.Provider>
  );
}
