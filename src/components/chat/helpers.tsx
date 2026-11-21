import type { ComposerState } from '@/lib/composerDrafts';
import type { QuoteLink } from '@/lib/quoteLinks';
import type { ThreadRow } from '../../lib/crew';
import { isRemoteBrowser } from '../../lib/remoteLifecycle';
import { isSettledFailure, type TranscriptFailureSource } from '../../lib/transcriptStatus';
import {
  DEFAULT_MODEL,
  type BallState,
  type ChatMessage,
  type FileAttachment,
  type MessageQueueSession,
  type MessagesStatus,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type StoredComposerDraft,
} from '../../types';

export const TranscriptFallback = () => (
  <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground" role="status">
    Loading conversation…
  </div>
);

export const YEET_KEY = 'ember.composer.yeet';

export const readYeet = (key: string | null | undefined): boolean => {
  if (!key) return false;
  try {
    return window.localStorage.getItem(`${YEET_KEY}:${key}`) === '1';
  } catch {
    return false;
  }
};

export const writeYeet = (key: string | null | undefined, enabled: boolean): void => {
  if (!key) return;
  try {
    const storageKey = `${YEET_KEY}:${key}`;
    if (enabled) window.localStorage.setItem(storageKey, '1');
    else window.localStorage.removeItem(storageKey);
  } catch {
    // storage unavailable: the toggle still works for this session
  }
};

export const messageContextText = (message: ChatMessage): string =>
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

export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
export const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;
export const STALE_AGENT_MS = 10 * 60_000;
export const MAX_COMPOSER_DRAFTS = 50;

export const saveComposerDraft = (
  drafts: Map<string, ComposerState>,
  key: string,
  state: ComposerState
) => {
  drafts.delete(key);
  drafts.set(key, state);
  if (isRemoteBrowser()) return;
  while (drafts.size > MAX_COMPOSER_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (!oldest) break;
    drafts.delete(oldest);
  }
};

export const composerFromStored = (draft: StoredComposerDraft): ComposerState => ({
  text: draft.text,
  modelId: draft.modelId ?? DEFAULT_MODEL,
  variant: draft.variant ?? '',
  attachments: [],
  replyContext: null,
});

export const storedFromComposer = (state: ComposerState): StoredComposerDraft => {
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

export const readAttachment = (file: File): Promise<FileAttachment> =>
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

export const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
export const EMPTY_QUESTIONS: QuestionRequest[] = Object.freeze([]) as unknown as QuestionRequest[];
export const EMPTY_PERMISSIONS: PermissionRequest[] = Object.freeze([]) as unknown as PermissionRequest[];
export const EMPTY_SESSIONS: Session[] = Object.freeze([]) as unknown as Session[];
export const EMPTY_THREAD_ROWS: ThreadRow[] = Object.freeze([]) as unknown as ThreadRow[];
export const EMPTY_QUOTE_LINK_LIST: QuoteLink[] = Object.freeze([]) as unknown as QuoteLink[];
export const EMPTY_QUEUE_ITEMS: NonNullable<MessageQueueSession['items']> = Object.freeze(
  []
) as unknown as NonNullable<MessageQueueSession['items']>;
export const PENDING_CREATE_LABELS = Object.freeze({ retry: 'Try again', discard: 'Edit' });
