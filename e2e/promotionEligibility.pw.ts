import { expect, test } from '@playwright/test';

for (const target of [
  { id: '17', title: 'Parse config', busy: true },
  { id: '23', title: 'Inspect migration', busy: true },
  { id: '22', title: 'Audit migration', busy: false },
]) {
  test(`${target.title}: promotion explains the running gate and recovers in its thread`, async ({ page }, testInfo) => {
    await page.goto('/?fixture=two-level-crew&threads&noDock');
    await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).first().click();
    const root = page.locator('main[data-session-key="pi:hearth::16"]');
    if (target.id === '22') {
      await root.getByRole('button', { name: 'Parse config', exact: true }).click();
      await page.getByTestId('thread-session-modal').getByRole('link', { name: 'Audit migration' }).click();
    } else {
      await root.getByRole('button', { name: target.title, exact: true }).click();
    }
    const worker = page.getByTestId('thread-session-modal').locator(`main[data-session-key="pi:hearth::${target.id}"]`);
    await worker.getByRole('button', { name: 'Promote to a persistent bot' }).click();
    const dialog = page.getByRole('dialog', { name: 'Promote to a persistent bot' });
    const confirm = dialog.getByRole('button', { name: 'Make persistent', exact: true });
    if (target.busy) {
      await expect(confirm).toBeDisabled();
      const reason = dialog.getByRole('status');
      await expect(reason).toContainText(/Kiln.*running turn/);
      await expect(reason).toContainText(/Back to thread.*Stop/);
      await page.screenshot({ path: testInfo.outputPath(`promotion-${target.id}-busy.png`) });
      await dialog.getByRole('button', { name: 'Back to thread', exact: true }).click();
      await expect(worker).toBeVisible();
      // Only the in-memory mock host is mutated. No live endpoint is involved.
      await page.evaluate(async (id) => {
        await window.ember.piRequest('pi:hearth', `/conversations/${id}/abort`, { method: 'POST', body: {} });
      }, target.id);
      await worker.getByRole('button', { name: 'Promote to a persistent bot' }).click();
    }
    await expect(confirm).toBeEnabled();
    await dialog.getByLabel('Name', { exact: true }).fill(`Persistent ${target.title}`);
    await page.screenshot({ path: testInfo.outputPath(`promotion-${target.id}-ready.png`) });
    await confirm.click();
    await expect(page.locator('aside').getByRole('button', { name: new RegExp(`Persistent ${target.title}`) }).first()).toBeVisible();
    await expect(page.getByTestId('thread-session-modal')).toHaveCount(0);
  });
}

test('a descendant question never disguises a running worker as promotable', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    let bridge: typeof window.ember;
    Object.defineProperty(window, 'ember', {
      configurable: true,
      get: () => bridge,
      set: (value: typeof window.ember) => {
        bridge = value;
        const original = value.piRequest!.bind(value);
        value.piRequest = async <T,>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
          const response = await original<T>(instance, path, init);
          if (path === '/conversations') {
            const data = response.data as { conversations?: Array<{ id: number; needsInput?: boolean }> };
            const child = data.conversations?.find((entry) => entry.id === 23);
            if (child) child.needsInput = true;
          }
          return response;
        };
      },
    });
  });
  await page.goto('/?fixture=two-level-crew&threads&noDock');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.locator('main[data-session-key="pi:hearth::16"]').getByRole('button', { name: 'Parse config', exact: true }).click();
  await page.getByTestId('thread-session-modal').getByRole('button', { name: 'Promote to a persistent bot' }).click();
  const dialog = page.getByRole('dialog', { name: 'Promote to a persistent bot' });
  await page.screenshot({ path: testInfo.outputPath('promotion-running-with-descendant-question.png') });
  await expect(dialog.getByRole('button', { name: 'Make persistent' })).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText(/Kiln.*running turn/);
});
