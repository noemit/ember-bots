import { expect, test, type Page } from '@playwright/test';

const key = 'pi:hearth::10';
const column = (page: Page) => page.locator(`main[data-session-key="${key}"]`);
const marks = (page: Page) => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
const savedMutes = (page: Page) => page.evaluate(() => window.ember.getSettings().then(s => s.mutedSessions));

async function toggle(page: Page, muted: boolean) {
  await column(page).getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('menuitem', { name: muted ? /New messages: Don't notify/ : /New messages: Notify/ }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => savedMutes(page)).toEqual(expect.arrayContaining(muted ? [key] : []));
  if (!muted) await expect.poll(() => savedMutes(page)).not.toContain(key);
}

for (const mode of ['normal', 'wide', 'mini', 'mobile'] as const) {
  test(`the 41st mute survives updates and reload without reading in ${mode}`, async ({ page }) => {
    // Retained hidden/offline sessions count too. The old generic parser silently kept only forty.
    await page.addInitScript(() => {
      if (localStorage.getItem('ember-pi-read-state')) return;
      localStorage.setItem('ember-pi-read-state', JSON.stringify({ mutedSessions: Array.from({ length: 40 }, (_, i) => `offline::${i}`) }));
    });
    await page.goto('/?noDock');
    await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
    if (mode === 'wide' || mode === 'mini') await page.getByRole('button', { name: 'Widen the session list', exact: true }).click();
    if (mode === 'mini') await page.getByRole('button', { name: 'Collapse the session list', exact: true }).click();
    if (mode === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    const before = await marks(page);
    await expect(page.locator('[data-composer-identity] [data-badge="unread"]')).toHaveCount(1);
    await toggle(page, true);
    await expect.poll(() => savedMutes(page)).toHaveLength(41);
    await expect(page.locator('[data-composer-identity] [data-badge="unread"]')).toHaveCount(0);
    await expect(column(page).getByRole('button', { name: /New unread messages/ })).toBeVisible();
    // A completed reply and its list invalidation must not re-enable the indicator.
    await page.evaluate(async () => {
      const path = '/src/dev/mockPi.ts';
      const { mockInternals } = await import(/* @vite-ignore */ path);
      const conversation = mockInternals.conversations.find((entry: { id: number }) => entry.id === 10);
      const entry = structuredClone(conversation.entries.find((entry: { kind: string }) => entry.kind === 'pi.assistant'));
      entry.id = 10000;
      entry.model[0].content = [{ type: 'text', text: 'A fresh reply while notifications are muted.' }];
      entry.model[0].timestamp = Date.now();
      conversation.entries.push(entry);
      await window.ember.piRequest!('pi:hearth', '/conversations/10', { method: 'PATCH', body: { title: conversation.title } });
    });
    await expect(column(page).getByText('A fresh reply while notifications are muted.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-composer-identity] [data-badge="unread"]')).toHaveCount(0);
    expect(await marks(page)).toEqual(before);
    await page.reload();
    if (mode === 'mobile') await page.getByRole('button', { name: 'Toggle sessions sidebar', exact: true }).click();
    await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
    await expect(column(page)).toBeVisible();
    await expect.poll(() => savedMutes(page)).toHaveLength(41);
    await expect(page.locator('[data-composer-identity] [data-badge="unread"]')).toHaveCount(0);
    expect(await marks(page)).toEqual(before);
    await toggle(page, false);
    await expect(page.locator('[data-composer-identity] [data-badge="unread"]')).toHaveCount(1);
    expect(await marks(page)).toEqual(before);
    await page.screenshot({ path: `/tmp/ember-mute-${mode}.png` });
  });
}

test('snoozed mute hides only its unread indicator, not pending human decisions', async ({ page }) => {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const before = await marks(page);
  await toggle(page, true);
  await column(page).getByRole('button', { name: 'Snooze session', exact: true }).click();
  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).click();
  const snoozed = page.getByRole('region', { name: 'Snoozed sessions' });
  await expect(snoozed.getByRole('button', { name: /^Snoozed 1/ })).not.toHaveAccessibleName(/unread messages/);
  await snoozed.getByRole('button', { name: /^Snoozed 1/ }).click();
  await expect(snoozed.locator('[data-badge="unread"]')).toHaveCount(0);
  // A muted approval remains actionable; muting cannot stand in for allowing a command.
  await page.evaluate(async () => {
    const settings = await window.ember.getSettings();
    await window.ember.setSettings({ mutedSessions: [...settings.mutedSessions!, 'pi:hearth::12', 'pi:hearth::16'] });
  });
  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Wire the pi mock/ }).click();
  await expect(page.locator('main[data-session-key="pi:hearth::12"]').getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  await expect(page.locator('main[data-session-key="pi:hearth::16"]').getByTestId('thread-question').first()).toBeVisible();
  expect(await marks(page)).toEqual(before);
});

test('a mute/unmute during queued preference writes never acknowledges output or restores stale mute state', async ({ page }) => {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const before = await marks(page);
  await page.evaluate(() => {
    const save = window.ember.setSettings.bind(window.ember);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const completions: boolean[] = [];
    Object.assign(window, { releaseMuteSave: release, muteSaveCompletions: completions });
    let first = true;
    window.ember.setSettings = async patch => {
      if (patch.mutedSessions && first) { first = false; await gate; }
      const stored = await save(patch);
      if (patch.mutedSessions) completions.push(patch.mutedSessions.includes('pi:hearth::10'));
      return stored;
    };
  });
  await column(page).getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('menuitem', { name: /New messages: Don't notify/ }).click();
  await expect(page.getByRole('menuitem', { name: /New messages: Notify/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /New messages: Notify/ }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as Window & { releaseMuteSave: () => void }).releaseMuteSave());
  await expect.poll(() => page.evaluate(() => (window as Window & { muteSaveCompletions: boolean[] }).muteSaveCompletions)).toEqual([true, false]);
  await expect.poll(() => savedMutes(page)).toEqual([]);
  await expect(page.locator('[data-composer-identity] [data-badge="unread"]')).toHaveCount(1);
  expect(await marks(page)).toEqual(before);
});

test('a muted scheduled run stays muted through Hide and Undo without clearing its unread replies', async ({ page }) => {
  await page.goto('/?noDock');
  await expect(page.getByTestId('scheduled-count')).toHaveText('1');
  await page.locator('aside').getByRole('button', { name: /Remote access hardening/ }).click();
  const run = page.locator('main[data-session-key="pi:hearth::11"]');
  const before = await marks(page);
  await run.getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('menuitem', { name: /New messages: Don't notify/ }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => savedMutes(page)).toContain('pi:hearth::11');
  await expect(page.getByTestId('scheduled-count')).toHaveCount(0);
  await expect(run.getByRole('button', { name: /New unread messages/ })).toBeVisible();
  await run.getByRole('button', { name: 'Hide session', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => savedMutes(page)).toContain('pi:hearth::11');
  await expect(page.getByTestId('scheduled-count')).toHaveCount(0);
  expect(await marks(page)).toEqual(before);
});
