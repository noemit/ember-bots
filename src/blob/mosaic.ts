import { IDENTITY_COLORS, contrastRatio, ensureContrast, hexToOklch, oklchToHexColor, perceptualDistance } from './contrast';
import { hashString, mulberry32 } from './seed';
import type { AvatarIdentity } from '../types';

// One unit is one body pixel, including every eye and gaze frame. Every row is a solid run;
// the notches, antennae and feet belong to the silhouette, not random pixel noise.
export const MOSAIC_SHAPES = [
  { name: 'tuft', rows: [[5,7],[4,8],[3,9],[2,9],[2,10],[1,10],[2,10],[2,10],[2,9],[3,9],[3,8],[3,7]] },
  { name: 'sprig', rows: [[3,4],[3,8],[2,9],[1,9],[2,9],[2,10],[1,10],[2,10],[2,9],[3,9],[3,8],[3,7]] },
  { name: 'pebble', rows: [[4,8],[3,9],[2,10],[2,10],[1,11],[1,11],[1,11],[1,11],[2,10],[2,9],[3,8],[4,6]] },
  { name: 'crown', rows: [[4,5],[3,9],[2,9],[2,9],[2,10],[1,10],[1,11],[2,10],[2,10],[2,9],[3,8],[3,7]] },
  { name: 'ribbon', rows: [[4,9],[3,9],[3,9],[1,9],[3,10],[3,11],[2,10],[2,9],[3,9],[3,8],[3,8],[3,7]] },
  { name: 'sail', rows: [[6,8],[4,9],[3,9],[2,10],[2,10],[2,10],[2,11],[2,10],[1,10],[2,9],[3,8],[3,6]] },
] as const;

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
  // Centre two two-cell eyes in the shared resting/raised-thinking rows.
  const eyeRows = [eyeY - 1, eyeY].map(y => cells.filter(cell => cell.y === y).map(cell => cell.x));
  const eyeLeft = Math.max(...eyeRows.map(xs => Math.min(...xs)));
  const eyeRight = Math.min(...eyeRows.map(xs => Math.max(...xs)));
  const eyeX = Math.floor((eyeLeft + eyeRight - 4) / 2);
  return { name: shape.name, cells, mirrored, lookRight: rng() > 0.5,
    eyes: [{ x: eyeX, y: eyeY }, { x: eyeX + 3, y: eyeY }],
    errorEyes: [{ x: errorX, y: errorY }, { x: errorX + 4, y: errorY }] };
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

/** Largest OKLab step allowed between two orthogonally touching body tiles. */
export const MOSAIC_MAX_NEIGHBOR_DELTA = .065;
/** Stone's panel/elev/bg: the default only for server rendering, where no theme is applied. */
const FALLBACK_SURFACES = ['#d9d9d5', '#d0d0cb', '#e5e5e3'];
const HEX = /^#[0-9a-f]{6}$/i;
const FIELD_CONTRAST = 1.6;

/** Preserve a field colour's hue and chroma while lifting/darkening it only as far as the theme
 * requires. The generic ensureContrast can jump to an extreme (black is technically safe on a dark
 * surface), which would turn a generated tile into a flat dark patch. */
function ensureFieldContrast(hex: string, surfaces: string[]): string {
  if (surfaces.every(surface => contrastRatio(hex, surface) >= FIELD_CONTRAST)) return hex;
  const [lightness, chroma, hue] = hexToOklch(hex);
  const day = contrastRatio('#000000', surfaces[0]) > contrastRatio('#ffffff', surfaces[0]);
  const direction = day ? -1 : 1;
  for (let step = 1; step <= 48; step++) {
    const candidate = oklchToHexColor(Math.max(.02, Math.min(.98, lightness + direction * step * .012)), chroma, hue);
    if (surfaces.every(surface => contrastRatio(candidate, surface) >= FIELD_CONTRAST)) return candidate;
  }
  return ensureContrast(hex, surfaces);
}
type Position = { x: number; y: number };
type ContrastResult = ReturnType<typeof neighborMetrics> & { colors: string[]; spatialScale: number; hueSpanDegrees: number };

/**
 * Concrete colour behind `blobColor`'s `var(--blob-N)`. The smooth field has to work in OKLab and
 * clear contrast against the theme's real surfaces, neither of which can be done on a CSS variable.
 * A browser reads the applied theme; static rendering falls back to the unthemed palette entry.
 */
export function mosaicBaseHex(identity: AvatarIdentity): string {
  if (identity.color) return identity.color;
  const index = Math.abs(identity.colorIndex ?? hashString(`mosaic:${identity.colorSeed}`) % IDENTITY_COLORS.length) % IDENTITY_COLORS.length;
  if (typeof document !== 'undefined') {
    const applied = getComputedStyle(document.documentElement).getPropertyValue(`--blob-${index}`).trim();
    if (HEX.test(applied)) return applied;
  }
  return IDENTITY_COLORS[index];
}

