import { hashString, mulberry32 } from './seed';

/** One brief diagonal wash every 26–34 seconds. Grouping equal x+y cells keeps the sweep
 * stepped on the body grid, including notches; no smooth body shading or palette replacement. */
export function mosaicRainbowPlan(cells: readonly { x: number; y: number }[], seed: string) {
  const random = mulberry32(hashString(`mosaic-rainbow:${seed}`));
  const duration = 26 + random() * 8;
  const delay = -random() * duration;
  const reverse = random() > .5;
  const diagonals = [...new Set(cells.map(cell => cell.x + cell.y))].sort((a, b) => a - b);
  return { duration, bands: diagonals.map(diagonal => ({
    diagonal,
    delay: delay + (reverse ? 24 - diagonal : diagonal) * .12,
    fill: `hsl(${Math.round((diagonal / 24) * 300)} 90% 60%)`,
    cells: cells.filter(cell => cell.x + cell.y === diagonal).map(({ x, y }) => ({ x, y })),
  })) };
}
