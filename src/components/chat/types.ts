import type { PromptInput } from '../../api';
import type { AnnotationGuard } from '../../lib/annotationNavigation';
import type { DraftChanges } from '@/lib/composerDrafts';
import type { ThreadRow } from '../../lib/crew';
import type { CrewCostState } from '../../lib/crewCost';
import type { DelegatorChoices } from '../../lib/delegatorModels';
import type { ModelPrefill } from '../../lib/newSessionDefaults';
import type { PendingCreate } from '../../lib/pendingCreate';
import type { ProjectUsage } from '../../lib/projectUsage';
import type { QueueReplaceRequest } from '@/lib/queueMerge';
import type { QuoteAnchor, QuoteLink } from '@/lib/quoteLinks';
import type { RepairHalt } from '../../lib/repairBudget';
import type { ThreadQuestion } from '../../lib/threadQuestions';
import type { TranscriptFailureSource } from '../../lib/transcriptStatus';
import type {
  AvatarIdentity,
  BallMood,
  BallState,
  BlobStyle,
  ChatMessage,
  DraftAppearance,
  Instance,
  InstanceStatus,
  MessageQueueSession,
  MessagesStatus,
  ModelOption,
  NewSessionOptions,
  PermissionReply,
  PermissionRequest,
  Project,
  QuestionAnswers,
  QuestionRequest,
  Session,
  SessionNote,
  SessionReadMark,
  StoredComposerDraft,
  ViewSettings,
  ViewSettingsPatch,
} from '../../types';
import type { StopProcessesResult } from '../SessionProcessesNotice';

