import { expect, test, type Locator, type Page } from '@playwright/test';

const current = (page: Page) => page.locator('[data-active-chat="local::perf-0"]');
const capture = (page: Page) => page.evaluate(() => {
  const original = window.ember.request;
  sessionStorage.setItem('dock-mutations', '[]');
  window.ember.request = async (instance, method, path, body) => {
    if (method !== 'GET') {
      const requests = JSON.parse(sessionStorage.getItem('dock-mutations') ?? '[]');
      sessionStorage.setItem('dock-mutations', JSON.stringify([...requests, { instance, method, path, body }]));
    }
    return original(instance, method, path, body);
  };
});
const requests = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('dock-mutations') ?? '[]'));

async function checkActions(identity: Locator) {
  await identity.locator('[data-composer-identity-actions]').locator('..').hover();
  await expect(identity.locator('[data-composer-identity-actions]')).toHaveCSS('opacity', '1');
  const hide = identity.getByRole('button', { name: 'Hide session', exact: true });
  const create = identity.getByRole('button', { name: 'New bot in this folder', exact: true });
  await expect(hide).toBeVisible();
  await expect(hide.locator('svg.lucide-eye-off')).toHaveCount(1);
  await expect(create).toBeVisible();
  await hide.focus();
  await expect(hide).toBeFocused();
  // Focus, not just hover, must keep the actions available to keyboard users.
  await hide.page().mouse.move(10, 10);
  await expect(identity.locator('[data-composer-identity-actions]')).toHaveCSS('opacity', '1');
  await expect(hide).toBeVisible();
  await create.focus();
  await expect(create).toBeFocused();
  await expect(create).toBeVisible();
}

for (const mode of ['normal', 'wide', 'mini'] as const) {
  test(`${mode} current bot offers accessible hide and same-folder new bot actions`, async ({ page }) => {
    await page.goto('/?fixture=performance&noDock&legacy');
    await expect(current(page)).toBeVisible();
    if (mode !== 'normal') await page.getByRole('button', { name: 'Widen the session list', exact: true }).click();
    if (mode === 'mini') await page.getByRole('button', { name: 'Collapse the session list', exact: true }).click();
    await checkActions(current(page));
    await page.screenshot({ path: `/tmp/ember-dock-actions-${mode}.png` });
    await capture(page);
    await current(page).getByRole('button', { name: 'New bot in this folder', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New bot project', exact: true })).toContainText(/habit/i);
    await expect(page.getByRole('combobox', { name: 'New bot instance', exact: true })).toContainText('MacBook');
    // Opening a draft must not create a conversation or send a message.
    expect(await requests(page)).toEqual([]);
  });
}

test('docked hide offers Undo and retains the current draft', async ({ page }) => {
  await page.goto('/?fixture=performance&noDock&legacy');
  const column = page.locator('main[data-session-key="local::perf-0"]');
  await column.locator('textarea').fill('Keep my dock draft');
  await capture(page);
  await current(page).hover();
  await current(page).getByRole('button', { name: 'Hide session', exact: true }).click();
  await expect(column).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(column.locator('textarea')).toHaveValue('Keep my dock draft');
  expect((await requests(page)).map((entry: { path: string }) => entry.path)).toEqual([
    '/api/openchamber/sessions/archive', '/api/openchamber/sessions/unarchive',
  ]);
});

test('busy dock hide defaults to keeping the bot and confirms without a stop request', async ({ page }) => {
  await page.goto('/?fixture=performance&noDock&busy&legacy');
  await expect(page.getByRole('textbox', { name: 'Queue a follow-up message' }).first()).toBeVisible();
  await capture(page);
  await current(page).hover();
  await current(page).getByRole('button', { name: 'Hide session', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Hide active session?' });
  await expect(dialog.getByRole('button', { name: 'Keep session', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep session', exact: true }).click();
  await expect(current(page)).toBeVisible();
  expect(await requests(page)).toEqual([]);
  await current(page).hover();
  await current(page).getByRole('button', { name: 'Hide session', exact: true }).click();
  await dialog.getByRole('button', { name: 'Hide anyway', exact: true }).click();
  await expect(page.locator('main[data-session-key="local::perf-0"]')).toHaveCount(0);
  expect(await requests(page)).toEqual([{ instance: 'local', method: 'POST', path: '/api/openchamber/sessions/archive', body: { ids: ['perf-0'] } }]);
});

test('mobile current composer retains accessible actions without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/?fixture=performance&noDock&legacy');
  const identity = page.locator('main[data-session-key="local::perf-0"] [data-composer-identity]');
  await expect(page.locator('[data-active-chat]')).toHaveCount(0);
  await checkActions(identity);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: '/tmp/ember-dock-actions-mobile.png' });
});

test('an unconnected split-column identity offers actions for its own bot', async ({ page }) => {
  await page.goto('/?fixture=performance&noDock&legacy');
  const column = page.locator('main[data-session-key="local::perf-1"]');
  const identity = column.locator('[data-composer-identity]');
  await expect(identity).toContainText('Performance session 1');
  await identity.hover();
  const hide = identity.getByRole('button', { name: 'Hide session', exact: true });
  await expect(hide.locator('svg.lucide-eye-off')).toHaveCount(1);
  await expect(identity.getByRole('button', { name: 'New bot in this folder', exact: true })).toBeVisible();
  await capture(page);
  // Pointer-down can activate this column and hand its identity to the dock; the action
  // must still hide this bot once rather than merely handing focus over.
  await hide.click();
  await expect(column).toHaveCount(0);
  expect(await requests(page)).toEqual([{ instance: 'local', method: 'POST', path: '/api/openchamber/sessions/archive', body: { ids: ['perf-1'] } }]);
});
