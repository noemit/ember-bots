import { hashString, mulberry32 } from './seed';
import { MOSAIC_PROFILES } from './mosaicProfiles';

/** Approved diagonal wash, below the unchanged face. Seeded duration/direction and per-chat
 * phase retain identity; the preview's global phase 0 never synchronizes the whole rail. */
export function mosaicRainbowPlan(cells: readonly { x: number; y: number }[], seed: string) {
  const profile = MOSAIC_PROFILES.thinking.rainbow;
  const random = mulberry32(hashString(`mosaic-profile-rainbow-v1:${seed}`));
  const duration = profile.cycle.min + random() * (profile.cycle.max - profile.cycle.min);
  const reverse = random() > .5;
  const delay = -mulberry32(hashString(`mosaic-rainbow-phase:${seed}`))() * duration - profile.phase * duration;
  const diagonals = [...new Set(cells.map(cell => cell.x + cell.y))].sort((a, b) => a - b);
  const end = profile.passSeconds / duration * 100;
  const frames = `0%,${end}%,100%{opacity:0}${end * .02}%,${end * .8}%{opacity:${profile.peakOpacity * .4}}${end * .2}%,${end * .6}%{opacity:${profile.peakOpacity}}`;
  return { duration, frames, bands: diagonals.map((diagonal, i) => ({
    diagonal, delay: delay + (reverse ? diagonals.length - 1 - i : i) * profile.staggerSeconds,
    fill: `hsl(${Math.round(diagonal / 24 * 300)} 90% 60%)`,
    cells: cells.filter(cell => cell.x + cell.y === diagonal).map(({ x, y }) => ({ x, y })),
  })) };
}
