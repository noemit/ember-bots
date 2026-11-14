import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  return page.getByRole('region', { name: 'Ollama setup' });
}

test('named keyless Ollama, explicit keep-default, saved address on reopen and reset', async ({ page }) => {
  const ollama = await setup(page);
  await expect(ollama).toContainText('not the computer running this window');
  await expect(ollama).toContainText('not answering');
  await expect(ollama.getByRole('textbox')).toHaveCount(0);
  await expect(ollama.getByLabel(/API key/)).toHaveCount(0);
  const before = await page.evaluate(async () => JSON.stringify((await window.ember.getSettings()).instanceDefaults));
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await expect(ollama).toContainText('Ollama is ready');
  const confirmation = page.getByRole('region', { name: 'Confirm instance default' });
  await expect(confirmation).toContainText('Ollama is connected');
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  expect(await page.evaluate(async () => JSON.stringify((await window.ember.getSettings()).instanceDefaults))).toBe(before);
  await ollama.getByRole('button', { name: 'Change address', exact: true }).click();
  await ollama.getByLabel('Ollama service address').fill('http://ollama-container:11434');
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  await page.screenshot({ path: '/tmp/ember-ollama-desktop.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(ollama.getByLabel('Ollama service address')).toHaveValue('http://ollama-container:11434');
  await ollama.getByRole('button', { name: 'Reset address', exact: true }).click();
  await expect(ollama).toContainText('http://127.0.0.1:11434');
  await expect(ollama.getByRole('button', { name: 'Reset address', exact: true })).toHaveCount(0);
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  await page.keyboard.press('Escape');
  await page.locator('aside').getByRole('button', { name: 'New bot', exact: true }).first().click();
  await page.getByRole('button', { name: 'Choose model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByLabel('Search models').fill('llama3.2:3b');
  await expect(picker.getByRole('button', { name: /llama3.2:3b/ }).first()).toBeVisible();
});

test('mobile separates not answering, running empty, wrong service and invalid address', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ollama = await setup(page);
  await ollama.getByRole('button', { name: 'Change address', exact: true }).click();
  const address = ollama.getByLabel('Ollama service address');
  await address.fill('http://down:11434');
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await expect(ollama).toContainText('Ollama is not answering');
  await address.fill('http://empty:11434');
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await expect(ollama).toContainText('no models are installed');
  await address.fill('http://wrong:11434');
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await expect(ollama).toContainText('not with an Ollama model list');
  await address.fill('http://localhost:11434/v1');
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await expect(ollama.getByRole('alert')).toContainText('without credentials or an API path');
  await page.screenshot({ path: '/tmp/ember-ollama-mobile.png' });
});

test('onboarding discovers installed models but requires a human default choice', async ({ page }) => {
  await page.goto('/?fixture=onboarding&noProviders&noDock');
  const wizard = page.getByTestId('onboarding');
  await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
  const ollama = wizard.getByRole('region', { name: 'Ollama setup' });
  await ollama.getByRole('button', { name: 'Test / Refresh', exact: true }).click();
  await wizard.getByRole('region', { name: 'Confirm instance default' }).getByRole('button', { name: 'Keep current default' }).click();
  const choice = wizard.getByLabel('Default model for');
  await expect(choice).toHaveValue('');
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  const option = choice.locator('option').filter({ hasText: 'llama3.2:3b' });
  await expect(option).toHaveCount(1);
  await choice.selectOption((await option.getAttribute('value'))!);
  await expect(page.getByTestId('onboarding-next')).toBeEnabled();
  await page.screenshot({ path: '/tmp/ember-ollama-onboarding.png' });
});
