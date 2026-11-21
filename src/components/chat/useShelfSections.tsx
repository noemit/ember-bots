import * as React from 'react';
import type { QueueReplaceRequest } from '@/lib/queueMerge';
import type { QuoteLink } from '@/lib/quoteLinks';
import type { ThreadRow } from '../../lib/crew';
import type {
  AvatarIdentity,
  BallState,
  BlobStyle,
  MessageQueueSession,
  ModelOption,
  QuestionAnswers,
  QuestionRequest,
  Session,
  SessionNote,
} from '../../types';
import type { ShelfSection } from '../ComposerShelf';
import CrewStrip from '../CrewStrip';
import QuestionsShelf from '../QuestionsShelf';
import SessionProcessesNotice, {
  processesNeedAttention,
  processesSectionLabel,
  type StopProcessesResult,
} from '../SessionProcessesNotice';

const SessionNotes = React.lazy(() => import('../SessionNotes'));
const QueuedMessageList = React.lazy(() => import('../QueuedMessageList'));

type UseShelfSectionsArgs = {
  session: Session | null;
  composerKey: string | null;
  composerLoaded: boolean;
  queue: MessageQueueSession | null;
  queueItems: NonNullable<MessageQueueSession['items']>;
  sessionNotes: SessionNote[];
  notesKey: string;
  destinationQuoteLinks: QuoteLink[];
  quoteDestinationKind: QuoteLink['destination']['kind'] | undefined;
  quoteItemFocus: { id: string; token: number } | null;
  models: ModelOption[];
  modelId: string;
  variant: string;
  defaultModelId: string | null;
  instanceDefaultModelId?: string | null;
  recentModels: string[];
  instanceLabel?: string;
  blobStyle: BlobStyle;
  identity: AvatarIdentity;
  identityFor?: (session: Session) => AvatarIdentity | undefined;
  threadRows: ThreadRow[];
  threadStatus: { summary: string; detail?: string; total: number };
  crewNeedsInput: boolean;
  workerState?: (worker: Session) => BallState;
  workerAutoAcceptByKey?: Readonly<Record<string, boolean>>;
  workerPeer?: (worker: Session) => Session | null;
  onOpenWorker?: (worker: Session, messageId?: string) => void;
  onToggleWorkerYolo?: (worker: Session, enabled: boolean) => void;
  asyncQuestions: QuestionRequest[];
  asyncQuestionRootCount: number;
  asyncQuestionsAlert: boolean;
  questionComposer: {
    activeKey: string | null;
    answerModeOpen: boolean;
    historyOpen: boolean;
    openQuestion: (request: QuestionRequest) => void;
    handleMutationSuccess: (action: 'answer' | 'context' | 'withdraw', key: string) => void;
    setHistoryOpen: (open: boolean) => void;
  };
  processExtensionFor: (target: Session) => number;
  onSetInstanceDefault?: (model: ModelOption) => void;
  onModelsRefresh?: (options?: { upstream?: boolean }) => Promise<unknown> | void;
  onSendQueued: (itemId: string) => Promise<boolean>;
  onMoveQueued: (itemId: string, direction: -1 | 1) => Promise<boolean>;
  onRemoveQueued: (itemId: string) => Promise<boolean>;
  onReplaceQueued: (request: QueueReplaceRequest) => Promise<boolean>;
  onRetryQueued: (itemId: string) => Promise<boolean>;
  onDiscardQueued: (itemId: string) => boolean;
  onExtendProcesses?: (session: Session) => void;
  onStopProcesses?: (session: Session, pids: number[], options: { force?: boolean }) => Promise<StopProcessesResult>;
  stableNavigateQuote: (link: QuoteLink, direction: 'source' | 'destination') => void;
  stableParkQueuedItem: (itemId: string) => Promise<boolean>;
  stableSendNote: (note: SessionNote) => Promise<boolean>;
  stableBringBackNote: (note: SessionNote) => void;
  stableUpdateNote: (note: SessionNote, patch: { text?: string; modelId?: string; variant?: string }) => void;
  stableDeleteNote: (note: SessionNote) => void;
  stableExtendProcesses: () => void;
  stableStopProcesses: (pids: number[], options: { force?: boolean }) => Promise<StopProcessesResult>;
  stableQuestion: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
  stableOpenQuestionSource: (request: QuestionRequest) => void;
};

