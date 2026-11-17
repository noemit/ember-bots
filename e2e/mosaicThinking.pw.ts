import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('thinking wanders one pixel per fast beat with only opposing pairs and keeps faint rainbow/reduced/hidden behavior', async ({ page }, testInfo) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  const allThinking = page.locator('[data-style="mosaic"][data-state="thinking"] .blob');
  const thinking = allThinking.first();
  await thinking.scrollIntoViewIfNeeded();
  const beats = await allThinking.evaluateAll(nodes => nodes.map(node => {
    const animations = node.getAnimations({ subtree: true });
    const pixels = [...node.querySelectorAll('.mosaic-thought')];
    const body = [...node.querySelectorAll<SVGRectElement>('[data-mosaic-grid] > rect')].map(rect => ({ x: rect.x.baseVal.value, y: rect.y.baseVal.value }));
    const sideOf = (x: number, y: number) => {
      const sides: string[] = [];
      const rows = body.filter(cell => cell.y === y).map(cell => cell.x);
      const columns = body.filter(cell => cell.x === x).map(cell => cell.y);
      if (rows.length) {
        const left = Math.min(...rows) - x, right = x - Math.max(...rows);
        if (left === 1 || left === 2) sides.push('left');
        if (right === 1 || right === 2) sides.push('right');
      }
      if (columns.length) {
        const top = Math.min(...columns) - y, bottom = y - Math.max(...columns);
        if (top === 1 || top === 2) sides.push('top');
        if (bottom === 1 || bottom === 2) sides.push('bottom');
      }
      return sides;
    };
    const frames = [];
    // 20ms sampling sees even the shortest 40ms rests. Pure tests cover every exact boundary.
    for (let time = 0; time < 42000; time += 20) {
      animations.forEach(animation => { animation.currentTime = time; });
      const lit = pixels.flatMap(pixel => {
        const style = getComputedStyle(pixel), opacity = Number(style.opacity);
        if (!opacity) return [];
        const transform = new DOMMatrix(style.transform);
        return [{ x: transform.e, y: transform.f, opacity, sides: sideOf(transform.e, transform.f) }];
      });
      frames.push({ time, lit });
    }
    let appearances = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i].lit.length && !frames[i - 1].lit.length) appearances++;
    return { shape: node.getAttribute('data-shape'), appearancesPerSecond: appearances / 42, frames };
  }));
  for (const sample of beats) {
    expect(sample.appearancesPerSecond).toBeGreaterThan(3);
    expect(sample.appearancesPerSecond).toBeLessThan(4);
    const active = sample.frames.filter(frame => frame.lit.length);
    expect(active.filter(frame => frame.lit.length === 1).length / active.length).toBeGreaterThan(.7);
    expect(active.filter(frame => frame.lit.length === 2).length).toBeGreaterThan(0);
    const opposite: Record<string, string> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
    const violations = sample.frames.filter(({ lit }) => lit.length > 2
      || new Set(lit.map(cell => `${cell.x}:${cell.y}`)).size !== lit.length
      || lit.some(cell => !Number.isInteger(cell.x) || !Number.isInteger(cell.y) || !cell.sides.length || cell.opacity < .3 || cell.opacity > 1)
      || (lit.length === 2 && !lit[0].sides.some(side => lit[1].sides.includes(opposite[side]))));
    expect(violations).toEqual([]);
    expect(new Set(sample.frames.flatMap(frame => frame.lit.map(cell => cell.opacity))).size).toBe(8);
  }
  writeFileSync(testInfo.outputPath('computed-beat-samples.json'), JSON.stringify(beats));
  const rainbow = await thinking.evaluate(node => {
    const animations = node.getAnimations({ subtree: true });
    const bands = [...node.querySelectorAll('.mosaic-rainbow')];
    const frames = [];
    for (let time = 0; time < 34000; time += 100) {
      animations.forEach(animation => { animation.currentTime = time; });
      frames.push({ time, bands: bands.map(band => Number(getComputedStyle(band).opacity)) });
    }
    return { frames, peak: [...frames].sort((a, b) => b.bands.filter(alpha => alpha === .1).length - a.bands.filter(alpha => alpha === .1).length)[0].time };
  });
  expect(Math.max(...rainbow.frames.flatMap(frame => frame.bands))).toBeCloseTo(.1);
  expect(rainbow.frames.filter(frame => frame.bands.some(alpha => alpha > 0)).length / rainbow.frames.length).toBeLessThan(.3);
  writeFileSync(testInfo.outputPath('computed-rainbow-samples.json'), JSON.stringify(rainbow));
  for (const theme of ['stone', 'graphite']) {
    await page.getByLabel('Theme', { exact: true }).selectOption(theme);
    for (const [label, time] of [['rainbow', rainbow.peak], ['later', rainbow.peak + 4000]] as const) {
      await allThinking.evaluateAll((nodes, time) => nodes.forEach(node => node.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = time; })), time);
      await page.getByRole('region', { name: 'Mosaic states', exact: true }).screenshot({ path: testInfo.outputPath(`mosaic-${theme}-${label}.png`) });
    }
  }
  for (const mood of ['idle', 'busy', 'input', 'question', 'error', 'unread', 'unknown']) {
    await expect(page.locator(`[data-style="mosaic"][data-state="${mood}"] [data-mosaic-rainbow]`)).toHaveCount(0);
  }
  expect(await page.locator('[data-style="mosaic"][data-state="idle"] .blob').first().evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await page.getByRole('button', { name: 'Play animations', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveClass(/motion-paused/);
  expect(await thinking.evaluate(node => node.getAnimations({ subtree: true }).every(animation => animation.playState === 'paused'))).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.blob-mosaic').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).length)).toBe(0);
  await expect(thinking.locator('.mosaic-rainbow').first()).toHaveCSS('opacity', '0');
  await expect(thinking.locator('.mosaic-thought').first()).toHaveCSS('opacity', '0');
});
