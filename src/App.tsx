import { threadDescendants } from './lib/crew';
import { hasUnreadMessages } from './lib/sessionUnread';
import { AvatarSizeContext } from './blob/size';
import { effectiveInstanceDefaultModel, withInstanceDefaultModel } from './lib/instanceDefaultModel';
import * as React from 'react';
import { WorkspaceConnection } from './components/workspaceConnection';
import { blobColor } from './blob/color';
import { MotionConfig } from 'motion/react';
import InstanceBar from './components/InstanceBar';
import LeftRail from './components/LeftRail';
import ChatView from './components/ChatView';
import type { StopProcessesResult } from './components/SessionProcessesNotice';
import ArchiveSessionDialog from './components/ArchiveSessionDialog';
import PromoteWorkerDialog from './components/PromoteWorkerDialog';
import { ImageViewerContext, type ImageViewerApi } from './components/imageViewerContext';
import type { ViewerImage } from './lib/gallery';
import { TooltipProvider } from '@/components/ui/tooltip';
import { applyTheme } from './themes';
import {
  projectForSession,
  projectIdentityKey,
  resolveAvatarIdentity,
  seedIdentity,
  sessionAvatarKey,
} from './blob/seed';
import { moodFrom } from './blob/mood';
import {
  abortSession,
  createClientMessageId,
  createSession,
  errorMessageOf,
  listInstances,
  isPartialSessionList,
  loadAllAutoAcceptPolicies,
  loadAllMessageQueues,
  loadAllPermissions,
  loadAllProjects,
  loadAllQuestions,
  loadAllSessions,
  loadAllSessionStates,
  loadMessageAppend,
  loadMessageHistory,
  loadMessages,
  loadSessionInstructions,
  setSessionInstructions,
  loadMessageTail,
  loadPermissions,
  loadQuestions,
  loadSessions,
  stopSessionProcesses,
  loadSessionStates,
  loadModels,
  loadScheduledIdentityData,
  mergePolledSessions,
  rejectQuestion,
  removeQueuedMessage,
  renameSession,
  replyPermission,
  replyQuestion,
  runScheduledTask,
  sendPrompt,
  setAutoAccept,
  setSessionArchived,
  updateScheduledTaskModel,
  askSideQuestion,
  compactSession,
  promoteSession,
  type AutoAcceptPolicy,
  type ModelList,
  type PromptInput,
  type ScheduledTask,
} from './api';
import { buildScheduledRuns, countUnseenScheduledRuns, scheduledReadSessions } from './lib/scheduledView';
import {
  checkGithubForUpdate,
  formatUpdateNotice,
  type UpdateCheckResult,
} from './lib/updateCheck';
import { isPiInstance } from './piApi';
import { emptyHomeTarget, newSessionTarget } from './lib/emptyHome';
import { useStableCallback } from '@/lib/useStableCallback';
import {
  addPendingNote,
  createPendingCreate,
  failPendingCreate,
  holdPendingMessage,
  restartPendingCreate,
  type PendingCreate,
} from './lib/pendingCreate';
import { newSessionFailureText, sessionCreateFailureOf } from './lib/newSessionFailure';
import { applyLiveToolOutput, entryOrdinal, newestEntryId, settleToolResults } from '@/lib/piMapping';
import type { LiveToolOutput, ToolResultSettlement } from '@/lib/piMapping';
import { copyText } from '@/lib/clipboard';
import { mergeDraftChanges, type DraftChanges } from '@/lib/composerDrafts';
import { selectedModelError } from '@/lib/modelSelection';
import {
  compactionFailureMessage,
  compactionLogLine,
  compactionNotice,
  compactionOutcome,
} from '@/lib/compaction';
import { crewCostOf, crewCostState } from '@/lib/crewCost';
import { reconcileOutageDismissals, silentInstances, type SilentInstance } from '@/lib/instanceHealth';
import { needsOnboarding, type OnboardingState } from '@/lib/onboarding';
import { ReadCoordinator } from '@/lib/readCoordinator';
import { shareValue } from '@/lib/structuralSharing';
import { TranscriptCache } from '@/lib/transcriptCache';
import { observationsFor, observeModels } from '@/lib/modelStats';
import { summarizeMessages, type SessionMessageSummary } from '@/lib/messageSummary';
import {
  reconcileFullTranscript,
  reconcileTranscriptAppend,
  reconcileTranscriptTail,
} from '@/lib/transcriptReconciliation';
import { missingSent, recordSent, PENDING_SEND_TTL_MS, type SentLedger } from '@/lib/sentLedger';
import {
  deliveryAfterAcceptance,
  steerAbandoned,
  stopHeldMessage,
  submitOutcomeOf,
  type AbortReceipt,
} from '@/lib/sendDelivery';
import {
  addComments,
  isMessageRead,
  markAllRead,
  markRead,
  markTimestampRead,
  pruneSessionReadMarks,
} from './lib/readState';
import { deriveSessionName } from './lib/sessionNames';
import { useUnreadDigests } from './hooks/useUnreadDigests';
import { isUnreadEligible, visibleUnreadItems } from './lib/unreadDigest';
import { useEmberSettings } from './hooks/useEmberSettings';
import { useFeedback } from './hooks/useFeedback';
import { mergePolledQueues, useMessageQueue, type QueueTarget } from './hooks/useMessageQueue';
import { useProcessReaper } from './hooks/useProcessReaper';
import { PROCESS_EXTENSION_MS, processKey } from './lib/processExpiry';
import { usePoll } from './hooks/usePoll';
import { useMotionPause } from './lib/useMotionPause';
import ManageGroupDialog, { type GroupDraft } from './components/ManageGroupDialog';
import { recentProjectDirectories, newSessionDirectoryPrefill, newSessionModelPrefill } from './lib/newSessionDefaults';
import { isQuietlyArchivable, sessionStatusAnswer, staleScheduledRuns } from './lib/bulkArchive';
import { instancesWithFreshStates, sessionStates } from './lib/sessionState';
import { nextSessionAfterArchive, notesKeyForSession } from './lib/projectGroups';
import { upsertGroup } from './lib/sessionGroups';
import { recoverStrandedNotes } from './lib/notes';
import { blockedWorkersUnder, crewByLeader, isWorker, leaderNeedsInput } from './lib/crew';
import { InvalidationQueue, invalidationsFor, parseEmberEvent, sessionIsLoaded, type Invalidation } from '@/lib/invalidation';
import { APPLY_STREAM_DELTAS, applyLiveDeltas } from '@/lib/liveStream';
import {
  MAX_OPEN_SESSIONS,
  MIN_COLUMN_WIDTH,
  numberShortcutSlot,
  parseSessionKey,
  pruneTranscripts,
  pruneWorkspace,
  sameWorkspace,
  transcriptKeysToKeep,
  visibleColumns,
  type Workspace,
} from './lib/workspace';
import { startupNotice, type TranscriptFailureSource, type TranscriptState } from './lib/transcriptStatus';
import { classifyFullReadFailure, RepairBudget, type FullReadFailure, type RepairHalt } from './lib/repairBudget';
import { applyTranscriptCommit } from './lib/transcriptCommit';
import { instanceMarkerColor } from './lib/instanceMarker';
import { DEFAULT_MODEL, modelRefKey, SESSION_WINDOWS, sessionKey } from './types';
import type {
  AvatarIdentity,
  AvatarOverride,
  BallMood,
  BallState,
  ChatMessage,
  LiveDelta,
  MessagesStatus,
  MessageQueueSession,
  Instance,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  Project,
  QuestionAnswers,
  QuestionRequest,
  Session,
  SessionRef,
  StoredComposerDraft,
  NewSessionOptions,
  RailMode,
} from './types';

const SettingsPanel = React.lazy(() => import('./components/SettingsPanel'));
const OnboardingWizard = React.lazy(() => import('./components/OnboardingWizard'));

const ModelUsagePanel = React.lazy(() => import('./components/ModelUsagePanel'));
const ScheduledView = React.lazy(() => import('./components/ScheduledView'));
const AvatarPicker = React.lazy(() => import('./components/AvatarPicker'));
const CommandPalette = React.lazy(() => import('./components/CommandPalette'));
const ArchiveDialog = React.lazy(() => import('./components/ArchiveDialog'));
const ImageViewer = React.lazy(() => import('./components/ImageViewer'));
const ModelPicker = React.lazy(() => import('./components/ModelPicker'));

const DialogFallback = ({ label }: { label: string }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="status">
    <span className="rounded-lg border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
      {label}
    </span>
  </div>
);

// Fast cadence: used while an instance has no live event stream.
const STATE_POLL_MS = 3000;
const SESSION_POLL_MS = 10_000;
const SCHEDULE_POLL_MS = 30_000;
// Slow cadence: the safety net while every instance is streaming events to us.
const STATE_POLL_LIVE_MS = 30_000;
const SESSION_POLL_LIVE_MS = 60_000;
const MESSAGES_POLL_LIVE_MS = 20_000;
// Approvals and questions have no stream event yet (see `PI_RESOURCES`), so a parked prompt is only
// discovered by polling. That is the one thing a live stream does not cover, and it is the one thing
// a person must see promptly, so it keeps the fast cadence whatever the instance's liveness is.
const PROMPT_POLL_MS = 3000;
const SCHEDULE_POLL_LIVE_MS = 5 * 60_000;
const PREVIEW_COUNT = 24;
const PREVIEW_CONCURRENCY = 4;
// Progressive tails for rail previews, largest last: stop as soon as a preview is found.
const PREVIEW_LIMITS = [8, 32, 128] as const;
// Transcripts kept warm for instant switching. Preview warming writes summaries only, never the
// message cache, so this covers the visible columns plus a little slack for quick switches.
const MESSAGE_CACHE_LIMIT = MAX_OPEN_SESSIONS + 4;

const RECENT_MODEL_COUNT = 5;
const CREATED_SESSION_GRACE_MS = 2 * 60_000;
// Stable empty set for the draft/empty pane, so Transcript's memo isn't defeated each render.

/** Models the instance ran most recently, newest first, taken from its sessions' last-used model. */
const recentModelKeys = (sessions: Session[]): string[] => {
  const keys: string[] = [];
  [...sessions]
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .forEach((session) => {
      if (!session.model) return;
      const key = modelRefKey(session.model);
      if (!keys.includes(key)) keys.push(key);
    });
  return keys.slice(0, RECENT_MODEL_COUNT);
};

const forSession = <T extends { instanceId: string; sessionId: string }>(
  list: T[],
  selected: SessionRef | null
): T[] =>
  selected
    ? list.filter(
        (request) =>
          request.instanceId === selected.instanceId && request.sessionId === selected.sessionId
      )
    : [];

const sameIdentity = (a: AvatarIdentity, b: AvatarIdentity): boolean =>
  a.sessionKey === b.sessionKey &&
  a.projectKey === b.projectKey &&
  a.taskKey === b.taskKey &&
  a.colorSeed === b.colorSeed &&
  a.shapeSeed === b.shapeSeed &&
  a.motionSeed === b.motionSeed &&
  a.colorIndex === b.colorIndex &&
  a.color === b.color &&
  a.shapeName === b.shapeName;

const sameStringRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const sameSummary = (a: SessionMessageSummary, b: SessionMessageSummary): boolean =>
  a.preview === b.preview && a.failed === b.failed && a.thinking === b.thinking && a.version === b.version;

const composerDraftSignature = (drafts: Record<string, StoredComposerDraft>): string =>
  JSON.stringify(
    Object.keys(drafts).sort().map((key) => {
      const draft = drafts[key];
      return [key, draft.text, draft.modelId ?? '', draft.variant ?? ''];
    })
  );

const responseError = (data: unknown, fallback: string, source?: string): string => {
  const detail = errorMessageOf(data);
  const message = detail ?? fallback;
  // Middle-process errors already say "Ember → …"; don't double-label those.
  const origin = data && typeof data === 'object' ? (data as Record<string, unknown>).source : undefined;
  return source && origin !== 'ember' ? `${source}: ${message}` : message;
};

let noteSequence = 0;
const createNoteId = (): string =>
  `note-${Date.now().toString(36)}-${(noteSequence = (noteSequence + 1) % 0xffff).toString(36)}`;

