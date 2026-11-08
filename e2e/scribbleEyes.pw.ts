import { expect, test } from '@playwright/test';

test('Scribble eyes keep their expressions at rail size, yield to the pointer, and respect motion settings', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  // Keep the production Scribble scene, without animating the other 96 gallery characters.
  await page.addStyleTag({ content: '.gallery-style:not(:has(.blob-scribble)), .gallery-spotlights, .gallery-thinking { display: none }' });
  await page.getByRole('button', { name: 'Rail · 55px', exact: true }).click();
  const busy = page.locator('[data-style="scribble"][data-state="busy"] .blob').first();
  await busy.scrollIntoViewIfNeeded();
  const box = (await busy.boundingBox())!;
  await page.mouse.move(box.x + box.width + 30, box.y + 15);
  await expect(busy).toHaveAttribute('data-pupil-tracking', 'true');
  await expect(busy.locator('.scribble-gaze').first()).toHaveCSS('animation-name', 'none');
  expect(await busy.locator('.scribble-pupil').evaluateAll(nodes => nodes.every(node => (node as SVGGElement).transform.baseVal.consolidate()!.matrix.e > 0))).toBe(true);
  await page.mouse.move(0, 0);
  await expect(busy).not.toHaveAttribute('data-pupil-tracking');
  await expect(busy.locator('.scribble-gaze').first()).toHaveCSS('animation-name', 'scribble-eye-glance');
  await page.evaluate(() => document.documentElement.classList.add('motion-paused'));
  await expect(busy.locator('.scribble-eye-blink').first()).toHaveCSS('animation-play-state', 'paused');
  await page.evaluate(() => document.documentElement.classList.remove('motion-paused'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(busy.locator('.scribble-eye-blink').first()).toHaveCSS('animation-name', 'none');
  await expect(busy.locator('.scribble-gaze').first()).toHaveCSS('animation-name', 'none');
  await page.getByLabel('Reduced motion', { exact: true }).check();
  await page.getByLabel('Scribble states', { exact: true }).screenshot({ path: '/tmp/scribble-evidence/browser-rail.png' });
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('graphite');
  await page.getByLabel('Scribble states', { exact: true }).screenshot({ path: '/tmp/scribble-evidence/browser-detail-dark.png' });
});
