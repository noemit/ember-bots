import { expect, test } from '@playwright/test';

test('Mosaic replaces Pip in settings and keeps custom shape and colour in the rail', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: /Pip/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Mosaic/ }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.blobStyle))).toBe('mosaic');
  await page.keyboard.press('Escape');
  const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
  await expect(row.locator('.blob-mosaic')).toBeVisible();
  await row.click();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Custom bot color').fill('#158cba');
  await dialog.getByRole('button', { name: 'crown', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('.blob-mosaic')).toHaveAttribute('data-shape', 'crown');
  await expect(page.locator('main[data-session-key="pi:hearth::10"] [data-agent-glow]')).toHaveAttribute('style', /rgb\(21, 140, 186\)/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await row.locator('.mosaic-step').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: '/tmp/ember-mosaic-rail.png' });
});

test('every style rasterises its body and overlay as a valid dock image', async ({ page }) => {
  await page.goto('/?noDock');
  await expect(page.locator('aside')).toBeVisible();
  const images = await page.evaluate(async () => {
    const source = '/src/blob/dockIcon.ts';
    const { renderDockIcon } = await import(/* @vite-ignore */ source);
    const identity = { sessionKey: 'demo', colorSeed: 'demo', shapeSeed: 'demo', motionSeed: 'demo', color: '#ff8648' };
    const results = [];
    for (const style of ['buddy', 'crystal', 'mosaic', 'lava', 'scribble']) results.push(await renderDockIcon(style, identity, 'question'));
    return results;
  });
  for (const image of images) expect(image).toMatch(/^data:image\/png;base64,/);
});
