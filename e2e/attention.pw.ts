import { expect, test } from '@playwright/test';

test('the workspace opens directly without an unread shortcut or reading modal', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside')).toBeVisible();
  await expect(page.locator('main[data-session-key]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Home —/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read unread messages' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(page.locator('main[data-session-key="pi:hearth::10"]').getByRole('button', { name: /Go to new messages/ })).toBeVisible();
});

test('muting a chat keeps its read history intact and survives reload', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
  await row.click();
  const marks = await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: "New Messages: Don't Notify" }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.mutedSessions))).toContain('pi:hearth::10');
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks))).toEqual(marks);
  await expect(page.locator('main[data-session-key="pi:hearth::10"]').getByRole('button', { name: /Go to new messages/ })).toBeVisible();
  await page.reload();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New Messages: Notify', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.mutedSessions))).not.toContain('pi:hearth::10');
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks))).toEqual(marks);
});

test('running processes stay visible through all three rail widths', async ({ page }) => {
  await page.goto('/?fixture=processes');
  const rail = page.locator('aside');
  const indicator = rail.getByTestId('rail-process-indicator');
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toHaveAccessibleName(/2 processes running/);
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(page.getByRole('tab', { name: 'Processes 2' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(indicator).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(rail.locator('[data-mini-session="pi:hearth::10"]')).toBeVisible();
  await expect(indicator).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+b');
  await page.screenshot({ path: '/tmp/ember-1.7.0-rail.png' });
});

test('a custom chat colour follows its blob and background without recolouring its neighbours', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
  await row.click();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: 'Appearance scope' })).toContainText('This session');
  await dialog.getByLabel('Custom agent color').fill('#d25b87');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.avatarOverrides['session:pi:hearth::10']?.color))).toBe('#d25b87');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.locator('[data-agent-glow]')).toHaveAttribute('style', /rgb\(210, 91, 135\)/);
  await expect(row.locator('svg [fill="#d25b87"]')).not.toHaveCount(0);
  const overrides = await page.evaluate(() => window.ember.getSettings().then(s => s.avatarOverrides));
  expect(Object.keys(overrides)).toEqual(['session:pi:hearth::10']);
});

test('adding a provider offers an explicit instance-default decision', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'API key for DeepSeek' });
  await field.fill('mock-test-key');
  await field.locator('..').getByRole('button', { name: 'Save', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm instance default' });
  await expect(confirmation).toContainText('DeepSeek');
  await confirmation.getByRole('button', { name: 'Choose default model' }).click();
  // The existing picker offers the whole catalogue, so a provider never silently chooses a model.
  await expect(page.getByRole('dialog').last()).toContainText('model');
  await page.keyboard.press('Escape');
  await confirmation.getByRole('button', { name: 'Keep current default' }).click();
  await expect(confirmation).toHaveCount(0);
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults))).toEqual({});
});

test('approval choices identify the same YOLO mode as the composer', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Wire the pi mock/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::12"]');
  await expect(column.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  await column.getByRole('button', { name: /Switch to Yolo mode/i }).click();
  await expect(column.getByRole('button', { name: /YOLO mode on/ })).toHaveAttribute('aria-pressed', 'true');
});

test('the confirmed instance default seeds the next chat without changing existing chats', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'API key for DeepSeek' });
  await field.fill('mock-test-key');
  await field.locator('..').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('region', { name: 'Confirm instance default' }).getByRole('button', { name: 'Choose default model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('button', { name: 'DeepSeek V4.1 Flash', exact: true }).click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.instanceDefaults['pi:hearth']?.model?.modelID))).toBe('deepseek-v4.1-flash');
  await expect(page.getByText('New chats default to faux-hearth/deepseek-v4.1-flash.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('aside').getByRole('button', { name: 'New agent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose model' })).toContainText('DeepSeek V4.1 Flash');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(page.getByRole('button', { name: 'Choose model' })).toContainText('GLM-5.3 Flash');
});

test('provider sign-in also offers the default decision after the credential lands', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with SuperGrok or X Premium' }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to xAI' });
  await expect(signIn).toContainText('xAI is connected.', { timeout: 10_000 });
  await signIn.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Confirm instance default' })).toContainText('xAI');
});

test('rail hover actions have an opaque surface separating them from the text', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
  const before = (await row.boundingBox())!.height;
  await row.hover();
  const root = row.locator('..');
  const actions = root.locator('[data-rail-actions]');
  await expect(actions).toHaveCSS('opacity', '1');
  const paint = await actions.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow }));
  expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(paint.background).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)/);
  expect(paint.shadow).not.toBe('none');
  const title = await root.locator('[data-session-title]').boundingBox();
  const controls = await actions.boundingBox();
  expect(title!.x + title!.width).toBeLessThanOrEqual(controls!.x);
  expect((await row.boundingBox())!.height).toBeCloseTo(before, 0);
  await page.screenshot({ path: '/tmp/ember-rail-action-surface.png' });
});
