import type { QuoteDestination, QuoteLink, SessionNote } from '../types';

/** Mutation receipts, not queue contents, authorize moving links to a replacement identity. */
export const replaceAnnotationDestinations = (links: readonly QuoteLink[], sessionKey: string, ids: readonly string[], destination?: Pick<QuoteDestination, 'kind' | 'id'>): QuoteLink[] => links.flatMap((link) => {
  if (link.destination.kind !== 'queue' || link.destination.sessionKey !== sessionKey || !ids.includes(link.destination.id)) return [link];
  return destination ? [{ ...link, destination: { ...destination, sessionKey } }] : [];
});

/** Note deletion and bounded-store eviction have the same cleanup rule. */
export const pruneAnnotationNotes = (links: readonly QuoteLink[], notes: Record<string, SessionNote[]>): QuoteLink[] => links.filter((link) => link.destination.kind !== 'note' || Boolean(notes[link.destination.sessionKey]?.some((note) => note.id === link.destination.id)));
