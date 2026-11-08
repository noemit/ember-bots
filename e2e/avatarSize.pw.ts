import { expect, test } from '@playwright/test';

test('avatar sizes keep rail and composer identities together without crowding the compact rail', async ({ page }) => {
  await page.goto('/?noDock');
  const rail = page.locator('aside');
  const row = rail.getByRole('button', { name: /Habit onboarding QA/ });
  await row.click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const composer = page.locator('[data-composer-identity]');
  await expect(composer).toContainText('Habit onboarding QA');
  await expect(row.locator('.blob').first()).toHaveCSS('width', '55px');
  for (const [label, size, composerSize] of [['Large', 69, 69], ['Extra large', 83, 83], ['Standard', 55, 55]] as const) {
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: `${label} avatars`, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(row.locator('.blob').first()).toHaveCSS('width', `${size}px`);
    await expect(composer.locator('.blob').first()).toHaveCSS('width', `${composerSize}px`);
  }
  // Custom identity stays exact beside the input and survives selecting another chat.
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  await page.getByLabel('Custom bot color').fill('#a858c8');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(composer.locator('svg [fill="#a858c8"]')).not.toHaveCount(0);
  await expect(column.locator('[data-composer-surface]')).toHaveAttribute('style', /rgb\(168, 88, 200\)/);
  await rail.getByRole('button', { name: /Screenshot review/ }).click();
  await expect(page.locator('[data-composer-identity]')).toContainText('Screenshot review');
  await row.click();
  await expect(composer).toContainText('Habit onboarding QA');

  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Extra large avatars', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+b');
  const mini = rail.locator('[data-mini-session="pi:hearth::10"]');
  await expect(mini.locator('.blob').first()).toHaveCSS('width', '60px');
  await expect(rail).toHaveCSS('width', '84px');
  await expect.poll(() => rail.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press('ControlOrMeta+b');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: '/tmp/ember-avatar-size.png' });
  await page.setViewportSize({ width: 420, height: 820 });
  await expect(composer).toBeVisible();
  expect(await column.locator('[data-composer-surface]').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
