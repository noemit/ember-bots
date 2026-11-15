import type { QuoteAnchor, QuoteLink } from '../types';
import { addNote, updateNote, type NotesStore } from './noteStore';
import { pruneAnnotationNotes } from './annotationDestinations';

/** The editor supplies one stable attempt id. Retrying a lost settings response updates that
 * same note/link, never creates a second note or deduplicates unrelated identical prose. */
export function annotationNotePatch(sessionNotes: NotesStore, quoteLinks: QuoteLink[], key: string, text: string, source: QuoteAnchor, attempt: string) {
  const id = attempt + ':note';
  const link: QuoteLink = { id: attempt + ':link', source, destination: { kind: 'note', sessionKey: key, id } };
  const existing = sessionNotes[key]?.some(note => note.id === id);
  const notes = existing ? updateNote(sessionNotes, key, id, { text }) : addNote(sessionNotes, key, { id, text, quoteLinkId: link.id });
  return { sessionNotes: notes, quoteLinks: pruneAnnotationNotes([...quoteLinks.filter(old => old.id !== link.id), link].slice(-5000), notes), link };
}
