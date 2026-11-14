import { describe, expect, test } from 'bun:test';
import { gestureLeavesBottom, scrollIntent, type ScrollEvent } from '../src/lib/scrollIntent';

/**
 * The rule that stopped following from switching itself off: a scroll only counts as the reader's when
 * a gesture is behind it, and a resize is never theirs. Measured against the live app before the fix —
 * a clamping viewport (clientHeight 403 → 431) produced a 28px "scroll up" nobody performed, and 42
 * messages at ~230ms left the transcript at the top of an 8,428px list.
 */
const base: ScrollEvent = {
  following: true,
  previousTop: 508,
  top: 480,
  distanceFromBottom: 400,
  threshold: 48,
  gestureAgeMs: 10_000,
  gestureDirection: 'down',
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

  test('the near-bottom tolerance keeps an existing follower pinned unless they move up', () => {
    expect(scrollIntent({ ...base, distanceFromBottom: 10 })).toBe('follow');
    expect(scrollIntent({ ...base, previousTop: 470, top: 480, distanceFromBottom: 10, userGesturing: true })).toBe('follow');
  });

  test('unattributed sub-pixel motion is not the reader', () => {
    expect(scrollIntent({ ...base, previousTop: 500, top: 499.5 })).toBe('ignore');
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
describe('leaving the bottom stays the reader’s choice', () => {
  test('the first tiny upward scroll wins over the near-bottom tolerance', () => {
    expect(scrollIntent({ ...base, previousTop: 500, top: 499, distanceFromBottom: 1, gestureAgeMs: 10 })).toBe('stop');
  });

  test('an upward gesture cannot be rearmed by its own near-bottom scroll event', () => {
    expect(scrollIntent({ ...base, following: false, previousTop: 500, top: 492, distanceFromBottom: 8, gestureAgeMs: 10 })).not.toBe('follow');
  });

  test('layout changes and programmatic motion cannot rearm a reader who left', () => {
    expect(scrollIntent({ ...base, following: false, previousTop: 480, top: 500, distanceFromBottom: 0 })).toBe('ignore');
    expect(scrollIntent({ ...base, following: false, distanceFromBottom: 0, resized: true, gestureAgeMs: 10 })).toBe('ignore');
    expect(scrollIntent({ ...base, following: false, previousTop: 500, top: 500, distanceFromBottom: 0, gestureAgeMs: 10 })).toBe('ignore');
  });

  test('virtualizer corrections after an upward gesture cannot resume following', () => {
    expect(scrollIntent({ ...base, following: false, previousTop: 480, top: 500, distanceFromBottom: 0, gestureAgeMs: 10, gestureDirection: 'up' })).toBe('ignore');
    expect(scrollIntent({ ...base, following: false, previousTop: 480, top: 500, distanceFromBottom: 0, gestureAgeMs: 10, gestureDirection: null })).toBe('ignore');
  });

  test('a downward scrollbar drag returning to the end resumes following', () => {
    expect(scrollIntent({ ...base, following: false, previousTop: 480, top: 500, distanceFromBottom: 0, userGesturing: true, gestureDirection: null })).toBe('follow');
  });

  test('only a deliberate downward return to the end resumes following', () => {
    expect(scrollIntent({ ...base, following: false, previousTop: 480, top: 499.5, distanceFromBottom: 0.5, gestureAgeMs: 10 })).toBe('follow');
    expect(scrollIntent({ ...base, following: false, previousTop: 480, top: 492, distanceFromBottom: 8, gestureAgeMs: 10 })).toBe('ignore');
  });
});

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
