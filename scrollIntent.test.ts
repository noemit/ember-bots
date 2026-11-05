import { describe, expect, test } from 'bun:test';
import { gestureLeavesBottom, scrollIntent, type ScrollEvent } from './src/lib/scrollIntent';

/**
 * The rule that stopped following from switching itself off: a scroll only counts as the reader's when
 * a gesture is behind it, and a resize is never theirs. Measured against the live app before the fix —
 * a clamping viewport (clientHeight 403 → 431) produced a 28px "scroll up" nobody performed, and 42
 * messages at ~230ms left the transcript at the top of an 8,428px list.
 */
const base: ScrollEvent = {
  previousTop: 508,
  top: 480,
  distanceFromBottom: 400,
  threshold: 48,
  gestureAgeMs: 10_000,
  userGesturing: false,
  resized: false,
  gestureWindowMs: 600,
};

describe('what a scroll event means', () => {
  test('a resize is the layout, never the reader', () => {
    expect(scrollIntent({ ...base, resized: true, gestureAgeMs: 10 })).toBe('ignore');
    expect(scrollIntent({ ...base, resized: true, userGesturing: true })).toBe('ignore');
    // The exact shape measured in the app: a 28px fall with no gesture behind it.
    expect(scrollIntent({ ...base, top: 480, previousTop: 508 })).toBe('ignore');
  });

  test('a wheel up stops following, while the gesture is recent', () => {
    expect(scrollIntent({ ...base, gestureAgeMs: 40 })).toBe('stop');
  });

  test('a scrollbar drag stops following even before the wheel timestamp catches up', () => {
    expect(scrollIntent({ ...base, userGesturing: true })).toBe('stop');
  });

  test('moving down but short of the end changes nothing', () => {
    expect(scrollIntent({ ...base, top: 900, previousTop: 508, gestureAgeMs: 40 })).toBe('ignore');
  });

  test('reaching the end always resumes following', () => {
    expect(scrollIntent({ ...base, distanceFromBottom: 10 })).toBe('follow');
    // Even mid-gesture: the reader is at the bottom because they went there.
    expect(scrollIntent({ ...base, distanceFromBottom: 10, userGesturing: true })).toBe('follow');
  });

  test('sub-threshold jitter is not a move', () => {
    expect(scrollIntent({ ...base, previousTop: 500, top: 497, gestureAgeMs: 10 })).toBe('ignore');
  });
});

/**
 * The gesture that leaves the end, decided before the scroll event that follows it.
 *
 * Measured before this existed: with a turn streaming, one 100px wheel up moved the reader 40px and
 * then the content's ResizeObserver pinned them back for 2.4s, until they had cleared
 * `FOLLOW_THRESHOLD` by main force. That is "it is hard to scroll up when you are at the bottom":
 * the reader's first inch of travel is spent fighting the pin rather than moving.
 */
describe('an upward gesture leaves the bottom at once', () => {
  const at = (over: Partial<Parameters<typeof gestureLeavesBottom>[0]>) => ({
    deltaY: -100,
    following: true,
    scrollTop: 4000,
    ...over,
  });

  test('one upward tick while pinned is enough', () => {
    expect(gestureLeavesBottom(at({}))).toBe(true);
    // Deliberately not 48px of travel, and not a threshold at all: the first tick counts.
    expect(gestureLeavesBottom(at({ deltaY: -1 }))).toBe(true);
  });

  test('a downward tick leaves following alone', () => {
    expect(gestureLeavesBottom(at({ deltaY: 100 }))).toBe(false);
    expect(gestureLeavesBottom(at({ deltaY: 0 }))).toBe(false);
  });

  test('a reader who already left is not told twice', () => {
    expect(gestureLeavesBottom(at({ following: false }))).toBe(false);
  });

  test('a fling at the very top is overscroll, not an opinion', () => {
    // Nothing above to reveal: the scroll event that follows decides what it meant.
    expect(gestureLeavesBottom(at({ scrollTop: 0 }))).toBe(false);
  });
});
