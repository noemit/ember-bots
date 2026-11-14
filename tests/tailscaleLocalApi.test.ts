import { expect, test } from 'bun:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configDigest, createLocalServeApi, localApiSocket, LocalApiError, TailscaleLocalApi, unixLocalApiTransport, type ServeConfig } from '../electron/tailscaleLocalApi';
import { KilnSharing } from '../electron/kilnSharing';
import { fileShareOwnerStore } from '../electron/kilnSharingOwner';

/** No production daemon sockets/state: every HTTP connection is to this disposable fixture. */
async function withDaemon(run: (api: TailscaleLocalApi, state: { config: ServeConfig; beforePost?: () => void; posts: string[]; hang?: boolean; dropPostResponse?: boolean }) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-sharing-api-'));
  const socket = path.join(directory, 'daemon.sock');
  const state: { config: ServeConfig; beforePost?: () => void; posts: string[]; hang?: boolean; dropPostResponse?: boolean } = { config: { TCP: { '8443': { HTTPS: true } } }, posts: [] };
  const server = http.createServer((request, response) => {
    if (state.hang) return;
    if (request.url === '/localapi/v0/status?peers=false') { response.end(JSON.stringify({ BackendState: 'Running', Self: { ID: 'synthetic-node', TailscaleIPs: ['100.72.1.9'] } })); return; }
    if (request.url !== '/localapi/v0/serve-config') { response.writeHead(404).end(); return; }
    if (request.method === 'GET') {
      const body = JSON.stringify(state.config);
      response.setHeader('ETag', configDigest(body)); response.end(body); return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      state.posts.push(request.headers['if-match'] as string);
      state.beforePost?.();
      if (request.headers['if-match'] !== configDigest(JSON.stringify(state.config))) { response.writeHead(412).end('private daemon diagnostic'); return; }
      state.config = JSON.parse(Buffer.concat(chunks).toString()) as ServeConfig;
      if (!state.dropPostResponse) response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try { await run(new TailscaleLocalApi(unixLocalApiTransport(socket, 100)), state); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
}

test('Unix HTTP integration uses exact ETag If-Match and preserves another service', async () => {
  await withDaemon(async (api, state) => {
    expect(await api.status()).toEqual({ nodeId: 'synthetic-node', ip: '100.72.1.9' });
    const snapshot = await api.read();
    await api.compareAndSwap(snapshot, { ...snapshot.config, TCP: { ...(snapshot.config.TCP as object), '3002': { TCPForward: '127.0.0.1:3002' } } });
    expect(state.posts).toEqual([snapshot.etag]);
    expect((state.config.TCP as Record<string, unknown>)['8443']).toEqual({ HTTPS: true });
  });
});
test('daemon-side concurrent mutation returns conflict, with no retry or overwrite', async () => {
  await withDaemon(async (api, state) => {
    const snapshot = await api.read();
    state.beforePost = () => { state.config = { TCP: { '3002': { TCPForward: '127.0.0.1:9999' } } }; };
    await expect(api.compareAndSwap(snapshot, { TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } })).rejects.toMatchObject({ kind: 'conflict' });
    expect(state.posts).toHaveLength(1);
    expect(state.config).toEqual({ TCP: { '3002': { TCPForward: '127.0.0.1:9999' } } });
  });
});
test('daemon transport timeout is bounded even when no headers arrive', async () => {
  await withDaemon(async (api, state) => {
    state.hang = true;
    await expect(api.read()).rejects.toMatchObject({ kind: 'timeout' });
  });
});
test('oversized daemon configuration is rejected without retaining the entire response', async () => {
  await withDaemon(async (api, state) => {
    state.config = { synthetic: 'x'.repeat(600 * 1024) };
    await expect(api.read()).rejects.toMatchObject({ kind: 'invalid' });
    expect(state.posts).toEqual([]);
  });
});
test('unset null configuration keeps the raw null ETag, not the normalized empty-object hash', async () => {
  let postedTag: string | undefined;
  const api = new TailscaleLocalApi(async (method, _endpoint, _body, etag) => {
    if (method === 'POST') { postedTag = etag; return { status: 200, body: '' }; }
    return { status: 200, body: 'null', etag: configDigest('null') };
  });
  const snapshot = await api.read();
  expect(snapshot.config).toEqual({}); expect(snapshot.etag).not.toBe(configDigest('{}'));
  await api.compareAndSwap(snapshot, { TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } });
  expect(postedTag).toBe(configDigest('null'));
});
test('timeout after daemon applied POST cannot adopt or delete the matching forward on recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-lost-sharing-'));
  const receipt = path.join(directory, 'owner.json');
  const endpoint = { id: 'pi:synthetic', label: 'Synthetic host', url: 'http://127.0.0.1:3002/', token: 'synthetic-only' };
  try {
    await withDaemon(async (api, state) => {
      state.dropPostResponse = true;
      const make = () => new KilnSharing({ command: async () => '--bg --tcp status', api: () => api, owner: fileShareOwnerStore(receipt), check: async () => ({ ok: true }) });
      const failed = await make().run('enable', endpoint, true);
      expect(failed.ok).toBe(false); expect(failed.detail).toMatch(/change was in flight/);
      expect((state.config.TCP as Record<string, unknown>)['3002']).toEqual({ TCPForward: '127.0.0.1:3002' });
      expect(fileShareOwnerStore(receipt).read()).toBeUndefined();
      const inspected = await make().run('inspect', endpoint, true);
      expect(inspected.enabled).toBe(true); expect(inspected.canChange).toBe(false);
      expect(inspected.detail).toMatch(/did not create or adopt/);
      const disabled = await make().run('disable', endpoint, true);
      expect(disabled.canChange).toBe(false); expect(disabled.detail).toMatch(/cannot confirm ownership/);
      expect(state.posts).toHaveLength(1); // No cleanup, adoption or retry based on target equality.
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('missing/forged ETags, malformed maps and denied daemon access fail closed', async () => {
  for (const response of [
    { status: 200, body: '{}' },
    { status: 200, body: '{}', etag: 'a'.repeat(64) },
    { status: 200, body: '{"TCP":"bad"}', etag: configDigest('{"TCP":"bad"}') },
    { status: 200, body: '[]', etag: configDigest('[]') },
    { status: 403, body: 'private diagnostic' },
  ]) {
    let posts = 0;
    const api = new TailscaleLocalApi(async (method) => { if (method === 'POST') posts++; return response; });
    await expect(api.read()).rejects.toBeInstanceOf(LocalApiError);
    expect(posts).toBe(0);
  }
});
test('transport refuses unconditional writes and arbitrary API routes before connecting', async () => {
  const transport = unixLocalApiTransport('/tmp/never-connect-ember-synthetic.sock');
  await expect(transport('POST', '/localapi/v0/serve-config', '{}')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(transport('GET', '/localapi/v0/prefs')).rejects.toMatchObject({ kind: 'invalid' });
});
test('platform policy has fixed Unix endpoints and explicitly gates Windows', () => {
  expect(localApiSocket('linux')).toBe('/var/run/tailscale/tailscaled.sock');
  expect(localApiSocket('darwin')).toBe('/var/run/tailscaled.socket');
  expect(() => createLocalServeApi('win32')).toThrow(LocalApiError);
});
test('ownership receipts survive a new store, contain no credentials and clear atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-sharing-owner-'));
  const file = path.join(directory, 'owner.json');
  try {
    const value = { nodeId: 'synthetic-node', target: '127.0.0.1:3002', etag: 'a'.repeat(64) };
    fileShareOwnerStore(file).write(value);
    expect(fileShareOwnerStore(file).read()).toEqual(value);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fileShareOwnerStore(file).write(undefined);
    expect(fileShareOwnerStore(file).read()).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual(['owner.json']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
