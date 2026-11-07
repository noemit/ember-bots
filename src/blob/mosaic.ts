import { hashString, mulberry32 } from './seed';
import type { AvatarIdentity } from '../types';

// One unit is one body pixel. Tiles and error crosses use whole cells; the expressive face is a
// separate, softly drawn layer in the outer 100-unit viewBox.
// Every row is a solid run;
// the notches, antennae and feet belong to the silhouette, not random pixel noise.
export const MOSAIC_SHAPES = [
  { name: 'tuft', rows: [[5,7],[4,8],[3,9],[2,9],[2,10],[1,10],[2,10],[2,10],[2,9],[3,9],[3,8],[3,7]] },
  { name: 'sprig', rows: [[3,4],[3,8],[2,9],[1,9],[2,9],[2,10],[1,10],[2,10],[2,9],[3,9],[3,8],[3,7]] },
  { name: 'pebble', rows: [[4,8],[3,9],[2,10],[2,10],[1,11],[1,11],[1,11],[1,11],[2,10],[2,9],[3,8],[4,6]] },
  { name: 'crown', rows: [[4,5],[3,9],[2,9],[2,9],[2,10],[1,10],[1,11],[2,10],[2,10],[2,9],[3,8],[3,7]] },
  { name: 'ribbon', rows: [[4,9],[3,9],[3,9],[1,9],[3,10],[3,11],[2,10],[2,9],[3,9],[3,8],[3,8],[3,7]] },
  { name: 'sail', rows: [[6,8],[4,9],[3,9],[2,10],[2,10],[2,10],[2,11],[2,10],[1,10],[2,9],[3,8],[3,6]] },
] as const;

/** Unequal, slightly lopsided whites: a tall left eye and a smaller, lower right eye. */
export const MOSAIC_EYES = [
  { x: -14, y: 0, pupilRadius: 6.5,
    path: 'M-12-4 C-13-12-6-16 1-15 C9-16 14-8 13 1 C14 9 8 15-1 14 C-9 15-14 7-12-4Z' },
  { x: 14, y: 2, pupilRadius: 6,
    path: 'M-11-3 C-11-10-5-14 2-13 C9-12 13-5 12 3 C11 11 5 14-3 12 C-9 11-13 5-11-3Z' },
] as const;
export const MOSAIC_PUPIL_REACH = 4;

export function mosaicGeometry(identity: AvatarIdentity) {
  const rng = mulberry32(hashString(`mosaic:${identity.shapeSeed}`));
  const shape = MOSAIC_SHAPES.find(s => s.name === identity.shapeName) ?? MOSAIC_SHAPES[Math.floor(rng() * MOSAIC_SHAPES.length)];
  const mirrored = rng() > 0.5;
  const diagonal = rng() > 0.5;
  const cells = shape.rows.flatMap(([start, end], y) => Array.from({ length: end - start }, (_, i) => {
    const x = mirrored ? 11 - (start + i) : start + i;
    return { x, y: y + 1, band: diagonal ? (x + Math.floor(y / 2)) % 12 : x };
  }));
  const eyeY = 6;
  // Two three-cell X eyes need seven columns including their gap. Centre that span inside
  // the intersection of all three face rows, so narrow/mirrored bodies keep full-size pixels.
  const errorY = eyeY - 1;
  const faceRows = [errorY, errorY + 1, errorY + 2].map(y => cells.filter(cell => cell.y === y).map(cell => cell.x));
  const left = Math.max(...faceRows.map(xs => Math.min(...xs)));
  const right = Math.min(...faceRows.map(xs => Math.max(...xs)));
  const errorX = Math.floor((left + right - 6) / 2);
  // Fit the whole expressive face inside a solid five-row patch, even on narrow mirrored bodies.
  const eyeRows = [4, 5, 6, 7, 8].map(y => cells.filter(cell => cell.y === y).map(cell => cell.x));
  const faceLeft = Math.max(...eyeRows.map(xs => Math.min(...xs)));
  const faceRight = Math.min(...eyeRows.map(xs => Math.max(...xs))) + 1;
  const face = { x: 8 + (faceLeft + faceRight) * 3.5, y: 46.5, scale: Math.min(1, ((faceRight - faceLeft) * 7 - 2) / 56) };
  return { name: shape.name, cells, face, errorEyes: [{ x: errorX, y: errorY }, { x: errorX + 4, y: errorY }] };
}

/** Side pixels follow the silhouette, on its own grid, with room for a second outward beat. */
export function mosaicActivityPixels(cells: readonly { x: number; y: number }[]) {
  return [3, 5, 8, 10].flatMap((y, row) => {
    const xs = cells.filter(cell => cell.y === y).map(cell => cell.x);
    if (!xs.length) return [];
    return ([-1, 1] as const).flatMap(side => {
      const edge = side === -1 ? Math.min(...xs) : Math.max(...xs);
      return [1, 2].flatMap(distance => {
        const x = edge + side * distance;
        const pixelY = y - (distance === 2 ? 1 : 0);
        if (x < -1 || x > 12 || cells.some(cell => cell.x === x && cell.y === pixelY)) return [];
        return [{ x, y: pixelY, side, distance, delay: row * 0.23 + (side === 1 ? 0.65 : 0) + (distance - 1) * 0.16 }];
      });
    });
  });
}

/** Broad colour ribbons with small tile-to-tile shifts, like translucent stacked paper. */
export function mosaicTileColor(base: string, band: number, y: number, seed: string): string {
  const accents = ['#ff683b', '#ffc84b', '#f29cdb', '#6554ed', '#36bac8', '#75b77c'];
  const offset = hashString(`mosaic-palette:${seed}`) % accents.length;
  const accent = accents[(offset + (band < 6 ? 0 : 2)) % accents.length];
  const amount = Math.round(Math.abs(band - 5.5) * 15);
  // Hue interpolation keeps opposite colours vivid instead of making grey seams.
  const ribbon = `color-mix(in oklch, ${base}, ${accent} ${amount}%)`;
  const shade = Math.abs(y - 6) * 2 + (band % 2) * 2;
  return `color-mix(in srgb, ${ribbon}, ${y < 6 ? '#fff8df' : '#19152c'} ${shade}%)`;
}
