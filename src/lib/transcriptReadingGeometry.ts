import { parseCrewReport } from './crew';
import type { ChatMessage } from '../types';

/** Crew wakes render as report cards, not as messages from the human. */
export function isHumanReadingMessage(message: Pick<ChatMessage, 'role' | 'text'>): boolean {
  return message.role === 'user' && !parseCrewReport(message.text);
}

/** All bounds share viewport coordinates. Partial visibility counts as visible. */
export type ReadingBounds = { top: number; bottom: number };
export function shouldOfferLastMessageJump(
  viewport: ReadingBounds,
  latestUser: ReadingBounds | undefined,
  userMessages: readonly ReadingBounds[],
): boolean {
  if (viewport.bottom <= viewport.top || !latestUser || latestUser.bottom > viewport.top) return false;
  return !userMessages.some(row => row.bottom > viewport.top && row.top < viewport.bottom);
}
