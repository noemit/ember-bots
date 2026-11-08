import { expect, test, type Page } from '@playwright/test';

/** Simulate old settings arriving from disk without changing the production mock defaults. */
async function legacySettings(page: Page, showAvatars: boolean, theme = 'stone') {
  await page.addInitScript(({ showAvatars, theme }) => {
    localStorage.setItem('ember-pi-read-state', JSON.stringify({ theme, conversationFontSize: 20 }));
    localStorage.setItem('avatar-regression-legacy-value', JSON.stringify(showAvatars));
    let bridge: typeof window.ember;
    Object.defineProperty(window, 'ember', {
      configurable: true,
      get: () => bridge,
      set: (value: typeof window.ember) => {
        const getSettings = value.getSettings.bind(value);
        const setSettings = value.setSettings.bind(value);
        value.getSettings = async () => ({ ...await getSettings(), showAvatars: JSON.parse(localStorage.getItem('avatar-regression-legacy-value')!) });
        value.setSettings = async (patch) => {
          if ('showAvatars' in patch) localStorage.setItem('avatar-regression-legacy-value', JSON.stringify(patch.showAvatars));
          return { ...await setSettings(patch), showAvatars: JSON.parse(localStorage.getItem('avatar-regression-legacy-value')!) };
        };
        bridge = value;
      },
    });
  }, { showAvatars, theme });
}

for (const showAvatars of [true, false]) {
  test(`legacy showAvatars=${showAvatars} never adds transcript avatars, including after Reset`, async ({ page }, testInfo) => {
    await legacySettings(page, showAvatars, showAvatars ? 'stone' : 'graphite');
    await page.goto('/?noDock');
    await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
    const regular = page.locator('main[data-session-key="pi:hearth::10"]');
    const log = regular.getByRole('log', { name: 'Conversation' });
    await expect(log).toContainText('step counter shows');
    await expect(log.locator('.blob')).toHaveCount(0);
    await expect(page.locator('aside .blob').first()).toBeVisible();
    await expect(page.locator('[data-composer-identity] .blob').first()).toBeVisible();
    expect((await page.evaluate(() => window.ember.getSettings())).showAvatars).toBe(showAvatars);

    await regular.getByRole('button', { name: 'View options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitemcheckbox', { name: /avatar/i })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Reset to defaults' }).click();
    await expect(log.locator('.blob')).toHaveCount(0);
    // Reset must not write the retired setting back into a legacy profile.
    expect((await page.evaluate(() => window.ember.getSettings())).showAvatars).toBe(showAvatars);
    await regular.getByRole('button', { name: 'View options' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /avatar/i })).toHaveCount(0);
    await page.getByRole('menuitemcheckbox', { name: 'List all tools' }).click();
    await page.keyboard.press('Escape');

    await regular.locator('textarea').fill('live tail of the log please');
    await regular.locator('textarea').press('Enter');
    await expect(log.locator('[data-live-tail]')).toBeVisible();
    await expect(log.locator('.blob')).toHaveCount(0);
    await expect(page.locator('[data-composer-identity] .blob').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`regular-live-${showAvatars ? 'light' : 'dark'}.png`) });
    await expect(log.locator('[data-live-tail]')).toHaveCount(0);
    await expect(log.locator('.blob')).toHaveCount(0);

    await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).first().click();
    const leader = page.locator('main[data-session-key="pi:hearth::16"]');
    const status = leader.locator('[data-session-status]');
    await expect(status).toHaveText('Waiting on 2 workers…');
    await expect(status).toHaveCSS('font-size', '12px');
    const prose = leader.locator('[role="article"][aria-label^="assistant"] p').first();
    await expect(prose).toHaveCSS('font-size', '20px');
    // The status dot shares the prose gutter, even at the largest conversation font size.
    const proseBox = await prose.boundingBox();
    const dotBox = await status.locator('[aria-hidden="true"]').boundingBox();
    expect(proseBox).not.toBeNull();
    expect(dotBox).not.toBeNull();
    expect(Math.abs(proseBox!.x - dotBox!.x)).toBeLessThanOrEqual(1);
    await expect(leader.getByRole('log').locator('.blob')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`waiting-workers-${showAvatars ? 'light' : 'dark'}.png`) });
    await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
    const thread = page.getByRole('dialog').locator('main[data-session-key="pi:hearth::17"]');
    const threadLog = thread.getByRole('log', { name: 'Conversation' });
    await expect(threadLog).toContainText('Parse the config and report back.');
    await expect(threadLog.locator('.blob')).toHaveCount(0);
    // This fixture is already running a tool: inspect it live, then settle via Stop.
    await expect(thread.getByRole('button', { name: 'Stop generating', exact: true })).toBeVisible();
    await expect(threadLog).toContainText('Parsing the config now');
    await expect(threadLog.locator('.blob')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`thread-live-${showAvatars ? 'light' : 'dark'}.png`) });
    await thread.getByRole('button', { name: 'Stop generating', exact: true }).click();
    await expect(thread.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0);
    await expect(threadLog.locator('.blob')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(threadLog).toBeVisible();
    await expect(threadLog.locator('.blob')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`thread-mobile-${showAvatars ? 'light' : 'dark'}.png`) });
  });
}
