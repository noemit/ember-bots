import * as React from 'react';
import { Button } from '@/components/ui/button';
import type { CommentBarPosition } from '@/hooks/useSelectionComments';
import { COMMENT_SHORTCUT, shortenQuote } from '@/lib/comments';
import { shortcutLabel } from '@/lib/shortcuts';

/** The quick replies: the three things a comment on a segment usually says. */
export const QUICK_REPLIES = ['Yes', 'No', 'Hold off'] as const;

type Props = {
  position: CommentBarPosition;
  quote: string;
  editing: boolean;
  onOpenEditor: () => void;
  onDismiss: () => void;
  /** Add a comment with this reply text (a chip, or what was typed). */
  onAdd: (reply: string) => void;
};

/**
 * The floating bar that follows a transcript selection: one Comment action plus three quick
 * replies. It is absolutely positioned inside the column (never the viewport), so neither the
 * column's own clipping nor a scroll offset can leave it stranded. Buttons prevent the default
 * mousedown so pressing one keeps the page selection that the click is about.
 */
export default function SelectionCommentBar({
  position,
  quote,
  editing,
  onOpenEditor,
  onDismiss,
  onAdd,
}: Props) {
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const preview = shortenQuote(quote, 80);

  React.useEffect(() => {
    if (!editing) {
      setDraft('');
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  const keepSelection = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div
      role="toolbar"
      aria-label="Comment on the selection"
      style={{ left: position.left, top: position.top }}
      className="absolute z-30 flex max-w-[320px] items-center gap-1 rounded-lg border bg-popover/95 p-1 shadow-lg backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDismiss();
      }}
    >
      {editing ? (
        <>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onAdd(draft);
            }}
            placeholder="Reply to this…"
            aria-label={`Reply to the selected text: ${preview}`}
            title={quote}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/30"
          />
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onMouseDown={keepSelection}
            onClick={() => onAdd(draft)}
            aria-label="Add this comment"
            className="h-7 flex-none px-2 text-[11.5px]"
          >
            Add
          </Button>
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
            title={`Comment on the selection (${shortcutLabel(COMMENT_SHORTCUT)})`}
            aria-label="Comment on the selected text"
            className="h-7 flex-none px-2 text-[11.5px]"
          >
            Comment
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
              className="h-7 flex-none px-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
            >
              {reply}
            </Button>
          ))}
        </>
      )}
    </div>
  );
}
