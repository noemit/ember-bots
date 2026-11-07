import ComposerIdentity from './ComposerIdentity';
import YoloLabel from './YoloLabel';
import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Box, ChevronDown, CircleDashed, CircleDollarSign, CircleHelp, Eye, Folder, Loader2, MessageCircleQuestion, Minus, NotebookPen, Paperclip, Pencil, RefreshCw, Reply, ShieldAlert, Square, Trash2, UserPlus, X, Zap } from 'lucide-react';
import Blob from '../blob/Blob';
import { blobColor } from '../blob/color';
import { normalizeDirectory } from '../blob/seed';
import { DEFAULT_MODEL, modelRefKey, sessionKey } from '../types';
import type { ModelPrefill } from '../lib/newSessionDefaults';
import type { BlockedWorker } from '../lib/crew';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import type { PromptInput } from '../api';
import { ModelPickerFallback } from './ModelPickerFallback';
import ReasoningLevelPicker from './ReasoningLevelPicker';
import { INSTRUCTION_PRESETS, presetFor, type InstructionPreset } from '../lib/instructionPresets';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { clearComposerText, composerMemory, removedDrafts, type ComposerState, type DraftChanges } from '@/lib/composerDrafts';
import { canonicalVariant, resolveComposerModel } from '@/lib/modelSelection';
import { applyMention, matchMentions, mentionQueryAt, type MentionQuery } from '@/lib/mentions';
import MentionSuggest from './MentionSuggest';
import { isTurnLive } from '@/lib/turnActivity';
import { shortcutLabel } from '@/lib/shortcuts';
import type { QueueReplaceRequest } from '@/lib/queueMerge';
import { useStableProps } from '@/lib/useStableProps';
import { useStableCallback } from '@/lib/useStableCallback';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  AvatarIdentity,
  BallState,
  BallMood,
  BlobStyle,
  ChatMessage,
  FileAttachment,
  Instance,
  InstanceStatus,
  MessagesStatus,
  MessageQueueSession,
  ModelOption,
  NewSessionOptions,
  Project,
  PermissionReply,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  Session,
  SessionNote,
  SessionReadMark,
  StoredComposerDraft,
  ViewSettings,
  ViewSettingsPatch,
} from '../types';
import { isSettledFailure, transcriptNotice, type TranscriptFailureSource } from '../lib/transcriptStatus';
import type { RepairHalt } from '../lib/repairBudget';
import ContextMeter from './ContextMeter';
import { contextMeterState } from '../lib/contextMeter';
import { COST_UNKNOWN_LABEL, COST_UNKNOWN_TITLE, hostReportsCost, sessionCostState } from '../lib/sessionCost';
import { crewCostLabel, crewCostTitle, type CrewCostState } from '../lib/crewCost';
import ViewMenu from './ViewMenu';
import CrewStrip from './CrewStrip';
import CommentTray from './CommentTray';
import ComposerShelf, { type ShelfSectionId } from './ComposerShelf';
import SessionProcessesNotice, {
  processesNeedAttention,
  processesSectionLabel,
  type StopProcessesResult,
} from './SessionProcessesNotice';
import SelectionCommentBar from './SelectionCommentBar';
import { processKey } from '../lib/processExpiry';
import { commentMemory, composeCommentMessage, normaliseSelection, type TranscriptComment } from '@/lib/comments';
import { useSelectionComments } from '@/hooks/useSelectionComments';
import { pendingCreateComposerText, pendingCreateMessages, type PendingCreate } from '../lib/pendingCreate';

const loadModelPicker = () => import('./ModelPicker');
const ModelPicker = React.lazy(loadModelPicker);
const Transcript = React.lazy(() => import('./Transcript'));
const SessionNotes = React.lazy(() => import('./SessionNotes'));
const ProjectPicker = React.lazy(() => import('./ProjectPicker'));
const QueuedMessageList = React.lazy(() => import('./QueuedMessageList'));

const TranscriptFallback = () => (
  <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground" role="status">
    Loading conversation…
  </div>
);

/**
 * YEET mode is a per-composer preference, so it is remembered per composer key rather than in
 * app settings: steering one agent says nothing about the next. Reads are defensive — a
 * throwaway localStorage value must not break the composer.
 */
const YEET_KEY = 'ember.composer.yeet';
const readYeet = (key: string | null | undefined): boolean => {
  if (!key) return false;
  try {
    return window.localStorage.getItem(`${YEET_KEY}:${key}`) === '1';
  } catch {
    return false;
  }
};
const writeYeet = (key: string | null | undefined, enabled: boolean): void => {
  if (!key) return;
  try {
    const storageKey = `${YEET_KEY}:${key}`;
    if (enabled) window.localStorage.setItem(storageKey, '1');
    else window.localStorage.removeItem(storageKey);
  } catch {
    // storage unavailable: the toggle still works for this session
  }
};

type Props = {
  session: Session | null;
  instance: Instance | null;
  instanceMarkerColor?: number;
  newSessionInstanceId: string | null;
  workspaceDirectory?: string;
  recentDirectories?: string[];
  onWorkspaceChange?: (instanceId: string, directory: string) => void;
  /** Prefill for a new-agent draft: last-used or default folder, model and YOLO on that instance. */
  newSessionPrefill: { directory: string | null; model: ModelPrefill | null; bypass: boolean } | null;
  instances: Instance[];
  /** Session titles the composer may tag with `@`; empty disables mentions. */
  mentionNames?: readonly string[];
  projectsByInstance: Record<string, Project[]>;
  seed: string;
  identity: AvatarIdentity;
  /**
   * Resolve any session's blob identity the way the rail resolves it. The crew strip draws a worker
   * at 22px while its column draws the same worker at full size, so both have to ask one question
   * or the two blobs disagree whenever a project colour or an avatar override applies.
   */
  identityFor?: (session: Session) => AvatarIdentity | undefined;
  /** Resolves the blob a new-agent draft will get from its target folder (project colour + override). */
  resolveDraftIdentity: (instanceId: string, directory: string) => AvatarIdentity;
  state: BallState;
  mood: BallMood;
  blobStyle: BlobStyle;
  messages: ChatMessage[];
  messagesStatus: MessagesStatus;
  /** Which path raised `messagesStatus === 'error'`; only an explicit reload is a settled failure. */
  transcriptFailure?: TranscriptFailureSource;
  /** A full read has landed, so nothing above the rendered window is missing. */
  historyComplete?: boolean;
  /**
   * Set when Ember has stopped repairing this session by itself: a full read cannot succeed for it
   * (see `lib/repairBudget`). The missing-history line says so and offers compaction instead of a
   * "Load them" that retries the same doomed request.
   */
  repairHalt?: RepairHalt | null;
  /** The instance's own health, so an absent Hearth reads as "still starting", not "broken session". */
  instanceStatus?: InstanceStatus;
  instanceLabel?: string;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  models: ModelOption[];
  defaultModelId: string | null;
  /** `provider/model` keys the instance used most recently, newest first. */
  recentModels: string[];
  /** Re-read this instance's model catalogue; called when the picker opens so new models appear without a relaunch. */
  onModelsRefresh?: () => void;
  sending: boolean;
  /** True while a stop was requested and the run hasn't reconciled yet. */
  stopping?: boolean;
  queue: MessageQueueSession | null;
  reloading: boolean;
  bypass: boolean;
  view: ViewSettings;
  sessionNotes: SessionNote[];
  /** Settings key the notes are stored under; project sessions share one across the project. */
  notesKey: string;
  savedComposerDrafts: Record<string, StoredComposerDraft>;
  composerDraftsHydrated: boolean;
  onComposerDraftsChange: (drafts: DraftChanges) => void;
  /** Send an unconfirmed message again, with the input the first attempt used. */
  onRetryPendingSend?: (message: ChatMessage) => void;
  /** Drop an unconfirmed message from the transcript. */
  onDiscardPendingSend?: (message: ChatMessage) => void;
  onSaveNote: (sessionKey: string, text: string) => void;
  onDeleteNote: (sessionKey: string, noteId: string) => void;
  /**
   * A message this column should open on (Home's link context bars). The token makes a repeat
   * request for the same message still count, so clicking the same link twice works.
   */
  focusTarget?: { messageId: string; token: number } | null;
  /**
   * Bumped when another surface (the reading view) wrote comment drafts for this session's key.
   * The column re-reads the shared memory rather than showing a tray that is missing them.
   */
  commentDraftsVersion?: number;
  /** A comment set was sent: Home's card counts it. Optional so the draft composer can omit it. */
  onCommentsSent?: (count: number) => void;
  onViewChange: (patch: ViewSettingsPatch) => void;
  /** Read a session's standing instructions (Hearth only; resolves `supported: false` elsewhere). */
  onLoadInstructions?: (session: Session) => Promise<{ supported: boolean; instructions?: string }>;
  /** Set them; `null` clears. Resolves false when the host refused. */
  onSaveInstructions?: (session: Session, instructions: string | null) => Promise<boolean>;
  onBypassChange: (enabled: boolean) => void;
  /**
   * Stop programs this session left running on its host (Hearth's `processes`). Absent where the
   * host has no such route, in which case the notice is not drawn at all.
   */
  onStopProcesses?: (session: Session, pids: number[], options: { force?: boolean }) => Promise<StopProcessesResult>;
  /** This session's read mark: which messages are read, and whether it is a quiet session. */
  readMark?: SessionReadMark;
  /** Mark one message read (the dot beside it). Omitted where marking is not offered. */
  onMarkMessageRead?: (session: Session, message: ChatMessage) => void;
  /** Mark the whole session read (the unread navigation bar). */
  onMarkAllRead?: (session: Session) => void;
  /** Set or clear "mark everything read, no notifications" for this session. */
  onQuietChange?: (session: Session, quiet: boolean) => void;
  notificationsMuted?: boolean;
  /**
   * Extra minutes bought for each session's leftovers, keyed `instanceId::id`.
   *
   * Data rather than a lookup function on purpose: `useStableProps` pins function props to their
   * first identity for `React.memo`, so a callback here would serve the extension the app had when
   * the window opened. A map is shared structurally, so a change reaches the tray.
   */
  processExtensions?: Readonly<Record<string, number>>;
  /** Buy another ten minutes for what this session left running. */
  onExtendProcesses?: (session: Session) => void;
  onNewSessionInstanceChange: (instanceId: string) => void;
  /** Draft submit: create the session, then send the first message into it. */
  onCreateAndSend: (options: NewSessionOptions, input: PromptInput) => Promise<boolean>;
  onCancelNewSession: () => void;
  /**
   * The draft's first message while its session is being created, or after the host refused it.
   * App owns it: the create outlives this pane (a person who leaves still gets the session), so its
   * state cannot live in a component that unmounts.
   */
  pendingCreate?: PendingCreate | null;
  /** Try a refused create again, to the destination the draft row shows now. */
  onRetryCreate?: (pendingId: string, options: NewSessionOptions) => void;
  /** Take a refused create's messages back into the composer, to edit and send again. */
  onEditCreate?: (pendingId: string) => void;
  /** Park a note while the session is starting; App moves it under the session's key on success. */
  onSaveDraftNote?: (text: string) => void;
  /**
   * Send one user message. `retainOnFailure` defaults to true (a failed send keeps its bubble so
   * the text has a home); the comment tray passes false, because its own rows already hold the
   * text and must survive a failure.
   */
  onSend: (input: PromptInput, options?: { retainOnFailure?: boolean }) => Promise<boolean>;
  onQueue: (input: PromptInput) => Promise<boolean>;
  onSendQueued: (itemId: string) => Promise<boolean>;
  onMoveQueued: (itemId: string, direction: -1 | 1) => Promise<boolean>;
  onRemoveQueued: (itemId: string) => Promise<boolean>;
  /** Replace queued rows with one item: the queue's edit and merge path. */
  onReplaceQueued: (request: QueueReplaceRequest) => Promise<boolean>;
  onRetryQueued: (itemId: string) => Promise<boolean>;
  onDiscardQueued: (itemId: string) => boolean;
  onReload: () => void;
  onAbort: () => void;
  onPermission: (request: PermissionRequest, reply: PermissionReply) => Promise<boolean>;
  onQuestion: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
  /** True while this session's context is being compacted. */
  compacting: boolean;
  onCompact: () => void;
  /** True while a side question ("btw …") is being forked into a worker. */
  askingSideQuestion?: boolean;
  /** Ask a side question via a forked worker carrying this session's context; omitted when unsupported. */
  onAskSideQuestion?: (question: string) => Promise<boolean>;
  /** Column chrome: collapse this column into the tab strip. */
  onMinimize?: () => void;
  /** Column chrome: archive this session (Undo is offered by the app-level notice). */
  onArchive?: () => void;
  /**
   * Promote this worker to a named peer. Rendered only on an unpromoted
   * worker column; the app opens `PromoteWorkerDialog` and calls Hearth.
   */
  onPromote?: () => void;
  /**
   * Open the Providers screen for this column's host. The model picker offers it when the host has
   * no providers at all, because that is the one state refreshing cannot fix.
   */
  onOpenProviders?: (instanceId: string) => void;
  /** Persist a new session title on its instance (double-click on the header title). */
  onRename?: (title: string) => void;
  /** Called when the user interacts with this column, so the active session follows focus. */
  onActivate?: () => void;
  /** The column the user is working in; inactive columns trim their composer chrome. Defaults true. */
  active?: boolean;
  /** A leader's crew workers; empty or absent for everyone else (they are hidden from the rail). */
  crew?: Session[];
  /**
   * What this session has cost, its crew included (`lib/crewCost`). Absent where there is nothing to
   * add up — a draft, or a caller that has not loaded the siblings — and then the badge falls back to
   * the session's own ledger alone.
   */
  crewCost?: CrewCostState;
  /**
   * Workers below this leader's direct crew that are blocked on the human, at any depth. The strip
   * is the only place a worker is visible, so a sub-agent's question has to be named there too.
   */
  nestedBlocked?: BlockedWorker[];
  /** Coarse ball state per worker, from the instance's status poll. */
  workerState?: (worker: Session) => BallState;
  /** Server-side auto-accept per worker, shown as an `auto` badge in the strip. */
  workerAutoAccept?: (worker: Session) => boolean;
  /** Open a worker as a transient column. */
  onOpenWorker?: (worker: Session) => void;
  /** Resolve a promoted worker's peer session, so the strip row links to the peer fork. */
  workerPeer?: (worker: Session) => Session | null;
  /** Toggle a worker's auto-accept from the strip. */
  onToggleWorkerYolo?: (worker: Session, enabled: boolean) => void;
};


