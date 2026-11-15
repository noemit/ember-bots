import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { MOSAIC_SHAPES, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { activityKeyframes, mosaicActivityPlan, mosaicPerimeter } from '../src/blob/mosaicActivityPlan';

test('all shapes keep irregular clusters on the perimeter grid and inside the canvas', () => {
  for (const shape of MOSAIC_SHAPES) for (const mood of ['thinking', 'busy'] as const) {
    const cells = mosaicGeometry({ ...seedIdentity('activity'), shapeName: shape.name }).cells.map(cell => ({ ...cell, fill: '#123456' }));
    const perimeter = mosaicPerimeter(cells);
    const plan = mosaicActivityPlan(cells, shape.name, mood);
    expect(plan).toEqual(mosaicActivityPlan(cells, shape.name, mood));
    expect(plan).not.toEqual(mosaicActivityPlan(cells, shape.name + '-other', mood));
    expect(plan.tracks).toHaveLength(mood === 'thinking' ? 1 : 2);
    expect(plan.duration).toBeGreaterThan(60);
    expect(plan.duration).toBeLessThan(110);
    for (const events of plan.tracks) {
      expect(events.length).toBeGreaterThan(15);
      expect(events.length).toBeLessThan(80);
      expect(new Set(events.map(e => e.cells.length)).size).toBeGreaterThan(1);
      expect(new Set(events.map(e => e.cells[0].x + ':' + e.cells[0].y)).size).toBeGreaterThan(10);
      expect(new Set(events.map(e => (e.until - e.at).toFixed(2))).size).toBeGreaterThan(10);
      for (const [i, event] of events.entries()) {
        expect(event.until).toBeLessThan(plan.duration);
        if (i) expect(event.at).toBeGreaterThan(events[i - 1].until);
        expect(event.cells.length).toBeLessThanOrEqual(3);
        for (const cell of event.cells) {
          expect(perimeter).toContainEqual(cell);
          expect(Number.isInteger(cell.x) && Number.isInteger(cell.y)).toBe(true);
          expect(cells.some(c => c.x === cell.x && c.y === cell.y)).toBe(false);
          expect(cell.x * 7 + 8).toBeGreaterThanOrEqual(0);
          expect((cell.x + 1) * 7 + 8).toBeLessThanOrEqual(100);
          expect(cell.y * 7 + 1).toBeGreaterThanOrEqual(0);
          expect((cell.y + 1) * 7 + 1).toBeLessThanOrEqual(100);
        }
      }
      for (let slot = 0; slot < 3; slot++) {
        const css = activityKeyframes(events, slot, plan.duration);
        expect(css).not.toMatch(/undefined|NaN/);
        expect(css).toContain('100%{opacity:0}');
        expect(css).not.toMatch(/translate\([^)]*\./);
      }
    }
  }
});

test('activity styles and DOM are bounded and absent at rest; repeated identities isolate their clocks', () => {
  for (const mood of ['idle', 'unknown', 'error', 'input', 'question', 'unread'] as const) {
    expect(renderToStaticMarkup(<MosaicBlob seed="same" mood={mood} />)).not.toContain('data-mosaic-activity');
  }
  const markup = renderToStaticMarkup(<><MosaicBlob seed="same" mood="thinking" /><MosaicBlob seed="same" mood="thinking" /></>);
  const names = [...markup.matchAll(/@keyframes ([^{]+)/g)].map(match => match[1]);
  expect(names).toHaveLength(6);
  expect(new Set(names).size).toBe(6);
  expect(markup.length).toBeLessThan(100_000);
});
