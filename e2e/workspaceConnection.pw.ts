import { expect, test } from '@playwright/test';

const dock = '[data-active-chat]';
test('the active identity joins the composer, replies are unboxed, and chat drafts survive handovers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator(dock)).toContainText('Crew: auth refactor');
  const rail = page.getByTestId('session-rail');
  const names = await rail.locator('[data-selected] .font-medium').allTextContents();
  expect(names.indexOf('Remote access hardening')).toBeLessThan(names.indexOf('Habit onboarding QA'));
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(page.locator(dock)).toContainText('Habit onboarding QA');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.locator('[data-composer-identity]')).toHaveCount(0);
  const context = page.locator(`${dock} [data-composer-context]`);
  await expect(context).toContainText('habit');
  await expect(context).toContainText('ember-harness (mock)');

  const reply = column.locator('.conversation-prose').filter({ hasText: 'step counter shows' });
  await expect(reply).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(reply).toHaveCSS('font-size', '14px');
  const input = column.locator('textarea');
  await input.fill('A thought held for Habit');
  const assertAligned = async () => {
    const left = await page.locator(dock).boundingBox();
    const right = await page.locator('[data-connection-composer]').boundingBox();
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
    expect(Math.abs(left!.height - right!.height)).toBeLessThan(2);
  };
  await assertAligned();
  await input.fill('A thought held for Habit\n' + 'More to consider.\n'.repeat(7));
  await expect.poll(async () => (await page.locator(dock).boundingBox())!.height).toBeGreaterThan(170);
  await assertAligned();
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  await expect(page.locator(dock)).toContainText('Remote access hardening');
  await expect(context).toContainText('channels');
  await expect(context).not.toContainText('habit');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(column.locator('textarea')).toHaveValue(/A thought held for Habit/);
  // Interrupt another handover; the final selection must own both composer and identity.
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  await page.getByRole('button', { name: /Screenshot review/ }).first().click();
  await expect(page.locator(dock)).toContainText('Screenshot review');
  await expect(page.locator('[data-connection-composer]')).toHaveCount(1);
  await page.waitForTimeout(700);
  await assertAligned();
  await expect(page.getByText('You’re talking to', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/ember-connected-workspace.png' });
  expect(errors).toEqual([]);
});

test('conversation size persists and mobile retains its composer identity', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Conversation text size', { exact: true }).selectOption('18');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const reply = page.locator('main[data-session-key="pi:hearth::10"] .conversation-prose').filter({ hasText: 'step counter shows' });
  await expect(reply).toHaveCSS('font-size', '18px');
  await page.reload();
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(reply).toHaveCSS('font-size', '18px');
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(page.locator(dock)).toHaveCount(0);
  await expect(page.locator('main[data-session-key="pi:hearth::10"] [data-composer-identity]')).toContainText('Habit onboarding QA');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('split columns keep their own composers and reduced motion uses a still handover', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(dock)).toContainText('Crew: auth refactor');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await page.keyboard.press('Escape');
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  await expect(page.locator('main[data-session-key]')).toHaveCount(2);
  await expect(page.locator(dock)).toContainText('Parse config');
  await expect(page.locator('[data-connection-composer]')).toHaveCount(1);
  await expect(leader.locator('[data-composer-identity]')).toContainText('Crew: auth refactor');
  await page.screenshot({ path: '/tmp/ember-layout-split.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await expect(page.locator(dock)).toContainText('Crew: auth refactor');
  await expect(page.locator('[data-connection-trace]')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('[data-active-chat] [data-avatar-key]')).toHaveCSS('transform', 'none');
});

test('trays sit above the composer and do not enlarge its connected agent row', async ({ page }) => {
  await page.goto('/?threads');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const band = column.locator('[data-connection-composer]');
  const extras = column.locator('[data-composer-extras]');
  await expect(extras.getByRole('tab', { name: /Threads/ })).toBeVisible();
  await expect(band.getByRole('tab')).toHaveCount(0);
  const expanded = (await band.boundingBox())!;
  const above = (await extras.boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(expanded.y + 1);
  await extras.getByRole('button', { name: 'Fold the composer trays' }).click();
  await expect.poll(async () => (await extras.boundingBox())!.height).toBeLessThan(above.height - 10);
  expect(Math.abs((await band.boundingBox())!.height - expanded.height)).toBeLessThan(2);
  const identity = (await page.locator(dock).boundingBox())!;
  expect(Math.abs(identity.y - (await band.boundingBox())!.y)).toBeLessThan(2);
  expect(Math.abs(identity.height - expanded.height)).toBeLessThan(2);
});
