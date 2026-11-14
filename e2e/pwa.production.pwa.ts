import { expect, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { test as base } from '@playwright/test';
import * as path from 'node:path';
import { createRemoteServer, SESSION_COOKIE } from '../electron/remoteServer';
import { DEFAULT_SETTINGS } from '../src/hooks/useEmberSettings';

const ROOT = path.resolve('dist');
const SECRET = 'fixture-private-setting-that-must-not-be-cached';
let server: http.Server;
let origin: string;
let instancesCalls = 0;
const openContexts = new Set<BrowserContext>();
const test = base.extend<{ managedContext: BrowserContext }>({
  managedContext: async ({ browser }, use) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
    openContexts.add(context);
    try { await use(context); } finally { openContexts.delete(context); await context.close(); }
  },
});
let settings = { ...DEFAULT_SETTINGS, theme: SECRET, onboardedAt: Date.now(), onboardingDismissedAt: Date.now(), remoteAccessEnabled: true, remotePasswordConfigured: true };

const handlers = {
  modelStats: { list: async () => ({ observations: [] }), observe: async () => ({ ok: true }), clear: async () => ({ ok: true }) },
  listInstances: async () => { instancesCalls++; return []; },
  getSettings: () => settings,
  setSettings: (patch: unknown) => { settings = { ...settings, ...(patch as object) }; return settings; },
  request: async () => ({ ok: true, status: 200, data: [] }),
  verifyPassword: async (password: string) => password === 'fixture-password',
  subscribeEvents: () => () => {},
  eventStatus: () => ({}),
};

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) throw new Error('Build production assets first: bunx vite build');
  server = createRemoteServer(ROOT, handlers);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(57823, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:57823';
});
test.afterAll(async () => { server?.closeAllConnections(); await new Promise<void>((resolve) => server?.close(() => resolve())); });
test.beforeEach(async () => {
  instancesCalls = 0;
  settings = { ...DEFAULT_SETTINGS, theme: SECRET, onboardedAt: Date.now(), onboardingDismissedAt: Date.now(), remoteAccessEnabled: true, remotePasswordConfigured: true };
});

async function login(page: Page) {
  await page.goto('/remote/login');
  await page.getByLabel(/password/i).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(origin + '/');
  await expect(page.getByRole('button', { name: /phone app/i })).toBeVisible();
}


test('login explains a lost connection and leaves Sign in available for an explicit retry', async ({ managedContext: context }) => {
  const page = await context.newPage();
  await page.goto('/remote/login');
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await page.getByLabel(/password/i).fill('fixture-password');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const status = page.getByRole('status');
  await expect(status).toContainText(/Ember computer did not answer/i);
  await expect(status).toContainText(/check your private connection/i);
  await expect(status).toContainText(/try Sign in again/i);
  const copy = await status.innerText();
  expect(copy).not.toMatch(/undefined|null|HTTP|something went wrong/i);
  await expect(page).toHaveURL(/\/remote\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await context.setOffline(false);
});

test('production PWA authenticates, installs its real worker, and limits cache to the public shell', async ({ managedContext: context }) => {
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await login(page);
  await expect.poll(() => instancesCalls).toBeGreaterThan(0);
  await expect(page.getByText(SECRET, { exact: false })).toHaveCount(0);
  await expect(page.locator('body')).toContainText(/sessions|new agent|ember/i);

  const cdp = await context.newCDPSession(page);
  const manifestErrors: Array<{ message?: string; critical?: boolean }> = [];
  cdp.on('Page.manifestError', event => manifestErrors.push(event));
  await cdp.send('Page.enable');
  const cdpManifest = await cdp.send('Page.getAppManifest');
  expect(cdpManifest.url).toContain('/manifest.webmanifest');
  expect(cdpManifest.errors).toEqual([]);
  expect(manifestErrors).toEqual([]);
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) throw new Error('production document has no manifest link');
    if (link.crossOrigin !== 'use-credentials') throw new Error('Manifest must use credentials for authenticated delivery');
    return await (await fetch(link.href, { credentials: 'include' })).json();
  });
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.map((item: { src: string }) => item.src)).toEqual(expect.arrayContaining(['/pwa-192.png', '/pwa-512.png']));
  for (const icon of ['/pwa-192.png', '/pwa-512.png']) expect((await page.request.get(origin + icon)).status()).toBe(200);

  await expect.poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toContain('/sw.js');
  const cacheAudit = await page.evaluate(async () => {
    const names = await caches.keys();
    const records: Array<{ cache: string; url: string }> = [];
    for (const name of names) for (const request of await (await caches.open(name)).keys()) records.push({ cache: name, url: request.url });
    return records;
  });
  expect(cacheAudit.length).toBeGreaterThan(0);
  for (const { url } of cacheAudit) {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(origin);
    expect(parsed.pathname).not.toMatch(/^\/remote\//);
    expect(parsed.pathname).not.toMatch(/^\/remote\/(?:api|settings|model-stats)(?:\/|$)/i);
    expect(parsed.pathname).not.toBe('/');
    expect(parsed.pathname).not.toContain('index.html');
  }
  expect(requests).toContain('/remote/settings');
  expect(requests).toContain('/remote/instances');
  await page.screenshot({ path: 'test-results/pwa-production-phone.png', fullPage: true });
});

