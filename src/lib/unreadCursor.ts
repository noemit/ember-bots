/**
 * The reading cursor behind the unread strip's cycling control.
 *
 * The strip used to be a single button that always jumped to the *newest* unread reply, which is
 * fine for one arrival and useless for seven: the reader sees the bottom of a backlog and has no
 * way to start at its top, or to walk down it in order. Cycling needs a position that survives
 * between clicks, and that position is the only state the control has — so it lives here, as plain
 * numbers, rather than inside the JSX where it could not be tested without a DOM.
 *
 * Two rules the arithmetic has to keep:
 *
 *   - the cursor is a *position in the strip*, not a message id. The list is rebuilt on every
 *     render (`items` is derived), and an id-keyed cursor would need the caller to decide what a
 *     vanished id means. A position plus a reset on any change to the list is simpler and cannot
 *     point at a message that is gone.
 *   - it is **browsing state only**. Nothing here marks a reply as read, which is why the count the
 *     label reads from stays the same however many times the reader cycles.
 */

/**
 * Where the next cycle click should land, as an index into the unread list.
 *
 * `null` means "no cursor yet" and starts at the oldest unread: the first click goes to the top of
 * the backlog, because that is where reading starts. Every later click moves one reply down, and
 * the one after the last wraps back to the oldest so the control never runs out.
 *
 * A stale cursor (one past the end, or negative) is treated as no cursor rather than clamped: it
 * comes from a list that has since shrunk, and restarting at the oldest is what a reader would
 * expect after the list changed under them. The caller resets on those changes anyway; this only
 * makes the failure harmless if one is missed.
 */
export function nextUnreadCursor(current: number | null, length: number): number {
  const at = Math.trunc(current ?? -1);
  if (at < 0 || at >= length) return 0;
  return (at + 1) % length;
}

/**
 * The badge: "which unread am I looking at, out of how many".
 *
 * A bare total made cycling look broken — several clicks in a row can barely move the viewport
 * when a reply is taller than the screen, and the only visible number stayed `7`. The position is
 * what tells the reader the click did something.
 *
 * With no cursor yet the label is `0/7`: nothing is being looked at, and the first click will go to
 * the oldest. An empty list has no strip at all, but it still answers honestly (`0/0`) rather than
 * producing `1/0`.
 */
export function unreadPositionLabel(current: number | null, length: number): string {
  const total = Math.max(0, Math.trunc(length));
  if (total === 0) return '0/0';
  const at = current === null || current < 0 || current >= total ? 0 : Math.trunc(current);
  return `${at + 1}/${total}`;
}

/** The same position, spelled out, for the button's accessible name. */
export function unreadPositionName(current: number | null, length: number): string {
  const total = Math.max(0, Math.trunc(length));
  const label = unreadPositionLabel(current, total);
  return total === 0 ? 'No unread replies' : `Unread reply ${label}`;
}
