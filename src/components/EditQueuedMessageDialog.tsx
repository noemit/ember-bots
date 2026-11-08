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
import ModelPicker from './ModelPicker';
import { DEFAULT_MODEL, modelRefKey } from '../types';
import { queueReplacementConfig, type QueueReplaceRequest, queuedItemText, queuedModeLabel } from '../lib/queueMerge';
import type { ModelOption, QueuedMessage } from '../types';

type Props = {
  /** The queued row being edited; the dialog is open while this is set. */
  item: QueuedMessage;
  /** The row's model as the queue list names it, so Save is obviously keeping it. */
  modelLabel: string;
  models: ModelOption[];
  instanceId?: string;
  directory?: string;
  defaultModelId?: string | null;
  onModelsRefresh?: () => Promise<unknown> | void;
  /** A queue mutation is already in flight for this row; Save waits for it. */
  busy: boolean;
  onCancel: () => void;
  onSave: (text: string, selection?: QueueReplaceRequest['modelSelection']) => void;
};

/**
 * Editing a queued message. The server-owned queue has no edit operation, so Save enqueues the new
 * text and then removes the original. Model and effort stay unchanged unless explicitly chosen. The dialog
 * shows the whole message (the composer's box is height-capped) and Esc changes nothing.
 */
export default function EditQueuedMessageDialog({
  item,
  modelLabel,
  models,
  instanceId,
  directory,
  defaultModelId,
  onModelsRefresh,
  busy,
  onCancel,
  onSave,
}: Props) {
  const original = queuedItemText(item);
  const [text, setText] = React.useState(original);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [selection, setSelection] = React.useState<QueueReplaceRequest['modelSelection']>();
  const { config, error } = queueReplacementConfig(item.sendConfig, selection, models);
  const modelChanged = selection !== undefined && (
    selection.modelId !== modelRefKey(item.sendConfig) || selection.variant !== (item.sendConfig.variant ?? '')
  );
  const explicitSelection = modelChanged ? selection : undefined;
  const trimmed = text.trim();
  const unchanged = trimmed === original.trim();
  const canSave = !busy && !error && trimmed.length > 0 && (!unchanged || modelChanged);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    onSave(trimmed, explicitSelection);
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
            <Button type="button" variant="outline" size="sm" aria-label="Queued message model"
              disabled={busy || item.pending} onClick={() => setPickerOpen(true)}>
              {selection ? `${config.providerID} / ${config.modelID}${config.variant ? ` · ${config.variant}` : ''}` : modelLabel}
            </Button>
            {item.pending ? <span className="text-xs text-muted-foreground">Choose a model once the host has queued this message.</span> : null}
          </div>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <ModelPicker
            open={pickerOpen} onOpenChange={setPickerOpen}
            instanceId={instanceId} directory={directory} models={models} recentModels={[]}
            value={selection?.modelId ?? modelRefKey(item.sendConfig)}
            variant={selection?.variant ?? item.sendConfig.variant ?? ''}
            defaultModelId={defaultModelId} requireConcreteModel preserveVariantOnModelChange
            onRefresh={onModelsRefresh}
            onSelect={(key, variant) => {
              const chosen = models.find(model => modelRefKey(model) === key) ??
                (key === DEFAULT_MODEL ? models.find(model => modelRefKey(model) === defaultModelId) : undefined);
              if (chosen) setSelection({ modelId: modelRefKey(chosen), variant });
            }}
          />
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
              onSave(trimmed, explicitSelection);
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
