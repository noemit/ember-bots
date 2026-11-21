import type { AutoAcceptPolicy, ModelList, PromptInput } from '../api';
import { seedIdentity } from '../blob/seed';
import { effectiveBlobStyle } from '../blob/styles';
import ChatView from '../components/ChatView';
import type { StopProcessesResult } from '../components/SessionProcessesNotice';
import type { QueueTarget, useMessageQueue } from '../hooks/useMessageQueue';
import type { AnnotationGuard } from '../lib/annotationNavigation';
import { isAsyncQuestion, questionsForSupervisor } from '../lib/asyncQuestions';
import type { DraftChanges } from '../lib/composerDrafts';
import { isWorker, threadDescendants, threadRows, threadSourcesFor } from '../lib/crew';
import type { CrewCostState } from '../lib/crewCost';
import type { DelegatorChoices } from '../lib/delegatorModels';
import { instanceMarkerColor } from '../lib/instanceMarker';
import { effectiveInstanceDefaultModel } from '../lib/instanceDefaultModel';
import { notesKeyForSession } from '../lib/projectGroups';
import type { RepairHalt } from '../lib/repairBudget';
import { questionsFromThreads } from '../lib/threadQuestions';
import type { TranscriptCache } from '../lib/transcriptCache';
import type { TranscriptState } from '../lib/transcriptStatus';
import { parseSessionKey } from '../lib/workspace';
import { isPiInstance } from '../piApi';
import { sessionKey } from '../types';
import type {
  AvatarIdentity,
  BallMood,
  BallState,
  ChatMessage,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  ModelRef,
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
  ViewSettings,
} from '../types';
import type { QuoteNavigationTarget } from './useAnnotationsAndNotes';
import { recentModelKeys } from './appHelpers';

