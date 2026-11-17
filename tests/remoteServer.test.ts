import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRemoteServer } from '../electron/remoteServer';
import { hashRemotePassword, verifyRemotePassword } from '../electron/remoteAuth';
import { PiClient } from '../electron/piClient';

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-remote-auth-'));
  const password = randomBytes(24).toString('hex');
  const hash = await hashRemotePassword(password);
  const writes: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const server = createRemoteServer(directory, {
    modelStats: {
      list: async () => [],
      observe: async () => { writes.push('observe'); return []; },
      rate: async () => { writes.push('rate'); },
      clear: async () => { writes.push('clear'); },
    },
    listInstances: async () => [],
    getSettings: () => ({ theme: 'stone' }),
    setSettings: async (patch) => { writes.push('settings'); return patch; },
    request: async () => { writes.push('api'); return { ok: true, status: 200, data: {} }; },
    piRequest: async (endpointId, path, init) => {
      writes.push(`pi:${endpointId}:${path}`);
      return { ok: true, status: 200, data: { endpointId, path, init } };
    },
    activityList: async () => { writes.push('activity:list'); return { entries: [], cursor: undefined }; },
    activitySearch: async () => { writes.push('activity:search'); return { entries: [], cursor: undefined }; },
    activityDays: async () => { writes.push('activity:days'); return ['2026-03-30']; },
    verifyPassword: (value) => verifyRemotePassword(value, hash),
    subscribeEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    eventStatus: () => ({ fixture: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const url = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => fetch(`${url}${path}`, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    request, url, password, writes, listeners,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    },
  };
};

test('remote routes reject anonymous writes and await authenticated settings writes', async () => {
  const f = await fixture();
  try {
    for (const [path, method] of [['/remote/settings', 'POST'], ['/remote/api', 'POST'], ['/remote/model-stats', 'POST'], ['/remote/model-stats', 'DELETE'], ['/remote/model-rating', 'POST']]) {
      expect((await f.request(path, method, {})).status).toBe(401);
    }
    expect(f.writes).toEqual([]);
    expect((await f.request('/remote/events')).status).toBe(302);
    const login = await f.request('/remote/login', 'POST', { password: f.password });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = setCookie.split(';')[0];
    const saved = await f.request('/remote/settings', 'POST', { theme: 'clay' }, cookie);
    expect(await saved.json()).toEqual({ theme: 'clay' });
    expect(saved.headers.get('cache-control')).toBe('no-store');
    await f.request('/remote/logout', 'POST', undefined, cookie);
    expect((await f.request('/remote/settings', 'POST', {}, cookie)).status).toBe(401);
  } finally {
    await f.close();
  }
});

test('remote login rate limiting remains enforced', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) expect((await f.request('/remote/login', 'POST', { password: 'wrong' })).status).toBe(401);
    const blocked = await f.request('/remote/login', 'POST', { password: f.password });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test('expired sessions cannot receive further event hints', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const login = await f.request('/remote/login', 'POST', { password: f.password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const stream = await fetch(`${f.url}/remote/events`, { headers: { Cookie: cookie }, signal: abort.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    const expiredAt = Date.now() + 31 * 86_400_000;
    const clock = spyOn(Date, 'now').mockReturnValue(expiredAt);
    try {
      [...f.listeners].forEach((listener) => listener({ type: 'must-not-arrive' }));
    } finally {
      clock.mockRestore();
    }
    expect((await reader.read()).done).toBe(true);
    expect(f.listeners.size).toBe(0);
  } finally {
    abort.abort();
    await f.close();
  }
});

test('logout closes existing authenticated event streams', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const login = await f.request('/remote/login', 'POST', { password: f.password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const stream = await fetch(`${f.url}/remote/events`, { headers: { Cookie: cookie }, signal: abort.signal });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ember:stream-status');
    expect(f.listeners.size).toBe(1);
    expect((await f.request('/remote/logout', 'POST', undefined, cookie)).status).toBe(200);
    const closed = await Promise.race([reader.read().then(({ done }) => done), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
    expect(closed).toBe(true);
    expect(f.listeners.size).toBe(0);
  } finally {
    abort.abort();
    await f.close();
  }
});

test('proxies piRequest, eventStatus, and activity endpoints', async () => {
  const f = await fixture();
  try {
    for (const [path, method] of [
      ['/remote/pi', 'POST'],
      ['/remote/events/status', 'GET'],
      ['/remote/activity/list', 'POST'],
      ['/remote/activity/search', 'POST'],
      ['/remote/activity/days', 'GET'],
    ]) {
      const isGet = method === 'GET';
      expect((await f.request(path, method, isGet ? undefined : {})).status).toBe(isGet ? 302 : 401);
    }

    const login = await f.request('/remote/login', 'POST', { password: f.password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const statusRes = await f.request('/remote/events/status', 'GET', undefined, cookie);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ fixture: true });

    const piRes = await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: '/conversations', init: { method: 'GET' } }, cookie);
    expect(piRes.status).toBe(200);
    const piData = await piRes.json() as { ok: boolean; status: number; data: unknown };
    expect(piData.ok).toBe(true);
    expect(f.writes).toContain('pi:pi:test:/conversations');

    // Metadata and every credential/peer route remain desktop-only, including encoded, backslash, dot-segment, and double-slash paths.
    for (const path of [
      '/alignment',
      '/alignment/',
      '/alignment/connections',
      '/alignment/share',
      '/alignment/import',
      '/alignment%2Fshare',
      '/%61lignment/share',
      '//alignment/share',
      '///alignment//share',
      '/\\alignment/connections',
      '/%5calignment/connections',
      '/%2e%2e/alignment/share',
      '/%2e/alignment/share',
      '/alignment/../alignment/share',
      '/conversations/../alignment/share',
      '/conversations/%2e%2e/alignment/share',
      '/conversations%2f%2e%2e%2falignment/share',
      '/directory/peers',
      '/directory/peers/',
      '/directory%2Fpeers',
      '/%64irectory/peers',
      '//directory/peers',
      '/\\directory/peers',
      '/%2e%2e/directory/peers',
      '/directory/../directory/peers',
      '/conversations/%2e%2e/directory/peers',
    ]) {
      const blocked = await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path, init: { method: path.includes('peers') ? 'PUT' : path === '/alignment' ? 'GET' : 'POST' } }, cookie);
      expect(blocked.status).toBe(403);
      const blockedBody = (await blocked.json()) as { error?: string };
      expect(blockedBody.error).toContain('desktop app');
      expect(blockedBody.error).not.toContain('!');
      expect(f.writes.some((entry) => entry.startsWith('pi:') && entry !== 'pi:pi:test:/conversations')).toBe(false);
    }
    const peersGet = await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: '/directory/peers', init: { method: 'GET' } }, cookie);
    expect(peersGet.status).toBe(403);
    expect((await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: '/directory', init: { method: 'GET' } }, cookie)).status).toBe(200);
    expect((await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: '/directories', init: { method: 'GET' } }, cookie)).status).toBe(200);

    // Consecutive slashes normalize to the canonical pathname while preserving encoded segment characters.
    expect((await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: '/conversations//12?limit=8', init: { method: 'GET' } }, cookie)).status).toBe(200);
    expect(f.writes).toContain('pi:pi:test:/conversations/12?limit=8');
    expect((await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: '/approvals/12/approval%2Fkey/preview', init: { method: 'POST' } }, cookie)).status).toBe(200);
    expect(f.writes).toContain('pi:pi:test:/approvals/12/approval%2Fkey/preview');

    // Host configuration commands and draft credential probes have no remote HTTP surface.
    for (const path of ['/remote/kiln-sharing', '/remote/pi/test', '/remote/local-harness-token']) {
      expect((await f.request(path, 'POST', { action: 'enable' }, cookie)).status).toBe(405);
    }

    // Invalid pi request validation: empty, missing slash, //, backslashes, control chars, #, dot segments, malformed %.
    expect((await f.request('/remote/pi', 'POST', { endpointId: '', path: '/foo' }, cookie)).status).toBe(400);
    const writesBeforeInvalid = f.writes.length;
    for (const badPath of [
      '',
      'no-slash',
      '//conversations',
      '//evil.example/conversations',
      '/\\conversations',
      '/conversations\\12',
      '/conversations%5c12',
      '/conversations\x00',
      '/conversations\r\n',
      '/conversations\x7f',
      '/conversations%00',
      '/conversations#frag',
      '/conversations?limit=1#frag',
      '/.',
      '/..',
      '/conversations/./entries',
      '/conversations/../models',
      '/alignment/../conversations',
      '/%2e',
      '/%2e%2e',
      '/%2e%2e/admin',
      '/%2E%2e/admin',
      '/conversations/%2e%2e/models',
      '/conversations%2f%2e%2e%2fmodels',
      '/%ZZ',
      '/conversations/%E0%A4%A',
      '/alignment/%ZZ',
      '/conversations?cursor=%ZZ',
    ]) {
      const invalid = await f.request('/remote/pi', 'POST', { endpointId: 'pi:test', path: badPath }, cookie);
      expect(invalid.status).toBe(400);
    }
    expect(f.writes.length).toBe(writesBeforeInvalid);

    const actList = await f.request('/remote/activity/list', 'POST', { limit: 10 }, cookie);
    expect(actList.status).toBe(200);
    expect(f.writes).toContain('activity:list');

    const actSearch = await f.request('/remote/activity/search', 'POST', { query: 'test' }, cookie);
    expect(actSearch.status).toBe(200);
    expect(f.writes).toContain('activity:search');

    const actDays = await f.request('/remote/activity/days', 'GET', undefined, cookie);
    expect(actDays.status).toBe(200);
    expect(await actDays.json()).toEqual(['2026-03-30']);
  } finally {
    await f.close();
  }
});

