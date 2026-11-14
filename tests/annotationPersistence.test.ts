import { describe, expect, test } from 'bun:test';
import { parseQuoteLinks, parseSessionNotes } from '../electron/transport';
import { submissionReceiptOf } from '../src/api';

const link = () => ({ id: 'quote-test', source: { sessionKey: 'host::chat', quote: 'again', spans: [{ messageId: 'e1', partId: 'e1-0', start: 6, end: 11, quote: 'again', text: 'again again' }] }, destination: { kind: 'queue', sessionKey: 'host::chat', id: '42' } });

describe('durable annotation schema', () => {
  test('round trips exact source offsets and real destination identities', () => {
    const original = link();
    expect(parseQuoteLinks(JSON.parse(JSON.stringify([original])))).toEqual([original]);
  });
  test('old occurrence-only proposals are refused rather than guessed', () => {
    const old = link();
    old.source.spans = [{ messageId: 'e1', partId: 'e1-0', quote: 'again', occurrence: 1 }] as never;
    expect(parseQuoteLinks([old])).toEqual([]);
  });
  test('rejects stale or malformed bounds, missing identities and oversized snapshots', () => {
    for (const patch of [{ start: -1 }, { start: 0.5 }, { end: 900 }, { quote: 'wrong' }, { text: 'x'.repeat(20001) }]) {
      const invalid = link(); Object.assign(invalid.source.spans[0], patch);
      expect(parseQuoteLinks([invalid])).toEqual([]);
    }
    const missing = link(); missing.destination.id = '';
    expect(parseQuoteLinks([missing])).toEqual([]);
    expect(parseQuoteLinks({})).toEqual([]);
  });
  test('deduplicates link IDs but permits duplicate source/destination pairs with independent IDs', () => {
    expect(parseQuoteLinks([link(), link()])).toHaveLength(1);
    expect(parseQuoteLinks([link(), { ...link(), id: 'quote-other' }])).toHaveLength(2);
    expect(parseQuoteLinks(Array.from({ length: 6000 }, (_, i) => ({ ...link(), id: 'quote-' + i })))).toHaveLength(5000);
  });
  test('notes retain their stable IDs and quote relationship over restart', () => {
    const stored = { 'host::chat': [{ id: 'note-stable', text: 'Retained note', quoteLinkId: 'quote-test' }] };
    expect(parseSessionNotes(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });
});

describe('host identity evidence', () => {
  test('canonical entry IDs win and queued submissions stay server IDs', () => {
    expect(submissionReceiptOf({ status: 'placed', submissionId: 42, entry: 57 }, true)).toEqual({ kind: 'message', id: 'e57', submissionId: '42' });
    expect(submissionReceiptOf({ status: 'queued', submissionId: 43 }, true)).toEqual({ kind: 'queue', id: '43' });
    expect(submissionReceiptOf({ status: 'placed', submissionId: 44 }, true)).toEqual({ kind: 'queue', id: '44' });
  });
  test('failures and same-text/time payloads never invent a destination', () => {
    for (const value of [null, {}, { text: 'duplicate', createdAt: 123 }, { status: 'unanswered', submissionId: 42 }, { status: 'queued', submissionId: NaN }]) expect(submissionReceiptOf(value, true)).toBeNull();
  });
  test('legacy hosts use their explicit reply identity', () => {
    expect(submissionReceiptOf({ info: { id: 'server-message' } }, false)).toEqual({ kind: 'message', id: 'server-message' });
  });
});
