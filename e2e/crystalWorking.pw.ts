import { expect, test } from '@playwright/test';

test.use({ video: { mode: 'on', size: { width: 1500, height: 1000 } }, viewport: { width: 1500, height: 1000 } });

test('working and thinking Crystal stay still with only facet reflections animated', async ({ page }, testInfo) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  const region = page.getByRole('region', { name: 'Crystal states', exact: true });
  await region.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500); // Record actual reflection motion before sampling precise phases.
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  for (const mood of ['busy', 'thinking']) {
    const blobs = page.locator(`[data-style="crystal"][data-state="${mood}"] .blob`);
    await expect(blobs.locator('.blob-heat, filter, feGaussianBlur')).toHaveCount(0);
    const frames = await blobs.evaluateAll(nodes => nodes.map(node => {
      const body = node.querySelector<SVGGraphicsElement>('.blob-body')!;
      return [0, .2, .35, .5, .7, .9].map(phase => {
        for (const animation of node.getAnimations({ subtree: true })) {
          const timing = animation.effect!.getTiming();
          animation.currentTime = Number(timing.delay) + Number(timing.duration) * phase;
        }
        const style = getComputedStyle(body);
        const matrix = body.getScreenCTM()!;
        return {
          bodyMatrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
          bodyAnimation: style.animationName, bodyTranslate: style.translate, bodyScale: style.scale,
          rootAnimation: getComputedStyle(node).animationName,
          lights: [...node.querySelectorAll('.crystal-reflection-sweep')].map(light => {
            const css = getComputedStyle(light); return `${css.opacity}:${css.translate}`;
          }).join('|'),
        };
      });
    }));
    for (const samples of frames) {
      expect(new Set(samples.map(sample => JSON.stringify(sample.bodyMatrix))).size).toBe(1);
      expect(new Set(samples.map(sample => sample.lights)).size).toBeGreaterThan(2);
      for (const sample of samples) {
        expect(sample.bodyAnimation).toBe('none');
        expect(sample.rootAnimation).toBe('none');
        expect(sample.bodyTranslate).toBe('none');
        expect(sample.bodyScale).toBe('none');
      }
    }
  }
  const idle = page.locator('[data-style="crystal"][data-state="idle"] .blob').first();
  expect(await idle.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(idle.locator('.crystal-working-light, .crystal-sparkle, .blob-heat')).toHaveCount(0);
  await region.evaluate(node => {
    for (const animation of node.getAnimations({ subtree: true })) {
      const timing = animation.effect!.getTiming();
      animation.currentTime = Number(timing.delay) + Number(timing.duration) * .35;
    }
  });
  await region.screenshot({ path: testInfo.outputPath('crystal-reflections-only.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mood of ['busy', 'thinking']) {
    const blob = page.locator(`[data-style="crystal"][data-state="${mood}"] .blob`).first();
    expect(await blob.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
    await expect(blob.locator('.crystal-working-facet').first()).toHaveCSS('opacity', '0.1');
    await expect(blob.locator('.crystal-reflection-sweep').first()).toHaveCSS('opacity', '0');
  }
});
