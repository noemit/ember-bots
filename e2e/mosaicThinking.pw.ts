import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('thinking has faint occasional diagonal ink and denser varied pixels; all moods stop for reduced/hidden motion', async ({ page }, testInfo) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  const thinking = page.locator('[data-style="mosaic"][data-state="thinking"] .blob').first();
  await thinking.scrollIntoViewIfNeeded();
  const sample = await thinking.evaluate(node => {
    const animations = node.getAnimations({ subtree: true });
    const pixels = [...node.querySelectorAll('.mosaic-thought')];
    const bands = [...node.querySelectorAll('.mosaic-rainbow')];
    const frames = [];
    for (let time = 0; time < 34000; time += 100) {
      animations.forEach(animation => { animation.currentTime = time; });
      frames.push({ time, pixels: pixels.map(pixel => ({ opacity: Number(getComputedStyle(pixel).opacity), transform: getComputedStyle(pixel).transform })),
        bands: bands.map(band => Number(getComputedStyle(band).opacity)) });
    }
    const visible = frames.filter(frame => frame.bands.some(alpha => alpha > 0));
    return { frames, peak: visible.sort((a, b) => b.bands.filter(alpha => alpha === .1).length - a.bands.filter(alpha => alpha === .1).length)[0].time };
  });
  const ink = sample.frames.flatMap(frame => frame.pixels.map(pixel => pixel.opacity)).filter(alpha => alpha > 0);
  expect(Math.min(...ink)).toBeCloseTo(.3);
  expect(Math.max(...ink)).toBe(1);
  expect(new Set(ink).size).toBe(8);
  expect(sample.frames.reduce((sum, frame) => sum + frame.pixels.filter(pixel => pixel.opacity > 0).length, 0) / sample.frames.length).toBeGreaterThan(2);
  expect(new Set(sample.frames.map(frame => frame.pixels.map(pixel => pixel.transform).join('|'))).size).toBeGreaterThan(20);
  expect(Math.max(...sample.frames.flatMap(frame => frame.bands))).toBeCloseTo(.1);
  expect(sample.frames.filter(frame => frame.bands.some(alpha => alpha > 0)).length / sample.frames.length).toBeLessThan(.3);
  writeFileSync(testInfo.outputPath('computed-animation-samples.json'), JSON.stringify(sample));
  await testInfo.attach('computed-animation-samples', { body: JSON.stringify(sample), contentType: 'application/json' });
  for (const theme of ['stone', 'graphite']) {
    await page.getByLabel('Theme', { exact: true }).selectOption(theme);
    for (const [label, time] of [['rainbow', sample.peak], ['later', sample.peak + 4000]] as const) {
      await thinking.evaluate((node, time) => node.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = time; }), time);
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
