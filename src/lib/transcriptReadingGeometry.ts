import { parseCrewReport } from './crew';
import type { ChatMessage } from '../types';

/** Crew wakes render as report cards, not as messages from the human. */
export function isHumanReadingMessage(message: Pick<ChatMessage, 'role' | 'text'>): boolean {
  return message.role === 'user' && !parseCrewReport(message.text);
}

/**
 * A bot turn with no prose is only tool calls (or a still-empty reply). Jumping to it would land the
 * reader on a stretch of folded tool output with nothing to read, so it is not a destination.
 */
export function isProseAssistantMessage(message: Pick<ChatMessage, 'role' | 'text'>): boolean {
  return message.role === 'assistant' && message.text.trim().length > 0;
}

/** All bounds share viewport coordinates. Partial visibility counts as visible. */
export type ReadingBounds = { top: number; bottom: number };

export type JumpTarget = {
  index: number;
  /**
   * `start` puts the target's own top edge in view. The reading helpers ask for it in every case:
   * the point of the jump is to find the *beginning* of the thing again, whether that is the
   * clipped message itself or the one above it.
   */
  align: 'start' | 'center';
};

type ReadingRow = ReadingBounds & { index: number };

/**
 * Where "previous message of this kind" should go, from what is on screen right now.
 *
 * A reader scrolled into the middle of a long reply has lost its opening lines; they are not
 * looking for the *previous* reply, they are looking for the top of this one. A reader with a
 * whole reply on screen is past it, so the previous one is what "previous" means. Both kinds are
 * resolved by this one rule so the visibility test and the target can never disagree — which is
 * what a boolean "show the pill?" plus a separate "which index?" could not guarantee.
 */
export function previousTarget(
  viewport: ReadingBounds,
  rows: readonly ReadingRow[],
): JumpTarget | null {
  // A collapsed viewport has no reading position to reason about; offering a jump from one would
  // be guessing.
  if (viewport.bottom <= viewport.top) return null;
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  const visible = sorted.filter(row => row.bottom > viewport.top && row.top < viewport.bottom);
  const current = visible[visible.length - 1];
  if (current) {
    // Clipped at the top means the row started above the viewport but has not ended there: the
    // reader is inside it. A row that merely begins just below the top edge is fully visible.
    if (current.top < viewport.top) return { index: current.index, align: 'start' };
  }
  // Fully visible row, or nothing of this kind on screen at all: either way the destination is the
  // last one that ended above the viewport.
  return previousAbove(sorted, viewport.top);
}

/**
 * "Above" is positional, not by index: the caller passes rows in message order, and the last one
 * whose bottom edge has left the top of the viewport is the nearest thing above it.
 */
function previousAbove(rows: readonly ReadingRow[], viewportTop: number): JumpTarget | null {
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at];
    if (row.bottom <= viewportTop) return { index: row.index, align: 'start' };
  }
  return null;
}
