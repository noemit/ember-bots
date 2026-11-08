import { describe, expect, test } from 'bun:test';
import { parseReadMarks } from '../electron/transport';
import type { SessionReadMark } from '../src/types';
import {
  MAX_OUT_OF_ORDER,
  addComments,
  isMessageRead,
  markAllRead,
  markRead,
  markTimestampRead,
  markUnreadFrom,
  pruneReadMarks,
  pruneSessionReadMarks,
} from '../src/lib/readState';

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

/**
 * "Mark as unread" is the inverse of a per-message receipt, and its meaning is a *watermark move*:
 * the reply pressed and everything after it become unread again. These tests pin that, plus the two
 * properties that make it safe to wire to a menu item — it is idempotent, and it never rewinds a
 * message *below* the one the person pointed at.
 */
describe('markUnreadFrom', () => {
  test('lowers the watermark to just below the target, so that reply and every later one is unread', () => {
    const mark = markAllRead({ through: 0 }, 40, 900);
    const next = markUnreadFrom(mark, 20);
    expect(next.through).toBe(19);
    expect(isMessageRead(next, 19, 0)).toBe(true);
    expect(isMessageRead(next, 20, 0)).toBe(false);
    expect(isMessageRead(next, 21, 0)).toBe(false);
    expect(isMessageRead(next, 40, 0)).toBe(false);
    // Everything the person had read *above* the target is unread now — that is the point.
    expect(isMessageRead(mark, 21, 0)).toBe(true);
  });

  test('drops the out-of-order marks it makes unread', () => {
    const mark = { through: 10, ids: [14, 17], readAt: 50, comments: 2 };
    const next = markUnreadFrom(mark, 5);
    expect(next.through).toBe(4);
    // 14 and 17 sat above the new watermark: they are unread again, so the listing is redundant.
    expect(next.ids).toBeUndefined();
    expect(isMessageRead(next, 14, 0)).toBe(false);
    // The comment count is not read state and survives untouched.
    expect(next.comments).toBe(2);
    expect(next.readAt).toBe(50);
  });

  test('an exception below the new watermark is dropped as redundant', () => {
    // 5 was undone; mark unread from 4, which lowers the watermark to 3.
    const mark = { through: 30, unreadOrdinals: [5] };
    const next = markUnreadFrom(mark, 4);
    expect(next.through).toBe(3);
    // 5 is above 3, so the exception still says something the watermark does not — it stays.
    expect(next.unreadOrdinals).toEqual([5]);
    // But an exception *at or below* the new watermark is covered by it and goes.
    const absorbed = markUnreadFrom({ through: 30, unreadOrdinals: [2] }, 10);
    expect(absorbed.through).toBe(9);
    expect(absorbed.unreadOrdinals).toBeUndefined();
    // 2 is at or below the new watermark, so it reads as read again — the exception was the only
    // thing keeping it unread, and it is now redundant.
    expect(isMessageRead(absorbed, 2, 0)).toBe(true);
  });

  test('keeps an exception that still stands after the rewind', () => {
    // 25 was undone while 1..30 were otherwise read. Marking unread from 10 lowers the watermark to
    // 9; 25 is above it, so the exception still names something the watermark does not.
    const mark = { through: 30, unreadOrdinals: [25] };
    const next = markUnreadFrom(mark, 10);
    expect(next.through).toBe(9);
    expect(next.unreadOrdinals).toEqual([25]);
  });

  test('a reply that is already unread changes nothing, and pressing again is idempotent', () => {
    const mark = { through: 10 };
    // 11 and everything above it is unread already.
    expect(markUnreadFrom(mark, 11).through).toBe(10);
    expect(markUnreadFrom(mark, 40).through).toBe(10);
    // Pressing it twice cannot keep lowering the record.
    const lowered = markUnreadFrom(mark, 5);
    expect(lowered.through).toBe(4);
    expect(markUnreadFrom(lowered, 5).through).toBe(4);
    expect(markUnreadFrom(lowered, 4).through).toBe(3);
  });

  test('never unreads anything below the target', () => {
    const mark = { through: 40 };
    const next = markUnreadFrom(mark, 20);
    for (const ordinal of [1, 10, 19]) expect(isMessageRead(next, ordinal, 0)).toBe(true);
  });

  test('the ordinal-free wire lowers `readAt` to just before the message', () => {
    const mark = { through: 0, readAt: 2_000 };
    const next = markUnreadFrom(mark, null, 5_000);
    expect(next.readAt).toBe(4_999);
    expect(isMessageRead(next, null, 4_999)).toBe(true);
    expect(isMessageRead(next, null, 5_000)).toBe(false);
  });

  test('the timestamp variant is idempotent, and never moves the watermark up', () => {
    const mark = { through: 0, readAt: 2_000 };
    // The message is already unread at that time: nothing to rewind.
    expect(markUnreadFrom(mark, null, 1_500).readAt).toBe(2_000);
    const lowered = markUnreadFrom(mark, null, 4_000);
    expect(lowered.readAt).toBe(3_999);
    expect(markUnreadFrom(lowered, null, 3_500).readAt).toBe(3_999);
  });

  test('a message with no usable stamp cannot be made unread by time, so nothing changes', () => {
    const mark = { through: 0, readAt: 2_000 };
    expect(markUnreadFrom(mark, null, 0).readAt).toBe(2_000);
    expect(markUnreadFrom(undefined, null, 0)).toEqual({ through: 0, readAt: 0 });
  });

  test('never mutates the mark it was given', () => {
    const mark = { through: 40, ids: [44], unreadOrdinals: [7], readAt: 100, comments: 1 };
    const snapshot = JSON.parse(JSON.stringify(mark));
    const next = markUnreadFrom(mark, 20);
    expect(mark).toEqual(snapshot);
    expect(next).not.toBe(mark);
    // ...nor does the ordinal-free branch.
    const timed = { through: 0, readAt: 500 };
    const timedSnapshot = { ...timed };
    markUnreadFrom(timed, null, 900);
    expect(timed).toEqual(timedSnapshot);
  });

  test('survives a settings round trip', () => {
    const roundTrip = (m: SessionReadMark | undefined) =>
      parseReadMarks(JSON.parse(JSON.stringify({ chat: m }))).chat;
    const mark = { through: 40, ids: [44], readAt: 100, comments: 1 };
    const persistedMark = roundTrip(markUnreadFrom(mark, 30));
    expect(persistedMark.through).toBe(29);
    expect(persistedMark.ids).toBeUndefined();
    expect(isMessageRead(persistedMark, 30, 0)).toBe(false);
    expect(isMessageRead(persistedMark, 29, 0)).toBe(true);
    // The first message of a chat is reachable: ordinal 1 lowers the mark to 0, not below it.
    // A mark that then says nothing at all (through 0, no readAt, no comments) is a key the write
    // path drops on purpose, which reads as "nothing is read" — the same statement.
    expect(markUnreadFrom({ through: 9 }, 1)).toEqual({ through: 0 });
    expect(isMessageRead(roundTrip(markUnreadFrom({ through: 9 }, 1)), 1, 0)).toBe(false);
  });

  test('an undefined mark is still a mark, not a hole in the settings', () => {
    // Nothing has been read yet, so everything is unread already and the receipt is unchanged.
    expect(markUnreadFrom(undefined, 6)).toEqual({ through: 0, readAt: 0 });
    // A reply *marked read* on an unmarked session lowers to just below it.
    expect(markUnreadFrom({ through: 0 }, 1).through).toBe(0);
    expect(markUnreadFrom({ through: 6 }, 6).through).toBe(5);
  });
});
