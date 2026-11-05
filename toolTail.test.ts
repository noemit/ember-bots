import { describe, expect, test } from 'bun:test';
import { LIVE_TAIL_LINE_CHARS, liveOutputTail } from './src/lib/toolTail';

/**
 * A running tool call's output streams in; the transcript shows its last few lines under the row.
 * The rules here are the ones that decide whether that block reads or garbles: which lines, how
 * many, and what happens to a line longer than the column.
 */
describe('the live tail of a running call', () => {
  test('the newest lines, last line last', () => {
    expect(liveOutputTail('one\ntwo\nthree\nfour')).toEqual(['two', 'three', 'four']);
  });

  test('a trailing newline is the end of a line, not an empty one', () => {
    expect(liveOutputTail('one\ntwo\n')).toEqual(['one', 'two']);
    expect(liveOutputTail('one\ntwo\n\n\n')).toEqual(['one', 'two']);
  });

  test('nothing to show is nothing at all, not an empty block', () => {
    expect(liveOutputTail('')).toEqual([]);
    expect(liveOutputTail('\n\n')).toEqual([]);
  });

  test('fewer lines than the limit are shown as they are', () => {
    expect(liveOutputTail('only this')).toEqual(['only this']);
  });

  test('a progress display rewriting one line does not become one mangled line', () => {
    // `\r` is how a progress bar rewrites itself; keeping it would render the history as garbage.
    expect(liveOutputTail(' 10%\r 40%\r 90%\r')).toEqual([' 10%', ' 40%', ' 90%']);
    expect(liveOutputTail('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });

  test('an enormous line is cut rather than wrapped into the composer', () => {
    const [line] = liveOutputTail('x'.repeat(1000));
    expect(line.length).toBe(LIVE_TAIL_LINE_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });

  test('the limits are adjustable, and never zero lines', () => {
    expect(liveOutputTail('a\nb\nc\nd', { lines: 2 })).toEqual(['c', 'd']);
    expect(liveOutputTail('a\nb', { lines: 0 })).toEqual(['b']);
  });
});
