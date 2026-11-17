import { hashString, mulberry32 } from './seed';
import { mosaicThinkingPlan } from './mosaicThinkingPlan';

export type ActivityCell = { x: number; y: number; fill: string; opacity?: number };
export type ActivityEvent = { at: number; until: number; cells: ActivityCell[] };
export type MosaicActivityPlan = { duration: number; delay: number; tracks: ActivityEvent[][]; slots: number };
const key = (x: number, y: number) => `${x}:${y}`;
const adjacent = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/** Outside neighbours of the silhouette, including top/bottom and notches, on the original grid.
 * Pigment comes from the adjacent body cell. Nothing moves the body, eyes or decision badges. */
export function mosaicPerimeter(cells: readonly ActivityCell[]): ActivityCell[] {
  const body = new Set(cells.map(cell => key(cell.x, cell.y)));
  const edge = new Map<string, ActivityCell>();
  for (const cell of cells) for (const delta of adjacent) {
    const x = cell.x + delta.x, y = cell.y + delta.y;
    if (x < -1 || x > 12 || y < 0 || y > 13 || body.has(key(x, y))) continue;
    if (!edge.has(key(x, y))) edge.set(key(x, y), { x, y, fill: cell.fill });
  }
  return [...edge.values()];
}

/** Long, seeded event tracks vary location, cluster size, hold and rest independently. CSS owns
 * the clock: there are no animation timers, frame callbacks or React updates during playback. */
export function mosaicActivityPlan(cells: readonly ActivityCell[], seed: string, mood: 'busy' | 'thinking'): MosaicActivityPlan {
  if (mood === 'thinking') return mosaicThinkingPlan(cells, seed);
  const random = mulberry32(hashString(`mosaic-perimeter:${seed}:${mood}`));
  const perimeter = mosaicPerimeter(cells);
  const duration = 79 + Math.floor(random() * 28);
  const delay = -random() * duration;
  const tracks = Array.from({ length: 2 }, () => {
    const events: ActivityEvent[] = [];
    if (!perimeter.length) return events;
    let at = random() * 3, previous = -1;
    while (at < duration - 3) {
      let index = Math.floor(random() * perimeter.length);
      if (index === previous) index = (index + 1) % perimeter.length;
      previous = index;
      const origin = perimeter[index];
      const neighbours = perimeter.filter(cell => cell !== origin && Math.abs(cell.x - origin.x) + Math.abs(cell.y - origin.y) <= 2);
      const cluster = [origin];
      const count = 1 + Math.floor(random() * 3);
      while (cluster.length < count && neighbours.length) cluster.push(neighbours.splice(Math.floor(random() * neighbours.length), 1)[0]);
      const until = at + (.22 + random() * .65);
      events.push({ at, until, cells: cluster });
      at = until + (.45 + random() * 1.7);
    }
    return events;
  });
  return { duration, delay, tracks, slots: 3 };
}

export function activityKeyframes(events: ActivityEvent[], slot: number, duration: number): string {
  const frames = ['0%{opacity:0}', '100%{opacity:0}'];
  for (const event of events) {
    const cell = event.cells[slot];
    if (!cell) continue;
    frames.push(`${(event.at / duration * 100).toFixed(4)}%{opacity:${cell.opacity ?? 1};transform:translate(${cell.x}px,${cell.y}px);fill:${cell.fill}}`);
    frames.push(`${(event.until / duration * 100).toFixed(4)}%{opacity:0}`);
  }
  return frames.join('');
}