const messageContextText = (message: ChatMessage): string =>
  message.text.trim() ||
  message.parts
    .map((part) => {
      if (part.type === 'reasoning') return part.text;
      if (part.type === 'file') return `File: ${part.file.filename}`;
      if (part.type === 'tool') return `${part.call.tool}: ${part.call.title ?? part.call.output ?? ''}`;
      return part.text;
    })
    .filter(Boolean)
    .join('\n');

/**
 * Attachments travel inline as data URLs, the same shape OpenChamber sends.
 *
 * These are **Hearth's** ceilings, not Ember's own taste: `hearth/src/view.ts` refuses an image over
 * `MAX_IMAGE_BYTES` (12 MB) and `hearth/src/images.ts` refuses a submission whose images total more
 * than `MAX_TOTAL_IMAGE_BYTES` (18 MB, decoded; at most 8 images). Raising these past that would not
 * let anyone attach more — it would only replace Ember's clear "skipped, too large" with a refusal from
 * the host after the whole upload had already gone out.
 *
 * The real cost of a bigger number is the session: an attachment is stored as base64 in the message
 * that carried it, so a 12 MB screenshot adds ~16 MB to that conversation's history for ever. If big
 * images need to work, downscaling them on the way out is the change that helps, not a larger cap.
 */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;
const STALE_AGENT_MS = 10 * 60_000;

const MAX_COMPOSER_DRAFTS = 50;

