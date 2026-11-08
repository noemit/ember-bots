import { stripMarkdown } from '../api';
import { entryOrdinal } from './piMapping';
import { isMessageRead } from './readState';
import type { ChatMessage, QuestionRequest, PermissionRequest, SessionReadMark } from '../types';

/**
 * What Home shows inside a session card: the messages you haven't read, cut short, newest last.
 *
 * A digest is built from a bounded tail or an append read, never a full transcript — Home must stay
 * affordable for a session whose full history is tens of megabytes. It holds excerpts and counts
 * only: no message parts, no image data.
 */

export type UnreadKind = 'message' | 'failure' | 'question' | 'permission';

export type UnreadItem = {
  /** Stable React key: the message id, or the prompt's own id. */
  id: string;
  /** Host entry ordinal, when the wire mints one (`e123` → 123). Null on ordinal-free wires. */
  ordinal: number | null;
  at: number;
  kind: UnreadKind;
  /** Readable text, already cut on a word boundary. Empty for a bare approval request. */
  excerpt: string;
  /** The excerpt was cut, so it must end in "…" even if the line happens to fit. */
  truncated: boolean;
  /** Small facts about the turn: "3 steps", "Failed". */
  tags: string[];
  /**
   * A pending approval or question: it is answered, never marked read, so it survives "Mark all as
   * read" and disappears when the reply lands.
   */
  sticky?: boolean;
};

export type UnreadDigest = {
  /** The `lastEntryId` (or `updated`) the digest was derived from, so a stale one is never shown. */
  version: number;
  items: UnreadItem[];
  /** Every unread message is in `items`; false when the read was capped and more exist. */
  complete: boolean;
};

/** Characters of one message kept for a card row. Two lines at the rail's width is ~200. */
export const UNREAD_EXCERPT_LIMIT = 280;

/** Cut on a word boundary and end in an ellipsis; short text is returned untouched. */
export const excerptText = (text: string, limit = UNREAD_EXCERPT_LIMIT): { excerpt: string; truncated: boolean } => {
  const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return { excerpt: flat, truncated: false };
  const cut = flat.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  // Never cut back past half the budget: one long unbroken token must not empty the excerpt.
  const body = boundary > limit / 2 ? cut.slice(0, boundary) : cut;
  return { excerpt: `${body.trimEnd()}…`, truncated: true };
};

/** A message belongs on Home when it is a finished assistant turn with something to read. */
export const isUnreadEligible = (message: ChatMessage): boolean =>
  message.role === 'assistant' &&
  message.completed &&
  !message.live &&
  // A stop is not news: the user pressed it, so there is nothing to catch up on.
  !message.aborted &&
  // A tool step is execution history, even when it includes commentary and is marked completed.
  // A failed turn still needs the person's attention; a tool's own result/error alone does not.
  (Boolean(message.error) || (
    message.text.trim().length > 0 && !message.parts.some((part) => part.type === 'tool')
  ));

/** Tag facts about the turn that Home can print without the transcript's tool rows. */
const tagsFor = (message: ChatMessage): string[] => {
  if (message.error) return ['Failed'];
  let calls = 0;
  let asking = false;
  message.parts.forEach((part) => {
    if (part.type !== 'tool') return;
    calls += 1;
    if (
      part.call.tool === 'ask' &&
      (part.call.status === 'pending' || part.call.status === 'running')
    ) {
      asking = true;
    }
  });
  const tags: string[] = [];
  if (asking) tags.push('Asking');
  if (calls > 0) tags.push(`${calls} ${calls === 1 ? 'step' : 'steps'}`);
  return tags;
};

/**
 * The unread messages of one session, oldest first.
 *
 * `complete` says whether the read covered everything after the mark: a capped tail that fills its
 * limit can still be hiding older unread turns, and the caller says so instead of inventing a count.
 */
export const digestUnread = (
  messages: readonly ChatMessage[],
  options: { mark: SessionReadMark | undefined; complete: boolean; version: number }
): UnreadDigest => {
  const items: UnreadItem[] = [];
  messages.forEach((message) => {
    if (!isUnreadEligible(message)) return;
    const ordinal = entryOrdinal(message.id);
    const at = message.createdAt ?? 0;
    if (isMessageRead(options.mark, ordinal, at, message.id)) return;
    const { excerpt, truncated } = excerptText(message.text || message.error || '');
    const tags = tagsFor(message);
    items.push({
      id: message.id,
      ordinal,
      at,
      kind: message.error ? 'failure' : tags.includes('Asking') ? 'question' : 'message',
      excerpt,
      truncated,
      tags,
    });
  });
  return { version: options.version, items, complete: options.complete };
};

/**
 * Pending approvals and questions as items to show above the unread messages.
 *
 * They have no transcript position yet, so they carry no ordinal; they are `sticky` so marking
 * everything read leaves them alone. They disappear when answered, which is the only way to clear
 * one, and that is deliberate: a blocked agent is not a read state.
 */
export const promptItems = (
  permissions: readonly PermissionRequest[],
  questions: readonly QuestionRequest[],
  at = 0
): UnreadItem[] => {
  const items: UnreadItem[] = [];
  permissions.forEach((request) => {
    const patterns = request.patterns.filter(Boolean).slice(0, 2).join(', ');
    items.push({
      id: `permission:${request.id}`,
      ordinal: null,
      at,
      kind: 'permission',
      excerpt: patterns ? `Wants to run ${patterns}` : `Wants to use ${request.permission}`,
      truncated: false,
      tags: ['Your call'],
      sticky: true,
    });
  });
  questions.forEach((request) => {
    const first = request.questions[0];
    items.push({
      id: `question:${request.id}`,
      ordinal: null,
      at,
      kind: 'question',
      excerpt: first?.question ?? 'Asked you a question',
      truncated: false,
      tags: ['Your call'],
      sticky: true,
    });
  });
  return items;
};

/**
 * The rows a card should actually draw: the digest's messages minus anything a mark now covers,
 * plus every sticky prompt.
 *
 * A digest is a snapshot of what *was* unread when it was read; a mark can land before the next
 * read (or without one at all), so every consumer filters here rather than trusting the snapshot.
 * That is what makes the dot disappear on the click that marked it.
 */
export const visibleUnreadItems = (
  digest: UnreadDigest | undefined,
  mark: SessionReadMark | undefined
): UnreadItem[] =>
  (digest?.items ?? []).filter((item) => item.sticky || !isMessageRead(mark, item.ordinal, item.at, item.id));

/** Unread first: most unread messages wins, then the most recent activity. */
export const orderUnreadCards = <T extends { count: number; updated: number }>(cards: readonly T[]): T[] =>
  [...cards].sort((a, b) => b.count - a.count || b.updated - a.updated);
