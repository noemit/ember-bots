import { expect, test, type Page } from '@playwright/test';

const openUpdater = async (page: Page, phase: string, label: string) => {
  await page.goto(`/?noDock&updater=${phase}`);
  await page.getByRole('button', { name: label, exact: true }).click();
  return page.getByRole('dialog', { name: 'Ember updates', exact: true });
};

// Exercise the real mock bridge and renderer; no release servers or installers are contacted.
test('available update waits for an explicit download, then confirms the bundled Kiln restart', async ({ page }, testInfo) => {
  const dialog = await openUpdater(page, 'available', 'Update available');
  await expect(dialog).toContainText(/Ember.*available/);
  await expect(dialog.getByRole('button', { name: 'Download update', exact: true })).toBeEnabled();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('update-available.png') });

  await dialog.getByRole('button', { name: 'Download update', exact: true }).click();
  await expect(dialog.getByRole('progressbar', { name: 'Ember update download' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toBeVisible();
  await expect(dialog).toContainText(/only when you choose.*not when you quit/);
  await dialog.getByRole('button', { name: 'Restart and install', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Restart Ember and install?', exact: true });
  await expect(confirmation).toContainText(/bundled Kiln.*running chats and tasks/);
  await expect(confirmation).toContainText(/Standalone Kilns.*keep running/);
  await expect(confirmation).toContainText(/not send an abort/);
  await page.screenshot({ path: testInfo.outputPath('update-restart-confirmation.png') });
  await confirmation.getByRole('button', { name: 'Keep working', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toBeEnabled();
});

test('download progress is persistent and has an accessible numeric value', async ({ page }) => {
  const dialog = await openUpdater(page, 'downloading', 'Downloading update · 42%');
  await expect(dialog.getByRole('progressbar', { name: 'Ember update download' })).toHaveAttribute('aria-valuenow', '42');
  await expect(dialog.getByRole('button', { name: 'Downloading…', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Downloading update · 42%', exact: true })).toBeVisible();
});

test('initial error with a known version retries download before offering restart', async ({ page }) => {
  const dialog = await openUpdater(page, 'error', 'Update needs attention');
  await expect(dialog).toContainText(/Ember.*Retry.*Releases/);
  await expect(dialog.getByRole('button', { name: 'Open Releases', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toBeVisible();
});

for (const failure of ['returned', 'rejected'] as const) {
  test(`a ${failure} restart failure retries download, never another restart`, async ({ page }) => {
    const dialog = await openUpdater(page, 'downloaded', 'Update ready');
    await page.evaluate((failure) => {
      const original = window.ember.updateAction!;
      sessionStorage.setItem('update-actions', '[]');
      window.ember.updateAction = async (action) => {
        const actions = JSON.parse(sessionStorage.getItem('update-actions')!);
        sessionStorage.setItem('update-actions', JSON.stringify([...actions, action]));
        if (action === 'restart') {
          if (failure === 'rejected') throw new Error('Fixture restart failure');
          return { ...(await window.ember.getUpdateState!()), phase: 'error' };
        }
        return original(action);
      };
    }, failure);
    await dialog.getByRole('button', { name: 'Restart and install', exact: true }).click();
    await page.getByRole('dialog', { name: 'Restart Ember and install?', exact: true }).getByRole('button', { name: 'Restart and install', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog.getByRole('progressbar')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('update-actions')!))).toEqual(['restart', 'download']);
    await expect(page.getByRole('dialog', { name: 'Restart Ember and install?', exact: true })).toHaveCount(0);
  });
}

test('error without a known version retries checking rather than downloading', async ({ page }) => {
  await page.addInitScript(() => {
    let bridge: typeof window.ember;
    Object.defineProperty(window, 'ember', { configurable: true, get: () => bridge, set: (value: typeof window.ember) => {
      bridge = { ...value, getUpdateState: async () => ({ phase: 'error', currentVersion: '1.22.0', supported: true }) };
    } });
  });
  const dialog = await openUpdater(page, 'error', 'Update needs attention');
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Download update', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart and install', exact: true })).toHaveCount(0);
});

for (const phase of ['unsupported', 'disabled']) {
  test(`${phase} desktop offers manual releases without installation controls`, async ({ page }) => {
    const dialog = await openUpdater(page, phase, 'Check for updates');
    await expect(dialog).toContainText(phase === 'unsupported' ? /Ember.*platform.*manually/ : /development.*Canary/);
    await expect(dialog.getByRole('button', { name: 'Open Releases', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Check for updates|Download update|Restart and install|Retry/ })).toHaveCount(0);
  });
}

for (const remote of [false, true]) {
  test(`${remote ? 'remote bridge without capability' : 'normal browser fixture'} never discovers desktop updates`, async ({ page }) => {
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', request => { if (/api\.github\.com/.test(request.url())) requests.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    if (remote) {
      await page.addInitScript(() => {
        let bridge: typeof window.ember;
        Object.defineProperty(window, 'ember', { configurable: true, get: () => bridge, set: (value: typeof window.ember) => {
          const forbidden = async (): Promise<never> => { throw new Error('Remote bridge must not invoke desktop updates'); };
          bridge = { ...value, capabilities: { ...value.capabilities!, desktopUpdates: false }, getUpdateState: forbidden, updateAction: forbidden };
        } });
      });
    }
    await page.goto(remote ? '/?noDock&updater=available' : '/?noDock');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Check for updates|Update available|Update ready|Downloading update|Update needs attention/ })).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
