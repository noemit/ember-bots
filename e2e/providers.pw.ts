import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Both key-only providers end in the same place: a key saved in Settings → Providers, then the
 * provider's models in the composer picker. The mock host mirrors Hearth's rule — an unkeyed
 * provider contributes nothing to `/models` — so a picker entry here means the credential reached
 * the catalogue, not merely the settings file.
 */
const providersTab = async (page: Page) => {
  await page.goto('/?noDock');
  // Settings moved to the top bar (beside the app name), not the rail.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
};

const saveKey = async (page: Page, provider: string, key: string) => {
  const field = page.getByRole('textbox', { name: `API key for ${provider}` });
  await field.fill(key);
  await field.locator('..').getByRole('button', { name: 'Save', exact: true }).click();
  // A saved key offers the instance-default decision; that is not this test's subject.
  await page.getByRole('region', { name: 'Confirm instance default' }).getByRole('button', { name: 'Keep current default' }).click();
  await expect(field).toHaveValue('');
};

const openPicker = async (page: Page): Promise<Locator> => {
  await page.keyboard.press('Escape');
  await page.locator('aside').getByRole('button', { name: 'New bot', exact: true }).first().click();
  await page.getByRole('button', { name: 'Choose model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await expect(picker).toBeVisible();
  return picker;
};

/**
 * Providers are collapsed by default, so searching opens the group that matches — the same way a
 * person finds a model in a long catalogue. `absent` asserts the model is not offered at all.
 */
const findModel = async (picker: Locator, name: string, absent = false) => {
  await picker.getByLabel('Search models').fill(name);
  const row = picker.getByRole('button', { name: new RegExp(name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  if (absent) await expect(row).toHaveCount(0);
  else await expect(row.first()).toBeVisible();
};

test('a DeepInfra key can be saved and its models reach the picker', async ({ page }) => {
  await providersTab(page);
  // The row exists before any key does — that is what gives it a field to type into.
  await expect(page.getByText('DeepInfra', { exact: true })).toBeVisible();
  await saveKey(page, 'DeepInfra', 'mock-deepinfra-key');
  await expect(page.getByText('DeepInfra', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove credential for DeepInfra' })).toBeVisible();

  const picker = await openPicker(page);
  await findModel(picker, 'Qwen3-32B');
  // The route id is the wire id; the picker shows the readable half.
  await findModel(picker, 'claude-opus-4-7');
  // Other providers' models are untouched by a DeepInfra key.
  await findModel(picker, 'Claude Sonnet 5.5', true);
  await picker.getByLabel('Search models').fill('');
  await page.screenshot({ path: '/tmp/ember-providers-deepinfra.png' });
});

test('OpenRouter still shows its row and its own models, next to DeepInfra', async ({ page }) => {
  await providersTab(page);
  await expect(page.getByText('OpenRouter', { exact: true })).toBeVisible();
  await saveKey(page, 'OpenRouter', 'mock-openrouter-key');

  const picker = await openPicker(page);
  await findModel(picker, 'Claude Sonnet 5.5');
  await findModel(picker, 'Qwen3-32B', true);
});

test('both keys can be present at once, each with its own status', async ({ page }) => {
  await providersTab(page);
  await saveKey(page, 'DeepInfra', 'mock-deepinfra-key');
  await saveKey(page, 'OpenRouter', 'mock-openrouter-key');
  for (const provider of ['DeepInfra', 'OpenRouter']) {
    await expect(page.getByRole('button', { name: `Remove credential for ${provider}` })).toBeVisible();
  }
  const picker = await openPicker(page);
  await findModel(picker, 'Qwen3-32B');
  await findModel(picker, 'Claude Sonnet 5.5');
});
