import { expect, test } from 'bun:test';
import { annotationDraftMemory, rememberAnnotationDraft, type AnnotationDraft } from '../src/lib/annotationDraftMemory';

const draft: AnnotationDraft = { text: 'Keep this thought', requestId: 'attempt-1', source: { sessionKey: 'host::one', quote: 'same', spans: [{ messageId: 'm', partId: 'p', start: 5, end: 9, quote: 'same', text: 'same same' }] } };
test('annotation memory retains text and exact source only for its original session', () => {
  annotationDraftMemory.clear();
  rememberAnnotationDraft('host::one', draft);
  expect(annotationDraftMemory.get('host::one')).toBe(draft);
  rememberAnnotationDraft('host::two', draft);
  expect(annotationDraftMemory.has('host::two')).toBe(false);
  rememberAnnotationDraft('host::one', null);
  expect(annotationDraftMemory.size).toBe(0);
});
test('empty, whitespace-only and orphaned drafts cannot become resumable', () => {
  for (const invalid of [{ ...draft, text: '  ' }, { ...draft, source: { ...draft.source, quote: '' } }, { ...draft, source: { ...draft.source, spans: [] } }]) {
    rememberAnnotationDraft('host::one', invalid);
    expect(annotationDraftMemory.has('host::one')).toBe(false);
  }
});

test('a delayed completion clears only its matching origin, not another session with the same annotation text', async () => {
  const { completeAnnotationDraft } = await import('../src/lib/annotationDraftMemory');
  const submitted = { ...draft, requestId: 'pending-note' };
  const other = { ...submitted, source: { ...draft.source, sessionKey: 'host::two' }, requestId: 'new-attempt' };
  rememberAnnotationDraft('host::one', submitted);
  rememberAnnotationDraft('host::two', other);
  const current = { key: 'host::two', draft: other };
  expect(completeAnnotationDraft('host::one', submitted, current)).toBe(false);
  expect(annotationDraftMemory.has('host::one')).toBe(false);
  expect(annotationDraftMemory.get('host::two')).toBe(other);
  expect(current.draft).toBe(other);
  expect(completeAnnotationDraft('host::two', other, current)).toBe(true);
});
test('a same-session replacement source or request is not consumed by an older completion', async () => {
  const { completeAnnotationDraft } = await import('../src/lib/annotationDraftMemory');
  for (const replacement of [{ ...draft, source: { ...draft.source } }, { ...draft, requestId: 'new' }]) {
    rememberAnnotationDraft('host::one', replacement);
    expect(completeAnnotationDraft('host::one', draft, { key: 'host::one', draft: replacement })).toBe(false);
    expect(annotationDraftMemory.get('host::one')).toBe(replacement);
  }
});
