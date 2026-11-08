import { expect, test, type Page } from '@playwright/test';

const captureMutations = (page: Page) => page.evaluate(() => {
  const original = window.ember.request;
  window.ember.request = async (instance, method, path, body) => {
    if (method !== 'GET') {
      const entries = JSON.parse(sessionStorage.getItem('archive-test-requests') ?? '[]');
      sessionStorage.setItem('archive-test-requests', JSON.stringify([...entries, { instance, method, path, body }]));
    }
    return original(instance, method, path, body);
  };
});
const mutations = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('archive-test-requests') ?? '[]'));
const visibleMarkers = (page: Page) => page.locator('aside [data-visible-column="true"]');

test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture=performance&noDock&legacy');
  await expect(page.locator('textarea')).toHaveCount(2, { timeout: 15_000 });
});

test('column hide button hides once and Undo brings back the session and its draft', async ({ page }) => {
  await captureMutations(page);
  const column = page.locator('main').first();
  await column.locator('textarea').fill('Keep this draft through hiding');
  const archive = column.locator('header').getByRole('button', { name: 'Hide session', exact: true });
  await expect(archive).toHaveAttribute('aria-label', 'Hide session');
  await expect(archive.locator('svg.lucide-eye-off')).toHaveCount(1);
  await expect(column.locator('header svg.lucide-archive')).toHaveCount(0);
  await expect(column.getByRole('button', { name: 'Close session', exact: true })).toHaveCount(0);
  await archive.click();
  await expect(page.locator('textarea')).toHaveCount(1);
  await expect.poll(async () => (await mutations(page)).filter((entry: { path: string }) => entry.path === '/api/openchamber/sessions/archive').length).toBe(1);
  expect((await mutations(page))[0].method).toBe('POST');
  expect((await mutations(page))[0].body.ids).toEqual(['perf-0']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('textarea')).toHaveCount(2);
  await expect(page.locator('main[data-session-key="local::perf-0"] textarea')).toHaveValue('Keep this draft through hiding');
  await expect.poll(async () => (await mutations(page)).filter((entry: { path: string }) => entry.path === '/api/openchamber/sessions/unarchive').length).toBe(1);
});

test('hiding the session I am reading hands over to the next one, not Home', async ({ page }) => {
  // One column left: hide the inactive one first (this test's subject is the last one).
  const first = page.locator('main[data-session-key]').first();
  await expect(first.locator('header')).toHaveAttribute('data-active', 'true');
  const second = page.locator('main[data-session-key]').nth(1);
  const secondKey = await second.getAttribute('data-session-key');
  await second.locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();
  await expect(page.locator(`main[data-session-key="${secondKey}"]`)).toHaveCount(0);
  await expect(page.locator('main[data-session-key]')).toHaveCount(1);

  const onlyKey = await page.locator('main[data-session-key]').first().getAttribute('data-session-key');
  await page
    .locator('main[data-session-key]')
    .first()
    .locator('header')
    .getByRole('button', { name: 'Hide session', exact: true })
    .click();

  // "Next, please": another session takes the column, rather than Home taking the window.
  await expect(page.locator(`main[data-session-key="${onlyKey}"]`)).toHaveCount(0);
  await expect(page.getByTestId('home-view')).toHaveCount(0);
  const next = page.locator('main[data-session-key]').first();
  await expect(next).toBeVisible();
  await expect(next.locator('header')).toHaveAttribute('data-active', 'true');
  expect(await next.getAttribute('data-session-key')).not.toBe(onlyKey);
});

test('hiding a background column leaves the one I am reading alone', async ({ page }) => {
  const active = page.locator('main[data-session-key]').first();
  const activeKey = await active.getAttribute('data-session-key');
  const background = page.locator('main[data-session-key]').nth(1);
  const backgroundKey = await background.getAttribute('data-session-key');
  await background.locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();

  const still = page.locator(`main[data-session-key="${activeKey}"]`);
  await expect(still).toBeVisible();
  await expect(still.locator('header')).toHaveAttribute('data-active', 'true');
  await expect(page.locator(`main[data-session-key="${backgroundKey}"]`)).toHaveCount(0);
});

