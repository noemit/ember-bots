import { expect, test } from '@playwright/test';

test('the workspace opens directly, with unread reading in the rail', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside')).toBeVisible();
  await expect(page.locator('main[data-session-key]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Home —/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read unread messages' })).toBeVisible();
  const marks = await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
  await page.getByRole('button', { name: 'Read unread messages' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('unread');
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks))).toEqual(marks);
  // Reader navigation still works while a control is focused.
  await sheet.getByRole('button', { name: 'Open conversation', exact: true }).press('j');
  await expect(sheet).toContainText(/2\s*of\s*2\s*unread/);
  await sheet.getByRole('button', { name: 'Open conversation', exact: true }).press('k');
  await expect(sheet).toContainText(/1\s*of\s*2\s*unread/);
  // Enter on a focused button must activate that button, not mark the message read.
  await sheet.getByRole('button', { name: 'Open conversation', exact: true }).press('Enter');
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks))).toEqual(marks);
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

for (const send of [false, true]) {
  test(`comments drafted in the rail reader ${send ? 'send to that chat' : 'return to its composer unsent'}`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Read unread messages' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(/1 of \d+ unread/)).toBeVisible();
    expect((await sheet.boundingBox())?.width ?? 0).toBeGreaterThan(900);
    const bar = page.getByRole('toolbar', { name: 'Comment on the selection' });
    const selectInReader = () => page.evaluate(() => {
        const region = document.querySelector('[data-testid="reading-region"]');
        if (!region) throw new Error('Reader has not loaded');
        const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if ((walker.currentNode.nodeValue ?? '').trim().length <= 40) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
        throw new Error('Message has not loaded');
      });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await selectInReader();
      if (await bar.isVisible()) break;
      await page.waitForTimeout(250);
    }
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Comment on the selected text' }).click();
    await bar.getByRole('textbox').fill('Keep this plan feedback attached to its chat.');
    await bar.getByRole('button', { name: 'Add this comment' }).click();
    if (send) {
      await sheet.getByRole('button', { name: 'Send 1 comment' }).click();
      await expect(page.getByTestId('sheet-comments')).toHaveCount(0);
    }
    await sheet.getByRole('button', { name: 'Open conversation', exact: true }).click();
    const column = page.locator('main[data-session-key="pi:hearth::16"]');
    await expect(column).toBeVisible();
    if (send) {
      await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Keep this plan feedback attached to its chat.');
    } else {
      await expect(column.getByRole('button', { name: 'Send 1 comment' })).toBeVisible();
      await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('Keep this plan feedback attached to its chat.');
    }
  });
}
