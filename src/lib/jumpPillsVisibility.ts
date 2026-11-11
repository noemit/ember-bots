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
 * Landing on a reply is not a reason to take the control away: the reader is still hovering the
 * conversation, and a jump that made its own buttons vanish would leave them nowhere to click
 * "previous" again from. Visibility is therefore a function of where the pointer is and how recently
 * the reader scrolled, and of nothing about what they clicked.
 *
 * The one interaction that would otherwise fight itself: the scroll timer fires while the pointer
 * is over the conversation. Hover wins — the reader is actively pointing at the pills' own surface,
 * and dismissing something under the cursor mid-reach is how a control becomes untrustworthy. So
 * the rules live here as small pure functions, and the hide-timer asks them rather than deciding on
 * its own.
 */

/** How long the pills stay after the last real scroll. */
export const PILLS_SCROLL_MS = 3_000;

/** The facts the pills' visibility depends on. */
export type JumpsVisibilityState = {
  /** The pointer is over the conversation area (`onPointerEnter`/`onPointerLeave`). */
  pointerInside: boolean;
  /** A real scroll happened, and its `PILLS_SCROLL_MS` tail has not run out. */
  scrollArmed: boolean;
};

/** Whether the pills should be rendered right now. */
export function jumpsVisible({ pointerInside, scrollArmed }: JumpsVisibilityState): boolean {
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
