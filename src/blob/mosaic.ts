import { IDENTITY_COLORS, contrastRatio, hexToOklch, oklchToHexColor, perceptualDistance } from './contrast';
import { hashString, mulberry32 } from './seed';
import type { AvatarIdentity } from '../types';

// One unit is one body pixel, including every eye and gaze frame. Original run-based rows
// retain their IDs and coordinates; appended masks allow notches and split tips.
export const MOSAIC_SHAPES = [
  { name: 'tuft', rows: [[5,7],[4,8],[3,9],[2,9],[2,10],[1,10],[2,10],[2,10],[2,9],[3,9],[3,8],[3,7]] },
  { name: 'sprig', rows: [[3,4],[3,8],[2,9],[1,9],[2,9],[2,10],[1,10],[2,10],[2,9],[3,9],[3,8],[3,7]] },
  { name: 'pebble', rows: [[4,8],[3,9],[2,10],[2,10],[1,11],[1,11],[1,11],[1,11],[2,10],[2,9],[3,8],[4,6]] },
  { name: 'crown', rows: [[4,5],[3,9],[2,9],[2,9],[2,10],[1,10],[1,11],[2,10],[2,10],[2,9],[3,8],[3,7]] },
  { name: 'ribbon', rows: [[4,9],[3,9],[3,9],[1,9],[3,10],[3,11],[2,10],[2,9],[3,9],[3,8],[3,8],[3,7]] },
  { name: 'sail', rows: [[6,8],[4,9],[3,9],[2,10],[2,10],[2,10],[2,11],[2,10],[1,10],[2,9],[3,8],[3,6]] },
  { name: 'arch', rows: ['..##....##..', '..###..###..', '.##########.', '.##########.', '.##########.', '.##########.', '.##########.', '.##########.', '..########..', '..########..', '...######...', '....####....'] },
  { name: 'bell', rows: ['....####....', '...######...', '...######...', '..########..', '..########..', '..########..', '..########..', '..########..', '.##########.', '.##########.', '############', '..###..###..'] },
  { name: 'star', rows: ['.....##.....', '.....##.....', '....####....', '##..####..##', '############', '.##########.', '..########..', '..########..', '..########..', '.####..####.', '.###....###.', '.##......##.'] },
  { name: 'kite', rows: ['.....##.....', '....####....', '...######...', '..########..', '.##########.', '############', '############', '.##########.', '..########..', '...######...', '....####....', '.....##.....'] },
  { name: 'lantern', rows: ['....####....', '....####....', '..########..', '.##########.', '.##########.', '.##########.', '.##########.', '.##########.', '.##########.', '..########..', '...######...', '....####....'] },
  { name: 'puddle', rows: ['............', '............', '...#####....', '..########..', '.##########.', '############', '############', '############', '.##########.', '..########..', '..###..###..', '...##..##...'] },
] as const;

/** Legacy seeds keep their original six-way draw, including persisted allocator seeds.
 * Only newly created Mosaic assignments opt into the expanded pool. Explicit names always win. */
export function mosaicSeedShapes(shapeSeed: string) {
  return shapeSeed.startsWith('allocated:mosaic-v2:') ? MOSAIC_SHAPES : MOSAIC_SHAPES.slice(0, 6);
}

export function mosaicGeometry(identity: AvatarIdentity) {
  const rng = mulberry32(hashString(`mosaic:${identity.shapeSeed}`));
  const choices = mosaicSeedShapes(identity.shapeSeed);
  const shape = MOSAIC_SHAPES.find(s => s.name === identity.shapeName) ?? choices[Math.floor(rng() * choices.length)];
  const mirrored = rng() > 0.5;
  const diagonal = rng() > 0.5;
  const cells = shape.rows.flatMap((row, y) => {
    const xs = typeof row === 'string'
      ? Array.from(row).flatMap((value, x) => value === '#' ? [x] : [])
      : Array.from({ length: row[1] - row[0] }, (_, i) => row[0] + i);
    return xs.map(column => {
      const x = mirrored ? 11 - column : column;
      return { x, y: y + 1, band: diagonal ? (x + Math.floor(y / 2)) % 12 : x };
    });
  });
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

/** Stone's panel/elev/bg: server-rendering fallback before a theme is applied. */
const FALLBACK_SURFACES = ['#d9d9d5', '#d0d0cb', '#e5e5e3'];
const HEX = /^#[0-9a-f]{6}$/i;
type Position = { x: number; y: number };
type ContrastResult = ReturnType<typeof neighborMetrics> & { colors: string[]; spatialScale: number; hueSpanDegrees: number };

/**
 * Concrete colour behind `blobColor`'s `var(--blob-N)`. Candidate A needs OKLCH coordinates and
 * contrast against the theme's real surfaces, neither of which can be computed from a CSS variable.
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

/** Approved Candidate A, copied from the prototype's aColors branch, not its midpoint.
 * The resolved assigned colour anchors a coordinate-based ±45° hue field. There is no seeded
 * colour replacement or neighbour-cap rescaling: the small per-tile shading is intentional. */
export function mosaicField(
  base: string,
  cells: readonly Position[],
  seed: string,
  surfaces: string[],
): ContrastResult {
  // Retain the call contract; Candidate A's pigment depends on body coordinates, not chat seed.
  void seed;
  const [L, C, H] = hexToOklch(base);
  const colors = cells.map(({ x, y }) => {
    const t = (x * .73 + y * .52 - 7.3) / 7.3;
    const hue = H + 45 * Math.sign(t) * Math.min(1, Math.abs(t));
    const shade = (6.5 - y) * .017 + (x - 5.5) * .004 + (((x * 13 + y * 7) % 5) - 2) * .003;
    let light = Math.max(.2, Math.min(.9, L + shade));
    const chroma = Math.max(.09, C) * (1 + (6 - y) * .01);
    let hex = oklchToHexColor(light, chroma, hue);
    const day = contrastRatio('#000000', surfaces[0]) > contrastRatio('#ffffff', surfaces[0]);
    for (let i = 0; i < 60 && surfaces.some(surface => contrastRatio(hex, surface) < 1.6); i++) {
      light = Math.max(.04, Math.min(.96, light + (day ? -.008 : .008)));
      hex = oklchToHexColor(light, chroma, hue);
    }
    return hex;
  });
  return { colors, ...neighborMetrics(colors, neighborPairs(cells)), spatialScale: 1, hueSpanDegrees: 90 };
}