/** The surfaces a blob actually sits on: rail panel, selected row, and chat header. */
export function mosaicSurfaces(revision = 0): string[] {
  // `revision` is the explicit dependency signal for callers that re-render after applyTheme.
  void revision;
  if (typeof document === 'undefined') return FALLBACK_SURFACES;
  const style = getComputedStyle(document.documentElement);
  const values = ['--card', '--secondary', '--background'].map(name => style.getPropertyValue(name).trim());
  return values.every(value => HEX.test(value)) ? values : FALLBACK_SURFACES;
}

function neighborPairs(cells: readonly Position[]): [number, number][] {
  const indices = new Map(cells.map((cell, i) => [`${cell.x}:${cell.y}`, i]));
  const pairs: [number, number][] = [];
  cells.forEach(({ x, y }, i) => {
    for (const key of [`${x + 1}:${y}`, `${x}:${y + 1}`]) {
      const j = indices.get(key);
      if (j !== undefined) pairs.push([i, j]);
    }
  });
  return pairs;
}

function neighborMetrics(colors: readonly string[], pairs: readonly [number, number][]) {
  const distances = pairs.map(([i, j]) => perceptualDistance(colors[i], colors[j])).sort((a, b) => a - b);
  const percentile = (p: number) => distances.length ? distances[Math.max(0, Math.ceil(distances.length * p) - 1)] : 0;
  return {
    maxNeighbor: distances.at(-1) ?? 0,
    p95Neighbor: percentile(.95),
    minNeighbor: distances[0] ?? 0,
    p05Neighbor: percentile(.05),
    equalNeighbors: distances.filter(distance => distance === 0).length,
    neighborCount: distances.length,
  };
}

/** Measurements of FINAL rendered hex colours, not idealised pre-gamut samples.
 * Pass body cells only: eye ink/whites are overlays and are deliberately outside the field.
 */
export function mosaicFieldMetrics(cells: readonly Position[], colors: readonly string[]) {
  if (cells.length !== colors.length) throw new RangeError('Each body cell needs one colour');
  let gamutRange = 0;
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
    gamutRange = Math.max(gamutRange, perceptualDistance(colors[i], colors[j]));
  }
  return { ...neighborMetrics(colors, neighborPairs(cells)), gamutRange };
}

/**
 * A continuous diagonal colour field through the body's actual pixel coordinates. Neighbouring
 * tiles differ in both axes without checkerboard noise; hues travel broadly through intermediate
 * shades instead of changing at a band boundary. Chroma is preserved (with a floor for pale
 * identities) rather than averaged, and the FINAL hex lattice — after gamut mapping and contrast
 * correction — is measured against the neighbour cap. Zooming out the spatial field is the cost
 * of meeting a tighter cap; it never flattens pixels by copying or blending neighbours.
 */
export function mosaicField(
  base: string,
  cells: readonly Position[],
  seed: string,
  surfaces: string[],
  maxDelta = MOSAIC_MAX_NEIGHBOR_DELTA,
): ContrastResult {
  if (!Number.isFinite(maxDelta) || maxDelta < 0) throw new RangeError('Neighbor bound must be finite and nonnegative');
  const [baseLightness, baseChroma, hue] = hexToOklch(base);
  const chroma = Math.max(.14, baseChroma);
  const rng = mulberry32(hashString(`mosaic-smooth:${seed}`));
  const angle = .6 + rng() * .35;
  const dx = Math.cos(angle) * (rng() > .5 ? 1 : -1);
  const dy = Math.sin(angle);
  const projections = cells.map(({ x, y }) => x * dx + y * dy);
  const min = cells.length ? Math.min(...projections) : 0;
  const max = cells.length ? Math.max(...projections) : 0;
  const width = Math.max(1, max - min);
  const center = (min + max) / 2;
  const centerX = cells.length ? cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length : 0;
  const centerY = cells.length ? cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length : 0;
  const pairs = neighborPairs(cells);
  const paint = (scale: number) => cells.map(({ x, y }, i) => {
    const t = (projections[i] - center) / width;
    const lightness = Math.max(.15, Math.min(.9, baseLightness + scale * .007 * ((x - centerX) * dy - (y - centerY) * dx)));
    return ensureFieldContrast(oklchToHexColor(lightness, chroma, hue + t * 260 * scale), surfaces);
  });
  let spatialScale = 1;
  let colors = paint(spatialScale);
  let metrics = neighborMetrics(colors, pairs);
  // Most fields need one correction. The proportional guess avoids the old .9 walk's 15+ repaints;
  // final acceptance is always the measured hex field, not an assumed linear scale.
  for (let attempt = 1; metrics.maxNeighbor > maxDelta && spatialScale > .001; attempt++) {
    const ratio = Math.max(.05, (maxDelta * .97) / Math.max(metrics.maxNeighbor, 1e-6));
    spatialScale = attempt > 8 ? spatialScale * .5 : Math.min(spatialScale, spatialScale * ratio);
    colors = paint(spatialScale);
    metrics = neighborMetrics(colors, pairs);
  }
  if (metrics.maxNeighbor > maxDelta) {
    spatialScale = 0;
    colors = paint(0);
  }
  // The renderer only needs the neighbour cap; whole-body gamut is a study/verification metric.
  return { colors, ...neighborMetrics(colors, pairs), spatialScale, hueSpanDegrees: 260 * spatialScale };
}
