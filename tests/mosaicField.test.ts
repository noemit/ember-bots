import { describe, expect, test } from 'bun:test';
import { contrastRatio, identityPaletteFor, perceptualDistance } from '../src/blob/contrast';
import { MOSAIC_MAX_NEIGHBOR_DELTA, MOSAIC_SHAPES, mosaicField, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { THEMES } from '../src/themes';

const surfacesFor = (theme: typeof THEMES[number]) => [theme.palette.panel, theme.palette.elev, theme.palette.bg];

/** Find one seed for each mirror orientation from the geometry itself. */
const orientationSeeds = (shapeName: string): string[] => {
  const seeds = new Map<boolean, string>();
  for (let i = 0; i < 200 && seeds.size < 2; i++) {
    const seed = `orientation-${shapeName}-${i}`;
    const { mirrored } = mosaicGeometry({ ...seedIdentity(seed), shapeName });
    if (!seeds.has(mirrored)) seeds.set(mirrored, seed);
  }
  expect(seeds.size).toBe(2);
  return [...seeds.values()];
};

const assertField = (cells: ReturnType<typeof mosaicGeometry>['cells'], colors: string[], surfaces: string[], label: string) => {
  expect(colors, label).toHaveLength(cells.length);
  expect(colors, label).not.toContain('#fffdf5');
  expect(colors, label).not.toContain('#14111a');
  const byPosition = new Map(cells.map((cell, i) => [`${cell.x}:${cell.y}`, colors[i]]));
  let equal = 0;
  let max = 0;
  let min = Infinity;
  for (const [i, cell] of cells.entries()) {
    for (const neighbor of [`${cell.x + 1}:${cell.y}`, `${cell.x}:${cell.y + 1}`]) {
      const other = byPosition.get(neighbor);
      if (other === undefined) continue;
      const distance = perceptualDistance(colors[i], other);
      if (distance === 0) equal++;
      max = Math.max(max, distance);
      min = Math.min(min, distance);
    }
  }
  expect(max, `${label}: neighbour cap`).toBeLessThanOrEqual(MOSAIC_MAX_NEIGHBOR_DELTA);
  expect(equal, `${label}: no flat neighbour plateaus`).toBe(0);
  expect(min, `${label}: every neighbour visibly distinct`).toBeGreaterThan(.001);
  let range = 0;
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
    range = Math.max(range, perceptualDistance(colors[i], colors[j]));
  }
  expect(range, `${label}: bold whole-body range`).toBeGreaterThan(.18);
  for (const color of colors) {
    expect(color, label).toMatch(/^#[0-9a-f]{6}$/);
    for (const surface of surfaces) expect(contrastRatio(color, surface), label).toBeGreaterThanOrEqual(1.6);
  }
  return { max, range };
};

describe('Mosaic smooth colour field', () => {
  for (const theme of THEMES) {
    const surfaces = surfacesFor(theme);
    const palette = identityPaletteFor(surfaces);
    for (const shape of MOSAIC_SHAPES) {
      test(`${theme.id}/${shape.name}: every palette colour, both mirror orientations, final hex invariants`, () => {
        const seeds = orientationSeeds(shape.name);
        const ranges: number[] = [];
        for (const seed of seeds) {
          const identity = { ...seedIdentity(seed), shapeName: shape.name };
          const { cells } = mosaicGeometry(identity);
          for (const base of palette) {
            const field = mosaicField(base, cells, identity.colorSeed, surfaces);
            const measured = assertField(cells, field.colors, surfaces, `${theme.id}/${shape.name}/${base}`);
            expect(field.maxNeighbor).toBeCloseTo(measured.max, 10);
            expect(field.equalNeighbors).toBe(0);
            expect(field.spatialScale).toBeGreaterThan(0);
            ranges.push(measured.range);
          }
        }
        // The proposal must stay bold across the whole shape, not merely at one sampled seed.
        ranges.sort((a, b) => a - b);
        expect(ranges[Math.floor(ranges.length / 2)]).toBeGreaterThan(.24);
      });
    }
  }

  test('field is deterministic per identity, ignores stale band labels, and responds to the seed', () => {
    const identity = { ...seedIdentity('repeat'), shapeName: 'ribbon' as const };
    const surfaces = surfacesFor(THEMES[0]);
    const { cells } = mosaicGeometry(identity);
    const first = mosaicField('#54ee73', cells, identity.colorSeed, surfaces);
    expect(mosaicField('#54ee73', cells, identity.colorSeed, surfaces)).toEqual(first);
    expect(mosaicField('#54ee73', cells.map(cell => ({ ...cell, band: 999 })), identity.colorSeed, surfaces)).toEqual(first);
    const reversed = mosaicField('#54ee73', [...cells].reverse(), identity.colorSeed, surfaces);
    expect(reversed.colors).toEqual([...first.colors].reverse());
    expect(mosaicField('#54ee73', cells, `${identity.colorSeed}-other`, surfaces).colors).not.toEqual(first.colors);
  });

  test('a custom identity colour joins the same bounded field instead of being used as one flat fill', () => {
    const identity = { ...seedIdentity('custom'), shapeName: 'crown' as const, color: '#15a5ba' };
    const surfaces = surfacesFor(THEMES[0]);
    const { cells } = mosaicGeometry(identity);
    const field = mosaicField(identity.color, cells, identity.colorSeed, surfaces);
    assertField(cells, field.colors, surfaces, 'custom');
    expect(new Set(field.colors).size).toBeGreaterThan(20);
  });
});
