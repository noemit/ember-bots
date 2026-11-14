import { expect, test, type Page } from '@playwright/test';

const picker = (page: Page) => page.getByRole('dialog', { name: 'Find a project' });
const project = (page: Page) => page.getByRole('button', { name: 'New bot project', exact: true });
const search = (page: Page) => picker(page).getByRole('searchbox');
const openFolder = (page: Page, path: string) => picker(page).getByRole('button', { name: 'Open folder ' + path, exact: true });
const startDraft = async (page: Page, fixture = 'project-picker') => {
  await page.goto('/?fixture=' + fixture);
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await project(page).click();
  await expect(picker(page).getByRole('heading', { name: 'Find a project' })).toBeVisible();
};

// Screenshots are review evidence,
// not pixel snapshots, so platform font differences do not turn behaviour checks into noise.
test('global known projects have independent Frequent and Recent lists and disambiguated paths', async ({ page }) => {
  await startDraft(page);
  const frequent = picker(page).getByRole('region', { name: 'Frequent projects', exact: true });
  const recent = picker(page).getByRole('region', { name: 'Recent projects', exact: true });
  await expect(frequent.getByRole('button', { name: /^Open folder / })).toHaveCount(5);
  await expect(recent.getByRole('button', { name: /^Open folder / })).toHaveCount(5);
  await expect(frequent.getByRole('button', { name: /^Open folder / }).first()).toHaveAccessibleName('Open folder /workspace/atlas');
  await expect(recent.getByRole('button', { name: /^Open folder / }).first()).toHaveAccessibleName('Open folder /workspace/beacon');
  await expect(picker(page)).not.toContainText(/favorites/i);
  await picker(page).getByRole('button', { name: 'Show more frequent projects', exact: true }).click();
  await expect(frequent.getByRole('button', { name: /^Open folder / })).toHaveCount(12);
  await expect(recent.getByRole('button', { name: /^Open folder / })).toHaveCount(5);
  await picker(page).getByRole('button', { name: 'Show more recent projects', exact: true }).click();
  await picker(page).getByRole('button', { name: 'Show less frequent projects', exact: true }).click();
  await expect(frequent.getByRole('button', { name: /^Open folder / })).toHaveCount(5);
  await expect(recent.getByRole('button', { name: /^Open folder / })).toHaveCount(12);
  await expect(frequent).not.toContainText('unknown-start');
  await expect(recent).not.toContainText('unknown-start');
  await picker(page).getByRole('button', { name: 'Show less recent projects', exact: true }).click();
  await picker(page).evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/ember-find-anything-desktop.png' });
  await search(page).fill('atlas');
  await expect(picker(page).getByRole('button', { name: /^Open folder / })).toHaveCount(4);
  for (const path of ['/workspace/atlas', '/Volumes/Studio/atlas', '/Users/alex/Experiments/atlas', '/Volumes/Backup/atlas']) await expect(openFolder(page, path)).toBeVisible();
  await search(page).fill('unknown-start');
  await expect(openFolder(page, '/workspace/unknown-start')).toBeVisible();
  await search(page).fill('worker-only');
  await expect(picker(page).getByRole('button', { name: /^Open folder / })).toHaveCount(0);
  await search(page).fill('hidden-only');
  await expect(picker(page).getByRole('button', { name: /^Open folder / })).toHaveCount(0);
});