test('offline fallback is static and secret-free; logout clears the shell and returns to login', async ({ managedContext: context }) => {
  const page = await context.newPage();
  await login(page);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBeTruthy();
  await page.context().setOffline(true);
  await page.goto('/').catch(() => {});
  const fallback = await page.locator('body').innerText().catch(() => '');
  expect(fallback).toMatch(/offline|reconnect/i);
  expect(fallback).not.toContain(SECRET);
  await page.context().setOffline(false);
  await page.goto('/');
  await page.getByRole('button', { name: /phone app/i }).click();
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/remote\/login$/);
  const jar = await context.cookies(origin);
  expect(jar.some(cookie => cookie.name === SESSION_COOKIE && cookie.value)).toBe(false);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('ember-shell-')).length)).toBe(0);
});

test('protected routes stay behind the login boundary and expiry is surfaced without exposing data', async ({ managedContext: context }) => {
  const page = await context.newPage();
  const unauthenticated = await page.request.get(origin + '/remote/settings', { maxRedirects: 0 });
  expect(unauthenticated.status()).toBe(302);
  const denied = await page.request.post(origin + '/remote/api', { data: { method: 'GET', path: '/sessions', instanceId: 'fixture' } });
  expect(denied.status()).toBe(401);
  expect((await denied.json()).code).toBe('session-expired');

  await login(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByText(/remote access/i)).toBeVisible();

  server.revokeRemoteSessions();
  const rejected = await page.evaluate(async () => { try { await window.ember.listInstances(); return false; } catch { return true; } });
  expect(rejected).toBe(true);
  await expect(settingsDialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /sign in to ember again/i })).toBeFocused();
  await expect(page.locator('body')).not.toContainText(/applies to this window|remote access password/i);
  const signIn = page.getByRole('button', { name: /go to sign in/i });
  await expect(signIn).toBeEnabled();
  await signIn.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/remote\/login$/);
});

test('waiting update obeys the reload guard and activation never reloads automatically', async ({ managedContext: context }) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const listeners = new Set<() => void>();
    const waiting = {
      state: 'installed',
      postMessage: (message: string) => {
        if (message !== 'ACTIVATE_UPDATE') throw new Error('Unexpected update command');
        waiting.state = 'activated';
        listeners.forEach(listener => listener());
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    const registration = { waiting, installing: null, addEventListener: () => {} };
    const container = {
      controller: null,
      register: async () => registration,
      addEventListener: () => {}, removeEventListener: () => {},
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    Object.defineProperty(window, '__pwaTestWaitingWorker', { configurable: true, value: waiting });
  });
  await login(page);
  await expect(page.getByRole('button', { name: /prepare update/i })).toBeVisible();
  await page.evaluate(() => window.addEventListener('ember:can-reload', event => event.preventDefault(), { once: true }));
  await page.getByRole('button', { name: /prepare update/i }).click();
  await expect(page.getByText(/finish active turns and resolve pending sends/i)).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __pwaTestWaitingWorker: { state: string } }).__pwaTestWaitingWorker.state)).toBe('installed');

  const navigations: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await page.getByRole('button', { name: /prepare update/i }).click();
  await expect(page.getByRole('button', { name: /refresh to use update/i })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __pwaTestWaitingWorker: { state: string } }).__pwaTestWaitingWorker.state)).toBe('activated');
  expect(navigations).toEqual([]);
});

test('plain HTTP shows install guidance because it is not a secure context', async ({ managedContext: context }) => {
  const page = await context.newPage();
  await page.route('http://ember-insecure.test/**', async route => {
    if (route.request().url().endsWith('/remote/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    const target = route.request().url().replace('http://ember-insecure.test', origin);
    const response = await page.request.fetch(target, { method: route.request().method(), headers: { ...route.request().headers(), host: '127.0.0.1:57823', origin: origin }, data: route.request().postData() ?? undefined, maxRedirects: 0 });
    await route.fulfill({ response, headers: { ...response.headers(), location: response.headers().location?.replace(origin, 'http://ember-insecure.test') ?? '' } });
  });
  await page.goto('http://ember-insecure.test/remote/login');
  await page.getByLabel(/password/i).fill('fixture-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/ember-insecure\.test\/$/);
  await expect(page.getByRole('button', { name: /phone app/i })).toBeVisible();
  await page.getByRole('button', { name: /phone app/i }).click();
  await expect(page.getByText(/this address uses http.*installation needs/i)).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => 'serviceWorker' in navigator)).toBe(false);
});
