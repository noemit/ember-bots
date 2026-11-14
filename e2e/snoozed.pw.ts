import { expect as baseExpect, test, type Page } from '@playwright/test';

// Startup can share this host with several isolated browser/check runs.
const expect = baseExpect.configure({ timeout: 30_000 });
test.setTimeout(120_000);
test.use({ actionTimeout: 30_000 });

const chat = (page: Page) => page.locator('main[data-session-key="pi:hearth::10"]');
const shelf = (page: Page) => page.getByRole('region', { name: 'Snoozed sessions' });
const stored = (page: Page) => page.evaluate(() => window.ember.getSettings());

async function openHabit(page: Page) {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(chat(page)).toBeVisible();
}

test('snooze persists without reading, muting, stopping or losing the selected dock and draft', async ({ page }) => {
  await openHabit(page);
  const before = await stored(page);
  await chat(page).getByRole('textbox', { name: 'Message your bot', exact: true }).fill('A draft kept while snoozed');
  await chat(page).getByRole('button', { name: 'Snooze session', exact: true }).click();
  const toggle = shelf(page).getByRole('button', { name: /^Snoozed 1/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAccessibleName(/unread/);
  await expect(chat(page).getByRole('button', { name: 'Unsnooze session', exact: true })).toBeVisible();
  await expect(page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ })).toHaveCount(1);
  const after = await stored(page);
  expect(after.snoozedSessions).toContain('pi:hearth::10');
  expect(after.readMarks).toEqual(before.readMarks);
  expect(after.mutedSessions).toEqual(before.mutedSessions);
  await expect(chat(page).getByRole('textbox', { name: 'Message your bot', exact: true })).toHaveValue('A draft kept while snoozed');
  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).click();
  await shelf(page).getByRole('button', { name: /^Snoozed 1/ }).click();
  await shelf(page).getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(chat(page).getByRole('textbox', { name: 'Message your bot', exact: true })).toHaveValue('A draft kept while snoozed');
  await page.reload();
  await expect(shelf(page).getByRole('button', { name: /^Snoozed 1/ })).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(chat(page)).toBeVisible();
  expect((await stored(page)).snoozedSessions).toContain('pi:hearth::10');
});

test('search finds a snoozed title once without unsnoozing on open', async ({ page }) => {
  await openHabit(page);
  await chat(page).getByRole('button', { name: 'Snooze session', exact: true }).click();
  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).click();
  await page.getByPlaceholder('Search sessions…').fill('Habit onboarding');
  await expect(page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ })).toHaveCount(1);
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(chat(page).getByRole('button', { name: 'Unsnooze session', exact: true })).toBeVisible();
  expect((await stored(page)).snoozedSessions).toContain('pi:hearth::10');
  await chat(page).getByRole('button', { name: 'Unsnooze session', exact: true }).click();
  expect((await stored(page)).snoozedSessions).not.toContain('pi:hearth::10');
});

test('Undo and Hide restoration retain independent snooze and read preferences', async ({ page }) => {
  await openHabit(page);
  await chat(page).getByRole('button', { name: 'Snooze session', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await stored(page)).snoozedSessions).not.toContain('pi:hearth::10');
  await chat(page).getByRole('button', { name: 'Snooze session', exact: true }).click();
  const before = await stored(page);
  await chat(page).getByRole('button', { name: 'Hide session', exact: true }).click();
  await expect(chat(page)).toHaveCount(0);
  expect((await stored(page)).snoozedSessions).toContain('pi:hearth::10');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(chat(page)).toBeVisible();
  await expect(chat(page).getByRole('button', { name: 'Unsnooze session', exact: true })).toBeVisible();
  expect((await stored(page)).readMarks).toEqual(before.readMarks);
});

for (const mode of ['normal', 'wide', 'mini', 'mobile'] as const) {
  test(`collapsed attention and individual snoozed session remain reachable in ${mode}`, async ({ page }) => {
    await openHabit(page);
    // Snooze a question session while keeping the current selected dock in view.
    await page.evaluate(async () => {
      const settings = await window.ember.getSettings();
      await window.ember.setSettings({ snoozedSessions: ['pi:hearth::13'], readMarks: settings.readMarks });
    });
    await page.reload();
    if (mode === 'wide') await page.getByRole('button', { name: 'Widen the session list', exact: true }).click();
    if (mode === 'mini') {
      await page.getByRole('button', { name: 'Widen the session list', exact: true }).click();
      await page.getByRole('button', { name: 'Collapse the session list', exact: true }).click();
    }
    if (mode === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Toggle sessions sidebar', exact: true }).click();
    }
    const toggle = shelf(page).getByRole('button', { name: /^Snoozed 1/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName(/needs input/);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(shelf(page).getByRole('button', { name: /Dataset shortlist/ }).first()).toBeVisible();
    await page.screenshot({ path: `/tmp/ember-snoozed-${mode}.png` });
    await shelf(page).getByRole('button', { name: /Dataset shortlist/ }).first().click();
    await expect(page.locator('main[data-session-key="pi:hearth::13"]')).toBeVisible();
    expect((await stored(page)).snoozedSessions).toContain('pi:hearth::13');
  });
}
