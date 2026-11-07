import { expect, test } from '@playwright/test';

test('footer shortcuts reveal on row hover, copy Markdown and reply without replacing the draft', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const message = column.locator('[data-message-id="e2"]');
  const footer = message.locator('[data-message-footer]');
  const actions = footer.locator('[data-footer-actions]');
  await page.mouse.move(5, 5);
  await expect(actions).toHaveCSS('opacity', '0');
  await footer.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  // The original gutter copy shortcut is still present.
  await expect(message.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(1);
  await footer.getByRole('button', { name: 'Copy message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Found a regression: the step counter shows **3/2** on the last step.');
  await expect(footer.getByRole('status')).toHaveText('Copied as Markdown');
  const composer = column.locator('textarea');
  await composer.fill('Keep this draft while I quote that reply.');
  await footer.hover();
  await page.screenshot({ path: '/tmp/ember-message-footer.png' });
  await footer.getByRole('button', { name: 'Reply to this message' }).click();
  await expect(column.getByText('Replying with context', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('Keep this draft while I quote that reply.');
  await expect(composer).toBeFocused();
  await column.getByRole('button', { name: 'Remove reply context' }).click();
  await expect(column.getByText('Replying with context', { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this draft while I quote that reply.');
});

test('footer shortcuts are discoverable with keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const footer = page.locator('main[data-session-key="pi:hearth::10"] [data-message-footer]').first();
  await page.mouse.move(5, 5);
  const reply = footer.getByRole('button', { name: 'Reply to this message' });
  await reply.focus();
  await expect(footer.locator('[data-footer-actions]')).toHaveCSS('opacity', '1');
  await reply.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove reply context' })).toBeVisible();
});

test('an unchanged Kiln setting exposes Off instead of an ambiguous Default', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ember-pi-read-state', JSON.stringify({ readMarks: {} })));
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await column.getByRole('button', { name: 'Reasoning level: Off', exact: true }).click();
  await page.getByRole('radio', { name: 'high', exact: true }).click();
  await column.getByRole('button', { name: 'Reasoning level: High', exact: true }).click();
  await page.getByRole('radio', { name: 'Keep Off', exact: true }).click();
  await expect(column.getByRole('button', { name: 'Reasoning level: Off', exact: true })).toBeVisible();
});

test('touch devices expose footer actions without hover', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5179/');
    const column = page.locator('main[data-session-key]').first();
    const actions = column.locator('[data-footer-actions]').first();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(actions.getByRole('button', { name: 'Reply to this message' })).toBeVisible();
  } finally {
    await context.close();
  }
});
