import { MOSAIC_PROFILES } from './mosaicProfiles';
import { mosaicTrailPlan } from './mosaicTrailPlan';

export type ActivityCell = { x: number; y: number; fill: string; opacity?: number };
export type ActivityEvent = { at: number; until: number; cells: ActivityCell[] };
export type MosaicActivityPlan = { duration: number; delay: number; tracks: ActivityEvent[][]; slots: number };
/** Both active moods use independent births with full retained lifetimes. */
export function mosaicActivityPlan(cells: readonly ActivityCell[], seed: string, mood: 'busy' | 'thinking') {
  return mosaicTrailPlan(cells, seed, MOSAIC_PROFILES[mood]);
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
