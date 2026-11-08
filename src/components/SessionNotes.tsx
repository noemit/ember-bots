import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { springTransition } from '@/lib/animation';
import TrayItemDialog from './TrayItemDialog';
import TrayRow from './TrayRow';
import type { SessionNote } from '../types';

type Props = {
  notes: SessionNote[];
  canSend?: boolean;
  onSend: (note: SessionNote) => Promise<boolean>;
  onBringBack: (note: SessionNote) => void;
  onDelete: (note: SessionNote) => void;
};

const ICON_BUTTON = 'size-5 max-sm:size-8 rounded text-muted-foreground hover:bg-muted hover:text-foreground';

/**
 * Notes parked from the composer: the shelf's "For later" section. Never dispatched on their own —
 * each row can be sent as-is, brought back into the composer, or deleted, and clicking it reads it.
 *
 * Two-line previews and fine separators match Queue. Actions occupy a reserved lane beneath
 * the text, shown on hover/focus or always on touch, so revealing them cannot reflow the preview.
 */
export default function SessionNotes({ notes, canSend = true, onSend, onBringBack, onDelete }: Props) {
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
                meta="note"
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
        <TrayItemDialog
          open
          title="Note for later"
          text={readingNote.text}
          facts={[{ label: 'Sending', value: 'Nothing is sent until you ask' }]}
          actions={
            <Button
              variant="outline"
              disabled={busyNoteId !== null || !canSend}
              onClick={() => {
                const note = readingNote;
                setReadingId(null);
                void send(note);
              }}
            >
              <ArrowUp />
              Send it now
            </Button>
          }
          onClose={() => setReadingId(null)}
        />
      ) : null}
    </>
  );
}
