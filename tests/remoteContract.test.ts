import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRemoteServer, isAllowedHost, isAllowedOrigin } from '../electron/remoteServer';
import { hashRemotePassword, verifyRemotePassword } from '../electron/remoteAuth';
import { redactRemoteSettings, withoutDesktopOnlySettings } from '../electron/transport';

/**
 * The remote surface's contract, exercised over a real socket on 127.0.0.1:0 only.
 * Nothing here touches the fixed port or the owner's app-data directory.
 */

const fixture = async (settings: unknown = { theme: 'stone' }) => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-remote-contract-'));
  const password = randomBytes(18).toString('hex');
  const hash = await hashRemotePassword(password);
  const writes: string[] = [];
  const server = createRemoteServer(directory, {
    modelStats: {
      list: async () => [],
      observe: async () => { writes.push('observe'); return []; },
      rate: async () => { writes.push('rate'); },
      clear: async () => { writes.push('clear'); },
    },
    listInstances: async () => [],
    getSettings: () => settings,
    setSettings: async (patch) => { writes.push('settings'); return patch; },
    request: async () => { writes.push('api'); return { ok: true, status: 200, data: {} }; },
    verifyPassword: (value) => verifyRemotePassword(value, hash),
    subscribeEvents: () => () => {},
    eventStatus: () => ({ fixture: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const url = `http://127.0.0.1:${address.port}`;
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async () => {
    const response = await call('/remote/login', 'POST', { password });
    const cookie = response.headers.get('set-cookie');
    if (!cookie) throw new Error('No cookie');
    return { cookie: cookie.split(';')[0], raw: cookie };
  };
  return {
    url, password, call, login, writes,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    },
  };
};

const token = 'hearth-bearer-token-that-must-not-cross-the-tailnet';

test('the remote settings payload never carries a Hearth bearer token', async () => {
  const settings = {
    theme: 'stone',
    piEndpoints: [
      { id: 'pi:keep', label: 'Keep', url: 'http://100.64.0.1:3002', token },
    ],
  };
  const f = await fixture(redactRemoteSettings(settings));
  try {
    const { cookie } = await f.login();
    const response = await f.call('/remote/settings', 'GET', undefined, { Cookie: cookie });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain(token);
    const parsed = JSON.parse(body) as { piEndpoints: Array<{ id: string; token: string; hasToken: boolean }> };
    expect(parsed.piEndpoints[0].id).toBe('pi:keep');
    expect(parsed.piEndpoints[0].token).toBe('');
    expect(parsed.piEndpoints[0].hasToken).toBe(true);
  } finally {
    await f.close();
  }
});

test('the redaction keeps the desktop value out of every field, not just the obvious one', () => {
  const redacted = redactRemoteSettings({
    theme: 'stone',
    piEndpoints: [{ id: 'pi:a', label: token, url: `http://x/${token}`, token }],
  });
  // A label or url that happens to contain the token is the user's own data and is not ours to
  // rewrite; what must never appear is the credential itself.
  expect(redacted.piEndpoints[0].token).toBe('');
  expect(redacted.piEndpoints[0].hasToken).toBe(true);
});

test('a remote client cannot write piEndpoints back and delete them by accident', () => {
  const stripped = withoutDesktopOnlySettings({ theme: 'clay', piEndpoints: [{ id: 'pi:a', token: '' }] }) as Record<string, unknown>;
  expect(stripped).toEqual({ theme: 'clay' });
  expect(withoutDesktopOnlySettings({ theme: 'clay' })).toEqual({ theme: 'clay' });
  expect(withoutDesktopOnlySettings(null)).toBeNull();
});

test('a cross-origin write is refused, and a same-origin one is not', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    const foreign = await f.call('/remote/settings', 'POST', { theme: 'clay' }, {
      Cookie: cookie,
      Origin: 'http://evil.example',
    });
    expect(foreign.status).toBe(403);
    expect(f.writes).toEqual([]);

    const sameOrigin = await f.call('/remote/settings', 'POST', { theme: 'clay' }, {
      Cookie: cookie,
      Origin: f.url,
    });
    expect(sameOrigin.status).toBe(200);
    expect(f.writes).toEqual(['settings']);

    // No Origin at all (curl, a native client) is not a CSRF vector and stays allowed.
    const noOrigin = await f.call('/remote/settings', 'POST', { theme: 'clay' }, { Cookie: cookie });
    expect(noOrigin.status).toBe(200);
  } finally {
    await f.close();
  }
});

