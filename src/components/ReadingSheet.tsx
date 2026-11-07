import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  CornerDownRight,
  ExternalLink,
  Loader2,
  PencilLine,
  Send,
  X,
} from 'lucide-react';
import Blob from '../blob/Blob';
import SheetMessage from './SheetMessage';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import SelectionCommentBar from './SelectionCommentBar';
import { useSelectionComments } from '../hooks/useSelectionComments';
import { commentMemory, sendCommentsLabel, shortenQuote, type TranscriptComment } from '../lib/comments';
import type { UnreadItem } from '../lib/unreadDigest';
import type { AvatarIdentity, BallMood, BlobStyle, ChatMessage, Session } from '../types';

type Props = {
  session: Session;
  /** The unread queue, oldest first: one entry per message, plus any pending request. */
  items: UnreadItem[];
  /** The messages behind those items (a bounded read, never a full transcript). */
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  mood: BallMood;
  identity: AvatarIdentity | undefined;
  blobStyle: BlobStyle;
  projectName?: string;
  instanceLabel: string;
  /**
   * The session's composer key (`instance::session`). Comments drafted here are kept in the same
   * `commentMemory` entry the conversation's comment tray reads, so closing the sheet hands them
   * over instead of dropping them — and nothing is sent from here, so no model has to be guessed.
   */
  commentsKey: string;
  /** The session with the next-oldest unread message, for the "read next" handoff. */
  onClose: () => void;
  /** Re-read the messages after a failed load (never a dead end). */
  onRetry?: () => void;
  /**
   * Park a thought for this session: the same "For Later" card the composer's save-as-note feeds.
   * No model, no send — a note never leaves Ember until you choose to send it from the column.
   */
  onSaveNote?: (text: string) => void;
  /**
   * Send the gathered comments as one message, without leaving the reader. The target and the model
   * are resolved by the caller from *this* session — never from whatever column happens to be
   * selected — and a false answer keeps every draft exactly where it is.
   */
  onSendComments?: (comments: TranscriptComment[]) => Promise<boolean>;
  onMarkRead: (item: UnreadItem) => void;
  onMarkAllRead: () => void;
  /** Open the ordinary conversation, with the composer, for a reply. */
  onOpenColumn: () => void;
  onOpenNext?: () => void;
  nextLabel?: string;
};

const formatTime = (at: number): string =>
  at > 0 ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

/**
 * The reading view: one session's unread messages, whole, over a blurred Home.
 *
 * Home truncates on purpose — it is an index, not a reader — and marking a message read from a
 * two-line excerpt is exactly backwards, so the mark lives here: after the words, never before
 * them. Each message is read in full (prose, folded reasoning, one line per tool, images in the
 * viewer), **Mark read** moves to the next one, and **Mark all read** clears the session. Closing
 * returns to the same list, with whatever was read now showing no dots.
 *
 * Not here yet: sending comments from the sheet. The queue and the marking are the point of this
 * pass; comments need the send path wired.
 */
