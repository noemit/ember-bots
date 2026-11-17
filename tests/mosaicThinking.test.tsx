import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { MOSAIC_SHAPES, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { mosaicRainbowPlan } from '../src/blob/mosaicRainbowPlan';

test('rainbow is a seeded, bounded diagonal overlay covering exactly the body cells', () => {
  for (const shape of MOSAIC_SHAPES) {
    const cells = mosaicGeometry({ ...seedIdentity('wash'), shapeName: shape.name }).cells;
    const plan = mosaicRainbowPlan(cells, 'wash');
    expect(plan).toEqual(mosaicRainbowPlan(cells, 'wash'));
    expect(plan).not.toEqual(mosaicRainbowPlan(cells, 'different'));
    expect(plan.duration).toBeGreaterThanOrEqual(2);
    expect(plan.duration).toBeLessThan(15);
    expect(plan.bands.length).toBeLessThanOrEqual(24);
    expect(plan.bands.flatMap(band => band.cells).sort((a, b) => a.x - b.x || a.y - b.y))
      .toEqual(cells.map(({ x, y }) => ({ x, y })).sort((a, b) => a.x - b.x || a.y - b.y));
    for (const [i, band] of plan.bands.entries()) {
      expect(band.cells.every(cell => cell.x + cell.y === band.diagonal)).toBe(true);
      if (i) expect(Math.abs(band.delay - plan.bands[i - 1].delay)).toBeCloseTo((band.diagonal - plan.bands[i - 1].diagonal) * .1);
    }
  }
});

test('wash is thinking-only, beneath the face, with approved high-alpha and reduced/hidden motion contracts', () => {
  for (const mood of ['idle', 'busy', 'unknown', 'error', 'input', 'question', 'unread'] as const) {
    expect(renderToStaticMarkup(<MosaicBlob seed="wash" mood={mood} />)).not.toContain('data-mosaic-rainbow');
  }
  const markup = renderToStaticMarkup(<MosaicBlob seed="wash" mood="thinking" />);
  expect(markup.indexOf('data-mosaic-rainbow')).toBeLessThan(markup.indexOf('class="mosaic-eyes"'));
  expect(markup).not.toMatch(/<filter|<linearGradient|requestAnimationFrame/);
  const css = readFileSync('src/blob/blob-mosaic.css', 'utf8');
  expect(mosaicRainbowPlan([{ x: 0, y: 0 }], 'peak').frames).toContain('opacity:0.7');
  expect(css).toMatch(/prefers-reduced-motion: reduce[^]*\.mosaic-rainbow\s*\{ animation: none !important; opacity: 0/);
  expect(readFileSync('src/styles.css', 'utf8')).toMatch(/html\.motion-paused[^]*animation-play-state: paused !important/);
});
