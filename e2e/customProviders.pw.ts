import { expect, test, type Page } from '@playwright/test';

async function editor(page: Page, url = 'http://spark:8000/v1') {
  await page.getByRole('button', { name: 'Add custom provider' }).click();
  const form = page.getByRole('form', { name: 'Custom provider editor' });
  await form.getByLabel('Display name').fill('Spark DeepSeek');
  await form.getByLabel('Base URL', { exact: true }).fill(url);
  return form;
}

test('custom provider discovery, explicit default choice, edit and remove in Settings', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  const form = await editor(page);
  await form.getByLabel('API key (optional)').fill('mock-only-secret');
  await form.getByRole('button', { name: 'Discover models', exact: true }).click();
  await expect(form.getByLabel('Model IDs')).toHaveValue('deepseek-v4.1-flash');
  await form.getByRole('button', { name: 'Save custom provider' }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm instance default' });
  await expect(confirmation).toContainText('Spark DeepSeek');
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  await expect.poll(() => page.evaluate(async () => JSON.stringify(await window.ember.getSettings()))).not.toContain('mock-only-secret');
  await page.getByRole('button', { name: 'Edit Spark DeepSeek' }).click();
  await expect(form.getByLabel('API key (optional)')).toHaveCount(0);
  await form.getByLabel('Display name').fill('Spark renamed');
  await form.getByLabel('Replace or remove saved API key').check();
  await expect(form.getByLabel('API key (optional)')).toHaveValue('');
  await form.getByLabel('Model IDs').fill('deepseek-manual');
  await form.getByRole('button', { name: 'Save custom provider' }).click();
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  await expect(page.getByText('http://spark:8000/v1 · No key needed')).toBeVisible();
  await page.screenshot({ path: '/tmp/ember-custom-providers-settings.png' });
  await page.keyboard.press('Escape');
  await page.locator('aside').getByRole('button', { name: 'New bot', exact: true }).first().click();
  await page.getByRole('button', { name: 'Choose model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByLabel('Search models').fill('deepseek-manual');
  await expect(picker.getByRole('button', { name: /deepseek-manual/ }).first()).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Spark renamed', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Remove Spark renamed' })).toContainText('Existing model choices stay unchanged');
  await page.getByRole('button', { name: 'Confirm remove' }).click();
  await expect(page.getByRole('button', { name: 'Edit Spark renamed' })).toHaveCount(0);
});

test('onboarding supports a keyless manual model when discovery fails, without silently choosing a default', async ({ page }) => {
  await page.goto('/?fixture=onboarding&noProviders&noDock');
  const wizard = page.getByTestId('onboarding');
  await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
  const form = await editor(page, 'http://spark:8000/broken');
  await form.getByRole('button', { name: 'Discover models', exact: true }).click();
  await expect(wizard.getByRole('status')).toContainText('enter model IDs manually');
  await form.getByLabel('Model IDs').fill('deepseek-v4.1-flash');
  await form.getByRole('button', { name: 'Save custom provider' }).click();
  await wizard.getByRole('region', { name: 'Confirm instance default' }).getByRole('button', { name: 'Keep current default' }).click();
  const choice = wizard.getByLabel('Default model for');
  await expect(choice).toBeVisible(); await expect(choice).toHaveValue('');
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  const option = choice.locator('option').filter({ hasText: 'deepseek-v4.1-flash' });
  await choice.selectOption((await option.getAttribute('value'))!);
  await expect(page.getByTestId('onboarding-next')).toBeEnabled();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local']?.model?.modelID)).toBe('deepseek-v4.1-flash');
  await page.screenshot({ path: '/tmp/ember-custom-providers-onboarding.png' });
});
