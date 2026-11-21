import { expect, test } from '@playwright/test';

test('a transcript create receipt opens its pending question in the current chat', async ({ page }) => {
  await page.goto('/?fixture=async-questions&askReceipt');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const chat = page.locator('main[data-session-key="pi:hearth::16"]');
  const message = chat.locator('[data-message-id="e100"]');
  await expect(message).toContainText('Which release channel should get the preview?');
  await expect(message).not.toContainText(/182818|"created"|conversationId|Canary channel|Internal channel/);

  await message.getByRole('button', { name: 'Open in Questions', exact: true }).click();
  await expect(chat.getByRole('tabpanel', { name: /Questions/ })).toBeVisible();
  const composer = chat.getByRole('region', { name: 'Answer to this question' });
  await expect(composer).toContainText('Answer for this conversation');
  const choice = composer.getByRole('button', { name: 'Canary channel', exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(composer.getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled();
});
