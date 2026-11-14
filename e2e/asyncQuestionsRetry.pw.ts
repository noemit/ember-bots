import { test, expect } from '@playwright/test';

test('a lost answer response cannot turn Resume into an answer replay', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.getByRole('tab', { name: /Questions/ }).click();
  const row = leader.getByRole('tabpanel', { name: /Questions/ }).locator('article').filter({ hasText: 'Keep the migration backup?' });
  await row.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    let loseOnce = true;
    window.ember.piRequest = async <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      const response = await original<T>(instance, path, init);
      if (path === '/questions/81/nested%3Adecision/reply' && loseOnce) { loseOnce = false; return { ok: false, status: 503, error: 'Kiln response lost' }; }
      return response;
    };
  });
  await row.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(row).toContainText('Answer saved · held on the host');
  await expect(row.getByRole('button', { name: 'Resume with answer', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Withdraw answer', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Retry answer', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Review current revision and edit', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Resume with answer', exact: true })).toBeVisible();
});

test('legacy questions and approvals remain blocking in the mixed fixture', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Dataset shortlist/ }).first().click();
  const dataset = page.locator('main[data-session-key="pi:hearth::13"]');
  await expect(dataset.getByText('The bot has a question', { exact: true })).toBeVisible();
  await expect(dataset.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
  await expect(dataset.getByRole('tab', { name: /Questions/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Wire the pi mock/ }).first().click();
  await expect(page.getByRole('button', { name: /^Allow(?: once)?$/ })).toBeVisible();
});
