import { describe, expect, test } from 'bun:test';
import {
  commentBlocks,
  composeCommentMessage,
  isCommentShortcut,
  normaliseSelection,
  QUOTE_LIMIT,
  sendCommentsLabel,
  shortenQuote,
  type TranscriptComment,
} from './src/lib/comments';

const comment = (quote: string, reply: string, id = quote): TranscriptComment => ({
  id,
  quote,
  reply,
});

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

describe('commentBlocks', () => {
  test('numbers the comments in the order they were made', () => {
    expect(
      commentBlocks([
        comment('we should drop the nightly cron and run it on demand', 'Yes, do that.'),
        comment('the export needs a queue', 'Hold off on this one.'),
      ])
    ).toBe(
      [
        '1. Re: "we should drop the nightly cron and run it on demand"',
        'Yes, do that.',
        '',
        '2. Re: "the export needs a queue"',
        'Hold off on this one.',
      ].join('\n')
    );
  });

  test('an empty reply leaves the quote alone on its line', () => {
    expect(commentBlocks([comment('the export needs a queue', '')])).toBe(
      '1. Re: "the export needs a queue"'
    );
  });

  test('a multi-line reply keeps its own lines', () => {
    expect(commentBlocks([comment('a plan', 'Do this.\nThen that.')])).toBe(
      '1. Re: "a plan"\nDo this.\nThen that.'
    );
  });

  test('long quotes are shortened in the block', () => {
    const long = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ');
    const block = commentBlocks([comment(long, 'ok')]);
    expect(block.split('\n')[0]).toContain('…');
    expect(block.split('\n')[0]!.length).toBeLessThan(QUOTE_LIMIT + 12);
  });

  test('no comments means no blocks', () => {
    expect(commentBlocks([])).toBe('');
  });
});

describe('composeCommentMessage', () => {
  const comments = [
    comment('we should drop the nightly cron and run it on demand', 'Yes, do that.'),
    comment('the export needs a queue', 'Hold off on this one.'),
  ];

  test('the blocks alone when the composer is empty', () => {
    expect(composeCommentMessage(comments, '')).toBe(commentBlocks(comments));
  });

  test('composer text is appended once, after a blank line', () => {
    expect(composeCommentMessage(comments, '  Also, ship it Friday.  ')).toBe(
      `${commentBlocks(comments)}\n\nAlso, ship it Friday.`
    );
  });

  test('composer text alone when there are no comments', () => {
    expect(composeCommentMessage([], 'Just this.')).toBe('Just this.');
  });

  test('nothing at all composes to an empty message', () => {
    expect(composeCommentMessage([], '   ')).toBe('');
  });

  test('a cleared row cannot leave a hole in the numbering', () => {
    expect(composeCommentMessage([comment('a', ''), comment('', ''), comment('b', 'x')], '')).toBe(
      ['1. Re: "a"', '', '2. Re: "b"', 'x'].join('\n')
    );
  });
});

describe('sendCommentsLabel', () => {
  test('counts in the singular and the plural', () => {
    expect(sendCommentsLabel(1)).toBe('Send 1 comment');
    expect(sendCommentsLabel(3)).toBe('Send 3 comments');
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
