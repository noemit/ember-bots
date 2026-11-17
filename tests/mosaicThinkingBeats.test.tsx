import { expect, test } from 'bun:test';
import { MOSAIC_SHAPES, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { mosaicActivityPlan } from '../src/blob/mosaicActivityPlan';
import { mosaicTrailPlan } from '../src/blob/mosaicTrailPlan';
import { MOSAIC_PROFILES } from '../src/blob/mosaicProfiles';
import { oppositeThinkingSide } from '../src/blob/mosaicThinkingPlan';

const geometry = (shape: string, seed: string) => mosaicGeometry({ ...seedIdentity(seed), shapeName: shape }).cells.map(cell => ({ ...cell, fill: '#123456' }));
test('all twelve shapes × eight seeds retain independent births, full lives, actual gaps and circular slots', () => {
  expect(MOSAIC_SHAPES).toHaveLength(12);
  let reuse = 0, touches = 0, thinkingCells = 0;
  for (const shape of MOSAIC_SHAPES) for (let seed = 0; seed < 8; seed++) for (const mood of ['thinking', 'busy'] as const) {
    const cells = geometry(shape.name, 'beats-' + seed);
    const p = mosaicActivityPlan(cells, 'beats-' + seed, mood), profile = MOSAIC_PROFILES[mood];
    expect(p).toEqual(mosaicActivityPlan(cells, 'beats-' + seed, mood));
    expect(p).not.toEqual(mosaicActivityPlan(cells, 'other-' + seed, mood));
    expect(p.duration).toBe(40); expect(p.requestedBirths).toBe(400);
    expect(p.slots).toBe(1); expect(p.tracks.length).toBeLessThanOrEqual(64);
    expect(p.skippedBudgetCells).toBe(0);
    for (const [i, birth] of p.births.entries()) {
      const life = birth.until - birth.at;
      expect(life).toBeGreaterThanOrEqual(profile.hold.min * .1 - 1e-6);
      expect(life).toBeLessThanOrEqual(profile.hold.max * .1 + 1e-6);
      if (i) expect(birth.at - p.births[i - 1].at).toBeGreaterThanOrEqual(.1 - 1e-6);
      expect(birth.cells.length).toBeLessThanOrEqual(2);
      if (birth.cells.length === 2) expect(birth.cells[1].side).toBe(oppositeThinkingSide[birth.cells[0].side]);
      for (const cell of birth.cells) {
        expect(Number.isInteger(cell.x) && Number.isInteger(cell.y)).toBe(true);
        expect(cells.some(b => b.x === cell.x && b.y === cell.y)).toBe(false);
        expect(cell.x).toBeGreaterThanOrEqual(-1); expect(cell.x).toBeLessThanOrEqual(12);
        expect(cell.y).toBeGreaterThanOrEqual(0); expect(cell.y).toBeLessThanOrEqual(13);
        expect([1, 2]).toContain(cell.distance);
        expect(cell.opacity!).toBeGreaterThanOrEqual(.1); expect(cell.opacity!).toBeLessThanOrEqual(1);
        const touching = cells.some(b => Math.abs(b.x - cell.x) + Math.abs(b.y - cell.y) === 1);
        if (mood === 'busy') expect(touching).toBe(false);
        else { thinkingCells++; if (touching) touches++; }
        if (p.births.slice(0, i).some(old => old.until > birth.at && old.cells.some(c => c.x === cell.x && c.y === cell.y))) reuse++;
        // Every slot's split segments preserve exactly the complete chosen residence.
        const matching = p.tracks[cell.slot].filter(e => e.cells[0].opacity === cell.opacity && e.cells[0].x === cell.x && e.cells[0].y === cell.y);
        expect(matching.reduce((sum, e) => sum + e.until - e.at, 0)).toBeCloseTo(life, 5);
      }
    }
    const pairs = p.births.filter(b => b.cells.length === 2).length / p.births.length;
    expect(pairs).toBeGreaterThan(.32); expect(pairs).toBeLessThan(.55);
    for (const track of p.tracks) for (let i = 1; i < track.length; i++) expect(track[i].at).toBeGreaterThanOrEqual(track[i - 1].until - 1e-9);
    const seam = p.births.filter(b => b.until > p.duration);
    expect(seam.length).toBeGreaterThan(0);
    expect(p.tracks.flat().filter(e => e.at === 0).length).toBeGreaterThan(1);
  }
  expect(reuse).toBeGreaterThan(0);
  expect(touches / thinkingCells).toBeGreaterThan(.93); expect(touches / thinkingCells).toBeLessThan(.97);
});

test('budget and unavailable geometry skip honestly; invalid inputs cannot generate unbounded CSS', () => {
  const cells = geometry('round', 'budget');
  const p = mosaicTrailPlan(cells, 'budget', { ...MOSAIC_PROFILES.thinking, hold: { min: 10, max: 10 }, beatMs: 100, appearance: { min: 1, max: 1 }, pairChance: 1 });
  expect(p.tracks.length).toBeLessThanOrEqual(64);
  const exhausted = mosaicTrailPlan(cells, 'budget', { ...MOSAIC_PROFILES.thinking, hold: { min: 38, max: 38 }, pairChance: 1 });
  expect(exhausted.skippedBudgetCells).toBeGreaterThan(0); expect(exhausted.tracks).toHaveLength(64);
  const empty = mosaicTrailPlan([], 'none', MOSAIC_PROFILES.busy);
  expect(empty.tracks).toHaveLength(0); expect(empty.skippedCandidates).toBe(400);
  expect(() => mosaicTrailPlan(cells, 'bad', { ...MOSAIC_PROFILES.busy, beatMs: 0 })).toThrow();
});
