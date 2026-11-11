import { describe, expect, test } from 'bun:test';
import { nextUnreadCursor, unreadPositionLabel, unreadPositionName } from '../src/lib/unreadCursor';

describe('unread cycling cursor', () => {
  test('the first click goes to the oldest unread, not the newest', () => {
    // The bug this replaces: one button always jumped to `length - 1`, so everything above it was
    // skipped on the way in.
    expect(nextUnreadCursor(null, 7)).toBe(0);
  });

  test('each click advances one reply down the list', () => {
    expect(nextUnreadCursor(0, 7)).toBe(1);
    expect(nextUnreadCursor(1, 7)).toBe(2);
    expect(nextUnreadCursor(5, 7)).toBe(6);
  });

  test('the click after the last wraps back to the oldest', () => {
    expect(nextUnreadCursor(6, 7)).toBe(0);
    expect(nextUnreadCursor(0, 1)).toBe(0);
  });

  test('a single unread stays a single position, however often it is clicked', () => {
    expect(nextUnreadCursor(null, 1)).toBe(0);
    expect(nextUnreadCursor(0, 1)).toBe(0);
    expect(nextUnreadCursor(nextUnreadCursor(nextUnreadCursor(null, 1), 1), 1)).toBe(0);
  });

  test('a shorter list restarts the cycle instead of pointing past the end', () => {
    // Two of seven marked read: position 5 no longer exists, and landing on it would be a crash or
    // a jump to the wrong reply. The caller clears the cursor on every list change; this is the
    // guard for the case where it has not happened yet.
    expect(nextUnreadCursor(5, 4)).toBe(0);
    expect(nextUnreadCursor(4, 4)).toBe(0);
    expect(nextUnreadCursor(3, 3)).toBe(0);
  });

  test('a stale negative cursor restarts too', () => {
    expect(nextUnreadCursor(-1, 4)).toBe(0);
    expect(nextUnreadCursor(-40, 4)).toBe(0);
  });

  test('no unread replies never produces a position', () => {
    // The strip does not render at length 0, but the arithmetic still has to answer sanely.
    expect(nextUnreadCursor(null, 0)).toBe(0);
    expect(nextUnreadCursor(0, 0)).toBe(0);
  });

  test('cycling never leaves the list, for every start and length', () => {
    for (let length = 0; length <= 12; length++) {
      for (let start = -2; start <= length + 2; start++) {
        const next = nextUnreadCursor(start, length);
        expect(next).toBeGreaterThanOrEqual(0);
        if (length > 0) expect(next).toBeLessThan(length);
      }
    }
  });
});

describe('unread position label', () => {
  test('reads position over total so a click is visibly different from the one before', () => {
    expect(unreadPositionLabel(null, 7)).toBe('1/7');
    expect(unreadPositionLabel(0, 7)).toBe('1/7');
    expect(unreadPositionLabel(1, 7)).toBe('2/7');
    expect(unreadPositionLabel(6, 7)).toBe('7/7');
  });

  test('the total does not change as the reader cycles', () => {
    // Browsing is not acknowledging: the denominator is the unread count, and it stays put.
    const length = 5;
    const labels = Array.from({ length: length + 1 }, (_, click) => {
      let cursor: number | null = null;
      for (let i = 0; i < click; i++) cursor = nextUnreadCursor(cursor, length);
      return unreadPositionLabel(cursor, length);
    });
    // Resting state, then one click each: the last click on a five-reply backlog has wrapped.
    expect(labels).toEqual(['1/5', '1/5', '2/5', '3/5', '4/5', '5/5']);
    expect(labels.every(label => label.endsWith('/5'))).toBe(true);
  });

  test('a single unread reads 1/1', () => {
    expect(unreadPositionLabel(0, 1)).toBe('1/1');
  });

  test('an empty list is 0/0 rather than 1/0', () => {
    expect(unreadPositionLabel(null, 0)).toBe('0/0');
    expect(unreadPositionLabel(3, 0)).toBe('0/0');
  });

  test('a stale position is reported as the first one, matching the next click', () => {
    expect(unreadPositionLabel(9, 3)).toBe('1/3');
    expect(unreadPositionLabel(-1, 3)).toBe('1/3');
  });

  test('the spoken name carries the same position', () => {
    expect(unreadPositionName(null, 4)).toBe('Unread reply 1/4');
    expect(unreadPositionName(2, 4)).toBe('Unread reply 3/4');
    expect(unreadPositionName(null, 0)).toBe('No unread replies');
  });
});