export type ChatViewProps = {
  session: Session | null;
  instance: Instance | null;
  instanceMarkerColor?: number;
  newSessionInstanceId: string | null;
  workspaceDirectory?: string;
  recentDirectories?: string[];
  projectUsage?: ProjectUsage[];
  delegatorModels?: Record<string, DelegatorChoices>;
  onDelegatorModelsChange?: (instanceId: string, choices: DelegatorChoices) => void;
  onWorkspaceChange?: (instanceId: string, directory: string) => void;
  newSessionPrefill: { directory: string | null; model: ModelPrefill | null; bypass: boolean } | null;
  instances: Instance[];
  mentionNames?: readonly string[];
  projectsByInstance: Record<string, Project[]>;
  seed: string;
  identity: AvatarIdentity;
  identityFor?: (session: Session) => AvatarIdentity | undefined;
  resolveDraftIdentity: (instanceId: string, directory: string, appearance?: DraftAppearance | null) => AvatarIdentity;
  draftAppearance?: DraftAppearance | null;
  onDraftAppearanceChange?: (appearance: DraftAppearance | null) => void;
  draftAppearanceTheme?: string;
  state: BallState;
  mood: BallMood;
  blobStyle: BlobStyle;
  messages: ChatMessage[];
  messagesStatus: MessagesStatus;
  transcriptFailure?: TranscriptFailureSource;
  historyComplete?: boolean;
  repairHalt?: RepairHalt | null;
  instanceStatus?: InstanceStatus;
  instanceLabel?: string;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  asyncQuestions?: QuestionRequest[];
  threadQuestions?: ThreadQuestion[];
  models: ModelOption[];
  defaultModelId: string | null;
  instanceDefaultModelId?: string | null;
  onSetInstanceDefault?: (model: ModelOption) => void;
  recentModels: string[];
  onModelsRefresh?: (options?: { upstream?: boolean }) => Promise<unknown> | void;
  sending: boolean;
  stopping?: boolean;
  queue: MessageQueueSession | null;
  reloading: boolean;
  bypass: boolean;
  view: ViewSettings;
  sessionNotes: SessionNote[];
  notesKey: string;
  savedComposerDrafts: Record<string, StoredComposerDraft>;
  composerDraftsHydrated: boolean;
  onComposerDraftsChange: (drafts: DraftChanges) => void;
  onRetryPendingSend?: (message: ChatMessage) => void;
  onDiscardPendingSend?: (message: ChatMessage) => void;
  onSaveNote: (sessionKey: string, text: string) => void;
  onUpdateNote: (sessionKey: string, noteId: string, patch: { text?: string; modelId?: string; variant?: string }) => void;
  onDeleteNote: (sessionKey: string, noteId: string) => void;
  focusTarget?: { messageId: string; token: number } | null;
  onAnnotate: (input: PromptInput, source: QuoteAnchor) => Promise<boolean>;
  onSaveAnnotationNote: (text: string, source: QuoteAnchor, requestId?: string) => Promise<boolean>;
  quoteLinks: QuoteLink[];
  onNavigateQuote: (link: QuoteLink, direction: 'source' | 'destination') => void;
  quoteFocus?: QuoteAnchor | null;
  quoteDestinationFocus?: { destination: QuoteLink['destination'] | null; token: number } | null;
  onViewChange: (patch: ViewSettingsPatch) => void;
  onLoadInstructions?: (session: Session) => Promise<{ supported: boolean; instructions?: string }>;
  onSaveInstructions?: (session: Session, instructions: string | null) => Promise<boolean>;
  onBypassChange: (enabled: boolean) => void;
  onStopProcesses?: (session: Session, pids: number[], options: { force?: boolean }) => Promise<StopProcessesResult>;
  readMark?: SessionReadMark;
  onMarkMessageRead?: (session: Session, message: ChatMessage) => void;
  onUndoMarkMessageRead?: (session: Session, message: ChatMessage) => void;
  onMarkMessageUnread?: (session: Session, message: ChatMessage) => void;
  onMarkAllRead?: (session: Session) => void;
  onQuietChange?: (session: Session, quiet: boolean) => void;
  notificationsMuted?: boolean;
  processExtensions?: Readonly<Record<string, number>>;
  onExtendProcesses?: (session: Session) => void;
  onNewSessionInstanceChange: (instanceId: string) => void;
  onCreateAndSend: (options: NewSessionOptions, input: PromptInput) => Promise<boolean>;
  onCancelNewSession: () => void;
  pendingCreate?: PendingCreate | null;
  onRetryCreate?: (pendingId: string, options: NewSessionOptions) => void;
  onEditCreate?: (pendingId: string) => void;
  onSaveDraftNote?: (text: string) => void;
  onSend: (input: PromptInput, options?: { retainOnFailure?: boolean }) => Promise<boolean>;
  onQueue: (input: PromptInput) => Promise<boolean>;
  onSendQueued: (itemId: string) => Promise<boolean>;
  onMoveQueued: (itemId: string, direction: -1 | 1) => Promise<boolean>;
  onRemoveQueued: (itemId: string) => Promise<boolean>;
  onReplaceQueued: (request: QueueReplaceRequest) => Promise<boolean>;
  onRetryQueued: (itemId: string) => Promise<boolean>;
  onDiscardQueued: (itemId: string) => boolean;
  onReload: () => void | Promise<void>;
  onAbort: () => void;
  onPermission: (request: PermissionRequest, reply: PermissionReply) => Promise<boolean>;
  onQuestion: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
  compacting: boolean;
  onCompact: () => void;
  askingSideQuestion?: boolean;
  onAskSideQuestion?: (question: string) => Promise<boolean>;
  onMinimize?: () => void;
  onArchive?: () => void;
  snoozed?: boolean;
  onSnooze?: () => void;
  onNewBotInFolder?: () => void;
  onPromote?: () => void;
  onOpenProviders?: (instanceId: string) => void;
  onRename?: (title: string) => void;
  onActivate?: () => void;
  onBeforeNavigate?: (request: AnnotationGuard | null) => void;
  active?: boolean;
  crew?: Session[];
  threadRows?: ThreadRow[];
  threadTargets?: Session[];
  crewCost?: CrewCostState;
  workerState?: (worker: Session) => BallState;
  workerAutoAcceptByKey?: Readonly<Record<string, boolean>>;
  onOpenWorker?: (worker: Session, messageId?: string) => void;
  workerPeer?: (worker: Session) => Session | null;
  onToggleWorkerYolo?: (worker: Session, enabled: boolean) => void;
};
