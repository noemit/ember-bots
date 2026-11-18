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

const defaultScheduleFrame = (callback: () => void): number =>
  typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(callback)
    : (globalThis.setTimeout(callback, 16) as unknown as number);

const defaultCancelFrame = (handle: number): void => {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle);
  } else {
    globalThis.clearTimeout(handle);
  }
};

/** Coalesce scroll and resize geometry checks to at most one measurement per animation frame. */
export function createReadingGeometryScheduler(
  measure: () => void,
  scheduleFrame: (callback: () => void) => number = defaultScheduleFrame,
  cancelFrame: (handle: number) => void = defaultCancelFrame,
): { schedule: () => void; flush: () => void; cancel: () => void } {
  let frame: number | null = null;
  return {
    schedule() {
      if (frame !== null) return;
      frame = scheduleFrame(() => {
        frame = null;
        measure();
      });
    },
    flush() {
      if (frame !== null) {
        cancelFrame(frame);
        frame = null;
      }
      measure();
    },
    cancel() {
      if (frame === null) return;
      cancelFrame(frame);
      frame = null;
    },
  };
}
