/**
 * When the "previous message" pills are on screen.
 *
 * The pills used to be permanent chrome: floating over the transcript text from the moment a
 * target existed, whether or not anyone was reading that way. They are an offer, not a status, so
 * they now appear on the two moments the offer is relevant — the pointer is over the conversation,
 * or the reader has just scrolled and may be looking for somewhere earlier.
 *
 * The two triggers are deliberately *not* symmetric: hover is a state, scrolling is an event with a
 * tail. Hovering keeps them up for as long as the pointer is there; a scroll raises them for
 * `PILLS_SCROLL_MS` after the last real scroll and then takes them away again, because a reader who
 * stopped scrolling has stopped looking for a destination.
 *
 * The one interaction that would otherwise fight itself: the scroll timer fires while the pointer
 * is over the conversation. Hover wins — the reader is actively pointing at the pills' own surface,
 * and dismissing something under the cursor mid-reach is how a control becomes untrustworthy. So
 * the rules live here as a small pure reducer over the three facts the component tracks, and the
 * hide-timer re-reads them rather than deciding on its own.
 */

/** How long the pills stay after the last real scroll. */
export const PILLS_SCROLL_MS = 3_000;

/** The facts the pills' visibility depends on. */
export type JumpsVisibilityState = {
  /** The pointer is over the conversation area (`onPointerEnter`/`onPointerLeave`). */
  pointerInside: boolean;
  /** A real scroll happened, and its `PILLS_SCROLL_MS` tail has not run out. */
  scrollArmed: boolean;
  /** A click was just served: the action is complete and the destination is already on screen. */
  dismissed: boolean;
};

/**
 * Whether the pills should be rendered right now.
 *
 * `dismissed` is cleared by the next hover-enter or the next real scroll, so clicking a pill does
 * not take the control away for the rest of the session — it only retires the instance that was
 * just used.
 */
export function jumpsVisible({ pointerInside, scrollArmed, dismissed }: JumpsVisibilityState): boolean {
  if (dismissed) return false;
  return pointerInside || scrollArmed;
}

/**
 * Whether a timer that just expired may take the pills away.
 *
 * The scroll timer can fire in the same tick that a hover begins. It must not win that race: the
 * pointer is over the surface, so the reader's intent is the newer fact. Asking this at fire time
 * (rather than only clearing the armed flag) means a hover that began while the timer was pending
 * keeps the pills up for as long as it lasts.
 */
export function scrollTailMayHide(pointerInside: boolean): boolean {
  return !pointerInside;
}
