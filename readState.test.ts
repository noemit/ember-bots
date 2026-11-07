import { describe, expect, test } from 'bun:test';
import {
  MAX_OUT_OF_ORDER,
  addComments,
  isMessageRead,
  markAllRead,
  markRead,
  markTimestampRead,
  pruneReadMarks,
  pruneSessionReadMarks,
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


test('explicit timestamp marking moves only the read watermark and retains comment history', () => {
  const mark = { through: 5, readAt: 100, comments: 3 };
  expect(markTimestampRead(mark, 500)).toEqual({ through: 5, readAt: 500, comments: 3 });
  expect(markTimestampRead(mark, 99)).toBe(mark);
});


test('archived read receipts survive restore, and a slow host cannot lose receipts during startup', () => {
  const marks = {
    'local::archived': { through: 12 },
    'remote::report': { through: 25 },
    'removed::old': { through: 4 },
    'local::deleted': { through: 3 },
  };
  const local = [{ id: 'archived', instanceId: 'local', archived: 2000 }];
  const retained = { 'local::archived': marks['local::archived'], 'remote::report': marks['remote::report'] };
  expect(pruneSessionReadMarks(marks, { local }, ['local', 'remote'])).toEqual(retained);
  expect(pruneSessionReadMarks(marks, { local, remote: [] }, ['local', 'remote'])).toEqual(retained);
  expect(pruneSessionReadMarks(marks, { local, remote: [{ id: 'report', instanceId: 'remote' }] }, ['local', 'remote'])).toEqual(retained);
});
