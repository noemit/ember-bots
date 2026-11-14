import { createHash } from 'node:crypto';

/** Deliberately not a runtime URL pattern: only these build outputs may enter CacheStorage. */
export const pwaBuild = () => ({
  name: 'ember-private-pwa',
  apply: 'build',
  generateBundle(_options, bundle) {
    const assets = Object.keys(bundle).filter((name) => /^assets\/[\w.-]+\.(?:js|css|woff2?|png|svg)$/.test(name)).map((name) => `/${name}`);
    assets.push('/offline.html', '/manifest.webmanifest', '/pwa-192.png', '/pwa-512.png', '/apple-touch-icon.png');
    const version = createHash('sha256').update(JSON.stringify(bundle)).digest('hex').slice(0, 16);
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(assets, version) });
  },
});

export function serviceWorkerSource(assets, version) {
  return `/* Ember app-shell only. No API, authentication, conversation or navigation responses are stored. */
const CACHE = 'ember-shell-${version}';
const ASSETS = new Set(${JSON.stringify(assets)});
let enabled = true;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const asset of ASSETS) {
      if (!enabled) return;
      const response = await fetch(asset, {cache:'no-store', credentials:'same-origin', redirect:'error'});
      if (!enabled) return;
      if (!response.ok || response.redirected) throw new Error('Shell asset unavailable');
      const type = response.headers.get('content-type') || '';
      if (asset !== '/offline.html' && type.includes('text/html')) throw new Error('Not a shell asset');
      await cache.put(asset, response);
    }
  })());
});
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('ember-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('message', event => {
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
  if (event.data === 'CLEAR_SHELL') {
    enabled = false;
    event.waitUntil((async () => {
      for (const key of await caches.keys()) if (key.startsWith('ember-shell-')) await caches.delete(key);
      event.ports[0]?.postMessage('cleared');
    })());
  }
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  // Never intercept auth, SSE or any remote data, including private images.
  if (url.pathname.startsWith('/remote/')) return;
  if (event.request.mode === 'navigate') {
    // Navigation HTML is always network-only. Offline fallback is a static, secret-free page.
    if (url.pathname === '/') event.respondWith(fetch(event.request).catch(async () =>
      await caches.match('/offline.html') || new Response('Ember is offline. Reconnect and reopen Ember.', {status:503,headers:{'Content-Type':'text/plain'}})));
    return;
  }
  if (!ASSETS.has(url.pathname) || !enabled) return;
  event.respondWith((async () => {
    const cached = await caches.match(url.pathname);
    return cached || fetch(event.request);
  })());
});
`;
}
