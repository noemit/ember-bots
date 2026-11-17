import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('approved trails retain old pixels while births continue; actual gaps, rainbow, phase and visibility contracts', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  const region = page.getByRole('region', { name: 'Mosaic states', exact: true });
  await region.scrollIntoViewIfNeeded();
  // Real wall clock: never seek or pause this trace. The test sampler is not product playback.
  const clock = await region.evaluate(async node => {
    const blobs = [...node.querySelectorAll<HTMLElement>('[data-state="thinking"] .blob, [data-state="busy"] .blob')];
    const start = performance.now();
    const frames: { time: number; avatars: { mood: string | null; lit: { slot: number; key: string }[] }[] }[] = [];
    while (performance.now() - start < 4500) {
      await new Promise(requestAnimationFrame);
      frames.push({ time: performance.now() - start, avatars: blobs.map(blob => ({ mood: blob.dataset.mood ?? null,
        lit: [...blob.querySelectorAll('[data-mosaic-activity] rect')].flatMap((pixel, slot) => {
          const css = getComputedStyle(pixel);
          return +css.opacity ? [{ slot, key: `${css.transform}:${css.opacity}:${css.fill}` }] : [];
        }),
      })) });
    }
    return frames;
  });
  writeFileSync(info.outputPath('wallclock.json'), JSON.stringify(clock));
  for (const mood of ['thinking', 'busy']) {
    let retainedWithBirths = 0;
    for (let i = 1; i < clock.length; i++) for (let j = 0; j < clock[i].avatars.length; j++) {
      const now = clock[i].avatars[j], old = clock[i - 1].avatars[j];
      if (now.mood !== mood) continue;
      const retained = now.lit.some(c => old.lit.some(o => o.slot === c.slot && o.key === c.key));
      const born = now.lit.some(c => !old.lit.some(o => o.slot === c.slot && o.key === c.key));
      if (retained && born) retainedWithBirths++;
    }
    expect(retainedWithBirths).toBeGreaterThan(15);
  }
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const computed = await region.evaluate(node => {
    const blobs = [...node.querySelectorAll<HTMLElement>('[data-state="thinking"] .blob, [data-state="busy"] .blob')];
    return blobs.map(blob => {
      const pixels = [...blob.querySelectorAll('[data-mosaic-activity] rect')];
      const body = [...blob.querySelectorAll<SVGRectElement>('[data-mosaic-grid] > rect')].map(r => ({ x: r.x.baseVal.value, y: r.y.baseVal.value }));
      const animations = blob.getAnimations({ subtree: true });
      let samples = 0, touching = 0, peak = 0, invalid = 0, maxLive = 0;
      const positions = new Set<string>();
      for (let time = 0; time < 40000; time += 200) {
        animations.forEach(a => { a.currentTime = time; });
        let live = 0;
        for (const pixel of pixels) {
          const css = getComputedStyle(pixel); if (+css.opacity === 0) continue;
          live++; samples++;
          const m = new DOMMatrix(css.transform), x = m.e, y = m.f;
          positions.add(`${x}:${y}`);
          if (body.some(b => Math.abs(b.x - x) + Math.abs(b.y - y) === 1)) touching++;
          if (!Number.isInteger(x) || !Number.isInteger(y) || body.some(b => b.x === x && b.y === y) || x < -1 || x > 12 || y < 0 || y > 13) invalid++;
        }
        maxLive = Math.max(maxLive, live);
        for (const band of blob.querySelectorAll('.mosaic-rainbow')) peak = Math.max(peak, +getComputedStyle(band).opacity);
      }
      return { mood: blob.dataset.mood, samples, touching, peak, invalid, maxLive, slots: pixels.length, positions: [...positions],
        delay: pixels[0] ? getComputedStyle(pixels[0]).animationDelay : '',
        names: animations.map(a => (a as CSSAnimation).animationName) };
    });
  });
  writeFileSync(info.outputPath('computed-profiles.json'), JSON.stringify(computed));
  for (const avatar of computed) {
    expect(avatar.invalid).toBe(0); expect(avatar.maxLive).toBeGreaterThan(2); expect(avatar.slots).toBeLessThanOrEqual(64);
    if (avatar.mood === 'busy') { expect(avatar.touching).toBe(0); expect(avatar.peak).toBe(0); }
    else { expect(avatar.touching / avatar.samples).toBeGreaterThan(.9); expect(avatar.touching / avatar.samples).toBeLessThan(.99); expect(avatar.peak).toBeCloseTo(.7); }
  }
  const trailNames = computed.flatMap(a => a.names.filter(n => /mosaic-(thinking|busy)-\d+-\d+$/.test(n)));
  expect(new Set(trailNames).size).toBe(trailNames.length);
  expect(new Set(computed.map(a => a.delay)).size).toBeGreaterThanOrEqual(3);
  for (const theme of ['stone', 'graphite']) {
    await page.getByLabel('Theme', { exact: true }).selectOption(theme);
    await region.screenshot({ path: info.outputPath(`mosaic-${theme}-profiles.png`) });
  }
  for (const mood of ['idle', 'input', 'question', 'error', 'unread', 'unknown']) {
    await expect(region.locator(`[data-state="${mood}"] [data-mosaic-activity]`)).toHaveCount(0);
    await expect(region.locator(`[data-state="${mood}"] [data-mosaic-rainbow]`)).toHaveCount(0);
  }
  // Fresh CSS-owned clocks after imperative seeking above.
  await page.reload(); await region.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveClass(/motion-paused/);
  const times = () => region.locator('[data-mosaic-activity] rect').evaluateAll(nodes => nodes.flatMap(n => n.getAnimations().map(a => ({ time: a.currentTime, state: a.playState }))));
  const paused = await times(); expect(paused.length).toBeGreaterThan(0); expect(paused.every(a => a.state === 'paused')).toBe(true);
  await page.waitForTimeout(200); expect(await times()).toEqual(paused);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await region.locator('.blob').evaluateAll(nodes => nodes.flatMap(n => n.getAnimations({ subtree: true })).length)).toBe(0);
  expect(await region.locator('[data-mosaic-activity] rect, .mosaic-rainbow').evaluateAll(nodes => nodes.every(n => getComputedStyle(n).opacity === '0'))).toBe(true);
});
