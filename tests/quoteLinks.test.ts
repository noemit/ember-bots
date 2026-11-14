import { describe, expect, test } from 'bun:test';
import {
  MAX_QUOTE_SELECTION_LENGTH,
  MAX_QUOTE_SOURCE_LENGTH,
  annotationMessage,
  normaliseSelection,
  occurrencesOf,
  validateQuoteAnchor,
} from '../src/lib/quoteLinks';
import type { ChatMessage, QuoteAnchor } from '../src/types';

const message = (text: string, id = 'm1', partId = 'p1'): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  parts: [{ type: 'text', id: partId, text }],
  completed: true,
});

const anchor = (text: string, quote: string, start: number, overrides: Partial<QuoteAnchor> = {}): QuoteAnchor => ({
  sessionKey: 'host::session',
  quote,
  spans: [{ messageId: 'm1', partId: 'p1', start, end: start + quote.length, quote, text }],
  ...overrides,
});

describe('quote link anchor helpers', () => {
  test('normalises selection whitespace for the user-facing quote without changing source offsets', () => {
    expect(normaliseSelection('  keep\r\n  going  ')).toBe('keep\ngoing');
    const saved = anchor('say it twice: yes, yes', 'yes', 14);
    expect(validateQuoteAnchor(saved, [message('say it twice: yes, yes')], 'host::session')).toMatchObject({
      valid: true,
      spans: [{ start: 14, end: 17 }],
    });
  });

  test('validates the exact source offset, not phrase occurrence lookup', () => {
    const saved = anchor('same text, same text', 'same', 11);
    expect(validateQuoteAnchor(saved, [message('same text, same text')])).toMatchObject({ valid: true });
    expect(validateQuoteAnchor(saved, [message('same text, same text', 'm1', 'different-part')])).toEqual({ valid: false, reason: 'part-missing' });
  });

  test('does not relocate a quote when the source changes or the source disappears', () => {
    const saved = anchor('one match; then one match', 'one', 12);
    expect(validateQuoteAnchor(saved, [message('changed; one match; one match')])).toEqual({ valid: false, reason: 'source-changed' });
    expect(validateQuoteAnchor(saved, [])).toEqual({ valid: false, reason: 'source-missing' });
    expect(validateQuoteAnchor(saved, [message('one match; then one match')], 'another::session')).toEqual({ valid: false, reason: 'source-missing' });
  });

  test('rejects malformed ranges even if the caller bypasses settings validation', () => {
    const saved = anchor('source text', 'text', 7);
    saved.spans[0].start = 1;
    expect(validateQuoteAnchor(saved, [message('source text')])).toEqual({ valid: false, reason: 'range-invalid' });
  });

  test('occurrence discovery is diagnostic only and reports repeated phrases instead of selecting one', () => {
    expect(occurrencesOf('yes, yes, yes', 'yes')).toEqual([0, 5, 10]);
    expect(occurrencesOf('nothing', 'yes')).toEqual([]);
  });

  test('annotation text names its quote but does not encode implementation offsets', () => {
    expect(annotationMessage('keep the cache', 'Please preserve this behavior.')).toBe('Re: “keep the cache”\n\nPlease preserve this behavior.');
  });

  test('source snapshot and selected quote bounds agree with the persistence schema', () => {
    expect(MAX_QUOTE_SOURCE_LENGTH).toBe(20_000);
    expect(MAX_QUOTE_SELECTION_LENGTH).toBe(4_000);
    expect(validateQuoteAnchor(anchor('abc', 'abc', 0), [message('abc')])).toMatchObject({ valid: true });
    const oversizedSnapshot = anchor('abc', 'abc', 0);
    oversizedSnapshot.spans[0].text = 'x'.repeat(MAX_QUOTE_SOURCE_LENGTH + 1);
    expect(validateQuoteAnchor(oversizedSnapshot, [message('abc')])).toEqual({ valid: false, reason: 'source-changed' });
    const oversizedQuote = anchor('x'.repeat(MAX_QUOTE_SELECTION_LENGTH + 1), 'x'.repeat(MAX_QUOTE_SELECTION_LENGTH + 1), 0);
    expect(validateQuoteAnchor(oversizedQuote, [message(oversizedQuote.spans[0].text)])).toEqual({ valid: false, reason: 'range-invalid' });
  });
});
