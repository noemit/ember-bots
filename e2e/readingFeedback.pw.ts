import { expect, test } from '@playwright/test';
test.setTimeout(90000);
test.use({ actionTimeout: 20000 });

test('one scoped receipt, keyboard parity, latest-only undo and background without border', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const first = column.locator('[data-message-id="e91"]');
  const latest = column.locator('[data-message-id="e93"]');
  await latest.locator('p').click();
  await expect(column.locator('[data-read-toast]')).toHaveText('Marked readUndo');
  await expect(latest).toHaveAttribute('data-read-highlighted', 'true');
  expect(await latest.evaluate(el => ({ border: getComputedStyle(el).borderTopWidth, shadow: getComputedStyle(el).boxShadow }))).toEqual({ border: '0px', shadow: 'none' });
  const button = first.getByRole('button', { name: 'Mark this message as read' });
  await button.focus();
  await button.press('Enter');
  await expect(first).toHaveAttribute('data-read-highlighted', 'true');
  await expect(latest).not.toHaveAttribute('data-read-highlighted', 'true');
  await expect(column.locator('[data-read-toast]')).toHaveCount(1);
  await page.screenshot({ path: '/tmp/ember-reading-feedback.png' });
  await column.locator('[data-read-toast]').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(first.locator('[data-unread-dot]')).toHaveCount(1);
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await expect(column.locator('[data-read-toast]')).toHaveCount(0);
  await first.locator('p').click();
  await expect(column.locator('[data-read-toast]')).toHaveCount(1);
  await expect(first).not.toHaveAttribute('data-read-highlighted', 'true', { timeout: 2000 });
  await expect(column.locator('[data-read-toast]')).toHaveCount(0, { timeout: 5500 });
});

test('last human message pill follows viewport geometry and navigation stays passive', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const history = column.getByLabel('Conversation history', { exact: true });
  const pill = column.getByRole('button', { name: '↑ Jump to your last message', exact: true });
  await expect(pill).toBeVisible({ timeout: 20000 });
  const before = await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
  const [pillBox, historyBox] = await Promise.all([pill.boundingBox(), history.boundingBox()]);
  expect(Math.abs(pillBox!.x + pillBox!.width / 2 - historyBox!.x - historyBox!.width / 2)).toBeLessThan(2);
  await page.screenshot({ path: '/tmp/ember-reading-last-message.png' });
  await pill.click();
  await expect(column.locator('[data-message-id="e3"]')).toBeInViewport();
  await expect(pill).toHaveCount(0);
  await history.evaluate(el => { el.scrollTop = 0; });
  await expect(pill).toHaveCount(0);
  await column.getByRole('button', { name: /New unread messages/ }).click();
  await history.evaluate(el => { el.scrollTop += 150; });
  await expect(pill).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => window.ember.getSettings().then(s => s.readMarks))).toEqual(before);
});

test('virtualized history can jump to an unmounted latest user', async ({ page }) => {
  await page.goto('/?fixture=performance&noDock&legacy');
  const column = page.locator('main').first();
  const log = column.getByRole('log');
  await expect(log.getByText('Synthetic message 9999', { exact: true })).toBeVisible({ timeout: 30000 });
  // Extend only the final assistant reply so the previous human row is out of the virtual window.
  await page.evaluate(() => window.emberFixture!.appendMessage(Array.from({ length: 180 }, () => `Long answer paragraph.\n\n`).join('')));
  const pill = column.getByRole('button', { name: '↑ Jump to your last message', exact: true });
  await expect(pill).toBeVisible({ timeout: 20000 });
  expect(await log.locator('[data-index]').count()).toBeLessThan(100);
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect(log.getByText('Synthetic message 9998', { exact: true })).toBeInViewport();
});

test('undo survives host refresh and reload while preserving another receipt', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const first = column.locator('[data-message-id="e91"]');
  const latest = column.locator('[data-message-id="e93"]');
  await latest.getByRole('button', { name: 'Mark this message as read' }).click();
  await first.getByRole('button', { name: 'Mark this message as read' }).click();
  await column.locator('[data-read-toast]').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(first.locator('[data-unread-dot]')).toHaveCount(1);
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reload session' }).click();
  await expect(first.locator('[data-unread-dot]')).toHaveCount(1);
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  await expect(first.locator('[data-unread-dot]')).toHaveCount(1);
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
});

test('leader receipt never appears in its worker dialog', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.locator('[data-message-id="e93"]').getByRole('button', { name: 'Mark this message as read' }).click();
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('log')).toBeVisible();
  await expect(dialog.locator('[data-read-toast]')).toHaveCount(0);
  await expect(leader.locator('[data-read-toast]')).toHaveCount(1);
  await expect(dialog.getByRole('log').locator('.blob')).toHaveCount(0);
});


test('focused Undo holds the receipt to its five-second cap, then goes', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const message = column.locator('[data-message-id="e2"]');
  await message.getByRole('button', { name: 'Mark this message as read' }).click();
  const undo = column.locator('[data-read-toast]').getByRole('button', { name: 'Undo', exact: true });
  await undo.focus();
  // Focus holds it well past the one-second default…
  await page.waitForTimeout(2500);
  await expect(undo).toBeFocused();
  await expect(message).not.toHaveAttribute('data-read-highlighted', 'true');
  // …but the five-second cap is measured from appearance, so focus cannot keep it for ever.
  await page.waitForTimeout(3000);
  await expect(column.locator('[data-read-toast]')).toHaveCount(0);
});

test('an untouched receipt leaves after about a second and still offers Undo', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const message = column.locator('[data-message-id="e2"]');
  await message.getByRole('button', { name: 'Mark this message as read' }).click();
  const undo = column.locator('[data-read-toast]').getByRole('button', { name: 'Undo', exact: true });
  await undo.focus();
  await undo.press('Enter');
  await expect(message.locator('[data-unread-dot]')).toHaveCount(1);
  await expect(column.locator('[data-read-toast]')).toHaveCount(0);
});

for (const scene of [{ name: 'light', theme: 'stone', width: 1600 }, { name: 'dark', theme: 'graphite', width: 1600 }, { name: 'mobile', theme: 'stone', width: 390 }]) {
  test('waiting status follows message inset at readable size: ' + scene.name, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('ember-pi-read-state', JSON.stringify({ theme })), scene.theme);
    await page.goto('/');
    await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
    await page.setViewportSize({ width: scene.width, height: 900 });
    const column = page.locator('main[data-session-key="pi:hearth::16"]');
    const status = column.locator('[data-session-status]');
    await expect(status).toHaveText('Waiting on 2 workers…');
    expect(await status.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
    const inset = await column.evaluate(el => {
      const status = el.querySelector('[data-session-status]')!;
      const message = el.querySelector('[data-message-id="e93"]')!;
      return {
        status: status.getBoundingClientRect().left + parseFloat(getComputedStyle(status).paddingLeft),
        message: message.getBoundingClientRect().left + parseFloat(getComputedStyle(message).paddingLeft),
      };
    });
    expect(Math.abs(inset.status - inset.message)).toBeLessThan(1);
    await page.screenshot({ path: '/tmp/ember-reading-status-' + scene.name + '.png' });
  });
}
