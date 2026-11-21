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
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add provider', exact: true }).getByRole('button', { name: new RegExp(provider) }).click();
  const field = page.getByRole('textbox', { name: `API key for ${provider}` });
  await field.fill(key);
  await field.locator('..').getByRole('button', { name: 'Save key', exact: true }).click();
  // A saved key offers the instance-default decision; that is not this test's subject.
  await page.getByRole('region', { name: 'Default model for new chats' }).getByRole('button', { name: 'Keep current default' }).click();
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
  await saveKey(page, 'DeepInfra', 'mock-deepinfra-key');
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
    await expect(page.getByRole('button', { name: 'Manage ' + provider })).toBeVisible();
  }
  const picker = await openPicker(page);
  await findModel(picker, 'Qwen3-32B');
  await findModel(picker, 'Claude Sonnet 5.5');
});

test('environment access appears in the inventory without a removable credential', async ({ page }) => {
  await page.goto('/?noDock');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    const original = window.ember.piRequest!;
    window.ember.piRequest = async (id, path, init) => path === '/providers'
      ? { ok: true, status: 200, data: { providers: [{ id: 'openai', name: 'OpenAI', credential: null, envVar: 'OPENAI_API_KEY' }] } as never }
      : original(id, path, init);
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(page.getByText('OPENAI_API_KEY', { exact: true })).toBeVisible();
  await expect(page.getByText(/unset it on the computer running this Kiln/i)).toBeVisible();
  await page.getByRole('button', { name: 'Manage OpenAI', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'API key for OpenAI' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove credential for OpenAI' })).toHaveCount(0);
});

test('switching computers during a pending save clears scoped controls and ignores the old response', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?noDock');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    const original = window.ember.piRequest!;
    const probe = { release: undefined as (() => void) | undefined, pending: false };
    Object.assign(window, { providerHostProbe: probe });
    window.ember.piRequest = async (id, path, init) => {
      if (path === '/providers') return { ok: true, status: 200, data: {
        providers: [{ id: 'shared', name: 'Shared Provider', credential: 'api_key' }],
        default: { provider: 'shared', modelId: id === 'pi:hearth' ? 'Model A' : 'Model B' },
      } as never };
      if (path === '/providers/shared' && init?.method === 'POST') {
        probe.pending = true;
        await new Promise<void>(resolve => { probe.release = resolve; });
        return { ok: true, status: 200, data: {} as never };
      }
      return original(id, path, init);
    };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Computers and Containers', exact: true }).click();
  const connection = page.getByRole('region', { name: 'Add connection', exact: true });
  await connection.getByRole('button', { name: 'On another computer or container', exact: true }).click();
  await connection.getByLabel('Computer or container name', { exact: true }).fill('Computer B');
  await connection.getByLabel('Kiln URL', { exact: true }).fill('https://computer-b.example.test');
  await connection.getByLabel('Bearer token', { exact: true }).fill('synthetic-only');
  await connection.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Add provider', exact: true });
  await chooser.getByRole('button', { name: /Shared Provider/ }).focus();
  await page.keyboard.press('Enter');
  const field = page.getByRole('textbox', { name: 'API key for Shared Provider', exact: true });
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport();
  await page.keyboard.type('synthetic-key-for-A');
  await field.locator('..').getByRole('button', { name: 'Save key', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { providerHostProbe: { pending: boolean } }).providerHostProbe.pending)).toBe(true);
  await page.getByRole('combobox', { name: 'Computer or container for providers', exact: true }).click();
  await page.getByRole('option', { name: /^Computer B/ }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Default model for new chats' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage Shared Provider', exact: true }).click();
  await expect(field).toHaveValue('');
  await field.fill('synthetic-key-for-B');
  await expect(field.locator('..').getByRole('button', { name: 'Save key', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { providerHostProbe: { release: () => void } }).providerHostProbe.release());
  await expect(field).toHaveValue('synthetic-key-for-B');
  await expect(field.locator('..').getByRole('button', { name: 'Save key', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Default model for new chats' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toContainText('Model B');
});

test('removing a saved credential from collapsed inventory clears its models immediately without picking a replacement default', async ({ page }) => {
  await providersTab(page);
  await saveKey(page, 'DeepInfra', 'mock-deepinfra-key');
  // Re-open Settings so DeepInfra renders collapsed in inventory mode.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Manage DeepInfra', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Remove credential for DeepInfra', exact: true }).click();
  const group = page.getByRole('group', { name: 'Remove DeepInfra', exact: true });
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: 'Remove credential', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Manage DeepInfra', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove credential for DeepInfra', exact: true })).toHaveCount(0);

  const picker = await openPicker(page);
  await findModel(picker, 'claude-opus-4-7', true);
});

test('custom provider can be removed with confirmation and its models leave the picker immediately', async ({ page }) => {
  await providersTab(page);
  await page.getByRole('button', { name: 'Add custom provider', exact: true }).click();
  const form = page.getByRole('form', { name: 'Custom provider editor', exact: true });
  await form.getByLabel('Display name', { exact: true }).fill('Local vLLM');
  await form.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:8000/v1');
  await form.getByLabel('Model IDs (one per line)', { exact: true }).fill('qwen-custom-7b');
  await form.getByRole('button', { name: 'Save custom provider', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Local vLLM', exact: true })).toBeVisible();

  const pickerWithCustom = await openPicker(page);
  await findModel(pickerWithCustom, 'qwen-custom-7b');
  await pickerWithCustom.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Local vLLM', exact: true }).click();
  const removeGroup = page.getByRole('group', { name: 'Remove Local vLLM', exact: true });
  await expect(removeGroup).toBeVisible();
  await removeGroup.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Local vLLM', exact: true })).toHaveCount(0);

  const pickerAfterDelete = await openPicker(page);
  await findModel(pickerAfterDelete, 'qwen-custom-7b', true);
});
