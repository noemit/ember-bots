import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { MOSAIC_SHAPES, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { activityKeyframes, mosaicActivityPlan } from '../src/blob/mosaicActivityPlan';
import { mosaicRainbowPlan } from '../src/blob/mosaicRainbowPlan';

test('thinking keeps spatial and temporal ink diversity, without changing working ink', () => {
  for (const shape of MOSAIC_SHAPES) {
    const cells = mosaicGeometry({ ...seedIdentity('ink'), shapeName: shape.name }).cells.map(cell => ({ ...cell, fill: '#123456' }));
    const thinking = mosaicActivityPlan(cells, shape.name, 'thinking');
    const busy = mosaicActivityPlan(cells, shape.name, 'busy');
    const ink = thinking.tracks.flatMap(events => events.flatMap(event => event.cells.map(cell => cell.opacity!)));
    expect(Math.min(...ink)).toBeCloseTo(.3);
    expect(Math.max(...ink)).toBe(1);
    expect(new Set(ink).size).toBe(8);
    expect(thinking.tracks.flat().some(event => new Set(event.cells.map(cell => cell.opacity)).size > 1)).toBe(true);
    expect(thinking.tracks).toHaveLength(1);
    expect(thinking.slots).toBe(2);
    expect(thinking.tracks[0].length / thinking.duration).toBeGreaterThan(3);
    for (const track of busy.tracks) {
      expect(track.every(event => event.cells.every(cell => cell.opacity === undefined))).toBe(true);
      expect(activityKeyframes(track, 0, busy.duration)).toContain('opacity:1;');
    }
  }
});

test('rainbow is a seeded, bounded diagonal overlay covering exactly the body cells', () => {
  for (const shape of MOSAIC_SHAPES) {
    const cells = mosaicGeometry({ ...seedIdentity('wash'), shapeName: shape.name }).cells;
    const plan = mosaicRainbowPlan(cells, 'wash');
    expect(plan).toEqual(mosaicRainbowPlan(cells, 'wash'));
    expect(plan).not.toEqual(mosaicRainbowPlan(cells, 'different'));
    expect(plan.duration).toBeGreaterThanOrEqual(26);
    expect(plan.duration).toBeLessThan(34);
    expect(plan.bands.length).toBeLessThanOrEqual(24);
    expect(plan.bands.flatMap(band => band.cells).sort((a, b) => a.x - b.x || a.y - b.y))
      .toEqual(cells.map(({ x, y }) => ({ x, y })).sort((a, b) => a.x - b.x || a.y - b.y));
    for (const [i, band] of plan.bands.entries()) {
      expect(band.cells.every(cell => cell.x + cell.y === band.diagonal)).toBe(true);
      if (i) expect(Math.abs(band.delay - plan.bands[i - 1].delay)).toBeCloseTo((band.diagonal - plan.bands[i - 1].diagonal) * .12);
    }
  }
});

test('wash is thinking-only, beneath the face, with low-alpha and reduced/hidden motion contracts', () => {
  for (const mood of ['idle', 'busy', 'unknown', 'error', 'input', 'question', 'unread'] as const) {
    expect(renderToStaticMarkup(<MosaicBlob seed="wash" mood={mood} />)).not.toContain('data-mosaic-rainbow');
  }
  const markup = renderToStaticMarkup(<MosaicBlob seed="wash" mood="thinking" />);
  expect(markup.indexOf('data-mosaic-rainbow')).toBeLessThan(markup.indexOf('class="mosaic-eyes"'));
  expect(markup).not.toMatch(/<filter|<linearGradient|requestAnimationFrame/);
  const css = readFileSync('src/blob/blob-mosaic.css', 'utf8');
  const frames = css.split('@keyframes mosaic-rainbow-pass')[1].split('@media')[0];
  const alphas = [...frames.matchAll(/opacity:\s*([\d.]+)/g)].map(match => Number(match[1]));
  expect(Math.max(...alphas)).toBe(.1);
  expect(frames).toMatch(/5%, 100%\s*\{ opacity: 0/);
  expect(css).toMatch(/prefers-reduced-motion: reduce[^]*\.mosaic-rainbow\s*\{ animation: none !important; opacity: 0/);
  expect(readFileSync('src/styles.css', 'utf8')).toMatch(/html\.motion-paused[^]*animation-play-state: paused !important/);
});
