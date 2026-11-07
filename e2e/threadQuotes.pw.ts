import { expect, test } from '@playwright/test';

test('a quoted thread opens its source while internal coordination stays out of the transcript', async ({ page }) => {
  await page.goto('/?threads');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const log = leader.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('Crew report', { exact: true })).toHaveCount(0);
  await expect(log.getByText(/\[crew\]/)).toHaveCount(0);
  await expect(leader.getByRole('tab', { name: /Threads.*running.*needs you/ })).toBeVisible();
  await log.getByRole('link', { name: 'Parse config', exact: true }).click();
  const worker = page.locator('main[data-session-key="pi:hearth::17"]');
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Parse the config');
  await expect(page.locator('[data-rail-scroll]').getByRole('button', { name: /^Parse config/ })).toHaveCount(0);
  await expect(worker.locator('textarea')).toBeEnabled();
});
