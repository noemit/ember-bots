import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { serviceWorkerSource } from '../scripts/pwa-build.mjs';

type WorkerEvent = { waitUntil: (promise: Promise<unknown>) => void; data: string; ports: { postMessage: (value: string) => void }[]; request: { url: string; mode: string; method: string }; respondWith: (value: Promise<unknown>) => void };
const harness = () => {
  const listeners: Record<string, (event: WorkerEvent) => void> = {};
  const stored = new Map<string, Response>();
  const cacheNames = new Set(['ember-shell-old', 'unrelated-cache']);
  const cache = { put: async (key: string, value: Response) => { stored.set(key, value); } };
  let activated = false;
  const self = {
    location: { origin: 'https://ember.test' },
    clients: { claim: async () => {} },
    addEventListener: (name: string, fn: (event: WorkerEvent) => void) => { listeners[name] = fn; },
    skipWaiting: () => { activated = true; },
  };
  runInNewContext(serviceWorkerSource(['/assets/app-abc.js', '/offline.html'], 'test'), {
    self, URL, Response, fetch: async (url: string) => new Response(url, { headers: { 'Content-Type': url.endsWith('.html') ? 'text/html' : 'text/javascript' } }),
    caches: {
      open: async (name: string) => { cacheNames.add(name); return cache; },
      keys: async () => [...cacheNames],
      delete: async (name: string) => { cacheNames.delete(name); stored.clear(); },
      match: async (name: string) => stored.get(name),
    },
  });
  const dispatch = async (name: string, rest = {}) => {
    let waiting: Promise<unknown> = Promise.resolve();
    listeners[name]({ waitUntil: (promise: Promise<unknown>) => { waiting = promise; }, ...rest });
    await waiting;
  };
  const intercepts = (pathname: string, mode = 'cors', method = 'GET') => {
    let intercepted = false;
    listeners.fetch({ request: { url: `https://ember.test${pathname}`, mode, method }, respondWith: (value: Promise<unknown>) => { intercepted = true; void value.catch(() => {}); } });
    return intercepted;
  };
  return { stored, cacheNames, dispatch, intercepts, activated: () => activated };
};

describe('private PWA shell', () => {
  test('stores only enumerated build assets, never runtime responses', async () => {
    const h = harness();
    await h.dispatch('install');
    expect([...h.stored.keys()]).toEqual(['/assets/app-abc.js', '/offline.html']);
    for (const path of ['/remote/api', '/remote/pi', '/remote/events', '/remote/login', '/remote/logout', '/remote/settings', '/remote/model-stats', '/conversations/1/documents/read', '/conversations/1/documents/resolve', '/?docPopout=1&popoutId=popout_1234', '/private.png', '/assets/unlisted.js', '/assets/app-abc.js?private=1']) {
      expect(h.intercepts(path)).toBe(false);
    }
    expect(h.intercepts('/assets/app-abc.js')).toBe(true);
    expect(h.intercepts('/remote/login', 'navigate')).toBe(false);
    expect(h.intercepts('/assets/app-abc.js', 'cors', 'POST')).toBe(false);
  });
  test('update waits for explicit action and activation bounds old versions', async () => {
    const h = harness();
    await h.dispatch('install');
    expect(h.activated()).toBe(false);
    await h.dispatch('message', { data: 'ACTIVATE_UPDATE' });
    expect(h.activated()).toBe(true);
    await h.dispatch('activate');
    expect([...h.cacheNames].sort()).toEqual(['ember-shell-test', 'unrelated-cache']);
  });
  test('logout/expiry clears shell versions and disables interception of shell assets', async () => {
    const h = harness();
    await h.dispatch('install');
    await h.dispatch('message', { data: 'CLEAR_SHELL', ports: [] });
    expect([...h.cacheNames]).toEqual(['unrelated-cache']);
    expect(h.intercepts('/assets/app-abc.js')).toBe(false);
  });
});
