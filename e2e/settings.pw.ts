import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test('five usable Settings sections, keyboard navigation and persisted choices at ' + width + 'px', async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto('/?noDock');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const names = ['Providers', 'Computers and Containers', 'Appearance', 'Conversations', 'Remote access'];
    await expect(dialog.getByRole('tab', { name: 'Providers', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const name of names) {
      await dialog.getByRole('tab', { name, exact: true }).click();
      await expect(dialog.getByRole('tabpanel')).toBeVisible();
      await expect(dialog.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(name.replaceAll(' ', '-') + '-' + width + '.png'), animations: 'disabled' });
    }
    await expect(dialog).toContainText('This shares the Kiln API, not Ember’s browser UI');
    await expect(dialog.getByRole('button', { name: /Update remote|Update Kiln/ })).toHaveCount(0);
    const appearance = dialog.getByRole('tab', { name: 'Appearance', exact: true });
    await appearance.focus();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('tab', { name: 'Conversations', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Split view', exact: true }).click();
    const saved = await page.evaluate(async () => (await window.ember.getSettings()).splitView);
    await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).splitView)).toBe(saved);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Conversations', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Split view', exact: true })).toHaveAttribute('aria-pressed', String(saved));
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await expect(dialog).toContainText('Chat avatars');
    await expect(dialog.locator('svg').first()).toBeVisible();
  });
}


test('Conversations exposes the real host-owned 70k/5k compaction settings', async ({ page }) => {
  await page.goto('/?noDock');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    const original = window.ember.piRequest!;
    window.ember.piRequest = async (id, path, init) => {
      if (path !== '/settings/compaction') return original(id, path, init);
      const preference = init?.method === 'PUT' ? (init.body as { preference: unknown }).preference : null;
      return { ok: true, status: 200, data: { preference, defaults: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }, models: [] } as never };
    };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Conversations', exact: true }).click();
  const area = page.getByRole('region', { name: 'Context & compaction', exact: true });
  await expect(area.getByLabel('Compact at tokens', { exact: true })).toHaveValue('70000');
  await expect(area.getByLabel('Keep recent tokens', { exact: true })).toHaveValue('5000');
  await area.getByRole('button', { name: 'Save compaction settings', exact: true }).click();
  await expect(area.getByRole('status')).toContainText('Saved on');
  await expect(area.getByRole('button', { name: 'Reset to Pi defaults', exact: true })).toBeEnabled();
});
