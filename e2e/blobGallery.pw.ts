import { expect, test } from '@playwright/test';

test('gallery shows every state and previews three distinct Scribble gestures', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/blob-gallery.html');
  await expect(page.getByRole('heading', { name: 'A little more character.' })).toBeVisible();
  await expect(page.locator('.gallery-state')).toHaveCount(40);
  expect(await page.evaluate(() => Boolean(window.ember))).toBe(false);
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const scribble = page.locator('[data-preview="scribble"] > .blob');
  await page.getByRole('button', { name: 'Head scratch', exact: true }).click();
  await expect(scribble.locator('.scribble-scratch')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '/tmp/ember-blob-gallery-scratch.png', fullPage: true });
  await page.getByRole('button', { name: 'Turn around', exact: true }).click();
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '0');
  await expect(scribble.locator('.scribble-scratch')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: '/tmp/ember-blob-gallery-turn.png' });
  await page.getByRole('button', { name: 'Little stretch', exact: true }).click();
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '1');
  expect(await scribble.locator('.scribble-dance').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).d)).toBeGreaterThan(1);
  await page.getByLabel('Theme', { exact: true }).selectOption('graphite');
  await page.getByLabel('Creature colour').fill('#fff4c2');
  await expect(scribble.locator('[data-scribble-eye]').first()).toHaveAttribute('stroke', '#29212f');
  await page.getByRole('button', { name: 'Head scratch', exact: true }).click();
  await page.screenshot({ path: '/tmp/ember-blob-gallery-dark.png' });
  await page.getByLabel('Reduced motion', { exact: true }).check();
  await expect(scribble.locator('.scribble-dance')).toHaveCSS('animation-name', 'none');
  expect(await scribble.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(scribble.locator('.scribble-scratch')).toHaveCSS('opacity', '0');
  await page.setViewportSize({ width: 430, height: 900 });
  await page.getByRole('heading', { name: 'Crystal', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: 'Crystal', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Mosaic pixels change on both sides while the body stays anchored, with a static reduced-motion pose', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  const mosaic = page.locator('[data-preview="mosaic"] > .blob');
  await expect(mosaic).toBeVisible();
  for (const side of ['left', 'right']) {
    const changes = await mosaic.locator(`.mosaic-pixel[data-side="${side}"]`).evaluateAll(nodes => {
      const frames: string[] = [];
      for (const time of [0, 600, 1200, 1800]) {
        nodes.forEach(node => {
          const pixel = node as SVGElement;
          pixel.style.animationPlayState = 'paused';
          pixel.style.animationDelay = `-${time}ms`;
        });
        frames.push(nodes.map(node => getComputedStyle(node).opacity).join(','));
      }
      return new Set(frames).size;
    });
    expect(changes).toBeGreaterThan(1);
  }
  await expect(mosaic.locator('.mosaic-step')).toHaveCSS('transform', 'none');
  expect(await page.locator('[data-style="mosaic"][data-state="idle"] .blob').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mosaic.locator('.mosaic-pixel').first()).toHaveCSS('animation-name', 'none');
  expect(await mosaic.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(mosaic.locator('.mosaic-pixel').first()).toHaveCSS('opacity', '0.45');
  const scribble = page.locator('[data-preview="scribble"] > .blob');
  expect(await scribble.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
});
