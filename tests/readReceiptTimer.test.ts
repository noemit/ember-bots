import { describe, expect, test } from 'bun:test';
import {
  READ_RECEIPT_LEAVE_GRACE_MS,
  READ_RECEIPT_MAX_MS,
  READ_RECEIPT_MS,
  readReceiptDismissIn,
  readReceiptIsDone,
  type ReadReceiptState,
} from '../src/lib/readReceiptTimer';

/** A receipt that appeared at `appearedAt`, asked about `elapsed` ms later. */
const at = (
  elapsed: number,
  { hovered = false, focused = false, released = false } = {},
  appearedAt = 1_000
): ReadReceiptState => ({ appearedAt, now: appearedAt + elapsed, hovered, focused, released });


describe('readReceiptTimer constants', () => {
  test('the policy is 1s visible, 5s cap from appearance, ~150ms leave grace', () => {
    expect(READ_RECEIPT_MS).toBe(1_000);
    expect(READ_RECEIPT_MAX_MS).toBe(5_000);
    expect(READ_RECEIPT_LEAVE_GRACE_MS).toBe(150);
  });
});

describe('readReceiptDismissIn', () => {
  test('untouched, it goes after 1s', () => {
    // Each answer is "how long from *now*", measured again at every interaction change, so an
    // untouched receipt always has its second — until the cap ends it.
    expect(readReceiptDismissIn(at(0))).toBe(1_000);
    expect(readReceiptDismissIn(at(400))).toBe(600);
    // Exactly at the second: gone.
    expect(readReceiptIsDone(at(1_000))).toBe(true);
    expect(readReceiptDismissIn(at(4_000))).toBe(0);
    expect(readReceiptDismissIn(at(5_000))).toBe(0);
    expect(readReceiptIsDone(at(5_000))).toBe(true);
  });

  test('hovering at 400ms extends to 5s measured from appearance', () => {
    // The hover arrives before the 1s timeout would have fired: the deadline moves to the cap.
    expect(readReceiptDismissIn(at(400, { hovered: true }))).toBe(READ_RECEIPT_MAX_MS - 400);
    expect(readReceiptDismissIn(at(4_999, { hovered: true }))).toBe(1);
    // The cap is absolute: still hovered, it dismisses at 5s.
    expect(readReceiptDismissIn(at(5_000, { hovered: true }))).toBe(0);
    expect(readReceiptDismissIn(at(6_000, { hovered: true }))).toBe(0);
    expect(readReceiptIsDone(at(5_000, { hovered: true }))).toBe(true);
  });

  test('leaving before the cap dismisses promptly, after the short grace', () => {
    expect(readReceiptDismissIn(at(2_000, { released: true }))).toBe(READ_RECEIPT_LEAVE_GRACE_MS);
    // Well under the second it would otherwise have had left.
    expect(READ_RECEIPT_LEAVE_GRACE_MS).toBeLessThan(READ_RECEIPT_MS);
    // The caller re-arms at every change, so the answer is always measured from *this* moment.
  });

  test('an untouched receipt keeps its full second; a released one does not', () => {
    // Same instant, two states: this is why `released` exists.
    expect(readReceiptDismissIn(at(2_000))).toBe(0);
    expect(readReceiptDismissIn(at(2_000, { released: true }))).toBe(READ_RECEIPT_LEAVE_GRACE_MS);
  });

  test('leaving late enough that the grace would outrun the cap still stops at the cap', () => {
    // Released at 4.95s: 150ms of grace would reach 5.1s, but the cap wins.
    expect(readReceiptDismissIn(at(4_950, { released: true }))).toBe(50);
    expect(readReceiptIsDone(at(5_000, { released: true }))).toBe(true);
    expect(readReceiptIsDone(at(6_000, { released: true }))).toBe(true);
  });

  test('keyboard focus inside behaves exactly like hover', () => {
    for (const elapsed of [0, 400, 2_400, 4_999]) {
      expect(readReceiptDismissIn(at(elapsed, { focused: true }))).toBe(readReceiptDismissIn(at(elapsed, { hovered: true })));
      expect(readReceiptDismissIn(at(elapsed, { focused: true }))).toBe(READ_RECEIPT_MAX_MS - elapsed);
    }
    // Focus leaving dismisses on the same grace as the pointer leaving.
    expect(readReceiptDismissIn(at(3_000, { focused: false, released: true }))).toBe(READ_RECEIPT_LEAVE_GRACE_MS);
  });

  test('either hold keeps it, and both together answer the same as one', () => {
    expect(readReceiptDismissIn(at(1_000, { hovered: true, focused: true }))).toBe(4_000);
    expect(readReceiptDismissIn(at(1_000, { hovered: true }))).toBe(4_000);
    expect(readReceiptDismissIn(at(1_000, { focused: true }))).toBe(4_000);
  });

  test('re-hovering inside the leave grace keeps it alive until the cap', () => {
    // Left at 2s (the grace would run out at 2.15s), pointer back 60ms later.
    const back = at(2_060, { hovered: true });
    expect(readReceiptIsDone(back)).toBe(false);
    expect(readReceiptDismissIn(back)).toBe(READ_RECEIPT_MAX_MS - 2_060);
    // A hover is a state, not a memory of one: held again, the cap is the only deadline left.
    expect(readReceiptDismissIn(at(2_150, { hovered: true }))).toBe(READ_RECEIPT_MAX_MS - 2_150);
  });

  test('a held receipt only ever lives 5s from appearance, however long it is held', () => {
    expect(readReceiptDismissIn(at(0, { hovered: true }))).toBe(5_000);
    expect(readReceiptDismissIn(at(1_000, { hovered: true }))).toBe(4_000);
    expect(readReceiptDismissIn(at(4_999, { hovered: true }))).toBe(1);
  });

  test('deterministic: the answer depends only on the inputs, never on a clock', () => {
    const state = at(400, { hovered: true });
    expect(readReceiptDismissIn(state)).toBe(readReceiptDismissIn({ ...state }));
    expect(readReceiptDismissIn(at(0))).toBe(readReceiptDismissIn(at(0)));
    // A `now` before the receipt appeared is not an error: it has only just appeared.
    expect(readReceiptDismissIn({ appearedAt: 5_000, now: 4_000, hovered: false, focused: false })).toBe(READ_RECEIPT_MS + 1_000);
    expect(readReceiptIsDone({ appearedAt: 5_000, now: 4_000, hovered: false, focused: false })).toBe(false);
    // Reduced motion is not an input: there is no CSS delay to turn off, only this timer.
    expect(readReceiptDismissIn(at(400))).toBe(readReceiptDismissIn(at(400)));
  });
});
