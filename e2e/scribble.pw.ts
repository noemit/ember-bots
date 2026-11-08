import { expect, test } from '@playwright/test';

test('retired Scribble remains available in the development gallery', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await expect(page.getByRole('heading', { name: 'Scribble (retired)', exact: true })).toBeVisible();
  const studies = page.locator('[data-style="scribble"][data-state="busy"]');
  await expect(studies.locator('.blob-scribble')).toHaveCount(3);
  await expect(studies.locator('.blob-buddy')).toHaveCount(0);
  await expect(studies.locator('[data-scribble-eye]').first()).toHaveAttribute('stroke', '#29212f');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await studies.locator('.scribble-dance').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});
