import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Card, CardContent } from '@/components/ui/card';
import { springTransition } from '@/lib/animation';
import { sendCommentsLabel, type TranscriptComment } from '@/lib/comments';

type Props = {
  comments: TranscriptComment[];
  sending: boolean;
  /** Sends every comment as one message; false when the composer can't send at all. */
  canSend: boolean;
  onChangeReply: (id: string, reply: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
};

/**
 * The comment tray above the composer. Rows follow the notes and queue cards' visual language
 * (each row names itself, no icon rail): the quoted segment, then the reply as an editable field.
 * It is a draft, not the queue: nothing dispatches until "Send N comments", which assembles all of
 * them into one ordinary user message.
 */
export default function CommentTray({
  comments,
  sending,
  canSend,
  onChangeReply,
  onRemove,
  onSend,
}: Props) {
  if (comments.length === 0) return null;
  return (
    <Card className="bg-background/80 shadow-sm">
      <CardContent className="flex flex-col gap-1 p-2 text-[11.5px]">
        <div className="flex items-center justify-between gap-2">
          <span className="pl-0.5 font-semibold text-highlight">Comments</span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={sending || !canSend}
            onClick={onSend}
            title="Send every comment as one message"
            className="h-6 px-2 text-[11px]"
          >
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            {sending ? 'Sending…' : sendCommentsLabel(comments.length)}
          </Button>
        </div>
        <ol className="flex max-h-44 min-w-0 flex-col gap-1 overflow-y-auto">
          <AnimatePresence initial={false} mode="popLayout">
            {comments.map((comment, index) => (
              <motion.li
                key={comment.id}
                layout="position"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={springTransition}
                className="flex flex-col gap-1 rounded-md bg-muted/50 px-2 py-1.5"
              >
                <div className="flex items-start gap-2">
                  <span
                    className="min-w-0 flex-1 truncate italic text-muted-foreground"
                    title={comment.quote}
                  >
                    <span className="not-italic text-muted-foreground/70">{index + 1}. </span>
                    &ldquo;{comment.quote}&rdquo;
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => onRemove(comment.id)}
                    aria-label={`Remove comment: ${comment.quote.slice(0, 60)}`}
                    title="Remove comment"
                    className="flex-none text-muted-foreground hover:text-destructive"
                  >
                    <X />
                  </Button>
                </div>
                {/* A growing textarea, not a one-line input.
                    The input was 24px high and scrolled horizontally, so a reply longer than the
                    visible width looked like it had been cut off — every character was there, just
                    out of sight, and coming back to the row showed a single line of it. There is no
                    character limit on a comment; the box was the bug. */}
                <AutoResizeTextarea
                  value={comment.reply}
                  onChange={(event) => onChangeReply(comment.id, event.target.value)}
                  placeholder="What should the agent do about this?"
                  aria-label={`Reply to the quoted segment: ${comment.quote.slice(0, 60)}`}
                  rows={1}
                  maxHeight={140}
                  // Not draggable: the tray scrolls as a whole, and a handle inside it would fight
                  // that scroll and reset on every re-render of the list.
                  resizable={false}
                  className="w-full rounded border border-input bg-background px-1.5 py-1 text-[11.5px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/30"
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </CardContent>
    </Card>
  );
}
