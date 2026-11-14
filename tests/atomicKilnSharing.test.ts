import { expect, test } from 'bun:test';
import { KilnSharing, sharingErrorCopy, type ShareOwner } from '../electron/kilnSharing';
import { configDigest, LocalApiError, type AtomicServeApi, type ServeConfig, type ServeSnapshot } from '../electron/tailscaleLocalApi';

const endpoint = { id: 'pi:synthetic', label: 'This computer', url: 'http://127.0.0.1:3002/', token: 'synthetic-token' };
const initial = () => ({ TCP: { '8443': { HTTPS: true } }, Web: { 'example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8443' } } } }, Services: { 'svc:other': { TCP: { '9000': { TCPForward: '127.0.0.1:9000' } } } } });
function fixture(options: { loopbackOk?: boolean; proxyOk?: boolean; ownerFails?: boolean; apiError?: LocalApiError } = {}) {
  let config: ServeConfig = initial();
  let owner: ShareOwner | undefined;
  let nodeId = 'synthetic-node';
  let beforeWrite: (() => void) | undefined;
  let afterWrite: (() => void) | undefined;
  let onProxy: (() => void) | undefined;
  const commands: string[][] = [];
  const writes: { etag: string; next: ServeConfig }[] = [];
  const snapshot = (): ServeSnapshot => ({ config: structuredClone(config), etag: configDigest(JSON.stringify(config)) });
  const api: AtomicServeApi = {
    read: async () => snapshot(), status: async () => ({ nodeId, ip: '100.72.1.9' }),
    compareAndSwap: async (expected, next) => {
      writes.push({ etag: expected.etag, next });
      beforeWrite?.();
      if (expected.etag !== snapshot().etag) throw new LocalApiError('conflict');
      config = structuredClone(next);
      afterWrite?.();
    },
  };
  const sharing = new KilnSharing({
    command: async args => { commands.push([...args]); return '--bg --tcp status'; },
    api: () => { if (options.apiError) throw options.apiError; return api; },
    owner: { read: () => owner, write: value => { if (value && options.ownerFails) throw new Error('synthetic disk failure'); owner = value; } },
    check: async value => {
      if (value.url === endpoint.url) return { ok: options.loopbackOk !== false };
      onProxy?.(); return { ok: options.proxyOk !== false };
    },
  });
  return { sharing, commands, writes, snapshot,
    config: () => config, owner: () => owner,
    setConfig: (value: ServeConfig) => { config = value; },
    setOwner: (value: ShareOwner | undefined) => { owner = value; },
    setNode: (value: string) => { nodeId = value; },
    beforeWrite: (value: (() => void) | undefined) => { beforeWrite = value; },
    afterWrite: (value: (() => void) | undefined) => { afterWrite = value; },
    onProxy: (value: () => void) => { onProxy = value; },
  };
}

