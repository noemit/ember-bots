import { describe, expect, test } from 'bun:test';
import {
  MAX_OUT_OF_ORDER,
  addComments,
  advanceQuietMark,
  isMessageRead,
  isQuietSession,
  markAllRead,
  markRead,
  markTimestampRead,
  pruneReadMarks,
  withQuiet,
} from './src/lib/readState';

describe('isMessageRead', () => {
  test('an ordinal at or below the mark is read', () => {
    const mark = { through: 40 };
    expect(isMessageRead(mark, 40, 0)).toBe(true);
    expect(isMessageRead(mark, 41, 0)).toBe(false);
  });

  test('an out-of-order mark reads only that message', () => {
    const mark = markRead({ through: 10 }, 14, [11, 12, 13, 14]);
    expect(isMessageRead(mark, 11, 0)).toBe(false);
    expect(isMessageRead(mark, 14, 0)).toBe(true);
  });

  test('without an ordinal, the timestamp decides', () => {
    expect(isMessageRead({ through: 0, readAt: 500 }, null, 499)).toBe(true);
    expect(isMessageRead({ through: 0, readAt: 500 }, null, 501)).toBe(false);
    // A session never marked read reads nothing, however old the message is.
    expect(isMessageRead(undefined, null, 1)).toBe(false);
  });
});

describe('markRead', () => {
  test('marking the next message advances the mark', () => {
    const mark = markRead({ through: 10 }, 11, [11, 12]);
    expect(mark.through).toBe(11);
    expect(mark.ids).toBeUndefined();
  });

  test('marking ahead of an unread message holds it out of order instead of swallowing it', () => {
    const mark = markRead({ through: 10 }, 13, [11, 12, 13]);
    expect(mark.through).toBe(10);
    expect(mark.ids).toEqual([13]);
  });

  test('the run closes once the gap is filled, and the ids compact away', () => {
    const first = markRead({ through: 10 }, 13, [11, 12, 13]);
    const second = markRead(first, 11, [11, 12]);
    expect(second.ids).toEqual([13]);
    const third = markRead(second, 12, [12]);
    // 11, 12, then 13 which was already marked: one contiguous run.
    expect(third.through).toBe(13);
    expect(third.ids).toBeUndefined();
  });

  test('re-marking something already read changes nothing', () => {
    const mark = { through: 40, readAt: 5 };
    expect(markRead(mark, 20, [])).toBe(mark);
  });

  test('the out-of-order set is bounded', () => {
    let mark = { through: 0 };
    for (let index = 0; index < MAX_OUT_OF_ORDER + 20; index += 1) {
      // Always skip the next unread message, so nothing ever compacts.
      mark = markRead(mark, 1000 + index, [1]);
    }
    expect(mark.ids?.length).toBe(MAX_OUT_OF_ORDER);
    expect(mark.through).toBe(0);
  });

  test('keeps the comment count it carried', () => {
    const mark = markRead(addComments({ through: 0 }, 3), 1, [1]);
    expect(mark.comments).toBe(3);
  });
});

describe('markAllRead', () => {
  test('reads everything up to the given ordinal and drops out-of-order marks', () => {
    const mark = markAllRead({ through: 10, ids: [14], comments: 2 }, 40, 999);
    expect(mark).toEqual({ through: 40, readAt: 999, comments: 2 });
  });

  test('never walks backwards', () => {
    expect(markAllRead({ through: 40 }, 12, 1).through).toBe(40);
  });
});

describe('pruneReadMarks', () => {
  test('keeps only sessions still in play', () => {
    const marks = { a: { through: 1 }, b: { through: 2 }, c: { through: 3 } };
    expect(Object.keys(pruneReadMarks(marks, ['a', 'c']))).toEqual(['a', 'c']);
    expect(pruneReadMarks(marks, [])).toEqual({});
  });

  test('a key that is gone does not hold a mark forever', () => {
    expect(pruneReadMarks({ a: { through: 1 } }, ['b'])).toEqual({});
  });
});

/**
 * "Mark all messages as read; no notifications needed."
 *
 * A standing policy rather than a mark: the newest message advances `through` as it arrives, so a
 * quiet session never accumulates a backlog on Home. That is the whole feature, so the two rules
 * worth pinning are that it advances and that it never *lowers* a mark — turning it off must not put
 * a backlog back, because those messages were seen.
 */
describe('quiet sessions', () => {
  test('are off unless the mark says otherwise', () => {
    expect(isQuietSession(undefined)).toBe(false);
    expect(isQuietSession({ through: 5 })).toBe(false);
    expect(isQuietSession(withQuiet({ through: 5 }, true))).toBe(true);
  });

  test('advance to the newest message', () => {
    const mark = withQuiet({ through: 3 }, true);
    expect(advanceQuietMark(mark, 9).through).toBe(9);
    // And keep the policy while doing it.
    expect(isQuietSession(advanceQuietMark(mark, 9))).toBe(true);
  });

  test('never move backwards', () => {
    const mark = withQuiet({ through: 9 }, true);
    expect(advanceQuietMark(mark, 4).through).toBe(9);
    expect(advanceQuietMark(mark, 9).through).toBe(9);
  });

  test('do nothing at all for a session that is not quiet', () => {
    // The mark must not creep forward just because `advanceQuietMark` was called: a normal session
    // stays unread until someone reads it.
    const loud = { through: 3 };
    expect(advanceQuietMark(loud, 9)).toBe(loud);
  });

  test('turning it off leaves every recorded read in place', () => {
    const quiet = withQuiet({ through: 12, ids: [14], readAt: 500 }, true);
    const loud = withQuiet(quiet, false);
    expect(isQuietSession(loud)).toBe(false);
    expect(loud.through).toBe(12);
    expect(loud.ids).toEqual([14]);
    expect(loud.readAt).toBe(500);
  });

  test('turning it on claims nothing was just read', () => {
    // `readAt` is the fallback ordering for a wire without ordinals; stamping it would mark older
    // messages read on OpenChamber simply by enabling the policy.
    const mark = withQuiet({ through: 2, readAt: 100 }, true);
    expect(mark.readAt).toBe(100);
  });

  test('markRead, markAllRead, and markTimestampRead preserve the quiet policy', () => {
    const base = withQuiet({ through: 5, readAt: 100 }, true);
    expect(isQuietSession(markRead(base, 8, [6, 7, 8], 200))).toBe(true);
    expect(isQuietSession(markAllRead(base, 12, 300))).toBe(true);
    const stamped = markTimestampRead(base, 500);
    expect(isQuietSession(stamped)).toBe(true);
    expect(stamped.readAt).toBe(500);
  });
});
