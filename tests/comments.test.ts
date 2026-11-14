import { describe, expect, test } from 'bun:test';
import {
  isCommentShortcut,
  normaliseSelection,
  QUOTE_LIMIT,
  shortenQuote,
} from '../src/lib/comments';

describe('normaliseSelection', () => {
  test('collapses indentation, tabs and CRLF from a rendered selection', () => {
    expect(normaliseSelection('  the export\r\n\tneeds   a queue  \r\n')).toBe(
      'the export\nneeds a queue'
    );
  });

  test('keeps paragraph breaks but drops runs of blank lines', () => {
    expect(normaliseSelection('one\n\n\n\ntwo')).toBe('one\n\ntwo');
  });

  test('treats non-breaking spaces as spaces', () => {
    expect(normaliseSelection('run\u00a0it\u00a0now')).toBe('run it now');
  });

  test('an all-whitespace selection is empty', () => {
    expect(normaliseSelection(' \n\t \n')).toBe('');
  });
});

describe('shortenQuote', () => {
  test('a short quote is unchanged (whitespace normalised)', () => {
    expect(shortenQuote('  drop the   cron ')).toBe('drop the cron');
  });

  test('a selection crossing messages becomes one line', () => {
    expect(shortenQuote('first paragraph\nsecond paragraph')).toBe(
      'first paragraph second paragraph'
    );
  });

  test('a long quote is cut on a word boundary and marked with an ellipsis', () => {
    const words = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
    const shortened = shortenQuote(words);
    expect(shortened.endsWith('…')).toBe(true);
    expect(shortened.length).toBeLessThanOrEqual(QUOTE_LIMIT + 1);
    // No half-word at the cut.
    const body = shortened.slice(0, -1);
    expect(words.startsWith(body)).toBe(true);
    expect(words[body.length]).toBe(' ');
  });

  test('a long unbroken token is still cut, rather than emptied', () => {
    const token = 'x'.repeat(QUOTE_LIMIT * 3);
    expect(shortenQuote(token)).toBe(`${'x'.repeat(QUOTE_LIMIT)}…`);
  });

  test('the limit is configurable', () => {
    expect(shortenQuote('alpha beta gamma', 10)).toBe('alpha beta…');
    expect(shortenQuote('abcdefghijklmno', 10)).toBe('abcdefghij…');
  });
});

describe('isCommentShortcut', () => {
  const event = (over: Partial<Parameters<typeof isCommentShortcut>[0]>) => ({
    key: 'c',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  test('Mod+Alt+C on either platform', () => {
    expect(isCommentShortcut(event({ metaKey: true, altKey: true }))).toBe(true);
    expect(isCommentShortcut(event({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCommentShortcut(event({ metaKey: true, altKey: true, key: 'C' }))).toBe(true);
  });

  test('it does not collide with the composer shortcuts', () => {
    expect(isCommentShortcut(event({ ctrlKey: true }))).toBe(false);
    expect(isCommentShortcut(event({ metaKey: true }))).toBe(false);
    expect(isCommentShortcut(event({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isCommentShortcut(event({ ctrlKey: true, altKey: true, key: 'k' }))).toBe(false);
    expect(isCommentShortcut(event({ ctrlKey: true, altKey: true, key: 'f' }))).toBe(false);
    expect(isCommentShortcut(event({ ctrlKey: true, altKey: true, key: 'Enter' }))).toBe(false);
  });
});
