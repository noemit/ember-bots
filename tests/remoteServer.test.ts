import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createRemoteServer,
  MAX_ACTIVE_SESSIONS,
  MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_BODY_BYTES,
  MAX_LOGIN_VERIFY_IN_FLIGHT,
  MAX_LOGIN_VERIFY_QUEUE,
  MAX_TRACKED_ATTEMPTS,
} from '../electron/remoteServer';
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
  }, { failedLoginDelayMs: 0 });
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

test('/remote/login rejects bodies over 4 KB with 413 before invoking verifyPassword', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-login-body-cap-'));
  let verifyCalls = 0;
  const server = createRemoteServer(directory, {
    modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
    listInstances: async () => [],
    getSettings: () => ({}),
    setSettings: async (patch) => patch,
    request: async () => ({ ok: true, status: 200, data: {} }),
    verifyPassword: async (candidate) => {
      verifyCalls += 1;
      return candidate === 'right-password';
    },
    subscribeEvents: () => () => {},
    eventStatus: () => ({}),
  }, { failedLoginDelayMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    for (let i = 0; i < 10; i += 1) {
      const tooBig = await fetch(`${url}/remote/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'right-password', junk: 'a'.repeat(MAX_LOGIN_BODY_BYTES) }),
      });
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toEqual({ error: 'Request body is too large' });
    }
    expect(verifyCalls).toBe(0);

    const exactFit = JSON.stringify({ password: 'right-password', pad: 'b'.repeat(MAX_LOGIN_BODY_BYTES - 40) });
    expect(Buffer.byteLength(exactFit)).toBeLessThanOrEqual(MAX_LOGIN_BODY_BYTES);
    const ok = await fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exactFit,
    });
    expect(ok.status).toBe(200);
    expect(verifyCalls).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});

test('parallel /remote/login bursts cannot bypass MAX_LOGIN_ATTEMPTS or exceed global verifyPassword concurrency', async () => {
  expect(MAX_LOGIN_VERIFY_IN_FLIGHT).toBe(2);
  expect(MAX_LOGIN_VERIFY_QUEUE).toBe(4);
  expect(MAX_TRACKED_ATTEMPTS).toBe(2048);
  expect(MAX_ACTIVE_SESSIONS).toBe(2048);

  const directory = await mkdtemp(join(tmpdir(), 'ember-login-concurrency-'));
  const origin = 'https://ember.example.ts.net';
  const proxyHeaders = { Host: 'ember.example.ts.net', 'X-Forwarded-Proto': 'https', Origin: origin };
  let inFlight = 0;
  let peakInFlight = 0;
  let verifyCalls = 0;
  let holdGate = false;
  const gateResolvers: Array<() => void> = [];

  const server = createRemoteServer(directory, {
    modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
    listInstances: async () => [],
    getSettings: () => ({}),
    setSettings: async (patch) => patch,
    request: async () => ({ ok: true, status: 200, data: {} }),
    verifyPassword: async (candidate) => {
      verifyCalls += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (holdGate) {
          await new Promise<void>((resolve) => { gateResolvers.push(resolve); });
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 15));
        }
        return candidate === 'correct-password';
      } finally {
        inFlight -= 1;
      }
    },
    subscribeEvents: () => () => {},
    eventStatus: () => ({}),
  }, { proxyOrigin: origin, failedLoginDelayMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const url = `http://127.0.0.1:${address.port}`;
  const loginFrom = (ip: string, password: string) =>
    fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders, 'X-Forwarded-For': ip },
      body: JSON.stringify({ password }),
    });

  try {
    // 1. Burst of 20 parallel requests from a single client IP: atomic inFlight + count prevents testing > MAX_LOGIN_ATTEMPTS.
    const wave1 = await Promise.all(Array.from({ length: 20 }, (_, i) => loginFrom('198.51.100.10', `guess-${i}`)));
    const wave1Denied = wave1.filter((r) => r.status === 401).length;
    const wave1Limited = wave1.filter((r) => r.status === 429).length;
    expect(wave1Denied + wave1Limited).toBe(20);
    expect(verifyCalls).toBeLessThanOrEqual(MAX_LOGIN_ATTEMPTS);
    expect(peakInFlight).toBeLessThanOrEqual(MAX_LOGIN_VERIFY_IN_FLIGHT);

    // Send a second parallel burst from the same IP to consume any remaining attempts shed by the global queue:
    // total verifyPassword executions for 198.51.100.10 must never exceed MAX_LOGIN_ATTEMPTS (8), and valid login is then locked out.
    const wave2 = await Promise.all(Array.from({ length: 10 }, (_, i) => loginFrom('198.51.100.10', `second-${i}`)));
    expect(wave2.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    expect(verifyCalls).toBe(MAX_LOGIN_ATTEMPTS);
    const lockedOut = await loginFrom('198.51.100.10', 'correct-password');
    expect(lockedOut.status).toBe(429);
    expect(Number(lockedOut.headers.get('retry-after'))).toBeGreaterThan(2);

    // 2. Global queue shedding across distinct client IPs: 2 in flight + 4 queued = 6 accepted; >= 7th immediately gets 429 Retry-After: 2.
    holdGate = true;
    peakInFlight = 0;
    const pendingTwelve = Array.from({ length: 12 }, (_, i) => loginFrom(`203.0.113.${i + 1}`, 'wrong'));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(inFlight).toBe(MAX_LOGIN_VERIFY_IN_FLIGHT);

    // Wait for the 6 overflow requests to resolve immediately while the 2 in-flight + 4 queued remain held!
    let immediate429 = 0;
    for (const promise of pendingTwelve) {
      const settled = await Promise.race([
        promise.then((res) => ({ done: true as const, res })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 5)),
      ]);
      if (settled.done) {
        expect(settled.res.status).toBe(429);
        expect(settled.res.headers.get('retry-after')).toBe('2');
        immediate429 += 1;
      }
    }
    expect(immediate429).toBe(12 - (MAX_LOGIN_VERIFY_IN_FLIGHT + MAX_LOGIN_VERIFY_QUEUE));

    holdGate = false;
    while (gateResolvers.length > 0) gateResolvers.shift()!();
    const allTwelve = await Promise.all(pendingTwelve);
    expect(peakInFlight).toBeLessThanOrEqual(MAX_LOGIN_VERIFY_IN_FLIGHT);
    expect(allTwelve.filter((r) => r.status === 401)).toHaveLength(MAX_LOGIN_VERIFY_IN_FLIGHT + MAX_LOGIN_VERIFY_QUEUE);
    expect(allTwelve.filter((r) => r.status === 429)).toHaveLength(12 - (MAX_LOGIN_VERIFY_IN_FLIGHT + MAX_LOGIN_VERIFY_QUEUE));
  } finally {
    holdGate = false;
    while (gateResolvers.length > 0) gateResolvers.shift()!();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});

test('proxyOrigin loopback mode keys rate-limits by X-Forwarded-For / CF-Connecting-IP and delays failed attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-proxy-buckets-'));
  const origin = 'https://ember.example.ts.net';
  const proxyHeaders = { Host: 'ember.example.ts.net', 'X-Forwarded-Proto': 'https', Origin: origin };
  const server = createRemoteServer(directory, {
    modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
    listInstances: async () => [],
    getSettings: () => ({}),
    setSettings: async (patch) => patch,
    request: async () => ({ ok: true, status: 200, data: {} }),
    verifyPassword: async (candidate) => candidate === 'owner-secret',
    subscribeEvents: () => () => {},
    eventStatus: () => ({}),
  }, { proxyOrigin: origin, failedLoginDelayMs: 60 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const startedFailure = performance.now();
    const failedOnce = await fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders, 'CF-Connecting-IP': '198.51.100.200' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    const failureDuration = performance.now() - startedFailure;
    expect(failedOnce.status).toBe(401);
    expect(failureDuration).toBeGreaterThanOrEqual(45);

    for (let i = 1; i < MAX_LOGIN_ATTEMPTS; i += 1) {
      const res = await fetch(`${url}/remote/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...proxyHeaders, 'CF-Connecting-IP': '198.51.100.200' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      expect(res.status).toBe(401);
    }
    const cfBlocked = await fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders, 'CF-Connecting-IP': '198.51.100.200' },
      body: JSON.stringify({ password: 'owner-secret' }),
    });
    expect(cfBlocked.status).toBe(429);

    // Owner on another IP (or local proxy without forwarded IP) is never locked out by the scanner!
    const ownerStarted = performance.now();
    const ownerOk = await fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders, 'X-Forwarded-For': '203.0.113.42, 10.0.0.1' },
      body: JSON.stringify({ password: 'owner-secret' }),
    });
    expect(ownerOk.status).toBe(200);
    expect(performance.now() - ownerStarted).toBeLessThan(55);

    const noForwardHeaderOk = await fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders },
      body: JSON.stringify({ password: 'owner-secret' }),
    });
    expect(noForwardHeaderOk.status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});

test('attempts and sessions maps evict oldest entries above their configured bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-map-bounds-'));
  const origin = 'https://ember.example.ts.net';
  const proxyHeaders = { Host: 'ember.example.ts.net', 'X-Forwarded-Proto': 'https', Origin: origin };
  const listeners = new Set<(event: unknown) => void>();
  const server = createRemoteServer(directory, {
    modelStats: { list: async () => [], observe: async () => [], clear: async () => {} },
    listInstances: async () => [],
    getSettings: () => ({ ok: true }),
    setSettings: async (patch) => patch,
    request: async () => ({ ok: true, status: 200, data: {} }),
    verifyPassword: async (candidate) => candidate === 'valid-pass',
    subscribeEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    eventStatus: () => ({ fixture: true }),
  }, { proxyOrigin: origin, failedLoginDelayMs: 0, maxTrackedAttempts: 4, maxSessions: 3 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const url = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();

  const postLogin = (ip: string, password: string) =>
    fetch(`${url}/remote/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders, 'X-Forwarded-For': ip },
      body: JSON.stringify({ password }),
    });

  try {
    // Lock out IP #1 and IP #2 (8 failed attempts each).
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i += 1) {
        expect((await postLogin(ip, 'wrong')).status).toBe(401);
      }
      expect((await postLogin(ip, 'valid-pass')).status).toBe(429);
    }
    // Insert 3 more distinct client buckets (total 5 > maxTrackedAttempts=4): oldest ('192.0.2.1') is evicted, '192.0.2.2' remains locked out!
    for (const ip of ['192.0.2.3', '192.0.2.4', '192.0.2.5']) {
      expect((await postLogin(ip, 'wrong')).status).toBe(401);
    }
    expect((await postLogin('192.0.2.2', 'valid-pass')).status).toBe(429);
    expect((await postLogin('192.0.2.1', 'valid-pass')).status).toBe(200);

    // Sessions map bound (maxSessions=3): create sessions S1, S2, S3 (note '192.0.2.1' login above already created 1 session; create 3 clean ones).
    const cookies: string[] = [];
    for (const ip of ['203.0.113.10', '203.0.113.11', '203.0.113.12']) {
      const res = await postLogin(ip, 'valid-pass');
      expect(res.status).toBe(200);
      cookies.push(res.headers.get('set-cookie')!.split(';')[0]);
    }
    // Open an SSE stream on oldest session cookies[0], then touch cookies[1] so cookies[0] stays oldest? Wait: opening SSE touches cookies[0], making cookies[1] oldest!
    // Touch cookies[1] and cookies[2] afterwards so cookies[0] becomes the oldest idle session again:
    const sse = await fetch(`${url}/remote/events`, {
      headers: { ...proxyHeaders, Cookie: cookies[0] },
      signal: abort.signal,
    });
    const reader = sse.body!.getReader();
    await reader.read();
    expect(listeners.size).toBe(1);

    for (const activeCookie of [cookies[1], cookies[2]]) {
      const check = await fetch(`${url}/remote/settings`, { headers: { ...proxyHeaders, Cookie: activeCookie }, redirect: 'manual' });
      expect(check.status).toBe(200);
    }

    // Creating a 4th session evicts oldest session cookies[0] AND closes its SSE stream, while keeping cookies[1] and cookies[2]!
    const s4 = await postLogin('203.0.113.13', 'valid-pass');
    expect(s4.status).toBe(200);
    const cookie4 = s4.headers.get('set-cookie')!.split(';')[0];

    expect((await reader.read()).done).toBe(true);
    expect(listeners.size).toBe(0);
    expect((await fetch(`${url}/remote/settings`, { headers: { ...proxyHeaders, Cookie: cookies[0] }, redirect: 'manual' })).status).toBe(302);
    for (const kept of [cookies[1], cookies[2], cookie4]) {
      expect((await fetch(`${url}/remote/settings`, { headers: { ...proxyHeaders, Cookie: kept }, redirect: 'manual' })).status).toBe(200);
    }
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