/** Comment ids only key React rows and edits; nothing about them is ever sent. */
const newCommentId = () => `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const saveComposerDraft = (
  drafts: Map<string, ComposerState>,
  key: string,
  state: ComposerState
) => {
  drafts.delete(key);
  drafts.set(key, state);
  while (drafts.size > MAX_COMPOSER_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (!oldest) break;
    drafts.delete(oldest);
  }
};

const composerFromStored = (draft: StoredComposerDraft): ComposerState => ({
  text: draft.text,
  modelId: draft.modelId ?? DEFAULT_MODEL,
  variant: draft.variant ?? '',
  attachments: [],
  replyContext: null,
});

const storedFromComposer = (state: ComposerState): StoredComposerDraft => {
  const draft: StoredComposerDraft = {
    text: state.text,
    modelId: state.modelId,
    updatedAt: Date.now(),
  };
  if (state.variant) draft.variant = state.variant;
  return draft;
};

export const shouldOfferSessionReload = (
  state: BallState,
  messagesStatus: MessagesStatus,
  sessionUpdated: number | undefined,
  messages: ChatMessage[],
  now: number,
  /**
   * Which path raised the error. Absent means the historical reload shape, which stays a failure.
   * A transient error (`'poll'`, `'tail'`, `'initial'`) is retried on its own, so offering Refresh
   * there just advertises a problem the user did not have.
   */
  transcriptFailure?: TranscriptFailureSource
): boolean => {
  if (messagesStatus === 'error') return isSettledFailure({ status: 'error', failure: transcriptFailure });
  if (state !== 'active') return false;
  const assistantUpdates = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.completedAt ?? message.createdAt ?? 0);
  const lastUpdate = assistantUpdates.length ? Math.max(...assistantUpdates) : sessionUpdated ?? 0;
  return lastUpdate > 0 && now - lastUpdate >= STALE_AGENT_MS;
};

const readAttachment = (file: File): Promise<FileAttachment> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () =>
      resolve({
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        url: String(reader.result),
      });
    reader.readAsDataURL(file);
  });

function ChatView({
  session,
  instance,
  instanceMarkerColor,
  newSessionInstanceId,
  workspaceDirectory,
  recentDirectories,
  onWorkspaceChange,
  newSessionPrefill,
  instances,
  mentionNames = [],
  projectsByInstance,
  seed,
  identity,
  identityFor,
  resolveDraftIdentity,
  state,
  mood,
  blobStyle,
  messages,
  messagesStatus,
  transcriptFailure,
  historyComplete,
  repairHalt,
  instanceStatus,
  instanceLabel,
  permissions,
  questions,
  models,
  defaultModelId,
  recentModels,
  onModelsRefresh,
  sending,
  stopping,
  queue,
  reloading,
  bypass,
  view,
  onViewChange,
  onLoadInstructions,
  onSaveInstructions,
  sessionNotes,
  notesKey,
  savedComposerDrafts,
  composerDraftsHydrated,
  onComposerDraftsChange,
  onRetryPendingSend,
  onDiscardPendingSend,
  onSaveNote,
  focusTarget,
  commentDraftsVersion,
  onCommentsSent,
  onDeleteNote,
  onBypassChange,
  onStopProcesses,
  readMark,
  onMarkMessageRead,
  onMarkAllRead,
  onQuietChange,
  notificationsMuted = false,
  processExtensions,
  onExtendProcesses,
  onNewSessionInstanceChange,
  onCreateAndSend,
  onCancelNewSession,
  pendingCreate,
  onRetryCreate,
  onEditCreate,
  onSaveDraftNote,
  onSend,
  onQueue,
  onSendQueued,
  onMoveQueued,
  onRemoveQueued,
  onReplaceQueued,
  onRetryQueued,
  onDiscardQueued,
  onReload,
  onAbort,
  onPermission,
  onQuestion,
  compacting,
  onCompact,
  askingSideQuestion = false,
  onAskSideQuestion,
  onMinimize,
  onActivate,
  onOpenProviders,
  onArchive,
  onPromote,
  onRename,
  active = true,
  crew = [],
  crewCost,
  nestedBlocked,
  workerState,
  workerAutoAccept,
  onOpenWorker,
  workerPeer,
  onToggleWorkerYolo,
}: Props) {
  const [text, setText] = React.useState('');
  /**
   * A composer height the reader dragged to, or null for "grow with the text".
   *
   * Deliberately *not* persisted: it is a momentary preference about how big the box is right now,
   * and it resets on send (see `resetComposerSize`). Storing it would make a one-off drag permanent,
   * which is the opposite of what dragging usually means.
   */
  const [composerHeight, setComposerHeight] = React.useState<number | null>(null);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [modelId, setModelId] = React.useState(DEFAULT_MODEL);
  const [variant, setVariant] = React.useState('');
  /**
   * The open `@` query and the highlighted row, both owned here so the textarea's keydown can drive
   * the list. `mention` is null whenever the popup is closed, which is what lets Enter fall through
   * to "send" instead of "accept".
   */
  const [mention, setMention] = React.useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const mentionOptions = React.useMemo(
    () => (mention ? matchMentions(mentionNames, mention.query) : []),
    [mention, mentionNames]
  );
  // Close the popup whenever the list empties (no match, or mentions disabled), so a stale open
  // state cannot swallow Enter.
  const mentionOpen = mention !== null && mentionOptions.length > 0;
  const [loadedComposerKey, setLoadedComposerKey] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerActivated, setPickerActivated] = React.useState(false);
  const [attachments, setAttachments] = React.useState<FileAttachment[]>([]);
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const [replyContext, setReplyContext] = React.useState<ChatMessage | null>(null);
  // The tray above the composer: one shelf, one open section. Which section is open is the
  // person's choice; the effect below only brings one forward when something new lands in it.
  const [shelfOpen, setShelfOpen] = React.useState(true);
  const [shelfSection, setShelfSection] = React.useState<ShelfSectionId>('queue');
  /**
   * The extension this session's leftovers have been granted.
   *
   * The number belongs to the reaper (App), so it is read rather than kept: a second copy in this
   * component would let the countdown and the timer disagree.
   */
  const processExtensionFor = React.useCallback(
    (target: Session): number => processExtensions?.[processKey(target)] ?? 0,
    [processExtensions]
  );

  const [comments, setComments] = React.useState<TranscriptComment[]>([]);
  const [commentsSending, setCommentsSending] = React.useState(false);
  const [sideQuestionOpen, setSideQuestionOpen] = React.useState(false);
  const [sideQuestionText, setSideQuestionText] = React.useState('');
  const sideQuestionInputRef = React.useRef<HTMLInputElement>(null);
  const [focusMessageId, setFocusMessageId] = React.useState<string | null>(null);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const [findRequest, setFindRequest] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());
  const fileRef = React.useRef<HTMLInputElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  /** The column, which is `relative`: the selection bar is positioned inside it. */
  const columnRef = React.useRef<HTMLElement>(null);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const commentsKeyRef = React.useRef<string | null | undefined>(undefined);
  /** The key the current `comments` state belongs to, so a saved list never lands under another. */
  const commentsOwnerRef = React.useRef<string | null>(null);
  const createdModelRef = React.useRef<{ key: string; variant?: string } | null>(null);
  const composerDraftsRef = React.useRef(composerMemory);
  const pendingDraftChangesRef = React.useRef<DraftChanges>({});
  const touchedComposerChoicesRef = React.useRef(new Set<string>());
  const previousComposerKeyRef = React.useRef<string | null>(null);
  const draftsHydratedRef = React.useRef(false);
  const draftPersistTimerRef = React.useRef<number | undefined>(undefined);
  const onComposerDraftsChangeRef = React.useRef(onComposerDraftsChange);
  onComposerDraftsChangeRef.current = onComposerDraftsChange;
  // A draft is the new-agent state: no session yet, composer live, options row above it.
  const draftInstanceId = session ? null : newSessionInstanceId;
  const draftInstance = draftInstanceId ? instances.find((candidate) => candidate.id === draftInstanceId) ?? null : null;
  /**
   * The create this pane is showing. It is only ever the draft's: a session column has a
   * conversation already, and App drops the reference when the person leaves the draft.
   */
  const pending = draftInstanceId ? pendingCreate ?? null : null;
  const creatingSession = pending?.phase === 'creating';
  const pendingFailed = pending?.phase === 'failed';
  const pendingMessages = React.useMemo(
    () => (pending ? pendingCreateMessages(pending) : []),
    [pending]
  );
  /** One line for the notes parked on this attempt, or null when there are none. */
  const pendingNoteSummary = React.useMemo(() => {
    const notes = pending?.notes ?? [];
    if (notes.length === 0) return null;
    const latest = notes[notes.length - 1].text.replace(/\s+/g, ' ').trim();
    const extra = notes.length > 1 ? ` (+${notes.length - 1} more)` : '';
    return `For later: “${latest}”${extra} — joins this session's notes when it starts.`;
  }, [pending]);
  const composerKey = session
    ? `${session.instanceId}::${session.id}`
    : draftInstanceId
      ? `new::${draftInstanceId}`
      : null;
  const [draftDirectory, setDraftDirectory] = React.useState('');
  const [draftBypass, setDraftBypass] = React.useState(false);
  /**
   * The standing instructions a *new* session will start with. Not persisted with the draft: it is a
   * decision about the agent being created, and a half-written prompt restored days later is a trap.
   */
  const [instructions, setInstructions] = React.useState('');
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
  const [instructionsDraft, setInstructionsDraft] = React.useState('');
  /** What an existing session has, once the dialog has read it. Keyed, so switching columns is safe. */
  const [instructionsByKey, setInstructionsByKey] = React.useState<Record<string, string>>({});
  const [instructionsLoading, setInstructionsLoading] = React.useState(false);
  /** The preset whose full text is being read, or null. */
  const [previewPreset, setPreviewPreset] = React.useState<InstructionPreset | null>(null);
  const instructionsKey = session ? sessionKey(session) : null;
  /** The text in force: the draft's choice for a new session, what was read back for an existing one. */
  const knownInstructions = draftInstanceId ? instructions : instructionsKey ? instructionsByKey[instructionsKey] : undefined;
  const instructionsPreset = presetFor(knownInstructions);
  /** Both paths reach the same dialog; only the footer differs. */
  const canEditInstructions = Boolean(
    (draftInstanceId && draftInstance?.kind === 'pi') || (session && !draftInstanceId && instance?.kind === 'pi')
  );

  const openInstructions = () => {
    setInstructionsOpen(true);
    setInstructionsDraft(knownInstructions ?? '');
    if (draftInstanceId || !session || !onLoadInstructions) return;
    const key = sessionKey(session);
    if (key in instructionsByKey) return;
    setInstructionsLoading(true);
    void onLoadInstructions(session)
      .then((result) => {
        if (!result.supported) return;
        const text = result.instructions ?? '';
        setInstructionsByKey((previous) => ({ ...previous, [key]: text }));
        setInstructionsDraft(text);
      })
      .catch(() => undefined)
      .finally(() => setInstructionsLoading(false));
  };

  const saveInstructions = async () => {
    const text = instructionsDraft.trim();
    if (draftInstanceId) {
      setInstructions(text);
      setInstructionsOpen(false);
      return;
    }
    if (!session || !onSaveInstructions) {
      setInstructionsOpen(false);
      return;
    }
    const key = sessionKey(session);
    const saved = await onSaveInstructions(session, text || null);
    if (!saved) return;
    setInstructionsByKey((previous) => ({ ...previous, [key]: text }));
    setInstructionsOpen(false);
  };
  /**
   * YEET mode: every message steers the running turn instead of queueing behind it. Queueing is
   * the safe default — a queued message waits its turn and cannot change what the agent is doing —
   * but when you are *directing* an agent mid-flight ("stop, do it this way") waiting is the wrong
   * behaviour. Remembered per composer so it survives a reload; it never touches the server, because
   * steer is decided when the message is sent.
   */
  const [yeet, setYeet] = React.useState(() => readYeet(composerKey));
  // The draft's blob follows the folder picker, so it previews the destination project's blob.
  const draftIdentity = React.useMemo(
    () => (draftInstance ? resolveDraftIdentity(draftInstance.id, draftDirectory) : undefined),
    [draftInstance, draftDirectory, resolveDraftIdentity]
  );
  const draftTouchedRef = React.useRef<{ directory: boolean; bypass: boolean }>({ directory: false, bypass: false });

  // Re-seed the draft options whenever the target instance changes, and follow the prefill
  // (sessions/projects can load after the draft opens) until the user edits a field.
  React.useEffect(() => {
    draftTouchedRef.current = { directory: false, bypass: false };
  }, [draftInstanceId]);
  /**
   * Where the attempt being shown was sent, if it was sent from this draft. A create that is on
   * screen owns the destination row: the failure names the folder and Try again reads the row, so
   * the prefill must not quietly reset it when the session list finishes loading underneath.
   */
  const pendingDirectory =
    pendingCreate && draftInstanceId && pendingCreate.options.instanceId === draftInstanceId
      ? pendingCreate.options.directory
      : null;
  React.useEffect(() => {
    if (!draftInstanceId) return;
    if (!draftTouchedRef.current.directory) {
      setDraftDirectory(pendingDirectory || newSessionPrefill?.directory || '');
    }
    if (!draftTouchedRef.current.bypass) setDraftBypass(newSessionPrefill?.bypass ?? false);
  }, [draftInstanceId, newSessionPrefill, pendingDirectory]);

  React.useEffect(() => {
    if (!composerDraftsHydrated || draftsHydratedRef.current) return;
    draftsHydratedRef.current = true;
    Object.entries(savedComposerDrafts).forEach(([key, draft]) => {
      if (draft.modelId !== undefined || draft.variant) {
        touchedComposerChoicesRef.current.add(key);
      }
      if (!composerDraftsRef.current.has(key) && !removedDrafts.has(key)) {
        composerDraftsRef.current.set(key, composerFromStored(draft));
      }
    });
    const restored = composerKey ? composerDraftsRef.current.get(composerKey) : undefined;
    // Only fill an untouched composer; the current values are read once, on hydration.
    if (restored && !text && attachments.length === 0 && !replyContext) {
      setText(restored.text);
      setModelId(restored.modelId);
      setVariant(restored.variant);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot hydration, guarded by draftsHydratedRef
  }, [composerDraftsHydrated, savedComposerDrafts]);

  const snapshotComposerDrafts = () => {
    const changes = pendingDraftChangesRef.current;
    pendingDraftChangesRef.current = {};
    return changes;
  };

  const scheduleDraftPersistence = () => {
    if (!draftsHydratedRef.current) return;
    if (draftPersistTimerRef.current !== undefined) window.clearTimeout(draftPersistTimerRef.current);
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = undefined;
      onComposerDraftsChangeRef.current(snapshotComposerDrafts());
    }, 600);
  };

  React.useEffect(() => () => {
    if (draftPersistTimerRef.current === undefined) return;
    window.clearTimeout(draftPersistTimerRef.current);
    onComposerDraftsChangeRef.current(snapshotComposerDrafts());
  }, []);

  const updateComposerDraft = (key: string, draft: ComposerState | null) => {
    if (draft) {
      removedDrafts.delete(key);
      saveComposerDraft(composerDraftsRef.current, key, draft);
    } else {
      removedDrafts.add(key);
      composerDraftsRef.current.delete(key);
      touchedComposerChoicesRef.current.delete(key);
    }
    pendingDraftChangesRef.current[key] = draft ? storedFromComposer(draft) : null;
    scheduleDraftPersistence();
  };

  React.useEffect(() => {
    if (!composerKey || loadedComposerKey !== composerKey || (!text && !attachments.length && !replyContext)) return;
    saveComposerDraft(composerMemory, composerKey, { text, modelId, variant, attachments, replyContext });
  }, [composerKey, loadedComposerKey, text, modelId, variant, attachments, replyContext]);

  const updateComposerChoices = (patch: Partial<Pick<ComposerState, 'modelId' | 'variant'>>) => {
    if (!composerKey) return;
    touchedComposerChoicesRef.current.add(composerKey);
    updateComposerDraft(composerKey, {
      text,
      modelId,
      variant,
      attachments,
      replyContext,
      ...patch,
    });
  };

  const last = messages[messages.length - 1];
  const busy = isTurnLive({ sending, state, last });
  // While a stop is in flight the run looks busy but the user has already asked to end it: the
  // stop button becomes a disabled spinner so a second press can't be lost, and the composer
  // stays read-only until the abort reconciles.
  const stoppingNow = Boolean(stopping);
  const offerReload = Boolean(
    session &&
      !sending &&
      shouldOfferSessionReload(state, messagesStatus, session.updated, messages, now, transcriptFailure)
  );
  // The transcript's empty pane renders this instead of deciding for itself whether an `'error'`
  // status is something to alarm about.
  const fetchNotice = React.useMemo(
    () =>
      transcriptNotice({
        state: { status: messagesStatus, failure: transcriptFailure },
        messagesEmpty: messages.length === 0,
        instanceStatus,
        instanceLabel,
      }),
    [messagesStatus, transcriptFailure, messages.length, instanceStatus, instanceLabel]
  );

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    let remaining =
      MAX_TOTAL_ATTACHMENT_BYTES -
      attachments.reduce((sum, file) => sum + Math.ceil(file.url.length * 0.75), 0);
    const accepted = [...files].filter((file) => {
      if (file.size > MAX_ATTACHMENT_BYTES || file.size > remaining) return false;
      remaining -= file.size;
      return true;
    });
    const skippedForSize = files.length - accepted.length;
    // A file this big is not going to fit down any wire this app has: a recording belongs on the
    // host's disk, where the agent can inspect it by path, not inside a conversation as base64.
    const oversized = [...files].filter((file) => file.size > MAX_ATTACHMENT_BYTES);
    // One unreadable file (permissions, removed drive) must not drop the whole batch.
    const results = await Promise.allSettled(accepted.map(readAttachment));
    const read = results
      .filter((result): result is PromiseFulfilledResult<FileAttachment> => result.status === 'fulfilled')
      .map((result) => result.value);
    const unreadable = results.length - read.length;
    const problems = [
      // Built from the constants: the sentence drifted from the numbers when they were literals.
      skippedForSize > 0
        ? `${skippedForSize} exceeding the ${megabytes(MAX_ATTACHMENT_BYTES)} file / ${megabytes(MAX_TOTAL_ATTACHMENT_BYTES)} total limit`
        : null,
      // Never a dead end: for a file that is over the ceiling rather than merely over the budget,
      // point at the route that does work — the host's own disk, reached by path.
      oversized.length > 0
        ? `put ${oversized.length === 1 ? 'it' : 'them'} on the host's disk and send the path instead — a recording that big cannot ride in a message`
        : null,
      unreadable > 0 ? `${unreadable} could not be read` : null,
    ].filter((entry): entry is string => entry !== null);
    setAttachmentError(problems.length > 0 ? `Skipped ${problems.join(', ')}.` : null);
    if (read.length > 0) setAttachments((prev) => [...prev, ...read]);
  };

  // Enter/leave fire for every child crossed, so count depth rather than toggling.
  const dragDepth = React.useRef(0);
  const [dragging, setDragging] = React.useState(false);
  const carriesFiles = (event: React.DragEvent) =>
    Boolean(composerKey) && event.dataTransfer.types.includes('Files');
  const dropHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      onActivate?.();
      void addFiles(event.dataTransfer.files);
      textareaRef.current?.focus();
    },
  };

  React.useEffect(() => {
    if (!composerKey) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [composerKey]);

  // Runs exactly when the open session changes: stash the outgoing composer under the previous
  // key and load the incoming one. It must read the *current* text/attachments/etc. without
  // re-running when they change, so those are intentionally not dependencies.
  React.useLayoutEffect(() => {
    const previousKey = previousComposerKeyRef.current;
    if (previousKey && previousKey !== composerKey) {
      if (
        text.trim() ||
        attachments.length ||
        replyContext ||
        touchedComposerChoicesRef.current.has(previousKey)
      ) {
        updateComposerDraft(previousKey, {
          text,
          modelId,
          variant,
          attachments,
          replyContext,
        });
      } else {
        updateComposerDraft(previousKey, null);
      }
    }
    previousComposerKeyRef.current = composerKey;
    setLoadedComposerKey(composerKey);

    const stored = composerKey && !removedDrafts.has(composerKey) ? savedComposerDrafts[composerKey] : undefined;
    const saved = composerKey ? composerDraftsRef.current.get(composerKey) ?? (stored ? composerFromStored(stored) : undefined) : undefined;
    if (saved && composerKey) {
      saveComposerDraft(composerDraftsRef.current, composerKey, saved);
      touchedComposerChoicesRef.current.add(composerKey);
    }
    const created = createdModelRef.current;
    const sessionModelKey = session?.model ? modelRefKey(session.model) : undefined;
    const prefill = draftInstanceId ? newSessionPrefill?.model ?? undefined : undefined;
    const next: ComposerState = saved ?? {
      text: '',
      modelId: created?.key ?? sessionModelKey ?? prefill?.key ?? defaultModelId ?? DEFAULT_MODEL,
      variant: created?.variant ?? session?.model?.variant ?? prefill?.variant ?? '',
      attachments: [],
      replyContext: null,
    };

    setText(next.text);
    setModelId(next.modelId);
    setVariant(next.variant);
    setAttachments(next.attachments);
    setAttachmentError(null);
    setReplyContext(next.replyContext);
    createdModelRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above the effect
  }, [composerKey]);

  React.useEffect(() => {
    setFocusMessageId(null);
    if (!composerKey) return;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [composerKey]);

  const commitRename = (value: string) => {
    setEditingTitle(false);
    const next = value.trim();
    if (next && session && next !== session.title) onRename?.(next);
  };

  const { model, error: modelError } = resolveComposerModel(modelId, variant, models, defaultModelId);
  const defaultModel = defaultModelId ? models.find((entry) => modelRefKey(entry) === defaultModelId) : undefined;
  /**
   * The reasoning levels this composer can actually choose between.
   *
   * Reads from the resolved model, falling back to the instance default when "server default" is
   * selected — a default still has effort levels, and hiding the control there would make it vanish
   * for exactly the people who never pick a model.
   */
  const reasoningLevels = (model ?? defaultModel)?.details.variants ?? [];
  const reasoningValue = canonicalVariant(reasoningLevels, variant) ?? '';

  const modelButtonLabel = modelId === DEFAULT_MODEL
    ? `Server default${defaultModel ? ` · ${defaultModel.details.name}` : ''}`
    : model
      ? `${model.details.providerName} / ${model.details.name}`
      : models.length === 0
        ? modelId
        : `${modelId} (unavailable)`;
  const draftProjects = draftInstanceId ? projectsByInstance[draftInstanceId] ?? [] : [];

  const draftReady = Boolean(draftInstanceId && draftDirectory.trim());
  React.useEffect(() => {
    setYeet(readYeet(composerKey));
  }, [composerKey]);

  /** YEET is a per-session preference, so it follows the composer, not the app. */
  const toggleYeet = (enabled: boolean) => {
    setYeet(enabled);
    writeYeet(composerKey, enabled);
  };

  const effectiveBypass = draftInstanceId ? draftBypass : bypass;

  /**
   * The draft keeps sending while its session is being created (the message is held and goes as
   * soon as the session exists), and sends nothing while a create is failed: the next thing that
   * has to happen is Try again or Edit on the row above, not another message into a session that
   * does not exist.
   */
  const canSend =
    loadedComposerKey === composerKey &&
    !modelError &&
    (session ? true : draftReady) &&
    !pendingFailed &&
    (text.trim().length > 0 || attachments.length > 0);
  /**
   * The destination the draft row currently describes. Submit and Try again both read it, so a
   * retry goes wherever the person has since pointed the row — the folder is the usual reason a
   * create failed, and making them retype it into a dialog would be backwards.
   */
  const draftOptionsFor = (variantValue: string): NewSessionOptions | null =>
    draftInstanceId
      ? {
          instanceId: draftInstanceId,
          directory: draftDirectory.trim(),
          model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
          variant: variantValue || undefined,
          bypass: draftBypass,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        }
      : null;

  /** Start the failed create again, with the destination shown under the message. */
  const retryPendingCreate = () => {
    if (!pending || !onRetryCreate) return;
    const options = draftOptionsFor(variant);
    onRetryCreate(pending.id, options ?? pending.options);
  };

  /**
   * Take the failed message back into the composer. Anything already typed stays after it: Edit is
   * a way to change and resend the message that failed, not a way to lose the next thought.
   */
  const editPendingCreate = () => {
    if (!pending || !onEditCreate) return;
    const restored = pendingCreateComposerText(pending);
    // Notes parked on the attempt come back too: Edit abandons the attempt, and a note that vanished
    // with it would be the one thing the person could not retype from memory.
    const parkedNotes = (pending.notes ?? []).map((note) => note.text).join('\n\n');
    onEditCreate(pending.id);
    const base = [restored.text, parkedNotes].filter(Boolean).join('\n\n');
    const nextText = text.trim() ? `${base}\n\n${text}` : base;
    const nextAttachments = [...restored.attachments, ...attachments];
    setText(nextText);
    setAttachments(nextAttachments);
    setAttachmentError(null);
    if (composerKey) {
      updateComposerDraft(composerKey, {
        text: nextText,
        modelId,
        variant,
        attachments: nextAttachments,
        replyContext,
      });
    }
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const queueItems = queue?.items ?? [];
  /**
   * Whether the crew is waiting on the human: a worker that asked a question, or one further down
   * the delegation chain that is blocked. It is what puts the dot on the shelf's Crew tab.
   */
  const crewNeedsInput =
    (nestedBlocked?.length ?? 0) > 0 || crew.some((worker) => worker.needsInput);
  /**
   * New things bring their own section forward — a queued message opens Queue, a saved note opens
   * For later — but they do not unfold a shelf the person folded. A crew that is now blocked is the
   * exception: that is a question waiting for an answer, so it opens itself.
   */
  const shelfCounts = React.useRef<{ queue: number; notes: number; blocked: number } | null>(null);
  React.useEffect(() => {
    const next = {
      queue: queueItems.length,
      notes: sessionNotes.length,
      blocked: crewNeedsInput ? 1 : 0,
    };
    const previous = shelfCounts.current;
    shelfCounts.current = next;
    // The first render is the baseline, not an arrival: a session that opens with a note parked or
    // a crew already blocked is not "something just happened", and stealing the shelf for it would
    // hide whatever the person opened the conversation to look at.
    if (!previous) return;
    if (next.queue > previous.queue) setShelfSection('queue');
    else if (next.notes > previous.notes) setShelfSection('notes');
    if (next.blocked > previous.blocked) {
      setShelfSection('crew');
      setShelfOpen(true);
    }
  }, [queueItems.length, sessionNotes.length, crewNeedsInput]);
  // A steer is in the queue because the host is holding it for the running turn, not because a
  // follow-up is waiting. Counting it as one would keep the composer in queue mode after the turn
  // it was steering has finished, and offer to "send the next queued message" one already running.
  const queuedFollowUps = queueItems.filter((item) => item.mode !== 'steer');
  const shouldQueue = Boolean(session && (busy || queuedFollowUps.length > 0));
  // The host has not said whether this session is busy. The composer still sends — a message that
  // arrives during a turn waits its turn rather than being lost — but nothing here may claim to know
  // which one it is, so the labels stay neutral and the tooltip says why.
  const statusUnknown = Boolean(session) && state === 'unknown';

  // Transcript comments are transient drafts: a per-session in-memory list, never the queue and
  // never a persisted format. Loading on a key change keeps them through a column switching
  // session or coming back from a closed column.
  React.useLayoutEffect(() => {
    commentsOwnerRef.current = composerKey;
    if (commentsKeyRef.current === composerKey) return;
    commentsKeyRef.current = composerKey;
    setComments(composerKey ? commentMemory.get(composerKey) ?? [] : []);
  }, [composerKey]);

  // Drafts can also arrive from the reading view while this column stays mounted: same key, same
  // memory, so re-reading is all it takes. Keyed on the version, never on our own list.
  const draftsVersionRef = React.useRef(commentDraftsVersion ?? 0);
  React.useEffect(() => {
    if (!composerKey) return;
    if (draftsVersionRef.current === (commentDraftsVersion ?? 0)) return;
    draftsVersionRef.current = commentDraftsVersion ?? 0;
    setComments(commentMemory.get(composerKey) ?? []);
  }, [composerKey, commentDraftsVersion]);

  React.useEffect(() => {
    const owner = commentsOwnerRef.current;
    if (!owner) return;
    if (comments.length > 0) commentMemory.set(owner, comments);
    else commentMemory.delete(owner);
  }, [comments]);

  const addComment = (quote: string, reply: string) => {
    const quoted = normaliseSelection(quote);
    if (!quoted) return;
    setComments((prev) => [...prev, { id: newCommentId(), quote: quoted, reply: reply.trim() }]);
  };

  const updateCommentReply = (id: string, reply: string) =>
    setComments((prev) => prev.map((comment) => (comment.id === id ? { ...comment, reply } : comment)));

  const removeComment = (id: string) =>
    setComments((prev) => prev.filter((comment) => comment.id !== id));

  /**
   * Send every comment as ONE user message through the ordinary send path (same model, reasoning
   * and queue decision as the composer), with the composer's own text appended once at the end.
   * A failure leaves the tray exactly as it was: the comments are the draft, so nothing is lost.
   */
  const sendComments = async () => {
    if (!session || !composerKey || commentsSending) return;
    if (loadedComposerKey !== composerKey || modelError) return;
    const composed = composeCommentMessage(comments, text);
    if (!composed.trim()) return;
    setCommentsSending(true);
    try {
      const input: PromptInput = {
        text: composed,
        model,
        selectedModelId: modelId,
        mode: session.agent,
        variant: variant || undefined,
      };
      // Not retained on failure: the tray still holds the text, so a transcript bubble would
      // duplicate it. The app surfaces the reason through its error banner.
      const sent = await (shouldQueue ? onQueue : onSend)(input, { retainOnFailure: false });
      if (!sent) return;
      onCommentsSent?.(comments.length);
      setComments([]);
      commentMemory.delete(composerKey);
      if (!text.trim()) return;
      // The composer's text travelled in that message, so it clears; attachments and the reply
      // context were not sent and stay put.
      touchedComposerChoicesRef.current.add(composerKey);
      updateComposerDraft(composerKey, { text: '', modelId, variant, attachments, replyContext });
      setText('');
      // A message just left: the box goes back to its natural size, so the next thought starts
      // somewhere calm rather than inheriting the height of a pasted document.
      setComposerHeight(null);
    } finally {
      setCommentsSending(false);
    }
  };

  const selectionComments = useSelectionComments({
    regionRef: transcriptRef,
    hostRef: columnRef,
    enabled: Boolean(session),
  });
  const hideToolCalls = view.hideToolCalls;
  const reasoningDisplay = view.reasoningDisplay;
  // The session's folder (its cwd), shown beside the instance in the header; empty for a root session.
  /**
   * Whether this conversation can be promoted: it is a worker, and it has not been promoted yet.
   *
   * Hearth's `kind` is the reliable answer and `onPromote` is only wired when the caller knows it.
   * The second half covers the column opened from a crew strip: a worker's conversation summary does
   * not always carry `kind`, but its leader's crew list does, and that list is what the strip draws.
   */
  const promotable = Boolean(
    session &&
      onPromote &&
      !session.promotedTo &&
      (session.kind === 'worker' || crew.some((worker) => worker.id === session.id))
  );
  const sessionFolder = session?.directory
    ? normalizeDirectory(session.directory).split(/[\\/]/).filter(Boolean).pop() ?? ''
    : '';
  // The cost badge: "never ran", "spent something the ledger can price" and "ran, ledger reported
  // nothing" are three different facts and used to be one blank space. `messages.length` is how we
  // know the session has run at all — there is nothing to report about a session that hasn't.
  /**
   * The badge's state: the crew-aware total when the caller supplied one, else this session's own
   * ledger. The fallback keeps the old shape, so a draft or a caller with no siblings behaves as
   * before — including "Cost unknown" for a session that ran without priced turns.
   */
  /**
   * Whether this column's host reports spend at all.
   *
   * Hearth prices every turn from its own ledger; OpenChamber's per-message figure is an estimate
   * from the model's rate, and the badge cannot say which it is showing — so an OpenChamber session
   * shows no cost. Not "Cost unknown" either: that claims the host tried, and it did not.
   */
  const costShown = hostReportsCost(instance?.kind);
  // `none` — not `unknown` — when the host doesn't report spend: "Cost unknown" would claim it tried
  // and reported nothing, which is a different fact from "this host has no cost to report".
  const legacyCost = costShown
    ? sessionCostState(session?.cost, messages.length > 0)
    : ({ kind: 'none' } as const);
  const costState: CrewCostState =
    crewCost ??
    (legacyCost.kind === 'priced'
      ? { kind: 'priced', total: legacyCost.cost, own: legacyCost.cost, crew: 0, workers: 0, partial: false }
      : legacyCost.kind === 'unknown'
        ? { kind: 'unknown' }
        : { kind: 'none' });
  // Composer context meter: the last completed turn's tokens against the window of the model that
  // ran it. The window comes from the composer's selection (or the instance default while the
  // composer is on "server default"), and only counts when it is the same model — otherwise the
  // meter says "unknown" rather than a ratio between two unrelated numbers. See
  // `lib/contextMeter.ts` for the rule and the reasons.
  const contextMeter = React.useMemo(
    () => contextMeterState(messages, model ?? defaultModel),
    [messages, model, defaultModel]
  );
  // Hearth does not compact on its own, so Ember does it for the session you are looking at: once
  // past 85% of the window, when the turn is finished and nothing is already compacting. The ref
  // makes it once per crossing rather than every render, and it rearms once usage drops back.
  // An unknown ratio never compacts: it is not a measurement, so it can't cross a threshold, and a
  // silent rewrite of the history on a guess is the worst thing this control could do.
  const autoCompactedRef = React.useRef<string | null>(null);
  const contextPercent = contextMeter.kind === 'known' ? contextMeter.percent : null;
  const turnBusy = sending || state === 'active';
  React.useEffect(() => {
    if (!session || compacting || turnBusy) return;
    if (contextPercent === null) return;
    const key = sessionKey(session);
    if (contextPercent < 85) {
      if (autoCompactedRef.current === key) autoCompactedRef.current = null;
      return;
    }
    if (autoCompactedRef.current === key) return;
    autoCompactedRef.current = key;
    onCompact();
  }, [session, compacting, turnBusy, contextPercent, onCompact]);

  // Up-arrow history: recall the most recent thing the user sent, like a shell.
  const lastSentMessage = React.useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && message.text.trim()) return message.text.trim();
    }
    return null;
  }, [messages]);

  const submit = (options?: { forceSend?: boolean }) => {
    if (!canSend) return;
    const submitted: ComposerState = { text: text.trim(), modelId, variant, attachments, replyContext };
    const submittedKey = composerKey;
    const input: PromptInput = {
      text: submitted.text,
      model,
      selectedModelId: submitted.modelId,
      mode: session?.agent,
      variant: submitted.variant || undefined,
      attachments: submitted.attachments,
      replyContext: submitted.replyContext ? messageContextText(submitted.replyContext) : undefined,
      // A forced send (Alt+Enter / "send now") always steers; YEET makes that the default rather
      // than a per-message decision.
      steer: options?.forceSend === true || yeet,
    };
    let result: Promise<boolean>;
    if (draftInstanceId) {
      // The new session's composer should open with the model chosen in the draft. A held message
      // never starts a session, so there is nothing to hand over: only a create does that.
      createdModelRef.current = { key: modelId, variant: submitted.variant || undefined };
      if (submittedKey) touchedComposerChoicesRef.current.delete(submittedKey);
      result = onCreateAndSend(
        draftOptionsFor(submitted.variant) ?? {
          instanceId: draftInstanceId,
          directory: draftDirectory.trim(),
          bypass: draftBypass,
        },
        input
      );
    } else {
      result = (shouldQueue && !options?.forceSend ? onQueue : onSend)(input);
    }
    result.then((sent) => {
      if (sent) return;
      const currentDraft = submittedKey ? composerDraftsRef.current.get(submittedKey) : undefined;
      if (submittedKey && currentDraft && (currentDraft.text.trim() || currentDraft.attachments.length || currentDraft.replyContext)) {
        updateComposerDraft(submittedKey, {
          ...currentDraft,
          attachments: currentDraft.attachments.length ? currentDraft.attachments : submitted.attachments,
          replyContext: currentDraft.replyContext ?? submitted.replyContext,
        });
        return;
      }
      const restored = { ...submitted, modelId: currentDraft?.modelId ?? submitted.modelId, variant: currentDraft?.variant ?? submitted.variant };
      if (submittedKey) updateComposerDraft(submittedKey, restored);
      if (previousComposerKeyRef.current !== submittedKey) return;
      setText(restored.text);
      setModelId(restored.modelId);
      setVariant(restored.variant);
      setAttachments(restored.attachments);
      setReplyContext(restored.replyContext);
    });
    if (composerKey) {
      if (session) touchedComposerChoicesRef.current.add(composerKey);
      updateComposerDraft(composerKey, session ? clearComposerText(submitted) : null);
    }
    setText('');
    // Sent: the height was about the message that just left, not about the next one.
    setComposerHeight(null);
    setAttachments([]);
    setAttachmentError(null);
    setReplyContext(null);
  };

  // "Save as note" parks the composer text; a note can send as-is, come back to the composer, or go.
  const saveNote = () => {
    if (!composerKey) return;
    const parked = text.trim();
    if (!parked) return;
    // A draft has no session to park a note for. The attempt itself holds it, and App moves it into
    // the session's tray the moment the session exists — so the note survives the wait instead of
    // the button doing nothing while a create is out.
    if (!session) {
      if (!pending || !onSaveDraftNote) return;
      onSaveDraftNote(parked);
    } else {
      onSaveNote(notesKey, parked);
    }
    touchedComposerChoicesRef.current.add(composerKey);
    updateComposerDraft(composerKey, { text: '', modelId, variant, attachments, replyContext });
    setText('');
    setAttachmentError(null);
    // Land on the start of the text: a long queued message overflows the composer's capped height,
    // and focusing it at the bottom showed the tail with no sign of where the message began.
    window.requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.focus();
      box.scrollTop = 0;
    });
  };

  const bringBackNote = (note: SessionNote) => {
    if (!composerKey) return;
    const next = text.trim() ? `${text.trimEnd()}\n\n${note.text}` : note.text;
    setText(next);
    updateComposerDraft(composerKey, { text: next, modelId, variant, attachments, replyContext });
    onDeleteNote(notesKey, note.id);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const sendNote = async (note: SessionNote): Promise<boolean> => {
    if (!composerKey || !session || modelError) return false;
    const input: PromptInput = { text: note.text, model, selectedModelId: modelId, variant: variant || undefined };
    const sent = await (shouldQueue ? onQueue : onSend)(input);
    if (sent) onDeleteNote(notesKey, note.id);
    return sent;
  };

  // Move a queued message out of the server queue and into this session's notes.
  const parkQueuedItem = async (itemId: string): Promise<boolean> => {
    if (!composerKey) return false;
    const item = queueItems.find((entry) => entry.id === itemId);
    const text = item ? item.text.trim() || item.content.trim() : '';
    if (!text) return false;
    const removed = await onRemoveQueued(itemId);
    if (!removed) return false;
    onSaveNote(notesKey, text);
    return true;
  };

  const stablePermission = useStableCallback(onPermission);
  const stableQuestion = useStableCallback(onQuestion);

  const jumpToMessage = (messageId: string) => {
    setFocusMessageId(messageId);
    setFocusRequest((request) => request + 1);
  };

  // A jump asked for from outside the column (a link's context bar on Home). Token-keyed, so the
  // same message can be asked for again and a fresh request is never swallowed.
  const focusToken = focusTarget?.token ?? 0;
  const focusMessageRef = React.useRef<string | null>(null);
  focusMessageRef.current = focusTarget?.messageId ?? null;
  React.useEffect(() => {
    if (!focusToken || !focusMessageRef.current) return;
    // Only the request token is a dependency: the id is read through a ref so a parent that hands
    // over a new object identity for the same jump cannot scroll the reader twice.
    jumpToMessage(focusMessageRef.current);
  }, [focusToken]);

  /**
   * One transcript pane, for a session column and for a new agent whose session is being created.
   *
   * The draft's pane must be the same component: its one bubble carries the same delivery states as
   * any other send (`sending`, `failed`), and the ways out of a failed create have to look like the
   * ways out of a failed send. Everything a session supplies but a draft cannot (history, prompts,
   * crew, pins) is simply empty for the draft.
   */
  const renderTranscript = (pane: {
    messages: ChatMessage[];
    messagesStatus: MessagesStatus;
    historyComplete?: boolean;
    repairHalt?: RepairHalt | null;
    onLoadEarlier?: () => void;
    onCompact?: () => void;
    permissions: PermissionRequest[];
    questions: QuestionRequest[];
    state: BallState;
    sending: boolean;
    creating?: boolean;
    sessionTitle?: string;
    /** The draft names its own target instance; a session inherits it from the column. */
    instanceLabel?: string;
    onRetryPendingSend?: (message: ChatMessage) => void;
    onDiscardPendingSend?: (message: ChatMessage) => void;
    pendingSendLabels?: { retry?: string; discard?: string };
    /** The draft has no crew, pins or scrub rail; a session passes the column's own. */
    crew?: Session[];
    workerState?: (worker: Session) => BallState;
    showAvatars?: boolean;
    showActivityRail?: boolean;
  }) => (
    <React.Suspense fallback={<TranscriptFallback />}>
      <Transcript
        findRequest={findRequest}
        messages={pane.messages}
        messagesStatus={pane.messagesStatus}
        historyComplete={pane.historyComplete}
        repairHalt={pane.repairHalt}
        onLoadEarlier={pane.onLoadEarlier}
        onCompact={pane.onCompact}
        compacting={compacting}
        fetchNotice={pane.messages.length === 0 ? fetchNotice : undefined}
        permissions={pane.permissions}
        questions={pane.questions}
        state={pane.state}
        sending={pane.sending}
        creating={pane.creating}
        sessionTitle={pane.sessionTitle}
        instanceLabel={pane.instanceLabel ?? instanceLabel ?? draftInstance?.label}
        blobStyle={blobStyle}
        seed={seed}
        identity={identity}
        mood={mood}
        hideToolCalls={hideToolCalls}
        reasoningDisplay={reasoningDisplay}
        showQuestions={view.showQuestions}
        expandToolCalls={view.expandToolCalls}
        toolDisplay={view.toolDisplay}
        showCost={costShown}
        {...(readMark ? { readMark } : {})}
        {...(onMarkMessageRead && session ? { onMarkRead: (message: ChatMessage) => onMarkMessageRead(session, message) } : {})}
        {...(onMarkAllRead && session ? { onMarkAllRead: () => onMarkAllRead(session) } : {})}
        showMessageDetails={view.showMessageDetails}
        showAvatars={pane.showAvatars ?? view.showAvatars}
        crew={pane.crew ?? crew}
        workerState={pane.workerState ?? workerState}
        showActivityRail={pane.showActivityRail ?? view.showActivityRail}
        compactSpacing={view.compactSpacing}
        autoFollow={view.autoFollow}
        focusMessageId={focusMessageId}
        focusRequest={focusRequest}
        onRetryPendingSend={pane.onRetryPendingSend}
        onDiscardPendingSend={pane.onDiscardPendingSend}
        pendingSendLabels={pane.pendingSendLabels}
        onPermission={stablePermission}
        onQuestion={stableQuestion}
      />
    </React.Suspense>
  );

  /**
   * The wash of colour behind the top-left corner.
   *
   * It is the session's **own** blob colour — the same value the avatar and the rail draw from — so a
   * column is recognisable by temperature before you read its title. Kept deliberately faint: one
   * very wide radial gradient, no blur filter (a 560px blurred layer is repainted on every scroll),
   * and low alpha, so it reads as light in the room rather than a coloured panel. `blobColor` returns
   * a `var(--blob-N)` reference, which is why `color-mix` can grade it without knowing the value.
   */
  const cornerTint = session
    ? `radial-gradient(125% 100% at -6% -8%, color-mix(in oklab, ${blobColor(blobStyle, identity ?? seed)} 10%, transparent), transparent 56%)`
    : undefined;

  return (
    <main
      ref={columnRef}
      className="relative flex min-w-0 flex-1 overflow-hidden"
      data-session-key={session ? seed : undefined}
      {...dropHandlers}
      onPointerDownCapture={(event) => {
        // Buttons carry their own intent. Activating here would start the column-width
        // transition under the pointer mid-press, so the click can land off the button —
        // a single press of × on an inactive column used to just activate instead of archiving.
        if (event.target instanceof Element && event.target.closest('button, a')) return;
        onActivate?.();
      }}
      onKeyDown={(event) => {
        if (session && !event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          setFindRequest((request) => request + 1);
        }
      }}
    >
      {cornerTint ? (
        // Its own layer, not a background on <main>: the transcript scrolls above it and must not
        // carry the gradient along, and `pointer-events-none` keeps it out of every hit test.
        <div
          aria-hidden="true"
          data-corner-tint=""
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
          data-agent-glow
          style={{ backgroundImage: cornerTint }}
        />
      ) : null}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <AnimatePresence mode="popLayout" initial={false}>
        {session ? (
          <motion.div
            key={`${session.instanceId}:${session.id}`}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            <header data-active={active} className="flex min-h-11 flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-1 sm:px-4 data-[active=true]:bg-muted/25">
              {editingTitle ? (
                <input
                  autoFocus
                  defaultValue={session.title ?? ''}
                  aria-label="Rename session"
                  className="min-w-0 flex-1 rounded-md border border-highlight/50 bg-background px-1.5 py-0.5 text-[13px] font-medium outline-none"
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {

                    if (event.key === 'Enter') commitRename(event.currentTarget.value);
                    else if (event.key === 'Escape') setEditingTitle(false);
                  }}
                  onBlur={(event) => commitRename(event.currentTarget.value)}
                />
              ) : (
                <span
                  className={cn('min-w-[5.5rem] flex-1 truncate text-[13px] font-medium', onRename && 'cursor-text')}
                  title={onRename ? `${session.title ?? session.id} — double-click to rename` : undefined}
                  onDoubleClick={onRename ? () => setEditingTitle(true) : undefined}
                  style={instanceMarkerColor === undefined ? undefined : {
                    textDecoration: 'underline',
                    textDecorationColor: `var(--instance-marker-${instanceMarkerColor})`,
                    textDecorationThickness: '2px',
                    textUnderlineOffset: '3px',
                  }}
                >
                  {session.title ?? session.id}
                </span>
              )}
              {/* A worker's own session is the only place its role is known. The header used to
                  guard a promote button on `session.kind`, which a worker's summary does not carry,
                  so the control never rendered — there was no way to promote anything. Promote is
                  spelled out here rather than hidden behind an icon: it forks the conversation into
                  a peer, which is not something to discover by hovering. */}
              {promotable && onPromote ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={onPromote}
                  title="Fork this worker into a named peer other agents can message by name"
                >
                  <UserPlus aria-hidden="true" />
                  Promote to peer
                </Button>
              ) : null}
              {offerReload || reloading ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={reloading}
                  onClick={onReload}
                  title="Reload this session from its instance"
                >
                  <RefreshCw className={cn(reloading && 'animate-spin')} />
                  <span className="hidden sm:inline">{reloading ? 'Reloading…' : 'Refresh'}</span>
                </Button>
              ) : null}
              {permissions.length ? (
                <Badge variant="secondary" className="border-warning/40 bg-warning/10 font-normal text-warning">
                  <ShieldAlert />
                  {permissions.length === 1 ? 'Approval needed' : `${permissions.length} approvals`}
                </Badge>
              ) : null}
              {questions.length ? (
                <Badge variant="secondary" className="border-highlight/40 bg-highlight/10 font-normal text-highlight">
                  <MessageCircleQuestion />
                  {questions.length === 1 ? 'Question needed' : `${questions.length} questions`}
                </Badge>
              ) : null}
              {instance ? (
                <Badge variant="secondary" className="hidden font-normal text-muted-foreground sm:inline-flex">
                  <Box aria-hidden="true" />
                  {instance.label}
                </Badge>
              ) : null}
              {sessionFolder ? (
                <Badge
                  variant="secondary"
                  className="hidden font-normal text-muted-foreground sm:inline-flex"
                  title={session?.directory}
                >
                  <Folder aria-hidden="true" />
                  {sessionFolder}
                </Badge>
              ) : null}
              {costState.kind === 'priced' ? (
                // One number, never a misleading one: a "+" means some turns in this family were not
                // priced, and the tooltip splits the bill between the session and its crew.
                <Badge
                  variant="secondary"
                  className="hidden font-normal text-muted-foreground sm:inline-flex"
                  title={crewCostTitle(costState)}
                >
                  <CircleDollarSign aria-hidden="true" />
                  {crewCostLabel(costState)}
                </Badge>
              ) : costState.kind === 'unknown' ? (
                // The session ran and the ledger reported nothing: say that, rather than showing
                // "$0" (a claim that it was free) or nothing at all (which reads the same).
                <Badge
                  variant="secondary"
                  className="hidden font-normal text-muted-foreground sm:inline-flex"
                  title={COST_UNKNOWN_TITLE}
                >
                  <CircleDashed aria-hidden="true" />
                  {COST_UNKNOWN_LABEL}
                </Badge>
              ) : null}
              <ViewMenu
                view={view}
                onChange={onViewChange}
                cost={costShown ? session?.cost : undefined}
                costUnknown={costShown && costState.kind === 'unknown'}
                instructions={session && canEditInstructions ? knownInstructions ?? '' : undefined}
                onEditInstructions={session && canEditInstructions ? openInstructions : undefined}
                // A worker is hidden from Home, so a read mark on it is invisible: offering the
                // switch there would be a control with no observable effect.
                quiet={notificationsMuted}
                onQuietChange={
                  session && onQuietChange && session.kind !== 'worker'
                    ? (quietNext) => onQuietChange(session, quietNext)
                    : undefined
                }
              />
              {onMinimize || onArchive ? (
                <div className="flex items-center gap-0.5">
                  {onMinimize ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={onMinimize}
                          aria-label="Close this column"
                        >
                          <Minus className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Close this column: the session stays in the list</TooltipContent>
                    </Tooltip>
                  ) : null}
                  {onArchive ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={onArchive}
                          aria-label="Archive session"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Archive session</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              ) : null}
            </header>

            <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col">
              {renderTranscript({
                messages,
                messagesStatus,
                historyComplete,
                repairHalt,
                onLoadEarlier: onReload,
                onCompact,
                permissions,
                questions,
                state,
                sending,
                sessionTitle: session?.title,
                onRetryPendingSend,
                onDiscardPendingSend,
              })}
            </div>
          </motion.div>
        ) : pending ? (
          <motion.div
            key={`pending-create-${pending.id}`}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            {/* A draft with a message on its way is already a conversation-shaped thing: it has a
                name, a destination and something the person wrote. The centre pane's blob and
                instruction list would say "nothing has happened yet", which is the opposite. */}
            <header className="flex min-h-11 flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-1 sm:px-4">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={pending.title}>
                {pending.title}
              </span>
              {draftInstance ? (
                <Badge variant="secondary" className="hidden font-normal text-muted-foreground sm:inline-flex">
                  <Box aria-hidden="true" />
                  {draftInstance.label}
                </Badge>
              ) : null}
              {pending.options.directory ? (
                <Badge
                  variant="secondary"
                  className="hidden font-normal text-muted-foreground sm:inline-flex"
                  title={pending.options.directory}
                >
                  <Folder aria-hidden="true" />
                  {normalizeDirectory(pending.options.directory).split(/[\\/]/).filter(Boolean).pop()}
                </Badge>
              ) : null}
            </header>
            <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col">
              {renderTranscript({
                messages: pendingMessages,
                messagesStatus: 'ready',
                // The pane holds every message this conversation has: there is no history above it
                // to load, and the transcript's "earlier messages aren't loaded" line would be a lie.
                historyComplete: true,
                permissions: [],
                questions: [],
                state: 'idle',
                sending: creatingSession,
                creating: creatingSession,
                sessionTitle: pending.title,
                instanceLabel: draftInstance?.label,
                crew: [],
                showAvatars: false,
                showActivityRail: false,
                onRetryPendingSend: () => retryPendingCreate(),
                onDiscardPendingSend: () => editPendingCreate(),
                pendingSendLabels: { retry: 'Try again', discard: 'Edit' },
              })}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key={newSessionInstanceId ? `new-${newSessionInstanceId}` : 'empty'}
            className="flex flex-1 flex-col items-center justify-start gap-3 overflow-y-auto py-4 text-muted-foreground sm:justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            {draftInstance ? (
              <>
                <Blob style={blobStyle} seed={`new:${draftInstance.id}`} identity={draftIdentity} size={48} interactive />
                <div className="flex flex-col items-center gap-1 text-center">
                  <span className="text-[13px] font-medium text-foreground">New agent on {draftInstance.label}</span>
                  <span className="max-w-[420px] truncate text-xs">
                    {draftDirectory.trim() || 'Pick a folder below to get started.'}
                  </span>
                </div>
                {/* What the agent is *for* is the most consequential choice about a new agent, so it
                    is made here, in the middle of the screen, by reading — not from a button on the
                    composer. A radio list with a preview per entry and a Custom at the end: a choice,
                    not a form. Nothing about instructions appears on the composer any more. */}
                {canEditInstructions ? (
                  <div className="flex w-full max-w-[460px] flex-col gap-2 px-4 text-left">
                    <span className="px-0.5 text-[11px] font-medium tracking-wide uppercase text-muted-foreground">
                      Standing instructions
                    </span>
                    <div className="flex flex-col gap-1" role="radiogroup" aria-label="Standing instructions">
                      {INSTRUCTION_PRESETS.map((preset) => {
                        const selected = (instructionsPreset?.id ?? 'classic') === preset.id;
                        return (
                          <div
                            key={preset.id}
                            className={cn(
                              'flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
                              selected ? 'border-ring bg-muted/40' : 'border-border/70'
                            )}
                          >
                            <button
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              onClick={() => setInstructions(preset.instructions)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'size-3.5 flex-none rounded-full border transition-colors',
                                  selected ? 'border-ring bg-highlight/70 ring-2 ring-ring/30' : 'border-muted-foreground/50'
                                )}
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-medium text-foreground">{preset.name}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">{preset.blurb}</span>
                              </span>
                            </button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => setPreviewPreset(preset)}
                              aria-label={`Read the ${preset.name} prompt`}
                              title={`Read the ${preset.name} prompt`}
                              className="flex-none text-muted-foreground hover:text-foreground"
                            >
                              <Eye className="size-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                      {/* Custom is a radio too, but it cannot select anything by itself: it opens the
                          editor, and the list shows it as chosen only when the text matches no preset. */}
                      <div
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
                          instructionsPreset === undefined && instructions.trim()
                            ? 'border-ring bg-muted/40'
                            : 'border-border/70'
                        )}
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={instructionsPreset === undefined && Boolean(instructions.trim())}
                          onClick={openInstructions}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-3.5 flex-none rounded-full border transition-colors',
                              instructionsPreset === undefined && instructions.trim()
                                ? 'border-ring bg-highlight/70 ring-2 ring-ring/30'
                                : 'border-muted-foreground/50'
                            )}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-foreground">Custom</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {instructionsPreset === undefined && instructions.trim()
                                ? 'Your own words — click to edit'
                                : 'Write your own standing instructions'}
                            </span>
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={openInstructions}
                          aria-label="Edit custom standing instructions"
                          title="Edit custom standing instructions"
                          className="flex-none text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="flex -space-x-3">
                  <Blob style={blobStyle} seed="empty one" size={48} interactive />
                  <Blob style={blobStyle} seed="empty two" size={48} interactive />
                  <Blob style={blobStyle} seed="empty three" size={48} interactive />
                </div>
                <span className="text-[13px]">Pick a session, or start a new agent.</span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {selectionComments.position ? (
        <SelectionCommentBar
          position={selectionComments.position}
          quote={selectionComments.quote}
          editing={selectionComments.editing}
          onOpenEditor={selectionComments.openEditor}
          onDismiss={selectionComments.dismiss}
          onAdd={(reply) => {
            addComment(selectionComments.quote, reply);
            selectionComments.dismiss();
          }}
        />
      ) : null}
      {composerKey ? (
        <div className="safe-composer flex-none border-t p-2.5 sm:p-3">
          {/* The region is a boundary plus one surface, not two: this band draws the line against the
              transcript and the input card is the surface inside it. It used to paint its own fill too,
              so the chips and the queue above the input sat on a rectangle inside another rectangle. */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {draftInstance ? (
              <div className="flex items-center gap-1.5 px-0.5" aria-label="New agent options">
                {/* Starting a session freezes its destination: the request is already out, so an
                    editable row would invite edits that change nothing. It thaws on failure,
                    because that is when changing the folder is the fix. */}
                <Select value={draftInstance.id} onValueChange={onNewSessionInstanceChange} disabled={creatingSession}>
                  <SelectTrigger
                    size="sm"
                    aria-label="New agent instance"
                    disabled={creatingSession}
                    className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {instances.filter((candidate) => candidate.attachable).map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <React.Suspense fallback={null}>
                  <ProjectPicker
                    projects={draftProjects}
                    key={draftInstance.id}
                    instance={draftInstance}
                    workspace={workspaceDirectory}
                    recentDirectories={recentDirectories}
                    onWorkspaceChange={(directory) => {
                      onWorkspaceChange?.(draftInstance.id, directory);
                      draftTouchedRef.current.directory = true;
                      setDraftDirectory(directory);
                    }}
                    value={draftDirectory}
                    disabled={creatingSession}
                    onSelect={(directory) => {
                      draftTouchedRef.current.directory = true;
                      setDraftDirectory(directory);
                    }}
                  />
                </React.Suspense>
                <div className="flex-1" />
                <Button variant="ghost" size="icon-sm" className="size-7" onClick={onCancelNewSession} aria-label="Cancel new agent">
                  <X />
                </Button>
              </div>
            ) : null}
            {draftInstance && pendingNoteSummary ? (
              // Notes saved while the session starts have no tray yet: say where they are, or a
              // cleared composer with nothing to show for it reads as a lost note.
              <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground" role="status">
                <NotebookPen className="size-3 flex-none" aria-hidden="true" />
                <span className="min-w-0 truncate" title={pendingNoteSummary}>
                  {pendingNoteSummary}
                </span>
              </div>
            ) : null}
            {session ? (
              <ComposerShelf
                active={shelfSection}
                onActiveChange={setShelfSection}
                open={shelfOpen}
                onOpenChange={setShelfOpen}
                sections={[
                  {
                    id: 'queue',
                    label: 'Queue',
                    count: queueItems.length,
                    // A row that failed to enqueue is stuck until someone acts on it.
                    alert: queueItems.some((item) => Boolean(item.error)),
                    content: (
                      <React.Suspense fallback={null}>
                        <QueuedMessageList
                          key={composerKey ?? 'none'}
                          queue={queue}
                          models={models}
                          onSendQueued={onSendQueued}
                          onMoveQueued={onMoveQueued}
                          onRemoveQueued={onRemoveQueued}
                          onParkQueued={parkQueuedItem}
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
                          canSend={loadedComposerKey === composerKey}
                          onSend={sendNote}
                          onBringBack={bringBackNote}
                          onDelete={(note) => {
                            if (notesKey) onDeleteNote(notesKey, note.id);
                          }}
                        />
                      </React.Suspense>
                    ),
                  },
                  // What this agent's commands left running, and Ember's deadline for it. Its own
                  // tray rather than a row above the input: a notice that pushes the composer down
                  // moves the thing being typed in, every time a dev server starts or stops.
                  ...(session.processes && session.processes.count > 0 && onStopProcesses
                    ? [
                        {
                          id: 'processes' as const,
                          label: processesSectionLabel,
                          count: session.processes.count,
                          alert: processesNeedAttention(
                            session.processes,
                            session.hostMemory,
                            processExtensionFor(session)
                          ),
                          content: (
                            <SessionProcessesNotice
                              // Keyed by the session: a refusal belongs to the process it was asked
                              // about, not to whatever column is open next.
                              key={`processes-${session.instanceId}::${session.id}`}
                              processes={session.processes}
                              {...(session.hostMemory ? { memory: session.hostMemory } : {})}
                              {...(instanceLabel ? { hostLabel: instanceLabel } : {})}
                              extensionMs={processExtensionFor(session)}
                              {...(onExtendProcesses ? { onExtend: () => onExtendProcesses(session) } : {})}
                              onStop={(pids, options) => onStopProcesses(session, pids, options)}
                            />
                          ),
                        },
                      ]
                    : []),
                  ...(onOpenWorker
                    ? [
                        {
                          id: 'crew' as const,
                          label: 'Crew',
                          count: crew.length + (nestedBlocked?.length ?? 0),
                          alert: crewNeedsInput,
                          content: (
                            <CrewStrip
                              workers={crew}
                              nestedBlocked={nestedBlocked}
                              onOpenWorker={onOpenWorker}
                              peerFor={workerPeer}
                              blobStyle={blobStyle}
                              stateFor={workerState}
                              autoAcceptFor={workerAutoAccept}
                              onToggleYolo={onToggleWorkerYolo}
                              identityFor={identityFor}
                              // The leader's own blob colour, so the crew's chips read as one family
                              // without recolouring a worker's blob (that has to keep matching its
                              // column). `identity` is the exact object the leader's own column
                              // draws, and it is stable across polls, so the memo holds.
                              leaderIdentity={identity}
                              leaderTitle={session.title?.trim() || undefined}
                            />
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
            {session ? (
              <CommentTray
                comments={comments}
                sending={commentsSending}
                canSend={loadedComposerKey === composerKey && !modelError}
                onChangeReply={updateCommentReply}
                onRemove={removeComment}
                onSend={() => void sendComments()}
              />
            ) : null}
            {session && onAskSideQuestion && (sideQuestionOpen || askingSideQuestion) ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const trimmed = sideQuestionText.trim();
                  if (!trimmed || askingSideQuestion) return;
                  void onAskSideQuestion(trimmed).then((ok) => {
                    if (ok) {
                      setSideQuestionText('');
                      setSideQuestionOpen(false);
                    }
                  });
                }}
                className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs"
              >
                <CircleHelp className="size-3.5 flex-none text-highlight" aria-hidden="true" />
                <input
                  ref={sideQuestionInputRef}
                  type="text"
                  value={sideQuestionText}
                  disabled={askingSideQuestion}
                  onChange={(event) => setSideQuestionText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      if (!askingSideQuestion) {
                        setSideQuestionOpen(false);
                      }
                    }
                  }}
                  placeholder="Ask about this conversation — the answer comes back as a worker's report"
                  aria-label="Side question"
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"
                />
                <Button
                  type="submit"
                  size="xs"
                  variant="secondary"
                  disabled={!sideQuestionText.trim() || askingSideQuestion}
                  className="h-6 px-2 text-[11px]"
                >
                  {askingSideQuestion ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      <span>Asking…</span>
                    </>
                  ) : (
                    'Ask'
                  )}
                </Button>
                <button
                  type="button"
                  disabled={askingSideQuestion}
                  onClick={() => setSideQuestionOpen(false)}
                  aria-label="Cancel side question"
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              </form>
            ) : null}
            <motion.div
              layout
              // Focus is a soft outer glow, never a recoloured or thickened border and never a
              // `ring-*` / `inset-ring` utility. Earlier attempts drew concentric arcs at the 14px
              // corner (`ring`, `inset-ring`, and a 2px recoloured border) that rounded to different
              // pixel columns and broke into a dotted double hairline at 1:1. A blurred outer
              // `box-shadow` (`has-focus-visible:shadow-[…]`) has one curve and falls off smoothly
              // while the border keeps its own colour at every state (`focus-within` and
              // `:focus-visible` stay distinct: clicking a row control does not trigger the glow).
              data-composer-surface
              style={session ? { backgroundImage: `radial-gradient(ellipse at top left, color-mix(in oklab, ${blobColor(blobStyle, identity)} 10%, transparent), transparent 75%)` } : undefined}
              className="group/composer flex flex-col rounded-xl border bg-background transition-shadow duration-200 has-focus-visible:shadow-[0_0_12px_-2px_color-mix(in_oklab,var(--ring)_28%,transparent)]"
            >
            {session ? <ComposerIdentity name={session.title?.trim() || session.id} seed={seed} identity={identity} style={blobStyle} mood={mood} /> : null}
            {replyContext ? (
              /* A left accent carries "this is quoted" without drawing a rectangle inside the
                 composer's rectangle. */
              <div className="mx-2 mt-2 flex items-start gap-2 rounded-md border-l-2 border-highlight/60 bg-muted/40 py-2 pr-2 pl-2.5 text-[11.5px]">
                <Reply className="mt-0.5 size-3.5 flex-none text-highlight" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">Replying with context</span>
                  <span className="truncate text-muted-foreground">
                    {messageContextText(replyContext).replace(/\s+/g, ' ').slice(0, 180)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyContext(null)}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Remove reply context"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : null}
            {modelError ? <div role="alert" className="mx-3 mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
              <span className="min-w-0 break-words">{modelError} Your draft is kept.</span>
              {onModelsRefresh ? <button type="button" className="underline" onClick={onModelsRefresh}>Refresh models</button> : null}
            </div> : null}
            {mentionOpen ? (
              <MentionSuggest
                names={mentionOptions}
                activeIndex={mentionIndex}
                onHover={setMentionIndex}
                onPick={(name) => {
                  const applied = applyMention(text, mention!, name);
                  setText(applied.text);
                  setMention(null);
                  if (composerKey) {
                    updateComposerDraft(composerKey, {
                      text: applied.text,
                      modelId,
                      variant,
                      attachments,
                      replyContext,
                    });
                  }
                  window.requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (el) {
                      el.focus();
                      el.setSelectionRange(applied.cursor, applied.cursor);
                    }
                  });
                }}
              />
            ) : null}
            <AutoResizeTextarea
              ref={textareaRef}
              value={text}
              // Raised from 160: a pasted stack trace or a spec hit the old cap at about eight
              // lines and then clipped silently. 320 is roughly a dozen lines of prose — enough for
              // a real draft without the box eating the conversation, and the reader can drag past
              // it whenever they want the whole thing on screen.
              maxHeight={320}
              manualHeight={composerHeight}
              // A drag can go taller than the automatic cap, but not off the bottom of the window:
              // two thirds of the viewport is the most a composer may occupy, dragging included.
              maxManualHeight={Math.round(window.innerHeight * 0.66)}
              onHeightChange={setComposerHeight}
              maxLength={200_000}
              placeholder={
                creatingSession
                  ? 'Type the next message…'
                  : pendingFailed
                    ? 'Try again or edit above to change this'
                    : yeet
                      ? 'Steer the running turn…'
                      : shouldQueue
                        ? 'Queue a follow-up…'
                        : 'Message the agent…'
              }
              aria-label={
                creatingSession
                  ? 'Message to send once this session starts'
                  : pendingFailed
                    ? 'Message (waiting for the session above)'
                    : shouldQueue
                      ? 'Queue a follow-up message'
                      : 'Message the agent'
              }
              aria-expanded={mentionOpen}
              aria-controls={mentionOpen ? 'mention-option-0' : undefined}
              aria-activedescendant={mentionOpen ? `mention-option-${mentionIndex}` : undefined}
              aria-autocomplete={mentionNames.length > 0 ? 'list' : undefined}
              onSelect={(event) => {
                if (mentionNames.length === 0) return;
                const caret = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
                setMention(mentionQueryAt(event.currentTarget.value, caret));
              }}
              onClick={(event) => {
                if (mentionNames.length === 0) return;
                const caret = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
                setMention(mentionQueryAt(event.currentTarget.value, caret));
              }}
              onBlur={() => {
                setMention(null);
              }}
              onPaste={(event) => {
                if (event.clipboardData.files.length === 0) return;
                event.preventDefault();
                void addFiles(event.clipboardData.files);
              }}
              onChange={(event) => {
                setText(event.target.value);
                const next = event.target.value;
                // Track the open `@` query from the caret the browser reports, which is already
                // correct at this point: React's synthetic event fires after the value updates.
                const caret = event.target.selectionStart ?? next.length;
                setMention(mentionNames.length > 0 ? mentionQueryAt(next, caret) : null);
                setMentionIndex(0);
                if (composerKey) {
                  if (
                    event.target.value.trim() ||
                    attachments.length ||
                    replyContext ||
                    touchedComposerChoicesRef.current.has(composerKey)
                  ) {
                    updateComposerDraft(composerKey, {
                      text: event.target.value,
                      modelId,
                      variant,
                      attachments,
                      replyContext,
                    });
                  } else {
                    updateComposerDraft(composerKey, null);
                  }
                }
              }}
              onKeyDown={(event) => {
                // Cmd/Ctrl+Enter parks the draft as a note; plain Enter sends.
                // The suggestion list owns the keys while it is open: Enter must accept the name,
                // never send the message. This is why the check sits above every other binding.
                if (mentionOpen) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setMentionIndex((current) => {
                      const count = mentionOptions.length;
                      return count === 0 ? 0 : (current + delta + count) % count;
                    });
                    return;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    const picked = mentionOptions[mentionIndex];
                    if (picked) {
                      const applied = applyMention(text, mention, picked);
                      setText(applied.text);
                      setMention(null);
                      if (composerKey) {
                        updateComposerDraft(composerKey, {
                          text: applied.text,
                          modelId,
                          variant,
                          attachments,
                          replyContext,
                        });
                      }
                      // Put the caret after the inserted name once React has painted the new value.
                      window.requestAnimationFrame(() => {
                        const el = textareaRef.current;
                        if (el) el.setSelectionRange(applied.cursor, applied.cursor);
                      });
                    }
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (
                  event.key === 'Enter' &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  saveNote();
                  return;
                }
                // Enter on an empty composer pushes the next queued message now, as a steer, instead
                // of waiting for the running turn to finish. Nothing else uses plain Enter when the
                // box is empty, so this costs no existing binding.
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.nativeEvent.isComposing &&
                  !text.trim() &&
                  queue &&
                  queue.items.some((item) => item.mode !== 'steer')
                ) {
                  event.preventDefault();
                  const next = queue.items.find((item) => item.mode !== 'steer');
                  if (next && next.id !== queue.sendingId) void onSendQueued(next.id);
                  return;
                }
                if (
                  event.key === 'ArrowUp' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.nativeEvent.isComposing &&
                  !text.trim() &&
                  lastSentMessage
                ) {
                  event.preventDefault();
                  const recalled = lastSentMessage;
                  setText(recalled);
                  if (composerKey) {
                    updateComposerDraft(composerKey, {
                      text: recalled,
                      modelId,
                      variant,
                      attachments,
                      replyContext,
                    });
                  }
                  window.requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (el) el.setSelectionRange(recalled.length, recalled.length);
                  });
                  return;
                }
                // Alt/Option+Enter skips the queue and sends now. Only while there's a queue to
                // skip — otherwise plain Enter already sends. Shift+Enter stays a newline.
                if (
                  event.key === 'Enter' &&
                  event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  shouldQueue &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit({ forceSend: true });
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              className="min-h-9 w-full bg-transparent px-3 pt-2 pb-1 text-base placeholder:text-muted-foreground focus-visible:border-input focus-visible:ring-0 disabled:cursor-not-allowed sm:px-3.5 sm:text-[13px]"
            />

            <div className="@container flex items-center gap-1 overflow-x-auto px-2 pt-1.5 pb-2 sm:gap-1.5">
              {/* A container, so everything below is a `@[…]` query on *this row's* width, never on
                  the window's. Because this is a block-level `flex` row (not `inline-flex`),
                  `container-type: inline-size` sizes from the parent column rather than collapsing
                  to padding (unlike a shrink-to-fit chip). The row gives affordances up in one order
                  as the column narrows — labels (490px), then the side-question button (470px), then
                  the context meter (440px) — and never gives up the model, attachment or send/stop:
                  those are the composer. Every threshold is well above the row's width at
                  MIN_COLUMN_WIDTH, so the ladder has finished by the time a column is as narrow as
                  it gets. */}
              <Button
                variant="ghost"
                size="sm"
                onMouseEnter={() => void loadModelPicker()}
                onFocus={() => void loadModelPicker()}
                onClick={() => {
                  if (creatingSession) return;
                  setPickerActivated(true);
                  setPickerOpen(true);
                  onModelsRefresh?.();
                }}
                aria-disabled={creatingSession}
                aria-label={creatingSession ? `Model: ${modelButtonLabel} (fixed while the session starts)` : 'Choose model'}
                // min-w-0 + `shrink` (the Button base says shrink-0): the label truncates down to the
                // chevron before any icon-only control gives up space in a skinny column. The wide
                // cap is a *container* query, not `sm:`: it is this row's own width that has to pay
                // for those extra pixels, and on a wide screen with a narrow column the viewport
                // query let the label claim 280px the column did not have. Below 640px the row keeps
                // the tight cap, because until then the labels and both extra controls are claiming
                // the room; a long model name truncates here rather than pushing the row into a
                // sideways scroll.
                className="h-7 min-w-0 max-w-[132px] shrink px-2 text-xs font-normal @[640px]:max-w-[280px]"
              >
                <span className="truncate">{modelButtonLabel}</span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </Button>
              {/* Existing sessions only: a draft picks its prompt as cards in the centre panel, so the
                  row does not offer a second, smaller-looking route to the same choice. */}
              {/* No instructions control here, by request: what an agent is *for* is decided in the
                  middle of the new-session screen, and an existing session edits it from the view
                  menu's "This session" line. A small dropdown in the composer row read as a setting,
                  which is the opposite of what a prompt is. */}
              {reasoningLevels.length > 1 ? (
                // Only rendered when the model offers a real choice, so the row never grows a
                // control that does nothing.
                <ReasoningLevelPicker
                  levels={reasoningLevels}
                  value={reasoningValue}
                  onChange={(next) => {
                    setVariant(next);
                    updateComposerChoices({ variant: next });
                  }}
                />
              ) : null}
              {pickerActivated ? (
                <React.Suspense fallback={<ModelPickerFallback />}>
                  <ModelPicker
                    open={pickerOpen}
                    instanceId={session?.instanceId ?? draftInstanceId ?? undefined}
                    directory={session?.directory ?? (draftDirectory || undefined)}
                    models={models}
                    recentModels={recentModels}
                    value={modelId}
                    variant={variant}
                    defaultModelId={defaultModelId}
                    collapseProviders
                    onSelect={(next, nextVariant) => {
                      setModelId(next);
                      setVariant(nextVariant);
                      updateComposerChoices({ modelId: next, variant: nextVariant });
                    }}
                    onOpenChange={setPickerOpen}
                    onRefresh={onModelsRefresh}
                    instanceLabel={instanceLabel ?? draftInstance?.label}
                    {...(onOpenProviders && (session?.instanceId ?? draftInstanceId)
                      ? {
                          onAddProviders: () =>
                            onOpenProviders((session?.instanceId ?? draftInstanceId) as string),
                        }
                      : {})}
                  />
                </React.Suspense>
              ) : null}

              <Toggle
                pressed={effectiveBypass}
                disabled={creatingSession}
                onPressedChange={(enabled) => {
                  if (draftInstanceId) {
                    draftTouchedRef.current.bypass = true;
                    setDraftBypass(enabled);
                  } else {
                    onBypassChange(enabled);
                  }
                }}
                variant="outline"
                size="sm"
                aria-label={effectiveBypass ? 'YOLO mode on: permission prompts are accepted automatically' : 'YOLO mode off'}
                title={
                  effectiveBypass
                    ? 'YOLO mode: permission prompts for this session are accepted automatically, even while Ember is closed'
                    : 'YOLO mode: accept permission prompts for this session automatically'
                }
                // Icon-only below the container query, so the horizontal padding and the
                // icon/label gap both have to shrink with it: at `px-2` + `gap-2` a lone shield sat
                // in 8px of dead space either side. `px-1.5` and `gap-1` are what the icon actually
                // needs, and the word adds its own space when it appears.
                className="h-7 flex-none gap-1 px-1.5 text-xs data-[state=on]:border-warning/60 data-[state=on]:bg-warning/10 data-[state=on]:text-warning @[490px]:pr-2"
              >
                <YoloLabel labelClassName="hidden @[490px]:inline" />
              </Toggle>

              <Toggle
                pressed={yeet}
                disabled={creatingSession}
                onPressedChange={toggleYeet}
                variant="outline"
                size="sm"
                aria-label={yeet ? 'YEET mode on: messages steer the running turn instead of queueing' : 'YEET mode off: messages queue behind the running turn'}
                title={
                  yeet
                    ? 'YEET mode: every message steers the running turn, interrupting what the agent is doing'
                    : 'YEET mode: send every message straight into the running turn instead of queueing it'
                }
                className="h-7 flex-none gap-1 px-1.5 text-xs data-[state=on]:border-destructive/60 data-[state=on]:bg-destructive/10 data-[state=on]:text-destructive @[490px]:pr-2"
              >
                <Zap className="size-3.5 flex-none" />
                <span className="hidden @[490px]:inline">Yeet</span>
              </Toggle>

              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              {active ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 flex-none"
                  aria-label="Attach a file"
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip />
                </Button>
              ) : null}

              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <AnimatePresence>
                  {attachments.map((file, index) => (
                    <motion.span
                      key={`${file.filename}-${index}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -6 }}
                      className="flex max-w-[160px] flex-none items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {file.mime.startsWith('image/') ? (
                        <img src={file.url} alt="" className="size-4 rounded-sm object-cover" />
                      ) : null}
                      <span className="truncate">{file.filename}</span>
                      <button
                        type="button"
                        className="rounded p-0.5 hover:text-foreground"
                        onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                        aria-label={`Remove ${file.filename}`}
                      >
                        <X className="size-3" />
                      </button>
                    </motion.span>
                  ))}
                </AnimatePresence>
                {attachmentError ? (
                  <span className="flex-none text-[11px] text-destructive">{attachmentError}</span>
                ) : null}
              </div>

              {active && session && contextMeter.kind !== 'none' ? (
                // Fourth rung, and the last control to go — the column is close to
                // MIN_COLUMN_WIDTH when this hides, and context is still readable from the
                // session details view. ContextMeter takes no className, so the width condition
                // lives on a wrapper.
                <div className="hidden @[440px]:flex">
                  <ContextMeter state={contextMeter} compacting={compacting} turnBusy={turnBusy} onCompact={onCompact} />
                </div>
              ) : null}

              {active && session && onAskSideQuestion ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setSideQuestionOpen((open) => {
                          const next = !open;
                          if (next) {
                            window.requestAnimationFrame(() => sideQuestionInputRef.current?.focus());
                          }
                          return next;
                        });
                      }}
                      disabled={askingSideQuestion}
                      aria-label="Ask a side question"
                      aria-expanded={sideQuestionOpen}
                      // Third rung: sits between the labels' (490px) and the context meter's (440px)
                      // so the ladder runs in one direction as the column narrows.
                      className={cn(
                        'hidden size-7 flex-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50 @[470px]:flex',
                        sideQuestionOpen && 'bg-muted text-foreground'
                      )}
                    >
                      {askingSideQuestion ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <CircleHelp className="size-3.5" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {askingSideQuestion
                      ? 'Asking in a side worker…'
                      : 'Ask a side question ("btw …") — forks a worker with this context and reports back without interrupting'}
                  </TooltipContent>
                </Tooltip>
              ) : null}

              <AnimatePresence>
                {busy && session ? (
                  <motion.div
                    key="stop"
                    className="flex-none"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.12 }}
                  >
                    <Button
                      size="icon-sm"
                      variant="secondary"
                      className="size-7 rounded-full"
                      onClick={onAbort}
                      disabled={stoppingNow}
                      aria-label={stoppingNow ? 'Stopping' : 'Stop generating'}
                      title={stoppingNow ? 'Stopping…' : 'Stop generating'}
                    >
                      {stoppingNow ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Square className="size-3 fill-current" />
                      )}
                    </Button>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {active && (session || (pending && onSaveDraftNote)) ? (
                <Tooltip>
                <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 flex-none rounded-full text-muted-foreground aria-disabled:opacity-50"
                  aria-disabled={!text.trim()}
                  onClick={saveNote}
                  aria-label={session ? 'Save as note' : 'Save as a note for this session'}
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                >
                  <NotebookPen className="size-3.5" />
                </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {session
                    ? shortcutLabel('Save as note · Mod+Enter')
                    : 'Park this for the session that is starting · Mod+Enter'}
                </TooltipContent>
                </Tooltip>
              ) : null}

              <Tooltip><TooltipTrigger asChild>
              <Button
                size="icon-sm"
                className="size-7 flex-none rounded-full group-has-focus-visible/composer:not-aria-disabled:bg-highlight group-has-focus-visible/composer:not-aria-disabled:text-highlight-foreground group-has-focus-visible/composer:not-aria-disabled:hover:bg-highlight/90 aria-disabled:bg-muted aria-disabled:text-muted-foreground aria-disabled:opacity-50"
                aria-disabled={!canSend}
                onClick={() => submit()}
                aria-label={
                  creatingSession
                    ? canSend
                      ? 'Send once this session starts'
                      : 'Starting this session'
                    : pendingFailed
                      ? 'Waiting for the session above'
                      : shouldQueue
                        ? 'Queue message'
                        : 'Send'
                }
                aria-keyshortcuts="Enter"
              >
                {/* A held message is a real action once the session starts, so it keeps the arrow:
                    a spinner there would say the click was already sent. */}
                {creatingSession ? (
                  canSend ? <ArrowUp /> : <Loader2 className="size-3.5 animate-spin" />
                ) : sending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp />
                )}
              </Button>
              </TooltipTrigger><TooltipContent>
                {creatingSession ? (
                  <>
                    <div>
                      Starting this session
                      {draftInstance ? ` on ${draftInstance.label}` : ''}…
                    </div>
                    <div>
                      {canSend
                        ? 'Enter holds this message until it starts'
                        : 'Type the next message now — it goes as soon as it starts'}
                    </div>
                  </>
                ) : pendingFailed ? (
                  <div>Try again or Edit above before sending another message</div>
                ) : (
                  <>
                    <div>{shouldQueue ? 'Queue message · Enter' : 'Send · Enter'}</div>
                    <div>New line · Shift+Enter</div>
                    {shouldQueue ? <div>{shortcutLabel('Send now · Alt+Enter')}</div> : null}
                    {statusUnknown ? <div>Status unknown — sending still works</div> : null}
                    {!text ? <div>Recall last message · ↑</div> : null}
                  </>
                )}
              </TooltipContent></Tooltip>
            </div>
            </motion.div>
          </div>
        </div>
      ) : null}
      </div>

      <Dialog open={previewPreset !== null} onOpenChange={(next) => { if (!next) setPreviewPreset(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{previewPreset?.name ?? 'Prompt'}</DialogTitle>
            <DialogDescription>
              {previewPreset?.note ?? 'Exactly what this session is told, before anything you type.'}
            </DialogDescription>
          </DialogHeader>
          {previewPreset?.instructions ? (
            <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {previewPreset.instructions}
            </pre>
          ) : null}
          <DialogFooter>
            <Button
              disabled={!previewPreset}
              onClick={() => {
                if (previewPreset) setInstructions(previewPreset.instructions);
                setPreviewPreset(null);
              }}
            >
              Use this
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Standing instructions</DialogTitle>
            <DialogDescription>
              {draftInstanceId
                ? "What this agent is for. It becomes part of the session's own prompt, before anything you type — not a first message."
                : "What this agent is for. Saved to the session itself and applied from its next turn — not sent as a message."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              {INSTRUCTION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setInstructionsDraft(preset.instructions)}
                  className={cn(
                    'rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-muted/60',
                    instructionsDraft === preset.instructions && 'border-ring bg-muted/40'
                  )}
                >
                  <span className="block text-xs font-medium">{preset.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{preset.blurb}</span>
                </button>
              ))}
            </div>
            {instructionsLoading ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Reading this session's current prompt…
              </span>
            ) : null}
            <Textarea
              value={instructionsDraft}
              onChange={(event) => setInstructionsDraft(event.target.value)}
              placeholder="Or write your own — leave empty for none."
              aria-label="Standing instructions text"
              className="min-h-32 text-xs"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setInstructionsDraft('');
                if (draftInstanceId) setInstructions('');
                else void saveInstructions();
              }}
            >
              Clear
            </Button>
            <Button disabled={instructionsLoading} onClick={() => void saveInstructions()}>
              {draftInstanceId ? 'Use these' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dragging ? (
        <div
          data-testid="drop-overlay"
          className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ring bg-background/80 text-sm text-muted-foreground"
        >
          <Paperclip className="size-4" />
          Drop to attach
        </div>
      ) : null}
    </main>
  );
}

const MemoChatView = React.memo(ChatView);
export default function StableChatView(props: Props) {
  return <MemoChatView {...useStableProps(props)} />;
}