export function useShelfSections({
  session,
  composerKey,
  composerLoaded,
  queue,
  queueItems,
  sessionNotes,
  notesKey,
  destinationQuoteLinks,
  quoteDestinationKind,
  quoteItemFocus,
  models,
  modelId,
  variant,
  defaultModelId,
  instanceDefaultModelId,
  recentModels,
  instanceLabel,
  blobStyle,
  identity,
  identityFor,
  threadRows,
  threadStatus,
  crewNeedsInput,
  workerState,
  workerAutoAcceptByKey,
  workerPeer,
  onOpenWorker,
  onToggleWorkerYolo,
  asyncQuestions,
  asyncQuestionRootCount,
  asyncQuestionsAlert,
  questionComposer,
  processExtensionFor,
  onSetInstanceDefault,
  onModelsRefresh,
  onSendQueued,
  onMoveQueued,
  onRemoveQueued,
  onReplaceQueued,
  onRetryQueued,
  onDiscardQueued,
  onExtendProcesses,
  onStopProcesses,
  stableNavigateQuote,
  stableParkQueuedItem,
  stableSendNote,
  stableBringBackNote,
  stableUpdateNote,
  stableDeleteNote,
  stableExtendProcesses,
  stableStopProcesses,
  stableQuestion,
  stableOpenQuestionSource,
}: UseShelfSectionsArgs): ShelfSection[] {
  return React.useMemo<ShelfSection[]>(() => {
    if (!session) return [];
    const extensionMs = processExtensionFor(session);
    return [
      {
        id: 'queue',
        label: 'Queue',
        count: queueItems.length,
        alert: queueItems.some((item) => Boolean(item.error)),
        content: (
          <React.Suspense fallback={null}>
            <QueuedMessageList
              key={composerKey ?? 'none'}
              queue={queue}
              quoteLinks={destinationQuoteLinks}
              onNavigateQuote={stableNavigateQuote}
              focusItem={quoteDestinationKind === 'queue' ? quoteItemFocus : null}
              models={models}
              instanceId={session.instanceId}
              defaultModelId={defaultModelId}
              instanceDefaultModelId={instanceDefaultModelId}
              onSetInstanceDefault={onSetInstanceDefault}
              onModelsRefresh={onModelsRefresh ? () => onModelsRefresh({ upstream: true }) : undefined}
              onSendQueued={onSendQueued}
              onMoveQueued={onMoveQueued}
              onRemoveQueued={onRemoveQueued}
              onParkQueued={stableParkQueuedItem}
              onReplaceQueued={onReplaceQueued}
              onRetryQueued={onRetryQueued}
              onDiscardQueued={onDiscardQueued}
            />
          </React.Suspense>
        ),
      },
      {
        id: 'notes',
        label: 'For later',
        count: sessionNotes.length,
        content: (
          <React.Suspense fallback={null}>
            <SessionNotes
              key={`notes-${notesKey || 'none'}`}
              notes={sessionNotes}
              quoteLinks={destinationQuoteLinks}
              onNavigateQuote={stableNavigateQuote}
              focusItem={quoteDestinationKind === 'note' ? quoteItemFocus : null}
              canSend={composerLoaded}
              onSend={stableSendNote}
              onBringBack={stableBringBackNote}
              models={models}
              modelValue={modelId}
              modelVariant={variant}
              defaultModelId={defaultModelId}
              instanceDefaultModelId={instanceDefaultModelId}
              recentModels={recentModels}
              onModelsRefresh={onModelsRefresh ? () => onModelsRefresh({ upstream: true }) : undefined}
              onUpdate={stableUpdateNote}
              onDelete={stableDeleteNote}
            />
          </React.Suspense>
        ),
      },
      ...(session.processes && session.processes.count > 0 && onStopProcesses
        ? [
            {
              id: 'processes' as const,
              label: processesSectionLabel,
              count: session.processes.count,
              alert: processesNeedAttention(session.processes, session.hostMemory, extensionMs),
              content: (
                <SessionProcessesNotice
                  key={`processes-${session.instanceId}::${session.id}`}
                  processes={session.processes}
                  {...(session.hostMemory ? { memory: session.hostMemory } : {})}
                  {...(instanceLabel ? { hostLabel: instanceLabel } : {})}
                  extensionMs={extensionMs}
                  {...(onExtendProcesses ? { onExtend: stableExtendProcesses } : {})}
                  onStop={stableStopProcesses}
                />
              ),
            },
          ]
        : []),
      ...(onOpenWorker
        ? [
            {
              id: 'crew' as const,
              label: 'Tasks',
              summary: threadStatus.summary,
              summaryLabel: threadStatus.detail,
              count: threadStatus.total,
              alert: crewNeedsInput,
              content: (
                <>
                  <span className="sr-only" role="status">
                    {threadStatus.detail}
                  </span>
                  <CrewStrip
                    rows={threadRows}
                    onOpenWorker={onOpenWorker}
                    peerFor={workerPeer}
                    blobStyle={blobStyle}
                    stateFor={workerState}
                    autoAcceptByKey={workerAutoAcceptByKey}
                    onToggleYolo={onToggleWorkerYolo}
                    identityFor={identityFor}
                    leaderIdentity={identity}
                    leaderTitle={session.title?.trim() || undefined}
                  />
                </>
              ),
            },
          ]
        : []),
      {
        id: 'questions',
        label: 'Questions',
        count: asyncQuestionRootCount,
        alert: asyncQuestionsAlert,
        content: (
          <QuestionsShelf
            hostLabel={instanceLabel}
            requests={asyncQuestions}
            sessionId={session.id}
            onAnswer={stableQuestion}
            onOpenSource={stableOpenQuestionSource}
            onSelectQuestion={questionComposer.openQuestion}
            onMutationSuccess={questionComposer.handleMutationSuccess}
            activeKey={questionComposer.activeKey}
            answerModeOpen={questionComposer.answerModeOpen}
            historyOpen={questionComposer.historyOpen}
            onHistoryOpenChange={questionComposer.setHistoryOpen}
          />
        ),
      },
    ];
  }, [
    asyncQuestionRootCount,
    asyncQuestions,
    asyncQuestionsAlert,
    blobStyle,
    composerKey,
    composerLoaded,
    crewNeedsInput,
    defaultModelId,
    destinationQuoteLinks,
    identity,
    identityFor,
    instanceDefaultModelId,
    instanceLabel,
    modelId,
    models,
    notesKey,
    onDiscardQueued,
    onExtendProcesses,
    onModelsRefresh,
    onMoveQueued,
    onOpenWorker,
    onRemoveQueued,
    onReplaceQueued,
    onRetryQueued,
    onSendQueued,
    onSetInstanceDefault,
    onStopProcesses,
    onToggleWorkerYolo,
    processExtensionFor,
    questionComposer.activeKey,
    questionComposer.answerModeOpen,
    questionComposer.handleMutationSuccess,
    questionComposer.historyOpen,
    questionComposer.openQuestion,
    questionComposer.setHistoryOpen,
    queue,
    queueItems,
    quoteDestinationKind,
    quoteItemFocus,
    recentModels,
    session,
    sessionNotes,
    stableBringBackNote,
    stableDeleteNote,
    stableExtendProcesses,
    stableNavigateQuote,
    stableOpenQuestionSource,
    stableParkQueuedItem,
    stableQuestion,
    stableSendNote,
    stableStopProcesses,
    stableUpdateNote,
    threadRows,
    threadStatus.detail,
    threadStatus.summary,
    threadStatus.total,
    variant,
    workerAutoAcceptByKey,
    workerPeer,
    workerState,
  ]);
}
