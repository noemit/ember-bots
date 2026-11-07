import { expect, test } from '@playwright/test';

const startDraft = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'New agent project' }).click();
};

test('choose an existing workspace, search projects, and remember the workspace', async ({ page }) => {
  await startDraft(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('where your projects or work already live');
  await expect(dialog.getByRole('button', { name: 'Use this workspace' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Enter a folder path' }).click();
  await dialog.getByRole('textbox', { name: 'Folder path' }).fill('/Users/alex/Work');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use this workspace' }).click();
  await expect(dialog).toContainText('Choose a project');
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults['pi:hearth']?.workspaceDirectory))).toBe('/Users/alex/Work');
  await dialog.getByRole('combobox', { name: 'Filter projects' }).fill('Website');
  await dialog.getByRole('option', { name: /Website/ }).click();
  await expect(page.getByRole('button', { name: 'New agent project' })).toHaveText('Website');
  await expect(page.getByRole('textbox', { name: 'New agent folder' })).toHaveCount(0);
  await page.locator('textarea').first().fill('inspect this project');
  await page.locator('textarea').first().press('Enter');
  await expect(page.locator('main[data-session-key]')).toHaveCount(1);
  await expect(page.locator('main[data-session-key]').getByTitle('/Users/alex/Work/Website')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'New agent', exact: true }).first().click();
  await page.getByRole('button', { name: 'New agent project' }).click();
  await expect(dialog).toContainText('Choose a project');
  await expect(dialog).toContainText('Workspace · Work');
});

test('empty folders remain selectable, and an unreadable path offers recovery', async ({ page }) => {
  await startDraft(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option', { name: 'habit', exact: true }).click();
  await dialog.getByRole('option', { name: 'docs', exact: true }).click();
  await expect(dialog).toContainText('No subfolders');
  await dialog.getByRole('button', { name: 'Use this workspace' }).click();
  await dialog.getByRole('button', { name: 'Choose another folder' }).click();
  await dialog.getByRole('button', { name: 'Enter a folder path' }).click();
  await dialog.getByRole('textbox', { name: 'Folder path' }).fill('/missing');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('ember-harness (mock)');
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Up one level' }).click();
  await expect(dialog.getByRole('option', { name: 'Users', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to projects' }).click();
  await dialog.getByRole('button', { name: 'Work in docs' }).click();
  await expect(page.getByRole('button', { name: 'New agent project' })).toHaveText('docs');
});

test('setup requires an explicit workspace choice and preserves the model default', async ({ page }) => {
  await page.goto('/?fixture=onboarding');
  const guide = page.getByTestId('onboarding');
  await expect(guide).toBeVisible();
  await page.evaluate(() => window.ember.setSettings({ instanceDefaults: { 'pi:local': { model: { providerID: 'openai', modelID: 'gpt-5' } } } }));
  // Refresh settings from the bridge so setup uses the same saved choices as the app.
  await page.reload();
  await guide.getByRole('button', { name: /First agent/ }).click();
  await expect(guide.getByRole('button', { name: 'New agent', exact: true })).toBeDisabled();
  await guide.getByRole('button', { name: 'Choose workspace' }).click();
  const picker = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Choose your workspace' }) });
  await picker.getByRole('button', { name: 'Use this workspace' }).click();
  await expect(guide.getByRole('button', { name: 'New agent', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults['pi:local']?.model?.modelID))).toBe('gpt-5');
  await page.screenshot({ path: '/tmp/ember-workspace-setup.png' });
  await guide.getByRole('button', { name: 'New agent', exact: true }).click();
  await expect(guide).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New agent project' })).toHaveText('workspace');
});

test('project selection works from the keyboard and keeps recent projects visible', async ({ page }) => {
  await startDraft(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Use this workspace' }).click();
  await expect(dialog).toContainText('Recent');
  await page.screenshot({ path: '/tmp/ember-project-picker.png' });
  const search = dialog.getByRole('combobox', { name: 'Filter projects' });
  await search.fill('channels');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New agent project' })).toHaveText('channels');
});

test('Settings uses the same workspace and project choices', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Instances', exact: true }).click();
  await page.getByRole('button', { name: 'Then copy from one' }).click();
  const defaults = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /mock\) defaults/ }) });
  await defaults.getByRole('button', { name: 'Choose workspace' }).click();
  await page.getByRole('button', { name: 'Use this workspace' }).click();
  await defaults.getByRole('button', { name: 'New agent project' }).click();
  await page.getByRole('option', { name: /channels/ }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults['pi:hearth']))).toMatchObject({
    workspaceDirectory: '/workspace', directory: '/workspace/channels',
  });
  await defaults.getByRole('button', { name: 'Use the most recent project instead' }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults['pi:hearth']?.directory))).toBeUndefined();
});

test('creating a folder can be cancelled, retried by name, and selected', async ({ page }) => {
  await startDraft(page);
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'New folder', exact: false }).click();
  await picker.getByRole('textbox', { name: 'New folder name' }).fill('Cancelled');
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker.getByRole('option', { name: 'Cancelled', exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: 'New folder', exact: false }).click();
  await picker.getByRole('textbox', { name: 'New folder name' }).fill('habit');
  await picker.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(picker.getByRole('alert')).toContainText('Try another name');
  await picker.getByRole('textbox', { name: 'New folder name' }).fill('New work');
  await picker.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(picker).toContainText('/workspace/New work');
  await picker.getByRole('button', { name: 'Use this workspace' }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults['pi:hearth']?.workspaceDirectory))).toBe('/workspace/New work');
});