test('enable is persistent top-level TCP only; ownership receipt then permits scoped conditional disable', async () => {
  const f = fixture();
  const report = await f.sharing.run('enable', endpoint, true);
  expect(report.ok).toBe(true); expect(report.enabled).toBe(true); expect(report.canChange).toBe(true);
  expect(report.detail).toMatch(/other Ember computer/);
  expect(f.owner()).toEqual({ nodeId: 'synthetic-node', target: '127.0.0.1:3002', etag: f.snapshot().etag });
  expect(f.config()).toEqual({ ...initial(), TCP: { ...initial().TCP, '3002': { TCPForward: '127.0.0.1:3002' } } });
  expect((await f.sharing.run('disable', endpoint, true)).enabled).toBe(false);
  expect(f.config()).toEqual(initial()); expect(f.owner()).toBeUndefined();
  expect(f.writes).toHaveLength(2);
  expect(f.commands.every(args => args.join(' ') === 'serve --help')).toBe(true);
});
test('a stopped included backend can remove only its verified persistent receipt without exposing a URL', async () => {
  const f = fixture(); await f.sharing.run('enable', endpoint, true);
  const stopped = { ...endpoint, token: '' };
  const report = await f.sharing.run('inspect', stopped, true);
  expect(report.enabled).toBe(true); expect(report.canChange).toBe(true); expect(report.url).toBeUndefined();
  expect((await f.sharing.run('disable', stopped, true)).ok).toBe(true); expect(f.config()).toEqual(initial());
});
test('read-only inspect is a baseline, not consent to create a forward or advertise an IP', async () => {
  const f = fixture(); const report = await f.sharing.run('inspect', endpoint, true);
  expect(report.canChange).toBe(true); expect(report.url).toBeUndefined(); expect(f.writes).toEqual([]);
});
test('external processes, malformed listeners and failed loopback authentication cannot create forwards', async () => {
  const f = fixture({ loopbackOk: false });
  await f.sharing.run('enable', endpoint, false);
  await f.sharing.run('enable', { ...endpoint, url: 'bad' }, true);
  expect(f.commands).toEqual([]);
  expect((await f.sharing.run('enable', endpoint, true)).ok).toBe(false);
  expect(f.writes).toEqual([]);
});
test('a matching preexisting forward without receipt is not adopted or removed', async () => {
  const f = fixture();
  const existing = { ...initial(), TCP: { ...initial().TCP, '3002': { TCPForward: '127.0.0.1:3002' } } };
  f.setConfig(existing);
  for (const action of ['inspect', 'enable', 'disable'] as const) {
    const report = await f.sharing.run(action, endpoint, true);
    expect(report.canChange).toBe(false); expect(report.detail).toMatch(/cannot confirm ownership/);
  }
  expect(f.writes).toEqual([]); expect(f.config()).toEqual(existing);
});
test('external mutation between enable ownership check and POST causes one failed CAS, no retry', async () => {
  const f = fixture();
  const external = { TCP: { '3002': { TCPForward: '127.0.0.1:9999' } } };
  f.beforeWrite(() => f.setConfig(external));
  const report = await f.sharing.run('enable', endpoint, true);
  expect(report.detail).toMatch(/did not overwrite/); expect(f.writes).toHaveLength(1);
  expect(f.config()).toEqual(external); expect(f.owner()).toBeUndefined();
});
test('external mutation between disable ownership check and POST cannot be removed', async () => {
  const f = fixture(); await f.sharing.run('enable', endpoint, true);
  const external = { TCP: { '3002': { TCPForward: '127.0.0.1:9999' } } };
  f.beforeWrite(() => f.setConfig(external));
  const report = await f.sharing.run('disable', endpoint, true);
  expect(report.detail).toMatch(/did not overwrite/); expect(f.writes).toHaveLength(2); expect(f.config()).toEqual(external);
});
test('a changed config version or daemon identity invalidates a durable ownership receipt', async () => {
  for (const mutate of ['config', 'node'] as const) {
    const f = fixture(); await f.sharing.run('enable', endpoint, true);
    if (mutate === 'config') f.setConfig({ ...f.config(), extra: 'synthetic-other-change' });
    else f.setNode('different-synthetic-node');
    expect((await f.sharing.run('disable', endpoint, true)).canChange).toBe(false);
    expect(f.writes).toHaveLength(1);
  }
});
test('failed forwarded authentication rolls back only the new port using a second CAS', async () => {
  const f = fixture({ proxyOk: false }); const report = await f.sharing.run('enable', endpoint, true);
  expect(report.detail).toMatch(/conditionally removed only/); expect(f.config()).toEqual(initial());
  expect(f.writes).toHaveLength(2); expect(f.owner()).toBeUndefined();
});
test('failed ownership persistence also rolls back without restoring an old full snapshot', async () => {
  const f = fixture({ ownerFails: true });
  expect((await f.sharing.run('enable', endpoint, true)).detail).toMatch(/conditionally removed only/);
  expect(f.config()).toEqual(initial()); expect(f.writes).toHaveLength(2);
});
test('rollback leaves concurrent configuration intact and reports uncertain outcome honestly', async () => {
  const f = fixture({ proxyOk: false });
  f.onProxy(() => f.setConfig({ ...f.config(), extra: 'other-writer' }));
  const report = await f.sharing.run('enable', endpoint, true);
  expect(report.detail).toMatch(/may have been created/); expect(f.writes).toHaveLength(1);
  expect(f.config().extra).toBe('other-writer');
});
test('rollback CAS conflict cannot overwrite a change arriving after its final read', async () => {
  const f = fixture({ proxyOk: false });
  f.onProxy(() => f.beforeWrite(() => f.setConfig({ ...f.config(), extra: 'last-moment-writer' })));
  const report = await f.sharing.run('enable', endpoint, true);
  expect(report.detail).toMatch(/did not overwrite/); expect(f.config().extra).toBe('last-moment-writer');
  expect(f.writes).toHaveLength(2);
});
test('parallel app enable/disable operations serialize, including ownership persistence', async () => {
  const f = fixture();
  const [enabled, disabled] = await Promise.all([f.sharing.run('enable', endpoint, true), f.sharing.run('disable', endpoint, true)]);
  expect(enabled.ok).toBe(true); expect(disabled.ok).toBe(true); expect(f.config()).toEqual(initial());
  expect(f.writes).toHaveLength(2); expect(f.owner()).toBeUndefined();
});
test('a lost mutation acknowledgement never becomes a success or an unconditional retry', async () => {
  const f = fixture();
  f.afterWrite(() => { throw new LocalApiError('timeout'); });
  const report = await f.sharing.run('enable', endpoint, true);
  expect(report.ok).toBe(false); expect(report.canChange).toBe(false);
  expect(report.detail).toMatch(/change was in flight/); expect(f.writes).toHaveLength(1);
  expect(f.owner()).toBeUndefined();
});
test('lost disable acknowledgement invalidates the receipt before any matching foreign restoration', async () => {
  const f = fixture(); await f.sharing.run('enable', endpoint, true);
  const previouslyOwned = structuredClone(f.config());
  f.afterWrite(() => { throw new LocalApiError('timeout'); });
  expect((await f.sharing.run('disable', endpoint, true)).ok).toBe(false);
  expect(f.owner()).toBeUndefined();
  f.afterWrite(undefined); f.setConfig(previouslyOwned); // Another writer restores identical bytes.
  expect((await f.sharing.run('disable', endpoint, true)).canChange).toBe(false);
  expect(f.writes).toHaveLength(2); expect(f.config()).toEqual(previouslyOwned);
});
test('a stale receipt is cleared before an unacknowledged enable can recreate matching bytes', async () => {
  const f = fixture();
  const next = { ...initial(), TCP: { ...initial().TCP, '3002': { TCPForward: '127.0.0.1:3002' } } };
  f.setOwner({ nodeId: 'synthetic-node', target: '127.0.0.1:3002', etag: configDigest(JSON.stringify(next)) });
  f.afterWrite(() => { throw new LocalApiError('timeout'); });
  expect((await f.sharing.run('enable', endpoint, true)).ok).toBe(false);
  expect(f.owner()).toBeUndefined();
  f.afterWrite(undefined);
  expect((await f.sharing.run('disable', endpoint, true)).canChange).toBe(false);
  expect(f.writes).toHaveLength(1);
});
test('daemon identity changing during verification prevents adopting or rolling back another identity', async () => {
  const f = fixture();
  f.afterWrite(() => f.setNode('other-synthetic-node'));
  const report = await f.sharing.run('enable', endpoint, true);
  expect(report.ok).toBe(false); expect(report.detail).toMatch(/may have been created/);
  expect(f.writes).toHaveLength(1); expect(f.owner()).toBeUndefined();
});
test('unsupported transport and daemon permission errors fail closed with an actor and recovery', async () => {
  for (const kind of ['unsupported', 'permission', 'timeout', 'invalid', 'unavailable'] as const) {
    const f = fixture({ apiError: new LocalApiError(kind) });
    const report = await f.sharing.run('enable', endpoint, true);
    expect(report.canChange).toBe(false); expect(report.detail).toMatch(/Tailscale/); expect(f.writes).toEqual([]);
  }
  expect(sharingErrorCopy(new LocalApiError('unsupported'), 'win32')).toMatch(/Windows.*named-pipe/);
  expect(sharingErrorCopy(new LocalApiError('unsupported'), 'darwin')).toMatch(/this Mac/);
});