export type SessionColumnSharedProps = {
  instances: Instance[];
  sessionsByInstance: Record<string, Session[]>;
  projectsByInstance: Record<string, Project[]>;
  modelsByInstance: Record<string, ModelList>;
  autoAcceptByInstance: Record<string, AutoAcceptPolicy>;
  bypassOverrides: Record<string, boolean>;
  transcripts: Record<string, TranscriptState & { messages: ChatMessage[] }>;
  messageCacheRef: React.RefObject<TranscriptCache>;
  settings: EmberSettings;
  settingsLoaded: boolean;
  viewSettings: ViewSettings;
  activeSession: string | null;
  featuredKey: string | null;
  sessionByKey: Map<string, Session>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  states: Record<string, BallState>;
  moods: Record<string, BallMood>;
  avatarIdentities: Record<string, AvatarIdentity>;
  resolveDraftIdentity: (instanceId: string, directory: string) => AvatarIdentity;
  mentionNamesFor: Record<string, string[]>;
  crewWorkers: Map<string, Session[]>;
  crewCostByKey: Map<string, CrewCostState>;
  workerKeys: Set<string>;
  quietKeys: Set<string>;
  repairHalts: Record<string, RepairHalt>;
  sendingKeys: Set<string>;
  stoppingKeys: Set<string>;
  reloadingKeys: Set<string>;
  compactingKeys: Set<string>;
  askingSideQuestionKeys: Set<string>;
  processExtensions: Record<string, number>;
  quoteNavigation: QuoteNavigationTarget | null;
  annotationQueueMutations: React.RefObject<Set<string>>;
  annotationNavigationHandlers: React.RefObject<Map<string, AnnotationGuard>>;
  queue: ReturnType<typeof useMessageQueue>;
  queueTargetFor: (ref: SessionRef, session: Session | null) => QueueTarget;
  refreshModels: (instanceId: string, options?: { upstream?: boolean; providers?: readonly string[] }) => Promise<void>;
  setInstanceDefaultModel: (instanceId: string, model: ModelRef) => void;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  rememberDelegatorModels: (instanceId: string, choices: DelegatorChoices) => void;
  handleComposerDraftsChange: (changes: DraftChanges) => void;
  handleRetryPendingSend: (key: string, message: ChatMessage) => void;
  handleDiscardPendingSend: (key: string, message: ChatMessage) => void;
  handleSaveNote: (key: string, text: string) => void;
  handleUpdateNote: (key: string, noteId: string, patch: { text?: string; modelId?: string; variant?: string }) => void;
  handleDeleteNote: (key: string, noteId: string) => void;
  sendAnnotation: (target: SessionRef, directory: string | undefined, input: PromptInput, source: QuoteAnchor) => Promise<boolean>;
  saveAnnotationNote: (key: string, text: string, source: QuoteAnchor, requestId?: string) => Promise<boolean>;
  navigateQuote: (link: QuoteLink, direction: 'source' | 'destination') => void;
  loadInstructionsFor: (session: Session) => Promise<{ supported: boolean; instructions?: string }>;
  saveInstructionsFor: (session: Session, instructions: string | null) => Promise<boolean>;
  setYolo: (ref: SessionRef, enabled: boolean, directory?: string) => Promise<void>;
  handleStopProcesses: (
    session: Session,
    pids: number[],
    options: { force?: boolean }
  ) => Promise<StopProcessesResult>;
  handleMarkMessageReadInColumn: (session: Session, message: ChatMessage) => void;
  handleUndoMarkMessageReadInColumn: (session: Session, message: ChatMessage) => void;
  handleMarkMessageUnreadInColumn: (session: Session, message: ChatMessage) => void;
  handleMarkAllRead: (session: Session) => void;
  handleQuietChange: (session: Session, quiet: boolean) => void;
  extendProcesses: (session: Session) => void;
  handleCreateAndSend: (options: NewSessionOptions, input: PromptInput) => Promise<boolean>;
  cancelNewAgent: () => void;
  sendTo: (
    target: SessionRef,
    directory: string | undefined,
    input: PromptInput,
    options?: { retainOnFailure?: boolean; quiet?: boolean }
  ) => Promise<boolean>;
  handleReloadSession: (session: Session) => Promise<void>;
  handleAbort: (session: Session) => Promise<void>;
  handlePermission: (request: PermissionRequest, reply: PermissionReply) => Promise<boolean>;
  handleQuestion: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
  handleCompact: (session: Session) => Promise<void>;
  handleAskSideQuestion: (session: Session, question: string) => Promise<boolean>;
  minimizeSession: (key: string) => void;
  activateSession: (key: string) => void;
  onOpenProviders: (instanceId: string) => void;
  handleSnooze: (session: Session, snoozed: boolean) => void;
  requestArchive: (session: Session) => void;
  beginNewAgent: (instanceId: string, directory?: string) => void;
  renameByHuman: (session: Session, title: string) => Promise<void>;
  onOpenWorker: (worker: Session, messageId?: string) => void;
  openPromoteDialog: (worker: Session) => void;
};

type Props = SessionColumnSharedProps & {
  columnKey: string;
  modal?: boolean;
};

/**
 * Renders one side-by-side workspace column (or the worker thread inspection modal's column)
 * with its transcript, queue bindings, prompt handlers, and crew controls.
 */
