import { DEFAULT_MODEL } from '../types';
import type { SessionNote } from '../types';

/**
 * The "For later" notes store, as a pure module.
 *
 * Notes are parked thoughts, saved on a timer or during a turn and read days later. Editing one is
 * therefore a plain settings patch, and patches race: two notes saved while one edit is in flight
 * must both survive. Every function here takes the store it was given and returns the next one,
 * touching only the notes it was asked about — which is what keeps an unrelated note (or another
 * session's list) exactly as it was.
 */
export type NotesStore = Record<string, SessionNote[]>;

/** The store's existing shape: at most this many notes per session, oldest dropped first. */
export const MAX_NOTES_PER_SESSION = 100;

/** How long a note's text may be, matching the composer's own cap. */
export const NOTE_TEXT_LIMIT = 20_000;

/** Trimmed, capped text, or `null` when the note would be empty. */
export const cleanNoteText = (text: string): string | null => {
  const clean = text.trim().slice(0, NOTE_TEXT_LIMIT);
  return clean ? clean : null;
};

/** Append one note to a session's list, dropping the oldest past the cap. */
export const addNote = (store: NotesStore, key: string, note: SessionNote): NotesStore => {
  if (!key) return store;
  const clean = cleanNoteText(note.text);
  if (!clean) return store;
  const next = { ...note, id: note.id, text: clean };
  return { ...store, [key]: [...(store[key] ?? []), next].slice(-MAX_NOTES_PER_SESSION) };
};

/**
 * Replace one note's text and model, leaving every other note — in this session and in every
 * other — byte-identical.
 *
 * A note that is no longer there is not resurrected: the person may have sent or deleted it while
 * the editor was open, and a save must not bring back work they finished.
 */
export const updateNote = (
  store: NotesStore,
  key: string,
  noteId: string,
  patch: { text?: string; modelId?: string; variant?: string }
): NotesStore => {
  if (!key) return store;
  const existing = store[key];
  if (!existing) return store;
  const index = existing.findIndex((note) => note.id === noteId);
  if (index < 0) return store;
  const text = patch.text === undefined ? existing[index].text : cleanNoteText(patch.text);
  // Clearing the text would silently delete the note through the editor; refuse instead.
  if (!text) return store;
  const updated: SessionNote = { ...existing[index], text };
  if (patch.modelId === undefined) {
    // Untouched: keep whatever the note already carried.
  } else if (!patch.modelId || patch.modelId === DEFAULT_MODEL) {
    // "The composer's model", said explicitly: the absence of a choice, not a choice of `default`.
    delete updated.modelId;
    delete updated.variant;
  } else {
    updated.modelId = patch.modelId;
    if (patch.variant && patch.variant !== 'default') updated.variant = patch.variant;
    else delete updated.variant;
  }
  const notes = existing.slice();
  notes[index] = updated;
  return { ...store, [key]: notes };
};

/** Remove a note, dropping the session's key when it has none left (the store's own rule). */
export const removeNote = (store: NotesStore, key: string, noteId: string): NotesStore => {
  if (!key) return store;
  const existing = store[key];
  if (!existing?.some((note) => note.id === noteId)) return store;
  const notes = existing.filter((note) => note.id !== noteId);
  const next = { ...store };
  if (notes.length) next[key] = notes;
  else delete next[key];
  return next;
};

/** What a note will be sent with: its own model, or the composer's when it named none. */
export type NoteModelChoice =
  | { kind: 'composer' }
  | { kind: 'note'; modelId: string; variant?: string }
  | { kind: 'unavailable'; modelId: string; variant?: string };

export const noteModelChoice = (note: SessionNote): NoteModelChoice => {
  const modelId = (note.modelId ?? '').trim();
  if (!modelId || modelId === DEFAULT_MODEL) return { kind: 'composer' };
  return { kind: 'note', modelId, ...(note.variant ? { variant: note.variant } : {}) };
};
