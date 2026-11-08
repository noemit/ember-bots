import { expect, test } from '@playwright/test';

test('onboarding requires and saves an explicit default before opening the first agent', async ({ page }) => {
  await page.goto('/?fixture=onboarding&noDock');
  const wizard = page.getByTestId('onboarding');
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
  const select = wizard.getByLabel('Default model for');
  await expect(select).toHaveValue('');
  await expect(wizard.getByRole('button', { name: 'Skip for now' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: /5\. First agent/ }).click();
  await expect(wizard.getByRole('button', { name: 'New agent', exact: true })).toBeDisabled();
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  await wizard.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  const workspacePicker = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Choose your workspace' }) });
  await workspacePicker.getByRole('button', { name: 'Use this workspace' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local']?.workspaceDirectory)).toBe('/workspace');
  // A workspace alone must not bypass the explicit model choice.
  await expect(wizard.getByRole('button', { name: 'New agent', exact: true })).toBeDisabled();
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  const tip = wizard.getByRole('complementary', { name: 'Tip for getting started' });
  await expect(tip).toContainText('may offer free models');
  await expect(tip).toContainText('not every model is free');
  await expect(tip).toContainText('API key');
  await expect.poll(() => select.locator('option').count()).toBeGreaterThan(2);
  const choice = await select.locator('option').nth(2).getAttribute('value');
  const choiceLabel = await select.locator('option').nth(2).textContent();
  await page.screenshot({ path: '/tmp/ember-onboarding-model.png', fullPage: true });
  await select.selectOption(choice!);
  await expect.poll(() => page.evaluate(async () => {
    const settings = await window.ember.getSettings();
    return settings.instanceDefaults['pi:local']?.model;
  })).toEqual({ providerID: choice!.split('/')[0], modelID: choice!.slice(choice!.indexOf('/') + 1) });
  await expect(page.getByTestId('onboarding-next')).toBeEnabled();
  await page.getByTestId('onboarding-next').click();
  await wizard.getByRole('button', { name: 'New agent', exact: true }).click();
  await expect(wizard).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toContainText(choiceLabel!);
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local']?.model)).toEqual({ providerID: choice!.split('/')[0], modelID: choice!.slice(choice!.indexOf('/') + 1) });
});

test('connect a provider first: no dropdown until credentials are saved', async ({ page }) => {
  await page.goto('/?fixture=onboarding&noProviders&noDock');
  const wizard = page.getByTestId('onboarding');
  await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
  await expect(wizard.getByRole('heading', { name: 'First, connect an AI service' })).toBeVisible();
  await expect(wizard.getByLabel('Default model for')).toHaveCount(0);
  await expect(wizard).toContainText('Once a provider is connected, choose your default model here');
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  await expect(wizard.getByRole('complementary', { name: 'Tip for getting started' }).locator('strong')).toHaveText('TIP');
  await expect(wizard.getByRole('button', { name: 'Open OpenCode', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/ember-onboarding-no-providers.png', fullPage: true });
  const key = wizard.getByRole('textbox', { name: 'API key for Faux Harness' });
  await key.fill('mock-provider-key');
  await key.press('Enter');
  await expect(wizard.getByLabel('Default model for')).toBeVisible();
  await expect(wizard.getByLabel('Default model for')).toHaveValue('');
  const confirmation = wizard.getByRole('region', { name: 'Confirm instance default' });
  await expect(confirmation).toContainText('Faux Harness is connected');
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local']?.model)).toBeUndefined();
  await expect(wizard.getByLabel('Default model for')).toHaveValue('');
  await expect(wizard).toContainText('Choose an available model, then select Continue');
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  await page.screenshot({ path: '/tmp/ember-onboarding-connected.png', fullPage: true });
});

test('a missing host offers a visible route back to connection recovery', async ({ page }) => {
  await page.goto('/?fixture=firstrun&noDock');
  const wizard = page.getByTestId('onboarding');
  await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
  await expect(wizard.getByLabel('Default model for')).toHaveCount(0);
  await expect(wizard).toContainText('Retry this computer or connect another host');
  await wizard.getByRole('button', { name: 'Where to run Kiln', exact: true }).click();
  await expect(wizard.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(wizard).toContainText('another computer');
});
