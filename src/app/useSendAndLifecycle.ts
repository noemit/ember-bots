import * as React from 'react';
import {
  abortSession,
  askSideQuestion,
  compactSession,
  createClientMessageId,
  createSession,
  loadAllQuestions,
  loadCompactionStatus,
  loadPermissions,
  loadQuestions,
  loadSessions,
  loadSessionStates,
  loadAllSessions,
  mergePolledSessions,
  promoteSession,
  rejectQuestion,
  removeQueuedMessage,
  renameSession,
  replyPermission,
  replyQuestion,
  runScheduledTask,
  sendPrompt,
  setAutoAccept,
  setSessionArchived,
  setSessionInstructions,
  loadSessionInstructions,
  stopSessionProcesses,
  submissionReceiptOf,
  updateScheduledTaskModel,
  type AutoAcceptPolicy,
  type ModelList,
  type PromptInput,
  type ScheduledTask,
  type SubmissionReceipt,
} from '../api';
import type { StopProcessesResult } from '../components/SessionProcessesNotice';
import type { ActionNotice } from '../hooks/useFeedback';
import { useMessageQueue, type QueueTarget } from '../hooks/useMessageQueue';
import { useProcessReaper } from '../hooks/useProcessReaper';
import type { UnreadDigestState } from '../hooks/useUnreadDigests';
import { recordAnnotationAcceptance } from '../lib/annotationAcceptance';
import { replaceAnnotationDestinations } from '../lib/annotationDestinations';
import { preserveAnnotationEcho } from '../lib/annotationEcho';
import { isAsyncQuestion, questionMutationConfirmed } from '../lib/asyncQuestions';
import { isQuietlyArchivable, sessionStatusAnswer, staleScheduledRuns } from '../lib/bulkArchive';
import {
  compactionFailureMessage,
  compactionLogLine,
  compactionNotice,
  compactionOutcome,
  consumeCompactionFailure,
  forgetCompactionTask,
  rememberCompactionTask,
  watchCompaction,
  type ObservedCompactions,
} from '../lib/compaction';
import { isWorker } from '../lib/crew';
import { newSessionTarget } from '../lib/emptyHome';
import { processesToStopOnHide } from '../lib/hideProcesses';
import { hideElsewhereNote, hideForceStopAsk, hideStopFailure, refusedPids } from '../lib/hideStopCopy';
import type { SilentInstance } from '../lib/instanceHealth';
import { selectedModelError } from '../lib/modelSelection';
import { newSessionFailureText, sessionCreateFailureOf } from '../lib/newSessionFailure';
import {
  addPendingNote,
  createPendingCreate,
  failPendingCreate,
  handOffPendingMessages,
  holdPendingMessage,
  restartPendingCreate,
  settleStagedFollowUps,
  type PendingCreate,
  type PendingFirstSendOutcome,
} from '../lib/pendingCreate';
import { PROCESS_EXTENSION_MS, processKey } from '../lib/processExpiry';
import { nextSessionAfterArchive } from '../lib/projectGroups';
import { promoteFailureText } from '../lib/promoteFailure';
import { createQuoteLinkId } from '../lib/quoteLinks';
import { hasUnreadMessages } from '../lib/sessionUnread';
import { isRemoteBrowser, isRemoteExpired, recordRemoteRefusedSend } from '../lib/remoteLifecycle';
import { classifyFullReadFailure, RepairBudget, type FullReadFailure, type RepairHalt } from '../lib/repairBudget';
import { applyScheduledModelSelection, type ScheduledModelTarget } from '../lib/scheduledView';
import {
  deliveryAfterAcceptance,
  steerAbandoned,
  stopHeldMessage,
  submitOutcomeOf,
  type AbortReceipt,
} from '../lib/sendDelivery';
import { recordSent, type SentLedger } from '../lib/sentLedger';
import { deriveSessionName } from '../lib/sessionNames';
import { firstNamingExchange, renameFor } from '../lib/sessionRenameQueue';
import { SessionTitleWrites, titleSaveFailure } from '../lib/sessionTitleWrites';
import { sessionVisibilityFailure } from '../lib/sessionVisibility';
import { questionKey } from '../lib/threadQuestions';
import { shareValue } from '../lib/structuralSharing';
import type { TranscriptCache } from '../lib/transcriptCache';
import type { TranscriptFailureSource, TranscriptState } from '../lib/transcriptStatus';
import { useStableCallback } from '../lib/useStableCallback';
import { parseSessionKey } from '../lib/workspace';
import { DEFAULT_MODEL, modelRefKey, sessionKey } from '../types';
import type {
  AvatarAssignment,
  AvatarOverride,
  BallMood,
  BallState,
  ChatMessage,
  DraftAppearance,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  MessageQueueSession,
  MessagesStatus,
  NewSessionOptions,
  PermissionReply,
  PermissionRequest,
  Project,
  QuestionAnswers,
  QuestionRequest,
  QuoteAnchor,
  QuoteLink,
  Session,
  SessionRef,
} from '../types';
import { CREATED_SESSION_GRACE_MS, createNoteId, responseError } from './appHelpers';
import type { PendingSendInput } from './useTranscriptStore';
import type { DraftChanges } from '../lib/composerDrafts';

