import { expect, test, type Page } from '@playwright/test';

const calls = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('queue-edit-calls') ?? '[]'));
const capture = (page: Page, fail = false) => page.evaluate((fail) => {
  const original = window.ember.piRequest!.bind(window.ember);
  window.ember.piRequest = async (instance, path, init) => {
    if (init?.method && init.method !== 'GET') {
      const recorded = JSON.parse(sessionStorage.getItem('queue-edit-calls') ?? '[]');
      sessionStorage.setItem('queue-edit-calls', JSON.stringify([...recorded, { instance, path, ...init }]));
    }
    if (fail && path.endsWith('/submit')) return { ok: false, status: 503, data: null as never };
    return original(instance, path, init);
  };
}, fail);

const choose = async (page: Page, modelName: string, level: string) => {
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill(modelName);
  await picker.getByRole('button', { name: modelName, exact: true }).click();
  await picker.getByRole('combobox', { name: 'Reasoning level' }).click();
  await page.getByRole('option', { name: level, exact: true }).click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
};
const setup = async (page: Page, image = false) => {
  await page.goto('/?staleBusy');
  await page.locator('aside').getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await column.getByRole('button', { name: 'Choose model', exact: true }).click();
  await choose(page, 'DeepSeek V4.1 Flash', 'max');
  if (image) await column.locator('input[type="file"]').setInputFiles({
    name: 'pixel.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zQAAAABJRU5ErkJggg==', 'base64'),
  });
  for (const text of ['original queued message', 'next queued message']) {
    await column.locator('textarea').fill(text);
    await column.locator('textarea').press('Enter');
    await expect(column.getByRole('button', { name: 'Cancel queued message: ' + text })).toBeVisible();
  }
  await expect(column.locator('ol > li')).toHaveCount(2);
  await column.getByRole('button', { name: 'Edit queued message: original queued message' }).click();
  return column;
};

test('text-only edits keep original model/effort, attachments and queue position; enqueue precedes withdrawal', async ({ page }) => {
  const column = await setup(page, true);
  await capture(page);
  await page.getByRole('textbox', { name: 'Queued message text' }).fill('edited original message');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(column.locator('ol > li')).toHaveCount(2);
  await expect(column.locator('ol > li').first()).toContainText('edited original message');
  await expect(column.locator('ol > li').nth(1)).toContainText('next queued message');
  const requests = await calls(page);
  expect(requests[0]).toMatchObject({ instance: 'pi:hearth', path: '/conversations/11/configure', body: {
    model: { provider: 'faux-hearth', modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'max',
  } });
  const submit = requests.findIndex((entry: { path: string }) => entry.path.endsWith('/submit'));
  const abort = requests.findIndex((entry: { path: string }) => entry.path.endsWith('/abort'));
  expect(abort).toBeGreaterThan(submit);
  expect(requests[submit].body.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
});

test('model-only edit uses target host catalogue, refuses incompatible effort, then sends the chosen config', async ({ page }) => {
  const column = await setup(page);
  await page.getByRole('button', { name: 'Queued message model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('GLM');
  await picker.getByRole('button', { name: 'GLM-5.3 Flash', exact: true }).click();
  await expect(picker.getByRole('status')).toContainText(/reasoning level max.*unavailable/);
  await expect(picker.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await picker.getByRole('combobox', { name: 'Reasoning level' }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await page.screenshot({ path: '/tmp/ember-queued-edit-model.png' });
  await capture(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await calls(page))[0]).toMatchObject({ body: {
    model: { provider: 'faux-hearth', modelId: 'glm-5.3-flash' }, thinkingLevel: 'high',
  } });
  await expect(column.locator('ol > li')).toHaveCount(2);
  await expect(column.locator('ol > li').first()).toContainText('original queued message');
});

test('explicit default effort clears rather than inheriting the old level; failed enqueue never withdraws original', async ({ page }) => {
  const column = await setup(page);
  await page.getByRole('button', { name: 'Queued message model' }).click();
  await choose(page, 'DeepSeek V4.1 Flash', 'Default');
  await capture(page, true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await calls(page))[0]).toMatchObject({ body: { thinkingLevel: null } });
  await expect(column.locator('ol > li').filter({ hasText: /could not queue/i })).toHaveCount(1);
  expect((await calls(page)).some((entry: { path: string }) => entry.path.endsWith('/abort'))).toBe(false);
  await expect(column.getByRole('button', { name: 'Cancel queued message: original queued message' }).first()).toBeVisible();
  await expect(column.locator('ol > li')).toHaveCount(3);
});

test('a refreshed catalogue cannot silently substitute an unavailable queued model', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    window.ember.piRequest = async (instance, path, init) => {
      const response = await original(instance, path, init);
      if (path === '/models') {
        const data = response.data as { models: Array<{ id: string }> };
        return { ...response, data: { ...data, models: data.models.filter(model => model.id !== 'deepseek-v4.1-flash') } as never };
      }
      return response;
    };
  });
  await page.getByRole('button', { name: 'Queued message model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('button', { name: 'Refresh the model list' }).click();
  await expect(picker.getByRole('status')).toContainText('deepseek-v4.1-flash');
  await expect(picker.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  const editor = page.getByRole('dialog', { name: 'Edit queued message' });
  await expect(editor.getByRole('alert')).toContainText(/Refresh models or choose another model/);
  await editor.getByRole('textbox', { name: 'Queued message text' }).fill('Still my draft');
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('setting an instance default from a queue picker leaves the queued edit unchanged', async ({ page }) => {
  await setup(page);
  await capture(page);
  await page.getByRole('button', { name: 'Queued message model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('DeepSeek V4.1 Flash');
  const row = picker.locator('[data-model-key]').first();
  await row.hover();
  const details = picker.getByRole('region', { name: 'Model details', exact: true });
  await expect(details).toContainText('DeepSeek V4.1 Flash');
  await expect(row.getByRole('button', { name: 'Set this model as the instance default', exact: true })).toHaveCount(0);
  await details.getByRole('button', { name: 'Set this model as the instance default', exact: true }).click();
  await expect(details.getByText('Instance Default', { exact: true })).toBeVisible();
  await expect(row.getByText('Instance Default', { exact: true })).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:hearth']?.model)).toMatchObject({ providerID: 'faux-hearth', modelID: 'deepseek-v4.1-flash' });
  expect(await calls(page)).toEqual([]);
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
