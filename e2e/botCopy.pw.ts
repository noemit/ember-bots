import { expect, test } from '@playwright/test';

test('idle and new-session composers invite a message to your bot', async ({ page }, testInfo) => {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const input = page.getByRole('textbox', { name: 'Message your bot', exact: true });
  await expect(input).toHaveAttribute('placeholder', 'Message your bot..');
  await expect(page.getByRole('button', { name: 'New bot', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('bot-composer.png') });
  await page.getByRole('button', { name: 'New bot', exact: true }).click();
  await expect(input).toHaveAttribute('placeholder', 'Message your bot..');
  await expect(page.getByLabel('New bot options')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel new bot', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New bot project', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('new-bot-composer.png') });
});