export function SessionColumn({
  columnKey,
  modal = false,
  instances,
  sessionsByInstance,
  projectsByInstance,
  modelsByInstance,
  autoAcceptByInstance,
  bypassOverrides,
  transcripts,
  messageCacheRef,
  settings,
  settingsLoaded,
  viewSettings,
  activeSession,
  featuredKey,
  sessionByKey,
  permissions,
  questions,
  states,
  moods,
  avatarIdentities,
  resolveDraftIdentity,
  mentionNamesFor,
  crewWorkers,
  crewCostByKey,
  workerKeys,
  quietKeys,
  repairHalts,
  sendingKeys,
  stoppingKeys,
  reloadingKeys,
  compactingKeys,
  askingSideQuestionKeys,
  processExtensions,
  quoteNavigation,
  annotationQueueMutations,
  annotationNavigationHandlers,
  queue,
  queueTargetFor,
  refreshModels,
  setInstanceDefaultModel,
  handleSettings,
  rememberDelegatorModels,
  handleComposerDraftsChange,
  handleRetryPendingSend,
  handleDiscardPendingSend,
  handleSaveNote,
  handleUpdateNote,
  handleDeleteNote,
  sendAnnotation,
  saveAnnotationNote,
  navigateQuote,
  loadInstructionsFor,
  saveInstructionsFor,
  setYolo,
  handleStopProcesses,
  handleMarkMessageReadInColumn,
  handleUndoMarkMessageReadInColumn,
  handleMarkMessageUnreadInColumn,
  handleMarkAllRead,
  handleQuietChange,
  extendProcesses,
  handleCreateAndSend,
  cancelNewAgent,
  sendTo,
  handleReloadSession,
  handleAbort,
  handlePermission,
  handleQuestion,
  handleCompact,
  handleAskSideQuestion,
  minimizeSession,
  activateSession,
  onOpenProviders,
  handleSnooze,
  requestArchive,
  beginNewAgent,
  renameByHuman,
  onOpenWorker,
  openPromoteDialog,
}: Props) {
  const ref = parseSessionKey(columnKey);
  const session = sessionByKey.get(columnKey);
  if (!ref || !session) return null;
  const instance = instances.find((entry) => entry.id === ref.instanceId) ?? null;
  const transcript = transcripts[columnKey];
  const cached = messageCacheRef.current.get(columnKey);
  const notesKey = notesKeyForSession(session);
  // From state, not `settingsRef`: a ref does not re-render, and the whole point of this prop is
  // that the dot disappears when the mark moves.
  const viewReadMark = settings.readMarks[sessionKey(session)];
  const columnPermissions = permissions.filter(
    (request) => request.instanceId === ref.instanceId && request.sessionId === ref.sessionId
  );
  const columnQuestions = questions.filter(
    (request) => !isAsyncQuestion(request) && request.instanceId === ref.instanceId && request.sessionId === ref.sessionId
  );
  const models = modelsByInstance[ref.instanceId];
  const policy = autoAcceptByInstance[ref.instanceId];
  const serverAutoAccept = Boolean(policy?.supported);
  const columnBypass = serverAutoAccept
    ? policy?.sessions[ref.sessionId] ?? false
    : bypassOverrides[columnKey] ?? settings.instanceDefaults[ref.instanceId]?.bypass ?? false;
  const target = queueTargetFor(ref, session);

  return (
    <div
      style={{ flexGrow: columnKey === featuredKey ? 1.12 : 1 }}
      className="flex min-h-0 min-w-0 flex-1 basis-0 border-r transition-[flex-grow] duration-200 ease-out last:border-r-0"
      onWheelCapture={() => {
        if (!modal && columnKey !== activeSession) activateSession(columnKey);
      }}
    >
      <ChatView
        session={session}
        instance={instance}
        active={modal || columnKey === featuredKey}
        instanceMarkerColor={instanceMarkerColor(ref.instanceId, settings.instanceDefaults[ref.instanceId])}
        newSessionInstanceId={null}
        newSessionPrefill={null}
        instances={instances}
        mentionNames={mentionNamesFor[ref.instanceId] ?? []}
        projectsByInstance={projectsByInstance}
        seed={columnKey}
        identity={avatarIdentities[columnKey] ?? seedIdentity(columnKey)}
        // The crew strip asks this same map for a worker's identity, so a row's 22px blob and the
        // column's full-size one are the same blob.
        identityFor={(worker) => avatarIdentities[sessionKey(worker)]}
        resolveDraftIdentity={resolveDraftIdentity}
        state={states[columnKey] ?? 'unknown'}
        mood={moods[columnKey] ?? 'unknown'}
        blobStyle={effectiveBlobStyle(settings.blobStyle)}
        messages={transcript?.messages ?? cached ?? []}
        messagesStatus={transcript?.status ?? (cached ? 'ready' : 'loading')}
        transcriptFailure={transcript?.failure}
        historyComplete={transcript?.historyComplete === true}
        repairHalt={repairHalts[columnKey] ?? null}
        instanceStatus={instance?.status}
        instanceLabel={instance?.label}
        permissions={columnPermissions}
        questions={columnQuestions}
        asyncQuestions={questionsForSupervisor(session, questions)}
        threadQuestions={questionsFromThreads(
          threadDescendants(session, crewWorkers),
          questions.filter((request) => !isAsyncQuestion(request))
        )}
        models={models?.models ?? []}
        onModelsRefresh={(options) => refreshModels(ref.instanceId, options)}
        defaultModelId={models?.defaultModelId ?? null}
        instanceDefaultModelId={effectiveInstanceDefaultModel(
          settings.instanceDefaults[ref.instanceId],
          models?.defaultModelId
        )}
        onSetInstanceDefault={(model) => setInstanceDefaultModel(ref.instanceId, model)}
        recentModels={recentModelKeys(sessionsByInstance[ref.instanceId] ?? [])}
        sending={sendingKeys.has(columnKey)}
        stopping={stoppingKeys.has(columnKey)}
        queue={target.queue}
        reloading={reloadingKeys.has(columnKey)}
        bypass={columnBypass}
        view={viewSettings}
        sessionNotes={settings.sessionNotes[notesKey] ?? []}
        notesKey={notesKey}
        savedComposerDrafts={settings.composerDrafts}
        composerDraftsHydrated={settingsLoaded}
        onComposerDraftsChange={handleComposerDraftsChange}
        onRetryPendingSend={(message) => handleRetryPendingSend(columnKey, message)}
        onDiscardPendingSend={(message) => handleDiscardPendingSend(columnKey, message)}
        onSaveNote={handleSaveNote}
        onUpdateNote={handleUpdateNote}
        onDeleteNote={handleDeleteNote}
        quoteLinks={settings.quoteLinks.filter(
          (link) => link.source.sessionKey === columnKey || link.destination.sessionKey === columnKey
        )}
        onAnnotate={(input, source) => sendAnnotation(ref, session.directory, input, source)}
        onSaveAnnotationNote={(text, source, requestId) => saveAnnotationNote(notesKey, text, source, requestId)}
        onNavigateQuote={navigateQuote}
        focusTarget={quoteNavigation?.key === columnKey ? quoteNavigation : null}
        quoteFocus={quoteNavigation?.key === columnKey ? quoteNavigation.source : null}
        quoteDestinationFocus={quoteNavigation?.key === columnKey ? quoteNavigation : null}
        onViewChange={handleSettings}
        delegatorModels={settings.delegatorModels}
        onDelegatorModelsChange={rememberDelegatorModels}
        onLoadInstructions={loadInstructionsFor}
        onSaveInstructions={saveInstructionsFor}
        onBypassChange={(enabled) => void setYolo(ref, enabled, session.directory)}
        onStopProcesses={handleStopProcesses}
        // No unread management on a worker: no marks to draw, no control to move them.
        {...(viewReadMark && !workerKeys.has(columnKey) ? { readMark: viewReadMark } : {})}
        {...(workerKeys.has(columnKey)
          ? {}
          : {
              onMarkMessageRead: handleMarkMessageReadInColumn,
              onUndoMarkMessageRead: handleUndoMarkMessageReadInColumn,
              onMarkMessageUnread: handleMarkMessageUnreadInColumn,
              onMarkAllRead: handleMarkAllRead,
              onQuietChange: handleQuietChange,
            })}
        notificationsMuted={quietKeys.has(columnKey)}
        processExtensions={processExtensions}
        onExtendProcesses={extendProcesses}
        onNewSessionInstanceChange={() => {}}
        onCreateAndSend={handleCreateAndSend}
        onCancelNewSession={cancelNewAgent}
        onSend={(input, options) =>
          sendTo(ref, session.directory, input, { retainOnFailure: options?.retainOnFailure ?? true })
        }
        onQueue={(input) => queue.queueMessage(input, target)}
        onSendQueued={async (itemId) => {
          annotationQueueMutations.current.add(columnKey);
          try {
            return await queue.sendQueuedMessage(itemId, target);
          } finally {
            annotationQueueMutations.current.delete(columnKey);
          }
        }}
        onMoveQueued={(itemId, direction) => queue.moveQueued(itemId, direction, target)}
        onRemoveQueued={(itemId) => queue.removeQueued(itemId, target)}
        onReplaceQueued={async (request) => {
          annotationQueueMutations.current.add(columnKey);
          try {
            return await queue.replaceQueued(request, target);
          } finally {
            annotationQueueMutations.current.delete(columnKey);
          }
        }}
        onRetryQueued={(itemId) => queue.retryQueued(itemId, target)}
        onDiscardQueued={(itemId) => queue.discardQueued(itemId, target)}
        onReload={() => handleReloadSession(session)}
        onAbort={() => void handleAbort(session)}
        onPermission={handlePermission}
        onQuestion={handleQuestion}
        compacting={compactingKeys.has(columnKey) || session.compacting === true}
        onCompact={() => void handleCompact(session)}
        askingSideQuestion={askingSideQuestionKeys.has(columnKey)}
        onAskSideQuestion={
          isPiInstance(session.instanceId) ? (question) => handleAskSideQuestion(session, question) : undefined
        }
        onMinimize={modal ? undefined : () => minimizeSession(columnKey)}
        onActivate={modal ? undefined : () => activateSession(columnKey)}
        onBeforeNavigate={(request) => {
          const scope = (modal ? 'thread:' : 'column:') + columnKey;
          if (request) annotationNavigationHandlers.current.set(scope, request);
          else annotationNavigationHandlers.current.delete(scope);
        }}
        onOpenProviders={onOpenProviders}
        snoozed={settings.snoozedSessions.includes(columnKey)}
        onSnooze={
          isWorker(session) ? undefined : () => handleSnooze(session, !settings.snoozedSessions.includes(columnKey))
        }
        onArchive={session.kind === 'worker' ? undefined : () => requestArchive(session)}
        onNewBotInFolder={modal ? undefined : () => beginNewAgent(session.instanceId, session.directory)}
        onRename={(title) => void renameByHuman(session, title)}
        crew={crewWorkers.get(columnKey) ?? []}
        threadRows={threadRows(session, crewWorkers)}
        threadTargets={threadSourcesFor(session, crewWorkers, sessionsByInstance[session.instanceId] ?? [])}
        crewCost={crewCostByKey.get(columnKey)}
        workerState={(worker) => states[sessionKey(worker)] ?? 'unknown'}
        workerAutoAcceptByKey={Object.fromEntries(
          threadDescendants(session, crewWorkers).map((worker) => [
            sessionKey(worker),
            Boolean(autoAcceptByInstance[worker.instanceId]?.sessions[worker.id] ?? false),
          ])
        )}
        onOpenWorker={onOpenWorker}
        onToggleWorkerYolo={(worker, enabled) =>
          void setYolo({ instanceId: worker.instanceId, sessionId: worker.id }, enabled, worker.directory)
        }
        // A worker's summary does not carry `kind`, so the title on its *own* summary cannot
        // decide this. The leader's crew list can: a conversation that appears in one is a worker,
        // and that is also the role the crew strip already draws for it.
        onPromote={
          !session.promotedTo &&
          (isWorker(session) ||
            [...crewWorkers.values()].some((workers) => workers.some((worker) => sessionKey(worker) === columnKey)))
            ? () => openPromoteDialog(session)
            : undefined
        }
        workerPeer={(worker) =>
          worker.promotedTo
            ? (sessionsByInstance[worker.instanceId] ?? []).find((entry) => entry.id === worker.promotedTo) ?? null
            : null
        }
      />
    </div>
  );
}
