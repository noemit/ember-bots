import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { activityKeyframes } from '../src/blob/mosaicActivityPlan';
import { MOSAIC_PROFILES } from '../src/blob/mosaicProfiles';
import approved from './fixtures/mosaicApprovedProfiles.json';

test('exact approved v3 profiles map working to busy; preview context is not a production setting', () => {
  expect(MOSAIC_PROFILES).toEqual({ thinking: approved.thinking, busy: approved.working });
  expect(MOSAIC_PROFILES).not.toHaveProperty('theme');
  expect(MOSAIC_PROFILES).not.toHaveProperty('seed');
});
test('activity styles and DOM are bounded and absent at rest; repeated identities isolate their clocks', () => {
  for (const mood of ['idle', 'unknown', 'error', 'input', 'question', 'unread'] as const) {
    expect(renderToStaticMarkup(<MosaicBlob seed="same" mood={mood} />)).not.toContain('data-mosaic-activity');
  }
  for (const mood of ['busy', 'thinking'] as const) {
    const markup = renderToStaticMarkup(<><MosaicBlob seed="same" mood={mood} /><MosaicBlob seed="same" mood={mood} /></>);
    const names = [...markup.matchAll(/@keyframes ([^{]+)/g)].map(match => match[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(130);
    expect(markup.length).toBeLessThan(300_000);
    expect(markup).not.toMatch(/<filter|requestAnimationFrame|setInterval/);
  }
});
test('CSS keeps wrap segment at zero visible, expiries discrete and whole coordinates', () => {
  const css = activityKeyframes([{ at: 0, until: .3, cells: [{ x: 1, y: 2, fill: '#123456', opacity: .7 }] }], 0, 40);
  expect(css).toContain('0.0000%{opacity:0.7;transform:translate(1px,2px)');
  expect(css).toContain('0.7500%{opacity:0}');
  expect(css).not.toMatch(/undefined|NaN/);
});
