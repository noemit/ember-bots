import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { MOSAIC_SHAPES, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { mosaicActivityPlan } from '../src/blob/mosaicActivityPlan';
import { mosaicThinkingCandidates, oppositeThinkingSide, type ThinkingCell } from '../src/blob/mosaicThinkingPlan';

test('all thinking beats show one cell or an occasional opposing pair, including every boundary and wrap', () => {
  for (const shape of MOSAIC_SHAPES) for (let seed = 0; seed < 8; seed++) {
    const cells = mosaicGeometry({ ...seedIdentity('beats-' + seed), shapeName: shape.name }).cells.map(cell => ({ ...cell, fill: '#123456' }));
    const candidates = mosaicThinkingCandidates(cells);
    const plan = mosaicActivityPlan(cells, 'beats-' + seed, 'thinking');
    expect(plan).toEqual(mosaicActivityPlan(cells, 'beats-' + seed, 'thinking'));
    expect(plan).not.toEqual(mosaicActivityPlan(cells, 'different-' + seed, 'thinking'));
    expect(plan.tracks).toHaveLength(1);
    expect(plan.slots).toBe(2);
    const events = plan.tracks[0];
    expect(events.length / plan.duration).toBeGreaterThan(3);
    expect(events.length / plan.duration).toBeLessThan(4);
    expect(events.filter(event => event.cells.length === 2).length / events.length).toBeGreaterThan(.02);
    expect(events.filter(event => event.cells.length === 2).length / events.length).toBeLessThan(.3);
    expect(new Set(events.flatMap(event => event.cells.map(cell => `${cell.x}:${cell.y}`))).size).toBeGreaterThan(20);
    for (const [i, event] of events.entries()) {
      expect(event.cells.length).toBeGreaterThanOrEqual(1);
      expect(event.cells.length).toBeLessThanOrEqual(2);
      expect(event.until - event.at).toBeGreaterThanOrEqual(.16 - 1e-10);
      expect(event.until - event.at).toBeLessThan(.3);
      if (i) {
        expect(event.at - events[i - 1].until).toBeGreaterThanOrEqual(.04 - 1e-10);
        expect(event.at - events[i - 1].until).toBeLessThan(.1);
      }
      for (const pixel of event.cells as ThinkingCell[]) {
        const candidate = candidates.find(cell => cell.x === pixel.x && cell.y === pixel.y)!;
        expect(candidate).toBeDefined();
        expect(candidate.side).toBe(pixel.side);
        expect(candidate.distance).toBe(pixel.distance);
        expect(pixel.opacity).toBeGreaterThanOrEqual(.3);
        expect(pixel.opacity).toBeLessThanOrEqual(1);
      }
      if (event.cells.length === 2) {
        const [a, b] = event.cells as ThinkingCell[];
        expect(b.side).toBe(oppositeThinkingSide[a.side]);
        expect(`${a.x}:${a.y}`).not.toBe(`${b.x}:${b.y}`);
      }
    }
    // Test both sides of every beat boundary, including the CSS cycle's invisible seam.
    for (const boundary of [0, plan.duration, ...events.flatMap(event => [event.at, event.until])]) {
      for (const offset of [-.0001, 0, .0001]) {
        const time = (boundary + offset + plan.duration) % plan.duration;
        const active = events.filter(event => event.at <= time && event.until > time);
        expect(active.length).toBeLessThanOrEqual(1);
        expect(new Set(active.flatMap(event => event.cells.map(cell => `${cell.x}:${cell.y}`))).size).toBeLessThanOrEqual(2);
      }
    }
    for (const pixel of candidates) {
      expect(Number.isInteger(pixel.x) && Number.isInteger(pixel.y)).toBe(true);
      expect(cells.some(cell => cell.x === pixel.x && cell.y === pixel.y)).toBe(false);
      expect(pixel.x * 7 + 8).toBeGreaterThanOrEqual(0);
      expect((pixel.x + 1) * 7 + 8).toBeLessThanOrEqual(100);
      expect(pixel.y * 7 + 1).toBeGreaterThanOrEqual(0);
      expect((pixel.y + 1) * 7 + 1).toBeLessThanOrEqual(100);
      const horizontal = pixel.side === 'left' || pixel.side === 'right';
      const sign = pixel.side === 'left' || pixel.side === 'top' ? -1 : 1;
      const outline = { x: pixel.x - (horizontal ? sign * pixel.distance : 0), y: pixel.y - (horizontal ? 0 : sign * pixel.distance) };
      expect(cells.some(cell => cell.x === outline.x && cell.y === outline.y)).toBe(true);
      expect(cells.some(cell => (horizontal ? cell.y === outline.y && sign * (cell.x - outline.x) > 0 : cell.x === outline.x && sign * (cell.y - outline.y) > 0))).toBe(false);
    }
    expect(new Set(candidates.map(pixel => pixel.side)).size).toBe(4);
    expect(new Set(candidates.map(pixel => pixel.distance))).toEqual(new Set([1, 2]));
  }
});

test('working tracks retain the exact production plan and thinking DOM remains bounded', () => {
  const original = createHash('sha256');
  for (const shape of MOSAIC_SHAPES) for (let seed = 0; seed < 8; seed++) {
    const cells = mosaicGeometry({ ...seedIdentity('beats-' + seed), shapeName: shape.name }).cells.map(cell => ({ ...cell, fill: '#123456' }));
    const { duration, delay, tracks } = mosaicActivityPlan(cells, 'beats-' + seed, 'busy');
    original.update(JSON.stringify({ duration, delay, tracks }));
  }
  expect(original.digest('hex')).toBe('2563c183b092e177cc097920df8c8497c90282ca7561b983f37c50579da3af1c');
  const markup = renderToStaticMarkup(<MosaicBlob seed="beats" mood="thinking" />);
  expect([...markup.matchAll(/class="mosaic-thought"/g)]).toHaveLength(2);
  expect(markup.length).toBeLessThan(50_000);
  expect(markup).not.toMatch(/<filter|requestAnimationFrame/);
});
