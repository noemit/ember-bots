import { expect, test } from '@playwright/test';

test('procedural perimeter clusters vary without leaving the pixel grid, and pause without resetting', async ({ page }, info) => {
  await page.goto('/blob-gallery.html');
  const region = page.getByRole('region', { name: 'Mosaic states', exact: true });
  await region.scrollIntoViewIfNeeded();
  for (const mood of ['thinking', 'busy']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first();
    const samples = await blob.evaluate(async node => {
      const pixels = [...node.querySelectorAll('[data-mosaic-activity] rect')];
      const animations = pixels.flatMap(pixel => pixel.getAnimations());
      animations.forEach(animation => animation.pause());
      const body = new Set([...node.querySelectorAll('[data-mosaic-grid] > rect')].map(cell => `${cell.getAttribute('x')}:${cell.getAttribute('y')}`));
      const positions = new Set<string>(), counts = new Set<number>();
      let invalid = false;
      for (let time = 0; time < 90_000; time += 400) {
        animations.forEach(animation => { animation.currentTime = time; });
        let visible = 0;
        for (const pixel of pixels) {
          const css = getComputedStyle(pixel);
          if (Number(css.opacity) === 0) continue;
          const matrix = new DOMMatrix(css.transform);
          const key = `${matrix.e}:${matrix.f}`;
          positions.add(key); visible++;
          invalid ||= !Number.isInteger(matrix.e) || !Number.isInteger(matrix.f) || body.has(key);
        }
        counts.add(visible);
      }
      animations.forEach(animation => animation.play());
      return { positions: positions.size, counts: [...counts], invalid, slots: pixels.length };
    });
    expect(samples.positions).toBeGreaterThan(15);
    expect(samples.counts.length).toBeGreaterThan(2);
    expect(Math.max(...samples.counts)).toBeLessThanOrEqual(64);
    expect(samples.invalid).toBe(false);
  }
  // Fresh CSS-owned clocks: imperative seek/play used above deliberately detaches those test
  // animations from CSS play-state, so never use them to assess production pause behavior.
  await page.reload();
  await region.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const active = region.locator('[data-mosaic-activity] rect');
  const times = () => active.evaluateAll(nodes => nodes.flatMap(node => node.getAnimations().map(a => ({ time: a.currentTime, state: a.playState }))));
  const paused = await times();
  expect(paused.every(a => a.state === 'paused')).toBe(true);
  await page.waitForTimeout(200);
  expect(await times()).toEqual(paused);
  await page.getByRole('button', { name: 'Play animations', exact: true }).click();
  await expect.poll(times).not.toEqual(paused);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await active.evaluateAll(nodes => nodes.every(node => node.getAnimations().length === 0 && getComputedStyle(node).opacity === '0'))).toBe(true);
  await page.screenshot({ path: info.outputPath('mosaic-reduced-motion.png') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect((await times()).every(a => a.state === 'paused')).toBe(true);
});
