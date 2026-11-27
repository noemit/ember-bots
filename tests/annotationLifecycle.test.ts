import { expect, test } from 'bun:test';
import { confirmAnnotations } from '../src/lib/annotationNavigation';
import { annotationNotePatch } from '../src/lib/annotationNote';
import { parseQuoteLinks, parseSessionNotes } from '../electron/transport';
import type { QuoteAnchor } from '../src/types';

const source: QuoteAnchor = { sessionKey: 'host::chat', quote: 'same', spans: [{ messageId: 'm', partId: 'p', text: 'same same', quote: 'same', start: 5, end: 9 }] };

test('clean navigation stays synchronous and cancellation prevents later guards', async () => {
  expect(confirmAnnotations([() => true])).toBe(true);
  let later = 0;
  expect(confirmAnnotations([() => false, () => { later++; return true; }])).toBe(false);
  expect(await confirmAnnotations([async () => false, () => { later++; return true; }])).toBe(false);
  expect(later).toBe(0);
});

test('dirty navigation waits for actual decisions in order', async () => {
  let resolve!: (allowed: boolean) => void;
  const order: number[] = [];
  const result = confirmAnnotations([() => { order.push(1); return new Promise<boolean>(r => { resolve = r; }); }, () => { order.push(2); return true; }]);
  expect(order).toEqual([1]);
  resolve(true);
  expect(await result).toBe(true);
  expect(order).toEqual([1, 2]);
});

test('lost save-response retries retain one exact note/link; separate annotations remain separate', () => {
  const first = annotationNotePatch({}, [], 'host::chat', 'A thought', source, 'attempt-one');
  const retry = annotationNotePatch(first.sessionNotes, first.quoteLinks, 'host::chat', 'A thought', source, 'attempt-one');
  expect(retry).toEqual(first);
  expect(retry.quoteLinks).toHaveLength(1);
  expect(retry.sessionNotes['host::chat']).toHaveLength(1);
  expect(retry.link.source).toEqual(source);
  const second = annotationNotePatch(retry.sessionNotes, retry.quoteLinks, 'host::chat', 'A thought', source, 'attempt-two');
  expect(second.quoteLinks).toHaveLength(2);
  expect(second.sessionNotes['host::chat']).toHaveLength(2);
});

test('annotationNotePatch IDs survive Electron settings parsers and retry without duplicating', () => {
  const first = annotationNotePatch({}, [], 'host::chat', 'Follow up later', source, 'ql_attempt_1');
  const parsedNotes1 = parseSessionNotes(first.sessionNotes);
  const parsedLinks1 = parseQuoteLinks(first.quoteLinks);

  expect(parsedNotes1['host::chat']).toHaveLength(1);
  expect(parsedLinks1).toHaveLength(1);
  expect(parsedNotes1['host::chat']![0]!.id).toBe(first.link.destination.id);
  expect(parsedNotes1['host::chat']![0]!.quoteLinkId).toBe(first.link.id);
  expect(parsedLinks1[0]!.id).toBe(first.link.id);

  // Retrying the same attempt against parsed settings updates in place rather than duplicating.
  const retry = annotationNotePatch(parsedNotes1, parsedLinks1, 'host::chat', 'Follow up later (edited)', source, 'ql_attempt_1');
  const parsedNotes2 = parseSessionNotes(retry.sessionNotes);
  const parsedLinks2 = parseQuoteLinks(retry.quoteLinks);

  expect(parsedNotes2['host::chat']).toHaveLength(1);
  expect(parsedNotes2['host::chat']![0]!.text).toBe('Follow up later (edited)');
  expect(parsedLinks2).toHaveLength(1);
  expect(parsedLinks2[0]!.id).toBe(retry.link.id);
});
