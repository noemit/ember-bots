import { expect, test } from '@playwright/test';

/**
 * The image lightbox: a transcript image opens larger, zooms, and closes. The pi mock's
 * `Screenshot review` conversation carries a tool-result image (`screenshot.png`).
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

/**
 * Read the zoom percentage the viewer is reporting.
 *
 * The percentage is `scale x fitScale`, so 100% means one image pixel per screen pixel at *any*
 * window size — not "the image has been fitted". Absolute numbers therefore depend on the mock
 * image's dimensions against the viewport, so these tests assert the *relationships* (zoom in
 * increases it, 1:1 lands on exactly 100%) rather than hard-coding values that would only hold at
 * one viewport size.
 */
const zoomPercent = async (dialog: import('@playwright/test').Locator): Promise<number> => {
  const label = dialog.getByRole('button', { name: /Zoom level \d+ percent/ });
  const text = (await label.textContent()) ?? '';
  const match = /(\d+)\s*%/.exec(text);
  if (!match) throw new Error(`no percentage in ${JSON.stringify(text)}`);
  return Number(match[1]);
};

test('a tool image opens in the lightbox, zooms, and closes', async ({ page }) => {
  await page.getByRole('button', { name: /Screenshot review/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::15"]');
  await column.locator('img[alt="screenshot.png"]').click();

  const dialog = page.getByRole('dialog', { name: 'Image: screenshot.png' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Save image' })).toHaveAttribute('download', 'screenshot.png');

  const fitted = await zoomPercent(dialog);
  expect(fitted).toBeGreaterThan(0);

  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await zoomPercent(dialog);
  expect(zoomed).toBeGreaterThan(fitted);

  await dialog.getByRole('button', { name: 'Zoom out' }).click();
  expect(await zoomPercent(dialog)).toBe(fitted);

  // 1:1 is the guarantee the whole viewer exists to make: exactly one image pixel per screen pixel.
  await dialog.getByRole('button', { name: '1:1' }).click();
  expect(await zoomPercent(dialog)).toBe(100);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('double-click toggles between fitted and twice that', async ({ page }) => {
  await page.getByRole('button', { name: /Screenshot review/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::15"]');
  await column.locator('img[alt="screenshot.png"]').click();
  const dialog = page.getByRole('dialog', { name: 'Image: screenshot.png' });
  await expect(dialog).toBeVisible();
  const large = dialog.locator('img[alt="screenshot.png"]');

  const fitted = await zoomPercent(dialog);
  await large.dblclick();
  const doubled = await zoomPercent(dialog);
  // Double-click zooms to 2x the transform scale, so the reported percentage doubles too.
  expect(doubled).toBe(fitted * 2);

  await large.dblclick();
  expect(await zoomPercent(dialog)).toBe(fitted);
});

test('next and previous step through every image in the conversation', async ({ page }) => {
  await page.getByRole('button', { name: /Screenshot review/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::15"]');

  // The two images live in different turns; the viewer still treats them as one gallery.
  await column.locator('img[alt="image.png"]').click();
  const dialog = page.getByRole('dialog', { name: 'Image: image.png' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('2 / 2');

  await dialog.getByRole('button', { name: 'Previous image' }).click();
  await expect(page.getByRole('dialog', { name: 'Image: screenshot.png' })).toContainText('1 / 2');

  await page.getByRole('dialog', { name: 'Image: screenshot.png' }).getByRole('button', { name: 'Next image' }).click();
  await expect(page.getByRole('dialog', { name: 'Image: image.png' })).toContainText('2 / 2');
});

test('keyboard zoom and gallery controls stay inside the viewer and closing restores focus', async ({ page }) => {
  await page.getByRole('button', { name: /Screenshot review/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::15"]');
  // Wait for the full conversation gallery, not just its first arriving image.
  await expect(column.locator('img[alt="image.png"]')).toBeVisible();
  const opener = column.locator('button').filter({ has: page.locator('img[alt="image.png"]') });
  await opener.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog', { name: /^Image:/ });
  await expect(viewer).toBeVisible();
  const fitted = await zoomPercent(viewer);
  await page.keyboard.press('+');
  await expect.poll(() => zoomPercent(viewer)).toBeGreaterThan(fitted);
  await page.keyboard.press('0');
  await expect.poll(() => zoomPercent(viewer)).toBe(fitted);
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toHaveAccessibleName('Image: screenshot.png');
  await page.keyboard.press('ArrowLeft');
  await expect(viewer).toHaveAccessibleName('Image: image.png');
  // Tab traversal must not reach the workspace beneath the lightbox.
  await viewer.getByRole('button', { name: 'Close image' }).focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => viewer.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  await viewer.getByRole('button', { name: 'Close image' }).click();
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
});
