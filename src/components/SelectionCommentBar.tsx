import * as React from 'react';
import { Button } from '@/components/ui/button';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import type { CommentBarPosition } from '@/hooks/useSelectionComments';
import { COMMENT_SHORTCUT, shortenQuote } from '@/lib/comments';
import {
  commentDelivery,
  commentSubmitDescription,
  commentSubmitHint,
  commentSubmitLabel,
} from '@/lib/commentDelivery';
import { shortcutLabel } from '@/lib/shortcuts';

/** The quick replies kept for the keyboard path: one press beats typing "yes" for a one-word note. */
export const QUICK_REPLIES = ['Yes', 'No', 'Hold off'] as const;

/** The widest the bar grows before the reply box starts wrapping rather than getting wider. */
const MAX_BAR_WIDTH = 420;

type Props = {
  position: CommentBarPosition;
  quote: string;
  editing: boolean;
  onOpenEditor: () => void;
  onDismiss: () => void;
  /** Add an annotation with this reply text (what was typed). */
  onAdd: (reply: string) => void;
  /** True while the agent is mid-turn or a follow-up is already waiting. */
  busy: boolean;
  /** YEET mode: the reply joins the running turn instead of queueing behind it. */
  yeet: boolean;
};

/**
 * The floating bar that follows a transcript selection.
 *
 * **It opens straight into the reply box.** The old bar showed a `Comment` button next to Yes / No /
 * Hold off chips, so commenting always took two presses and the chips were a guess at what the person
 * meant. Selecting text is already the intent, so the input is focused immediately; the chips remain
 * as one-press shortcuts for a keyboard reader, but they are no longer the headline.
 *
 * **The submit button says what will happen.** Send when the agent is idle, Queue when it is busy,
 * Steer in YEET mode (see `lib/commentDelivery.ts`) — "Add" described the shelf it wrote to and
 * nothing about the consequence.
 *
 * **The box grows with the text.** `AutoResizeTextarea` with `resizable={false}`: a dragged height
 * handle in a floating bar that is itself positioned over the transcript would be noise, but a
 * three-line annotation is common enough that a fixed one-line input hid what was being written.
 *
 * It is absolutely positioned inside the column (never the viewport), so neither the column's own
 * clipping nor a scroll offset can leave it stranded. Buttons prevent the default mousedown so
 * pressing one keeps the page selection that the click is about.
 */
export default function SelectionCommentBar({
  position,
  quote,
  editing,
  onOpenEditor,
  onDismiss,
  onAdd,
  busy,
  yeet,
}: Props) {
  const [draft, setDraft] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const preview = shortenQuote(quote, 80);
  const delivery = commentDelivery({ busy, yeet });

  React.useEffect(() => {
    if (!editing) {
      setDraft('');
      return;
    }
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  // The bar opens in the editor, so `editing` is normally already true. Keep the fallback for the
  // keyboard path, which raises the bar before deciding to focus — a click on the preview promotes
  // it rather than being a dead target.
  React.useEffect(() => {
    if (!editing) return;
    textareaRef.current?.focus();
  }, [editing]);

  const keepSelection = (event: React.MouseEvent) => event.preventDefault();
  const empty = draft.trim().length === 0;

  return (
    <div
      role="toolbar"
      aria-label="Annotate the selection"
      style={{ left: position.left, top: position.top, maxWidth: MAX_BAR_WIDTH }}
      className="absolute z-30 flex items-end gap-1 rounded-lg border bg-popover/95 p-1 shadow-lg backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDismiss();
      }}
    >
      {editing ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className="max-w-full truncate pl-1 text-[10.5px] leading-tight text-muted-foreground"
              title={quote}
            >
              {preview}
            </span>
            <AutoResizeTextarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                if (empty) return;
                onAdd(draft);
              }}
              placeholder="What about it?"
              aria-label={`Reply to the selected text: ${preview}`}
              title={quote}
              // A drag handle in a bar floating over the transcript is noise; growth is automatic.
              resizable={false}
              maxHeight={Math.round(window.innerHeight * 0.4)}
              // `min-h-9` is the component's own floor; the bar is tighter than the composer, so a
              // one-line reply is 28px here and grows as the annotation gets longer.
              className="min-h-7 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-[12px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/30"
            />
          </div>
          <div className="flex flex-none flex-col items-stretch gap-1">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={empty}
              onMouseDown={keepSelection}
              onClick={() => onAdd(draft)}
              title={commentSubmitHint(delivery)}
              aria-label={commentSubmitDescription(delivery, 1)}
              className="h-7 flex-none px-2 text-[11.5px]"
            >
              {commentSubmitLabel(delivery)}
            </Button>
            {QUICK_REPLIES.map((reply) => (
              <Button
                key={reply}
                type="button"
                size="xs"
                variant="ghost"
                onMouseDown={keepSelection}
                onClick={() => onAdd(reply)}
                title={`Quote it and reply "${reply}"`}
                className="h-6 flex-none px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {reply}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <>
          <span className="max-w-[104px] truncate pl-1.5 text-[11px] text-muted-foreground" title={quote}>
            {preview}
          </span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onMouseDown={keepSelection}
            onClick={onOpenEditor}
            title={`Annotate the selection (${shortcutLabel(COMMENT_SHORTCUT)})`}
            aria-label="Annotate the selected text"
            className="h-7 flex-none px-2 text-[11.5px]"
          >
            Annotate
          </Button>
        </>
      )}
    </div>
  );
}
