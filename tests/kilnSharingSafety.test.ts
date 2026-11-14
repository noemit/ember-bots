import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KilnSharing, isTailnetAddress, sharingTarget, sharingErrorCopy } from '../electron/kilnSharing';
import { fileShareOwnerStore } from '../electron/kilnSharingOwner';
import { configDigest, LocalApiError, TailscaleLocalApi, type AtomicServeApi, type ServeConfig } from '../electron/tailscaleLocalApi';
import { checkSharedKilnAuth } from '../electron/sharedKilnAuth';

const endpoint = { id: 'pi:synthetic', label: 'Tower', url: 'http://127.0.0.1:3002/', token: 'private-synthetic-token' };

test('numerical loopback targets and tailnet membership retain IPv4 and IPv6 safeguards', () => {
  expect(sharingTarget('http://127.0.0.1:3002')).toBe('127.0.0.1:3002');
  expect(sharingTarget('http://[::1]:3002')).toBe('[::1]:3002');
  for (const url of ['http://localhost:3002', 'http://0.0.0.0:3002', 'http://[::]:3002', 'http://[::ffff:127.0.0.1]:3002', 'http://100.64.0.1:3002', 'https://127.0.0.1:3002', 'http://a:b@127.0.0.1:3002', 'http://127.0.0.1:3002/path', 'http://127.0.0.1:3002/?token=bad']) expect(() => sharingTarget(url)).toThrow();
  for (const ip of ['100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::1234']) expect(isTailnetAddress(ip)).toBe(true);
  for (const ip of ['100.128.0.1', '100.63.0.1', '100.64.0.999', '10.0.0.1', 'fd7a:115c:a1e1::1', 'fe80::1%eth0', '::ffff:100.64.0.1']) expect(isTailnetAddress(ip)).toBe(false);
});

test('sharing requires anonymous denial as well as authenticated readiness', async () => {
  for (const status of [200, 401, 403, 404, 500]) {
    const seen: boolean[] = [];
    const request = (async (url, init) => {
      const authorized = new Headers(init?.headers).has('authorization');
      seen.push(authorized);
      return authorized ? Response.json(String(url).endsWith('/health') ? { ok: true, service: 'hearth' } : { conversations: [] }) : new Response(null, { status });
    }) as typeof fetch;
    expect((await checkSharedKilnAuth(endpoint, request)).ok).toBe(status === 401 || status === 403);
    expect(seen).toEqual([true, true, false]);
  }
});

test('private atomic receipt remains sufficient after controller restart, but never adopts legacy pending intent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-share-state-'));
  const file = join(home, 'owner.json');
  let config: ServeConfig = { TCP: { '8443': { HTTPS: true } } };
  let writes = 0;
  const api: AtomicServeApi = {
    status: async () => ({ nodeId: 'synthetic-node', ip: '100.64.0.2' }),
    read: async () => ({ config: structuredClone(config), etag: configDigest(JSON.stringify(config)) }),
    compareAndSwap: async (snapshot, next) => {
      expect(snapshot.etag).toBe(configDigest(JSON.stringify(config))); writes++; config = structuredClone(next);
    },
  };
  const make = () => new KilnSharing({ command: async () => '--bg --tcp status', api: () => api, owner: fileShareOwnerStore(file), check: async () => ({ ok: true }) });
  try {
    expect((await make().run('enable', endpoint, true)).ok).toBe(true);
    expect(await readFile(file, 'utf8')).not.toContain(endpoint.token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await make().run('inspect', endpoint, true)).canChange).toBe(true);
    expect((await make().run('disable', endpoint, true)).ok).toBe(true);
    expect(config).toEqual({ TCP: { '8443': { HTTPS: true } } });
    config = { TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } };
    await writeFile(file, JSON.stringify({ version: 1, port: 3002, target: '127.0.0.1:3002', phase: 'pending' }));
    expect((await make().run('disable', endpoint, true)).canChange).toBe(false);
    expect(writes).toBe(2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid tailnet addresses cannot receive the bearer or a forwarding rule', async () => {
  for (const address of ['192.168.1.1', '::1', 'fd00::1', '100.64.0.256']) {
    let checked = false; let posted = false;
    const api = new TailscaleLocalApi(async (method) => {
      if (method === 'POST') posted = true;
      return { status: 200, body: JSON.stringify({ BackendState: 'Running', Self: { ID: 'synthetic-node', TailscaleIPs: [address] } }) };
    });
    const sharing = new KilnSharing({ command: async () => '--bg --tcp status', api: () => api,
      owner: { read: () => undefined, write: () => { throw new Error('must not save'); } }, check: async () => { checked = true; return { ok: true }; } });
    expect((await sharing.run('enable', endpoint, true)).canChange).toBe(false);
    expect(checked).toBe(false); expect(posted).toBe(false);
  }
});

test('safe daemon diagnostics name Tailscale and a recovery, never raw output or credentials', () => {
  for (const kind of ['unsupported', 'permission', 'timeout', 'invalid', 'unavailable'] as const) {
    const message = sharingErrorCopy(new LocalApiError(kind), 'linux');
    expect(message).toContain('Tailscale'); expect(message).toMatch(/Check sharing|Update|administrator/);
    expect(message).not.toContain(endpoint.token); expect(message).not.toMatch(/EACCES|undefined|HTTP \d/);
  }
});
