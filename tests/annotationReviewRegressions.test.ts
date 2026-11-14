import { quoteLinksForMessage } from '../src/lib/quoteLinkScope';
import type { QuoteLink } from '../src/types';
import { expect, test } from 'bun:test';
import { recordAnnotationAcceptance } from '../src/lib/annotationAcceptance';
import { submissionReceiptOf } from '../src/api';
import { messageNavigationAction } from '../src/lib/messageNavigation';

test('unrecognized successful bodies never persist an invented identity or authorize clearing', async () => {
  for (const body of [{}, null, { status: 'unknown' }, { status: 'queued' }, { text: 'same annotation', createdAt: 100 }]) {
    let called = false;
    const result = await recordAnnotationAcceptance(submissionReceiptOf(body, true), async () => { called = true; });
    expect(result.kind).toBe('missing-receipt');
    expect(called).toBe(false);
  }
});
test('canonical acceptance clears only after durable link persistence succeeds', async () => {
  const receipt = { kind: 'message' as const, id: 'e42' };
  expect((await recordAnnotationAcceptance(receipt, async () => { throw new Error('disk unavailable'); })).kind).toBe('persistence-failed');
  let release!: () => void;
  let finished = false;
  const pending = recordAnnotationAcceptance(receipt, () => new Promise<void>((resolve) => { release = resolve; })).then((result) => { finished = true; return result; });
  await Promise.resolve(); expect(finished).toBe(false);
  release(); expect((await pending).kind).toBe('linked');
});
test('unloaded targets retry completed reads, then jump once the target arrives', () => {
  const initial = { found: false, loading: false, complete: false, attempts: 0, canLoad: true };
  expect(messageNavigationAction(initial)).toBe('load');
  expect(messageNavigationAction({ ...initial, loading: true, attempts: 1 })).toBe('wait');
  expect(messageNavigationAction({ ...initial, attempts: 1 })).toBe('load');
  expect(messageNavigationAction({ ...initial, found: true, attempts: 2 })).toBe('jump');
  expect(messageNavigationAction({ ...initial, attempts: 3 })).toBe('unavailable');
  expect(messageNavigationAction({ ...initial, complete: true })).toBe('unavailable');
});

test('backlinks distinguish repeated entry IDs by host and session for both directions', () => {
  const link: QuoteLink = { id: 'scope', source: { sessionKey: 'remote::source', quote: 'same', spans: [{ messageId: 'e1', partId: 'p1', start: 0, end: 4, quote: 'same', text: 'same' }] }, destination: { kind: 'message', sessionKey: 'local::destination', id: 'e2' } };
  expect(quoteLinksForMessage([link], 'local::destination', 'e1')).toEqual([]);
  expect(quoteLinksForMessage([link], 'local::destination', 'e2')).toEqual([{ link, source: false }]);
  expect(quoteLinksForMessage([link], 'remote::source', 'e1')).toEqual([{ link, source: true }]);
  expect(quoteLinksForMessage([link], 'remote::source', 'e2')).toEqual([]);
  expect(quoteLinksForMessage([link], undefined, 'e1')).toEqual([]);
});

test('a canonical annotation echo remains visible across repeated link-save failures', async () => {
  const { preserveAnnotationEcho } = await import('../src/lib/annotationEcho');
  const submitted = (id: string) => ({ id, role: 'user' as const, text: 'same annotation', parts: [{ id: id + '-text', type: 'text' as const, text: 'same annotation' }], completed: true, delivery: 'sending' as const });
  const receipt = { kind: 'message' as const, id: 'e42' };
  let held = [submitted('attempt-one')];
  let canonical = preserveAnnotationEcho(held, ['attempt-one'], receipt, held[0]);
  expect(canonical.map((message) => message.id)).toEqual(['e42']);
  for (const id of ['attempt-two', 'attempt-three']) {
    const next = submitted(id);
    const existing = canonical[0];
    canonical = preserveAnnotationEcho([...canonical, next], ['e42', id], receipt, next);
    expect(canonical).toEqual([existing]);
    expect((await recordAnnotationAcceptance(receipt, async () => { throw new Error('disk still unavailable'); })).kind).toBe('persistence-failed');
    expect(canonical[0].text).toBe('same annotation');
  }
  const echo = { ...canonical[0], delivery: undefined };
  expect(preserveAnnotationEcho([echo, submitted('attempt-four')], ['e42', 'attempt-four'], receipt, submitted('attempt-four'))).toEqual([echo]);
  held = [submitted('queued-attempt')];
  expect(preserveAnnotationEcho(held, ['queued-attempt'], { kind: 'queue', id: '99' }, held[0])).toEqual([]);
});
