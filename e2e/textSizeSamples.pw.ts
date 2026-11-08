import { expect, test } from '@playwright/test';

test('each text size shows a live sample that follows its own preset only', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const chat = page.getByTestId('text-size-preview-chat');
  const composer = page.getByTestId('text-size-preview-composer');
  const iface = page.getByTestId('text-size-preview-interface');
  await expect(chat).toHaveCSS('font-size', '14px');
  await expect(composer).toHaveCSS('font-size', '18px');
  await expect(iface).toHaveCSS('zoom', '1');
  const pick = async (group: string, choice: string) =>
    page.getByRole('group', { name: group, exact: true }).getByRole('button', { name: choice, exact: true }).click();
  await pick('Chat text size', 'Large');
  await expect(chat).toHaveCSS('font-size', '16px');
  await expect(composer).toHaveCSS('font-size', '18px');
  await pick('Composer text size', 'Small');
  await expect(composer).toHaveCSS('font-size', '16px');
  await expect(chat).toHaveCSS('font-size', '16px');
  await pick('Interface text size', 'Small');
  await expect(iface).toHaveCSS('zoom', '0.92');
  await expect(chat).toHaveCSS('font-size', '16px');
  await page.screenshot({ path: '/tmp/ember-text-size-samples.png' });
});
