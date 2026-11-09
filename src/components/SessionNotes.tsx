import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { springTransition } from '@/lib/animation';
import { DEFAULT_MODEL, modelRefKey } from '../types';
import type { ModelOption, SessionNote } from '../types';
import TrayRow from './TrayRow';
import NoteDialog from './NoteDialog';
import type { NoteModelEdit } from './NoteDialog';

type Props = {
  notes: SessionNote[];
  canSend?: boolean;
  onSend: (note: SessionNote) => Promise<boolean>;
  onBringBack: (note: SessionNote) => void;
  onDelete: (note: SessionNote) => void;
  /** Save an edit made in the note's dialog: its text, its model, or both. */
  onUpdate: (note: SessionNote, patch: { text?: string; modelId?: string; variant?: string }) => void;
  /** The composer's catalogue and choice, so a note can borrow them or name its own. */
  models: ModelOption[];
  modelValue: string;
  modelVariant: string;
  defaultModelId?: string | null;
  instanceDefaultModelId?: string | null;
  recentModels: string[];
  onModelsRefresh?: () => void;
};

const ICON_BUTTON = 'size-5 max-sm:size-8 rounded text-muted-foreground hover:bg-muted hover:text-foreground';

/**
 * Notes parked from the composer: the shelf's "For later" section. Never dispatched on their own —
 * each row can be sent as-is, brought back into the composer, or deleted, and clicking it opens the
 * note to read and edit.
 *
 * Two-line previews and fine separators match Queue. Actions occupy a reserved lane beneath
 * the text, shown on hover/focus or always on touch, so revealing them cannot reflow the preview.
 */
export default function SessionNotes({
  notes,
  canSend = true,
  onSend,
  onBringBack,
  onDelete,
  onUpdate,
  models,
  modelValue,
  modelVariant,
  defaultModelId = null,
  instanceDefaultModelId = defaultModelId,
  recentModels,
  onModelsRefresh,
}: Props) {
  const [busyNoteId, setBusyNoteId] = React.useState<string | null>(null);
  const [readingId, setReadingId] = React.useState<string | null>(null);

  const send = async (note: SessionNote) => {
    if (busyNoteId || !canSend) return;
    setBusyNoteId(note.id);
    try {
      await onSend(note);
    } finally {
      setBusyNoteId((current) => (current === note.id ? null : current));
    }
  };

  // A trace for a reported disappearance: the section renders nothing when it has no notes, so a
  // loss between renders would be silent. This prints once per loss, with what it had before.
  const previousCount = React.useRef(notes.length);
  React.useEffect(() => {
    if (previousCount.current > 0 && notes.length === 0) {
      console.warn('[ember] the notes tray emptied', { had: previousCount.current, now: notes.length });
    }
    previousCount.current = notes.length;
  }, [notes.length]);

  const readingNote = readingId ? notes.find((note) => note.id === readingId) ?? null : null;
  if (notes.length === 0) return null;

  return (
    <>
      <ol className="flex max-h-48 min-w-0 list-none flex-col divide-y divide-border/50 overflow-y-auto" aria-label="Notes for later">
        <AnimatePresence initial={false} mode="popLayout">
          {notes.map((note) => (
            <motion.li
              key={note.id}
              layout="position"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={springTransition}
            >
              <TrayRow
                text={note.text}
                busy={busyNoteId === note.id}
                meta={modelMeta(note, models, modelValue, defaultModelId)}
                openLabel={`Read note: ${note.text.slice(0, 60)}`}
                onOpen={() => setReadingId(note.id)}
                actions={
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={busyNoteId !== null || !canSend}
                      onClick={() => void send(note)}
                      aria-label={`Send note: ${note.text.slice(0, 60)}`}
                      title="Send this note now"
                      className={`${ICON_BUTTON} hover:text-highlight`}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={busyNoteId === note.id}
                      onClick={() => onBringBack(note)}
                      aria-label={`Edit note in composer: ${note.text.slice(0, 60)}`}
                      title="Edit in composer"
                      className={ICON_BUTTON}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={busyNoteId === note.id}
                      onClick={() => onDelete(note)}
                      aria-label={`Delete note: ${note.text.slice(0, 60)}`}
                      title="Delete note"
                      className={`${ICON_BUTTON} hover:text-destructive`}
                    >
                      <Trash2 />
                    </Button>
                  </>
                }
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      {readingNote ? (
        <NoteDialog
          key={readingNote.id}
          open
          note={readingNote}
          models={models}
          modelValue={modelValue}
          modelVariant={modelVariant}
          defaultModelId={defaultModelId}
          instanceDefaultModelId={instanceDefaultModelId}
          recentModels={recentModels}
          busy={busyNoteId !== null}
          canSend={canSend}
          onModelsRefresh={onModelsRefresh}
          onSave={(text, model) => onUpdate(readingNote, { text, modelId: model.modelId, variant: model.variant })}
          onSend={() => {
            const note = readingNote;
            setReadingId(null);
            void send(note);
          }}
          onClose={() => setReadingId(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The row's quiet second line: which model the note will be sent with. A note carrying its own
 * model says so; one that does not names the composer's model, because that is the one it will
 * actually use. It is not a control — the model lives in the dialog.
 */
function modelMeta(
  note: SessionNote,
  models: ModelOption[],
  composerModel: string,
  defaultModelId: string | null
): string {
  const key = note.modelId && note.modelId !== DEFAULT_MODEL ? note.modelId : null;
  const model = (id: string) =>
    models.find((entry) => modelRefKey(entry) === id)?.label ?? id.slice(0, 40);
  if (key) {
    const variant = (note.variant ?? '').trim();
    return `${model(key)}${variant && variant !== 'default' ? ` · ${variant}` : ''}`;
  }
  return `${composerModel === DEFAULT_MODEL ? model(defaultModelId ?? DEFAULT_MODEL) || 'Default model' : model(composerModel)} · with the composer`;
}

export type { NoteModelEdit };
