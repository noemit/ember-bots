import { expect, test, type Page } from '@playwright/test';
import { FACES } from '../src/blob/mosaicFaces';

test.setTimeout(180_000);

// Compare actual SVG output with the same identities minus their retired faceId. This checks
// every old accessory, body override, eye-cover and bodyShift without deleting the source art.
const grids = (page: Page) => page.locator('[data-mosaic-grid]').evaluateAll(nodes => nodes.map(node => node.innerHTML));
const bodySignatures = (page: Page) => page.locator('[data-case] .blob').evaluateAll(nodes => nodes.map(node => ({
  case: node.closest('[data-case]')!.getAttribute('data-case'),
  shape: node.getAttribute('data-shape'),
  tiles: Array.from(node.querySelectorAll('[data-mosaic-grid] > rect:not([class])')).map(rect =>
    ['x', 'y', 'width', 'height', 'fill'].map(name => rect.getAttribute(name))),
})));

for (const theme of ['light', 'dark']) {
  test('retained eighteen face identities are inert · sizes, moods and reduced motion · ' + theme, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1680, height: 1400 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const mode of ['', '&mirrored', '&moods', '&mirrored&moods']) {
      const url = '/e2e/fixtures/mosaicFaces.html?theme=' + theme + mode;
      await page.goto(url);
      await expect(page.locator('[data-case]')).toHaveCount(FACES.length);
      const perCase = mode.includes('moods') ? 8 : 6;
      await expect(page.locator('[data-case] .blob')).toHaveCount(FACES.length * perCase);
      await expect(page.locator('.blob[data-face]')).toHaveCount(0);
      await expect(page.locator('[data-explicit] .blob')).toHaveAttribute('data-shape', 'sail');
      await expect(page.locator('[data-automatic] .blob [data-mosaic-eye]')).toHaveCount(2);
      const signatures = await bodySignatures(page);
      for (const face of FACES) {
        const bodies = signatures.filter(signature => signature.case === face.id);
        expect(bodies).toHaveLength(perCase);
        // Changing recognition size or mood cannot choose another silhouette, shift the body,
        // replace its pigment or insert accessory pixels among its field tiles.
        for (const body of bodies) expect(body).toEqual(bodies[0]);
      }
      const pinnedGrids = await grids(page);
      const label = mode.replaceAll('&', '-') || '-sizes';
      await page.screenshot({ path: testInfo.outputPath('retained-identities' + label + '-' + theme + '.png'), fullPage: true });
      await page.goto(url + '&unpin');
      await expect(page.locator('[data-case] .blob')).toHaveCount(FACES.length * perCase);
      expect(await bodySignatures(page)).toEqual(signatures);
      expect(await grids(page)).toEqual(pinnedGrids);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/e2e/fixtures/mosaicFaces.html?moods&theme=' + theme);
    await expect(page.locator('[data-case] .blob')).toHaveCount(144);
    await expect(page.getByText(/Real MosaicBlob renderer/)).toContainText('reduced motion');
    expect(await page.locator('.blob').evaluateAll(nodes => nodes.every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('retained-identities-reduced-motion-' + theme + '.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('retained face identities keep snapped gaze; thinking, error and unknown never track', async ({ page }) => {
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
      const label = blob.closest('[data-case]')!.getAttribute('data-case') + ':' + mood;
      for (const side of [-1, 1]) {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: box.x + box.width / 2 + side * 45, clientY: box.y + box.height / 2 }));
        await frame();
        await frame();
        if (mood === 'thinking' || mood === 'error' || mood === 'unknown') {
          if (blob.hasAttribute('data-pupil-tracking')) failures.push(label + ':tracked');
          if (blob.querySelector('.mosaic-pupil[transform]')) failures.push(label + ':pointer-transform');
          continue;
        }
        if (!blob.hasAttribute('data-pupil-tracking')) failures.push(label + ':not-tracked');
        for (const node of blob.querySelectorAll<SVGGElement>('.mosaic-pupil')) {
          const pupil = node.querySelector('rect')!;
          const offset = node.transform.baseVal.consolidate()?.matrix;
          const eye = node.closest('.mosaic-eye-open')!.querySelector('[data-mosaic-eye]')!;
          if (!offset) {
            failures.push(label + ':missing-transform');
            continue;
          }
          const x = Number(pupil.getAttribute('x')) + offset.e - Number(eye.getAttribute('x'));
          if (x !== (side === -1 ? 0 : 1) || offset.f !== 0) failures.push(label + ':out-of-bounds');
        }
      }
    }
    return failures;
  });
  expect(failures).toEqual([]);
});
