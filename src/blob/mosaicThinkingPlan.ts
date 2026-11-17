import { hashString, mulberry32 } from './seed';
import type { ActivityCell, MosaicActivityPlan } from './mosaicActivityPlan';

export type ThinkingSide = 'left' | 'right' | 'top' | 'bottom';
export type ThinkingCell = ActivityCell & { side: ThinkingSide; distance: 1 | 2 };
export const oppositeThinkingSide: Record<ThinkingSide, ThinkingSide> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

/** Outer row/column extrema, not neighbours inside notches: a side describes the avatar's
 * silhouette, never the eyes. Distance 1 touches its edge; 2 leaves one empty grid cell.
 * Keep each candidate in its cardinal half of the bounding box so opposite pairs read apart
 * even on irregular tips. Reject anything outside the existing 100px SVG canvas. */
export function mosaicThinkingCandidates(cells: readonly ActivityCell[]): ThinkingCell[] {
  if (!cells.length) return [];
  const centerX = (Math.min(...cells.map(c => c.x)) + Math.max(...cells.map(c => c.x))) / 2;
  const centerY = (Math.min(...cells.map(c => c.y)) + Math.max(...cells.map(c => c.y))) / 2;
  const candidates = new Map<string, ThinkingCell>();
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const horizontal = side === 'left' || side === 'right';
    const sign = side === 'left' || side === 'top' ? -1 : 1;
    for (const cell of cells) {
      const row = cells.filter(other => horizontal ? other.y === cell.y : other.x === cell.x);
      if (row.some(other => sign * (horizontal ? other.x - cell.x : other.y - cell.y) > 0)) continue;
      for (const distance of [1, 2] as const) {
        const x = cell.x + (horizontal ? sign * distance : 0);
        const y = cell.y + (horizontal ? 0 : sign * distance);
        if (x < -1 || x > 12 || y < 0 || y > 13) continue;
        if (sign * (horizontal ? x - centerX : y - centerY) <= 0) continue;
        // A corner can qualify for two sides. Keep one stable classification per coordinate.
        const key = `${x}:${y}`;
        if (!candidates.has(key)) candidates.set(key, { x, y, fill: cell.fill, side, distance });
      }
    }
  }
  return [...candidates.values()];
}

/** A single coordinated clock prevents independent holds overlapping. Usually one pixel;
 * occasional opposing pairs share one hold and clear together before the following beat. */
export function mosaicThinkingPlan(cells: readonly ActivityCell[], seed: string): MosaicActivityPlan {
  const random = mulberry32(hashString(`mosaic-thinking-beats:${seed}`));
  const duration = 31 + Math.floor(random() * 12);
  const delay = -random() * duration;
  const candidates = mosaicThinkingCandidates(cells);
  const events: MosaicActivityPlan['tracks'][number] = [];
  let at = .05 + random() * .15;
  let previous = '';
  while (candidates.length && at < duration - .5) {
    const options = candidates.filter(cell => `${cell.x}:${cell.y}` !== previous);
    const origin = options[Math.floor(random() * options.length)] ?? candidates[0];
    previous = `${origin.x}:${origin.y}`;
    const pixels = [origin];
    if (random() < .15) {
      const opposite = candidates.filter(cell => cell.side === oppositeThinkingSide[origin.side]);
      if (opposite.length) pixels.push(opposite[Math.floor(random() * opposite.length)]);
    }
    const until = at + .16 + random() * .14;
    events.push({ at, until, cells: pixels.map(cell => ({ ...cell, opacity: .3 + Math.floor(random() * 8) / 10 })) });
    at = until + .04 + random() * .06;
  }
  return { duration, delay, tracks: [events], slots: 2 };
}