test('keyboard opens a global project without selecting; Choose this folder preserves the draft', async ({ page }) => {
  await startDraft(page);
  await picker(page).press('Escape');
  const composer = page.locator('textarea').first();
  await page.getByRole('button', { name: 'Choose model', exact: true }).click();
  const modelPicker = page.getByRole('dialog', { name: 'Choose a model' });
  await modelPicker.getByRole('searchbox', { name: 'Search models' }).fill('DeepSeek');
  await modelPicker.getByRole('button', { name: 'DeepSeek V4.1 Flash', exact: true }).click();
  await modelPicker.getByRole('button', { name: 'Done', exact: true }).click();
  const chosenModel = await page.getByRole('button', { name: 'Choose model', exact: true }).innerText();
  await composer.fill('Keep this unsent message');
  const previous = await project(page).innerText();
  await project(page).click();
  await search(page).fill('/Volumes/Studio/atlas');
  await search(page).press('Tab');
  await expect(openFolder(page, '/Volumes/Studio/atlas')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker(page).getByRole('heading', { name: 'Browse folders' })).toBeVisible();
  await expect(project(page)).toHaveText(previous);
  await expect(composer).toHaveValue('Keep this unsent message');
  await expect(picker(page).getByRole('textbox')).toHaveCount(0);
  await picker(page).getByRole('button', { name: 'Choose this folder', exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(project(page)).toHaveText('atlas');
  await expect(composer).toHaveValue('Keep this unsent message');
  await expect(composer).toBeFocused();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toHaveText(chosenModel);
});

test('browse breadcrumbs reach the computer root; navigation and Escape never select', async ({ page }) => {
  await startDraft(page);
  const previous = await project(page).innerText();
  await picker(page).getByRole('button', { name: 'Browse folders on this host' }).click();
  await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeEnabled();
  await picker(page).getByRole('navigation', { name: 'Folder breadcrumbs' }).getByRole('button', { name: 'Computer /', exact: true }).click();
  await expect(picker(page).getByRole('heading', { name: 'Computer · filesystem root' })).toBeVisible();
  await expect(picker(page).getByRole('button', { name: 'Up one folder' })).toBeDisabled();
  await picker(page).getByRole('button', { name: 'Computer /', exact: true }).click();
  await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeEnabled();
  await page.screenshot({ path: '/tmp/ember-find-anything-desktop-browse.png' });
  await openFolder(page, '/Users').click();
  await picker(page).getByRole('heading', { name: 'Users', exact: true }).press('Alt+ArrowLeft');
  await expect(picker(page).getByRole('heading', { name: 'Computer · filesystem root' })).toBeVisible();
  await expect(project(page)).toHaveText(previous);
  await picker(page).press('Escape');
  await expect(search(page)).toBeVisible();
  await picker(page).press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(project(page)).toHaveText(previous);
});

test('path and creation are revealed on demand; invalid, duplicate and missing parents cannot create', async ({ page }) => {
  await startDraft(page);
  await picker(page).getByRole('button', { name: 'Browse folders on this host' }).click();
  await expect(picker(page).getByRole('textbox')).toHaveCount(0);
  await picker(page).getByRole('button', { name: 'Enter a path…', exact: true }).click();
  await picker(page).getByRole('textbox', { name: 'Existing folder path' }).fill('/workspace');
  await picker(page).getByRole('button', { name: 'Open path', exact: true }).click();
  await expect(openFolder(page, '/workspace/habit')).toBeVisible();
  await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeEnabled();
  await picker(page).getByRole('navigation', { name: 'Folder breadcrumbs' }).getByRole('button', { name: 'workspace', exact: true }).click();
  await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeEnabled();
  await picker(page).getByRole('button', { name: 'New folder…', exact: true }).click();
  const name = picker(page).getByRole('textbox', { name: 'New folder name' });
  const create = picker(page).getByRole('button', { name: 'Create folder', exact: true });
  for (const invalid of ['..', '.', 'missing/child', 'missing\\child', 'habit']) {
    await name.fill(invalid);
    await expect(create).toBeDisabled();
    await expect(picker(page).getByRole('alert')).toBeVisible();
  }
  await name.fill('Cancelled');
  await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker(page).getByRole('button', { name: 'New folder…', exact: true })).toBeFocused();
  await expect(openFolder(page, '/workspace/Cancelled')).toHaveCount(0);
  await picker(page).getByRole('button', { name: 'Enter a path…', exact: true }).click();
  await picker(page).getByRole('textbox', { name: 'Existing folder path' }).press('Escape');
  await expect(picker(page).getByRole('button', { name: 'Enter a path…', exact: true })).toBeFocused();
  await picker(page).getByRole('button', { name: 'New folder…', exact: true }).click();
  await picker(page).getByRole('textbox', { name: 'New folder name' }).fill('New work');
  await create.click();
  await expect(picker(page).getByRole('heading', { name: 'New work', exact: true })).toBeVisible();
  await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeEnabled();
  await picker(page).getByRole('button', { name: 'Enter a path…', exact: true }).click();
  await picker(page).getByRole('textbox', { name: 'Existing folder path' }).fill('/missing/parent');
  await picker(page).getByRole('button', { name: 'Open path', exact: true }).click();
  await expect(picker(page).getByRole('alert')).toContainText('ember-harness (mock)');
  await expect(picker(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeDisabled();
  await expect(picker(page).getByRole('button', { name: 'New folder…', exact: true })).toHaveCount(0);
});

test('mobile search and browse fit the viewport with an explicit choice', async ({ page }) => {
  await startDraft(page);
  await picker(page).press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await project(page).click();
  await picker(page).evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/ember-find-anything-mobile-search.png' });
  await search(page).fill('/Users/alex/Experiments/atlas');
  await openFolder(page, '/Users/alex/Experiments/atlas').click();
  const choose = picker(page).getByRole('button', { name: 'Choose this folder' });
  await choose.scrollIntoViewIfNeeded();
  await expect(choose).toBeVisible();
  const bounds = await picker(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/ember-find-anything-mobile-browse.png' });
  await choose.click();
  await expect(project(page)).toHaveText('atlas');
});

test('setup workspace choice is explicit and keeps the selected model default', async ({ page }) => {
  await page.goto('/?fixture=onboarding');
  const guide = page.getByTestId('onboarding');
  await guide.getByRole('button', { name: /Choose an AI/ }).click();
  const select = guide.getByLabel('Default model for');
  await expect.poll(() => select.locator('option').count()).toBeGreaterThan(1);
  const modelKey = (await select.locator('option').nth(1).getAttribute('value'))!;
  await select.selectOption(modelKey);
  await guide.getByRole('button', { name: /First bot/ }).click();
  await expect(guide.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await guide.getByRole('button', { name: 'Choose workspace' }).click();
  const workspace = page.getByRole('dialog', { name: 'Choose your workspace' });
  await expect(workspace.getByRole('button', { name: 'Choose this workspace' })).toBeEnabled();
  await workspace.getByRole('button', { name: 'Choose this workspace' }).click();
  await expect(guide.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local'])).toMatchObject({
    model: { providerID: modelKey.split('/')[0], modelID: modelKey.slice(modelKey.indexOf('/') + 1) }, workspaceDirectory: '/workspace',
  });
});

test('Settings shares search-first global project selection without changing the model default', async ({ page }) => {
  await page.goto('/?fixture=project-picker');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Instances', exact: true }).click();
  await page.getByRole('button', { name: 'Then copy from one' }).click();
  const defaults = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /mock\) defaults/ }) });
  const originalModel = await page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:hearth']?.model);
  await defaults.getByRole('button', { name: 'Choose workspace' }).click();
  await page.getByRole('button', { name: 'Choose this workspace' }).click();
  await defaults.getByRole('button', { name: 'New bot project' }).click();
  await search(page).fill('/Volumes/Studio/atlas');
  await openFolder(page, '/Volumes/Studio/atlas').click();
  await picker(page).getByRole('button', { name: 'Choose this folder' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:hearth'])).toMatchObject({ workspaceDirectory: '/workspace', directory: '/Volumes/Studio/atlas' });
  expect(await page.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:hearth']?.model)).toEqual(originalModel);
});

for (const delayed of ['listing', 'creation'] as const) {
  test('late ' + delayed + ' from the old host cannot replace the new host folder', async ({ page }) => {
    await page.goto('/?fixture=project-picker&pickerHosts');
    await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'ember-harness (mock)', exact: true }).click();
    await page.evaluate((kind) => {
      const state = window as unknown as { releasePickerRequest?: () => void; pickerRequestHeld?: boolean; pickerRequestDone?: boolean };
      const original = window.ember.piRequest!.bind(window.ember);
      window.ember.piRequest = async (...args) => {
        if (args[0] === 'pi:hearth' && args[1].startsWith('/directories') && (args[2]?.method === 'POST') === (kind === 'creation')) {
          state.pickerRequestHeld = true;
          await new Promise<void>((resolve) => { state.releasePickerRequest = resolve; });
          const result = await original(...args);
          state.pickerRequestDone = true;
          return result;
        }
        return original(...args);
      };
    }, delayed);
    await project(page).click();
    await picker(page).getByRole('button', { name: 'Browse folders on this host' }).click();
    if (delayed === 'creation') {
      await picker(page).getByRole('button', { name: 'New folder…' }).click();
      await picker(page).getByRole('textbox', { name: 'New folder name' }).fill('Delayed old host folder');
      await picker(page).getByRole('button', { name: 'Create folder', exact: true }).click();
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { pickerRequestHeld?: boolean }).pickerRequestHeld)).toBe(true);
    await page.getByRole('combobox', { name: 'New bot instance' }).click();
    await page.getByRole('option', { name: 'Tower (mock)', exact: true }).click();
    await project(page).click();
    await expect(picker(page)).toContainText('Tower (mock)');
    await expect(picker(page)).not.toContainText('/Volumes/Studio/atlas');
    await picker(page).getByRole('button', { name: 'Browse folders on this host' }).click();
    await expect(picker(page).getByRole('heading', { name: 'srv', exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { releasePickerRequest?: () => void }).releasePickerRequest!());
    await expect.poll(() => page.evaluate(() => (window as unknown as { pickerRequestDone?: boolean }).pickerRequestDone)).toBe(true);
    await expect(picker(page).getByRole('heading', { name: 'srv', exact: true })).toBeVisible();
    await expect(picker(page)).not.toContainText('Delayed old host folder');
    await expect(picker(page).getByRole('button', { name: 'Choose this folder' })).toBeEnabled();
  });
}
