/**
 * Transcript annotations: quote a segment of the reply, say what you think about it, and send the
 * whole set as ONE ordinary user message. Nothing but the words travels, so the agent reads the
 * referent without a protocol, an id or an offset:
 *
 *   1. Re: "we should drop the nightly cron and run it on demand"
 *   Yes, do that.
 *
 *   2. Re: "the export needs a queue"
 *   Hold off on this one.
 *
 * Annotations are transient drafts (a tray above the composer), never the server queue and never a
 * persisted format. Everything here is pure so the wording can be tested without a bridge.
 *
 * The identifiers still say `comment` (`TranscriptComment`, `commentMemory`, this file's name): they
 * are internal, and renaming them would churn every call site for no one's benefit. Only the words a
 * person reads say "annotation".
 */

import type { CommentDelivery } from './commentDelivery';

export type TranscriptComment = {
  id: string;
  /** The selected text, whitespace-normalised. Shortened only when the message is assembled. */
  quote: string;
  /** What the user wants to say about that segment. May be empty (the quote alone is a referent). */
  reply: string;
};

/** How much of a selection is quoted; a giant selection must not dominate the message. */
export const QUOTE_LIMIT = 200;

/**
 * Collapse a selection into readable text: CRLF to LF, runs of spaces/tabs to one space, and no
 * blank-line runs. Selections copied across rendered paragraphs, list items and code blocks arrive
 * with arbitrary indentation, which reads badly once quoted.
 */
export const normaliseSelection = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0\u200b ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * The quote that goes into the message: one line, at most `limit` characters, cut on a word
 * boundary and marked with an ellipsis. A selection that crosses message boundaries arrives as
 * several lines; quoting the whole thing inline is what makes the "Re: …" line readable.
 */
export const shortenQuote = (text: string, limit: number = QUOTE_LIMIT): string => {
  const flat = normaliseSelection(text).replace(/\s*\n\s*/g, ' ');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  // Never cut back further than half the limit, or a long unbroken token would empty the quote.
  const body = boundary > limit / 2 ? cut.slice(0, boundary) : cut;
  return `${body.trimEnd()}…`;
};

/** One numbered block: the quote, then the reply on its own line when there is one. */
export const commentBlock = (comment: TranscriptComment, index: number): string => {
  const quote = shortenQuote(comment.quote);
  const head = quote ? `${index}. Re: "${quote}"` : `${index}.`;
  return comment.reply.trim() ? `${head}\n${comment.reply.trim()}` : head;
};

/** Every comment as the numbered quote blocks, in the order the comments were made. */
export const commentBlocks = (comments: readonly TranscriptComment[]): string =>
  comments.map((comment, index) => commentBlock(comment, index + 1)).join('\n\n');

/**
 * The single user message: the blocks, then the composer's own text once at the end, separated by
 * a blank line. Empty comments are ignored so a cleared row can't leave a hole in the numbering.
 */
export const composeCommentMessage = (
  comments: readonly TranscriptComment[],
  composerText = ''
): string => {
  const blocks = commentBlocks(comments.filter((comment) => comment.quote.trim() || comment.reply.trim()));
  const trailing = composerText.trim();
  return [blocks, trailing].filter((part) => part.length > 0).join('\n\n');
};

/**
 * The shortcut that comments on the current selection. Alt is deliberate: Mod+K (palette),
 * Mod+Enter (save note), Mod+F (find) and Mod+1-9 (columns) are all taken, and Mod+Alt+C is free
 * on every platform Ember runs on.
 */
export const COMMENT_SHORTCUT = 'Mod+Alt+C';

export const isCommentShortcut = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean =>
  (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c';

/**
 * The tray's label, which names the delivery as well as the count.
 *
 * "Send 3 comments" promised a send that did not always happen: on a busy session the assembled
 * message is queued behind the running turn, and in YEET mode it steers into it. The label now says
 * which, from the same `commentDelivery` answer the selection bar's own button uses.
 */
export const sendCommentsLabel = (count: number, delivery: CommentDelivery = 'send'): string => {
  const noun = count === 1 ? 'annotation' : 'annotations';
  switch (delivery) {
    case 'queue': return `Queue ${count} ${noun}`;
    case 'steer': return `Steer ${count} ${noun}`;
    default: return `Send ${count} ${noun}`;
  }
};

/**
 * Comments survive switching columns within a run (a column unmounts when it is closed or
 * scrolled out of the workspace), but they are never written anywhere: the map lives in memory
 * only, like `composerMemory`.
 */
export const commentMemory = new Map<string, TranscriptComment[]>();