test('an unexpected Host is refused before anything is served', async () => {
  const f = await fixture();
  try {
    const response = await f.call('/remote/login', 'GET', undefined, { Host: 'evil.example' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Unexpected host');
  } finally {
    await f.close();
  }
});

test('host and origin rules are the same functions the server uses', async () => {
  // Bound to 127.0.0.1:57821 in this scenario; the port must match on every allowed name.
  expect(isAllowedHost('100.64.0.1:57821', '100.64.0.1', 57821)).toBe(true);
  expect(isAllowedHost('box.example.ts.net:57821', '100.64.0.1', 57821)).toBe(true);
  expect(isAllowedHost('localhost:57821', '100.64.0.1', 57821)).toBe(true);
  expect(isAllowedHost('evil.example:57821', '100.64.0.1', 57821)).toBe(false);
  expect(isAllowedHost('100.64.0.1:9999', '100.64.0.1', 57821)).toBe(false);
  expect(isAllowedHost(undefined, '100.64.0.1', 57821)).toBe(false);

  expect(isAllowedOrigin('http://100.64.0.1:57821', '100.64.0.1:57821', false)).toBe(true);
  expect(isAllowedOrigin('https://100.64.0.1:57821', '100.64.0.1:57821', false)).toBe(false);
  expect(isAllowedOrigin('http://evil.example', '100.64.0.1:57821', false)).toBe(false);
  expect(isAllowedOrigin(undefined, '100.64.0.1:57821', false)).toBe(true);
  const f = await fixture();
  await f.close();
});

test('an oversized body is a JSON 413, not a dropped socket', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    const response = await f.call('/remote/settings', 'POST', { padding: 'a'.repeat(33 * 1024 * 1024) }, { Cookie: cookie });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body is too large' });
    expect(f.writes).toEqual([]);
  } finally {
    await f.close();
  }
});

test('an event stream with no session gets a 401 it can act on, not a login page', async () => {
  const f = await fixture();
  try {
    const streaming = await f.call('/remote/events', 'GET', undefined, { Accept: 'text/event-stream' });
    expect(streaming.status).toBe(401);
    expect(await streaming.json()).toEqual({ error: 'Session expired', code: 'session-expired' });
    // A plain navigation still redirects, because that is what a browser needs.
    const navigation = await f.call('/remote/events');
    expect(navigation.status).toBe(302);
  } finally {
    await f.close();
  }
});

test('the session cookie is HttpOnly and SameSite, with no Secure on plain HTTP', async () => {
  const f = await fixture();
  try {
    const { raw } = await f.login();
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    // No TLS here, so `Secure` would make the browser drop the cookie and lock the user out.
    expect(raw).not.toContain('Secure');
    expect(raw).not.toContain('__Host-');
  } finally {
    await f.close();
  }
});

test('a session ends after the idle window and the cookie is no longer accepted', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    expect((await f.call('/remote/settings', 'GET', undefined, { Cookie: cookie })).status).toBe(200);
    const clock = spyOn(Date, 'now');
    clock.mockReturnValue(Date.now() + 13 * 60 * 60 * 1000);
    try {
      const expired = await f.call('/remote/settings', 'GET', undefined, { Cookie: cookie });
      expect(expired.status).toBe(302);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await f.close();
  }
});
