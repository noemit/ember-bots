import { describe, expect, test } from 'bun:test';
import { applyMention, matchMentions, mentionQueryAt } from '../src/lib/mentions';

/**
 * The `@` trigger and the suggestion list. These are the parts that get subtly wrong — a popup that
 * opens mid-word, a query that swallows a space, or an accept that leaves the caret where the popup
 * reopens instantly.
 */
describe('the @ trigger', () => {
  test('a bare @ at the start of a word opens it', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionQueryAt('hi @', 4)).toEqual({ start: 3, end: 4, query: '' });
  });

  test('the query is what has been typed since the @', () => {
    expect(mentionQueryAt('hi @Stu', 7)).toEqual({ start: 3, end: 7, query: 'Stu' });
  });

  test('an @ inside a word is an email address, not a mention', () => {
    expect(mentionQueryAt('mail a@b', 9)).toBeNull();
    expect(mentionQueryAt('foo@bar', 7)).toBeNull();
  });

  test('a space ends the query instead of being swallowed', () => {
    // The caret sits after a space, so the mention is finished rather than open on "@Studio Blog".
    expect(mentionQueryAt('hi @Studio Blog', 15)).toBeNull();
    expect(mentionQueryAt('hi @Studio Blog', 11)).toBeNull();
    // It is still open while the caret is inside the name.
    expect(mentionQueryAt('hi @Studio Blog', 10)).toEqual({ start: 3, end: 10, query: 'Studio' });
  });

  test('nothing is offered with no @ before the caret', () => {
    expect(mentionQueryAt('hello', 5)).toBeNull();
    expect(mentionQueryAt('', 0)).toBeNull();
  });

  test('a caret outside the text is ignored rather than throwing', () => {
    expect(mentionQueryAt('hi', -1)).toBeNull();
    expect(mentionQueryAt('hi', 99)).toBeNull();
  });

  test('a runaway query does not stay open forever', () => {
    expect(mentionQueryAt('@' + 'a'.repeat(41), 42)).toBeNull();
    expect(mentionQueryAt('@' + 'a'.repeat(39), 40)).not.toBeNull();
  });
});

describe('matching names', () => {
  const names = ['Studio Blog Updater', 'Harness Engineer', 'Blog Archive', 'Blog Updater'];

  test('a prefix beats a word start beats a substring', () => {
    expect(matchMentions(names, 'blo')).toEqual(['Blog Archive', 'Blog Updater', 'Studio Blog Updater']);
  });

  test('an exact prefix is ranked first', () => {
    expect(matchMentions(names, 'blog')[0]).toBe('Blog Archive');
  });

  test('an empty query lists everything, alphabetically', () => {
    expect(matchMentions(names, '')).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test('no match means no list, so the popup can stay shut', () => {
    expect(matchMentions(names, 'zzz')).toEqual([]);
  });

  test('the limit is respected and duplicates collapse', () => {
    expect(matchMentions([...names, 'Blog Archive'], 'blog', 2)).toHaveLength(2);
  });

  test('regex characters in the query are literal, not patterns', () => {
    // A name with a dot must not behave like a wildcard.
    expect(matchMentions(['v1.2 Release'], '1.2')).toEqual(['v1.2 Release']);
    expect(matchMentions(['v1x2 Release'], '1.2')).toEqual([]);
  });
});

describe('accepting a mention', () => {
  test('the name replaces the query and a space follows', () => {
    const mention = mentionQueryAt('hi @Stu', 7)!;
    expect(applyMention('hi @Stu', mention, 'Studio Blog Updater')).toEqual({
      text: 'hi @Studio Blog Updater ',
      cursor: 24,
    });
  });

  test('text after the caret is kept', () => {
    const text = 'hi @Stu there';
    const mention = mentionQueryAt(text, 7)!;
    expect(applyMention(text, mention, 'Harness Engineer').text).toBe('hi @Harness Engineer  there');
  });

  test('the caret lands past the trailing space so the popup does not reopen', () => {
    const mention = mentionQueryAt('@a', 2)!;
    const { text, cursor } = applyMention('@a', mention, 'Blog');
    expect(text).toBe('@Blog ');
    expect(cursor).toBe(text.length);
    // And a mention query at that caret is closed.
    expect(mentionQueryAt(text, cursor)).toBeNull();
  });
});