type Options = {
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  projectsByInstanceRef: React.RefObject<Record<string, Project[]>>;
  sessionsByInstance: Record<string, Session[]>;
  setSessionsByInstance: React.Dispatch<React.SetStateAction<Record<string, Session[]>>>;
  sessionsByInstanceRef: React.RefObject<Record<string, Session[]>>;
  statesByInstanceRef: React.RefObject<Record<string, Record<string, BallState>>>;
  setStatesByInstance: React.Dispatch<React.SetStateAction<Record<string, Record<string, BallState>>>>;
  setStateReadAt: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setPermissionsByInstance: React.Dispatch<React.SetStateAction<Record<string, PermissionRequest[]>>>;
  questionsByInstance: Record<string, QuestionRequest[]>;
  setQuestionsByInstance: React.Dispatch<React.SetStateAction<Record<string, QuestionRequest[]>>>;
  queuesByInstance: Record<string, MessageQueueSession[]>;
  setQueuesByInstance: React.Dispatch<React.SetStateAction<Record<string, MessageQueueSession[]>>>;
  queuesRef: React.RefObject<Record<string, MessageQueueSession[]>>;
  modelsByInstance: Record<string, ModelList>;
  autoAcceptByInstance: Record<string, AutoAcceptPolicy>;
  setAutoAcceptByInstance: React.Dispatch<React.SetStateAction<Record<string, AutoAcceptPolicy>>>;
  setBypassOverrides: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setScheduledTasksByKey: React.Dispatch<React.SetStateAction<Record<string, ScheduledTask>>>;
  setRunningScheduledKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setScheduledModelTarget: React.Dispatch<React.SetStateAction<ScheduledModelTarget | null>>;
  setRepairHalts: React.Dispatch<React.SetStateAction<Record<string, RepairHalt>>>;
  transcripts: Record<string, TranscriptState & { messages: ChatMessage[] }>;
  pendingCreates: PendingCreate[];
  setPendingCreates: React.Dispatch<React.SetStateAction<PendingCreate[]>>;
  pendingCreatesRef: React.RefObject<PendingCreate[]>;
  draftPendingId: string | null;
  draftPendingIdRef: React.RefObject<string | null>;
  setDraftPendingId: (id: string | null) => void;
  setDraftAppearance: React.Dispatch<React.SetStateAction<DraftAppearance | null>>;
  setSendingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  reloadingKeys: Set<string>;
  setReloadingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  stoppingKeys: Set<string>;
  setStoppingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  archivingKeys: Set<string>;
  setArchivingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  compactingKeys: Set<string>;
  setCompactingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  askingSideQuestionKeys: Set<string>;
  setAskingSideQuestionKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  activeSession: string | null;
  setActiveSession: React.Dispatch<React.SetStateAction<string | null>>;
  activeSessionRef: React.RefObject<string | null>;
  openSessions: string[];
  openSessionsRef: React.RefObject<string[]>;
  minimizedSessions: Set<string>;
  minimizedKeysRef: React.RefObject<Set<string>>;
  newSessionInstanceId: string | null;
  setNewSessionInstanceId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewSessionDirectory: React.Dispatch<React.SetStateAction<string | null>>;
  usageOpen: boolean;
  setUsageOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setScheduledOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setArchiveOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setArchiveConfirmKey: React.Dispatch<React.SetStateAction<string | null>>;
  setPromoteTarget: React.Dispatch<React.SetStateAction<Session | null>>;
  promoteSubmitting: boolean;
  setPromoteSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setPromoteError: React.Dispatch<React.SetStateAction<string | null>>;
  settings: EmberSettings;
  settingsLoaded: boolean;
  settingsRef: React.RefObject<EmberSettings>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  showActionError: (message: string | null, retry?: () => void, retryLabel?: string, onDismiss?: () => void) => void;
  setActionNotice: (notice: ActionNotice | null) => void;
  announceStatus: (message: string) => void;
  navigateWithAnnotations: (action: () => void) => void;
  openSession: (ref: SessionRef, known?: Session | null) => void;
  closeSession: (key: string) => void;
  beginNewAgent: (instanceId: string, directory?: string) => void;
  hidden: Set<string>;
  readyIds: string[];
  states: Record<string, BallState>;
  statesRef: React.RefObject<Record<string, BallState>>;
  moods: Record<string, BallMood>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  crewWorkers: Map<string, Session[]>;
  selected: SessionRef | null;
  selectedSession: Session | null;
  serverYolo: boolean;
  bypass: boolean;
  sessionByKey: Map<string, Session>;
  unreadDigests: UnreadDigestState;
  pendingAvatars: React.RefObject<Map<string, AvatarAssignment>>;
  avatarReservations: React.RefObject<
    Map<string, { session: Session; assignment: AvatarAssignment; appearance?: AvatarOverride }>
  >;
  allocateFor: (session: Session, arriving?: readonly Session[]) => AvatarAssignment;
  reserveIdentity: (
    session: Session,
    assignment: AvatarAssignment,
    reservationKey?: string,
    appearance?: AvatarOverride
  ) => void;
  saveNewAvatarAssignment: (session: Session, assignment?: AvatarAssignment, appearance?: AvatarOverride) => void;
  pendingOptimisticIds: React.RefObject<Map<string, Set<string>>>;
  pendingSentAt: React.RefObject<Map<string, number>>;
  abortReceipts: React.RefObject<Map<string, AbortReceipt & { at: number }>>;
  sentLedgerRef: React.RefObject<SentLedger>;
  pendingInputs: React.RefObject<Map<string, PendingSendInput>>;
  heldFollowUpsByTriggerId: React.RefObject<Map<string, string[]>>;
  pendingFor: (key: string) => Set<string>;
  releaseOptimistic: (key: string, ids: readonly string[]) => void;
  forgetPendingSend: (key: string, messageId: string) => void;
  messageCacheRef: React.RefObject<TranscriptCache>;
  transcriptsRef: React.RefObject<Record<string, TranscriptState & { messages: ChatMessage[] }>>;
  repairBudget: React.RefObject<RepairBudget>;
  setTranscriptFor: (
    key: string,
    messagesForSession: ChatMessage[],
    status?: MessagesStatus,
    failure?: TranscriptFailureSource
  ) => void;
  updateCachedMessages: (key: string, updater: (messagesForSession: ChatMessage[]) => ChatMessage[]) => void;
  markSessionStepsInterrupted: (instanceId: string, sessionId: string) => void;
  loadAndCommitMessages: (
    ref: SessionRef,
    mode: 'tail' | 'full',
    directory?: string,
    afterCurrent?: boolean
  ) => Promise<void>;
  recordFullReadFailure: (ref: SessionRef, reason: FullReadFailure) => void;
  refreshMessages: (ref: SessionRef, afterCurrent?: boolean) => Promise<void>;
  onReplayMissingSendRef: React.RefObject<((replay: PendingSendInput) => void) | null>;
  readInstances: (refresh?: boolean) => Promise<void>;
  promptHintsFor: (
    instanceIds: string[],
    known: Record<string, Array<{ directory?: string }>>
  ) => Record<string, string[]>;
  pendingCreatedSessions: React.RefObject<Map<string, { session: Session; expiresAt: number }>>;
  prunePendingCreated: (shouldDrop: (pending: { session: Session; expiresAt: number }) => boolean) => void;
  refreshSessions: (instanceIds: string[], deep?: boolean) => Promise<void>;
  refreshAutoAccept: (instanceIds: string[]) => Promise<void>;
  refreshStates: (instanceIds: string[]) => Promise<void>;
  refreshQuestions: (instanceIds: string[]) => Promise<void>;
  refreshQueues: (instanceIds: string[]) => Promise<void>;
  refreshScheduled: (instanceIds: string[]) => Promise<void>;
  refreshPromptsFor: (ids: string[]) => Promise<void>;
  handleSaveNote: (key: string, text: string) => void;
  handleComposerDraftsChange: (changes: DraftChanges) => void;
};

/**
 * Owns pending new-agent creation/adoption, prompt sending & optimistic delivery/steer reclaim,
 * server queue operations, and session/task/instance lifecycle actions (reload, hide/unhide, sweep,
 * abort, compact, side question, promote, permissions, questions, instructions, process reaper, rename).
 */
