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
  const readingHeight = (await column.getByLabel('Conversation history', { exact: true }).boundingBox())!.height;
  expect((await second.boundingBox())!.height).toBeGreaterThan(readingHeight * 2);
  await expect(first.locator('table')).toHaveCount(1);
  await expect(first.locator('pre')).toHaveCount(1);
  await column.getByRole('button', { name: /Go to new messages/ }).click();
  await expect(second).toHaveAttribute('data-highlighted', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/ember-long-messages.png' });
});

test('unread jump opens a long reply at its start with padding and a five-second fading highlight', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const history = column.getByLabel('Conversation history', { exact: true });
  const message = column.locator('[data-message-id="e4"]');
  const jump = column.getByRole('button', { name: /Go to new messages/ });
  await jump.click();
  await expect.poll(async () => {
    const [row, viewport] = await Promise.all([message.boundingBox(), history.boundingBox()]);
    return Math.round(row!.y - viewport!.y);
  }).toBe(28);
  const highlight = message.locator('.message-jump-highlight');
  expect(await highlight.evaluate(el => getComputedStyle(el).animationDuration)).toBe('5s');
  const initial = await highlight.evaluate(el => Number(getComputedStyle(el).opacity));
  expect(initial).toBeGreaterThan(.8);
  await page.waitForTimeout(2200);
  const middle = await highlight.evaluate(el => Number(getComputedStyle(el).opacity));
  expect(middle).toBeGreaterThan(.3);
  expect(middle).toBeLessThan(.7);
  await jump.click();
  expect(await highlight.evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(.9);
  await expect(message).not.toHaveAttribute('data-highlighted', 'true', { timeout: 6500 });
  await expect(highlight).toHaveCount(0);
});
