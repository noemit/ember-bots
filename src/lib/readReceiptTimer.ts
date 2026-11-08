/**
 * How long the "Marked read" receipt stays on screen, and who may keep it there.
 *
 * The receipt is the undo surface for an explicit read mark: it has to be long enough to notice, and
 * it must get out of the way of a reader who is already moving on. A single fixed timeout got both
 * wrong — it vanished while someone was reaching for Undo, and it lingered in front of the transcript
 * once it was no longer wanted.
 *
 * The rule, in full:
 *
 *   - it appears with the mark and leaves **1s** later if nobody touches it;
 *   - pointing at it, or putting keyboard focus anywhere inside it, **holds** it — but only until
 *     **5s after it appeared**. The cap is measured from appearance, not from the last interaction,
 *     so a pointer resting on a corner of the transcript can't keep a stale receipt up for ever;
 *   - **leaving** before that cap dismisses it **promptly**: after a small grace
 *     (`READ_RECEIPT_LEAVE_GRACE_MS`), so a hand slipping across it on the way back to the text
 *     doesn't snuff it out, and so the Undo the reader was aiming at is still there when the pointer
 *     arrives. Re-entering inside the grace simply re-holds it;
 *   - after the cap it goes on its own, hovered, focused or not;
 *   - reduced motion changes nothing: this is a timer, never a CSS delay, so the receipt is present
 *     or absent at the same instants either way.
 *
 * `readReceiptDismissIn` is a pure function of the four inputs, so the component re-runs it whenever
 * one of them changes and arms one `setTimeout` for the answer. Asking "how long from *now*" rather
 * than "is it time yet" keeps the receipt's state to a small object and makes every case — hold, cap,
 * release, re-enter — an ordinary effect re-run instead of a graph of stored deadlines.
 *
 * "Released" is a distinct state from "never touched", and the caller has to say which it is: a
 * pointer that has been on the receipt and left gets the short grace, while a receipt nobody has
 * touched keeps its full second. Both are still bounded by the cap.
 */

/** How long the receipt stays if nobody touches it. */
export const READ_RECEIPT_MS = 1_000;
/** The longest it may stay on screen, measured from the moment it appeared. */
export const READ_RECEIPT_MAX_MS = 5_000;
/** After the pointer/focus leaves, how long before it goes. Short, but not instant. */
export const READ_RECEIPT_LEAVE_GRACE_MS = 150;

/** What the receipt needs to know about the moment being asked about. */
export type ReadReceiptState = {
  /** Epoch ms the receipt appeared (the version it was shown for), not the last interaction. */
  appearedAt: number;
  /** The moment to answer for, so callers and tests can ask about any instant deterministically. */
  now: number;
  /** Pointer over the receipt. */
  hovered: boolean;
  /** Focus is inside the receipt — exactly like hover, so keyboard users get the same hold. */
  focused: boolean;
  /**
   * The pointer/focus was on the receipt and has since left it. Without this, "not held" cannot tell
   * "nobody ever touched it" (the full default) from "released after holding" (the short grace).
   */
  released?: boolean;
};

/**
 * Milliseconds from `now` until the receipt should be dismissed. Never negative: `0` means "now",
 * because it is already at or past its cap, or its release grace has run out.
 */
export const readReceiptDismissIn = ({ appearedAt, now, hovered, focused, released = false }: ReadReceiptState): number => {
  const cap = appearedAt + READ_RECEIPT_MAX_MS;
  // Held (or already past the cap, where nothing can hold it any more): the cap is the only deadline.
  if (hovered || focused) return Math.max(0, cap - now);
  // Released: prompt, but through a short grace so passing across the receipt doesn't kill it.
  if (released) return Math.max(0, Math.min(now + READ_RECEIPT_LEAVE_GRACE_MS, cap) - now);
  // Never touched: the visible second, counted from appearance, so a late question finds the receipt
  // already gone rather than granting it a fresh second.
  return Math.max(0, Math.min(appearedAt + READ_RECEIPT_MS, cap) - now);
};

/** Whether the receipt's time is up right now — what the component checks when an event arrives. */
export const readReceiptIsDone = (state: ReadReceiptState): boolean => readReceiptDismissIn(state) === 0;
