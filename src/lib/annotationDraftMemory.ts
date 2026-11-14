import type { QuoteAnchor } from '../types';

export type AnnotationDraft = { text: string; source: QuoteAnchor; requestId: string | null };
/** Unsent annotations are session-local and memory-only, like composer attachments. */
export const annotationDraftMemory = new Map<string, AnnotationDraft>();
export const rememberAnnotationDraft = (key: string | null, draft: AnnotationDraft | null): void => {
  if (!key) return;
  if (draft?.text.trim() && draft.source.quote.trim() && draft.source.spans.length && draft.source.sessionKey === key) annotationDraftMemory.set(key, draft);
  else annotationDraftMemory.delete(key);
};

const sameDraft = (left: AnnotationDraft | null | undefined, right: AnnotationDraft): boolean =>
  Boolean(left && left.text === right.text && left.source === right.source && left.requestId === right.requestId);

/** An old completion may clear its saved origin, never a same-text draft in another session. */
export const completeAnnotationDraft = (
  key: string,
  submitted: AnnotationDraft,
  current: { key: string | null; draft: AnnotationDraft | null },
): boolean => {
  if (sameDraft(annotationDraftMemory.get(key), submitted)) annotationDraftMemory.delete(key);
  return current.key === key && sameDraft(current.draft, submitted);
};
