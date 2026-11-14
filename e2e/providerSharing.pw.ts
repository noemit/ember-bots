import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/types';

const prepare = async (page: Page) => {
  await page.goto('/?noDock');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    const original = window.ember.piRequest!;
    const peers = ['Missing', 'Existing', 'Old', 'Offline'].map((label, index) => ({ id: `pi:review-${label.toLowerCase()}`, label, url: `http://100.64.0.${index + 30}:3002`, token: 'synthetic-peer-token' }));
    const probe = { calls: [] as Array<{ id: string; path: string; method: string; body: unknown }> };
    (window as unknown as { sharingProbe: typeof probe }).sharingProbe = probe;
    const p = (providerId: string, type = 'api_key', extra = {}) => ({ providerId, type, source: 'stored', hasCredential: true, shareable: true, ...extra });
    const binding = { id: 'custom-test', name: 'Internal', baseUrl: 'https://models.example/v1', modelIds: ['one'] };
    window.ember.piRequest = async <T,>(id: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (!path.startsWith('/alignment')) return original<T>(id, path, init);
      probe.calls.push({ id, path, method: init?.method ?? 'GET', body: init?.body });
      const label = (await window.ember.getSettings()).piEndpoints.find(endpoint => endpoint.id === id)?.label;
      const reply = (data: unknown, status = 200) => ({ ok: status === 200, status, data: data as T });
      if (path === '/alignment') {
        if (label === 'Old') return reply({ apiKeys: [] }); // An older Kiln must fail closed.
        if (label === 'Offline') return reply({}, 503);
        const providers = label === 'Missing' ? [p('custom-local-destination', 'api_key', { hasCredential: false, source: 'missing', configIdentity: { ...binding, id: 'custom-local-destination' } }), p('custom-mismatch', 'api_key', { hasCredential: false, source: 'missing', configIdentity: { ...binding, id: 'custom-mismatch', name: 'Different API', baseUrl: 'https://different.example/v1' } })]
          : label === 'Existing' ? [p('new-generic-provider'), p('environment-provider', 'api_key', { source: 'environment', shareable: false })]
          : [p('new-generic-provider', 'api_key', { key: 'provider-secret-never-render' }), p('openai-codex', 'oauth', { experimental: true }), p('antigravity', 'oauth', { experimental: true }), p('other-oauth', 'oauth', { shareable: false }), p('environment-provider', 'api_key', { source: 'environment', shareable: false }), p('custom-test', 'api_key', { configIdentity: binding }), p('custom-mismatch', 'api_key', { configIdentity: { ...binding, id: 'custom-mismatch', name: 'Different API' } })];
        return reply({ apiKeys: ['new-generic-provider'], signIns: 3, peers: [], providers });
      }
      if (path === '/alignment/connections') return reply({ peers });
      if (path === '/alignment/share') {
        const targets = (init?.body as { targets: Array<{ id: string; providers: unknown[] }> }).targets;
        return reply({ results: targets.map(target => ({ id: target.id, ok: true, keys: target.providers.length })) });
      }
      return reply({ connections: 0 });
    };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Instances', exact: true }).click();
  const alignment = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Align all my instances' }) });
  await alignment.getByRole('button', { name: 'Review', exact: true }).click();
  await alignment.getByRole('button', { name: 'Review instances', exact: true }).click();
  await alignment.getByRole('button', { name: 'Align now', exact: true }).click();
  await expect(alignment.getByRole('status')).toContainText('Added 4 connections');
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Custom OpenAI-compatible providers' })).toBeVisible();
  const area = page.getByRole('region', { name: 'Share providers across Kilns' });
  await page.screenshot({ path: '/tmp/ember-provider-sharing-entry.png', fullPage: true });
  await area.getByRole('button', { name: 'Review and share' }).click();
  await page.evaluate(() => { (window as unknown as { sharingProbe: { calls: unknown[] } }).sharingProbe.calls.length = 0; });
  await area.getByRole('button', { name: 'Compare providers' }).click();
  return area;
};

const calls = (page: Page) => page.evaluate(() => (window as unknown as { sharingProbe: { calls: Array<{ id: string; path: string; method: string; body: unknown }> } }).sharingProbe.calls);