test('all visible columns have underlines regardless of focus; closed columns do not', async ({ page }) => {
  await expect(visibleMarkers(page)).toHaveCount(2);
  await expect(page.locator('main[data-session-key="local::perf-0"] header')).toHaveAttribute('data-active', 'true');
  await page.locator('main[data-session-key="local::perf-1"] textarea').click();
  await expect(page.locator('main[data-session-key="local::perf-1"] header')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('main header[data-active="true"]')).toHaveCount(1);
  await expect(visibleMarkers(page)).toHaveCount(2);
  for (const marker of await visibleMarkers(page).all()) {
    expect((await marker.getAttribute('class'))?.split(/\s+/)).not.toContain('ring-2');
    await expect(marker.locator('[data-column-underline]')).toBeVisible();
  }
  await page.locator('main').first().getByRole('button', { name: 'Close this column', exact: true }).click();
  await expect(visibleMarkers(page)).toHaveCount(1);
});

test('Hide on an inactive column hides on the first click, not just activate', async ({ page }) => {
  await captureMutations(page);
  const inactive = page.locator('main').nth(1);
  await expect(inactive.locator('header')).toHaveAttribute('data-active', 'false');
  await inactive.locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();
  await expect(page.locator('textarea')).toHaveCount(1);
  await expect.poll(async () => (await mutations(page)).filter((entry: { path: string }) => entry.path === '/api/openchamber/sessions/archive').length).toBe(1);
  expect((await mutations(page))[0].body.ids).toEqual(['perf-1']);
});

test('closing a column in split view removes its column underline without hiding', async ({ page }) => {
  await captureMutations(page);
  await page.locator('main').first().getByRole('button', { name: 'Close this column', exact: true }).click();
  await expect(visibleMarkers(page)).toHaveCount(1);
  expect(await mutations(page)).toEqual([]);
});

for (const status of ['busy', 'waiting']) {
  test(`${status} sessions require confirmation and hiding never sends abort`, async ({ page }) => {
    await page.goto(`/?fixture=performance&noDock&${status}&legacy`);
    await expect(page.locator('textarea')).toHaveCount(2);
    if (status === 'busy') await expect(page.getByRole('textbox', { name: 'Queue a follow-up message' }).first()).toBeVisible();
    else await expect(page.locator('main').first().getByText('Approval needed', { exact: true }).first()).toBeVisible();
    await captureMutations(page);
    await page.locator('main').first().locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Hide active session?' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(/Ember will not send a stop command/i);
    await expect(confirmation).toContainText(/Undo/);
    await expect(confirmation).not.toContainText(/archiv|restore/i);
    await page.screenshot({ path: `/tmp/ember-hide-${status}-confirmation.png` });
    await expect(confirmation.getByRole('button', { name: 'Keep session', exact: true })).toBeFocused();
    expect(await mutations(page)).toEqual([]);
    await confirmation.getByRole('button', { name: 'Keep session', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(2);
    expect(await mutations(page)).toEqual([]);
    await page.locator('main').first().locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    expect(await mutations(page)).toEqual([]);
    await page.locator('main').first().locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Hide anyway', exact: true }).click();
    await expect(page.locator('textarea')).toHaveCount(1);
    const sent = await mutations(page);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].path).toBe('/api/openchamber/sessions/archive');
    expect(sent[0].path).not.toContain('/interrupt');
  });
}