export default function App() {
  const [instances, setInstances] = React.useState<Instance[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [projectsByInstance, setProjectsByInstance] = React.useState<Record<string, Project[]>>({});
  const [sessionsByInstance, setSessionsByInstance] = React.useState<Record<string, Session[]>>({});
  const [statesByInstance, setStatesByInstance] = React.useState<
    Record<string, Record<string, BallState>>
  >({});
  // When each instance's status endpoint last answered. A session with no answer is `unknown`, not
  // idle, so this is what keeps "we have not heard" distinguishable from "it said nothing is
  // happening" — including after the poll starts failing, when the map above is kept as-is.
  const [stateReadAt, setStateReadAt] = React.useState<Record<string, number>>({});
  // A coarse clock so an answer that is no longer being refreshed can age into `unknown` even when
  // every poll is failing: a failing poll changes no state, so nothing else would re-render.
  const [stateClock, setStateClock] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setStateClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [permissionsByInstance, setPermissionsByInstance] = React.useState<
    Record<string, PermissionRequest[]>
  >({});
  const [questionsByInstance, setQuestionsByInstance] = React.useState<
    Record<string, QuestionRequest[]>
  >({});
  const [queuesByInstance, setQueuesByInstance] = React.useState<
    Record<string, MessageQueueSession[]>
  >({});
  const [summaries, setSummaries] = React.useState<Record<string, SessionMessageSummary>>({});
  const [openSessions, setOpenSessions] = React.useState<string[]>([]);
  const [activeSession, setActiveSession] = React.useState<string | null>(null);
  const [minimizedSessions, setMinimizedSessions] = React.useState<Set<string>>(() => new Set());
  const [newSessionInstanceId, setNewSessionInstanceId] = React.useState<string | null>(null);
  const [newSessionDirectory, setNewSessionDirectory] = React.useState<string | null>(null);
  // `failure` records *which path* raised the `'error'` status, because only a failed explicit
  // reload is a settled failure: everything else is retried by the poller and must not be dressed
  // up as a destructive error (see `src/lib/transcriptStatus.ts`). Dropped again on any success.
  const [transcripts, setTranscripts] = React.useState<
    Record<string, TranscriptState & { messages: ChatMessage[] }>
  >({});
  const [modelsByInstance, setModelsByInstance] = React.useState<Record<string, ModelList>>({});
  const [scheduledTaskNames, setScheduledTaskNames] = React.useState<Record<string, string>>({});
  const [scheduledTasksByKey, setScheduledTasksByKey] = React.useState<Record<string, ScheduledTask>>({});
  const [runningScheduledKeys, setRunningScheduledKeys] = React.useState<Set<string>>(() => new Set());
  const [scheduledModelTarget, setScheduledModelTarget] = React.useState<ScheduledTask | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [instancesLoaded, setInstancesLoaded] = React.useState(false);
  // Width of the column area, measured with a ResizeObserver; how many columns fit depends on it.
  const [workspaceWidth, setWorkspaceWidth] = React.useState(0);
  const [sendingKeys, setSendingKeys] = React.useState<Set<string>>(() => new Set());
  const [reloadingKeys, setReloadingKeys] = React.useState<Set<string>>(() => new Set());
  // Sessions whose stop was requested but whose abort hasn't reconciled yet: the composer's
  // stop button shows a spinner and the send button stays disabled until the run settles.
  const [stoppingKeys, setStoppingKeys] = React.useState<Set<string>>(() => new Set());
  const [archivingKeys, setArchivingKeys] = React.useState<Set<string>>(() => new Set());
  const [compactingKeys, setCompactingKeys] = React.useState<Set<string>>(() => new Set());
  const [askingSideQuestionKeys, setAskingSideQuestionKeys] = React.useState<Set<string>>(() => new Set());
  // Local fallback for instances whose OpenChamber predates server-side auto-accept.
  const [bypassOverrides, setBypassOverrides] = React.useState<Record<string, boolean>>({});
  const [autoAcceptByInstance, setAutoAcceptByInstance] = React.useState<Record<string, AutoAcceptPolicy>>({});
  // Nothing on screen is being looked at; stop animating (one listener for the whole window).
  useMotionPause();
  const [groupDraft, setGroupDraft] = React.useState<GroupDraft | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  /** The Usage view, a sibling of Home rather than a dialog over it. */
  const [usageOpen, setUsageOpen] = React.useState(false);
  /** The Scheduled view: runs newest-first and recurring plans, a fourth top-bar tab. */
  const [scheduledOpen, setScheduledOpen] = React.useState(false);
  /** GitHub release update check: shown as an "Update available" pill in the top bar until dismissed. */
  const [availableUpdate, setAvailableUpdate] = React.useState<UpdateCheckResult | null>(null);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = React.useState<string | null>(null);

  /**
   * New-agent attempts in flight, or refused and waiting for a decision.
   *
   * They live here, not in the draft's ChatView, because a create outlives the pane: the person can
   * press × or open another session while `POST /conversations` is out, and the answer still has to
   * reach somewhere. The draft's message is therefore a *prop* (`PendingCreate`) rather than a
   * transcript entry under a placeholder key — the handover to the real session is a single tick,
   * and no placeholder can leak into persisted workspace or settings.
   *
   * The ref is the synchronous source of truth: Enter can arrive again before React commits, and a
   * second create for the same pane would be two sessions. It is only ever written through
   * `mutatePendingCreates`, so it and the state never disagree.
   */
  const [pendingCreates, setPendingCreates] = React.useState<PendingCreate[]>([]);
  const pendingCreatesRef = React.useRef<PendingCreate[]>([]);
  const [draftPendingId, setDraftPendingIdState] = React.useState<string | null>(null);
  const draftPendingIdRef = React.useRef<string | null>(null);
  /**
   * The session ids Ember knew when each attempt began.
   *
   * A create whose answer was lost may have happened anyway. Before retrying one, the rail is asked
   * whether a conversation appeared that matches this attempt and was not there at the start; if so
   * it is adopted instead of creating a second empty session. The baseline comes from the list Ember
   * already holds, so the check costs nothing on the happy path.
   */
  const createBaselines = React.useRef(new Map<string, Set<string>>());
  /** Which attempt the draft pane is showing, if any. Stable so `openSession` can clear it. */
  const setDraftPendingId = React.useCallback((id: string | null) => {
    draftPendingIdRef.current = id;
    setDraftPendingIdState(id);
  }, []);
  const [settingsActivated, setSettingsActivated] = React.useState(false);
  const [avatarPickerSession, setAvatarPickerSession] = React.useState<Session | null>(null);

  /**
   * Session titles the composer can tag with `@`.
   *
   * Same instance only — a name is resolved by the host that owns the conversation, so offering a
   * title from a different Hearth would suggest something unreachable. Archived sessions and hidden
   * workers are excluded for the same reason, and the session being typed in is excluded because
   * tagging yourself means nothing.
   */
  const mentionNamesFor = React.useMemo(() => {
    const byInstance: Record<string, string[]> = {};
    for (const [instanceId, list] of Object.entries(sessionsByInstance)) {
      byInstance[instanceId] = list
        .filter((entry) => !entry.archived && entry.kind !== 'worker' && entry.title)
        .map((entry) => entry.title as string);
    }
    return byInstance;
  }, [sessionsByInstance]);

  const [settingsView, setSettingsView] = React.useState<'general' | 'instances' | 'providers'>('general');
  /** The host whose Providers screen is open, when it was opened from a session's model picker. */
  const [providerEndpointId, setProviderEndpointId] = React.useState<string | undefined>(undefined);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [archiveConfirmKey, setArchiveConfirmKey] = React.useState<string | null>(null);
  /** The crew worker the Promote-to-peer dialog is open for; null when closed. */
  const [promoteTarget, setPromoteTarget] = React.useState<Session | null>(null);
  /** The image lightbox: a message's gallery and the open index, or null when closed. */
  const [imageViewer, setImageViewer] = React.useState<{ images: ViewerImage[]; index: number } | null>(
    null
  );
  /** Stable opener for the transcript/markdown; the modal itself lives at the app root. */
  const imageViewerApi = React.useMemo<ImageViewerApi>(
    () => ({
      open: (images, index) => setImageViewer({ images, index }),
      openOne: (image) => setImageViewer({ images: [image], index: 0 }),
    }),
    []
  );

  const [mobileRailOpen, setMobileRailOpen] = React.useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);
  const instanceSnapshotRevision = React.useRef(0);
  const readInstances = useStableCallback(async (refresh: boolean = true) => {
    const revision = ++instanceSnapshotRevision.current;
    const list = await listInstances(refresh);
    if (revision !== instanceSnapshotRevision.current) return;
    setInstances((previous) => shareValue(previous, list));
    setInstancesLoaded(true);
  });

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
  const { settings, settingsLoaded, settingsRef, hydrateSettings, refreshHarnessSettings, markSettingsLoaded, updateSettings } =
    useEmberSettings({ onError: showActionError, onBeforeSave: clearActionError });
  React.useEffect(() => {
    document.documentElement.style.setProperty('--conversation-text-size', `${settings.conversationFontSize ?? 14}px`);
  }, [settings.conversationFontSize]);

  // The remote web client's session can end under it (the desktop restarted, the password changed,
  // or the 12-hour idle window passed). The bridge reports that as one event so the user gets a
  // "sign in again" prompt instead of a JSON parse error over an empty window.
  React.useEffect(() => {
    const onExpired = () => showActionError(
      'Your remote session has ended. Reload this page and sign in again.',
      () => window.location.reload()
    );
    window.addEventListener('ember:session-expired', onExpired);
    return () => window.removeEventListener('ember:session-expired', onExpired);
  }, [showActionError]);
  const handleSettings = updateSettings;
  const setInstanceDefaultModel = (instanceId: string, model: import('./types').ModelRef) => {
    const current = settingsRef.current.instanceDefaults;
    handleSettings({ instanceDefaults: { ...current, [instanceId]: withInstanceDefaultModel(current[instanceId], model) } });
  };
  // Hidden instances live in settings, not in memory: unticking a host in the Instances menu is
  // "remove it from my list", and it used to be forgotten on the next launch.
  const hidden = React.useMemo(() => new Set(settings.hiddenInstances), [settings.hiddenInstances]);
  // Hosts whose outage warning was dismissed. Same reasoning — a sleeping laptop should not put
  // the row back on every launch — but a dismissal only survives *this* outage: see
  // reconcileOutageDismissals for when it is cleared.
  const dismissedOutages = React.useMemo(
    () => new Set(settings.dismissedOutages),
    [settings.dismissedOutages]
  );
  // Per-message read state lives in settings (`readMarks`), so it survives a restart — see
  // lib/readState. Opening a session does not mark anything; the dot on one message does.
  const readMarks = settings.readMarks;

  // Absent on the first launch that understood marks: everything older than this instant counts as
  // read, so the upgrade doesn't open Home with every message ever written flagged unread.
  const readSince = settings.readSince ?? 0;
  React.useEffect(() => {
    if (!settingsLoaded || settings.readSince !== undefined) return;
    handleSettings({ readSince: Date.now() });
  }, [settingsLoaded, settings.readSince, handleSettings]);
  // The transcript/rail display slice the eye menu edits; memoized so ChatView (memoized) only
  // re-renders when one of these actually changes.
  const viewSettings = React.useMemo(
    () => ({
      reasoningDisplay: settings.reasoningDisplay,
      hideToolCalls: settings.hideToolCalls,
      showQuestions: settings.showQuestions,
      expandToolCalls: settings.expandToolCalls,
      showMessageDetails: settings.showMessageDetails,
      showAvatars: settings.showAvatars,
      showActivityRail: settings.showActivityRail,
      compactSpacing: settings.compactSpacing,
      compactRail: settings.compactRail,
      autoFollow: settings.autoFollow,
      splitView: settings.splitView,
      toolDisplay: settings.toolDisplay,
    }),
    [
      settings.reasoningDisplay,
      settings.hideToolCalls,
      settings.showQuestions,
      settings.expandToolCalls,
      settings.showMessageDetails,
      settings.showAvatars,
      settings.showActivityRail,
      settings.compactSpacing,
      settings.compactRail,
      settings.autoFollow,
      settings.splitView,
      settings.toolDisplay,
    ]
  );

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
      setCommandPaletteOpen(true);
    };
    window.addEventListener('keydown', openOnShortcut);
    return () => window.removeEventListener('keydown', openOnShortcut);
  }, []);

  // Keep a live ref to the selected session so pollers can read its
  // directory (for routing) without re-running the effect on every session list refresh.
  const selectedSessionRef = React.useRef<Session | null>(null);
  const activeKeyRef = React.useRef<string | null>(null);
  const openSessionsRef = React.useRef<string[]>([]);
  const minimizedKeysRef = React.useRef<Set<string>>(new Set());
  /** Read by `openSession`, which is a stable callback and cannot depend on the setting. */
  const splitViewRef = React.useRef(false);
  // Per-project workspace memory: leaving a project saves its columns/tabs/active so returning
  // restores the exact layout instead of re-opening every session.
  const projectLayoutsRef = React.useRef<Map<string, Workspace>>(new Map());
  const workspaceHydratedRef = React.useRef(false);
  const workspaceRef = React.useRef<HTMLDivElement | null>(null);
  const sessionsByInstanceRef = React.useRef<Record<string, Session[]>>({});
  const projectsByInstanceRef = React.useRef<Record<string, Project[]>>({});
  // Directories named by prompt events (question/permission). OpenCode scopes prompts by directory,
  // and the event's directory is authoritative, so keep asking for it even when it isn't the
  // session folder we already know.
  const promptDirectoriesRef = React.useRef<Record<string, string[]>>({});
  const pendingCreatedSessions = React.useRef(new Map<string, { session: Session; expiresAt: number }>());
  // Snapshot the entries first: deleting from a Map while `forEach`-ing it can skip entries.
  const prunePendingCreated = (shouldDrop: (pending: { session: Session; expiresAt: number }) => boolean) => {
    [...pendingCreatedSessions.current.entries()].forEach(([key, pending]) => {
      if (shouldDrop(pending)) pendingCreatedSessions.current.delete(key);
    });
  };
  // Pending optimistic sends, scoped per session so one column's fetch can never release another's.
  const pendingOptimisticIds = React.useRef(new Map<string, Set<string>>());
  /** When each pending send was made, so a send whose echo never arrives can age out. */
  const pendingSentAt = React.useRef(new Map<string, number>());
  /**
   * Sends whose echo never came: no longer pending (the ledger may report them, nothing pretends an
   * answer is on its way), but still held on screen, because the words are the user's and a bubble
   * that quietly disappears is worse than one that says "Not confirmed".
   */
  const unconfirmedSends = React.useRef(new Set<string>());
  /** The last stop's receipt per session: what the host kept, while the queue read catches up. */
  const abortReceipts = React.useRef(new Map<string, AbortReceipt & { at: number }>());
  // A bounded record of what Ember sent, so a message missing from a later fetch is noticed.
  const sentLedgerRef = React.useRef<SentLedger>(new Map());
  const flaggedMissingSends = React.useRef(new Set<string>());
  // The input behind each optimistic send, so a failed bubble can be retried with exactly what
  // was sent (attachments, reply context, steer) rather than a reconstruction.
  const pendingInputs = React.useRef(
    new Map<string, { target: SessionRef; directory?: string; input: PromptInput }>()
  );
  const pendingFor = (key: string): Set<string> => {
    let ids = pendingOptimisticIds.current.get(key);
    if (!ids) {
      ids = new Set();
      pendingOptimisticIds.current.set(key, ids);
    }
    return ids;
  };
  const releaseOptimistic = (key: string, ids: readonly string[]) => {
    if (ids.length === 0) return;
    ids.forEach((id) => {
      unconfirmedSends.current.delete(id);
      pendingSentAt.current.delete(id);
    });
    const pending = pendingOptimisticIds.current.get(key);
    if (!pending) return;
    ids.forEach((id) => {
      pending.delete(id);
      pendingInputs.current.delete(id);
    });
    if (pending.size === 0) pendingOptimisticIds.current.delete(key);
  };
  /**
   * A send whose echo never arrived stops being "pending".
   *
   * Pending is a promise that an answer is coming; after `PENDING_SEND_TTL_MS` the evidence is
   * against it. The bubble is *kept* (`unconfirmedSends` protects it the way a retained failure is
   * protected) and its own note says what happened, so the words never vanish. What changes is that
   * the ledger may now report it, and no code path keeps re-appending a bubble for ever on the
   * strength of a request id that will never be answered.
   */
  const ageOutPendingSend = (key: string, messages: readonly ChatMessage[], now: number) => {
    const ids = pendingOptimisticIds.current.get(key);
    if (!ids || ids.size === 0) return;
    for (const id of [...ids]) {
      const message = messages.find((entry) => entry.id === id);
      const since = pendingSentAt.current.get(id) ?? message?.createdAt;
      if (since === undefined || now - since < PENDING_SEND_TTL_MS) continue;
      ids.delete(id);
      unconfirmedSends.current.add(id);
      // Nothing will ask when this was sent again: the bubble's own `createdAt` drives its note.
      pendingSentAt.current.delete(id);
    }
    if (ids.size === 0) pendingOptimisticIds.current.delete(key);
  };
  const bypassReplyIds = React.useRef(new Set<string>());
  const protectedTranscriptKeys = React.useRef(new Set<string>());
  const messageCacheRef = React.useRef(new TranscriptCache(() => new Set([
    ...protectedTranscriptKeys.current,
    ...[...pendingOptimisticIds.current].filter(([, ids]) => ids.size > 0).map(([key]) => key),
  ]), undefined, MESSAGE_CACHE_LIMIT));
  // A rendered transcript can outlive its LRU cache entry; read it through a ref so a tail still
  // merges against what is on screen rather than treating the column as empty.
  const transcriptsRef = React.useRef(transcripts);
  transcriptsRef.current = transcripts;
  const summariesRef = React.useRef<Record<string, SessionMessageSummary>>(summaries);
  summariesRef.current = summaries;
  // One deduplicated full repair per session when a tail has no safe overlap to merge.
  const fullRepairRef = React.useRef<(key: string) => void>(() => {});
  const fullRepairInFlight = React.useRef(new Set<string>());
  /** Consecutive failed full reads, per session, and where to stop starting them (lib/repairBudget). */
  const repairBudget = React.useRef(new RepairBudget());
  const [repairHalts, setRepairHalts] = React.useState<Record<string, RepairHalt>>({});
  // The session `updated` each cached transcript reflects. A newer `updated` means it is stale,
  // however recently it was read.
  const transcriptVersion = React.useRef(new Map<string, number>());
  const scheduledBindingsRef = React.useRef<Record<string, string>>({});
  const lastStatusAnnouncementRef = React.useRef<{
    key: string;
    state: BallState;
    signature: string;
  } | null>(null);
  const cacheMessages = (key: string, messagesForSession: ChatMessage[]) => {
    const cache = messageCacheRef.current;
    cache.delete(key);
    cache.set(key, messagesForSession);
    cache.prune();
  };

  const setTranscriptFor = (
    key: string,
    messagesForSession: ChatMessage[],
    status: MessagesStatus = 'ready',
    failure?: TranscriptFailureSource
  ) => {
    setTranscripts((prev) => {
      const current = prev[key];
      if (
        current &&
        current.messages === messagesForSession &&
        current.status === status &&
        current.failure === failure
      ) {
        return prev;
      }
      // Keep every other field the transcript carries (`historyComplete` and anything added
      // later). Rebuilding the object from three keys is how a completed history reverted to
      // "loading earlier messages" on the next commit.
      return { ...prev, [key]: applyTranscriptCommit(current, { messages: messagesForSession, status, failure }) };
    });
  };

  // PERF-4: the LRU message cache is bounded, but `transcripts` is not — it would otherwise retain
  // every transcript a column ever loaded. Keep only the open sessions, whatever the cache still
  // holds, and the active session; anything else is a fetch away. Reading the cache ref is safe
  // here because every cache write is paired with a transcript write, so this effect re-runs.
  React.useEffect(() => {
    messageCacheRef.current.prune();
    setTranscripts((prev) =>
      pruneTranscripts(
        prev,
        transcriptKeysToKeep([...protectedTranscriptKeys.current], [...messageCacheRef.current.keys()], activeSession)
      )
    );
    for (const key of transcriptVersion.current.keys()) {
      if (!messageCacheRef.current.has(key) && !transcriptsRef.current[key]) transcriptVersion.current.delete(key);
    }
  }, [transcripts, openSessions, activeSession, minimizedSessions, workspaceWidth]);

  const commitSummary = React.useCallback(
    (key: string, messagesForSession: ChatMessage[], complete: boolean, version?: number) => {
      const summary = summarizeMessages(messagesForSession, {
        previous: summariesRef.current[key],
        complete,
        version,
      });
      setSummaries((prev) => {
        const existing = prev[key];
        if (existing && sameSummary(existing, summary)) return prev;
        return { ...prev, [key]: summary };
      });
    },
    []
  );

  /**
   * A full read that a tail could not reconcile.
   *
   * A request made while a read is already in flight must not be dropped: the in-flight read was
   * started before whatever made the tail unreconcilable, so its answer can still leave the
   * transcript short. Dropping the request is how a reopened session kept rendering only its tail —
   * the cache looked healthy, the tail could not overlap it, the repair was skipped because the
   * poll happened to be mid-read, and nothing tried again.
   */
  const pendingRepair = React.useRef(new Set<string>());
  const requestFullRepair = React.useCallback((key: string) => {
    if (fullRepairInFlight.current.has(key)) {
      // Remember it; the read in flight replays this when it settles.
      pendingRepair.current.add(key);
      return;
    }
    fullRepairInFlight.current.add(key);
    fullRepairRef.current(key);
  }, []);

  /**
   * The single transcript commit path. Every fetched full or tail response goes through here so
   * structural sharing, optimistic reconciliation, the message cache and the compact summary stay
   * in lockstep no matter which caller issued the fetch.
   */
  const commitFetchedTranscript = useStableCallback(
    (
      key: string,
      fetched: ChatMessage[],
      mode: 'full' | 'tail' | 'append',
      version?: number,
      repair = true,
      /** Results whose call was committed by an earlier read; applied to the held transcript. */
      settlements?: readonly ToolResultSettlement[],
      /**
       * Output of calls still executing, from the same read. An incremental page is usually empty
       * (the call was committed earlier), so without this a running command's streamed output never
       * reached the row that was already on screen.
       */
      liveOutputs?: readonly LiveToolOutput[]
    ) => {
      const current =
        messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
      const now = Date.now();
      ageOutPendingSend(key, current, now);
      const pending = pendingOptimisticIds.current.get(key) ?? new Set<string>();
      // A send the host said it placed but never echoed back is no longer pending, yet it is still
      // the user's words: reconciliation keeps it exactly as it keeps a retained failure. The two
      // sets differ only in what they claim — pending says an echo is coming, this says it is not.
      const held = new Set(pending);
      unconfirmedSends.current.forEach((id) => held.add(id));
      const outcome =
        mode === 'tail'
          ? reconcileTranscriptTail(current, fetched, held)
          : mode === 'append'
            ? reconcileTranscriptAppend(current, fetched, held)
            : reconcileFullTranscript(current, fetched, held);
      // A tool result is not a message: it carries the settlement of a call that an earlier page
      // already committed. Patch the transcript we hold with it, or the tool row keeps the status it
      // was drawn with and its output is lost. No-op (same array) when nothing actually changed.
      const settled =
        settlements && settlements.length > 0
          ? settleToolResults(outcome.messages, settlements)
          : outcome.messages;
      // A running call's output arrives on the same page that carries no new entries; patch it onto
      // the call already held. No-op (same array) when nothing changed.
      const messages =
        liveOutputs && liveOutputs.length > 0
          ? applyLiveToolOutput(settled, liveOutputs)
          : settled;
      // A background tail with no overlap isn't worth a full fetch nobody is looking at; the stale
      // version makes the next switch-in repair it instead.
      if (outcome.needsFullFetch && !repair) {
        commitSummary(key, fetched, false, version);
        return;
      }
      if (outcome.reconciledOptimisticIds.length > 0) {
        releaseOptimistic(key, outcome.reconciledOptimisticIds);
      }
      // Diagnostic for a reported flash: a message that was on screen and is not pending must never
      // vanish because a *tail* or *append* landed — only an authoritative full read may remove
      // anything (compaction, a fork, a rewrite). If this warns, the id and the mode say which read
      // dropped it, which is the difference between a host returning a short page and a client
      // reconciliation bug. Cheap: only compares ids of the arrays already in hand.
      if (mode !== 'full' && current.length > 0) {
        const kept = new Set(messages.map((message) => message.id));
        const dropped = current.filter((message) => !kept.has(message.id) && !held.has(message.id));
        if (dropped.length > 0) {
          console.warn('[ember] a transcript read removed messages it did not replace', {
            key,
            mode,
            dropped: dropped.map((message) => ({ id: message.id, role: message.role, live: message.live === true })),
          });
        }
      }
      cacheMessages(key, messages);
      setTranscriptFor(key, messages, 'ready');
      commitSummary(key, messages, mode === 'full', version);
      // Sent-message ledger: notice any send that has vanished from the committed transcript.
      for (const record of missingSent(sentLedgerRef.current, key, messages, pending, now)) {
        if (flaggedMissingSends.current.has(record.id)) continue;
        flaggedMissingSends.current.add(record.id);
        console.warn('[ember] a sent message is missing from the transcript', { key, record });
        // The bubble is the usual surface for this (its own "Not confirmed" note). This is the
        // case where the bubble is gone too, so the notice has to carry the text and the way out:
        // a message cannot be reported as lost and then be unreachable.
        const preview = record.text.trim().replace(/\s+/g, ' ').slice(0, 60);
        const replay = pendingInputs.current.get(record.id);
        setActionNotice({
          message: `The host took “${preview}” but never showed it in this conversation — it may not have arrived.`,
          ...(replay
            ? {
                actionLabel: 'Send again',
                action: () => {
                  forgetPendingSend(key, record.id);
                  void sendTo(replay.target, replay.directory, replay.input, { retainOnFailure: true });
                },
              }
            : {}),
        });
      }
      if (outcome.needsFullFetch) requestFullRepair(key);
      else transcriptVersion.current.set(key, version ?? 0);
    }
  );

  /**
   * Apply a streamed chunk to the live message on screen, instead of reading the transcript again.
   *
   * Returns true when the hint is fully handled. False — no live message yet, a session that is not
   * on screen, a transcript that is not settled — means the caller should take the REST path, which
   * is also how the first chunk of a turn arrives and how any drift is corrected.
   */
  const applyStreamDeltas = useStableCallback(
    (instanceId: string, sessionId: string, deltas: LiveDelta[]): boolean => {
      const key = sessionKey({ instanceId, sessionId });
      if (!sessionIsLoaded({ instanceId, sessionId }, columnsRef.current, activeSessionRef.current, document.hidden)) {
        return false;
      }
      const transcript = transcriptsRef.current[key];
      // Never append into a transcript that is showing an error or still loading: the read that
      // resolves it is the one that should draw the message.
      if (!transcript || transcript.status !== 'ready') return false;
      const current = messageCacheRef.current.get(key) ?? transcript.messages;
      const next = applyLiveDeltas(current, deltas);
      if (next === null) return false;
      if (next !== current) {
        cacheMessages(key, next);
        setTranscriptFor(key, next, 'ready');
      }
      return true;
    }
  );

  /**
   * Fold a tail that was fetched for a background session's preview into its cached transcript,
   * so switching back renders current messages with no extra request. Sessions without a cached
   * transcript stay summary-only; this never grows the cache.
   */
  const mergeBackgroundTail = useStableCallback(
    (
      key: string,
      tail: ChatMessage[],
      version?: number,
      mode: 'tail' | 'append' = 'tail',
      settlements?: readonly ToolResultSettlement[]
    ) => {
      if (messageCacheRef.current.has(key)) {
        commitFetchedTranscript(key, tail, mode, version, false, settlements);
      }
      // A summary is derived from the messages it is given, so a delta would describe only the newest
      // few turns. A session with no cached transcript keeps the bounded tail for that reason.
      else commitSummary(key, tail, false, version);
    }
  );

  const updateCachedMessages = (
    key: string,
    updater: (messagesForSession: ChatMessage[]) => ChatMessage[]
  ) => {
    const next = updater(
      messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? []
    );
    cacheMessages(key, next);
    setTranscriptFor(key, next, 'ready');
  };

  /**
   * The instant a stop is requested, mark every in-flight tool step in the cached transcript as
   * interrupted so its spinner becomes a `[step interrupted]` row without waiting for the server
   * round trip. The authoritative fetch that follows replaces this with the committed result.
   */
  const markSessionStepsInterrupted = (instanceId: string, sessionId: string) => {
    const key = sessionKey({ instanceId, sessionId });
    const current = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages;
    if (!current) return;
    let changed = false;
    const next = current.map((message) => {
      if (!message.parts.some((part) => part.type === 'tool' && (part.call.status === 'running' || part.call.status === 'pending'))) {
        return message;
      }
      changed = true;
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'tool' && (part.call.status === 'running' || part.call.status === 'pending')
            ? { ...part, call: { ...part.call, status: 'interrupted' as const } }
            : part
        ),
      };
    });
    if (changed) {
      cacheMessages(key, next);
      setTranscriptFor(key, next, 'ready');
    }
  };

  /**
   * The first-run guide.
   *
   * Derived from what is actually true — a local harness that answers, or another host that does —
   * rather than from "have sessions ever existed". `onboardedAt` is the migration: an install that
   * has ever had a working host is set up, whatever this launch looks like, so upgrading to the
   * build that introduced the guide does not lecture someone who has used Ember for months.
   */
  const onboardingState: OnboardingState = React.useMemo(() => {
    const localView = settings.localHarnessState;
    const localEndpoint = instances.find((instance) => instance.id === 'pi:local');
    const localReady = localEndpoint?.status === 'ready';
    const remoteReady = instances.some((instance) => instance.id !== 'pi:local' && instance.status === 'ready');
    const target =
      localEndpoint?.status === 'ready'
        ? localEndpoint.id
        : instances.find((instance) => instance.status === 'ready')?.id ?? null;
    return {
      localReady,
      canRotate: settings.localHarnessCanRotate === true,
      remoteReady,
      targetInstanceId: target,
      // A harness that answered is also "ready" before the instance list catches up; the state
      // written by the launcher is the earlier signal and avoids a flash of the failure copy.
      ...(localView?.kind === 'started' || localView?.kind === 'restarted' || localView?.kind === 'attached'
        ? {}
        : {}),
    };
  }, [instances, settings.localHarnessCanRotate, settings.localHarnessState]);

  /**
   * The dev fixture that walks the *connected* path.
   *
   * `?fixture=onboarding` describes a working install whose guide has not been dismissed, which is a
   * state `needsOnboarding` deliberately says "no" to (a working host means set up). The fixture
   * exists so that path can be seen in a browser at all, so it overrides only the readiness part.
   */
  const onboardingFixture =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fixture') === 'onboarding';

  const onboardingOpen =
    settingsLoaded &&
    !settings.onboardedAt &&
    !settings.onboardingDismissedAt &&
    (onboardingFixture || needsOnboarding(onboardingState, settings.onboardingDismissedAt, settings.onboardingStartedAt));

  /** What the wizard reports when the local harness did not start; null when it did. */
  const onboardingProblem =
    settings.localHarnessState && !onboardingState.localReady
      ? settings.localHarnessState.notice ?? null
      : null;

  const readyIds = React.useMemo(
    () => instances.filter((instance) => instance.attachable).map((instance) => instance.id),
    [instances]
  );
  // Stable key so effects re-run only when the set of connected instances changes.
  const readyKey = readyIds.join('\u0000');

  /**
   * The instances Ember still knows about, connected or not.
   *
   * Every list below is built from this rather than from `readyIds`: an unreachable host keeps the
   * session list from its last answer in `sessionsByInstance` (a failed poll omits the instance
   * instead of emptying it), and filtering by `readyIds` here is what turned an outage into what
   * looked like deletion — a rail showing only the one session pinned back in. The set is what keeps
   * a *removed* endpoint's leftovers out, which is a different thing from a silent one.
   */
  const knownIds = React.useMemo(() => new Set(instances.map((instance) => instance.id)), [instances]);

  // The rail lists active sessions only; archived sessions live behind the top-bar archive
  // screen. The recency window still trims the active list. Date.now() is read inside the memo,
  // so the cut-off refreshes with every session poll rather than needing a timer.
  const { sessionWindowHours } = settings;
  const sessions = React.useMemo(() => {
    const cutoff = sessionWindowHours > 0 ? Date.now() - sessionWindowHours * 3_600_000 : 0;
    return Object.entries(sessionsByInstance)
      .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
      .flatMap(([, list]) => list)
      .filter((session) => {
        // Crew workers are hidden from the rail: they surface only in their leader's strip.
        if (isWorker(session)) return false;
        // A scheduled run is an ordinary session: same list, same window, same archive rules.
        return !session.archived && (!cutoff || (session.updated ?? 0) >= cutoff);
      });
  }, [sessionsByInstance, knownIds, hidden, sessionWindowHours]);

  /**
   * What the launch is still waiting on, in one neutral line. The rail's skeleton rows were the only
   * startup signal and read as data loss, so this says plainly which of the two things is happening:
   * a Hearth that has not answered yet, or a session list still filling in.
   */
  const startupMessage = React.useMemo(
    () =>
      startupNotice({
        bootstrapping: !instancesLoaded,
        // A ready instance with no list yet is the interesting case: the request is out and the
        // answer hasn't landed. An empty list from a short read is not evidence either way (see the
        // pruning effect below), so this only counts instances that have never reported.
        waitingForSessions: readyIds.filter((id) => sessionsByInstance[id] === undefined).length,
        unreachable: instances.filter((instance) => instance.status === 'unreachable').length,
        sessionCount: sessions.length,
      }),
    [instancesLoaded, readyIds, sessionsByInstance, instances, sessions.length]
  );

  /**
   * The scheduling plans, for the rail's own section: a trigger per configured task, sorted by name.
   * The *runs* are ordinary sessions in the list above (a calendar mark says what started them).
   */
  const scheduledTaskList = React.useMemo(
    () =>
      Object.values(scheduledTasksByKey).sort(
        (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
      ),
    [scheduledTasksByKey]
  );

  /** Session key → the scheduled task its latest run belongs to, when Ember has both. */
  const scheduledTaskBySession = React.useMemo(() => {
    const map: Record<string, ScheduledTask> = {};
    for (const [key, taskKey] of Object.entries(settings.scheduledSessionBindings)) {
      const task = scheduledTasksByKey[taskKey];
      if (task) map[key] = task;
    }
    return map;
  }, [settings.scheduledSessionBindings, scheduledTasksByKey]);

  const archivedSessions = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list)
        .filter((session) => Boolean(session.archived) && !isWorker(session)),
    [knownIds, sessionsByInstance, hidden]
  );

  // Active + archived, ignoring the recency window, for the rail's broadened search.
  const everySession = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list)
        .filter((session) => !isWorker(session)),
    [knownIds, sessionsByInstance, hidden]
  );

  const allSessions = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list)
        .filter((session) => !isWorker(session)),
    [knownIds, sessionsByInstance, hidden]
  );

  /**
   * Every known session, **workers included**.
   *
   * The rail hides workers, but their summaries are what the cost badge needs: a worker is a separate
   * conversation with its own ledger, so a leader's own `cost` is only its own turns. This is the
   * list the crew walk reads — not `allSessions`, which is deliberately worker-free.
   */
  const everyKnownSession = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list),
    [knownIds, sessionsByInstance, hidden]
  );

  /**
   * What each session has actually cost, its crew included (`lib/crewCost`). Keyed by session, so a
   * column can look its own up without walking the tree again on every render of the list.
   */
  const crewCostByKey = React.useMemo(() => {
    const map = new Map<string, ReturnType<typeof crewCostState>>();
    for (const session of everyKnownSession) {
      // "Has this run at all?" — the summary's newest entry id answers it without a transcript read;
      // a priced ledger or a cached transcript covers the instances that send no entry ids.
      const hasRun =
        session.lastEntryId !== undefined ||
        (typeof session.cost === 'number' && session.cost > 0) ||
        (messageCacheRef.current.get(sessionKey(session))?.length ?? 0) > 0;
      map.set(sessionKey(session), crewCostState(crewCostOf(session, hasRun, everyKnownSession)));
    }
    return map;
  }, [everyKnownSession]);

  /**
   * Configured hosts that are not answering, with the sessions Ember still lists from each one's
   * last answer. The rail renders one honest row per entry and nothing pretends the sessions were
   * deleted. Instances the user switched off in the Instances menu are left out: they are hidden on
   * purpose, not silent.
   */
  const silentInstancesList = React.useMemo(
    () => silentInstances(instances, allSessions, hidden, dismissedOutages),
    [instances, allSessions, hidden, dismissedOutages]
  );

  /**
   * A host that answers clears its own dismissal, so the warning is back the next time it goes
   * down. Deliberately keyed on `instances` rather than run on a timer: the probe result is the
   * only evidence there is, and `reconcileOutageDismissals` returns the same array when nothing
   * changed, which is what keeps this from writing settings on every render.
   */
  React.useEffect(() => {
    const current = settingsRef.current.dismissedOutages;
    if (current.length === 0) return;
    const next = reconcileOutageDismissals(current, instances);
    if (next === current) return;
    handleSettings({ dismissedOutages: next });
  }, [instances, handleSettings, settingsRef]);

  /**
   * Crew workers grouped by their leader's key. Workers ride the session list (they are hidden
   * from the rail, not from the fetch), so the strip and the rollup need no extra reads. Built
   * from every known instance, not the recency window, so a busy worker never ages out of view.
   */
  const crewWorkers = React.useMemo(
    () =>
      crewByLeader(
        Object.values(sessionsByInstance)
          .flat()
      ),
    [sessionsByInstance]
  );

  /**
   * The keys whose blob should read `needs-input` because someone in their crew does — including
   * a worker that is itself a leader (transitive), and a worker's own summary flag. A pending
   * worker question is a decision the leader is accountable for, so it rolls all the way up.
   */
  const crewNeedsInputKeys = React.useMemo(() => {
    const keys = new Set<string>();
    const all = Object.values(sessionsByInstance).flat();
    for (const session of all) {
      if (session.needsInput !== true && !leaderNeedsInput(session, all)) continue;
      keys.add(sessionKey(session));
    }
    return keys;
  }, [sessionsByInstance]);

  /**
   * Leader key → the workers **below** it that are blocked on the human, at any depth
   * (`blockedWorkersUnder`). A leader's blob already glows for a nested need, but the rail hides
   * workers, so without this the human could not see *which* sub-agent is asking: the crew strip
   * only lists the leader's direct workers, and a sub-agent's question lives one strip deeper.
   *
   * Derived from the session list on every poll, so answering a question drops the entry — nothing
   * accumulates. Only direct crews are walked (`blockedWorkersUnder` skips an entry it has already
   * visited), and only keys with something blocked are stored, so a calm rail costs nothing.
   */
  const blockedCrewByLeader = React.useMemo(() => {
    const map = new Map<string, ReturnType<typeof blockedWorkersUnder>>();
    const all = Object.values(sessionsByInstance).flat();
    all.forEach((session) => {
      if (isWorker(session) && session.needsInput !== true) return;
      const blocked = blockedWorkersUnder(session, all);
      if (blocked.length > 0) map.set(sessionKey(session), blocked);
    });
    return map;
  }, [sessionsByInstance]);

  const permissions = React.useMemo(
    () => Object.values(permissionsByInstance).flat(),
    [permissionsByInstance]
  );
  const questions = React.useMemo(
    () => Object.values(questionsByInstance).flat(),
    [questionsByInstance]
  );

  // The instances whose status Ember actually has an answer from: reachable, and answered recently.
  const statesAnswered = React.useMemo(
    () => instancesWithFreshStates(instances, stateReadAt, stateClock),
    [instances, stateReadAt, stateClock]
  );

  // The status endpoint only knows idle/busy. A failed last turn makes an idle session `error`;
  // a pending approval or question trumps everything: the agent is blocked on us — and a prompt is
  // knowledge even when the busy flag is not, which is why those two overlays apply to `unknown`
  // too, and the failed-turn one does not.
  const states = React.useMemo(() => {
    const merged = sessionStates(sessionsByInstance, statesByInstance, statesAnswered);
    Object.entries(summaries).forEach(([key, summary]) => {
      if (summary.failed && (merged[key] ?? 'unknown') === 'idle') merged[key] = 'error';
    });
    [...permissions, ...questions].forEach((request) => {
      merged[sessionKey({ instanceId: request.instanceId, sessionId: request.sessionId })] = 'needs-input';
    });
    // A worker's pending request is the leader's decision too: roll it up the lead chain so a
    // leader looks blocked while its crew waits on the human.
    crewNeedsInputKeys.forEach((key) => {
      merged[key] = 'needs-input';
    });
    return merged;
  }, [sessionsByInstance, statesByInstance, statesAnswered, permissions, questions, summaries, crewNeedsInputKeys]);

  // Which kind of pending prompt a session has, so the blob can show a lock vs a question.
  const promptKinds = React.useMemo(() => {
    const kinds: Record<string, 'input' | 'question'> = {};
    permissions.forEach((request) => {
      kinds[sessionKey({ instanceId: request.instanceId, sessionId: request.sessionId })] = 'input';
    });
    questions.forEach((request) => {
      kinds[sessionKey({ instanceId: request.instanceId, sessionId: request.sessionId })] = 'question';
    });
    // A rolled-up crew need has no prompt of its own: show the question tilt, not a padlock.
    crewNeedsInputKeys.forEach((key) => {
      if (!kinds[key]) kinds[key] = 'question';
    });
    return kinds;
  }, [permissions, questions, crewNeedsInputKeys]);

  const selected = React.useMemo(() => parseSessionKey(activeSession), [activeSession]);
  const selectedKey = activeSession;
  // Rail previews are derived from the compact summaries, which survive transcript-cache eviction.
  const previews = React.useMemo(
    () => Object.fromEntries(Object.entries(summaries).map(([key, summary]) => [key, summary.preview])),
    [summaries]
  );
  // Thinking = an active session whose latest assistant turn is streaming with no tool running.
  // Summaries carry this even for sessions whose full transcript was never cached.
  const thinkingKeys = React.useMemo(() => {
    const keys = new Set<string>();
    Object.entries(summaries).forEach(([key, summary]) => {
      if (summary.thinking && (states[key] ?? 'unknown') === 'active') keys.add(key);
    });
    return keys;
  }, [states, summaries]);
  // Unread is per message now: a session is unread when its digest still holds a message the marks
  // do not cover. Busy/error/needs-input moods take priority over the unread dot.
  const unreadSessions = React.useMemo(
    () => scheduledReadSessions(everySession, settings.scheduledSessionBindings),
    [everySession, settings.scheduledSessionBindings]
  );
  const unreadDigests = useUnreadDigests({
    sessions: unreadSessions,
    marks: readMarks,
    readSince,
    enabled: settingsLoaded,
  });
  const unreadKeys = React.useMemo(() => {
    const keys = new Set<string>();
    unreadSessions.forEach((session) => {
      const key = sessionKey(session);
      if (!settings.mutedSessions?.includes(key) &&
          hasUnreadMessages(session, readMarks[key], unreadDigests.digests[key])) keys.add(key);
    });
    return keys;
  }, [unreadSessions, unreadDigests.digests, readMarks, settings.mutedSessions]);

  const quietKeys = React.useMemo(() => new Set(settings.mutedSessions ?? []), [settings.mutedSessions]);

  const failedSessionKeys = React.useMemo(() => {
    const keys = new Set<string>();
    Object.entries(summaries).forEach(([key, summary]) => {
      if (summary.failed) keys.add(key);
    });
    return keys;
  }, [summaries]);

  const scheduledRuns = React.useMemo(
    () =>
      buildScheduledRuns({
        tasks: scheduledTaskList,
        sessions: everySession,
        bindings: settings.scheduledSessionBindings,
        states,
        failedKeys: failedSessionKeys,
        readMarks,
        mutedSessions: settings.mutedSessions,
        seenBaselineAt: readSince ?? 0,
        unreadKeys,
        instances,
      }),
    [
      scheduledTaskList,
      everySession,
      settings.scheduledSessionBindings,
      states,
      failedSessionKeys,
      readMarks,
      settings.mutedSessions,
      readSince,
      unreadKeys,
      instances,
    ]
  );

  const unseenScheduledRunsCount = React.useMemo(
    () => countUnseenScheduledRuns(scheduledRuns),
    [scheduledRuns]
  );

  const moods = React.useMemo(() => {
    const map: Record<string, BallMood> = {};
    Object.entries(sessionsByInstance).forEach(([, list]) =>
      list.forEach((session) => {
        const key = sessionKey(session);
        map[key] = moodFrom(
          states[key] ?? 'unknown',
          promptKinds[key],
          thinkingKeys.has(key),
          unreadKeys.has(key)
        );
      })
    );
    return map;
  }, [sessionsByInstance, states, promptKinds, thinkingKeys, unreadKeys]);
  // A retry belongs to the session it failed on; the banner text may still apply.
  React.useEffect(() => {
    clearActionErrorRetry();
  }, [selectedKey, clearActionErrorRetry]);
  // YOLO mode. When the instance supports server-side auto-accept, the server's per-session
  // policy is the truth (it's what OpenChamber shows as "Permission auto-accept"). Otherwise
  // fall back to a local override and Ember replies to prompts itself while the session is open.
  const selectedPolicy = selected ? autoAcceptByInstance[selected.instanceId] : undefined;
  const serverYolo = Boolean(selectedPolicy?.supported);
  const bypass = selectedKey && selected
    ? serverYolo
      ? selectedPolicy?.sessions[selected.sessionId] ?? false
      : bypassOverrides[selectedKey] ?? settings.instanceDefaults[selected.instanceId]?.bypass ?? false
    : false;
  const selectedSession = selected
    ? (sessionsByInstance[selected.instanceId] ?? []).find((s) => s.id === selected.sessionId) ?? null
    : null;
  // Reading a session is not the same as reading its messages: opening a column marks nothing.
  // The only ways a mark moves are the dot on one unread message and "Mark all as read".
  const selectedInstance = selected
    ? instances.find((instance) => instance.id === selected.instanceId) ?? null
    : null;
  const selectedQueue = selected
    ? (queuesByInstance[selected.instanceId] ?? []).find((queue) => queue.sessionId === selected.sessionId) ?? null
    : null;
  // Every blob renderer memoizes on its identity object, so hand back the previous reference
  // whenever a session's identity hasn't actually changed; otherwise each 10s poll would
  // re-derive traits for every visible avatar.
  const avatarIdentitiesRef = React.useRef<Record<string, AvatarIdentity>>({});
  const avatarIdentities = React.useMemo(() => {
    const previous = avatarIdentitiesRef.current;
    const next = Object.fromEntries(
      Object.entries(sessionsByInstance).flatMap(([instanceId, list]) =>
        list.map((session) => {
          const key = sessionKey(session);
          const identity = resolveAvatarIdentity(
            session,
            projectsByInstance[instanceId] ?? [],
            settings.scheduledSessionBindings,
            settings.avatarOverrides
          );
          const before = previous[key];
          return [key, before && sameIdentity(before, identity) ? before : identity];
        })
      )
    );
    avatarIdentitiesRef.current = next;
    return next;
  }, [sessionsByInstance, projectsByInstance, settings.scheduledSessionBindings, settings.avatarOverrides ]);
  // avatarIdentities keeps stable references, and the fallback is memoized on the key, so this
  // is safe to use directly as an effect dependency.
  const selectedIdentity = React.useMemo(
    () => (selectedKey ? avatarIdentities[selectedKey] ?? seedIdentity(selectedKey) : seedIdentity('')),
    [selectedKey, avatarIdentities]
  );
  // The blob a new-agent draft will get: resolve it from the folder being used, so the draft shows
  // the destination project's colour (and its override) rather than a generic placeholder.
  const resolveDraftIdentity = React.useCallback(
    (instanceId: string, directory: string): AvatarIdentity =>
      resolveAvatarIdentity(
        { id: `draft:${instanceId}`, instanceId, directory },
        projectsByInstance[instanceId] ?? [],
        settings.scheduledSessionBindings,
        settings.avatarOverrides
      ),
    [projectsByInstance, settings.scheduledSessionBindings, settings.avatarOverrides ]
  );
  const avatarPickerIdentity = avatarPickerSession
    ? avatarIdentities[sessionKey(avatarPickerSession)] ??
      resolveAvatarIdentity(
        avatarPickerSession,
        projectsByInstance[avatarPickerSession.instanceId] ?? [],
        settings.scheduledSessionBindings,
        settings.avatarOverrides
      )
    : seedIdentity('');
  const avatarPickerProject = avatarPickerSession
    ? projectForSession(avatarPickerSession, projectsByInstance[avatarPickerSession.instanceId] ?? [])
    : null;
  // Appearance belongs to the project/folder, so that scope comes first and is the picker's
  // default; the scheduled-task and single-session scopes stay available underneath it.
  const avatarPickerFolderName = avatarPickerSession?.directory
    ? avatarPickerSession.directory.split(/[\\/]/).filter(Boolean).pop() ?? avatarPickerSession.directory
    : null;
  const avatarPickerScopes = avatarPickerSession
    ? [
        { key: sessionAvatarKey(avatarPickerSession), kind: 'session' as const, label: 'This session' },
        ...(avatarPickerIdentity.projectKey
          ? [{
              key: avatarPickerIdentity.projectKey,
              kind: 'project' as const,
              label: avatarPickerProject ? `Project: ${avatarPickerProject.name}` : `Folder: ${avatarPickerFolderName}`,
            }]
          : []),
        ...(avatarPickerIdentity.taskKey
          ? [{
              key: avatarPickerIdentity.taskKey,
              kind: 'task' as const,
              label: `Scheduled task: ${scheduledTaskNames[avatarPickerIdentity.taskKey] ?? 'this task'}`,
            }]
          : []),
      ]
    : [];
  // Sync the ref every render so the poller always sees the current directory.
  selectedSessionRef.current = selectedSession;
  activeKeyRef.current = selectedKey;
  openSessionsRef.current = openSessions;
  minimizedKeysRef.current = minimizedSessions;
  splitViewRef.current = settings.splitView;
  sessionsByInstanceRef.current = sessionsByInstance;
  projectsByInstanceRef.current = projectsByInstance;
  scheduledBindingsRef.current = settings.scheduledSessionBindings;

  React.useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // Check GitHub for a newer release on startup and every 6 hours.
  React.useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        if (window.ember.checkForUpdate) {
          const result = await window.ember.checkForUpdate();
          if (!cancelled && result?.updateAvailable && result.latestVersion) {
            setAvailableUpdate(result);
          }
          return;
        }
        const current = await window.ember.appVersion?.().catch(() => null);
        if (!current || cancelled) return;
        const result = await checkGithubForUpdate(current);
        if (!cancelled && result.updateAvailable && result.latestVersion) {
          setAvailableUpdate(result);
        }
      } catch {
        // Ignore update check failures.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // The app icon mirrors the selected session's blob (and its mood) so a glance at the Dock -- or,
  // on Windows, the taskbar -- says which agent this window is on. Theme is a dependency because the
  // tile and the contrast-adjusted palettes come from the current CSS variables.
  const selectedState: BallState = selectedKey ? states[selectedKey] ?? 'unknown' : 'idle';
  const selectedMood: BallMood = selectedKey ? moods[selectedKey] ?? 'unknown' : 'idle';
  React.useEffect(() => {
    // No `selectedKey` guard: the icon should be the blob from launch, not only once a session is
    // chosen. With nothing selected it simply mirrors the idle mood.
    // Gate on `capabilities.dockIcon` when the bridge reports capabilities so clients without dock
    // support (`?noDock` or web remote) never load the dock renderer.
    if (!window.ember.setAppIcon || window.ember.capabilities?.dockIcon === false) return;
    let cancelled = false;
    // The attempt goes in the log too: without it, "no line" cannot be told apart from "the effect
    // never ran", and that is the difference between a broken render and a stale build.
    void window.ember.reportAppIconIssue?.(`attempt blob=${settings.blobStyle} mood=${selectedMood} key=${selectedKey ?? '-'}`);
    void import('./blob/dockIcon')
      .then(({ renderDockIcon }) =>
        cancelled ? undefined : renderDockIcon(settings.blobStyle, selectedIdentity, selectedMood)
      )
      .then((dataUrl) => {
        if (cancelled) {
          void window.ember.reportAppIconIssue?.('cancelled before the icon was rendered');
          return undefined;
        }
        if (!dataUrl) {
          void window.ember.reportAppIconIssue?.('the rasteriser returned nothing');
          return undefined;
        }
        return window.ember.setAppIcon(dataUrl).then((result) => {
          // A refused icon is silent otherwise, and "the icon is wrong" is impossible to diagnose
          // from the outside. One line names the reason.
          if (result && !result.ok) console.warn('App icon not applied:', result.reason ?? 'unknown');
        });
      })
      .catch((err: unknown) => {
        console.warn('App icon render failed', err);
        void window.ember.reportAppIconIssue?.(`render failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, selectedIdentity, selectedMood, settings.blobStyle, settings.theme]);

  const refreshInstances = React.useCallback(async function refreshInstances() {
    setRefreshing(true);
    showActionError(null);
    // Asking again is asking again: an explicit reprobe re-arms every dismissed warning, so a
    // host someone silenced can never be stuck silent because they looked from somewhere else.
    if (settingsRef.current.dismissedOutages.length > 0) handleSettings({ dismissedOutages: [] });
    try {
      await readInstances();
    } catch (err) {
      showActionError(
        err instanceof Error ? err.message : 'Could not reprobe instances.',
        () => void refreshInstances()
      );
    } finally {
      setRefreshing(false);
    }
  }, [showActionError, readInstances, handleSettings, settingsRef]);

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
  }, [hydrateSettings, markSettingsLoaded, showActionError, readInstances]);

  // ---- Workspace: open columns, the active one, and sticky minimized sessions. ----
  // The helpers below are the only writers of workspace state; `activeSession` is the single
  // source of truth for `selected`, so existing selection-driven code keeps working unchanged.

  /** The project identity the current open group belongs to, or a standalone bucket. */
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
  }, []);
  /** Remember the current workspace under its project before switching away. */
  const saveCurrentLayout = React.useCallback(() => {
    const contextKey = currentContextKey();
    if (!contextKey) return;
    projectLayoutsRef.current.set(contextKey, {
      open: [...openSessionsRef.current],
      active: activeKeyRef.current,
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
  const openSession = React.useCallback((ref: SessionRef, known?: Session | null) => {
    void known;
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
  }, [saveCurrentLayout, setDraftPendingId]);

  /**
   * Open a project. `projectSessions` is exactly what the project's card showed, so opening it
   * never pulls in out-of-window or archived sessions that share the directory. If some of the
   * project's sessions are already open, only the missing ones are added (preserving the current
   * layout). If none are open, the remembered layout is restored; otherwise every session opens in
   * recency order. An empty set opens a draft.
   */
  /** Open a group: its members become the workspace's columns, replacing whatever was open. */
  const openGroup = (members: Session[]) => {
    showActionError(null);
    const keys = members.filter((session) => !session.archived && !isWorker(session)).map(sessionKey);
    if (keys.length === 0) return;
    saveCurrentLayout();
    setNewSessionInstanceId(null);
    setNewSessionDirectory(null);
    setOpenSessions(keys);
    setActiveSession(keys[0]);
    setMinimizedSessions(new Set());
    setUsageOpen(false);
    setScheduledOpen(false);
  };

  const ungroupGroup = (groupId: string) => {
    handleSettings({
      sessionGroups: settingsRef.current.sessionGroups.filter((group) => group.id !== groupId),
    });
  };

  /** Save (or create) a group from the panel. Editing keeps its place in the rail's order. */
  const saveGroup = (group: { id: string; name: string; keys: string[]; primaryKey?: string }) => {
    handleSettings({
      sessionGroups: upsertGroup(settingsRef.current.sessionGroups, group),
    });
  };

  const openProject = React.useCallback((instanceId: string, project: Project, projectSessions: Session[]) => {
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
  }, [showActionError, saveCurrentLayout]);

  const activateSession = React.useCallback((key: string) => {
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
  }, []);

  /**
   * Close a session's column. It is not parked anywhere: with no tab strip there is nothing to
   * park it in, and the rail already lists every session, so closing simply hands the view back to
   * whatever else is open (or to the activity home when nothing is).
   */
  const minimizeSession = React.useCallback((key: string) => {
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
  }, []);

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
  }, []);

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
        splitView: settings.splitView,
        minWidth: MIN_COLUMN_WIDTH,
      }),
    [openSessions, workspaceWidth, activeSession, settings.splitView]
  );
  const columnsRef = React.useRef<string[]>([]);
  columnsRef.current = columns;
  // The active session may render in the tab strip (sticky-minimized) rather than as a column, but
  // it is still the session the user is watching, so stream hints for it must fetch its transcript.
  const activeSessionRef = React.useRef<string | null>(null);
  activeSessionRef.current = activeSession;
  const columnKeySet = React.useMemo(() => new Set(columns), [columns]);
  protectedTranscriptKeys.current = columnKeySet;

  /**
   * The session list's three widths, in order. One control walks them: mini (a blob dock) → normal
   * (320px) → wide (about half the window) → mini. `Cmd/Ctrl+B` does the same from anywhere, and
   * the choice is remembered in settings.
   */
  const cycleRailMode = React.useCallback(() => {
    const order: RailMode[] = ['mini', 'normal', 'wide'];
    const current = settingsRef.current.railMode ?? 'normal';
    const next = order[(order.indexOf(current) + 1) % order.length];
    handleSettings({ railMode: next });
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
      const key = openSessionsRef.current[slot];
      if (!key) return;
      event.preventDefault();
      activateSession(key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activateSession]);

  // Persist the workspace after the initial restore. The guarded ref keeps the first render
  // (empty defaults) from clobbering what main just handed back.
  React.useEffect(() => {
    if (!workspaceHydratedRef.current) return;
    // Workers open as transient columns: they work while open, but the layout that persists is
    // the human's own. A worker key is dropped from open/minimized here (and so never restored).
    const workerKey = (key: string): boolean => {
      const ref = parseSessionKey(key);
      if (!ref) return false;
      const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find(
        (entry) => entry.id === ref.sessionId
      );
      return session ? isWorker(session) : false;
    };
    handleSettings({
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
  }, [sessionsByInstance, instances, instancesLoaded, openSessions, activeSession, minimizedSessions]);

  // Keep read receipts across archives and while another host's session list is still loading.
  React.useEffect(() => {
    if (!instancesLoaded) return;
    const current = settingsRef.current.readMarks;
    const next = pruneSessionReadMarks(current, sessionsByInstance, instances.map((instance) => instance.id));
    if (Object.keys(next).length === Object.keys(current).length) return;
    handleSettings({ readMarks: next }, { preserveActionError: true });
  }, [sessionsByInstance, instances, instancesLoaded, handleSettings, settingsRef]);

  // Recovery for notes a previous build stranded on the shared project key: 0.13.0's migration
  // (removed in this release) moved a project session's notes onto the project key and deleted the
  // session key, so a saved note left the place the UI reads from and looked lost. The helper puts
  // them back where ChatView looks; `notes.test.ts` covers it.
  React.useEffect(() => {
    if (!settingsLoaded) return;
    const current = settingsRef.current.sessionNotes;
    const recovered = recoverStrandedNotes(current, sessionsByInstance, projectsByInstance, activeSession);
    if (recovered !== current) handleSettings({ sessionNotes: recovered });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-way recovery; retriggers when sessions load
  }, [settingsLoaded, sessionsByInstance, projectsByInstance, activeSession]);

  // Per-instance data that rarely changes: projects, models.
  React.useEffect(() => {
    if (readyIds.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        await Promise.all(readyIds.map(async (id) => {
          const [projects, models] = await Promise.all([loadAllProjects([id]), loadModels(id)]);
          if (cancelled) return;
          // An instance that failed to answer is absent from these maps; keep its previous data.
          setProjectsByInstance((prev) => ({ ...prev, ...projects }));
          if (models) setModelsByInstance((prev) => ({ ...prev, [id]: models }));
        }));
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

  const refreshModels = useStableCallback(async (instanceId: string) => {
    const next = await loadModels(instanceId).catch(() => null);
    if (next) setModelsByInstance((previous) => shareValue(previous, { ...previous, [instanceId]: next }));
    else showActionError('Could not refresh models. Your model selection has not changed.');
  });

  // ---- Refreshers: one per REST resource. Timers and event hints both call these. ----
  // Each takes the instance ids to refresh and merges the result into state, leaving other
  // instances untouched. Failure preserves prior state (the loaders return null / omit keys).

  const directoryHintsFor = (instanceIds: string[]): Record<string, string[]> => {
    const hints: Record<string, string[]> = {};
    const add = (instanceId: string | undefined, directory: string | undefined) => {
      if (!instanceId || !directory || !instanceIds.includes(instanceId)) return;
      const list = hints[instanceId] ?? (hints[instanceId] = []);
      if (!list.includes(directory)) list.push(directory);
    };
    // Every open session (columns and tabs), not just the active one: OpenCode scopes prompts by
    // directory, so a question in a background column must still be listed for its card to appear.
    add(selectedSessionRef.current?.instanceId, selectedSessionRef.current?.directory);
    openSessionsRef.current.forEach((key) => {
      const ref = parseSessionKey(key);
      if (!ref) return;
      const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find(
        (entry) => entry.id === ref.sessionId
      );
      add(ref.instanceId, session?.directory);
    });
    // The exact directory a pending prompt event reported, when it differs from the session folder.
    instanceIds.forEach((instanceId) => {
      (promptDirectoriesRef.current[instanceId] ?? []).forEach((directory) => add(instanceId, directory));
    });
    return hints;
  };

  /**
   * OpenCode scopes pending prompts by project, so a refresh only sees the directories it asks for.
   * Keep asking for every directory that already holds a pending permission/question; otherwise
   * browsing to another session drops the old directory and the prompt vanishes from the UI.
   */
  const promptHintsFor = (
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
  };

  const sessionReads = React.useRef(new ReadCoordinator());
  const sessionFullReadAt = React.useRef(new Map<string, number>());
  const [historyIncomplete, setHistoryIncomplete] = React.useState<Record<string, boolean>>({});
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const refreshSessions = useStableCallback(async (instanceIds: string[], deep = false): Promise<void> => {
    if (instanceIds.length > 1) { await Promise.all(instanceIds.map((id) => refreshSessions([id], deep))); return; }
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
        answered.forEach((id) => { updated[id] = at; });
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

  /** Directory + `updated` for a session, read through the ref so pollers stay stable. */
  const sessionMetaFor = (ref: SessionRef): { directory?: string; updated?: number } => {
    const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find(
      (entry) => entry.id === ref.sessionId
    );
    return { directory: session?.directory, updated: session?.updated };
  };

  const transcriptReads = React.useRef(new ReadCoordinator());
  const fullReadAt = React.useRef(new Map<string, number>());
  /** When each column first went on screen, so "no full read yet" has a sane baseline. */
  const columnOpenedAt = React.useRef(new Map<string, number>());
  const loadAndCommitMessages = useStableCallback((ref: SessionRef, mode: 'tail' | 'full', directory?: string, afterCurrent: boolean = false) => {
    const key = sessionKey(ref);
    return transcriptReads.current.run(key, mode, async () => {
      const meta = sessionMetaFor(ref);
      if (mode === 'tail') {
        // Try the incremental read first. On a big session the tail costs 40 whole entry records
        // (measured 21.3MB for one with screenshots) on every poll, nearly all of it unchanged;
        // `since` costs only what actually changed, and nothing at all when nothing did. A gap (a
        // `next` cursor) or a host that cannot answer one falls through to the tail below, which
        // repairs by overlap.
        const held = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
        const since = newestEntryId(held);
        if (since !== undefined) {
          const appended = await loadMessageAppend(ref.instanceId, ref.sessionId, since).catch((err: unknown) => {
            console.error('Failed to load message delta', err);
            return null;
          });
          if (appended?.supported && appended.complete) {
            commitFetchedTranscript(
              key,
              appended.messages,
              'append',
              meta.updated,
              true,
              appended.settlements,
              appended.liveOutputs
            );
            observeModels(observationsFor(ref.instanceId, ref.sessionId, directory ?? meta.directory, appended.messages));
            return;
          }
        }
      }
      if (mode === 'full') {
        // A full read is a *paged* walk of the entries route, not the snapshot: the snapshot serves
        // the active window, so after a compaction it is a fraction of the history (measured live:
        // 39 of 872 entries on one conversation). `complete` says whether the walk reached the
        // start; a cap or a short answer leaves it false and the transcript says so.
        const history = await loadMessageHistory(ref.instanceId, ref.sessionId);
        // The walk landed, so the session is not one the breaker has to hold back. A success here is
        // the only evidence that counts: a transient timeout clears on the next attempt anyway.
        if (repairBudget.current.halt(ref)) {
          repairBudget.current.succeeded(ref);
          setRepairHalts((prev) => {
            if (!prev[key]) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
        const messages = history.supported
          ? history.messages
          : await loadMessages(ref.instanceId, ref.sessionId, directory ?? meta.directory);
        commitFetchedTranscript(key, messages, 'full', meta.updated);
        observeModels(observationsFor(ref.instanceId, ref.sessionId, directory ?? meta.directory, messages));
        fullReadAt.current.set(key, Date.now());
        // Legacy instances have no cursor: their own paged read is complete by construction (or by
        // their documented ceiling, which this client cannot see). Do not claim either way for a
        // read that did not come from the Hearth walk.
        const historyComplete = history.supported ? history.complete : true;
        setTranscripts((prev) => {
          const current = prev[key];
          if (!current) return prev;
          if (current.historyComplete === historyComplete) return prev;
          return { ...prev, [key]: { ...current, historyComplete } };
        });
        return;
      }
      const messages = await loadMessageTail(ref.instanceId, ref.sessionId, directory ?? meta.directory);
      commitFetchedTranscript(key, messages, mode, meta.updated);
      observeModels(observationsFor(ref.instanceId, ref.sessionId, directory ?? meta.directory, messages));
    }, afterCurrent);
  });

  /**
   * One failed full read, recorded for the breaker, and the halt it may have caused published so the
   * column can say why it is no longer repairing itself.
   */
  const recordFullReadFailure = (ref: SessionRef, reason: FullReadFailure) => {
    repairBudget.current.failed(ref, reason);
    const halt = repairBudget.current.halt(ref);
    setRepairHalts((prev) => {
      const key = sessionKey(ref);
      if (!halt || (prev[key] && prev[key].failures >= halt.failures)) return prev;
      return { ...prev, [key]: halt };
    });
  };

  /** Refetch one transcript in full; authoritative for removals, compaction and terminal events. */
  const refreshMessages = useStableCallback(async (ref: SessionRef, afterCurrent: boolean = false) => {
    const key = sessionKey(ref);
    try {
      await loadAndCommitMessages(ref, 'full', undefined, afterCurrent);
    } catch (err) {
      console.error('Failed to load messages', err);
      // Count the failure for the breaker (`lib/repairBudget`). A full read that a session's size
      // makes impossible used to be asked for again on every trigger — open, reconnect, poll, an
      // event that wants a full read — so one oversized conversation kept a futile read alive for as
      // long as it was open. After a few consecutive failures the automatic repairs stop; the
      // reader's own Refresh still goes through, because asking again is asking again.
      recordFullReadFailure(ref, classifyFullReadFailure(err));
      setTranscripts((prev) => {
        const current = prev[key];
        // A transcript that already rendered is never demoted to an error: the poll retries and the
        // messages on screen are still the truth.
        if (current?.status === 'ready') return prev;
        // Keep a settled reload failure settled (it was the user's own action); otherwise this is
        // the transient shape, which reads as "waiting", not as a failure.
        const failure = current?.failure === 'reload' ? 'reload' : 'poll';
        const messages = current?.messages ?? messageCacheRef.current.get(key) ?? [];
        if (current && current.messages === messages && current.status === 'error' && current.failure === failure) {
          return prev;
        }
        return { ...prev, [key]: { messages, status: 'error', failure } };
      });
    } finally {
      fullRepairInFlight.current.delete(key);
      // A repair requested while this read was running was deferred rather than dropped — unless the
      // breaker has stopped repairs for this session, in which case replaying it would be the very
      // loop the breaker exists to end.
      const replay = pendingRepair.current.delete(key);
      if (replay && repairBudget.current.allows(ref)) requestFullRepair(key);
    }
  });

  /** Bounded tail refresh for a visible column while a turn streams. */
  const refreshMessageTail = useStableCallback(async (ref: SessionRef) => {
    try {
      await loadAndCommitMessages(ref, 'tail');
    } catch (err) {
      console.error('Failed to load message tail', err);
    }
  });

  /**
   * Background sessions refresh their summary, and their cached transcript if they have one.
   *
   * A session that is streaming but not on screen is invalidated once per second, and each of those
   * refreshes used to be a whole bounded tail (20 entries, so megabytes on a session with images)
   * for a column nobody is looking at. With a cached transcript there is an anchor id to read from,
   * so it asks for the delta instead; without one it keeps the tail, because the summary is derived
   * from whatever messages it is handed.
   */
  const refreshMessageSummary = useStableCallback(async (ref: SessionRef) => {
    const key = sessionKey(ref);
    const { directory, updated } = sessionMetaFor(ref);
    try {
      const held = messageCacheRef.current.get(key);
      const since = held === undefined ? undefined : newestEntryId(held);
      if (since !== undefined) {
        const appended = await loadMessageAppend(ref.instanceId, ref.sessionId, since).catch(() => null);
        if (appended?.supported && appended.complete) {
          mergeBackgroundTail(key, appended.messages, updated, 'append', appended.settlements);
          return;
        }
      }
      const tail = await loadMessageTail(ref.instanceId, ref.sessionId, directory);
      mergeBackgroundTail(key, tail, updated);
    } catch (err) {
      console.warn('Failed to load message summary', err);
    }
  });

  // A tail with no safe overlap asks for one full repair; route it through the normal loader.
  // The breaker is checked here rather than at each of the four call sites: a session whose full read
  // cannot succeed (larger than the response cap) would otherwise be repaired again on every trigger,
  // for as long as it is open. The missing-history line says so and offers compaction.
  fullRepairRef.current = (key: string) => {
    const ref = parseSessionKey(key);
    if (!ref) {
      fullRepairInFlight.current.delete(key);
      return;
    }
    if (!repairBudget.current.allows(ref)) {
      fullRepairInFlight.current.delete(key);
      setRepairHalts((prev) => {
        const halt = repairBudget.current.halt(ref);
        if (!halt || prev[key]?.failures === halt.failures) return prev;
        return { ...prev, [key]: halt };
      });
      return;
    }
    void refreshMessages(ref);
  };

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
      const merged: Record<string, string> = Object.fromEntries(
        Object.entries({ ...scheduledBindingsRef.current, ...discovered }).slice(-2000)
      );
      if (!sameStringRecord(merged, scheduledBindingsRef.current)) {
        scheduledBindingsRef.current = merged;
        handleSettings({ scheduledSessionBindings: merged });
      }
    } catch (err) {
      console.warn('Failed to load scheduled task identities', err);
    }
  });

  /** Re-run a task now. The server creates a fresh session with the task's prompt and model. */
  const handleRunScheduledTask = useStableCallback(async (task: ScheduledTask) => {
    setRunningScheduledKeys((prev) => new Set(prev).add(task.key));
    try {
      const result = await runScheduledTask(task.instanceId, task);
      if (!result.ok) {
        showActionError(result.error ?? `Could not run “${task.name}”.`);
        return;
      }
      setActionNotice({ message: `Started “${task.name}”.` });
      void refreshScheduled([task.instanceId]);
      // The instance needs a beat to create the session before the next list fetch can see it.
      window.setTimeout(() => void refreshSessions([task.instanceId]), 900);
    } catch (err) {
      showActionError(err instanceof Error ? err.message : `Could not run “${task.name}”.`);
    } finally {
      setRunningScheduledKeys((prev) => {
        const next = new Set(prev);
        next.delete(task.key);
        return next;
      });
    }
  });

  const handleChangeScheduledTaskModel = useStableCallback((task: ScheduledTask) =>
    setScheduledModelTarget(task)
  );

  /**
   * Persist a task's new model, then run it — the point of the flow is to fix an errored task and
   * retry it with a working model. The task's own JSON is replayed so schedule/prompt survive.
   */
  const handleScheduledModelSelect = async (task: ScheduledTask, key: string, variant: string) => {
    const models = modelsByInstance[task.instanceId];
    let model: ModelRef | null = null;
    if (key === DEFAULT_MODEL) {
      const fallback = models?.models.find((option) => modelRefKey(option) === models.defaultModelId);
      if (fallback) model = { providerID: fallback.providerID, modelID: fallback.modelID };
    } else {
      const slash = key.indexOf('/');
      if (slash > 0) model = { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) };
    }
    if (!model) {
      showActionError('Pick a concrete model for the scheduled task.');
      return;
    }
    if (variant) model.variant = variant;
    const result = await updateScheduledTaskModel(task.instanceId, task, model);
    if (!result.ok) {
      showActionError(result.error ?? `Could not update “${task.name}”.`);
      return;
    }
    const updated = result.task ?? { ...task, model };
    setScheduledTasksByKey((prev) => ({ ...prev, [updated.key]: updated }));
    setActionNotice({
      message: `Updated “${task.name}” to ${model.providerID}/${model.modelID} — starting a run.`,
    });
    void refreshScheduled([task.instanceId]);
    void handleRunScheduledTask(updated);
  };

  // ---- Event streams: hints invalidate, refreshers refetch. ----
  const [liveInstances, setLiveInstances] = React.useState<Record<string, boolean>>({});
  const liveInstancesRef = React.useRef(liveInstances);
  const refetch = useStableCallback(async ({ instanceId, resource, sessionId, messageMode }: Invalidation) => {
    switch (resource) {
      case 'sessions': await refreshSessions([instanceId]); break;
      case 'states': await refreshStates([instanceId]); break;
      case 'permissions': await refreshPermissions([instanceId]); break;
      case 'questions': await refreshQuestions([instanceId]); break;
      case 'queues': await refreshQueues([instanceId]); break;
      case 'autoAccept': await refreshAutoAccept([instanceId]); break;
      case 'scheduled': await refreshScheduled([instanceId]); break;
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
        columnsRef.current,
        activeSessionRef.current,
        document.hidden
      );

    const catchUp = (instanceId: string) => {
      // The stream just (re)connected; anything that changed while it was down was missed.
      (['sessions', 'states', 'permissions', 'questions', 'queues', 'autoAccept'] as const).forEach((resource) =>
        invalidationQueue.push({ instanceId, resource })
      );
      columnsRef.current.forEach((key) => {
        const ref = parseSessionKey(key);
        if (ref?.instanceId === instanceId) {
          invalidationQueue.push({
            instanceId,
            resource: 'messages',
            sessionId: ref.sessionId,
            messageMode: 'full',
          });
        }
      });
    };

    const unsubscribe = bridge.onEvent((raw) => {
      const event = parseEmberEvent(raw);
      if (event?.type === 'ember:instances-updated') {
        void readInstances(false).catch(() => {});
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
        liveInstancesRef.current = { ...liveInstancesRef.current, [event.instanceId]: connected };
        setLiveInstances(liveInstancesRef.current);
        if (connected && readySet.has(event.instanceId)) catchUp(event.instanceId);
        return;
      }
      if (!readySet.has(event.instanceId)) return;
      // Whitelisted milestones carry a bounded summary; those become live activity entries.
      // A streamed chunk carries the append itself, so a watching column can draw it without
      // reading the transcript again. Anything this cannot apply falls through to the invalidation
      // below, which is the path every hint took before deltas existed.
      if (APPLY_STREAM_DELTAS && event.deltas && event.deltas.length > 0 && event.sessionId) {
        if (applyStreamDeltas(event.instanceId, event.sessionId, event.deltas)) return;
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
    });

    const resume = () => {
      if (!document.hidden) readyIds.forEach(catchUp);
    };
    const online = () => {
      // A restored network can also mean a changed tunnel or port; reprobe so an instance
      // marked unreachable reattaches instead of waiting for the watchdog.
      void readInstances().catch(() => {});
      resume();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', online);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', online);
      unsubscribe();
      invalidationQueue.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readyKey is the stable string form of readyIds; refs carry the rest
  }, [readyKey, invalidationQueue]);

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

  const refreshListFor = async (ids: string[]) => {
    await Promise.all([refreshSessions(ids), refreshAutoAccept(ids)]);
  };
  const refreshStateFor = useStableCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => Promise.all([
      refreshStates([id]), refreshQueues([id]),
    ])));
  });
  /** Prompts keep their own cadence: parked approvals and questions are poll-only. */
  const refreshPromptsFor = useStableCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => Promise.all([
      refreshPermissions([id]), refreshQuestions([id]),
    ])));
  });
  React.useEffect(() => {
    readyIds.forEach((id) => { void refreshSessions([id]); void refreshStateFor([id]); });
    // Hearth scheduled tasks are one aggregate request, so load them as soon as a pi instance
    // is ready (the OpenChamber path stays on its rare poll to avoid the per-project fan-out).
    const piIds = instances
      .filter((instance) => instance.kind === 'pi' && readyIds.includes(instance.id))
      .map((instance) => instance.id);
    if (piIds.length > 0) void refreshScheduled(piIds);
  }, [readyIds, instances, refreshSessions, refreshStateFor, refreshScheduled]);
  usePoll(() => refreshListFor(deadIdsRef.current), SESSION_POLL_MS, deadIds.length > 0);
  usePoll(() => refreshListFor(liveIdsRef.current), SESSION_POLL_LIVE_MS, liveIds.length > 0);
  usePoll(() => refreshStateFor(deadIdsRef.current), STATE_POLL_MS, deadIds.length > 0);
  usePoll(() => refreshStateFor(liveIdsRef.current), STATE_POLL_LIVE_MS, liveIds.length > 0);
  usePoll(() => refreshPromptsFor(readyIdsRef.current), PROMPT_POLL_MS, readyIds.length > 0);


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
  }, [sessions, commitFetchedTranscript, refreshPromptsFor]);

  /**
   * Bring an on-screen transcript up to date. Cached messages render first; a cached session gets
   * a bounded tail (which repairs itself with a full read when it no longer overlaps), an uncached
   * one a full read.
   */
  const showTranscript = useStableCallback((ref: SessionRef) => {
    const key = sessionKey(ref);
    if (!columnOpenedAt.current.has(key)) columnOpenedAt.current.set(key, Date.now());
    // Opening a session always starts with the tail, never the full read.
    //
    // The full read is the whole conversation in one response, and a real long session is enormous:
    // one here is 45MB of JSON, of which 44.7MB is tool output and only 0.9MB is the assistant text
    // you actually read. Fetching that on open is what made chats fail to appear — the tail for the
    // same session is 24KB, roughly 1900x smaller, and it is enough to render the screen
    // immediately. Older history is a separate, lazy concern (see ), not something
    // to block the first paint on.
    const read = refreshMessageTail(ref);
    priorityReads.current.add(read);
    void read
      .finally(() => priorityReads.current.delete(read))
      .then(() => {
        // The tail paints the screen; it is not the whole conversation. Without this the column
        // showed roughly the last ten messages and nothing else, so scrolling back was impossible
        // and Find could not reach anything older — the transcript looked truncated rather than
        // lazy. Backfill in the background, after the first paint, so opening stays fast *and* the
        // history is really there.
        const key2 = sessionKey(ref);
        if (transcriptsRef.current[key2]?.historyComplete === true) return;
        if (fullRepairInFlight.current.has(key2)) return;
        fullRepairInFlight.current.add(key2);
        void refreshMessages(ref);
      });
    // A prompt raised while this column was off screen would otherwise not appear until the next
    // poll or reload: the question list is fetched per directory on hints, and switching to a
    // session is not a hint. Ask for it as the column comes on screen.
    void refreshQuestions([ref.instanceId]);
  });

  // Selecting a column refreshes it immediately; the poll below (and message events) keep it
  // fresh while the agent is working.
  const selectedMetadataKey = selectedSession ? `${sessionKey(selectedSession)}\u0000${selectedSession.directory ?? ''}` : null;
  React.useEffect(() => {
    if (selected && selectedMetadataKey) showTranscript(selected);
  }, [selected, selectedMetadataKey, showTranscript]);

  // Every column that just came on screen refreshes, however recently it was read. One already on
  // screen refreshes when the session list says it moved past the version its transcript reflects,
  // which also covers stream events lost to a dropped connection.
  const previouslyVisible = React.useRef(new Set<string>());
  React.useEffect(() => {
    const known = new Set<string>();
    for (const key of columns) {
      const ref = parseSessionKey(key);
      const session = ref && (sessionsByInstance[ref.instanceId] ?? []).find((entry) => entry.id === ref.sessionId);
      if (!ref || !session) continue;
      known.add(key);
      const behind = (session.updated ?? 0) > (transcriptVersion.current.get(key) ?? -1);
      if (!previouslyVisible.current.has(key) || behind) showTranscript(ref);
    }
    previouslyVisible.current = known;
  }, [columns, sessionsByInstance, showTranscript]);

  // Only the columns actually on screen poll their transcripts; overflow/minimized tabs rely on
  // the preview cache and the session list's `updated`.
  const columnIsLive = React.useCallback(
    (ref: SessionRef | null): boolean => (ref ? liveInstances[ref.instanceId] === true : false),
    [liveInstances]
  );
  const columnsLive = columns.length > 0 && columns.every((key) => columnIsLive(parseSessionKey(key)));
  // A turn in flight is the one case where a single dropped hint leaves a reply unseen, and the
  // wire has no sequence number that would let a reader notice the gap. So a busy column keeps the
  // fast cadence even when its instance streams: the safety net's job is to miss less, and that is
  // when it matters. Idle sessions -- the common case -- take the slow cadence.
  const anyColumnBusy = columns.some((key) => states[key] === 'active');
  usePoll(
    async () => {
      await Promise.all(
        columnsRef.current.map((key) => {
          const ref = parseSessionKey(key);
          if (!ref || document.hidden || !(sessionsByInstanceRef.current[ref.instanceId] ?? []).some((session) => session.id === ref.sessionId)) return Promise.resolve();
          const busy = states[key] === 'active';
          // A live instance needs a full repair every five minutes; an unreachable one, or a turn
          // in flight, every minute. Per column, so one dead instance stops penalising the rest.
          const repairInterval = busy || !columnIsLive(ref) ? 60_000 : 5 * 60_000;
          // With no full read yet the baseline is when the column opened, not 0: otherwise the
          // first poll treats a session that has only ever had a tail as overdue for a repair and
          // immediately fetches the whole conversation, which is the thing we are avoiding.
          const lastFull = fullReadAt.current.get(key) ?? columnOpenedAt.current.get(key) ?? Date.now();
          return Date.now() - lastFull >= repairInterval ? refreshMessages(ref) : refreshMessageTail(ref);
        })
      );
    },
    anyColumnBusy || !columnsLive ? STATE_POLL_MS : MESSAGES_POLL_LIVE_MS,
    columns.length > 0
  );

  const toggleInstance = (instanceId: string) => {
    const current = settingsRef.current.hiddenInstances;
    const next = current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId];
    handleSettings({ hiddenInstances: next });
  };

  /**
   * One-way hide: the instance leaves the list and stays gone across launches, including the ones
   * that never connect. Restoring is the same menu row's tick box once the host answers again, or
   * Settings → Endpoints for a Hearth host.
   */
  const forgetInstance = (instanceId: string) => {
    const current = settingsRef.current.hiddenInstances;
    if (current.includes(instanceId)) return;
    handleSettings({ hiddenInstances: [...current, instanceId] });
  };

  /**
   * Silence one host's outage row. The notice is the whole explanation — what went away and the two
   * ways back (Undo here, Reprobe in the Instances menu afterwards) — because a dismissed row has no
   * control left to click.
   */
  const dismissOutage = React.useCallback(
    (entry: SilentInstance) => {
      const current = settingsRef.current.dismissedOutages;
      if (current.includes(entry.instanceId)) return;
      handleSettings({ dismissedOutages: [...current, entry.instanceId] });
      setActionNotice({
        message: `No more warnings about ${entry.label}. Reprobe in the Instances menu brings it back.`,
        actionLabel: 'Undo',
        action: () =>
          handleSettings({
            dismissedOutages: settingsRef.current.dismissedOutages.filter(
              (id) => id !== entry.instanceId
            ),
          }),
      });
    },
    [handleSettings, setActionNotice, settingsRef]
  );

  /**
   * Turn YOLO mode on/off for a session. Writes the server-side policy when the instance has
   * it (optimistically, then reconciled by the next poll); otherwise records a local override
   * and Ember auto-replies itself while the session is open.
   */
  const setYolo = async (ref: SessionRef, enabled: boolean, directory?: string): Promise<void> => {
    const key = sessionKey(ref);
    const policy = autoAcceptByInstance[ref.instanceId];
    if (policy && !policy.supported) {
      setBypassOverrides((prev) => ({ ...prev, [key]: enabled }));
      return;
    }
    const previous = policy?.sessions[ref.sessionId];
    setAutoAcceptByInstance((prev) => ({
      ...prev,
      [ref.instanceId]: {
        supported: true,
        sessions: { ...(prev[ref.instanceId]?.sessions ?? {}), [ref.sessionId]: enabled },
      },
    }));
    try {
      const result = await setAutoAccept(ref.instanceId, ref.sessionId, enabled, directory);
      if (result.status === 404) {
        // Older OpenChamber: remember that and use the local fallback from now on.
        setAutoAcceptByInstance((prev) => ({ ...prev, [ref.instanceId]: { supported: false, sessions: {} } }));
        setBypassOverrides((prev) => ({ ...prev, [key]: enabled }));
        return;
      }
      if (!result.ok) throw new Error(`Server refused (${result.status}).`);
    } catch (err) {
      setAutoAcceptByInstance((prev) => {
        const sessions = { ...(prev[ref.instanceId]?.sessions ?? {}) };
        if (previous === undefined) delete sessions[ref.sessionId];
        else sessions[ref.sessionId] = previous;
        return { ...prev, [ref.instanceId]: { supported: true, sessions } };
      });
      showActionError(
        `Could not ${enabled ? 'enable' : 'disable'} YOLO mode. ${err instanceof Error ? err.message : ''}`.trim(),
        () => void setYolo(ref, enabled, directory)
      );
    }
  };

  const beginNewAgent = React.useCallback((instanceId: string, directory?: string) => {
    showActionError(null);
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
  }, [showActionError, setDraftPendingId]);

  const dismissOnboarding = React.useCallback(() => {
    handleSettings({ onboardingDismissedAt: Date.now() }, { preserveActionError: true });
    const target = newSessionTarget(instances, hidden);
    if (target) beginNewAgent(target);
  }, [handleSettings, instances, hidden, beginNewAgent]);

  const initialWorkspaceChosen = React.useRef(false);
  const defaultEmptyHomeTarget = settingsLoaded && instancesLoaded
    ? emptyHomeTarget(instances, sessionsByInstance, sessions.length, hidden)
    : null;
  React.useEffect(() => {
    if (initialWorkspaceChosen.current || !settingsLoaded || !instancesLoaded || onboardingOpen) return;
    if (columns.length > 0 || newSessionInstanceId) { initialWorkspaceChosen.current = true; return; }
    if (usageOpen || scheduledOpen || archiveOpen) return;
    const latest = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    if (latest) {
      initialWorkspaceChosen.current = true;
      openSession({ instanceId: latest.instanceId, sessionId: latest.id }, latest);
    } else if (defaultEmptyHomeTarget) {
      initialWorkspaceChosen.current = true;
      beginNewAgent(defaultEmptyHomeTarget);
    }
  }, [settingsLoaded, instancesLoaded, onboardingOpen, columns.length, sessions, newSessionInstanceId, usageOpen, scheduledOpen, archiveOpen, defaultEmptyHomeTarget, beginNewAgent, openSession]);

  const cancelNewAgent = () => {
    // A failed attempt has nothing on the host, so closing the pane is also letting it go. One that
    // is still being created does not: the session may already exist, and an orphan is worse than
    // the wait. It finishes in the background and says so.
    const id = draftPendingIdRef.current;
    if (id) {
      mutatePendingCreates((previous) =>
        previous.filter((entry) => !(entry.id === id && entry.phase === 'failed'))
      );
    }
    setDraftPendingId(null);
    setNewSessionInstanceId(null);
    setNewSessionDirectory(null);
  };

  /**
   * New agent: the message exists before the session does.
   *
   * The create is the slow part (a cold Hearth, a folder that does not exist, a host on a tailnet),
   * and the person has already pressed Enter. So the attempt is registered here at once, ChatView
   * renders its bubble from it, and the request runs behind it. Everything that can go wrong is
   * decided into two states: `creating` (the host has not answered) and `failed` (it refused, and
   * the same row carries Try again / Edit / Copy).
   */
  const mutatePendingCreates = (updater: (previous: PendingCreate[]) => PendingCreate[]) => {
    const next = updater(pendingCreatesRef.current);
    pendingCreatesRef.current = next;
    setPendingCreates(next);
  };

  const pendingCreateById = (id: string | null): PendingCreate | null =>
    id ? pendingCreatesRef.current.find((entry) => entry.id === id) ?? null : null;

  const updatePendingCreate = (id: string, update: (pending: PendingCreate) => PendingCreate) =>
    mutatePendingCreates((previous) =>
      previous.map((entry) => (entry.id === id ? update(entry) : entry))
    );

  const dropPendingCreate = (id: string) =>
    mutatePendingCreates((previous) => previous.filter((entry) => entry.id !== id));

  /**
   * Whether the person is looking at this attempt right now, as opposed to having left it.
   *
   * Read through a ref assigned during render: a create resolves in an async callback, and the
   * state it would close over is a render behind. A pane that is not on screen means the answer —
   * success or failure — must arrive somewhere the person can see and act on, which is a notice
   * with an action, never a silent jump back into a draft they left.
   */
  const draftPaneRef = React.useRef({
    pendingId: null as string | null,
    activeSession: null as string | null,
    newSessionInstanceId: null as string | null,
    usageOpen: false,
  });
  draftPaneRef.current = { pendingId: draftPendingId, activeSession, newSessionInstanceId, usageOpen };
  const paneShowsPending = (id: string): boolean => {
    const pane = draftPaneRef.current;
    return (
      pane.pendingId === id &&
      pane.newSessionInstanceId !== null &&
      !pane.activeSession &&
      !pane.usageOpen
    );
  };

  /** The name a new conversation gets before the host ever answers. Local, deterministic. */
  const newSessionTitle = (options: NewSessionOptions, input: PromptInput): string =>
    deriveSessionName({
      text: input.text,
      directory: options.directory,
      project:
        ((projectsByInstance[options.instanceId] ?? []).find((project) => project.path === options.directory)
          ?.name ?? undefined),
      taken: Object.values(sessionsByInstanceRef.current)
        .flat()
        .map((session) => session.title ?? '')
        .filter(Boolean),
      seed: `${options.instanceId}|${options.directory ?? ''}|${input.text}`,
    });

  /**
   * Bring a draft that is still being created, or that failed while off screen, back into view.
   * The banner's action is this rather than a blind retry: the person has to see where it got to.
   */
  const showPendingDraft = (id: string) => {
    const pending = pendingCreateById(id);
    if (!pending) return;
    setActiveSession(null);
    setNewSessionInstanceId(pending.options.instanceId);
    setNewSessionDirectory(pending.options.directory);
    setUsageOpen(false);
    setScheduledOpen(false);
    setDraftPendingId(id);
  };

  /** The host refused, or never answered. The pane says why; a banner covers a pane that is gone. */
  const failNewSessionCreate = (id: string, error: unknown | null) => {
    const pending = pendingCreateById(id);
    if (!pending) return;
    const failure = error === null ? { kind: 'unknown' as const } : sessionCreateFailureOf(error);
    const text = newSessionFailureText({
      failure,
      instanceLabel: instanceLabelOf(pending.options.instanceId),
      directory: pending.options.directory,
    });
    updatePendingCreate(id, (entry) => failPendingCreate(entry, text));
    if (!paneShowsPending(id)) {
      showActionError(text, () => showPendingDraft(id), 'Show');
    }
  };

  /**
   * Create the session and hand the draft's messages to it.
   *
   * The first message is sent the moment the id exists, before the column opens, so the bubble the
   * draft was showing is replaced in one commit by the identical bubble under the session's own
   * key. Messages typed while the create was out follow in order, as ordinary queued follow-ups.
   */
  const runPendingCreate = async (id: string) => {
    const pending = pendingCreateById(id);
    if (!pending) return;
    const { options } = pending;
    let created: Session | null;
    try {
      created = await createSession(options.instanceId, options.directory, {
        instructions: options.instructions,
        model: options.model,
        variant: options.variant,
        title: pending.title,
      });
    } catch (err) {
      failNewSessionCreate(id, err);
      return;
    }
    if (!created) {
      failNewSessionCreate(id, null);
      return;
    }
    handOffPendingCreate(id, created);
  };

  /**
   * The attempt has a real session: send its messages, then either open it or say it exists.
   *
   * Reached two ways — the host answered the create, or a retry found the conversation a lost
   * answer had already made — so it must not assume the session is new to the rail.
   */
  const handOffPendingCreate = (id: string, created: Session) => {
    const pending = pendingCreateById(id);
    if (!pending) return;
    const { options } = pending;
    const session = created;
    const ref = { instanceId: options.instanceId, sessionId: session.id };
    const now = Date.now();
    prunePendingCreated((entry) => entry.expiresAt <= now);
    pendingCreatedSessions.current.set(sessionKey(session), {
      session,
      expiresAt: now + CREATED_SESSION_GRACE_MS,
    });
    setSessionsByInstance((prev) => {
      const list = prev[options.instanceId] ?? [];
      // An adopted conversation is already in the rail; prepending it would show it twice.
      if (list.some((entry) => entry.id === session.id)) return prev;
      return { ...prev, [options.instanceId]: [session, ...list] };
    });
    // Creating a session on a host un-hides it: the person is clearly using it, and a draft that
    // lands in a hidden instance would otherwise look like nothing happened.
    if (settingsRef.current.hiddenInstances.includes(options.instanceId)) {
      handleSettings({
        hiddenInstances: settingsRef.current.hiddenInstances.filter((entry) => entry !== options.instanceId),
      });
    }
    // Read the attempt again: Enter may have held more messages, or a note, while the create was out.
    const latest = pendingCreateById(id) ?? pending;
    for (const note of latest.notes ?? []) handleSaveNote(sessionKey(session), note.text);
    const first = latest.messages[0];
    handleComposerDraftsChange({
      [sessionKey(ref)]: {
        text: '',
        modelId: first?.input.selectedModelId ?? (first?.input.model ? modelRefKey(first.input.model) : DEFAULT_MODEL),
        variant: first?.input.variant,
        updatedAt: now,
      },
    });
    // `sendTo` inserts its optimistic bubble synchronously, so opening the column on the next line
    // shows the message immediately — the handover has no empty frame.
    const sent = first
      ? sendTo(ref, session.directory, { ...first.input, configured: true }, {
          retainOnFailure: true,
          quiet: true,
        })
      : Promise.resolve(true);
    for (const held of latest.messages.slice(1)) {
      void sent.then((accepted) => {
        if (accepted) void sendTo(ref, session.directory, held.input, { retainOnFailure: true, quiet: true });
      });
    }
    // The auto-accept write runs alongside the send rather than in front of it. What must not be
    // raced is the first *tool call*, and a model has to answer before one can exist.
    if (options.bypass) void setYolo(ref, true, session.directory);
    const showing = paneShowsPending(id);
    dropPendingCreate(id);
    // Only drop the pane reference if it still points at *this* attempt: the person may have
    // started another draft while this one was in flight, and that one is not this one's to close.
    if (draftPendingIdRef.current === id) setDraftPendingId(null);
    if (showing) {
      openSession(ref, session);
    } else {
      // Left the draft while it was being created: the session is real, so say so and offer the way
      // in rather than pulling the person off whatever they moved on to.
      setActionNotice({
        message: `Started “${latest.title}” on ${instanceLabelOf(options.instanceId)}.`,
        actionLabel: 'Open',
        action: () => openSession(ref, session),
      });
    }
    createBaselines.current.delete(id);
  };

  /**
   * Register a draft's message and start (or extend) its create.
   *
   * The boolean keeps `sendTo`'s meaning — "the UI now holds this message" — and resolves as soon
   * as the attempt is on screen, not when the host answers. A pre-flight refusal (an unavailable
   * model) is the only case that returns false, because then nothing is held anywhere.
   */
  const handleCreateAndSend = async (options: NewSessionOptions, input: PromptInput): Promise<boolean> => {
    showActionError(null);
    const modelError = selectedModelError(input.selectedModelId, input.model);
    if (modelError) {
      showActionError(modelError);
      return false;
    }
    const createdAt = Date.now();
    const message = {
      id: createClientMessageId(createdAt),
      input,
      text: input.text.trim(),
      attachments: input.attachments ?? [],
      createdAt,
      held: false,
    };
    const existing = pendingCreateById(draftPendingIdRef.current);
    if (existing) {
      // Enter while the session is starting: hold it, do not start a second session.
      if (existing.phase === 'creating') {
        updatePendingCreate(existing.id, (entry) => holdPendingMessage(entry, message));
        announceStatus('Held. This message will be sent once the session starts.');
        return true;
      }
      // A refused create plus a new message: the person has said "send this too", so retry to the
      // destination the row now shows, with the failed message still first.
      updatePendingCreate(existing.id, (entry) =>
        restartPendingCreate(holdPendingMessage(entry, message), options)
      );
      void runPendingCreate(existing.id);
      return true;
    }
    const pending = createPendingCreate({
      id: createClientMessageId(createdAt),
      options,
      title: newSessionTitle(options, input),
      message,
      createdAt,
    });
    mutatePendingCreates((previous) => [...previous, pending]);
    createBaselines.current.set(
      pending.id,
      new Set((sessionsByInstanceRef.current[options.instanceId] ?? []).map((entry) => entry.id))
    );
    setDraftPendingId(pending.id);
    void runPendingCreate(pending.id);
    return true;
  };

  /**
   * A conversation this attempt may already have made.
   *
   * A create whose answer was lost (a dropped socket, a timeout) is not a failure the client can
   * resolve: the host may have committed it. Before retrying, ask the rail. The match is deliberately
   * narrow — same folder, exactly the derived title, no entries, and not in the list the attempt
   * started from — because adopting the wrong conversation would send the message into someone
   * else's chat. `lastEntryId` is absent only when the host reports an empty conversation, which a
   * create makes and nothing else does.
   */
  const adoptOrphanedCreate = async (
    pending: PendingCreate,
    options: NewSessionOptions
  ): Promise<Session | null> => {
    const baseline = createBaselines.current.get(pending.id);
    const list = await loadSessions(options.instanceId);
    if (!list) return null;
    return (
      list.find(
        (session) =>
          session.directory === options.directory &&
          session.title === pending.title &&
          session.lastEntryId === undefined &&
          !baseline?.has(session.id)
      ) ?? null
    );
  };

  /** Try a refused create again, wherever the draft row now points. */
  const handleRetryCreate = async (id: string, options: NewSessionOptions) => {
    showActionError(null);
    const pending = pendingCreateById(id);
    if (!pending) return;
    updatePendingCreate(id, (entry) => restartPendingCreate(entry, options));
    setDraftPendingId(id);
    const orphan = await adoptOrphanedCreate(pending, options);
    if (orphan) {
      handOffPendingCreate(id, orphan);
      return;
    }
    void runPendingCreate(id);
  };

  /** Put a refused create's message back in the composer to edit; App keeps nothing of it. */
  const handleEditCreate = (id: string) => {
    dropPendingCreate(id);
    setDraftPendingId(null);
  };

  /**
   * Park a note while the session is starting.
   *
   * The draft has no session key to hang notes on, so the attempt holds them and the hand-off moves
   * them under the session's own key — the same For later tray as any other note, just one step
   * later. Anywhere else this is `handleSaveNote` under the surface, which is defined below.
   */
  const handleSaveDraftNote = (id: string, text: string) => {
    const clean = text.trim().slice(0, 20_000);
    if (!clean) return;
    updatePendingCreate(id, (entry) => addPendingNote(entry, { id: createNoteId(), text: clean }));
    announceStatus('Saved for this session. It joins its notes when the session starts.');
  };

  /** The attempt the draft pane shows. State, not the ref, so a phase change re-renders the pane. */
  const draftPendingCreate = draftPendingId
    ? pendingCreates.find((entry) => entry.id === draftPendingId) ?? null
    : null;

  const handleSend = (
    input: PromptInput,
    options?: { retainOnFailure?: boolean }
  ): Promise<boolean> =>
    selected
      ? sendTo(selected, selectedSession?.directory, input, {
          retainOnFailure: options?.retainOnFailure ?? true,
        })
      : Promise.resolve(false);

  const instanceLabelOf = (instanceId: string): string =>
    instances.find((instance) => instance.id === instanceId)?.label ?? instanceId;

  const queue = useMessageQueue({
    modelsByInstance,
    setQueuesByInstance,
    showActionError,
  });

  /**
   * Send one message. The boolean means "the UI now holds this message": placed, queued, or a
   * failed bubble that keeps the text with its own Send again. Only a send that left no trace
   * anywhere returns false, so a composer clears its draft exactly when the message has a home.
   */
  const sendTo = async (
    target: SessionRef,
    directory: string | undefined,
    input: PromptInput,
    options: { retainOnFailure?: boolean; quiet?: boolean } = {}
  ): Promise<boolean> => {
    showActionError(null);
    const { instanceId, sessionId } = target;
    const { model, text, attachments = [], variant } = input;
    const key = sessionKey(target);

    // The bubble appears at once, marked `Sending…`, and is reconciled when Hearth answers. It used
    // to be withheld until the reply arrived (because a follow-up can be parked in the inbox when
    // the conversation is busy, and a bubble that then hops to the queue is a lie). Withholding it
    // was worse: the composer clears on Enter, so between the keystroke and the server's answer -
    // which is exactly the slow round trip the user is waiting on - the message was nowhere on
    // screen and looked lost. So it is shown immediately and *moved* to the queue row when Hearth
    // says it was parked, rather than never appearing.
    const isPi = instances.find((instance) => instance.id === instanceId)?.kind === 'pi';
    const steered = input.steer === true;

    const createdAt = Date.now();
    const optimisticId = createClientMessageId(createdAt);
    const parts: ChatMessage['parts'] = [
      ...(text.trim()
        ? [{ type: 'text' as const, id: `${optimisticId}-text`, text: text.trim() }]
        : []),
      ...attachments.map((file, index) => ({
        type: 'file' as const,
        id: `${optimisticId}-file-${index}`,
        file,
      })),
    ];
    const optimistic: ChatMessage = {
      id: optimisticId,
      role: 'user',
      text: text.trim(),
      parts,
      model: model ? { providerID: model.providerID, modelID: model.modelID, variant } : undefined,
      createdAt,
      completed: true,
      // The request is in flight. It stays `sending` for as long as the server takes: an accepted
      // send is never doubted, and a definite failure replaces this with `failed`.
      delivery: 'sending',
    };
    const showOptimistic = () => {
      pendingFor(key).add(optimisticId);
      pendingSentAt.current.set(optimisticId, createdAt);
      recordSent(sentLedgerRef.current, key, { id: optimisticId, text: text.trim(), at: createdAt });
      pendingInputs.current.set(optimisticId, { target, directory, input });
      updateCachedMessages(key, (prev) => [...prev, optimistic]);
    };
    const removeOptimistic = () =>
      updateCachedMessages(key, (prev) => prev.filter((message) => message.id !== optimisticId));
    /** Replace the in-flight state with a settled one, keeping the bubble in place. */
    const setDelivery = (delivery?: ChatMessage['delivery'], deliveryError?: string) =>
      updateCachedMessages(key, (prev) =>
        prev.map((message) =>
          message.id === optimisticId ? { ...message, delivery, deliveryError } : message
        )
      );
    /**
     * A definite failure. The bubble keeps the message (so the text cannot vanish) and shows the
     * ways out: Send again replays exactly this input, Copy keeps the text, Discard drops it. The
     * banner names the reason, since the row is deliberately short.
     */
    const failSend = (reason: string) => {
      setDelivery('failed', reason);
      // `quiet` is for a failure that is already on screen in its own session — a new agent's first
      // send. The bubble carries the reason; the top bar would only say it twice, far away.
      if (!options.quiet) showActionError(reason);
    };
    showOptimistic();
    setSendingKeys((prev) => new Set(prev).add(key));

    let accepted = false;
    // A retained failure bubble is the message's home until the user retries or discards it, so
    // its id must stay protected from the poll's reconciliation (which would otherwise drop it).
    let retained = false;

    try {
      const sent = await sendPrompt(instanceId, sessionId, input, directory, optimisticId);
      // Keep the optimistic id registered until the transcript below is reconciled; the 3s
      // poller can land in between and would otherwise drop the bubble for one tick.
      if (!sent.ok) {
        const reason = responseError(sent.data, 'Message could not be sent.', instanceLabelOf(instanceId));
        if (options.retainOnFailure === true) {
          retained = true;
          failSend(reason);
          return true;
        }
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        showActionError(reason, () => void sendTo(target, directory, input));
        return false;
      }
      accepted = true;
      // Hearth says whether the message actually landed. `queued` means the conversation was
      // busy and it was parked in the inbox — that is NOT a sent message, so it belongs in the
      // queue, never the transcript. A *steer* (Alt+Enter / "send now") is also admitted
      // `queued`, but it joins the running turn rather than waiting in the inbox — it keeps its
      // optimistic bubble and lands at its boundary.
      // A 2xx is confirmation that the server holds the message; the body only refines it (a
      // queued follow-up, a steer joining the running turn). `sendDelivery` owns that reading so
      // it can be tested without a bridge.
      const outcome = submitOutcomeOf(sent.data, { steer: steered });
      if (outcome.kind === 'failed') {
        // A wire that reports a refused submission in a 2xx body: still a definite failure.
        failSend(outcome.error ?? 'The server refused the message.');
        return false;
      }
      const didSteer = outcome.steer;
      const queued = Boolean(isPi) && outcome.queued && !didSteer;
      if (queued) {
        // It was parked in the inbox, so it belongs in the queue, not the transcript. Move it
        // rather than leaving a stale bubble behind: the queue row is keyed by the submission id,
        // so the same text continues to reconcile against Hearth's inbox.
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        // Show it where it really lives: an optimistic queue row (with a loader) keyed by the
        // submission id, so it reconciles with Hearth's inbox instead of flickering.
        const submissionId = outcome.submissionId ?? '';
        if (submissionId) {
          queue.adoptQueuedSubmission(target, directory, {
            id: submissionId,
            text: text.trim(),
            model,
            variant,
            mode: input.mode,
          });
        }
        void refreshQueues([instanceId]);
        return true;
      }
      // Placed (or steered): the host says it is in the conversation, and the bubble is already on
      // screen from the moment Enter was pressed. That claim is `unconfirmed`, not "sent": the
      // proof is the transcript's echo, and a placed message whose echo never lands is the one case
      // where a 2xx is not evidence that anything arrived. A queued steer keeps a factual note
      // until the server's copy lands in the transcript.
      setDelivery(deliveryAfterAcceptance(outcome));
      const updated = Date.now();
      // Mirror what the next session poll will report so the recents list moves right away.
      setSessionsByInstance((prev) => ({
        ...prev,
        [instanceId]: (prev[instanceId] ?? []).map((session) =>
          session.id === sessionId
            ? {
                ...session,
                updated,
                model: model ? { providerID: model.providerID, modelID: model.modelID, variant } : session.model,
              }
            : session
        ),
      }));
      // The server may not have indexed the user turn yet; reconcile keeps the bubble until it does.
      await loadAndCommitMessages({ instanceId, sessionId }, 'full', directory, true);
      return true;
    } catch (err) {
      console.error('Send failed', err);
      // Name the underlying failure: a generic "could not be refreshed" hides the real cause
      // (auth, a missing route, a malformed response) exactly when it matters.
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 200)})` : '';
      if (!accepted) {
        const reason = err instanceof Error ? err.message : 'Message could not be sent.';
        if (options.retainOnFailure === true) {
          retained = true;
          failSend(reason);
          return true;
        }
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        showActionError(reason, () => void sendTo(target, directory, input));
      } else if (!options.quiet) {
        showActionError(`Message was sent, but the transcript could not be refreshed yet.${detail}`);
      }
      return accepted;
    } finally {
      // Accepted sends and retained failures keep the id until the server copy or the user's
      // retry/discard settles it (see releaseOptimistic).
      if (!accepted && !retained) releaseOptimistic(key, [optimisticId]);
      setSendingKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  /**
   * Turn a ghost steer into an honest answer — which now has two shapes.
   *
   * A message sent as a steer is held by the host until the turn's next boundary — and a turn that is
   * *stopped* may never reach one. Whether it did is not something the client can infer: Hearth's
   * stop withdraws every queued input and re-parks it in the same mode, and reports how many it kept
   * (`parked`, `parkedText`). So the receipt decides:
   *
   * - The host still holds it: it is *waiting*, not lost. The bubble keeps its `queued` note
   *   ("Waiting for the turn to pause") and offers Discard, which withdraws it from the host. It
   *   must never offer Send again — the message is already in the queue, and sending it again would
   *   run the same instruction twice.
   * - The host does not hold it: the bubble becomes an ordinary failed send with a reason and the
   *   ways out (Send again / Copy / Discard), which keeps the text and lets the person decide.
   */
  const reclaimAbandonedSteers = useStableCallback((key: string) => {
    const ids = pendingOptimisticIds.current.get(key);
    if (!ids || ids.size === 0) return;
    const ref = parseSessionKey(key);
    if (!ref) return;
    if (statesRef.current[key] === 'active') return;
    const messages = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
    if (messages.length === 0) return;
    const queued = (queuesRef.current[ref.instanceId] ?? [])
      .find((entry) => entry.sessionId === ref.sessionId)?.items ?? [];
    const receipt = abortReceipts.current.get(key);
    const now = Date.now();
    for (const id of [...ids]) {
      const messageIndex = messages.findIndex((entry) => entry.id === id);
      if (messageIndex < 0) continue;
      const message = messages[messageIndex];
      const inQueue =
        message.text.trim().length > 0 && queued.some((item) => item.text.trim() === message.text.trim());
      const landed =
        messages.some(
          (entry, index) =>
            entry.id !== id &&
            entry.role === 'user' &&
            entry.text === message.text &&
            (index > messageIndex ||
              (entry.createdAt !== undefined &&
                message.createdAt !== undefined &&
                entry.createdAt >= message.createdAt - 5_000))
        ) || inQueue;
      // The stop's own receipt is evidence a moment older than the queue read: it names the messages
      // the host kept before the inbox refresh lands. Only a stop *after* this message was sent can
      // speak for it. Either piece of evidence is enough to stop calling it lost.
      const receiptForThisSend = receipt && receipt.at >= (message.createdAt ?? 0) - 1_000 ? receipt : undefined;
      const hostHolds = inQueue || stopHeldMessage(receiptForThisSend, message.text);
      if (
        !steerAbandoned({
          delivery: message.delivery,
          createdAt: message.createdAt,
          sessionBusy: false,
          landed,
          hostHolds,
          now,
        })
      ) {
        continue;
      }
      forgetPendingSend(key, id);
      updateCachedMessages(key, (previous) =>
        previous.map((entry) =>
          entry.id === id
            ? { ...entry, delivery: 'failed' as const, deliveryError: 'Stopped before this was sent.' }
            : entry
        )
      );
    }
  });

  // A queued steer whose turn is over will never be placed (see `reclaimAbandonedSteers`). Checking on
  // every state/transcript change catches both ways a turn ends: the stop button, and a turn that
  // errors out on its own. The age guard inside the predicate keeps it from racing a real boundary.
  const pendingSendKeys = React.useMemo(
    () => [...pendingOptimisticIds.current].filter(([, ids]) => ids.size > 0).map(([key]) => key).join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed from the same state the reclaim watches
    [states, transcripts]
  );
  React.useEffect(() => {
    for (const key of pendingSendKeys.split('|').filter(Boolean)) reclaimAbandonedSteers(key);
  }, [pendingSendKeys, states, transcripts, reclaimAbandonedSteers]);

  /** Forget every trace of an optimistic send: pending id, stored input and ledger record. */
  const forgetPendingSend = (key: string, messageId: string) => {
    pendingOptimisticIds.current.get(key)?.delete(messageId);
    pendingSentAt.current.delete(messageId);
    unconfirmedSends.current.delete(messageId);
    pendingInputs.current.delete(messageId);
    const records = sentLedgerRef.current.get(key);
    if (records) {
      sentLedgerRef.current.set(key, records.filter((record) => record.id !== messageId));
    }
  };

  /** Send a failed message again, with exactly the input the first attempt used. */
  const handleRetryPendingSend = (key: string, message: ChatMessage) => {
    const stored = pendingInputs.current.get(message.id);
    forgetPendingSend(key, message.id);
    if (!stored) {
      setActionNotice({ message: 'Removed it. Copy the text out of the transcript to send it again.' });
      // The parameter shadowed the outer `message`, so the predicate compared an id to itself and the
      // filter returned []: "Removed it" blanked the whole cached transcript instead of the bubble.
      updateCachedMessages(key, (previous) => previous.filter((entry) => entry.id !== message.id));
      return;
    }
    disposePendingSend(key, message.id);
    void sendTo(stored.target, stored.directory, stored.input, { retainOnFailure: true });
  };

  /**
   * Take back an unsent message.
   *
   * Which way that works depends on what the host holds. A `failed` bubble only ever existed here,
   * so removing it is the whole job. A `queued` one is in the host's hands: removing the bubble
   * alone would leave the message to run, so it is withdrawn from the host first. An `unconfirmed`
   * one may or may not have arrived, and there is no id to withdraw by — the bubble goes and the
   * notice says plainly what could not be undone.
   */
  const handleDiscardPendingSend = (key: string, message: ChatMessage) => {
    const ref = parseSessionKey(key);
    if (message.delivery === 'queued' && ref) {
      const items =
        (queuesByInstance[ref.instanceId] ?? []).find((entry) => entry.sessionId === ref.sessionId)?.items ?? [];
      const wanted = message.text.trim();
      const item =
        wanted.length > 0
          ? items.find((entry) => entry.text.trim() === wanted) ?? null
          : items.find((entry) => entry.mode === 'steer' && entry.text.trim() === '') ??
            items.find((entry) => entry.mode === 'steer') ??
            null;
      forgetPendingSend(key, message.id);
      disposePendingSend(key, message.id);
      if (!item) {
        setActionNotice({
          message: 'Removed it here. The host no longer lists it as waiting, so there was nothing left to withdraw.',
        });
        return;
      }
      void removeQueuedMessage(ref.instanceId, ref.sessionId, item.id).then((removed) => {
        void refreshQueues([ref.instanceId]);
        setActionNotice({
          message: removed.ok
            ? 'Withdrew that message from the host.'
            : 'Removed it here, but the host still holds it. Try Discard again.',
        });
      });
      return;
    }
    const wasUnconfirmed = message.delivery === 'unconfirmed';
    forgetPendingSend(key, message.id);
    disposePendingSend(key, message.id);
    setActionNotice({
      message: wasUnconfirmed
        ? 'Removed it. The host may have taken the message anyway — it was never shown in this conversation.'
        : 'Removed the failed message from the transcript.',
    });
  };

  const disposePendingSend = (key: string, messageId: string) =>
    updateCachedMessages(key, (previous) => previous.filter((message) => message.id !== messageId));

  /** Queue handlers are built per column; this binds one to its session. */
  const queueTargetFor = (ref: SessionRef, session: Session | null): QueueTarget => ({
    ref,
    session,
    queue:
      (queuesByInstance[ref.instanceId] ?? []).find((entry) => entry.sessionId === ref.sessionId) ??
      null,
    send: (input) => sendTo(ref, session?.directory, input),
  });

  const handleReloadSession = async (session: Session) => {
    const key = sessionKey(session);
    if (reloadingKeys.has(key)) return;
    showActionError(null);
    setReloadingKeys((current) => new Set(current).add(key));
    const hints = session.directory ? { [session.instanceId]: [session.directory] } : {};
    const results = await Promise.allSettled([
      loadAllSessions([session.instanceId], hints),
      loadAndCommitMessages({ instanceId: session.instanceId, sessionId: session.id }, 'full', session.directory, true),
      loadSessionStates(session.instanceId),
      loadPermissions(session.instanceId),
      loadQuestions(session.instanceId, session.directory),
    ] as const);
    const [sessionResult, messageResult, stateResult, permissionResult, questionResult] = results;

    if (sessionResult.status === 'fulfilled' && sessionResult.value[session.instanceId]) {
      setSessionsByInstance((current) =>
        mergePolledSessions(current, sessionResult.value, [session])
      );
    }
    if (messageResult.status === 'rejected') {
      // The user pressed Refresh and the full read was rejected: nothing will retry this on its
      // own, so it is the one failure that may present as a failure.
      setTranscriptFor(key, messageCacheRef.current.get(key) ?? [], 'error', 'reload');
      // Refresh is also carried out here, not through `refreshMessages`, so its failure has to be
      // counted where it happens: otherwise the breaker never saw the reader's own failed attempt
      // and the missing-history line would keep offering a "Load them" that is known to fail.
      // Asking is asking, though — a run of failures never stops a repair the reader started.
      recordFullReadFailure(
        { instanceId: session.instanceId, sessionId: session.id },
        classifyFullReadFailure(messageResult.reason)
      );
    }
    if (stateResult.status === 'fulfilled' && stateResult.value) {
      setStateReadAt((current) => ({ ...current, [session.instanceId]: Date.now() }));
      setStatesByInstance((current) => ({ ...current, [session.instanceId]: stateResult.value! }));
    }
    if (permissionResult.status === 'fulfilled' && permissionResult.value) {
      setPermissionsByInstance((current) => ({ ...current, [session.instanceId]: permissionResult.value! }));
    }
    if (questionResult.status === 'fulfilled' && questionResult.value) {
      setQuestionsByInstance((current) => {
        const previous = current[session.instanceId] ?? [];
        const incoming = questionResult.value!;
        const incomingIds = new Set(incoming.map((entry) => entry.id));
        const kept = previous.filter(
          (entry) =>
            !incomingIds.has(entry.id) &&
            entry.sessionId !== session.id &&
            (session.directory ? entry.directory !== session.directory : false)
        );
        return { ...current, [session.instanceId]: [...kept, ...incoming] };
      });
    }
    void refreshPromptsFor([session.instanceId]);
    void refreshQueues([session.instanceId]);
    if (results.some((result) => result.status === 'rejected')) {
      // A failed reload often means the instance dropped; reprobe so its status is honest and a
      // revived remote reattaches without waiting for the watchdog.
      void readInstances().catch(() => {});
      showActionError(
        'Some session data could not be refreshed.',
        () => void handleReloadSession(session)
      );
    }
    setReloadingKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  // Archive/restore on the source OpenChamber instance, then mirror locally so the
  // row leaves the current view without waiting for the next poll.
  const handleArchive = async (session: Session, archived: boolean) => {
    const key = sessionKey(session);
    if (archivingKeys.has(key)) return;
    showActionError(null);
    setActionNotice(null);
    setArchivingKeys((current) => new Set(current).add(key));
    try {
      const ok = await setSessionArchived(session, archived);
      if (!ok) {
        showActionError(
          archived ? 'Could not archive this session.' : 'Could not restore this session.',
          () => void handleArchive(session, archived)
        );
        return;
      }
      /** Whether closing this column leaves nothing to read — Home would otherwise take over. */
      const wasActive = archived && activeSessionRef.current === key;
      const remainingAfterClose = openSessionsRef.current.filter((entry) => entry !== key);
      // The rail's next session, captured *before* the archive bumps `updated` and resorts it.
      const nextToOpen =
        wasActive && remainingAfterClose.length === 0 && !newSessionInstanceId
          ? nextSessionAfterArchive(
              session,
              Object.values(sessionsByInstanceRef.current).flat(),
              projectsByInstanceRef.current,
              settingsRef.current.sessionGroups,
              minimizedKeysRef.current
            )
          : null;
      const now = Date.now();
      setSessionsByInstance((prev) => ({
        ...prev,
        [session.instanceId]: (prev[session.instanceId] ?? []).map((entry) =>
          entry.id === session.id ? { ...entry, archived: archived ? now : undefined, updated: now } : entry
        ),
      }));
      // Archived sessions never stay open; a neighbour takes over if this was the active column.
      const wasOpen = openSessionsRef.current.includes(key);
      if (archived) {
        closeSession(key);
        // Archiving the last column is "next, please", not an exit: open the session that was
        // underneath it in the rail. With nothing left the workspace does go Home, honestly.
        if (nextToOpen) {
          openSession({ instanceId: nextToOpen.instanceId, sessionId: nextToOpen.id }, nextToOpen);
        }
      }
      setActionNotice(
        archived
          ? {
              message: 'Session archived.',
              actionLabel: 'Undo',
              // Undo restores the session on the instance and reopens it if the archive closed it.
              action: () => {
                void (async () => {
                  await handleArchive(session, false);
                  if (wasOpen) {
                    openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                  }
                })();
              },
            }
          : { message: 'Session restored.' }
      );
    } catch (err) {
      showActionError(
        err instanceof Error
          ? err.message
          : archived
            ? 'Could not archive this session.'
            : 'Could not restore this session.',
        () => void handleArchive(session, archived)
      );
    } finally {
      setArchivingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  /**
   * Rename on the source instance, mirroring locally right away. The local `updated` bump keeps
   * an in-flight pre-rename poll from reverting the title (the server's PATCH bumps it too).
   */
  const handleRenameSession = async (session: Session, title: string) => {
    const next = title.trim();
    const previous = session.title;
    if (!next || next === previous) return;
    const apply = (value: string | undefined) =>
      setSessionsByInstance((prev) => ({
        ...prev,
        [session.instanceId]: (prev[session.instanceId] ?? []).map((entry) =>
          entry.id === session.id ? { ...entry, title: value, updated: Date.now() } : entry
        ),
      }));
    apply(next);
    try {
      if (!(await renameSession(session, next))) throw new Error('rename failed');
    } catch {
      apply(previous);
      showActionError('Could not rename the session.');
    }
  };

  /**
   * Archive from a session's × control (header or tab). A session with live work, a pending
   * permission/question or queued messages gets one confirmation first; archiving never sends an
   * abort and always offers Undo.
   */
  const requestArchive = (session: Session) => {
    const key = sessionKey(session);
    const ref = parseSessionKey(key);
    if (!ref || session.archived || archivingKeys.has(key)) return;
    const pending =
      // Anything that is not *known* to be quiet needs a confirmation: a session whose host has not
      // answered may be mid-turn, and archiving it closes the column while the run goes on.
      !isQuietlyArchivable(sessionStatusAnswer(moods, session)) ||
      permissions.some((entry) => entry.instanceId === ref.instanceId && entry.sessionId === ref.sessionId) ||
      questions.some((entry) => entry.instanceId === ref.instanceId && entry.sessionId === ref.sessionId) ||
      (queuesByInstance[ref.instanceId] ?? []).some(
        (entry) => entry.sessionId === ref.sessionId && entry.items.length > 0
      ) ||
      // A leader with a working crew gets one confirmation: archiving cascades to the workers
      // (and stops the running ones) on the server, so the human should mean it.
      (crewWorkers.get(key) ?? []).some((worker) => {
        const state = states[sessionKey(worker)] ?? 'unknown';
        return state === 'unknown' || state === 'active' || state === 'needs-input';
      });
    if (pending) setArchiveConfirmKey(key);
    else void handleArchive(session, true);
  };

  /** Bulk archive/restore from a project card's `+N` menu, with one undo notice for the batch. */
  const handleArchiveMany = async (sessions: Session[], archived = true, notice?: (count: number) => string) => {
    const targets = sessions.filter((session) => Boolean(session.archived) !== archived);
    if (targets.length === 0) return;
    showActionError(null);
    setActionNotice(null);
    setArchivingKeys((current) => {
      const next = new Set(current);
      targets.forEach((session) => next.add(sessionKey(session)));
      return next;
    });
    const results = await Promise.all(
      targets.map(async (session) => ({
        session,
        ok: await setSessionArchived(session, archived).catch(() => false),
      }))
    );
    const succeeded = results.filter((result) => result.ok).map((result) => result.session);
    const failed = results.length - succeeded.length;
    if (succeeded.length > 0) {
      // A bulk archive that takes every open column (a sweep, or a project's tidy-up) lands once,
      // on the rail's next session — not by shuffling through intermediate actives on the way.
      const succeededKeys = new Set(succeeded.map(sessionKey));
      const activeKey = activeSessionRef.current;
      const clearsWorkspace =
        archived &&
        Boolean(activeKey && succeededKeys.has(activeKey)) &&
        openSessionsRef.current.every((entry) => succeededKeys.has(entry));
      const nextToOpen =
        clearsWorkspace && !newSessionInstanceId && activeKey
          ? nextSessionAfterArchive(
              succeeded.find((session) => sessionKey(session) === activeKey) ?? succeeded[0],
              Object.values(sessionsByInstanceRef.current).flat(),
              projectsByInstanceRef.current,
              settingsRef.current.sessionGroups,
              minimizedKeysRef.current
            )
          : null;
      const now = Date.now();
      setSessionsByInstance((prev) => {
        const next = { ...prev };
        succeeded.forEach((session) => {
          next[session.instanceId] = (next[session.instanceId] ?? []).map((entry) =>
            entry.id === session.id ? { ...entry, archived: archived ? now : undefined, updated: now } : entry
          );
        });
        return next;
      });
      if (archived) {
        succeeded.forEach((session) => closeSession(sessionKey(session)));
        if (nextToOpen) {
          openSession({ instanceId: nextToOpen.instanceId, sessionId: nextToOpen.id }, nextToOpen);
        }
      }
    }
    setArchivingKeys((current) => {
      const next = new Set(current);
      targets.forEach((session) => next.delete(sessionKey(session)));
      return next;
    });
    if (failed > 0) {
      showActionError(
        `${failed} of ${targets.length} sessions could not be ${archived ? 'archived' : 'restored'}.`
      );
    }
    if (succeeded.length > 0) {
      setActionNotice({
        message: archived && notice
          ? notice(succeeded.length)
          : `${archived ? 'Archived' : 'Restored'} ${succeeded.length} session${succeeded.length === 1 ? '' : 's'}.`,
        actionLabel: 'Undo',
        action: () => void handleArchiveMany(succeeded, !archived),
      });
    }
  };

  /**
   * Housekeeping: scheduled-task runs archive themselves once they're read, a day old, finished, and
   * not on screen. They stay reachable — the scheduled view lists bound sessions regardless of
   * archive state, and Undo/restore still works. One notice covers the whole sweep.
   */
  const sweepAttemptsRef = React.useRef(new Map<string, number>());
  const sweepStaleScheduledRuns = useStableCallback(() => {
    if (!settings.autoArchiveScheduledRuns || archivingKeys.size > 0) return;
    const open = new Set([...openSessions, ...minimizedSessions]);
    const ready = new Set(readyIds);
    const pool = Object.values(sessionsByInstance)
      .flat()
      .filter((session) => ready.has(session.instanceId));
    const now = Date.now();
    // A failed archive is retried at most every five minutes, not on every poll.
    // Silence/muting is not a read receipt. Only current message evidence permits cleanup.
    const readKeys = new Set(pool.filter((session) => !hasUnreadMessages(
      session, readMarks[sessionKey(session)], unreadDigests.digests[sessionKey(session)]
    )).map(sessionKey));
    const targets = staleScheduledRuns(pool, settings.scheduledSessionBindings, moods, open, now, readKeys)
      .filter((session) => {
        const key = sessionKey(session);
        const attempted = sweepAttemptsRef.current.get(key) ?? 0;
        if (now - attempted < 5 * 60_000) return false;
        sweepAttemptsRef.current.set(key, now);
        return true;
      });
    if (targets.length > 0) {
      void handleArchiveMany(
        targets,
        true,
        (count) => `Auto-archived ${count} finished scheduled run${count === 1 ? '' : 's'}.`
      );
    }
  });

  React.useEffect(() => {
    sweepStaleScheduledRuns();
    const timer = window.setInterval(sweepStaleScheduledRuns, 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [sweepStaleScheduledRuns, sessionsByInstance, settings.scheduledSessionBindings, settings.autoArchiveScheduledRuns]);

  /** From the archive screen: restore, then open the session as a column. */
  const handleRestoreAndOpen = async (session: Session) => {
    await handleArchive(session, false);
    openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
    setArchiveOpen(false);
  };

  // Drop the card as soon as the server accepts the reply; the next poll is authoritative.
  const handlePermission = async (
    request: PermissionRequest,
    reply: PermissionReply
  ): Promise<boolean> => {
    showActionError(null);
    try {
      const directory = request.directory ?? (sessionsByInstance[request.instanceId] ?? []).find(
        (session) => session.id === request.sessionId
      )?.directory;
      const ok = await replyPermission(request, reply, directory);
      if (!ok) {
        showActionError(
          'Could not reply to this permission request.',
          () => void handlePermission(request, reply)
        );
        return false;
      }
      setPermissionsByInstance((prev) => ({
        ...prev,
        [request.instanceId]: (prev[request.instanceId] ?? []).filter((entry) => entry.id !== request.id),
      }));
      // "Always allow" enables server-side auto-accept, so refresh the YOLO toggle to match.
      if (reply === 'always') void refreshAutoAccept([request.instanceId]);
      return true;
    } catch (err) {
      showActionError(
        err instanceof Error ? err.message : 'Could not reply to this permission request.',
        () => void handlePermission(request, reply)
      );
      return false;
    }
  };

  // handlePermission is redefined every render; go through a stable wrapper so this effect
  // only re-runs when the permission list or the selection actually changes.
  const autoReplyPermission = useStableCallback(handlePermission);
  React.useEffect(() => {
    // With server-side YOLO the server answers prompts itself; replying here too would race it.
    if (!bypass || !selected || serverYolo) return;
    permissions
      .filter(
        (request) =>
          request.instanceId === selected.instanceId && request.sessionId === selected.sessionId
      )
      .forEach((request) => {
        const key = `${request.instanceId}:${request.id}`;
        if (bypassReplyIds.current.has(key)) return;
        bypassReplyIds.current.add(key);
        void autoReplyPermission(request, 'once').finally(() => bypassReplyIds.current.delete(key));
      });
  }, [bypass, serverYolo, permissions, selected, autoReplyPermission]);

  const sessionDirectory = (instanceId: string, sessionId: string) =>
    (sessionsByInstance[instanceId] ?? []).find((session) => session.id === sessionId)?.directory;

  const dropQuestion = (request: QuestionRequest) =>
    setQuestionsByInstance((prev) => ({
      ...prev,
      [request.instanceId]: (prev[request.instanceId] ?? []).filter((entry) => entry.id !== request.id),
    }));

  const handleQuestion = async (
    request: QuestionRequest,
    answers: QuestionAnswers | null
  ): Promise<boolean> => {
    showActionError(null);
    try {
      const directory = request.directory ?? sessionDirectory(request.instanceId, request.sessionId);
      const ok = answers
        ? await replyQuestion(request, answers, directory)
        : await rejectQuestion(request, directory);
      if (!ok) {
        showActionError(
          answers ? 'Could not submit this answer.' : 'Could not dismiss this question.',
          () => void handleQuestion(request, answers)
        );
        return false;
      }
      dropQuestion(request);
      return true;
    } catch (err) {
      showActionError(
        err instanceof Error
          ? err.message
          : answers
            ? 'Could not submit this answer.'
            : 'Could not dismiss this question.',
        () => void handleQuestion(request, answers)
      );
      return false;
    }
  };

  /**
   * The instructions dialog's two halves. Reading is lazy -- only when the dialog opens, since it is a
   * request for a string nobody looks at most days. Writing reports a refusal rather than throwing, so
   * the dialog can stay open with the text still in it.
   */
  const loadInstructionsFor = useStableCallback((session: Session) =>
    loadSessionInstructions(session.instanceId, session.id).catch(() => ({ supported: false }))
  );
  const saveInstructionsFor = useStableCallback(async (session: Session, instructions: string | null) => {
    const ok = await setSessionInstructions(session.instanceId, session.id, instructions);
    if (!ok) showActionError('Could not save those instructions. The host refused them.');
    return ok;
  });

  /**
   * Stop programs a session left running, and fold the host's answer back into the session list.
   *
   * The host answers with the list *after* the stop, so the notice redraws from that rather than from
   * a second read — and a process that ignored the polite signal comes back `refused`, which is what
   * the notice turns into its Force stop question. `{ ok: false }` means the request did not land:
   * the caller must say nothing was stopped, never that it worked.
   */
  const handleStopProcesses = useStableCallback(
    async (
      session: Session,
      pids: number[],
      options: { force?: boolean }
    ): Promise<StopProcessesResult> => {
      const answer = await stopSessionProcesses(session.instanceId, session.id, {
        pids,
        ...(options.force ? { force: true } : {}),
      });
      if (!answer) return { ok: false };
      const nextProcesses =
        answer.processes.length > 0
          ? {
              count: answer.processes.length,
              rssBytes: answer.processes.reduce((sum, process) => sum + process.rssBytes, 0),
              items: answer.processes.slice(0, 5),
            }
          : undefined;
      setSessionsByInstance((previous) => {
        const list = previous[session.instanceId];
        if (!list) return previous;
        return {
          ...previous,
          [session.instanceId]: list.map((entry) =>
            entry.id !== session.id
              ? entry
              : {
                  ...entry,
                  processes: nextProcesses,
                  ...(answer.memory ? { hostMemory: answer.memory } : {}),
                }
          ),
        };
      });
      return {
        ok: true,
        results: answer.results,
        processes: nextProcesses,
        ...(answer.memory ? { memory: answer.memory } : {}),
      };
    }
  );

  /**
   * Extra minutes the clock button has bought, per session (`instance::id`).
   *
   * Kept beside the reaper rather than inside the tray: the deadline a person extends and the timer
   * that stops the process have to read the same number, or the app promises ten minutes and takes
   * them anyway.
   */
  const [processExtensions, setProcessExtensions] = React.useState<Record<string, number>>({});
  const extendProcesses = React.useCallback((session: Session) => {
    const key = processKey(session);
    setProcessExtensions((previous) => ({ ...previous, [key]: (previous[key] ?? 0) + PROCESS_EXTENSION_MS }));
  }, []);

  /**
   * The reaper: Ember's own deadline for what its agents left running.
   *
   * The host has no expiry — a leftover program outlives its turn until something stops it — so the
   * only thing that ends one on time is this window staying open. It reads every session, not the
   * rail's list, because a crew worker's leftovers are exactly as real as a leader's.
   */
  const sessionsWithProcesses = React.useMemo(
    () => Object.values(sessionsByInstance).flat(),
    [sessionsByInstance]
  );
  useProcessReaper({
    sessions: sessionsWithProcesses,
    extensions: processExtensions,
    stop: (session, pids) => handleStopProcesses(session, pids, {}),
  });

  const handleAbort = async (session: Session) => {
    showActionError(null);
    const key = sessionKey(session);
    if (stoppingKeys.has(key)) return;
    setStoppingKeys((current) => new Set(current).add(key));
    const prevState = statesByInstanceRef.current[session.instanceId]?.[key];
    const restorePrevState = () =>
      setStatesByInstance((prev) => {
        const map = { ...(prev[session.instanceId] ?? {}) };
        if (prevState === undefined) delete map[key];
        else map[key] = prevState;
        return { ...prev, [session.instanceId]: map };
      });
    // Stop must feel instant. The transcript can't show the interrupted step until the run
    // commits it, but the UI should stop looking busy the moment the user asks: flip the
    // session's state to idle optimistically, mark any in-flight tool step interrupted, and
    // reconcile when the abort returns (or the stream event lands, whichever comes first).
    setStatesByInstance((prev) => ({ ...prev, [session.instanceId]: { ...(prev[session.instanceId] ?? {}), [key]: 'idle' } }));
    markSessionStepsInterrupted(session.instanceId, session.id);
    try {
      const aborted = await abortSession(session);
      if (!aborted.ok) {
        restorePrevState();
        showActionError('Could not stop this agent.', () => void handleAbort(session));
        return;
      }
      // What the stop kept. Hearth re-parks every queued input (in the same mode) and reports how
      // many, so the one question a stop raises — "did that eat my queue?" — has an answer. The
      // receipt is held for the steer reclaim: a placed steer that never ran is waiting, not lost,
      // and the queue read that proves it may still be a moment away.
      abortReceipts.current.set(key, { ...aborted, at: Date.now() });
      if (aborted.parked > 0) {
        const kept = aborted.parked === 1 ? '1 unsent message' : `${aborted.parked} unsent messages`;
        setActionNotice({
          message: `Stopped. The host kept ${kept} — ${aborted.parked === 1 ? 'it is' : 'they are'} still in the queue, waiting for a turn to run.`,
        });
      }
      // A stop can end a steer's wait without placing it, or keep it. Either way the bubbles that
      // were waiting on this turn can now be decided against the truth (`reclaimAbandonedSteers`).
      reclaimAbandonedSteers(key);
      // Reconcile, but do not make the stop wait for it — and do not ask for a full transcript to do
      // it. The host has already stopped (it answers within 250ms and winds the run down in the
      // background); what was left here was a *full* read of the session, seconds on a long one, with
      // the stop button held in its stopping state until it finished. That is what made a finished
      // stop feel unfinished.
      //
      // A tail is enough to settle it: the interrupted step belongs to the turn that just ended, so it
      // is at the end of the transcript, and `markSessionStepsInterrupted` already drew it. Anything
      // deeper is the periodic repair's job, not the stop's.
      void loadAndCommitMessages({ instanceId: session.instanceId, sessionId: session.id }, 'tail', session.directory, true).catch((err) => {
        console.error('Abort refresh failed', err);
      });
      // A stop re-parks every queued message as a *new* submission with a new id (`parking.ts`), so
      // until this read lands every row on screen is holding an id the host no longer has: Cancel,
      // Send now, Edit and reorder would all fail exactly while the user is looking at that strip.
      void refreshQueues([session.instanceId]);
    } catch (err) {
      console.error('Abort refresh failed', err);
      restorePrevState();
      showActionError(
        err instanceof Error ? err.message : 'Could not stop this agent.',
        () => void handleAbort(session)
      );
    } finally {
      setStoppingKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  // Summarize/compact the session's context on the instance, then pull the rewritten transcript.
  /**
   * How long to watch for a compaction actually starting: five polls of 400ms. A host that has not
   * flagged one within two seconds is the signature of a request accepted and then dropped, and
   * waiting longer only makes the click feel more broken.
   */
  const COMPACTION_WATCH_POLLS = 5;
  const COMPACTION_WATCH_MS = 400;

  const handleCompact = async (session: Session) => {
    const key = sessionKey(session);
    if (compactingKeys.has(key)) return;
    const ref = { instanceId: session.instanceId, sessionId: session.id };
    showActionError(null);
    setCompactingKeys((current) => new Set(current).add(key));
    const entriesBefore =
      (messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? []).length;
    const previousFailureTaskId = session.compactionFailure?.taskId;
    let sawCompacting = false;
    let compactionError: string | undefined;
    try {
      const receipt = await compactSession(session);
      if (!receipt.accepted) {
        showActionError('Could not compact this session.', () => void handleCompact(session));
        return;
      }
      // Watch the summary for the flag the host sets while a compaction runs, or for a failure the
      // task recorded on `pi.live.compactionFailure`. The host answers 202 for *every* request:
      // when the transcript already fits the kept window it posts no summary, no event and no flag,
      // and when the task fails immediately (`no_model`, `model_error`) it clears `compactions` and
      // sets `compactionFailure` in the same commit.
      for (let attempt = 0; attempt < COMPACTION_WATCH_POLLS && !sawCompacting && !compactionError; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, COMPACTION_WATCH_MS));
        await refreshSessions([session.instanceId]);
        const fresh = (sessionsByInstanceRef.current[session.instanceId] ?? []).find(
          (entry) => entry.id === session.id
        );
        sawCompacting = fresh?.compacting === true;
        const failure = fresh?.compactionFailure;
        if (
          failure?.error &&
          (receipt.taskId !== undefined
            ? failure.taskId === receipt.taskId
            : failure.taskId !== previousFailureTaskId)
        ) {
          compactionError = failure.error;
        }
      }
      // Clear any repair-breaker halt before re-reading so the full read is allowed and the banner
      // updates if the conversation now fits (or re-evaluates honestly if it still does not).
      if (repairBudget.current.halt(ref)) {
        repairBudget.current.succeeded(ref);
        setRepairHalts((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      await refreshMessages(ref, true);
      const entriesAfter =
        (messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? []).length;
      const trace = {
        accepted: receipt.accepted,
        sawCompacting,
        entriesBefore,
        entriesAfter,
        ...(compactionError ? { error: compactionError } : {}),
      };
      const outcome = compactionOutcome(trace);
      if (compactionError) {
        showActionError(compactionFailureMessage(compactionError), () => void handleCompact(session));
      } else {
        const notice = compactionNotice(outcome);
        if (notice) setActionNotice({ message: notice });
      }
      // Written down either way: the next "nothing happened" should be answerable from a file.
      void window.ember
        .reportCompaction?.(
          compactionLogLine(trace, { instanceId: session.instanceId, sessionId: session.id })
        )
        ?.catch(() => {});
    } catch (err) {
      console.error('Compact failed', err);
      showActionError(
        err instanceof Error ? err.message : 'Could not compact this session.',
        () => void handleCompact(session)
      );
    } finally {
      setCompactingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  /**
   * Ask a side question ("btw …") on a Kiln/Hearth session: forks the conversation into a hidden
   * `Aside #N` worker that carries the leader's full context and reports back as a side-question
   * card without interrupting the leader's running turn.
   */
  const handleAskSideQuestion = async (session: Session, question: string): Promise<boolean> => {
    const key = sessionKey(session);
    if (askingSideQuestionKeys.has(key)) return false;
    showActionError(null);
    setAskingSideQuestionKeys((current) => new Set(current).add(key));
    try {
      const worker = await askSideQuestion(session, question);
      if (!worker) {
        showActionError(
          'Could not ask a side question on this session. Try again.',
          () => void handleAskSideQuestion(session, question)
        );
        return false;
      }
      setSessionsByInstance((prev) => {
        const list = prev[session.instanceId] ?? [];
        if (list.some((entry) => entry.id === worker.id)) return prev;
        return { ...prev, [session.instanceId]: [worker, ...list] };
      });
      setStatesByInstance((prev) => ({
        ...prev,
        [session.instanceId]: { ...(prev[session.instanceId] ?? {}), [sessionKey(worker)]: 'active' },
      }));
      setActionNotice({
        message: `Asked in ${worker.title ?? 'a side worker'} — the answer will arrive here as a side-question card.`,
      });
      return true;
    } catch (err) {
      console.error('Side question failed', err);
      showActionError(
        err instanceof Error ? err.message : 'Could not ask a side question.',
        () => void handleAskSideQuestion(session, question)
      );
      return false;
    } finally {
      setAskingSideQuestionKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  /**
   * Promote a crew worker to an addressable peer (Hearth forks it). The response is the new peer
   * session: insert it, mark the worker `promotedTo` so its strip row becomes a peer link before
   * the next poll, then open the peer. Failure keeps the dialog closed and offers a retry.
   */
  const handlePromoteWorker = async (
    worker: Session,
    input: { name: string; description?: string; pinned: boolean }
  ) => {
    showActionError(null);
    const peer = await promoteSession(worker, {
      name: input.name,
      description: input.description,
      pinned: input.pinned,
    }).catch(() => null);
    if (!peer) {
      showActionError('Could not promote this worker.', () => void handlePromoteWorker(worker, input));
      return;
    }
    const now = Date.now();
    setSessionsByInstance((prev) => ({
      ...prev,
      [worker.instanceId]: [
        peer,
        ...(prev[worker.instanceId] ?? []).map((entry) =>
          entry.id === worker.id ? { ...entry, promotedTo: peer.id, updated: now } : entry
        ),
      ],
    }));
    // The server is the truth (promotedTo, the fork's title/summary); reconcile right away.
    await refreshSessions([worker.instanceId]).catch(() => undefined);
    openSession({ instanceId: peer.instanceId, sessionId: peer.id }, peer);
    setActionNotice({ message: `Promoted “${input.name}” to a peer.` });
  };

  const handleAvatarOverride = (scopeKey: string, override: AvatarOverride | null) => {
    const next = { ...settings.avatarOverrides };
    if (override) next[scopeKey] = override;
    else delete next[scopeKey];
    handleSettings({ avatarOverrides: next });
  };

  // The rail groups sessions into projects. Hearth folders are only for the new-agent folder
  // picker, so keep pi endpoints out of the rail's grouping map (they stay standalone sessions).
  const railProjectsByInstance = React.useMemo(
    () => Object.fromEntries(Object.entries(projectsByInstance).filter(([id]) => !id.startsWith('pi:'))),
    [projectsByInstance]
  );

  // Scheduled-task identity is one request per project (70+ on a busy instance), so it polls
  // rarely; the `scheduled-task-ran` event covers the moment it actually matters. Hearth serves
  // one aggregate request and has no project list, so pi instances count as known too.
  const projectsKnown =
    Object.keys(projectsByInstance).length > 0 || instances.some((instance) => instance.kind === 'pi');
  usePoll(() => refreshScheduled(deadIdsRef.current), SCHEDULE_POLL_MS, projectsKnown && deadIds.length > 0);
  usePoll(() => refreshScheduled(liveIdsRef.current), SCHEDULE_POLL_LIVE_MS, projectsKnown && liveIds.length > 0);

  const handleComposerDraftsChange = (changes: DraftChanges) => {
    const drafts = mergeDraftChanges(settingsRef.current.composerDrafts, changes);
    const composerDrafts = Object.fromEntries(
      Object.entries(drafts)
        .filter(([key, draft]) =>
          key.length > 0 &&
          key.length <= 500 &&
          (draft.text.trim() || draft.modelId || draft.variant)
        )
        .slice(-50)
        .map(([key, draft]) => [key, {
          text: draft.text.slice(0, 200_000),
          ...(draft.modelId ? { modelId: draft.modelId } : {}),
          ...(draft.variant ? { variant: draft.variant } : {}),
          updatedAt: draft.updatedAt || Date.now(),
        }])
    );
    if (composerDraftSignature(composerDrafts) === composerDraftSignature(settingsRef.current.composerDrafts)) return;
    handleSettings({ composerDraftChanges: changes }, { preserveActionError: true });
  };

  /**
   * The Sessions tab: the workspace, with the rail and its columns. With nothing open there is
   * nothing to show, so it opens the most recently updated session ("load up the top session").
   */
  /**
   * Back to the workspace, from the Sessions tab or Home's "Back to workspace".
   *
   * Three cases, in order: something is already on screen (just leave Home); sessions are open but
   * every one is **minimized** (restore one - otherwise Home would be a trap, since Home hides the
   * rail and the tab strip); nothing is open at all (load the most recently updated session).
   */
  const showSessions = () => {
    setUsageOpen(false);
    setScheduledOpen(false);
    const open = openSessionsRef.current;
    if (open.length === 0) {
      const top = Object.values(sessionsByInstanceRef.current)
        .flat()
        .filter((session) => !session.archived && session.kind !== 'worker')
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
  };

  const handleSaveNote = (key: string, text: string) => {
    if (!key) return;
    const clean = text.trim().slice(0, 20_000);
    if (!clean) return;
    const current = settingsRef.current.sessionNotes;
    const notes = [...(current[key] ?? []), { id: createNoteId(), text: clean }].slice(-100);
    handleSettings({ sessionNotes: { ...current, [key]: notes } });
  };

  /** Explicit per-message acknowledgement; opening or scrolling never marks a reply read. */
  const handleMarkMessageReadInColumn = (session: Session, message: ChatMessage) => {
    if (!isUnreadEligible(message)) return;
    const key = sessionKey(session);
    const current = settingsRef.current.readMarks[key];
    const ordinal = entryOrdinal(message.id);
    if (ordinal !== null) {
      const digestUnread = visibleUnreadItems(unreadDigests.digests[key], current)
        .map((entry) => entry.ordinal)
        .filter((o): o is number => o !== null);
      const heldMessages =
        messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
      const transcriptUnread = heldMessages
        .filter(
          (m) =>
            isUnreadEligible(m) &&
            !isMessageRead(current, entryOrdinal(m.id), m.completedAt ?? m.createdAt ?? 0)
        )
        .map((m) => entryOrdinal(m.id))
        .filter((o): o is number => o !== null);
      const unread = [...new Set([...digestUnread, ...transcriptUnread])];
      const next = markRead(current, ordinal, unread, Date.now());
      if (next === current) return;
      handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
      return;
    }
    const at = message.completedAt ?? message.createdAt ?? Date.now();
    const next = markTimestampRead(current, at);
    if (next === current) return;
    handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
  };

  /** Muting notifications leaves every explicit read mark intact. */
  const handleQuietChange = (session: Session, quiet: boolean) => {
    const key = sessionKey(session);
    const muted = new Set(settingsRef.current.mutedSessions ?? []);
    if (quiet) muted.add(key);
    else muted.delete(key);
    handleSettings({ mutedSessions: [...muted] }, { preserveActionError: true });
  };

  /** Right-click "Mark all as read": everything the host has, including out-of-order marks. */
  const handleMarkAllRead = (session: Session) => {
    const key = sessionKey(session);
    const current = settingsRef.current.readMarks[key];
    // Hearth reports the newest entry id; a wire without one falls back to the message the digest
    // saw, then to the session's own update time for the timestamp rule.
    const through =
      session.lastEntryId ??
      Math.max(
        0,
        ...visibleUnreadItems(unreadDigests.digests[key], current).map((item) => item.ordinal ?? 0)
      );
    const next = markAllRead(current, through, Date.now());
    if (next === current) return;
    handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
  };

  /** A comment set was sent from a column: the card's summary bar counts it. */
  const handleCommentsSent = (sessionKeyValue: string, count: number) => {
    if (!sessionKeyValue || count <= 0) return;
    const current = settingsRef.current.readMarks[sessionKeyValue];
    const next = addComments(current, count);
    if (next === current) return;
    handleSettings({ readMarks: { ...settingsRef.current.readMarks, [sessionKeyValue]: next } });
  };

  const handleDeleteNote = (key: string, noteId: string) => {
    if (!key) return;
    const current = settingsRef.current.sessionNotes;
    const existing = current[key];
    if (!existing) return;
    const notes = existing.filter((note) => note.id !== noteId);
    const sessionNotes = { ...current };
    if (notes.length) sessionNotes[key] = notes;
    else delete sessionNotes[key];
    handleSettings({ sessionNotes });
  };

  const newSessionInstanceDefaults = newSessionInstanceId ? settings.instanceDefaults[newSessionInstanceId] : undefined;
  const newSessionPrefill = React.useMemo(() => {
    if (!newSessionInstanceId) return null;
    const sessions = sessionsByInstance[newSessionInstanceId] ?? [];
    const defaults = newSessionInstanceDefaults ?? {};
    return {
      directory:
        newSessionDirectory ??
        newSessionDirectoryPrefill(sessions, projectsByInstance[newSessionInstanceId] ?? [], defaults),
      model: newSessionModelPrefill(defaults),
      bypass: defaults.bypass === true,
    };
  }, [newSessionInstanceId, newSessionDirectory, newSessionInstanceDefaults, sessionsByInstance, projectsByInstance]);

  const modelInstanceId = selected?.instanceId ?? newSessionInstanceId;
  const selectedModels = modelInstanceId ? modelsByInstance[modelInstanceId] : undefined;
  const modelInstanceSessions = modelInstanceId ? sessionsByInstance[modelInstanceId] : undefined;
  const recentModels = React.useMemo(
    () => recentModelKeys(modelInstanceSessions ?? []),
    [modelInstanceSessions]
  );
  const recentModelsByInstance = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(sessionsByInstance)) out[id] = recentModelKeys(list);
    return out;
  }, [sessionsByInstance]);
  const selectedPermissions = React.useMemo(() => forSession(permissions, selected), [permissions, selected]);
  const selectedQuestions = React.useMemo(() => forSession(questions, selected), [questions, selected]);

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
      message = `Agent in ${sessionLabel} is waiting for approval.`;
    } else if (selectedQuestions.length > 0) {
      message = `Agent in ${sessionLabel} has a question.`;
    } else if (selectedQueue?.sendingId) {
      message = `Sending a queued message in ${sessionLabel}.`;
    } else if (selectedQueue?.items.length) {
      const count = selectedQueue.items.length;
      message = selectedState === 'active'
        ? `Agent in ${sessionLabel} is working; ${count} ${count === 1 ? 'message is' : 'messages are'} queued.`
        : `${count} queued ${count === 1 ? 'message' : 'messages'} in ${sessionLabel}.`;
    } else if (selectedState === 'active') {
      message = `Agent in ${sessionLabel} is working.`;
    } else if (selectedState === 'error') {
      message = `Agent in ${sessionLabel} stopped with an error.`;
    } else if (selectedState === 'unknown') {
      // Sighted users get the status line under the transcript; without this a screen reader would
      // never learn that the session's status became unknown.
      message = `Status unknown in ${sessionLabel} — the host has not answered.`;
    } else if (
      previous?.key === selectedKey &&
      previous.state === 'active' &&
      selectedState === 'idle'
    ) {
      message = `Agent in ${sessionLabel} finished.`;
    }
    const signature = `${selectedState}:${requestSignature}:${message}`;
    if (previous?.key !== selectedKey || previous.signature !== signature) {
      announceStatus(message);
    }
    lastStatusAnnouncementRef.current = { key: selectedKey, state: selectedState, signature };
  }, [selectedKey, selectedSession, selectedState, selectedPermissions, selectedQuestions, selectedQueue, announceStatus]);

  const sessionByKey = React.useMemo(() => {
    const map = new Map<string, Session>();
    Object.values(sessionsByInstance)
      .flat()
      .forEach((session) => map.set(sessionKey(session), session));
    return map;
  }, [sessionsByInstance]);

  const archiveConfirmSession = archiveConfirmKey ? sessionByKey.get(archiveConfirmKey) ?? null : null;

  // The column the user is working in: whichever they last clicked, focused or scrolled. Before
  // any interaction (or if that session left), the most recently updated visible column stands in
  // using data already in hand — no polling. If timestamps are missing, any non-idle column will do.
  const featuredKey = React.useMemo(() => {
    if (activeSession && columns.includes(activeSession)) return activeSession;
    let best: string | null = null;
    let bestUpdated = -Infinity;
    for (const key of columns) {
      const updated = sessionByKey.get(key)?.updated ?? 0;
      if (updated > bestUpdated) {
        bestUpdated = updated;
        best = key;
      }
    }
    if (best && bestUpdated > 0) return best;
    return (
      columns.find((key) => {
        const state = states[key] ?? 'unknown';
        // Only a *known* busy/blocked/error column is worth featuring; unknown is not a reason.
        return state !== 'idle' && state !== 'unknown';
      }) ??
      columns[0] ??
      null
    );
  }, [activeSession, columns, sessionByKey, states]);

  /** One side-by-side column for an open session, with its own transcript, queue and handlers. */
  const renderColumn = (key: string) => {
    const ref = parseSessionKey(key);
    const session = sessionByKey.get(key);
    if (!ref || !session) return null;
    const instance = instances.find((entry) => entry.id === ref.instanceId) ?? null;
    const transcript = transcripts[key];
    const cached = messageCacheRef.current.get(key);
    const notesKey = notesKeyForSession(session);
    // From state, not `settingsRef`: a ref does not re-render, and the whole point of this prop is
    // that the dot disappears when the mark moves.
    const viewReadMark = readMarks[sessionKey(session)];
    const columnPermissions = permissions.filter(
      (request) => request.instanceId === ref.instanceId && request.sessionId === ref.sessionId
    );
    const columnQuestions = questions.filter(
      (request) => request.instanceId === ref.instanceId && request.sessionId === ref.sessionId
    );
    const models = modelsByInstance[ref.instanceId];
    const policy = autoAcceptByInstance[ref.instanceId];
    const serverAutoAccept = Boolean(policy?.supported);
    const columnBypass = serverAutoAccept
      ? policy?.sessions[ref.sessionId] ?? false
      : bypassOverrides[key] ?? settings.instanceDefaults[ref.instanceId]?.bypass ?? false;
    const target = queueTargetFor(ref, session);
    return (
      <div
        key={key}
        style={{ flexGrow: key === featuredKey ? 1.12 : 1 }}
        className="flex min-h-0 min-w-0 flex-1 basis-0 border-r transition-[flex-grow] duration-200 ease-out last:border-r-0"
        onWheelCapture={() => {
          if (key !== activeSession) activateSession(key);
        }}
      >
        <ChatView
          session={session}
          instance={instance}
          active={key === featuredKey}
          instanceMarkerColor={instanceMarkerColor(ref.instanceId, settings.instanceDefaults[ref.instanceId])}
          newSessionInstanceId={null}
          newSessionPrefill={null}
          instances={instances}
          mentionNames={mentionNamesFor[ref.instanceId] ?? []}
          projectsByInstance={projectsByInstance}
          seed={key}
          identity={avatarIdentities[key] ?? seedIdentity(key)}
          // The crew strip asks this same map for a worker's identity, so a row's 22px blob and the
          // column's full-size one are the same blob.
          identityFor={(worker) => avatarIdentities[sessionKey(worker)]}
          resolveDraftIdentity={resolveDraftIdentity}
          state={states[key] ?? 'unknown'}
          mood={moods[key] ?? 'unknown'}
          blobStyle={settings.blobStyle}
          messages={transcript?.messages ?? cached ?? []}
          messagesStatus={transcript?.status ?? (cached ? 'ready' : 'loading')}
          transcriptFailure={transcript?.failure}
          historyComplete={transcript?.historyComplete === true}
          repairHalt={repairHalts[key] ?? null}
          instanceStatus={instance?.status}
          instanceLabel={instance?.label}
          permissions={columnPermissions}
          questions={columnQuestions}
          models={models?.models ?? []}
          onModelsRefresh={() => void refreshModels(ref.instanceId)}
          defaultModelId={models?.defaultModelId ?? null}
          instanceDefaultModelId={effectiveInstanceDefaultModel(settings.instanceDefaults[ref.instanceId], models?.defaultModelId)}
          onSetInstanceDefault={(model) => setInstanceDefaultModel(ref.instanceId, model)}
          recentModels={recentModelKeys(sessionsByInstance[ref.instanceId] ?? [])}
          sending={sendingKeys.has(key)}
          stopping={stoppingKeys.has(key)}
          queue={target.queue}
          reloading={reloadingKeys.has(key)}
          bypass={columnBypass}
          view={viewSettings}
          sessionNotes={settings.sessionNotes[notesKey] ?? []}
          notesKey={notesKey}
          savedComposerDrafts={settings.composerDrafts}
          composerDraftsHydrated={settingsLoaded}
          onComposerDraftsChange={handleComposerDraftsChange}
          onRetryPendingSend={(message) => handleRetryPendingSend(key, message)}
          onDiscardPendingSend={(message) => handleDiscardPendingSend(key, message)}
          onSaveNote={handleSaveNote}
          onDeleteNote={handleDeleteNote}
          onCommentsSent={(count) => handleCommentsSent(key, count)}
          onViewChange={handleSettings}
          onLoadInstructions={loadInstructionsFor}
          onSaveInstructions={saveInstructionsFor}
          onBypassChange={(enabled) => void setYolo(ref, enabled, session.directory)}
          onStopProcesses={handleStopProcesses}
          {...(viewReadMark ? { readMark: viewReadMark } : {})}
          onMarkMessageRead={handleMarkMessageReadInColumn}
          onMarkAllRead={handleMarkAllRead}
          onQuietChange={handleQuietChange}
          notificationsMuted={quietKeys.has(sessionKey(session))}
          processExtensions={processExtensions}
          onExtendProcesses={extendProcesses}
          onNewSessionInstanceChange={() => {}}
          onCreateAndSend={handleCreateAndSend}
          onCancelNewSession={cancelNewAgent}
          onSend={(input, options) =>
            sendTo(ref, session.directory, input, { retainOnFailure: options?.retainOnFailure ?? true })
          }
          onQueue={(input) => queue.queueMessage(input, target)}
          onSendQueued={(itemId) => queue.sendQueuedMessage(itemId, target)}
          onMoveQueued={(itemId, direction) => queue.moveQueued(itemId, direction, target)}
          onRemoveQueued={(itemId) => queue.removeQueued(itemId, target)}
          onReplaceQueued={(request) => queue.replaceQueued(request, target)}
          onRetryQueued={(itemId) => queue.retryQueued(itemId, target)}
          onDiscardQueued={(itemId) => queue.discardQueued(itemId, target)}
          onReload={() => void handleReloadSession(session)}
          onAbort={() => void handleAbort(session)}
          onPermission={handlePermission}
          onQuestion={handleQuestion}
          compacting={compactingKeys.has(key) || session.compacting === true}
          onCompact={() => void handleCompact(session)}
          askingSideQuestion={askingSideQuestionKeys.has(key)}
          onAskSideQuestion={
            isPiInstance(session.instanceId)
              ? (question) => handleAskSideQuestion(session, question)
              : undefined
          }
          onMinimize={() => minimizeSession(key)}
          onActivate={() => activateSession(key)}
          // The picker's "Add providers…" opens the host's own Providers screen. Which endpoint is
          // being configured is a property of that screen, so the id comes along.
          onOpenProviders={(instanceId) => {
            setProviderEndpointId(instanceId);
            setSettingsView('providers');
            setSettingsActivated(true);
            setSettingsOpen(true);
          }}
          onArchive={session.kind === 'worker' ? undefined : () => requestArchive(session)}
          onRename={(title) => void handleRenameSession(session, title)}
          crew={crewWorkers.get(key) ?? []}
          threadTargets={threadDescendants(session, crewWorkers)}
          crewCost={crewCostByKey.get(key)}
          nestedBlocked={blockedCrewByLeader.get(key) ?? []}
          workerState={(worker) => states[sessionKey(worker)] ?? 'unknown'}
          workerAutoAccept={(worker) =>
            Boolean(autoAcceptByInstance[worker.instanceId]?.sessions[worker.id] ?? false)
          }
          onOpenWorker={(worker) =>
            openSession({ instanceId: worker.instanceId, sessionId: worker.id }, worker)
          }
          onToggleWorkerYolo={(worker, enabled) =>
            void setYolo({ instanceId: worker.instanceId, sessionId: worker.id }, enabled, worker.directory)
          }
          // A worker's summary does not carry `kind`, so the title on its *own* summary cannot
          // decide this. The leader's crew list can: a conversation that appears in one is a worker,
          // and that is also the role the crew strip already draws for it.
          onPromote={
            !session.promotedTo &&
            (session.kind === 'worker' || crewWorkers.get(key)?.some((worker) => worker.id === session.id))
              ? () => setPromoteTarget(session)
              : undefined
          }
          workerPeer={(worker) =>
            worker.promotedTo
              ? (sessionsByInstance[worker.instanceId] ?? []).find(
                  (entry) => entry.id === worker.promotedTo
                ) ?? null
              : null
          }
        />
      </div>
    );
  };

  const updateVisible =
    availableUpdate?.updateAvailable &&
    availableUpdate.latestVersion &&
    availableUpdate.latestVersion !== dismissedUpdateVersion
      ? availableUpdate
      : null;

  // Error + notice + update toasts. They render inline at the very top of the window, next to the
  // search button, and action notices/errors self-dismiss.
  const feedbackBanner =
    actionError || actionNotice || updateVisible ? (
      <>
        {updateVisible && updateVisible.latestVersion ? (
          <div
            role="status"
            data-testid="update-available-notice"
            className="animate-in fade-in flex h-7 min-w-0 items-center gap-2 rounded-full border border-highlight/40 bg-popover px-2.5 text-[11.5px] shadow-sm"
          >
            <span className="min-w-0 truncate" title={formatUpdateNotice(updateVisible.latestVersion)}>
              {formatUpdateNotice(updateVisible.latestVersion)}
            </span>
            <button
              type="button"
              className="shrink-0 rounded font-medium text-highlight hover:underline focus-visible:outline-2"
              onClick={() => void window.ember.openExternal(updateVisible.releaseUrl)}
            >
              View release
            </button>
            <button
              type="button"
              className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
              onClick={() => setDismissedUpdateVersion(updateVisible.latestVersion)}
              aria-label="Dismiss update notice"
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {actionError ? (
          <div
            role="alert"
            className="animate-in fade-in flex h-7 min-w-0 items-center gap-2 rounded-full border border-destructive/40 bg-popover px-2.5 text-[11.5px] shadow-sm"
          >
            <span className="min-w-0 max-w-[44ch] truncate" title={actionError}>
              {actionError}
            </span>
            {actionErrorRetry ? (
              <button
                type="button"
                className="shrink-0 rounded font-medium text-highlight hover:underline focus-visible:outline-2"
                onClick={() => actionErrorRetry()}
                aria-label={actionErrorRetryLabel ?? 'Retry failed action'}
              >
                {actionErrorRetryLabel ?? 'Retry'}
              </button>
            ) : null}
            <button
              type="button"
              className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
              onClick={() => {
                void copyText(actionError).then((copied) => setErrorCopied(copied));
              }}
              aria-label="Copy error message"
            >
              {errorCopied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
              onClick={() => showActionError(null)}
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {actionNotice ? (
          <div
            role="status"
            aria-live="polite"
            onFocusCapture={() => setNoticePaused(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setNoticePaused(false);
              }
            }}
            onPointerEnter={() => setNoticePaused(true)}
            onPointerLeave={() => setNoticePaused(false)}
            className="animate-in fade-in flex h-7 min-w-0 items-center gap-2 rounded-full border border-highlight/35 bg-popover px-2.5 text-[11.5px] shadow-sm"
          >
            {/* 60ch, not 44: a notice that says why ("nothing to compact — the recent turns already
                fit") loses its point when the clause after the dash is the part that gets clipped. */}
            <span className="min-w-0 max-w-[min(60ch,55vw)] truncate" title={actionNotice.message}>
              {actionNotice.message}
            </span>
            {actionNotice.actionLabel && actionNotice.action ? (
              <button
                type="button"
                className="shrink-0 rounded font-medium text-highlight hover:underline focus-visible:outline-2"
                onClick={() => {
                  const action = actionNotice.action;
                  setActionNotice(null);
                  action?.();
                }}
              >
                {actionNotice.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2"
              onClick={() => setActionNotice(null)}
              // "Close", not "Dismiss": a notice can now report that something *was* dismissed,
              // and two buttons saying "dismiss" beside each other would read as the same act.
              aria-label="Close message"
            >
              Close
            </button>
          </div>
        ) : null}
      </>
    ) : null;

  return (
    <AvatarSizeContext.Provider value={settings.blobSize}>
    <ImageViewerContext.Provider value={imageViewerApi}>
    <MotionConfig reducedMotion="user">
    <WorkspaceConnection activeKey={!newSessionInstanceId && !usageOpen && !scheduledOpen ? selectedKey : null} color={blobColor(settings.blobStyle, selectedIdentity)}>
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full flex-col">
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {statusAnnouncement}
          </div>
          <InstanceBar
            instances={instances}
            hidden={hidden}
            live={liveInstances}
            refreshing={refreshing}
            banner={feedbackBanner}
            onToggle={toggleInstance}
            // Forget = hide, permanently. It is not a delete: an OpenChamber host lives in
            // OpenChamber's own settings file, which Ember must not rewrite, and a Hearth endpoint
            // has its own Remove in Settings → Endpoints. What this fixes is that a host which can
            // never answer again had no way out of this menu at all.
            onForget={forgetInstance}
            onToggleNavigation={() => setMobileRailOpen((open) => !open)}
            mobileNavigationOpen={mobileRailOpen}
            railMode={settings.railMode}
            onCycleRailMode={cycleRailMode}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
            onRefresh={() => void refreshInstances()}
            onShowSessions={showSessions}
            onShowUsage={() => {
              setScheduledOpen(false);
              setUsageOpen(true);
            }}
            usageActive={usageOpen}
            onShowScheduled={() => {
              setUsageOpen(false);
              setScheduledOpen(true);
            }}
            scheduledActive={scheduledOpen}
            unseenScheduledRuns={unseenScheduledRunsCount}
            hideNavigation={usageOpen || scheduledOpen}
            onOpenSettings={() => {
              setProviderEndpointId(undefined);
              setSettingsView('instances');
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
              onRenameSession={(session, title) => void handleRenameSession(session, title)}
              mode={settings.railMode}
              instances={instances}
              groups={settings.sessionGroups}
              onOpenGroup={openGroup}
              onUngroup={ungroupGroup}
              onManageGroup={setGroupDraft}
              projectsByInstance={railProjectsByInstance}
              instanceDefaults={settings.instanceDefaults}
              sessions={sessions}
              everySession={everySession}
              moods={moods}
              previews={previews}
              selectedKey={selectedKey}
              selectedSession={selectedSession}
              avatarIdentities={avatarIdentities}
              blobStyle={settings.blobStyle}
              compact={settings.compactRail}
              loading={loading}
              startupMessage={startupMessage}
              silentInstances={silentInstancesList}
              onRetryInstances={() => void refreshInstances()}
              onDismissOutage={dismissOutage}
              retryingInstances={refreshing}
              mobileOpen={mobileRailOpen}
              reloadingKeys={reloadingKeys}
              archivingKeys={archivingKeys}
              visibleColumnKeys={columnKeySet}
              windowLabel={
                SESSION_WINDOWS.find((option) => option.hours === sessionWindowHours && option.hours > 0)
                  ?.label ?? null
              }
              scheduledTaskBySession={scheduledTaskBySession}
              runningScheduledKeys={runningScheduledKeys}
              onRunScheduledTask={(task) => void handleRunScheduledTask(task)}
              onChangeScheduledTaskModel={handleChangeScheduledTaskModel}
              onOpenArchive={() => setArchiveOpen(true)}
              onSelectSession={(session) => {
                if (session.archived) void handleRestoreAndOpen(session);
                else openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                setMobileRailOpen(false);
              }}
              onOpenProject={(instanceId, project, projectSessions) => {
                openProject(instanceId, project, projectSessions);
                setMobileRailOpen(false);
              }}
              onOpenSession={(session) => {
                openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                setMobileRailOpen(false);
              }}
              onReload={(session) => void handleReloadSession(session)}
              onArchive={(session, archived) => void handleArchive(session, archived)}
              onArchiveMany={(sessions) => void handleArchiveMany(sessions, true)}
              onCustomizeAppearance={setAvatarPickerSession}
              onMarkAllRead={handleMarkAllRead}
              unreadKeys={unreadKeys}
              quietKeys={quietKeys}
              onQuietChange={handleQuietChange}
              onNewAgent={(instanceId, directory) => {
                beginNewAgent(instanceId, directory);
                setMobileRailOpen(false);
              }}
              onOpenSettings={() => {
                setMobileRailOpen(false);
                setProviderEndpointId(undefined);
                setSettingsView('general');
                setSettingsActivated(true);
                setSettingsOpen(true);
              }}
            />
            ) : null}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div ref={workspaceRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {scheduledOpen ? (
                <React.Suspense fallback={null}>
                  <ScheduledView
                    tasks={scheduledTaskList}
                    runs={scheduledRuns}
                    instances={instances}
                    silentInstances={silentInstancesList}
                    runningTaskKeys={runningScheduledKeys}
                    onOpenSession={(session) => {
                      if (session.archived) void handleRestoreAndOpen(session);
                      else openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                    }}
                    onRunTask={(task) => void handleRunScheduledTask(task)}
                    onChangeTaskModel={handleChangeScheduledTaskModel}
                    onRetryInstances={() => void refreshInstances()}
                    retryingInstances={refreshing}
                  />
                </React.Suspense>
              ) : usageOpen ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background px-4 py-3">
                  <React.Suspense fallback={null}>
                    <ModelUsagePanel instances={instances} modelsByInstance={modelsByInstance} />
                  </React.Suspense>
                </div>
              ) : newSessionInstanceId || columns.length === 0 ? (
                <ChatView
                  session={null}
                  instance={selectedInstance}
                  instanceMarkerColor={undefined}
                  newSessionInstanceId={newSessionInstanceId}
                  newSessionPrefill={newSessionPrefill}
                  recentDirectories={recentProjectDirectories(sessionsByInstance[newSessionInstanceId ?? ''] ?? [])}
                  workspaceDirectory={newSessionInstanceId ? settings.instanceDefaults[newSessionInstanceId]?.workspaceDirectory : undefined}
                  onWorkspaceChange={(id, directory) => handleSettings({ instanceDefaults: { ...settings.instanceDefaults, [id]: { ...settings.instanceDefaults[id], workspaceDirectory: directory } } })}
                  instances={instances}
                  projectsByInstance={projectsByInstance}
                  seed={selectedKey ?? (newSessionInstanceId ? `new:${newSessionInstanceId}` : '')}
                  identity={selectedIdentity}
                  resolveDraftIdentity={resolveDraftIdentity}
                  state="idle"
                  mood={selectedMood}
                  blobStyle={settings.blobStyle}
                  messages={[]}
                  messagesStatus="ready"
                  permissions={[]}
                  questions={[]}
                  models={selectedModels?.models ?? []}
                  onModelsRefresh={() => { if (newSessionInstanceId) void refreshModels(newSessionInstanceId); }}
                  defaultModelId={selectedModels?.defaultModelId ?? null}
                  instanceDefaultModelId={effectiveInstanceDefaultModel(modelInstanceId ? settings.instanceDefaults[modelInstanceId] : undefined, selectedModels?.defaultModelId)}
                  onSetInstanceDefault={modelInstanceId ? (model) => setInstanceDefaultModel(modelInstanceId, model) : undefined}
                  recentModels={recentModels}
                  sending={draftPendingCreate?.phase === 'creating'}
                  pendingCreate={draftPendingCreate}
                  onRetryCreate={handleRetryCreate}
                  onEditCreate={handleEditCreate}
                  onSaveDraftNote={(text) => {
                    if (draftPendingCreate) handleSaveDraftNote(draftPendingCreate.id, text);
                  }}
                  queue={null}
                  reloading={false}
                  bypass={false}
                  view={viewSettings}
                  sessionNotes={[]}
                  notesKey=""
                  savedComposerDrafts={settings.composerDrafts}
                  composerDraftsHydrated={settingsLoaded}
                  onComposerDraftsChange={handleComposerDraftsChange}
                  onSaveNote={handleSaveNote}
                  onDeleteNote={handleDeleteNote}
                  onViewChange={handleSettings}
                  onLoadInstructions={loadInstructionsFor}
                  onSaveInstructions={saveInstructionsFor}
                  onBypassChange={() => {}}
                  onNewSessionInstanceChange={(instanceId) => {
                    setNewSessionInstanceId(instanceId);
                    setNewSessionDirectory(null);
                  }}
                  onCreateAndSend={handleCreateAndSend}
                  onCancelNewSession={cancelNewAgent}
                  onSend={handleSend}
                  onQueue={async () => false}
                  onSendQueued={async () => false}
                  onMoveQueued={async () => false}
                  onRemoveQueued={async () => false}
                  onReplaceQueued={async () => false}
                  onRetryQueued={async () => false}
                  onDiscardQueued={() => false}
                  onReload={() => {}}
                  onAbort={() => {}}
                  onPermission={handlePermission}
                  onQuestion={handleQuestion}
                  compacting={false}
                  onCompact={() => {}}
                />
              ) : (
                columns.map(renderColumn)
              )}
              </div>
            </div>
          </div>

          <React.Suspense fallback={null}>
            <CommandPalette
              open={commandPaletteOpen}
              historyIncomplete={Object.values(historyIncomplete).some(Boolean)}
              loadingHistory={loadingHistory}
              onLoadHistory={() => {
                setLoadingHistory(true);
                void refreshSessions(readyIds, true).finally(() => setLoadingHistory(false));
              }}
              sessions={allSessions}
              states={states}
              instances={instances}
              projectsByInstance={projectsByInstance}
              sessionNotes={settings.sessionNotes}
              onOpenChange={setCommandPaletteOpen}
              onSelectSession={(session) => {
                if (session.archived) void handleRestoreAndOpen(session);
                else openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                setMobileRailOpen(false);
              }}
              onNewAgent={(instanceId) => {
                beginNewAgent(instanceId);
                setMobileRailOpen(false);
              }}
            />
          </React.Suspense>

          {archiveConfirmSession ? (
            <ArchiveSessionDialog
              session={archiveConfirmSession}
              crewCount={
                archiveConfirmKey ? (crewWorkers.get(archiveConfirmKey) ?? []).length : 0
              }
              statusUnknown={archiveConfirmKey ? moods[archiveConfirmKey] === 'unknown' : false}
              instanceLabel={
                instances.find((entry) => entry.id === archiveConfirmSession.instanceId)?.label
              }
              onCancel={() => setArchiveConfirmKey(null)}
              onConfirm={() => {
                const confirmed = archiveConfirmSession;
                setArchiveConfirmKey(null);
                void handleArchive(confirmed, true);
              }}
            />
          ) : null}

          {promoteTarget ? (
            <PromoteWorkerDialog
              worker={promoteTarget}
              busy={(states[sessionKey(promoteTarget)] ?? 'unknown') === 'active'}
              onCancel={() => setPromoteTarget(null)}
              onConfirm={(input) => {
                const worker = promoteTarget;
                setPromoteTarget(null);
                void handlePromoteWorker(worker, input);
              }}
            />
          ) : null}

          {archiveOpen ? (
            <React.Suspense fallback={<DialogFallback label="Loading archive…" />}>
              <ArchiveDialog
                open
                onOpenChange={setArchiveOpen}
                sessions={archivedSessions}
                projectsByInstance={projectsByInstance}
                instances={instances}
                moods={moods}
                previews={previews}
                avatarIdentities={avatarIdentities}
                blobStyle={settings.blobStyle}
                instanceDefaults={settings.instanceDefaults}
                reloadingKeys={reloadingKeys}
                archivingKeys={archivingKeys}
                onRestoreSession={(session) => void handleRestoreAndOpen(session)}
                onReload={(session) => void handleReloadSession(session)}
                onArchive={(session, archived) => void handleArchive(session, archived)}
                onCustomizeAppearance={setAvatarPickerSession}
              />
            </React.Suspense>
          ) : null}

          {settingsActivated ? (
            <React.Suspense fallback={<DialogFallback label="Loading settings…" />}>
              <SettingsPanel
                open={settingsOpen}
                view={settingsView}
                settings={settings}
                instances={instances}
                projectsByInstance={projectsByInstance}
                modelsByInstance={modelsByInstance}
                recentModelsByInstance={recentModelsByInstance}
                onChange={handleSettings}
                onOpenChange={setSettingsOpen}
                onViewChange={(next) => {
                  // Leaving the Providers screen clears the host it was opened for, so a later open
                  // from Settings → Instances does not silently configure the last session's host.
                  if (next !== 'providers') setProviderEndpointId(undefined);
                  setSettingsView(next);
                }}
                {...(providerEndpointId ? { providerEndpointId } : {})}
                onRefreshInstances={() => void refreshInstances()}
                onRefreshModels={(id) => void refreshModels(id)}
              />
            </React.Suspense>
          ) : null}

          {onboardingOpen ? (
            <React.Suspense fallback={null}>
              <OnboardingWizard
                instanceDefaults={settings.instanceDefaults}
                open={onboardingOpen}
                startAtWelcome={Boolean(settings.onboardingStartedAt)}
                state={onboardingState}
                models={modelsByInstance[onboardingState.targetInstanceId ?? ""]?.models ?? []}
                onRefreshModels={(id) => void refreshModels(id)}
                localProblem={onboardingProblem}
                instances={instances}
                endpoints={settings.piEndpoints}
                onDismiss={dismissOnboarding}
                onRetryLocal={async () => {
                  try {
                    await window.ember.retryLocalHarness?.();
                    await refreshInstances();
                    const stored = await refreshHarnessSettings();
                    if (stored.localHarnessState?.notice) showActionError(stored.localHarnessState.notice);
                  } catch {
                    showActionError('Ember could not retry Kiln. Reopen the setup guide and select Retry again.');
                  }
                }}
                onRefreshInstances={() => void refreshInstances()}
                onChange={handleSettings}
                onStartAgent={({ instanceId, directory }) => {
                  handleSettings({ onboardingDismissedAt: Date.now() }, { preserveActionError: true });
                  beginNewAgent(instanceId, directory ?? undefined);
                }}
                {...(window.ember.localHarnessToken
                  ? { loadToken: window.ember.localHarnessToken }
                  : {})}
              />
            </React.Suspense>
          ) : null}

          {groupDraft ? (
            <ManageGroupDialog
              open
              draft={groupDraft}
              sessions={everySession}
              instances={instances}
              onOpenChange={(open) => {
                if (!open) setGroupDraft(null);
              }}
              onSave={saveGroup}
              onUngroup={ungroupGroup}
            />
          ) : null}


          {avatarPickerSession ? (
            <React.Suspense fallback={<DialogFallback label="Loading appearance…" />}>
              <AvatarPicker
                open
                title={avatarPickerSession.title ?? avatarPickerSession.id}
                style={settings.blobStyle}
                theme={settings.theme}
                resolvePreview={(scopeKey, override) => resolveAvatarIdentity(
                  avatarPickerSession,
                  projectsByInstance[avatarPickerSession.instanceId] ?? [],
                  settings.scheduledSessionBindings,
                  { ...settings.avatarOverrides, [scopeKey]: override }
                )}
                identity={avatarPickerIdentity}
                scopes={avatarPickerScopes}
                overrides={settings.avatarOverrides}
                onSave={handleAvatarOverride}
                onOpenChange={(open) => {
                  if (!open) setAvatarPickerSession(null);
                }}
              />
            </React.Suspense>
          ) : null}

          {scheduledModelTarget ? (
            <React.Suspense fallback={null}>
              <ModelPicker
                open
                models={modelsByInstance[scheduledModelTarget.instanceId]?.models ?? []}
                recentModels={recentModelsByInstance[scheduledModelTarget.instanceId] ?? []}
                value={scheduledModelTarget.model ? modelRefKey(scheduledModelTarget.model) : ''}
                variant={scheduledModelTarget.model?.variant ?? ''}
                defaultModelId={modelsByInstance[scheduledModelTarget.instanceId]?.defaultModelId ?? null}
                instanceDefaultModelId={effectiveInstanceDefaultModel(settings.instanceDefaults[scheduledModelTarget.instanceId], modelsByInstance[scheduledModelTarget.instanceId]?.defaultModelId)}
                onSetInstanceDefault={(model) => setInstanceDefaultModel(scheduledModelTarget.instanceId, model)}
                collapseProviders
                onSelect={(key, variant) => void handleScheduledModelSelect(scheduledModelTarget, key, variant)}
                onOpenChange={(open) => {
                  if (!open) setScheduledModelTarget(null);
                }}
              />
            </React.Suspense>
          ) : null}

        </div>
      </TooltipProvider>
    </WorkspaceConnection>
    </MotionConfig>
    {imageViewer ? (
      <React.Suspense fallback={null}>
        <ImageViewer
          images={imageViewer.images}
          index={imageViewer.index}
          onIndex={(index) => setImageViewer((current) => (current ? { ...current, index } : current))}
          onClose={() => setImageViewer(null)}
        />
      </React.Suspense>
    ) : null}
    </ImageViewerContext.Provider>
    </AvatarSizeContext.Provider>
  );
}
