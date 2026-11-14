import { expect, test } from '@playwright/test';
import { FACES } from '../src/blob/mosaicFaces';

test.setTimeout(180_000);

for (const theme of ['light', 'dark']) {
  test('eighteen production faces · sizes and moods · ' + theme, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1680, height: 1400 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/e2e/fixtures/mosaicFaces.html?theme=' + theme);
    await expect(page.locator('[data-case]')).toHaveCount(18);
    for (const face of FACES) {
      const blobs = page.locator('[data-case="' + face.id + '"] .blob-mosaic');
      await expect(blobs).toHaveCount(6);
      for (const blob of await blobs.all()) {
        await expect(blob).toHaveAttribute('data-face', face.id);
        await expect(blob).toHaveAttribute('data-shape', face.body);
      }
    }
    await expect(page.locator('[data-explicit] .blob')).toHaveAttribute('data-shape', 'sail');
    await expect(page.locator('[data-explicit] .blob')).not.toHaveAttribute('data-face', 'horns.1');
    await page.screenshot({ path: testInfo.outputPath('all18-sizes-' + theme + '.png'), fullPage: true });
    await page.goto('/e2e/fixtures/mosaicFaces.html?mirrored&theme=' + theme);
    await expect(page.locator('[data-case] .blob')).toHaveCount(108);
    await expect(page.locator('[data-automatic] .blob')).toHaveAttribute('data-face', 'horns.1');
    await page.screenshot({ path: testInfo.outputPath('all18-mirrored-sizes-' + theme + '.png'), fullPage: true });
    await page.goto('/e2e/fixtures/mosaicFaces.html?moods&theme=' + theme);
    await expect(page.locator('[data-case] .blob')).toHaveCount(144);
    await page.screenshot({ path: testInfo.outputPath('all18-moods-' + theme + '.png'), fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(page.locator('[data-case] .blob')).toHaveCount(144);
    await expect(page.getByText(/Real MosaicBlob renderer/)).toContainText('reduced motion');
    expect(await page.locator('.blob').evaluateAll(nodes => nodes.every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('all18-reduced-motion-' + theme + '.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('all face gazes stay within their two legal pupil cells; error and unknown never track', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1400 });
  await page.goto('/e2e/fixtures/mosaicFaces.html?moods');
  await expect(page.locator('[data-case] .blob')).toHaveCount(144);
  const failures = await page.evaluate(async () => {
    const failures: string[] = [];
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    for (const blob of document.querySelectorAll<HTMLElement>('[data-case] .blob')) {
      blob.scrollIntoView({ block: 'center' });
      const box = blob.getBoundingClientRect();
      const mood = blob.dataset.mood;
      for (const side of [-1, 1]) {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: box.x + box.width / 2 + side * 45, clientY: box.y + box.height / 2 }));
        await frame();
        await frame();
        if (mood === 'error' || mood === 'unknown') {
          if (blob.hasAttribute('data-pupil-tracking')) failures.push(blob.dataset.face + ':' + mood + ':tracked');
          continue;
        }
        if (!blob.hasAttribute('data-pupil-tracking')) failures.push(blob.dataset.face + ':' + mood + ':not-tracked');
        for (const node of blob.querySelectorAll<SVGGElement>('.mosaic-pupil')) {
          const pupil = node.querySelector('rect')!;
          const offset = node.transform.baseVal.consolidate()!.matrix;
          const eye = node.closest('.mosaic-eye-open')!.querySelector('[data-mosaic-eye]')!;
          const x = Number(pupil.getAttribute('x')) + offset.e - Number(eye.getAttribute('x'));
          if (x !== (side === -1 ? 0 : 1) || offset.f !== 0) failures.push(blob.dataset.face + ':' + mood + ':out-of-bounds');
        }
      }
    }
    return failures;
  });
  expect(failures).toEqual([]);
});
