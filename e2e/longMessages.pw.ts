import { expect, test } from '@playwright/test';

test('long-message study opens with scrollable full replies and mixed Markdown', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column).toBeVisible();
  const first = column.locator('[data-message-id="e2"]');
  const second = column.locator('[data-message-id="e4"]');
  await expect(first).toContainText('A small comparison');
  await expect(second).toContainText('A second long reply');
  expect((await first.boundingBox())!.height).toBeGreaterThan(3000);
  expect((await second.boundingBox())!.height).toBeGreaterThan(2000);
  await expect(first.locator('table')).toHaveCount(1);
  await expect(first.locator('pre')).toHaveCount(1);
  await column.getByRole('button', { name: /Go to new messages/ }).click();
  await expect(second).toHaveAttribute('data-highlighted', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/ember-long-messages.png' });
});
