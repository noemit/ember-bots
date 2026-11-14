import { describe, expect, test } from 'bun:test';
import { contrastRatio, identityPaletteFor, perceptualDistance } from '../src/blob/contrast';
import { MOSAIC_SHAPES, mosaicField, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { THEMES } from '../src/themes';

const surfacesFor = (theme: typeof THEMES[number]) => [theme.palette.panel, theme.palette.elev, theme.palette.bg];

describe('approved Mosaic Candidate A field (not Original or Midpoint)', () => {
  for (const theme of THEMES) test(`${theme.id}: assigned palette, custom colours, all silhouettes and mirror orientations`, () => {
    const surfaces = surfacesFor(theme);
    const palette = [...identityPaletteFor(surfaces), '#15a5ba', '#000000', '#ffffff'];
    for (const shape of MOSAIC_SHAPES) for (const base of palette) {
      for (const seed of ['a', 'b', 'c', 'd']) {
        const { cells } = mosaicGeometry({ ...seedIdentity(seed), shapeName: shape.name });
        const field = mosaicField(base, cells, seed, surfaces);
        expect(field.hueSpanDegrees).toBe(90);
        expect(field.spatialScale).toBe(1);
        expect(field.colors).toHaveLength(cells.length);
        expect(new Set(field.colors).size).toBeGreaterThan(20);
        for (const color of field.colors) {
          expect(color).toMatch(/^#[0-9a-f]{6}$/);
          for (const surface of surfaces) expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(1.6);
        }
        // A preserves the assigned colour family rather than travelling around the hue wheel.
        if (base !== '#ffffff' && base !== '#000000') expect(field.colors.some(color => perceptualDistance(color, base) < .2)).toBe(true);
      }
    }
  }, 20_000);

  test('coordinate field ignores seed/band labels/order, while assigned colour changes it', () => {
    const { cells } = mosaicGeometry(seedIdentity('repeat'));
    const surfaces = surfacesFor(THEMES[0]);
    const first = mosaicField('#54ee73', cells, 'first', surfaces);
    expect(mosaicField('#54ee73', cells, 'other', surfaces)).toEqual(first);
    expect(mosaicField('#54ee73', cells.map(cell => ({ ...cell, band: 999 })), 'first', surfaces)).toEqual(first);
    expect(mosaicField('#54ee73', [...cells].reverse(), 'first', surfaces).colors).toEqual([...first.colors].reverse());
    expect(mosaicField('#15a5ba', cells, 'first', surfaces).colors).not.toEqual(first.colors);
  });
});
