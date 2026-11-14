import * as React from 'react';
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
};

/** Floating annotation composer. Its draft belongs to ChatView, so hiding it never discards text. */
export default function SelectionCommentBar({ position, quote, reason, draft, focusEditor, busy, queueing, onDraftChange, onSend, onNote, onDismiss }: Props) {
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
      className="absolute z-30 flex w-[min(360px,calc(100%-16px))] items-end gap-2 rounded-lg border bg-popover/95 p-2 shadow-lg backdrop-blur-sm"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onDismiss(); } }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="max-w-full truncate text-[11px] text-muted-foreground" title={quote}>“{preview}”</span>
        {reason ? <span className="text-[11px] text-destructive" role="status">{reason}</span> : null}
        <AutoResizeTextarea
          ref={input}
          disabled={busy}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (draft.trim()) onSend();
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
      <div className="flex flex-none flex-col gap-1">
        <Button type="button" size="xs" variant="secondary" disabled={!draft.trim() || busy || Boolean(reason)} onMouseDown={keepSelection} onClick={onSend} aria-label={queueing ? 'Queue annotation with quote' : 'Send annotation with quote'}>
          {queueing ? 'Queue' : 'Send'}
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onDismiss} aria-label="Hide annotation draft">Hide</Button>
        <Button type="button" size="xs" variant="ghost" disabled={!draft.trim() || busy || Boolean(reason)} onMouseDown={keepSelection} onClick={onNote} aria-label="Save annotation with quote as a note">Note</Button>
      </div>
    </div>
  );
}
