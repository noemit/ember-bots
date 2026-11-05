import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { queuedItemText, queuedModeLabel } from '../lib/queueMerge';
import type { QueuedMessage } from '../types';

type Props = {
  /** The queued row being edited; the dialog is open while this is set. */
  item: QueuedMessage;
  /** The row's model as the queue list names it, so Save is obviously keeping it. */
  modelLabel: string;
  /** A queue mutation is already in flight for this row; Save waits for it. */
  busy: boolean;
  onCancel: () => void;
  onSave: (text: string) => void;
};

/**
 * Editing a queued message. The server-owned queue has no edit operation, so Save enqueues the new
 * text and then removes the original with the same mode, model and reasoning variant. The dialog
 * shows the whole message (the composer's box is height-capped) and Esc changes nothing.
 */
export default function EditQueuedMessageDialog({
  item,
  modelLabel,
  busy,
  onCancel,
  onSave,
}: Props) {
  const original = queuedItemText(item);
  const [text, setText] = React.useState(original);
  const trimmed = text.trim();
  const unchanged = trimmed === original.trim();
  const canSave = !busy && trimmed.length > 0 && !unchanged;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    onSave(trimmed);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="w-[620px] sm:max-w-[620px]">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit queued message</DialogTitle>
            <DialogDescription>
              Saving queues the new text, then removes the original. The queue has no edit, so a
              failed removal leaves both rows rather than losing what you wrote.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-normal">
              {queuedModeLabel(item)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Keeps {modelLabel} and its reasoning level.
            </span>
          </div>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            /*
             * Enter saves, Shift+Enter opens a line — the same convention the composer uses, so
             * editing a queued message does not feel like a different editor. A textarea swallows
             * Enter by default, which is why the form-relying default never fired; the modifiers are
             * checked so an IME candidate (isComposing) or Cmd/Ctrl+Enter cannot save by accident.
             */
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!canSave) return;
              onSave(trimmed);
            }}
            // A long queued message has to open at its start, not scrolled to its tail.
            onFocus={(event) => {
              event.currentTarget.scrollTop = 0;
            }}
            autoFocus
            aria-label="Queued message text"
            spellCheck
            className="max-h-[55vh] min-h-56 overflow-y-auto text-sm"
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
