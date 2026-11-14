import { test, expect } from '@playwright/test';

test('nonblocking Questions keep failed drafts, retry identities and independent source/history', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const composer = leader.locator('textarea').last();
  await composer.fill('Keep my working draft');
  await expect(leader.getByTestId('thread-question')).toHaveCount(0);
  const tab = leader.getByRole('tab', { name: /Questions/ });
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click();
  const panel = leader.getByRole('tabpanel', { name: /Questions/ });
  const nested = panel.locator('article').filter({ hasText: 'Keep the migration backup?' });
  await expect(nested).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Migrate schema' })).toBeVisible();
  await nested.getByText('Source and delivery history', { exact: true }).click();
  await expect(nested).toContainText('backup-review');
  await nested.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    const calls: unknown[] = [];
    let failOnce = true;
    Object.assign(window, { questionMutationCalls: calls });
    window.ember.piRequest = async <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (path.startsWith('/questions/81/') && init?.method === 'POST') {
        calls.push({ path, body: init.body });
        if (failOnce) { failOnce = false; return { ok: false, status: 503, error: 'Kiln is restarting' }; }
      }
      return original<T>(instance, path, init);
    };
  });
  await nested.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(nested.getByRole('alert')).toContainText('confirm');
  await expect(nested.locator('textarea')).toHaveValue('Keep');
  await page.screenshot({ path: '/tmp/ember-questions-failed-draft.png', fullPage: true, animations: 'disabled' });
  // Shelf navigation keeps the request identity and human draft across unmounts.
  await tab.click();
  await expect(panel).toBeHidden();
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(nested.locator('textarea')).toHaveValue('Keep');
  await nested.getByRole('button', { name: 'Retry answer', exact: true }).click();
  await expect(nested).toContainText('Answer saved · held on the host');
  const calls = await page.evaluate(() => (window as unknown as { questionMutationCalls: Array<{ path: string; body: { requestId: string; revision: number } }> }).questionMutationCalls);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0].path).toBe('/questions/81/nested%3Adecision/reply');
  expect(calls[0].body.revision).toBe(3);
  await expect(composer).toHaveValue('Keep my working draft');
  await panel.getByLabel('Questions', { exact: true }).evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/ember-questions-held-answer.png', fullPage: true, animations: 'disabled' });
  await nested.getByRole('button', { name: 'Open source', exact: true }).click();
  const dialog = page.getByTestId('thread-session-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Review the backup policy.');
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('Keep my working draft');
  await nested.getByRole('button', { name: 'Resume with answer', exact: true }).click();
  await expect(nested).toContainText('Answer admitted · not yet confirmed seen');
  await expect(nested.getByRole('button', { name: 'Resume with answer', exact: true })).toHaveCount(0);
  // Own question withdrawal is explicit and remains readable in history.
  const own = panel.locator('article').filter({ hasText: 'Keep the rollout gradual?' });
  await own.getByRole('button', { name: 'Withdraw question', exact: true }).click();
  await expect(own).toContainText('withdrawn');
  await page.screenshot({ path: '/tmp/ember-questions-history.png', fullPage: true, animations: 'disabled' });
});
