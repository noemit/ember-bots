import { expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { createRemoteServer, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../electron/remoteServer';
import { isTrustedHttpsProxy, parseRemoteProxyOrigin, remoteBindAddress } from '../electron/remoteProxy';
import { withoutDesktopOnlySettings } from '../electron/transport';
import { RemoteListener } from '../electron/remoteListener';

const origin = 'https://ember.example.ts.net';
const proxyHeaders = { Host: 'ember.example.ts.net', 'X-Forwarded-Proto': 'https', Origin: origin };
const fixture = async (proxyOrigin?: string) => {
  const listeners = new Set<(event: unknown) => void>();
  let writes = 0;
  const server = createRemoteServer(tmpdir(), {
    modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
    listInstances: async () => [], getSettings: () => ({ theme: 'stone' }),
    setSettings: (patch) => { writes++; return patch; },
    request: async () => ({ ok: true, status: 200, data: {} }),
    verifyPassword: async (password) => password === 'fixture-password',
    subscribeEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    eventStatus: () => ({ fixture: true }),
  }, { proxyOrigin });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const url = `http://127.0.0.1:${address.port}`;
  const call = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) => fetch(url + path, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = (headers: Record<string, string> = proxyHeaders) => call('/remote/login', headers, 'POST', { password: 'fixture-password' });
  return { server, call, login, listeners, writes: () => writes, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
};

test('proxy setting accepts only HTTPS origins and chooses loopback without network discovery', () => {
  expect(parseRemoteProxyOrigin('https://EMBER.example.ts.net:443/')).toBe(origin);
  expect(parseRemoteProxyOrigin('')).toBeUndefined();
  for (const invalid of ['http://ember.example', 'https://a/path', 'https://u:p@a', 'https://a?q=x', 'https://a#x', null, 12]) {
    expect(() => parseRemoteProxyOrigin(invalid)).toThrow();
  }
  let discoveries = 0;
  const discover = () => { discoveries++; return '100.64.0.1'; };
  expect(remoteBindAddress(origin, discover)).toBe('127.0.0.1');
  expect(discoveries).toBe(0);
  expect(remoteBindAddress(undefined, discover)).toBe('100.64.0.1');
  expect(() => remoteBindAddress('not an origin', discover)).toThrow();
  expect(discoveries).toBe(1);
  expect(withoutDesktopOnlySettings({ remoteAccessProxyOrigin: origin, remoteAccessEnabled: true, remotePassword: 'new', theme: 'stone' })).toEqual({ theme: 'stone' });
});

test('HTTPS proxy trust requires configured host, exact protocol and verified loopback peer', () => {
  expect(isTrustedHttpsProxy(origin, '127.0.0.1', 'ember.example.ts.net', 'https')).toBe(true);
  for (const peer of ['100.64.0.1', '192.168.1.2', '127.0.0.2', undefined]) {
    expect(isTrustedHttpsProxy(origin, peer, 'ember.example.ts.net', 'https')).toBe(false);
  }
  for (const proto of ['http', 'https,http', 'https, https', ['https'], undefined]) {
    expect(isTrustedHttpsProxy(origin, '127.0.0.1', 'ember.example.ts.net', proto)).toBe(false);
  }
  expect(isTrustedHttpsProxy(origin, '127.0.0.1', 'evil.ts.net', 'https')).toBe(false);
});

test('proxy login rejects spoofing, sets secure host cookie, and validates writes against configured origin', async () => {
  const f = await fixture(origin);
  try {
    for (const headers of [{}, { Host: 'ember.example.ts.net' }, { ...proxyHeaders, Host: 'evil.ts.net' }, { ...proxyHeaders, 'X-Forwarded-Proto': 'https, http' }]) {
      expect((await f.login(headers)).status).toBe(400);
    }
    for (const headers of [
      { ...proxyHeaders, Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
      { ...proxyHeaders, Origin: 'http://ember.example.ts.net' },
      { ...proxyHeaders, 'Sec-Fetch-Site': 'cross-site' },
    ]) expect((await f.login(headers)).status).toBe(403);
    const login = await f.login();
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const raw = login.headers.get('set-cookie')!;
    expect(raw).toContain('__Host-ember_remote_session=');
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) expect(raw).toContain(flag);
    const headers = { ...proxyHeaders, Cookie: raw.split(';')[0] };
    expect((await f.call('/remote/settings', headers)).status).toBe(200);
    expect((await f.call('/remote/settings', { ...headers, Cookie: headers.Cookie.replace('__Host-', '') })).status).toBe(302);
    expect((await f.call('/remote/settings', { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await f.call('/remote/settings', { ...headers, Origin: 'https://evil.example', Forwarded: 'proto=https;host=evil.example' }, 'POST', {})).status).toBe(403);
    expect(f.writes()).toBe(0);
    expect((await f.call('/remote/settings', headers, 'POST', {})).status).toBe(200);
    expect(f.writes()).toBe(1);
    const logout = await f.call('/remote/logout', headers, 'POST');
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await f.call('/remote/settings', headers)).status).toBe(302);
  } finally { await f.close(); }
});

test('plain HTTP ignores forged forwarding headers and does not issue secure cookies', async () => {
  const f = await fixture();
  try {
    const login = await f.login({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'ember.example.ts.net', Forwarded: 'proto=https;host=ember.example.ts.net' });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie.startsWith('ember_remote_session=')).toBe(true);
    expect(cookie).not.toContain('Secure');
    expect((await f.call('/remote/settings', { Cookie: cookie.split(';')[0] })).status).toBe(200);
    expect((await f.login(proxyHeaders)).status).toBe(403);
  } finally { await f.close(); }
});

for (const reason of ['logout', 'idle expiry', 'absolute expiry'] as const) {
  test(`trusted HTTPS SSE uses no-store and revokes on ${reason}`, async () => {
    const f = await fixture(origin);
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      const login = await f.login();
      const headers = { ...proxyHeaders, Cookie: login.headers.get('set-cookie')!.split(';')[0] };
      const stream = await f.call('/remote/events', headers);
      expect(stream.headers.get('cache-control')).toContain('no-store');
      const reader = stream.body!.getReader();
      await reader.read();
      expect(f.listeners.size).toBe(1);
      if (reason === 'logout') await f.call('/remote/logout', headers, 'POST');
      else {
        const later = Date.now() + (reason === 'idle expiry' ? SESSION_IDLE_MS : SESSION_ABSOLUTE_MS) + 1;
        clock = spyOn(Date, 'now').mockReturnValue(later);
        for (const listener of [...f.listeners]) listener({ type: 'must-not-arrive' });
      }
      expect(f.listeners.size).toBe(0);
      expect((await reader.read()).done).toBe(true);
      expect((await f.call('/remote/events', { ...headers, Accept: 'text/event-stream' })).status).toBe(401);
    } finally { clock?.mockRestore(); await f.close(); }
  });
}

test('forged forwarded client IPs cannot bypass the proxy login limit', async () => {
  const f = await fixture(origin);
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const denied = await f.call('/remote/login', { ...proxyHeaders, 'X-Forwarded-For': '192.0.2.' + attempt }, 'POST', { password: 'wrong' });
      expect(denied.status).toBe(401);
    }
    const blocked = await f.login({ ...proxyHeaders, 'X-Forwarded-For': '203.0.113.1' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
  } finally { await f.close(); }
});

test('listener replacement drops trusted HTTPS streams and never carries sessions into the replacement', async () => {
  const old = await fixture(origin);
  const replacement = await fixture(origin);
  const listener = new RemoteListener(() => ({ server: old.server, address: '127.0.0.1' }));
  try {
    const login = await old.login();
    const headers = { ...proxyHeaders, Cookie: login.headers.get('set-cookie')!.split(';')[0] };
    const stream = await old.call('/remote/events', headers);
    const reader = stream.body!.getReader();
    await reader.read();
    expect(old.listeners.size).toBe(1);
    listener.configure(true);
    const ended = reader.read().then((result) => result.done, () => true);
    const closed = new Promise<void>((resolve) => old.server.once('close', resolve));
    // main uses this path for password/origin changes before starting the new listener.
    listener.dispose();
    expect(await ended).toBe(true);
    await closed;
    expect(old.listeners.size).toBe(0);
    expect((await replacement.call('/remote/events', { ...headers, Accept: 'text/event-stream' })).status).toBe(401);
  } finally { await old.close(); await replacement.close(); }
});
