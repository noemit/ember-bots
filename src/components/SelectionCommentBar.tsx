import * as React from 'react';
import { ArrowUp, Loader2, NotebookPen, X } from 'lucide-react';
import type { CommentBarPosition } from '@/hooks/useSelectionComments';
import { shortenQuote } from '@/lib/comments';
import { Button } from '@/components/ui/button';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';

type Props = {
  position: CommentBarPosition;
  quote: string;
  reason: string | null;
  draft: string;
  focusEditor: boolean;
  busy: boolean;
  queueing: boolean;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onNote: () => void;
  onDismiss: () => void;
  onDiscard: () => void;
};

/** Floating annotation composer. Its draft belongs to ChatView, so hiding it never discards text. */
export default function SelectionCommentBar({ position, quote, reason, draft, focusEditor, busy, queueing, onDraftChange, onSend, onNote, onDismiss, onDiscard }: Props) {
  const input = React.useRef<HTMLTextAreaElement>(null);
  const group = React.useRef<HTMLDivElement>(null);
  const preview = shortenQuote(quote, 100);
  React.useEffect(() => { if (focusEditor) input.current?.focus(); }, [focusEditor]);
  const keepSelection = (event: React.MouseEvent) => event.preventDefault();
  return (
    <div
      ref={group}
      role="group"
      data-annotation-composer=""
      aria-label="Annotate selected text"
      style={{ left: position.left, top: position.top }}
      className="absolute z-30 flex w-[min(360px,calc(100%-16px))] flex-col gap-2 rounded-lg border bg-popover/40 p-2 shadow-lg backdrop-blur-sm"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onDismiss(); } }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={quote}>“{preview}”</span>
          <Button type="button" size="icon-sm" variant="ghost" className="size-11 flex-none rounded-full text-muted-foreground" disabled={busy} onClick={onDismiss} aria-label="Close annotation editor" title={draft.trim() ? 'Close annotation editor — keep this draft' : 'Close annotation editor'}><X /></Button>
        </div>
        {reason ? <span className="text-[11px] text-destructive" role="status">{reason}</span> : null}
        <AutoResizeTextarea
          ref={input}
          disabled={busy || (Boolean(reason) && !draft)}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (draft.trim() && !reason) onSend();
            }
          }}
          placeholder="Add an annotation"
          aria-label={`Annotation for selected text: ${preview}`}
          title={quote}
          resizable={false}
          maxHeight={Math.round(window.innerHeight * 0.35)}
          className="min-h-8 min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-[12px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/30"
        />
        <span className="sr-only" aria-live="polite">{busy ? 'Saving annotation' : ''}</span>
      </div>
      <div className="flex flex-none items-center justify-end gap-1">
        {draft ? <Button type="button" size="xs" variant="ghost" className="mr-auto min-h-11 min-w-11" disabled={busy} onClick={onDiscard} aria-label="Discard annotation draft" title="Discard only this annotation draft">Discard</Button> : null}
        <Button type="button" size="icon-sm" variant="ghost" className="size-11 flex-none rounded-full text-muted-foreground" disabled={!draft.trim() || busy || Boolean(reason)} onMouseDown={keepSelection} onClick={onNote} aria-label="Save annotation with quote as a note" title="Save annotation with quote as a note">
          <NotebookPen className="size-3.5" />
        </Button>
        <Button type="button" size="icon-sm" className="size-11 flex-none rounded-full disabled:bg-muted disabled:text-muted-foreground" disabled={!draft.trim() || busy || Boolean(reason)} onMouseDown={keepSelection} onClick={onSend} aria-label={queueing ? 'Queue annotation with quote' : 'Send annotation with quote'} title={queueing ? 'Queue annotation with quote' : 'Send annotation with quote'}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </div>
  );
}
