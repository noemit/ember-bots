import { expect, test } from '@playwright/test';

test('Scribble can be selected and customised, with the same creature beside the composer', async ({ page }) => {
  await page.goto('/?noDock');
  const rail = page.locator('aside');
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Scribble/ }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.blobStyle))).toBe('scribble');
  await page.keyboard.press('Escape');
  const row = rail.getByRole('button', { name: /Habit onboarding QA/ });
  await row.click();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  await page.getByLabel('Custom agent color').fill('#fff4c2');
  await page.getByRole('button', { name: 'thistle', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('.blob-scribble')).toHaveAttribute('data-shape', 'thistle');
  const composer = page.locator('[data-active-chat="pi:hearth::10"] [data-composer-identity]');
  await expect(composer.locator('.blob-scribble')).toHaveAttribute('data-shape', 'thistle');
  await expect(composer.locator('[data-scribble-eye]').first()).toHaveAttribute('stroke', '#29212f');
  await expect(composer.locator('path[fill="#fff4c2"]')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await row.locator('.scribble-dance').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: '/tmp/ember-scribble-rail.png' });
});
