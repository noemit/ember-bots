import { expect, test } from '@playwright/test';

test('connection alignment stays separate from provider sharing and discovered connections persist', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(async () => {
    const original = window.ember.piRequest!;
    const testState = { paths: [] as string[] };
    (window as unknown as { alignmentTest: typeof testState }).alignmentTest = testState;
    window.ember.piRequest = async <T,>(id: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (!path.startsWith('/alignment')) return original<T>(id, path, init);
      testState.paths.push(path);
      const peer = { id: 'pi:test-remote', label: 'Test remote', url: 'http://100.64.0.28:3002', token: 'synthetic-test-token' };
      const data = path === '/alignment' ? { apiKeys: ['openai'], signIns: 1, peers: [{ id: peer.id, label: peer.label, url: peer.url }] }
        : path === '/alignment/connections' ? { peers: [peer] }
        : path === '/alignment/share' ? { results: [] }
        : { connections: 1, keys: 0 };
      return { ok: true, status: 200, data: data as T };
    };
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  const area = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Align all my instances' }) });
  await area.getByRole('button', { name: 'Review', exact: true }).click();
  await area.getByRole('button', { name: 'Review instances', exact: true }).click();
  await expect(area).toContainText('1 stored API keys');
  await expect(area.getByRole('checkbox')).toHaveCount(0);
  await expect(area.getByRole('button', { name: 'Review and share' })).toBeVisible();
  const calls = () => page.evaluate(() => (window as unknown as { alignmentTest: { paths: string[] } }).alignmentTest.paths);
  expect((await calls()).every(path => path === '/alignment')).toBe(true);
  await area.getByRole('button', { name: 'Align now' }).click();
  await expect(area.getByRole('status')).toContainText('Added 1 connections');
  expect(await calls()).not.toContain('/alignment/share');
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.piEndpoints.some(e => e.label === 'Test remote')))).toBe(true);
  await expect(area).not.toContainText('synthetic-test-token');
  await area.getByRole('button', { name: 'Review instances', exact: true }).click();
  await area.getByRole('button', { name: 'Review and share' }).click();
  await expect(area).toContainText('The comparison reads metadata only');
  expect(await calls()).not.toContain('/alignment/share');
  await page.screenshot({ path: '/tmp/ember-instance-alignment.png' });
});