test('metadata review names missing/existing/unsupported hosts and shares only explicitly reviewed providers without changing defaults', async ({ page }) => {
  const area = await prepare(page);
  await expect(area.getByLabel('Provider availability')).toContainText('Missing credential');
  await expect(area.getByLabel('Provider availability')).toContainText('Environment key — available here, not exported');
  await expect(area.getByLabel('Kiln comparison status')).toContainText('Old does not support reviewed provider sharing yet');
  await expect(area.getByLabel('Kiln comparison status')).toContainText('Offline did not answer');
  expect((await calls(page)).every(call => call.path === '/alignment' && call.method === 'GET' && call.body === undefined)).toBe(true);
  await expect(area).not.toContainText('provider-secret-never-render');
  const source = await area.getByLabel('Provider sharing source').locator('option').nth(1).getAttribute('value');
  await area.getByLabel('Provider sharing source').selectOption(source!);
  await expect(area.getByLabel('Share new-generic-provider to Missing')).toBeEnabled();
  await expect(area.getByLabel('Share new-generic-provider to Existing')).toBeDisabled();
  await expect(area.getByLabel('Share new-generic-provider to Old')).toBeDisabled();
  await expect(area.getByLabel('Share new-generic-provider to Offline')).toBeDisabled();
  await expect(area.getByLabel('Share environment-provider to Missing')).toBeDisabled();
  await expect(area.getByLabel('Share custom-test to Missing')).toBeEnabled();
  await expect(area.getByLabel('Share custom-mismatch to Missing')).toBeDisabled();
  await expect(area.getByLabel('Source ember-harness (mock) configuration for custom-test', { exact: true }).first()).toContainText('https://models.example/v1');
  await expect(area.getByLabel('Destination Missing configuration for custom-test', { exact: true })).toContainText('https://models.example/v1');
  await expect(area.getByLabel('Destination Missing configuration for custom-test', { exact: true })).toContainText('custom-local-destination');
  await expect(area.getByLabel('Destination Missing configuration for custom-mismatch', { exact: true })).toContainText('https://different.example/v1');
  await expect(area.getByLabel('Destination Missing configuration for custom-test', { exact: true })).toContainText('Internal');
  await expect(area.getByLabel('Destination Missing configuration for custom-test', { exact: true })).toContainText('one');
  await expect(area.getByLabel('Share openai-codex to Missing')).toBeDisabled();
  await expect(area.getByLabel('Share other-oauth to Missing')).toBeDisabled();
  await area.getByLabel('Enable experimental Codex and Antigravity sign-in sharing').check();
  await expect(area).toContainText('tokens refresh');
  await expect(area).toContainText('Signing in separately');
  await expect(area.getByLabel('Share openai-codex to Missing')).toBeEnabled();
  await expect(area.getByLabel('Share antigravity to Missing')).toBeEnabled();
  await area.getByLabel('Share new-generic-provider to Missing').check();
  await area.getByLabel('Share openai-codex to Missing').check();
  await area.getByLabel('Share antigravity to Missing').check();
  await area.getByLabel('Share custom-test to Missing').check();
  await expect(area.getByRole('button', { name: 'Share 4 reviewed selections' })).toBeEnabled();
  await expect(area).not.toContainText('synthetic-peer-token');
  await page.screenshot({ path: '/tmp/ember-provider-sharing-review.png', fullPage: true });
  await area.getByLabel('Destination Missing configuration for custom-test', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/ember-provider-sharing-custom-review.png', fullPage: true });
  const before = await page.evaluate(() => window.ember.getSettings().then(settings => settings.instanceDefaults));
  await area.getByRole('button', { name: 'Share 4 reviewed selections' }).click();
  await expect(area.getByRole('status')).toContainText('Missing: 4 credentials added');
  const writes = (await calls(page)).filter(call => call.path === '/alignment/share');
  expect(writes).toHaveLength(1);
  expect(writes[0].id).toBe(source);
  const targets = (writes[0].body as { targets: Array<{ label: string; providers: unknown[] }> }).targets;
  expect(targets).toHaveLength(1);
  expect(targets[0].label).toBe('Missing');
  expect(targets[0].providers).toEqual([{ providerId: 'new-generic-provider', type: 'api_key' }, { providerId: 'openai-codex', type: 'oauth', experimental: true }, { providerId: 'antigravity', type: 'oauth', experimental: true }, { providerId: 'custom-test', type: 'api_key', configIdentity: { id: 'custom-test', name: 'Internal', baseUrl: 'https://models.example/v1', modelIds: ['one'] }, destinationConfigIdentity: { id: 'custom-local-destination', name: 'Internal', baseUrl: 'https://models.example/v1', modelIds: ['one'] } }]);
  expect(await page.evaluate(() => window.ember.getSettings().then(settings => settings.instanceDefaults))).toEqual(before);
  expect(await page.evaluate(() => window.ember.getSettings().then(settings => JSON.stringify(settings)))).not.toContain('provider-secret-never-render');
  await expect(page.getByRole('region', { name: 'Confirm instance default' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/ember-provider-sharing-result.png', fullPage: true });
});

test('turning off experimental sharing or changing source clears selections', async ({ page }) => {
  const area = await prepare(page);
  const source = await area.getByLabel('Provider sharing source').locator('option').nth(1).getAttribute('value');
  await area.getByLabel('Provider sharing source').selectOption(source!);
  await expect(area).toContainText('Kiln address: http://100.64.0.30:3002');
  const experimental = area.getByLabel('Enable experimental Codex and Antigravity sign-in sharing');
  await experimental.check();
  await area.getByLabel('Share openai-codex to Missing').check();
  await experimental.uncheck();
  await expect(area.getByRole('button', { name: 'Share 0 reviewed selections' })).toBeDisabled();
  await experimental.check();
  await expect(area.getByLabel('Share openai-codex to Missing')).not.toBeChecked();
  await area.getByLabel('Share new-generic-provider to Missing').check();
  await area.getByLabel('Provider sharing source').selectOption('');
  await area.getByLabel('Provider sharing source').selectOption(source!);
  await expect(area.getByLabel('Share new-generic-provider to Missing')).not.toBeChecked();
  expect((await calls(page)).filter(call => call.path === '/alignment/share')).toHaveLength(0);
});

test('remote browser sharing stays desktop-only without requesting metadata or credentials', async ({ page }) => {
  await page.goto('/?noDock');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    const save = window.ember.setSettings;
    window.ember.setSettings = async patch => {
      const settings = await save(patch);
      return { ...settings, piEndpoints: settings.piEndpoints.map(endpoint => ({ ...endpoint, token: '', hasToken: true })) };
    };
    const original = window.ember.piRequest!;
    const probe = { calls: [] as string[] };
    (window as unknown as { remoteSharingProbe: typeof probe }).remoteSharingProbe = probe;
    window.ember.piRequest = async (id, path, init) => { if (path.startsWith('/alignment')) probe.calls.push(path); return original(id, path, init); };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  const area = page.getByRole('region', { name: 'Share providers across Kilns' });
  await area.getByRole('button', { name: 'Review and share' }).click();
  await expect(area).toContainText('available in the Ember desktop app');
  await expect(area.getByRole('button', { name: 'Compare providers' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { remoteSharingProbe: { calls: string[] } }).remoteSharingProbe.calls)).toEqual([]);
});
