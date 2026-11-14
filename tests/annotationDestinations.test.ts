import { expect, test } from 'bun:test';
import type { QuoteLink } from '../src/types';
import { replaceAnnotationDestinations, pruneAnnotationNotes } from '../src/lib/annotationDestinations';
const source = { sessionKey: 'host::chat', quote: 'hello', spans: [{ messageId: 'e1', partId: 'e1-0', start: 0, end: 5, quote: 'hello', text: 'hello' }] };
const queued: QuoteLink = { id: 'link-one', source, destination: { kind: 'queue', sessionKey: 'host::chat', id: '42' } };

test('queue canonical transition is identity-only, and keeps duplicates independent', () => {
  const links = [queued, { ...queued, id: 'link-two' }];
  const moved = replaceAnnotationDestinations(links, 'host::chat', ['42'], { kind: 'message', id: 'e70' });
  expect(moved.map((link) => link.destination)).toEqual([{ kind: 'message', sessionKey: 'host::chat', id: 'e70' }, { kind: 'message', sessionKey: 'host::chat', id: 'e70' }]);
  expect(moved.map((link) => link.id)).toEqual(['link-one', 'link-two']);
  expect(replaceAnnotationDestinations(links, 'other::chat', ['42'], { kind: 'message', id: 'e70' })).toEqual(links);
});
test('edit/requeue preserves the source but cancellation removes its link', () => {
  const edited = replaceAnnotationDestinations([queued], 'host::chat', ['42'], { kind: 'queue', id: '43' });
  expect(edited[0].source).toBe(source);
  expect(edited[0].destination.id).toBe('43');
  expect(replaceAnnotationDestinations(edited, 'host::chat', ['42'])).toEqual(edited);
  expect(replaceAnnotationDestinations(edited, 'host::chat', ['43'])).toEqual([]);
});
test('note deletion/eviction cleans only the missing note links', () => {
  const note: QuoteLink = { ...queued, destination: { kind: 'note', sessionKey: 'host::chat', id: 'stable-note' } };
  expect(pruneAnnotationNotes([queued, note], { 'host::chat': [{ id: 'stable-note', text: 'hello' }] })).toEqual([queued, note]);
  expect(pruneAnnotationNotes([queued, note], {})).toEqual([queued]);
});