test('authenticated remote browsers have no host update or installer routes', async () => {
  const f = await fixture();
  try {
    const login = await f.request('/remote/login', 'POST', { password: f.password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    for (const path of ['/remote/updates', '/remote/updates/action', '/remote/updates:action', '/remote/check-update']) {
      expect([404, 405]).toContain((await f.request(path, 'POST', { action: 'restart' }, cookie)).status);
    }
    const bridge = await readFile(new URL('../src/remoteBridge.ts', import.meta.url), 'utf8');
    expect(bridge).not.toContain('desktopUpdates: true');
    expect(bridge).not.toContain('updateAction');
    expect(f.writes).toEqual([]);
  } finally { await f.close(); }
});

test('/remote/pi and PiClient evaluate the same canonical pathname and confine subpath endpoints', async () => {
  const upstreamSeen: Array<{ pathname: string; search: string; auth: string | null }> = [];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      upstreamSeen.push({
        pathname: url.pathname,
        search: url.search,
        auth: request.headers.get('authorization'),
      });
      return Response.json({ ok: true, pathname: url.pathname, search: url.search });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'ember-remote-pi-subpath-'));
  const password = randomBytes(24).toString('hex');
  const hash = await hashRemotePassword(password);
  const client = new PiClient(() => {}, (id) =>
    id === 'pi:subpath'
      ? { id: 'pi:subpath', label: 'Subpath Kiln', url: `http://127.0.0.1:${upstream.port}/kiln/`, token: 'subpath-bearer-secret' }
      : undefined
  );
  const server = createRemoteServer(directory, {
    modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
    listInstances: async () => [],
    getSettings: () => ({ theme: 'stone' }),
    setSettings: async (patch) => patch,
    request: async () => ({ ok: true, status: 200, data: {} }),
    piRequest: (endpointId, reqPath, init) => client.request(endpointId, reqPath, init),
    verifyPassword: (value) => verifyRemotePassword(value, hash),
    subscribeEvents: () => () => {},
    eventStatus: () => ({}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const remoteUrl = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${remoteUrl}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const postPi = (path: string) =>
      fetch(`${remoteUrl}/remote/pi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ endpointId: 'pi:subpath', path, init: { method: 'GET' } }),
      });

    for (const blockedPath of ['//alignment/share', '/\\alignment/connections', '/%2e%2e/alignment/share', '/alignment/../alignment/share']) {
      expect((await postPi(blockedPath)).status).toBe(403);
    }
    for (const escapePath of ['/%2e%2e/admin', '/../admin', '//127.0.0.1/admin', '/\\admin', '/conversations/%ZZ']) {
      expect((await postPi(escapePath)).status).toBe(400);
    }
    expect(upstreamSeen).toHaveLength(0);

    const allowed = await postPi('/conversations//42?limit=1');
    expect(allowed.status).toBe(200);
    expect(upstreamSeen).toEqual([
      { pathname: '/kiln/conversations/42', search: '?limit=1', auth: 'Bearer subpath-bearer-secret' },
    ]);
  } finally {
    client.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    upstream.stop(true);
    await rm(directory, { recursive: true });
  }
});