test('a failed hide keeps the column and offers a retry', async ({ page }) => {
  await page.evaluate(() => {
    const original = window.ember.request;
    let failed = false;
    window.ember.request = async (instance, method, path, body) => {
      if (!failed && method === 'POST' && path === '/api/openchamber/sessions/archive') {
        failed = true;
        return { ok: false, status: 503, data: null };
      }
      return original(instance, method, path, body);
    };
  });
  await page.locator('main').first().locator('header').getByRole('button', { name: 'Hide session', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/MacBook.*hide.*Retry/i);
  await expect(page.getByRole('alert')).not.toContainText(/archiv|restore|503|undefined/i);
  await expect(page.locator('textarea')).toHaveCount(2);
  await page.getByRole('button', { name: 'Retry failed action' }).click();
  await expect(page.locator('textarea')).toHaveCount(1);
});

test('the underline follows whichever blob is a column', async ({ page }) => {
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Performance session 2');
  await page.getByRole('option').filter({ hasText: 'Performance session 2' }).first().click();
  const swapped = page.locator('aside [data-session-key="local::perf-2"]');
  await expect(swapped).toHaveAttribute('data-visible-column', 'true');
  await expect(visibleMarkers(page)).toHaveCount(await page.locator('main[data-session-key]').count());
});

test('a day-old finished scheduled run hides itself', async ({ page }) => {
  await page.goto('/?noDock&legacy');
  // ses_a7 ("Daily channel brief · yesterday") is bound to a task and idle for a day.
  await expect(page.getByText(/Auto-hidden \d+ finished scheduled run/)).toBeVisible();
  // Home has no rail, so the proof is the list: the run is gone from it.
  await expect(
    page.locator('[data-testid="home-session-card"][data-session-key="local::ses_a7"]')
  ).toHaveCount(0);
});

test('one-session project rows use the same visible-column indicator', async ({ page }) => {
  await page.goto('/?noDock&legacy');
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Bot deploy');
  await page.getByRole('option').filter({ hasText: 'Bot deploy smoke test' }).first().click();
  const row = page.locator('aside [data-session-key="studio::ses_b2"]');
  await expect(row).toHaveAttribute('data-visible-column', 'true');
  await expect(row.locator('[data-column-underline]')).toBeVisible();
});

test('hidden sessions can be unhidden with Eye after hiding with EyeOff', async ({ page }) => {
  await captureMutations(page);
  const column = page.locator('main[data-session-key="local::perf-0"]');
  await column.locator('textarea').fill('Keep this draft while hidden');
  const hide = column.locator('header').getByRole('button', { name: 'Hide session', exact: true });
  await expect(hide.locator('svg.lucide-eye-off')).toHaveCount(1);
  await hide.click();
  await expect(column).toHaveCount(0);
  await expect(page.locator('aside [data-session-key="local::perf-0"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hidden sessions', exact: true }).click();
  const hidden = page.getByRole('dialog', { name: 'Hidden sessions', exact: true });
  const row = hidden.locator('div.group').filter({ has: page.locator('[data-session-key="local::perf-0"]') });
  await expect(row).toBeVisible();
  const unhide = row.getByRole('button', { name: 'Unhide session', exact: true });
  await expect(unhide.locator('svg.lucide-eye')).toHaveCount(1);
  await expect(unhide.locator('svg.lucide-eye-off')).toHaveCount(0);
  await expect(hidden).not.toContainText(/archiv|restore/i);
  await page.screenshot({ path: '/tmp/ember-hidden-sessions.png' });
  await unhide.click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await mutations(page)).filter((entry: { path: string }) => entry.path === '/api/openchamber/sessions/unarchive').length).toBe(1);
  const sent = await mutations(page);
  expect(sent.map((entry: { path: string }) => entry.path)).toEqual([
    '/api/openchamber/sessions/archive', '/api/openchamber/sessions/unarchive',
  ]);
  expect(sent[1].body.ids).toEqual(['perf-0']);
  await page.keyboard.press('Escape');
  // Unhide brings it back to the rail; opening it must retain its draft.
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Performance session 0');
  await page.getByRole('option').filter({ hasText: 'Performance session 0' }).first().click();
  await expect(column.locator('textarea')).toHaveValue('Keep this draft while hidden');
  await page.screenshot({ path: '/tmp/ember-unhidden-session.png' });
});