export default function ReadingSheet({
  session,
  items,
  messages,
  loading,
  error,
  mood,
  identity,
  blobStyle,
  projectName,
  instanceLabel,
  commentsKey,
  onClose,
  onRetry,
  onSaveNote,
  onSendComments,
  onMarkRead,
  onMarkAllRead,
  onOpenColumn,
  onOpenNext,
  nextLabel,
}: Props) {
  const [currentId, setCurrentId] = React.useState<string | null>(items[0]?.id ?? null);
  // Comments drafted while reading. They live in the same per-session memory the conversation's
  // tray reads, so they are already handed over by the time this sheet closes — nothing is sent,
  // and nothing is lost.
  const [comments, setComments] = React.useState<TranscriptComment[]>(
    () => commentMemory.get(commentsKey) ?? []
  );
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [noteDraft, setNoteDraft] = React.useState('');
  const [noteSaved, setNoteSaved] = React.useState(false);
  const [commentsSending, setCommentsSending] = React.useState(false);
  const noteRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!noteOpen) return;
    const frame = window.requestAnimationFrame(() => noteRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [noteOpen]);
  const saveNote = () => {
    const text = noteDraft.trim();
    if (!text) return;
    onSaveNote?.(text);
    setNoteDraft('');
    setNoteOpen(false);
    // A quiet confirmation, because a note goes somewhere you cannot see from here.
    setNoteSaved(true);
    window.setTimeout(() => setNoteSaved(false), 2500);
  };
  const ownerRef = React.useRef(commentsKey);
  ownerRef.current = commentsKey;
  React.useEffect(() => {
    setComments(commentMemory.get(commentsKey) ?? []);
  }, [commentsKey]);
  React.useEffect(() => {
    if (comments.length > 0) commentMemory.set(ownerRef.current, comments);
    else commentMemory.delete(ownerRef.current);
  }, [comments]);

  /** The scrolling text region a selection must fall inside, and the box the bar is placed in. */
  const regionRef = React.useRef<HTMLDivElement>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const selection = useSelectionComments({ regionRef, hostRef, enabled: true });

  const sendComments = async () => {
    if (!onSendComments || comments.length === 0 || commentsSending) return;
    setCommentsSending(true);
    try {
      const sent = await onSendComments(comments);
      // A failure keeps the drafts: the caller has already said why.
      if (sent) setComments([]);
    } finally {
      setCommentsSending(false);
    }
  };

  const addComment = (quote: string, reply: string) => {
    const clean = quote.trim();
    if (!clean) return;
    setComments((current) => [
      ...current,
      { id: `sheet-${Date.now()}-${current.length}`, quote: clean, reply: reply.trim() },
    ]);
    selection.dismiss();
  };

  // The queue shrinks as things are read; keep the cursor on the message that follows the one just
  // marked rather than on an index that now points at something else.
  React.useEffect(() => {
    if (items.length === 0) {
      setCurrentId(null);
      return;
    }
    setCurrentId((current) => (current && items.some((item) => item.id === current) ? current : items[0].id));
  }, [items]);

  const index = Math.max(0, items.findIndex((item) => item.id === currentId));
  const current = items[index] ?? null;
  const message = current ? messages.find((entry) => entry.id === current.id) ?? null : null;
  /** The message before the current one in the transcript: the last thing that was read. */
  const before = React.useMemo(() => {
    if (!message) return null;
    const at = messages.findIndex((entry) => entry.id === message.id);
    for (let cursor = at - 1; cursor >= 0; cursor -= 1) {
      const candidate = messages[cursor];
      if (candidate.role === 'assistant' && candidate.text.trim()) return candidate;
    }
    return null;
  }, [message, messages]);

  const go = (delta: number) => {
    const next = items[index + delta];
    if (next) setCurrentId(next.id);
  };

  const markRead = () => {
    if (!current) return;
    const next = items[index + 1] ?? items[index - 1] ?? null;
    onMarkRead(current);
    if (next) setCurrentId(next.id);
  };

  const title = session.title?.trim() || projectName || session.id;

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Typing in a field (or a disclosure) keeps its own keys.
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'Enter' && target?.closest('button, a, summary, [role="button"]')) return;
      if (event.key === 'j') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'k') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'x' || event.key === 'Enter') {
        event.preventDefault();
        markRead();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-background/35 backdrop-blur-md"
        ref={hostRef}
        className={cn(
          // Grows with the message up to a ceiling: a one-line reply gets a small sheet, not a
          // 900px empty box, and a long one scrolls inside the same frame.
          // `sm:max-w-none` is not optional: the dialog primitive carries a variant-scoped
          // `sm:max-w-lg`, which `max-w-none` alone does not displace (it is not the same
          // variant), so the sheet silently stayed 512px wide.
          'relative flex max-h-[min(88vh,900px)] w-[min(94vw,1100px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none',
          'fixed top-[max(1.5rem,6vh)] left-1/2 translate-x-[-50%] translate-y-0'
        )}
      >
        <header className="flex flex-none items-center gap-2.5 border-b px-4 py-2.5">
          <Blob style={blobStyle} seed={`${session.instanceId}::${session.id}`} identity={identity} mood={mood} size={26} />
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate text-[13.5px] font-semibold">{title}</DialogTitle>
            <DialogDescription className="truncate text-[11px]">
              {[projectName, instanceLabel, `${items.length} unread`].filter(Boolean).join(' · ')}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onOpenColumn}
            aria-label="Open conversation"
            title="Open this conversation, with its composer"
            className="flex-none"
          >
            <ExternalLink />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onMarkAllRead}
            disabled={items.length === 0}
            className="flex-none text-[11px]"
          >
            <CheckCheck />
            Mark all as read
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close reading view">
            <X />
          </Button>
        </header>

        <div ref={regionRef} data-testid="reading-region" className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Reading the messages…
            </p>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
            >
              <p>
                Couldn’t read these messages from {instanceLabel}: {error}. They’re still unread, so
                nothing is lost.
              </p>
              {onRetry ? (
                <Button type="button" size="xs" variant="outline" onClick={onRetry}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}

          {!loading && items.length === 0 ? (
            <div className="flex flex-col items-start gap-2 pt-6">
              <p className="text-[15px] font-medium">You’re caught up on {title}.</p>
              <p className="text-[12.5px] text-muted-foreground">
                Nothing here is waiting for you. New replies appear in the rail as the agent finishes them.
              </p>
              <div className="flex gap-2 pt-2">
                {onOpenNext ? (
                  <Button type="button" size="sm" onClick={onOpenNext}>
                    <CornerDownRight />
                    {nextLabel ?? 'Read the next session'}
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="outline" onClick={onClose}>
                  Back to sessions
                </Button>
              </div>
            </div>
          ) : null}

          {current ? (
            <article className="mx-auto flex w-full max-w-[780px] flex-col gap-4">
              {before ? (
                <div className="border-l-2 border-border/70 pl-3 text-[12.5px] leading-relaxed text-muted-foreground">
                  <p className="pb-1 text-[10.5px] uppercase tracking-wide">
                    Read earlier · {formatTime(before.createdAt ?? 0)}
                  </p>
                  <p className="line-clamp-3 whitespace-pre-wrap">{before.text}</p>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="tabular-nums">{formatTime(current.at)}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {index + 1} of {items.length} unread
                </span>
                {current.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="h-4 px-1.5 text-[9.5px] uppercase tracking-wide">
                    {tag}
                  </Badge>
                ))}
              </div>

              {current.sticky ? (
                // An approval or a question is not prose in the transcript; say so and hand over
                // to the conversation, where the answer controls live.
                <div className="flex flex-col gap-2 rounded-lg border border-highlight/40 bg-highlight/[0.06] p-3">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wide text-highlight">
                    Waiting for your reply
                  </p>
                  <p className="text-[13.5px] leading-relaxed">{current.excerpt}</p>
                  <Button type="button" size="sm" className="w-fit" onClick={onOpenColumn}>
                    <ExternalLink />
                    Answer in the conversation
                  </Button>
                </div>
              ) : message ? (
                <SheetMessage message={message} />
              ) : (
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{current.excerpt}</p>
              )}
            </article>
          ) : null}
        </div>

        {selection.position ? (
          <SelectionCommentBar
            position={selection.position}
            quote={selection.quote}
            editing={selection.editing}
            onOpenEditor={selection.openEditor}
            onDismiss={selection.dismiss}
            onAdd={(reply) => addComment(selection.quote, reply)}
          />
        ) : null}

        {noteOpen ? (
          <div className="flex w-full flex-none items-center gap-2 border-t bg-muted/20 px-4 py-2">
            <input
              ref={noteRef}
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveNote();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setNoteOpen(false);
                  setNoteDraft('');
                }
              }}
              placeholder="Park a note for this session…"
              aria-label="Note for this session"
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/30"
            />
            <Button type="button" size="xs" variant="secondary" onClick={saveNote} disabled={!noteDraft.trim()}>
              Save note
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
          </div>
        ) : null}

        {noteSaved ? (
          <p
            data-testid="sheet-note-saved"
            className="w-full flex-none border-t bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground"
          >
            Saved to For Later. It stays in Ember until you send it from the conversation.
          </p>
        ) : null}

        {comments.length > 0 ? (
          <div
            data-testid="sheet-comments"
            className="max-h-40 w-full flex-none overflow-y-auto border-t bg-muted/20 px-4 py-2"
          >
            <div className="mx-auto flex w-full max-w-[780px] flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-highlight">
                Comments
                <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
                  kept for this conversation until you send them
                </span>
              </p>
              {onSendComments ? (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => void sendComments()}
                  disabled={commentsSending}
                  className="ml-auto h-6 flex-none px-2 text-[11px]"
                  title="Send these comments to this session now"
                >
                  {commentsSending ? <Loader2 className="animate-spin" /> : <Send className="size-3" />}
                  {commentsSending ? 'Sending…' : sendCommentsLabel(comments.length)}
                </Button>
              ) : null}
            </div>
            {comments.map((comment) => (
              <div key={comment.id} className="flex min-w-0 items-start gap-2 text-[11.5px]">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    “{shortenQuote(comment.quote, 90)}”
                  </span>
                  {/* Scrolls rather than clamps: `line-clamp-2` reads as "the rest was cut off",
                      and this tray has no editor to open, so the text had nowhere to be seen in
                      full. The whole reply is also in the title, for a glance. */}
                  {comment.reply ? (
                    <span
                      className="max-h-16 overflow-y-auto whitespace-pre-wrap text-foreground"
                      title={comment.reply}
                    >
                      {comment.reply}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => setComments((current) => current.filter((entry) => entry.id !== comment.id))}
                  className="flex-none rounded text-muted-foreground hover:text-foreground"
                  aria-label={`Remove comment on "${shortenQuote(comment.quote, 40)}"`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            </div>
          </div>
        ) : null}

        <footer className="flex w-full flex-none flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
          <Button type="button" size="sm" variant="outline" onClick={() => go(-1)} disabled={index <= 0}>
            <ArrowLeft />
            Previous
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => go(1)} disabled={index >= items.length - 1}>
            Next
            <ArrowRight />
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setNoteOpen((open) => !open)}
            className="whitespace-nowrap"
            title="Park a note for this session"
          >
            <PencilLine />
            Note
          </Button>
          <Button type="button" size="sm" onClick={markRead} disabled={!current} className="whitespace-nowrap">
            <Check />
            Mark read
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
