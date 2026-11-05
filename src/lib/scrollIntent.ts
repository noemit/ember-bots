/**
 * Whether a scroll event means the reader moved, or the layout did.
 *
 * `handleScroll` used to decide "the reader scrolled up" from a bare `scrollTop` decrease, and stop
 * following on it. But `scrollTop` also *falls* when the viewport grows and the browser clamps the
 * scroll to the new maximum — every send that closes the follow-up chips row does exactly that
 * (measured: `clientHeight 403 → 431`, `scrollHeight` unchanged, `scrollTop 508 → 480`), and an image
 * decoding into a box with no reserved height does it too. Each was read as the reader scrolling back,
 * so following switched itself off: 42 messages at ~230ms left the transcript at `scrollTop 0` of
 * `8428` with the "Jump to latest" pill showing, three runs out of three.
 *
 * The rule this exists for: **only a gesture can stop following.** `pointerDown`, wheel, touch and key
 * already fed `userScrollAt`/`pointerDown` for the other direction; an upward move with no gesture in
 * `USER_SCROLL_WINDOW` is a clamp, and a clamp is not an opinion about where the reader wants to be.
 */

/** What a scroll event asks the transcript to do. */
export type ScrollIntent =
  /** The reader is at the end (or arrived there): keep pinning. */
  | 'follow'
  /** The reader moved away from the end on purpose: stop pinning where they are. */
  | 'stop'
  /** Neither: a layout change, or a move that is not the reader's. Change nothing. */
  | 'ignore';

export type ScrollEvent = {
  /** `scrollTop` before this event, as the last one left it. */
  previousTop: number;
  top: number;
  /** `scrollHeight - scrollTop - clientHeight`: how far the end is. */
  distanceFromBottom: number;
  /** How close counts as "at the end" (`FOLLOW_THRESHOLD`). */
  threshold: number;
  /** Milliseconds since the last wheel/touch/key on the scroller (`USER_SCROLL_WINDOW` bounds it). */
  gestureAgeMs: number;
  /** A pointer is down on the scroller right now (a scrollbar drag). */
  userGesturing: boolean;
  /** The viewport or the content changed size since the previous event. */
  resized: boolean;
  /** How long a gesture keeps counting as the reader's. */
  gestureWindowMs: number;
  /** Movement smaller than this is not a scroll the reader meant. */
  smallMovePx?: number;
};

export const scrollIntent = (event: ScrollEvent): ScrollIntent => {
  const small = event.smallMovePx ?? 4;
  // A resize moved the content under a fixed scrollTop: the delta is the browser clamping, not the
  // reader. Nothing to learn from it either way.
  if (event.resized) return 'ignore';
  if (event.distanceFromBottom <= event.threshold) return 'follow';
  const movedUp = event.top < event.previousTop - small;
  if (!movedUp) return 'ignore';
  const attributed = event.userGesturing || event.gestureAgeMs <= event.gestureWindowMs;
  return attributed ? 'stop' : 'ignore';
};

/**
 * Whether a raw upward gesture (a wheel tick, a finger drag) should stop following *now*.
 *
 * `scrollIntent` can only answer from a finished scroll event, and a streaming turn puts a pinned
 * ResizeObserver between the gesture and that event: measured in the app, one 100px wheel up moved
 * the reader 40px and then the next chunk pinned them for 2.4s until they cleared `FOLLOW_THRESHOLD`
 * on their own. That fight is the reported "it is hard to scroll up when you are at the bottom".
 *
 * An upward wheel or finger is unambiguous — content only ever grows downward, so nothing but the
 * reader scrolls up — which makes it safe to decide before any content can arrive.
 */
export type GestureEvent = {
  /** The gesture's own delta: negative is up (a wheel), or a finger moving down the screen. */
  deltaY: number;
  /** Whether the transcript is still pinned to the end. */
  following: boolean;
  /** `scrollTop` right now: at 0 there is nowhere further up to go. */
  scrollTop: number;
};

/**
 * True when this gesture means the reader wants to leave the end.
 *
 * Deliberately *not* gated on `FOLLOW_THRESHOLD`: the whole point is to yield on the first tick
 * rather than let the pin consume the first 48px. At `scrollTop 0` nothing is disengaged — that is
 * the browser's elastic overscroll, and the scroll event that follows decides.
 */
export const gestureLeavesBottom = (event: GestureEvent): boolean =>
  event.deltaY < 0 && event.following && event.scrollTop > 0;
