import { expect, test } from '@playwright/test';

test('thinking Scribble yields its gaze to nearby pointers, including reduced motion, but unavailable and error eyes do not track', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.addStyleTag({ content: '.gallery-style:not(:has(.blob-scribble)), .gallery-spotlights, .gallery-thinking { display: none }' });
  await page.getByRole('button', { name: 'Rail · 55px', exact: true }).click();
  const thinking = page.locator('[data-style="scribble"][data-state="thinking"] .blob').first();
  await thinking.scrollIntoViewIfNeeded();
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion });
    const box = (await thinking.boundingBox())!;
    for (const side of [-1, 1]) {
      await page.mouse.move(box.x + box.width / 2 + side * 65, box.y + 5);
      await expect(thinking).toHaveAttribute('data-pupil-tracking', 'true');
      await expect(thinking.locator('.scribble-gaze').first()).toHaveCSS('transform', 'none');
      await expect.poll(() => thinking.locator('.scribble-pupil').evaluateAll((nodes, direction) => nodes.every(node => {
        const matrix = (node as SVGGElement).transform.baseVal.consolidate()!.matrix;
        return matrix.e * direction > 0;
      }), side)).toBe(true);
      await expect.poll(() => thinking.locator('.scribble-pupil ellipse').evaluateAll(nodes => nodes.every(node => {
        const pupil = node as SVGEllipseElement;
        const eye = node.closest('.scribble-eye-blink')!.querySelector('[data-scribble-eye]') as SVGGeometryElement;
        const relative = eye.getScreenCTM()!.inverse().multiply(pupil.getScreenCTM()!);
        return Array.from({ length: 24 }, (_, i) => i * Math.PI / 12).every(angle => eye.isPointInFill(
          new DOMPoint(pupil.rx.baseVal.value * Math.cos(angle), pupil.ry.baseVal.value * Math.sin(angle)).matrixTransform(relative)));
      }))).toBe(true);
    }
    if (reducedMotion === 'reduce') await expect(thinking.locator('.scribble-eye-blink').first()).toHaveCSS('animation-name', 'none');
    await page.mouse.move(0, 0);
    await expect(thinking).not.toHaveAttribute('data-pupil-tracking');
    await expect(thinking.locator('.scribble-gaze').first()).not.toHaveCSS('transform', 'none');
  }
  for (const mood of ['error', 'unknown']) {
    const blob = page.locator(`[data-style="scribble"][data-state="${mood}"] .blob`).first();
    await blob.hover();
    await expect(blob).not.toHaveAttribute('data-pupil-tracking');
  }
});