export function useSendAndLifecycle({
  instances,
  projectsByInstance,
  projectsByInstanceRef,
  sessionsByInstance,
  setSessionsByInstance,
  sessionsByInstanceRef,
  statesByInstanceRef,
  setStatesByInstance,
  setStateReadAt,
  setPermissionsByInstance,
  questionsByInstance,
  setQuestionsByInstance,
  queuesByInstance,
  setQueuesByInstance,
  queuesRef,
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
  activeSessionRef,
  openSessions,
  openSessionsRef,
  minimizedSessions,
  minimizedKeysRef,
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
  openSession,
  closeSession,
  beginNewAgent,
  hidden,
  readyIds,
  states,
  statesRef,
  moods,
  permissions,
  questions,
  crewWorkers,
  selected,
  selectedSession,
  serverYolo,
  bypass,
  sessionByKey,
  unreadDigests,
  pendingAvatars,
  avatarReservations,
  allocateFor,
  reserveIdentity,
  saveNewAvatarAssignment,
  pendingOptimisticIds,
  pendingSentAt,
  abortReceipts,
  sentLedgerRef,
  pendingInputs,
  heldFollowUpsByTriggerId,
  pendingFor,
  releaseOptimistic,
  forgetPendingSend,
  messageCacheRef,
  transcriptsRef,
  repairBudget,
  setTranscriptFor,
  updateCachedMessages,
  markSessionStepsInterrupted,
  loadAndCommitMessages,
  recordFullReadFailure,
  refreshMessages,
  onReplayMissingSendRef,
  readInstances,
  promptHintsFor,
  pendingCreatedSessions,
  prunePendingCreated,
  refreshSessions,
  refreshAutoAccept,
  refreshStates,
  refreshQuestions,
  refreshQueues,
  refreshScheduled,
  refreshPromptsFor,
  handleSaveNote,
  handleComposerDraftsChange,
}: Options) {
  /**
   * The session ids Ember knew when each attempt began.
   *
   * A create whose answer was lost may have happened anyway. Before retrying one, the rail is asked
   * whether a conversation appeared that matches this attempt and was not there at the start; if so
   * it is adopted instead of creating a second empty session. The baseline comes from the list Ember
   * already holds, so the check costs nothing on the happy path.
   */
  const createBaselines = React.useRef(new Map<string, Set<string>>());
  const titleWrites = React.useRef(new SessionTitleWrites());
  const assessedTitles = React.useRef(new Set<string>());
  const observedCompactions = React.useRef<ObservedCompactions>({});
  const bypassReplyIds = React.useRef(new Set<string>());
  const promoteAttemptRef = React.useRef(0);

  const openPromoteDialog = React.useCallback(
    (worker: Session) => {
      promoteAttemptRef.current += 1;
      setPromoteSubmitting(false);
      setPromoteError(null);
      setPromoteTarget(worker);
    },
    [setPromoteError, setPromoteSubmitting, setPromoteTarget]
  );

  const closePromoteDialog = React.useCallback(() => {
    promoteAttemptRef.current += 1;
    setPromoteSubmitting(false);
    setPromoteError(null);
    setPromoteTarget(null);
  }, [setPromoteError, setPromoteSubmitting, setPromoteTarget]);

  const toggleInstance = (instanceId: string) => {
    const current = settingsRef.current.hiddenInstances;
    const next = current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId];
    void handleSettings({ hiddenInstances: next });
  };

  /**
   * One-way hide: the instance leaves the list and stays gone across launches, including the ones
   * that never connect. Restoring is the same menu row's tick box once the host answers again, or
   * Settings → Endpoints for a Hearth host.
   */
  const forgetInstance = (instanceId: string) => {
    const current = settingsRef.current.hiddenInstances;
    if (current.includes(instanceId)) return;
    void handleSettings({ hiddenInstances: [...current, instanceId] });
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
      void handleSettings({ dismissedOutages: [...current, entry.instanceId] });
      setActionNotice({
        message: `No more warnings about ${entry.label}. Reprobe in the Instances menu brings it back.`,
        actionLabel: 'Undo',
        action: () =>
          void handleSettings({
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

  const dismissOnboarding = React.useCallback(() => {
    void handleSettings({ onboardingDismissedAt: Date.now() }, { preserveActionError: true });
    const target = newSessionTarget(instances, hidden);
    if (target) beginNewAgent(target);
  }, [handleSettings, instances, hidden, beginNewAgent]);

  const instanceLabelOf = (instanceId: string): string =>
    instances.find((instance) => instance.id === instanceId)?.label ?? instanceId;

  const queue = useMessageQueue({
    modelsByInstance,
    setQueuesByInstance,
    showActionError,
    refreshQueues,
  });

  /** Queue handlers are built per column; this binds one to its session. */
  const queueTargetFor = (ref: SessionRef, session: Session | null): QueueTarget => ({
    ref,
    session,
    queue:
      (queuesByInstance[ref.instanceId] ?? []).find((entry) => entry.sessionId === ref.sessionId) ??
      null,
    send: (input, previousQueueId) =>
      sendTo(ref, session?.directory, input, {
        onAccepted: previousQueueId
          ? async (receipt) => {
              await handleSettings({
                quoteLinks: replaceAnnotationDestinations(
                  settingsRef.current.quoteLinks,
                  sessionKey(ref),
                  [previousQueueId],
                  receipt
                ),
              });
            }
          : undefined,
      }),
    sendDirectFollowUp: async (input) =>
      (await sendToWithOutcome(ref, session?.directory, input, { retainOnFailure: true })).serverAccepted,
    onPlaced: () => {
      void loadAndCommitMessages(ref, 'full', session?.directory, true);
    },
    onRemoved: async (ids, destination) => {
      await handleSettings({
        quoteLinks: replaceAnnotationDestinations(settingsRef.current.quoteLinks, sessionKey(ref), ids, destination),
      });
    },
  });

  /**
   * Send one message and distinguish `uiHeld` ("the UI holds this message, so the composer may
   * clear") from `serverAccepted` ("the host genuinely accepted the submission, so dependent
   * follow-ups may safely proceed"). With `retainOnFailure: true`, a failed send keeps a failed
   * bubble on screen (`uiHeld: true`) without ever claiming `serverAccepted: true`.
   */
  const sendToWithOutcome = async (
    target: SessionRef,
    directory: string | undefined,
    input: PromptInput,
    options: { retainOnFailure?: boolean; quiet?: boolean; onAccepted?: (receipt: SubmissionReceipt) => Promise<void> } = {}
  ): Promise<PendingFirstSendOutcome> => {
    showActionError(null);
    const { instanceId, sessionId } = target;
    const { model, text, attachments = [], variant } = input;
    const key = sessionKey(target);

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
      if (!options.quiet) showActionError(reason);
    };
    showOptimistic();
    setSendingKeys((prev) => new Set(prev).add(key));

    let accepted = false;
    let annotationLinked = !options.onAccepted;
    let retained = false;

    try {
      const sent = await sendPrompt(instanceId, sessionId, input, directory, optimisticId);
      if (!sent.ok) {
        const reason = responseError(sent.data, 'Message could not be sent.', instanceLabelOf(instanceId));
        if (options.retainOnFailure === true) {
          retained = true;
          failSend(reason);
          return { uiHeld: true, serverAccepted: false, messageId: optimisticId };
        }
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        showActionError(reason, () => void sendTo(target, directory, input));
        return { uiHeld: false, serverAccepted: false, messageId: optimisticId };
      }
      const outcome = submitOutcomeOf(sent.data, { steer: steered });
      if (outcome.kind === 'failed') {
        const reason = outcome.error ?? 'The server refused the message.';
        if (options.retainOnFailure === true) {
          retained = true;
          failSend(reason);
          return { uiHeld: true, serverAccepted: false, messageId: optimisticId };
        }
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        showActionError(reason, () => void sendTo(target, directory, input));
        return { uiHeld: false, serverAccepted: false, messageId: optimisticId };
      }
      accepted = true;
      const receipt = submissionReceiptOf(sent.data, Boolean(isPi), isPi ? undefined : optimisticId);
      let adoptedAnnotationQueue = false;
      if (options.onAccepted && receipt?.kind === 'queue' && outcome.queued && !outcome.steer) {
        queue.adoptQueuedSubmission(target, directory, {
          id: receipt.id,
          text: text.trim(),
          model,
          variant,
          mode: input.mode,
          attachments,
        });
        adoptedAnnotationQueue = true;
        void refreshQueues([instanceId]);
      }
      if (options.onAccepted && receipt && input.requestId && (receipt.kind === 'message' || adoptedAnnotationQueue)) {
        const attempts = [...pendingInputs.current]
          .filter(([, value]) => value.input.requestId === input.requestId && sessionKey(value.target) === key)
          .map(([id]) => id);
        const held = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
        const canonical = receipt.kind === 'message' ? held.find((message) => message.id === receipt.id) : undefined;
        for (const id of attempts) forgetPendingSend(key, id);
        updateCachedMessages(key, (previous) => preserveAnnotationEcho(previous, attempts, receipt, optimistic));
        if (receipt.kind === 'message') {
          if (!canonical || canonical.delivery) {
            pendingFor(key).add(receipt.id);
            pendingSentAt.current.set(receipt.id, createdAt);
            pendingInputs.current.set(receipt.id, { target, directory, input });
          }
          recordSent(sentLedgerRef.current, key, { id: receipt.id, text: text.trim(), at: createdAt });
        }
      }
      if (options.onAccepted) {
        const annotation = await recordAnnotationAcceptance(receipt, options.onAccepted);
        annotationLinked = annotation.kind === 'linked';
        if (annotation.kind === 'missing-receipt') {
          showActionError(
            instanceLabelOf(instanceId) +
              ' did not confirm where this annotation went. Your draft is still here; refresh the conversation before trying again.'
          );
        }
        if (annotation.kind === 'persistence-failed') {
          showActionError(
            'Ember could not save this annotation’s source link. Your draft is retained; retry it to save the link without sending a second copy.'
          );
        }
      }
      const didSteer = outcome.steer;
      const queued = Boolean(isPi) && outcome.queued && !didSteer;
      if (queued) {
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        const submissionId = outcome.submissionId ?? '';
        if (submissionId && !adoptedAnnotationQueue) {
          queue.adoptQueuedSubmission(target, directory, {
            id: submissionId,
            text: text.trim(),
            model,
            variant,
            mode: input.mode,
            attachments,
          });
        }
        void refreshQueues([instanceId]);
        return { uiHeld: annotationLinked, serverAccepted: true, messageId: optimisticId };
      }
      if (didSteer && outcome.queued && outcome.submissionId) {
        const current = pendingInputs.current.get(optimisticId);
        if (current) pendingInputs.current.set(optimisticId, { ...current, submissionId: outcome.submissionId });
        void refreshQueues([instanceId]);
      }
      setDelivery(deliveryAfterAcceptance(outcome));
      const updated = Date.now();
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
      await loadAndCommitMessages({ instanceId, sessionId }, 'full', directory, true);
      return { uiHeld: annotationLinked, serverAccepted: true, messageId: optimisticId };
    } catch (err) {
      console.error('Send failed', err);
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 200)})` : '';
      if (
        !accepted &&
        isRemoteBrowser() &&
        !(err && typeof err === 'object' && 'kind' in err && (err.kind === 'rejected' || err.kind === 'session-expired'))
      ) {
        retained = true;
        setDelivery('unconfirmed');
        if (!options.quiet) {
          showActionError(
            'Ember did not confirm this message. It may already be running. Keep this app open and check the conversation before sending it again.'
          );
        }
        return { uiHeld: !options.onAccepted, serverAccepted: false, messageId: optimisticId };
      }
      if (!accepted) {
        const sessionExpired =
          isRemoteExpired() ||
          Boolean(err && typeof err === 'object' && 'kind' in err && err.kind === 'session-expired');
        if (isRemoteBrowser() && sessionExpired) {
          // RemoteAppBoundary unmounts the transcript synchronously on expiry; keep the refused
          // text in page memory so the locked recovery cover still offers Copy unsent text.
          recordRemoteRefusedSend(optimisticId, input.text);
        }
        const reason = err instanceof Error ? err.message : 'Message could not be sent.';
        if (options.retainOnFailure === true) {
          retained = true;
          failSend(reason);
          return { uiHeld: true, serverAccepted: false, messageId: optimisticId };
        }
        releaseOptimistic(key, [optimisticId]);
        removeOptimistic();
        showActionError(reason, () => void sendTo(target, directory, input));
      } else if (!options.quiet) {
        showActionError(`Message was sent, but the transcript could not be refreshed yet.${detail}`);
      }
      return { uiHeld: accepted && annotationLinked, serverAccepted: accepted, messageId: optimisticId };
    } finally {
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
   * Send one message. The boolean means "the UI now holds this message": placed, queued, or a
   * failed bubble that keeps the text with its own Send again. Only a send that left no trace
   * anywhere returns false, so a composer clears its draft exactly when the message has a home.
   */
  const sendTo = async (
    target: SessionRef,
    directory: string | undefined,
    input: PromptInput,
    options: { retainOnFailure?: boolean; quiet?: boolean; onAccepted?: (receipt: SubmissionReceipt) => Promise<void> } = {}
  ): Promise<boolean> => (await sendToWithOutcome(target, directory, input, options)).uiHeld;

  onReplayMissingSendRef.current = (replay) => {
    void sendTo(replay.target, replay.directory, replay.input, { retainOnFailure: true });
  };

  const handleSend = (
    input: PromptInput,
    options?: { retainOnFailure?: boolean }
  ): Promise<boolean> =>
    selected
      ? sendTo(selected, selectedSession?.directory, input, {
          retainOnFailure: options?.retainOnFailure ?? true,
        })
      : Promise.resolve(false);

  const sendAnnotation = async (
    target: SessionRef,
    directory: string | undefined,
    input: PromptInput,
    source: QuoteAnchor
  ): Promise<boolean> => {
    return sendTo(target, directory, input, {
      retainOnFailure: false,
      onAccepted: async (receipt) => {
        const link: QuoteLink = {
          id: input.requestId ?? createQuoteLinkId(),
          source,
          destination: { kind: receipt.kind, sessionKey: sessionKey(target), id: receipt.id },
        };
        const stored = await handleSettings({
          quoteLinks: [...settingsRef.current.quoteLinks.filter((existing) => existing.id !== link.id), link].slice(-5000),
        });
        if (!stored.quoteLinks.some((entry) => entry.id === link.id)) {
          throw new Error('Annotation link exceeded the saved link limit.');
        }
      },
    });
  };

  // ---- Pending create lifecycle ----

  const mutatePendingCreates = (updater: (previous: PendingCreate[]) => PendingCreate[]) => {
    const next = updater(pendingCreatesRef.current);
    pendingCreatesRef.current = next;
    setPendingCreates(next);
  };

  const pendingCreateById = (id: string | null): PendingCreate | null =>
    id ? pendingCreatesRef.current.find((entry) => entry.id === id) ?? null : null;

  const updatePendingCreate = (id: string, update: (pending: PendingCreate) => PendingCreate) =>
    mutatePendingCreates((previous) => previous.map((entry) => (entry.id === id ? update(entry) : entry)));

  const dropPendingCreate = (id: string) =>
    mutatePendingCreates((previous) => previous.filter((entry) => entry.id !== id));

  const cancelNewAgent = () => {
    const id = draftPendingIdRef.current;
    setDraftAppearance(null);
    if (id) {
      if (pendingCreateById(id)?.phase === 'failed') {
        pendingAvatars.current.delete(id);
        avatarReservations.current.delete(`pending:${id}`);
        createBaselines.current.delete(id);
      }
      mutatePendingCreates((previous) => previous.filter((entry) => !(entry.id === id && entry.phase === 'failed')));
    }
    setDraftPendingId(null);
    setNewSessionInstanceId(null);
    setNewSessionDirectory(null);
  };

  const draftPaneRef = React.useRef({
    pendingId: null as string | null,
    activeSession: null as string | null,
    newSessionInstanceId: null as string | null,
    usageOpen: false,
  });
  draftPaneRef.current = { pendingId: draftPendingId, activeSession, newSessionInstanceId, usageOpen };
  const paneShowsPending = (id: string, instanceId?: string): boolean => {
    const pane = draftPaneRef.current;
    if (pane.pendingId !== id || pane.newSessionInstanceId === null || pane.activeSession || pane.usageOpen) {
      return false;
    }
    return instanceId === undefined || pane.newSessionInstanceId === instanceId;
  };

  /** The name a new conversation gets before the host ever answers. Local, deterministic. */
  const newSessionTitle = (options: NewSessionOptions, input: PromptInput): string =>
    deriveSessionName({
      text: input.text,
      directory: options.directory,
      project:
        (projectsByInstance[options.instanceId] ?? []).find((project) => project.path === options.directory)?.name ??
        undefined,
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
      const sessionExpired =
        isRemoteExpired() ||
        Boolean(err && typeof err === 'object' && 'kind' in err && err.kind === 'session-expired');
      if (isRemoteBrowser() && sessionExpired) {
        for (const msg of pending.messages) {
          recordRemoteRefusedSend(msg.id, msg.input.text);
        }
      }
      failNewSessionCreate(id, err);
      return;
    }
    if (!created) {
      failNewSessionCreate(id, null);
      return;
    }
    handOffPendingCreate(id, created);
  };

  const handOffPendingCreate = (id: string, created: Session) => {
    const pending = pendingCreateById(id);
    if (!pending) return;
    const { options } = pending;
    const session = created;
    saveNewAvatarAssignment(session, pendingAvatars.current.get(id), options.appearance?.override);
    avatarReservations.current.delete(`pending:${id}`);
    const ref = { instanceId: options.instanceId, sessionId: session.id };
    const titleKey = sessionKey(session);
    if (!pendingCreatedSessions.current.has(titleKey)) {
      void handleSettings({
        taskTitleSeeds: Object.fromEntries([
          ...Object.entries(settingsRef.current.taskTitleSeeds ?? {}),
          [titleKey, pending.title],
        ].slice(-2000)),
      });
    }
    const now = Date.now();
    prunePendingCreated((entry) => entry.expiresAt <= now);
    pendingCreatedSessions.current.set(sessionKey(session), {
      session,
      expiresAt: now + CREATED_SESSION_GRACE_MS,
    });
    setSessionsByInstance((prev) => {
      const list = prev[options.instanceId] ?? [];
      if (list.some((entry) => entry.id === session.id)) return prev;
      return { ...prev, [options.instanceId]: [session, ...list] };
    });
    if (settingsRef.current.hiddenInstances.includes(options.instanceId)) {
      void handleSettings({
        hiddenInstances: settingsRef.current.hiddenInstances.filter((entry) => entry !== options.instanceId),
      });
    }
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
    const showing = paneShowsPending(id, options.instanceId);
    const hostLabel = instanceLabelOf(options.instanceId);
    const target = queueTargetFor(ref, session);
    void handOffPendingMessages({
      messages: latest.messages,
      instanceLabel: hostLabel,
      stageFollowUps: (followUps) => queue.stageMessages(followUps, target),
      sendFirst: (input) =>
        sendToWithOutcome(ref, session.directory, input, {
          retainOnFailure: true,
          quiet: showing,
        }),
      flushFollowUp: (localId) => queue.flushStagedMessage(localId, target),
      failFollowUps: (localIds, reason) => queue.failStagedMessages(localIds, target, reason),
      onRetainFailedTrigger: (messageId, stagedIds) => {
        heldFollowUpsByTriggerId.current.set(messageId, [...stagedIds]);
      },
    });
    if (options.bypass) void setYolo(ref, true, session.directory);
    dropPendingCreate(id);
    if (draftPendingIdRef.current === id) {
      setDraftPendingId(null);
      setDraftAppearance(null);
    }
    if (showing) {
      openSession(ref, session);
    } else {
      setActionNotice({
        message: `Started “${latest.title}” on ${hostLabel}.`,
        actionLabel: 'Open',
        action: () => openSession(ref, session),
      });
    }
    createBaselines.current.delete(id);
    pendingAvatars.current.delete(id);
  };

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
      if (existing.phase === 'creating') {
        updatePendingCreate(existing.id, (entry) => holdPendingMessage(entry, message));
        announceStatus('Held. This message will be sent once the session starts.');
        return true;
      }
      updatePendingCreate(existing.id, (entry) =>
        restartPendingCreate(holdPendingMessage(entry, message), options)
      );
      const assignment = pendingAvatars.current.get(existing.id);
      if (assignment) {
        reserveIdentity(
          { id: existing.id, instanceId: options.instanceId, directory: options.directory },
          assignment,
          `pending:${existing.id}`,
          options.appearance?.override
        );
      }
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
    const pendingSession = { id: pending.id, instanceId: options.instanceId, directory: options.directory };
    const assignment = options.appearance?.assignment ?? allocateFor(pendingSession);
    pendingAvatars.current.set(pending.id, assignment);
    reserveIdentity(pendingSession, assignment, `pending:${pending.id}`, options.appearance?.override);
    mutatePendingCreates((previous) => [...previous, pending]);
    createBaselines.current.set(
      pending.id,
      new Set((sessionsByInstanceRef.current[options.instanceId] ?? []).map((entry) => entry.id))
    );
    setDraftPendingId(pending.id);
    void runPendingCreate(pending.id);
    return true;
  };

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
    const assignment = pendingAvatars.current.get(id);
    if (assignment) {
      reserveIdentity(
        { id, instanceId: options.instanceId, directory: options.directory },
        assignment,
        `pending:${id}`,
        options.appearance?.override
      );
    }
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
    setDraftAppearance(pendingCreateById(id)?.options.appearance ?? null);
    avatarReservations.current.delete(`pending:${id}`);
    pendingAvatars.current.delete(id);
    dropPendingCreate(id);
    setDraftPendingId(null);
  };

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

  // ---- Steer reclaim, retry, discard ----

  const reclaimAbandonedSteers = useStableCallback((key: string) => {
    const ids = pendingOptimisticIds.current.get(key);
    if (!ids || ids.size === 0) return;
    const ref = parseSessionKey(key);
    if (!ref) return;
    if (statesRef.current[key] === 'active') return;
    const messages = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
    if (messages.length === 0) return;
    const queued =
      (queuesRef.current[ref.instanceId] ?? []).find((entry) => entry.sessionId === ref.sessionId)?.items ?? [];
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

  const pendingSendKeys = React.useMemo(
    () => [...pendingOptimisticIds.current].filter(([, ids]) => ids.size > 0).map(([key]) => key).join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed from the same state the reclaim watches
    [states, transcripts]
  );
  React.useEffect(() => {
    for (const key of pendingSendKeys.split('|').filter(Boolean)) reclaimAbandonedSteers(key);
  }, [pendingSendKeys, states, transcripts, reclaimAbandonedSteers]);

  const disposePendingSend = (key: string, messageId: string) =>
    updateCachedMessages(key, (previous) => previous.filter((message) => message.id !== messageId));

  /** Send a failed message again, with exactly the input the first attempt used. */
  const handleRetryPendingSend = (key: string, message: ChatMessage) => {
    const stored = pendingInputs.current.get(message.id);
    const waitingFollowUps = heldFollowUpsByTriggerId.current.get(message.id);
    heldFollowUpsByTriggerId.current.delete(message.id);
    forgetPendingSend(key, message.id);
    if (!stored) {
      setActionNotice({ message: 'Removed it. Copy the text out of the transcript to send it again.' });
      updateCachedMessages(key, (previous) => previous.filter((entry) => entry.id !== message.id));
      return;
    }
    disposePendingSend(key, message.id);
    if (waitingFollowUps && waitingFollowUps.length > 0) {
      const session =
        (sessionsByInstanceRef.current[stored.target.instanceId] ?? []).find(
          (entry) => entry.id === stored.target.sessionId
        ) ?? null;
      const target = queueTargetFor(stored.target, session);
      const activeIds = queue.restageMessages(waitingFollowUps, target);
      const hostLabel = instanceLabelOf(stored.target.instanceId);
      void sendToWithOutcome(stored.target, stored.directory, stored.input, { retainOnFailure: true }).then(
        (firstOutcome) =>
          settleStagedFollowUps({
            firstOutcome,
            stagedIds: activeIds,
            instanceLabel: hostLabel,
            flushFollowUp: (localId) => queue.flushStagedMessage(localId, target),
            failFollowUps: (localIds, reason) => queue.failStagedMessages(localIds, target, reason),
            onRetainFailedTrigger: (messageId, stagedIds) => {
              heldFollowUpsByTriggerId.current.set(messageId, [...stagedIds]);
            },
          })
      );
      return;
    }
    void sendTo(stored.target, stored.directory, stored.input, { retainOnFailure: true });
  };

  /**
   * Take back an unsent message.
   */
  const handleDiscardPendingSend = async (key: string, message: ChatMessage) => {
    heldFollowUpsByTriggerId.current.delete(message.id);
    const ref = parseSessionKey(key);
    if (message.delivery === 'queued' && ref) {
      const items =
        (queuesByInstance[ref.instanceId] ?? []).find((entry) => entry.sessionId === ref.sessionId)?.items ?? [];
      const storedSubmissionId = pendingInputs.current.get(message.id)?.submissionId;
      const wanted = message.text.trim();
      const item =
        (storedSubmissionId ? items.find((entry) => entry.id === storedSubmissionId) : undefined) ??
        (wanted.length > 0
          ? items.find((entry) => entry.text.trim() === wanted) ?? null
          : items.find((entry) => entry.mode === 'steer' && entry.text.trim() === '') ??
            items.find((entry) => entry.mode === 'steer') ??
            null);
      const targetItemId = item?.id ?? storedSubmissionId;
      if (!targetItemId) {
        forgetPendingSend(key, message.id);
        disposePendingSend(key, message.id);
        setActionNotice({
          message: 'Removed it here. The host no longer lists it as waiting, so there was nothing left to withdraw.',
        });
        return;
      }
      try {
        const removed = await removeQueuedMessage(ref.instanceId, ref.sessionId, targetItemId);
        void refreshQueues([ref.instanceId]);
        if (removed.ok) {
          forgetPendingSend(key, message.id);
          disposePendingSend(key, message.id);
          setActionNotice({ message: 'Withdrew that message from the host.' });
        } else {
          showActionError(
            `${instanceLabelOf(ref.instanceId)} still holds that message. Try Discard again.`,
            () => void handleDiscardPendingSend(key, message)
          );
        }
      } catch {
        showActionError(
          `${instanceLabelOf(ref.instanceId)} did not answer the discard request. Try Discard again.`,
          () => void handleDiscardPendingSend(key, message)
        );
      }
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

  // ---- Reload, hide/archive, sweep, rename ----

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
      setSessionsByInstance((current) => mergePolledSessions(current, sessionResult.value, [session]));
    }
    if (messageResult.status === 'rejected') {
      setTranscriptFor(key, messageCacheRef.current.get(key) ?? [], 'error', 'reload');
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
      void readInstances().catch(() => {});
      showActionError('Some session data could not be refreshed.', () => void handleReloadSession(session));
    }
    setReloadingKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  /** The second step of the same two-step stop: SIGKILL for what took SIGTERM and stayed. */
  const forceProcessesAfterHide = useStableCallback(
    async function forceProcessesAfterHide(entries: Array<{ session: Session; pids: number[] }>): Promise<void> {
      const failed: Array<{ session: Session; pids: number[] }> = [];
      for (const entry of entries) {
        const answer = await stopSessionProcesses(entry.session.instanceId, entry.session.id, {
          pids: entry.pids,
          force: true,
        }).catch(() => null);
        if (!answer) failed.push(entry);
      }
      if (failed.length > 0) {
        const hostLabel = instances.find((entry) => entry.id === failed[0].session.instanceId)?.label;
        showActionError(hideStopFailure(hostLabel), () => void forceProcessesAfterHide(failed), 'Force stop');
        return;
      }
      showActionError(null);
    }
  );

  const stopProcessesOnHide = useStableCallback(async function stopProcessesOnHide(session: Session): Promise<void> {
    const { targets, elsewhere } = processesToStopOnHide(session, Object.values(sessionsByInstanceRef.current).flat());
    const hostLabel = instances.find((entry) => entry.id === session.instanceId)?.label;
    if (targets.length === 0) {
      if (elsewhere > 0) showActionError(hideElsewhereNote(elsewhere), undefined);
      return;
    }
    const failed: Session[] = [];
    const refused: Array<{ session: Session; pids: number[] }> = [];
    for (const target of targets) {
      const answer = await stopSessionProcesses(target.session.instanceId, target.session.id, {
        pids: target.pids,
      }).catch(() => null);
      if (!answer) {
        failed.push(target.session);
        continue;
      }
      const leftRunning = refusedPids(answer.results);
      if (leftRunning.length > 0) refused.push({ session: target.session, pids: leftRunning });
    }
    const note = elsewhere > 0 ? ` ${hideElsewhereNote(elsewhere)}` : '';
    if (failed.length > 0) {
      showActionError(hideStopFailure(hostLabel) + note, () => {
        void stopProcessesOnHide(session);
      });
      return;
    }
    if (refused.length > 0) {
      const pids = refused.flatMap((entry) => entry.pids);
      showActionError(
        hideForceStopAsk(pids, hostLabel) + note,
        () => {
          void forceProcessesAfterHide(refused);
        },
        'Force stop'
      );
    }
  });

  const handleArchive = async (session: Session, archived: boolean): Promise<boolean> => {
    const key = sessionKey(session);
    if (archivingKeys.has(key)) return false;
    showActionError(null);
    setActionNotice(null);
    setArchivingKeys((current) => new Set(current).add(key));
    try {
      const ok = await setSessionArchived(session, archived);
      if (!ok) {
        showActionError(
          sessionVisibilityFailure(instances.find((entry) => entry.id === session.instanceId)?.label, archived),
          () => void handleArchive(session, archived)
        );
        return false;
      }
      const wasActive = archived && activeSessionRef.current === key;
      const remainingAfterClose = openSessionsRef.current.filter((entry) => entry !== key);
      const nextToOpen =
        wasActive && remainingAfterClose.length === 0 && !newSessionInstanceId
          ? nextSessionAfterArchive(
              session,
              Object.values(sessionsByInstanceRef.current).flat(),
              projectsByInstanceRef.current,
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
      const wasOpen = openSessionsRef.current.includes(key);
      if (archived) {
        closeSession(key);
        if (nextToOpen) {
          openSession({ instanceId: nextToOpen.instanceId, sessionId: nextToOpen.id }, nextToOpen);
        }
      }
      setActionNotice(
        archived
          ? {
              message: 'Session hidden.',
              actionLabel: 'Undo',
              action: () => {
                void (async () => {
                  const unarchived = await handleArchive(session, false);
                  if (unarchived && wasOpen) {
                    openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
                  }
                })();
              },
            }
          : { message: 'Session unhidden.' }
      );
      if (archived) void stopProcessesOnHide(session);
      return true;
    } catch {
      showActionError(
        sessionVisibilityFailure(instances.find((entry) => entry.id === session.instanceId)?.label, archived),
        () => void handleArchive(session, archived)
      );
      return false;
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
  const handleRenameSession = useStableCallback(async (session: Session, title: string) => {
    const next = title.trim();
    const key = sessionKey(session);
    const previous = session.title;
    if (!next || next === previous) return;
    const apply = (value: string | undefined) =>
      setSessionsByInstance((prev) => ({
        ...prev,
        [session.instanceId]: (prev[session.instanceId] ?? []).map((entry) =>
          entry.id === session.id ? { ...entry, title: value, updated: Date.now() } : entry
        ),
      }));
    await titleWrites.current.rename(key, previous, next, {
      apply,
      write: () => renameSession(session, next),
      failed: () => {
        const host = instances.find((entry) => entry.id === session.instanceId)?.label ?? 'The host';
        showActionError(titleSaveFailure(host));
      },
    });
  });

  /** One attempt, including failure: never surprise the human with a delayed retry after restart. */
  const forgetAutomaticTitle = useStableCallback((key: string) => {
    assessedTitles.current.add(key);
    const seeds = { ...settingsRef.current.taskTitleSeeds };
    if (!(key in seeds)) return;
    delete seeds[key];
    void handleSettings({ taskTitleSeeds: seeds });
  });

  const renameByHuman = async (session: Session, title: string) => {
    const key = sessionKey(session);
    forgetAutomaticTitle(key);
    await handleRenameSession(session, title);
  };

  React.useEffect(() => {
    if (!settingsLoaded) return;
    const seeds = settings.taskTitleSeeds ?? {};
    if (Object.keys(seeds).length === 0) return;
    const sessions = Object.values(sessionsByInstance).flat();
    for (const session of sessions) {
      const key = sessionKey(session);
      const seed = seeds[key];
      if (!seed || assessedTitles.current.has(key)) continue;
      if (session.title !== seed || isWorker(session)) {
        forgetAutomaticTitle(key);
        continue;
      }
      const transcript = transcripts[key];
      if (states[key] !== 'idle' || !transcript?.historyComplete) continue;
      const exchange = firstNamingExchange(transcript.messages);
      if (!exchange) continue;
      const name = renameFor(
        {
          key,
          provisional: true,
          expectedTitle: seed,
          currentTitle: session.title,
          kind: session.kind,
          request: exchange.request,
          directory: session.directory,
        },
        exchange.reply,
        sessions.filter((entry) => sessionKey(entry) !== key).map((entry) => entry.title ?? '')
      );
      forgetAutomaticTitle(key);
      if (name && name !== seed) void handleRenameSession(session, name);
    }
  }, [
    settingsLoaded,
    settings.taskTitleSeeds,
    sessionsByInstance,
    states,
    transcripts,
    forgetAutomaticTitle,
    handleRenameSession,
  ]);

  const requestArchive = (session: Session) =>
    navigateWithAnnotations(() => {
      const key = sessionKey(session);
      const ref = parseSessionKey(key);
      if (!ref || session.archived || archivingKeys.has(key)) return;
      const pending =
        !isQuietlyArchivable(sessionStatusAnswer(moods, session)) ||
        permissions.some((entry) => entry.instanceId === ref.instanceId && entry.sessionId === ref.sessionId) ||
        questions.some(
          (entry) => !isAsyncQuestion(entry) && entry.instanceId === ref.instanceId && entry.sessionId === ref.sessionId
        ) ||
        (queuesByInstance[ref.instanceId] ?? []).some(
          (entry) => entry.sessionId === ref.sessionId && entry.items.length > 0
        ) ||
        (crewWorkers.get(key) ?? []).some((worker) => {
          const state = states[sessionKey(worker)] ?? 'unknown';
          return state === 'unknown' || state === 'active' || state === 'needs-input';
        });
      if (pending) setArchiveConfirmKey(key);
      else void handleArchive(session, true);
    });

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
              minimizedKeysRef.current,
              succeededKeys
            )
          : null;
      const now = Date.now();
      const updatedSucceeded = succeeded.map((session) => ({
        ...session,
        archived: archived ? now : undefined,
        updated: now,
      }));
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
      setArchivingKeys((current) => {
        const next = new Set(current);
        targets.forEach((session) => next.delete(sessionKey(session)));
        return next;
      });
      if (failed > 0) {
        showActionError(
          `Ember could not ${archived ? 'hide' : 'unhide'} ${failed} of ${targets.length} sessions on their hosts. Try again from each session’s menu.`
        );
      }
      setActionNotice({
        message:
          archived && notice
            ? notice(succeeded.length)
            : `${archived ? 'Hidden' : 'Unhidden'} ${succeeded.length} session${succeeded.length === 1 ? '' : 's'}.`,
        actionLabel: 'Undo',
        action: () => void handleArchiveMany(updatedSucceeded, !archived),
      });
      return;
    }
    setArchivingKeys((current) => {
      const next = new Set(current);
      targets.forEach((session) => next.delete(sessionKey(session)));
      return next;
    });
    if (failed > 0) {
      showActionError(
        `Ember could not ${archived ? 'hide' : 'unhide'} ${failed} of ${targets.length} sessions on their hosts. Try again from each session’s menu.`
      );
    }
  };

  const sweepAttemptsRef = React.useRef(new Map<string, number>());
  const sweepStaleScheduledRuns = useStableCallback(() => {
    if (!settings.autoArchiveScheduledRuns || archivingKeys.size > 0) return;
    const open = new Set([...openSessions, ...minimizedSessions]);
    const ready = new Set(readyIds);
    const pool = Object.values(sessionsByInstance)
      .flat()
      .filter((session) => ready.has(session.instanceId));
    const now = Date.now();
    const readKeys = new Set(
      pool
        .filter(
          (session) =>
            !hasUnreadMessages(session, settings.readMarks[sessionKey(session)], unreadDigests.digests[sessionKey(session)])
        )
        .map(sessionKey)
    );
    const targets = staleScheduledRuns(pool, settings.scheduledSessionBindings, moods, open, now, readKeys).filter(
      (session) => {
        const key = sessionKey(session);
        const attempted = sweepAttemptsRef.current.get(key) ?? 0;
        if (now - attempted < 5 * 60_000) return false;
        sweepAttemptsRef.current.set(key, now);
        return true;
      }
    );
    if (targets.length > 0) {
      void handleArchiveMany(
        targets,
        true,
        (count) => `Auto-hidden ${count} finished scheduled run${count === 1 ? '' : 's'}.`
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
    const ok = await handleArchive(session, false);
    if (!ok) return;
    openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
    setArchiveOpen(false);
  };

  // ---- Permissions, questions, instructions, processes ----

  const handlePermission = async (request: PermissionRequest, reply: PermissionReply): Promise<boolean> => {
    showActionError(null);
    try {
      const directory =
        request.directory ??
        (sessionsByInstance[request.instanceId] ?? []).find((session) => session.id === request.sessionId)?.directory;
      const ok = await replyPermission(request, reply, directory);
      if (!ok) {
        showActionError('Could not reply to this permission request.', () => void handlePermission(request, reply));
        return false;
      }
      setPermissionsByInstance((prev) => ({
        ...prev,
        [request.instanceId]: (prev[request.instanceId] ?? []).filter((entry) => entry.id !== request.id),
      }));
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

  const autoReplyPermission = useStableCallback(handlePermission);
  React.useEffect(() => {
    const onRulesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; instanceId?: string }>).detail;
      if (!detail?.id || !detail?.instanceId) return;
      const { id, instanceId } = detail;
      setPermissionsByInstance((prev) => ({
        ...prev,
        [instanceId]: (prev[instanceId] ?? []).filter((entry) => entry.id !== id),
      }));
    };
    window.addEventListener('ember:permission-rules-changed', onRulesChanged);
    return () => window.removeEventListener('ember:permission-rules-changed', onRulesChanged);
  }, [setPermissionsByInstance]);
  React.useEffect(() => {
    if (!bypass || !selected || serverYolo) return;
    permissions
      .filter((request) => request.instanceId === selected.instanceId && request.sessionId === selected.sessionId)
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
      [request.instanceId]: (prev[request.instanceId] ?? []).filter(
        (entry) => questionKey(entry) !== questionKey(request)
      ),
    }));

  const handleQuestion = async (request: QuestionRequest, answers: QuestionAnswers | null): Promise<boolean> => {
    showActionError(null);
    const host = instances.find((instance) => instance.id === request.instanceId)?.label || 'The host';
    const source = sessionByKey.get(sessionKey(request))?.title?.trim() || 'this conversation';
    const operation =
      request.mutation?.action === 'context'
        ? 'additional context'
        : request.mutation?.action === 'resume'
          ? 'resume'
          : request.mutation?.action === 'withdraw'
            ? 'withdrawal'
            : answers
              ? 'answer'
              : 'dismissal';
    const failure =
      host +
      ' did not confirm the ' +
      operation +
      ' for ' +
      source +
      '. Your answer is still in the question card; try again there.';
    const confirmReceipt = async () => {
      if (!isAsyncQuestion(request) || !request.mutation) return false;
      const next = await loadAllQuestions(
        [request.instanceId],
        promptHintsFor([request.instanceId], questionsByInstance)
      ).catch(() => ({}) as Record<string, QuestionRequest[]>);
      setQuestionsByInstance((prev) => shareValue(prev, { ...prev, ...next }));
      return questionMutationConfirmed(request, answers, next[request.instanceId] ?? []);
    };
    try {
      const directory = request.directory ?? sessionDirectory(request.instanceId, request.sessionId);
      const ok = answers ? await replyQuestion(request, answers, directory) : await rejectQuestion(request, directory);
      if (!ok) {
        if (await confirmReceipt()) return true;
        if (!isAsyncQuestion(request)) {
          showActionError(failure, () => void handleQuestion(request, answers));
        }
        return false;
      }
      if (!isAsyncQuestion(request)) dropQuestion(request);
      void refreshStates([request.instanceId]);
      void refreshSessions([request.instanceId]);
      if (isAsyncQuestion(request)) await refreshQuestions([request.instanceId]);
      else void refreshQuestions([request.instanceId]);
      return true;
    } catch {
      if (await confirmReceipt()) return true;
      if (!isAsyncQuestion(request)) {
        showActionError(failure, () => void handleQuestion(request, answers));
      }
      return false;
    }
  };

  const loadInstructionsFor = useStableCallback((session: Session) =>
    loadSessionInstructions(session.instanceId, session.id).catch(() => ({ supported: false }))
  );
  const saveInstructionsFor = useStableCallback(async (session: Session, instructions: string | null) => {
    const ok = await setSessionInstructions(session.instanceId, session.id, instructions);
    if (!ok) showActionError('Could not save those instructions. The host refused them.');
    return ok;
  });

  const handleStopProcesses = useStableCallback(
    async (session: Session, pids: number[], options: { force?: boolean }): Promise<StopProcessesResult> => {
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

  const [processExtensions, setProcessExtensions] = React.useState<Record<string, number>>({});
  const extendProcesses = React.useCallback((session: Session) => {
    const key = processKey(session);
    setProcessExtensions((previous) => ({ ...previous, [key]: (previous[key] ?? 0) + PROCESS_EXTENSION_MS }));
  }, []);

  const sessionsWithProcesses = React.useMemo(
    () => Object.values(sessionsByInstance).flat(),
    [sessionsByInstance]
  );
  useProcessReaper({
    sessions: sessionsWithProcesses,
    extensions: processExtensions,
    stop: (session, pids) => handleStopProcesses(session, pids, {}),
  });

  // ---- Abort, compact, side question, promote, scheduled task actions ----

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
    try {
      const aborted = await abortSession(session);
      if (!aborted.ok) {
        restorePrevState();
        showActionError('Could not stop this bot.', () => void handleAbort(session));
        return;
      }
      setStatesByInstance((prev) => ({
        ...prev,
        [session.instanceId]: { ...(prev[session.instanceId] ?? {}), [key]: 'idle' },
      }));
      markSessionStepsInterrupted(session.instanceId, session.id);
      abortReceipts.current.set(key, { ...aborted, at: Date.now() });
      if (aborted.parked > 0) {
        const kept = aborted.parked === 1 ? '1 unsent message' : `${aborted.parked} unsent messages`;
        setActionNotice({
          message: aborted.continuing
            ? 'Stopping the current reply. Waiting messages continue once it has stopped.'
            : `Stopped. The host kept ${kept} — ${aborted.parked === 1 ? 'it is' : 'they are'} still in the queue, waiting for a turn to run.`,
        });
      }
      reclaimAbandonedSteers(key);
      void loadAndCommitMessages(
        { instanceId: session.instanceId, sessionId: session.id },
        'tail',
        session.directory,
        true
      ).catch((err) => {
        console.error('Abort refresh failed', err);
      });
      void refreshQueues([session.instanceId]);
    } catch (err) {
      console.error('Abort refresh failed', err);
      restorePrevState();
      showActionError(err instanceof Error ? err.message : 'Could not stop this bot.', () => void handleAbort(session));
    } finally {
      setStoppingKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const handleCompact = async (session: Session) => {
    const key = sessionKey(session);
    if (compactingKeys.has(key)) return;
    const ref = { instanceId: session.instanceId, sessionId: session.id };
    showActionError(null);
    setCompactingKeys((current) => new Set(current).add(key));
    const entriesBefore = (messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? []).length;
    const previousFailureTaskId = session.compactionFailure?.taskId;
    try {
      const receipt = await compactSession(session);
      if (!receipt.accepted) {
        showActionError('Could not compact this session.', () => void handleCompact(session));
        return;
      }
      if (receipt.taskId !== undefined) {
        observedCompactions.current = rememberCompactionTask(observedCompactions.current, key, receipt.taskId);
      }
      const watched = await watchCompaction({
        taskId: receipt.taskId,
        previousFailureTaskId,
        readTask: (taskId) => loadCompactionStatus(session, taskId),
        readSummary: async () => {
          await refreshSessions([session.instanceId]);
          return (sessionsByInstanceRef.current[session.instanceId] ?? []).find((entry) => entry.id === session.id);
        },
        delay: () => new Promise((resolve) => setTimeout(resolve, 400)),
      });
      const { sawCompacting, error: compactionError } = watched;
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
      const entriesAfter = (messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? []).length;
      const trace = {
        accepted: receipt.accepted,
        sawCompacting,
        taskStatus: watched.taskStatus,
        entriesBefore,
        entriesAfter,
        ...(compactionError ? { error: compactionError } : {}),
      };
      const outcome = compactionOutcome(trace);
      if (outcome === 'failed') {
        if (receipt.taskId === undefined) {
          showActionError(
            compactionFailureMessage(
              compactionError,
              `“${session.title?.trim() || 'Untitled session'}” on ${instanceLabelOf(session.instanceId)}`
            ),
            () => void handleCompact(session)
          );
        } else {
          reportObservedCompactionFailure(session, {
            taskId: receipt.taskId,
            error: compactionError ?? 'Compaction did not finish',
          });
        }
      } else {
        const notice = compactionNotice(outcome);
        if (notice) setActionNotice({ message: notice });
      }
      if (receipt.taskId !== undefined && (outcome === 'landed' || outcome === 'nothing' || outcome === 'aborted')) {
        observedCompactions.current = forgetCompactionTask(observedCompactions.current, key, receipt.taskId);
      }
      void window.ember
        .reportCompaction?.(compactionLogLine(trace, { instanceId: session.instanceId, sessionId: session.id }))
        ?.catch(() => {});
    } catch (err) {
      console.error('Compact failed', err);
      showActionError(err instanceof Error ? err.message : 'Could not compact this session.', () => void handleCompact(session));
    } finally {
      setCompactingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const reportObservedCompactionFailure = useStableCallback(
    (session: Session, failure: { taskId?: number; error?: string } | undefined) => {
      const claimed = consumeCompactionFailure(observedCompactions.current, sessionKey(session), failure);
      observedCompactions.current = claimed.state;
      if (claimed.error) {
        showActionError(
          compactionFailureMessage(
            claimed.error,
            `“${session.title?.trim() || 'Untitled session'}” on ${instanceLabelOf(session.instanceId)}`
          ),
          () => void handleCompact(session)
        );
      }
    }
  );
  React.useEffect(() => {
    for (const list of Object.values(sessionsByInstance)) {
      for (const session of list) reportObservedCompactionFailure(session, session.compactionFailure);
    }
  }, [sessionsByInstance, reportObservedCompactionFailure]);

  const handleAskSideQuestion = async (session: Session, question: string): Promise<boolean> => {
    const key = sessionKey(session);
    if (askingSideQuestionKeys.has(key)) return false;
    showActionError(null);
    setAskingSideQuestionKeys((current) => new Set(current).add(key));
    try {
      const worker = await askSideQuestion(session, question);
      if (!worker) {
        showActionError('Could not ask a side question on this session. Try again.', () =>
          void handleAskSideQuestion(session, question)
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

  const handlePromoteWorker = async (
    worker: Session,
    input: { name: string; description?: string; pinned: boolean }
  ) => {
    if (promoteSubmitting) return;
    const attempt = ++promoteAttemptRef.current;
    const instanceLabel = instances.find((entry) => entry.id === worker.instanceId)?.label ?? 'Kiln';
    showActionError(null);
    setPromoteError(null);
    setPromoteSubmitting(true);
    let peer: Session | null = null;
    try {
      peer = await promoteSession(worker, {
        name: input.name,
        description: input.description,
        pinned: input.pinned,
      });
    } catch (err) {
      if (promoteAttemptRef.current !== attempt) return;
      setPromoteSubmitting(false);
      setPromoteError(
        promoteFailureText({
          failure: sessionCreateFailureOf(err),
          instanceLabel,
          name: input.name,
        })
      );
      return;
    }
    if (promoteAttemptRef.current !== attempt) return;
    if (!peer) {
      setPromoteSubmitting(false);
      setPromoteError(
        `Couldn’t make this bot persistent. ${instanceLabel} didn’t return the new bot — try Make persistent again.`
      );
      return;
    }
    setPromoteSubmitting(false);
    setPromoteError(null);
    setPromoteTarget(null);
    saveNewAvatarAssignment(peer);
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
    await refreshSessions([worker.instanceId]).catch(() => undefined);
    openSession({ instanceId: peer.instanceId, sessionId: peer.id }, peer);
    setActionNotice({ message: `“${input.name}” is persistent now — others can message it by name.` });
  };

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

  /** Update a scheduled plan's configured model without launching an immediate run. */
  const handleChangeScheduledTaskModel = useStableCallback((task: ScheduledTask) =>
    setScheduledModelTarget({ task, runImmediately: false })
  );

  /** Update a scheduled plan's model and immediately launch a retry run ("Change model & run…"). */
  const handleChangeAndRunScheduledTaskModel = useStableCallback((task: ScheduledTask) =>
    setScheduledModelTarget({ task, runImmediately: true })
  );

  const handleScheduledModelSelect = async (target: ScheduledModelTarget, key: string, variant: string) => {
    await applyScheduledModelSelection({
      target,
      key,
      variant,
      models: modelsByInstance[target.task.instanceId],
      updateModel: updateScheduledTaskModel,
      onUpdated: (updated) => setScheduledTasksByKey((prev) => ({ ...prev, [updated.key]: updated })),
      onNotice: (message) => setActionNotice({ message }),
      onError: showActionError,
      onRefreshScheduled: (instanceId) => void refreshScheduled([instanceId]),
      onRunTask: (updated) => void handleRunScheduledTask(updated),
    });
  };

  return {
    queue,
    queueTargetFor,
    sendToWithOutcome,
    sendTo,
    handleSend,
    sendAnnotation,
    cancelNewAgent,
    handleCreateAndSend,
    handleRetryCreate,
    handleEditCreate,
    handleSaveDraftNote,
    draftPendingCreate,
    handleRetryPendingSend,
    handleDiscardPendingSend,
    handleReloadSession,
    handleArchive,
    requestArchive,
    handleArchiveMany,
    handleRestoreAndOpen,
    handleRenameSession,
    renameByHuman,
    handlePermission,
    handleQuestion,
    loadInstructionsFor,
    saveInstructionsFor,
    handleStopProcesses,
    processExtensions,
    extendProcesses,
    handleAbort,
    handleCompact,
    handleAskSideQuestion,
    openPromoteDialog,
    closePromoteDialog,
    handlePromoteWorker,
    setYolo,
    toggleInstance,
    forgetInstance,
    dismissOutage,
    dismissOnboarding,
    handleRunScheduledTask,
    handleChangeScheduledTaskModel,
    handleChangeAndRunScheduledTaskModel,
    handleScheduledModelSelect,
  };
}
