import * as React from 'react';
import { ArrowUp, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DEFAULT_MODEL } from '../types';
import type { ModelOption, SessionNote } from '../types';
import ModelPicker from './ModelPicker';

/** The model a note is saved with: `modelId` empty means "the composer's model". */
export type NoteModelEdit = { modelId: string; variant: string };

type Props = {
  open: boolean;
  note: SessionNote;
  models: ModelOption[];
  /** The composer's own choice, offered as the default when the note names none. */
  modelValue: string;
  modelVariant: string;
  defaultModelId?: string | null;
  instanceDefaultModelId?: string | null;
  recentModels: string[];
  busy?: boolean;
  canSend?: boolean;
  onModelsRefresh?: () => void;
  onSave: (text: string, model: NoteModelEdit) => void;
  onSend: () => void;
  onClose: () => void;
};

/**
 * One parked note, read and edited in place.
 *
 * Notes used to be read-only here, with editing bequeathed to the composer ("Edit in composer"),
 * which meant a note you simply wanted to reword had to be retyped where it would look like a draft
 * about to be sent. This dialog edits the note itself, and lets it carry the model it should be sent
 * with — a parked "run the tests with the cheap model" is useless if it goes out on whatever the
 * composer happens to be set to.
 *
 * Nothing here is written until Save. Cancel (or Escape, or the close button) discards the draft,
 * so opening a note to read it can never change it.
 */
export default function NoteDialog({
  open,
  note,
  models,
  modelValue,
  modelVariant,
  defaultModelId = null,
  instanceDefaultModelId = defaultModelId,
  recentModels,
  busy = false,
  canSend = true,
  onModelsRefresh,
  onSave,
  onSend,
  onClose,
}: Props) {
  const [text, setText] = React.useState(note.text);
  const [modelId, setModelId] = React.useState(note.modelId ?? '');
  const [variant, setVariant] = React.useState(note.variant ?? '');
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const clean = text.trim();
  const dirty = clean !== note.text || (modelId || '') !== (note.modelId ?? '') || (variant || '') !== (note.variant ?? '');

  const save = () => {
    if (!clean) return;
    onSave(text, { modelId, variant });
    onClose();
  };

  // What the note will be sent with, in the same words the rest of the composer uses.
  const inherits = !modelId || modelId === DEFAULT_MODEL;
  const chosen = models.find((entry) => `${entry.providerID}/${entry.modelID}` === modelId);
  const inherited = models.find((entry) =>
    `${entry.providerID}/${entry.modelID}` === (modelValue === DEFAULT_MODEL ? defaultModelId : modelValue));
  const label = inherits
    ? `Composer's model${inherited ? ` · ${inherited.label}` : ''}`
    : `${chosen?.label ?? modelId}${variant && variant !== 'default' ? ` · ${variant}` : ''}`;
  const stale = !inherits && models.length > 0 && !chosen;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-[620px] sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Note for later</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="text-[11.5px] text-muted-foreground" htmlFor="note-text">Note</label>
          <textarea
            id="note-text"
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter is a newline in a note; Mod+Enter saves, the same as every other text editor here.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
            maxLength={20_000}
            className="min-h-[36vh] max-h-[46vh] resize-y rounded-md border bg-background px-3 py-2 font-sans text-[12.5px] leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px]">
            <span className="text-muted-foreground">Sends with</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 max-w-full gap-1.5 truncate px-2 text-[11.5px] font-normal"
              aria-label="Model this note sends with"
              onClick={() => setPickerOpen(true)}
            >
              <span className="truncate">{label}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
            {inherits ? (
              <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={() => setPickerOpen(true)}>
                Choose a model for this note
              </button>
            ) : (
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => { setModelId(''); setVariant(''); }}
              >
                Use the composer's model
              </button>
            )}
          </div>
          {stale ? (
            <p role="status" className="text-[11.5px] text-destructive">
              {modelId} is not in this instance's catalogue right now. Sending with it is refused until it is back; the note keeps the choice.
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy || !canSend}
            onClick={() => {
              if (dirty) save();
              onSend();
            }}
          >
            <ArrowUp />
            Send it now
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            <X />
            Cancel
          </Button>
          <Button disabled={!clean || !dirty} onClick={save}>
            Save
          </Button>
        </DialogFooter>
        <ModelPicker
          open={pickerOpen}
          models={models}
          recentModels={recentModels}
          value={modelId || DEFAULT_MODEL}
          variant={modelId ? variant : modelVariant}
          defaultModelId={defaultModelId}
          instanceDefaultModelId={instanceDefaultModelId}
          collapseProviders
          onSelect={(key, nextVariant) => {
            setModelId(key === DEFAULT_MODEL ? '' : key);
            setVariant(key === DEFAULT_MODEL ? '' : nextVariant);
          }}
          onOpenChange={setPickerOpen}
          onRefresh={onModelsRefresh}
        />
      </DialogContent>
    </Dialog>
  );
}
