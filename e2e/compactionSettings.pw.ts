import { expect, test } from '@playwright/test';
import type { Session } from '../src/types';
type TestWindow = Window & { compactionTest: { requests: unknown[]; fail: boolean }; renderCompactionStatus: (session: Partial<Session>) => void };

test('production compaction component saves host-owned targets, resets and reports recoverable failures', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().waitFor();
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const clientPath = '/node_modules/.vite/deps/react-dom_client.js';
    const componentPath = '/src/components/ContextCompactionSettings.tsx';
    const react = await import(/* @vite-ignore */ reactPath);
    const client = await import(/* @vite-ignore */ clientPath);
    const createElement = react.createElement ?? react.default.createElement;
    const createRoot = client.createRoot ?? client.default.createRoot;
    const { default: Component } = await import(/* @vite-ignore */ componentPath);
    const state = { preference: null, defaults: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }, models: [{ provider: 'faux', modelId: 'large', contextWindow: 200000, compactAtTokens: 150848, keepRecentTokens: 20000, blockingAtTokens: 183616, custom: false, supported: true }] };
    const w = window as TestWindow;
    w.compactionTest = { requests: [], fail: false };
    w.ember.piRequest = async (id: string, path: string, init: { method?: string; body?: { preference: unknown } }) => {
      w.compactionTest.requests.push({ id, path, init });
      if (w.compactionTest.fail) return { ok: false, status: 503, data: {} };
      if (init?.method === 'PUT') Object.assign(state, { preference: init.body.preference });
      return { ok: true, status: 200, data: JSON.parse(JSON.stringify(state)) };
    };
    const mount = document.createElement('div');
    mount.id = 'compaction-settings-test';
    mount.className = 'mx-auto max-w-2xl p-8 bg-background text-foreground';
    document.body.replaceChildren(mount);
    createRoot(mount).render(createElement(Component, { instances: [{ id: 'test-kiln', kind: 'pi', label: 'Tower', status: 'ready', attachable: true }] }));
  });
  await expect(page.getByText('Using Pi defaults', { exact: true })).toBeVisible();
  await page.getByLabel('Compact at tokens', { exact: true }).fill('70000');
  await page.getByLabel('Keep recent tokens', { exact: true }).fill('5000');
  await page.getByRole('button', { name: 'Save compaction settings' }).click();
  await expect(page.getByRole('status')).toContainText('Saved on Tower');
  expect(await page.evaluate(() => (window as TestWindow).compactionTest.requests.at(-1))).toMatchObject({ id: 'test-kiln', path: '/settings/compaction', init: { method: 'PUT', body: { preference: { compactAtTokens: 70000, keepRecentTokens: 5000 } } } });
  await page.screenshot({ path: '/tmp/ember-compaction-settings.png', fullPage: true });
  await page.getByRole('button', { name: 'Reset to Pi defaults' }).click();
  await expect(page.getByText('Using Pi defaults', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as TestWindow).compactionTest.fail = true; });
  await page.getByRole('button', { name: 'Save compaction settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Tower');
  await expect(page.getByRole('alert')).toContainText('Save again');
});

test('compaction outcome needs a new landed summary; progress and a no-op never announce success', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().waitFor();
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const clientPath = '/node_modules/.vite/deps/react-dom_client.js';
    const componentPath = '/src/components/ContextCompactionStatus.tsx';
    const react = await import(/* @vite-ignore */ reactPath);
    const client = await import(/* @vite-ignore */ clientPath);
    const { default: Component } = await import(/* @vite-ignore */ componentPath);
    const mount = document.createElement('div'); document.body.replaceChildren(mount);
    const root = (client.createRoot ?? client.default.createRoot)(mount);
    (window as TestWindow).renderCompactionStatus = (session: Partial<Session>) => root.render((react.createElement ?? react.default.createElement)(Component, { session, host: 'Tower', onCompact: () => {} }));
    (window as TestWindow).renderCompactionStatus({ contextCompaction: { entryId: 42, reason: 'manual' } });
  });
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => (window as TestWindow).renderCompactionStatus({ compacting: true, contextCompaction: { entryId: 42, reason: 'manual' } }));
  await expect(page.getByRole('status')).toContainText('Tower is compacting');
  await page.evaluate(() => (window as TestWindow).renderCompactionStatus({ contextCompaction: { entryId: 42, reason: 'manual' } }));
  await expect(page.getByRole('status')).toHaveCount(0); // no new summary = no success
  await page.evaluate(() => (window as TestWindow).renderCompactionStatus({ contextCompaction: { entryId: 43, reason: 'threshold' }, currentContextEpoch: '43' }));
  await expect(page.getByRole('status')).toContainText('Context compacted automatically');
  await page.evaluate(() => (window as TestWindow).renderCompactionStatus({ compactionFailure: { trigger: 'manual', error: 'failed' } }));
  await expect(page.getByRole('status')).toContainText('Tower did not finish');
  await expect(page.getByRole('status')).not.toContainText('Context compacted');
});
