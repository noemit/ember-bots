import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { FileCredentialStore } from '../src/credentials';
import { CustomProviders } from '../src/custom-providers';

const baseUrl = 'https://models.example/v1';
const winner = { type: 'api_key' as const, key: 'temporary-winner-key', env: { KILN_CUSTOM_BASE_URL: baseUrl, ACCOUNT: 'temporary-winner-metadata' } };
const definition = { name: 'Atomic import test', baseUrl, modelIds: ['test-model'], apiKey: '' };

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'kiln-custom-atomic-'));
  const underlying = new FileCredentialStore(join(home, 'auth.json'));
  const hooks: { before?: (id: string) => Promise<void>; after?: (id: string) => Promise<void>; deletes: number } = { deletes: 0 };
  const store: CredentialStore = {
    read: underlying.read.bind(underlying), list: underlying.list.bind(underlying),
    async delete(id, options) { hooks.deletes++; await underlying.delete(id, options); },
    async modify(id, fn, options) {
      const before = hooks.before; hooks.before = undefined;
      await before?.(id);
      const result = await underlying.modify(id, fn, options);
      const after = hooks.after; hooks.after = undefined;
      await after?.(id);
      return result;
    },
  };
  const models = createModels({ credentials: store });
  const custom = new CustomProviders(home, store, models);
  await custom.ready;
  const config = await custom.save(definition);
  const identity = custom.identities().find(entry => entry.id === config.id)!;
  hooks.deletes = 0;
  return { home, underlying, hooks, store, models, custom, config, identity, close: () => rm(home, { recursive: true, force: true }) };
}

test('atomic custom import preserves a bound store-lock winner and republishes its runtime credential', async () => {
  const f = await fixture();
  try {
    const oldModel = f.models.getModel(f.config.id, 'test-model')!;
    const oldProvider = f.models.getProvider(f.config.id);
    f.hooks.before = async id => { await f.underlying.modify(id, async () => winner); };
    expect(await f.custom.importMissingKey(f.config.id, f.identity, 'temporary-incoming-key')).toBe(false);
    expect(await f.store.read(f.config.id)).toEqual(winner);
    expect(f.hooks.deletes).toBe(0);
    expect(f.models.getProvider(f.config.id)).not.toBe(oldProvider);
    expect((await f.models.getAuth(f.config.id))?.auth.apiKey).toBe(winner.key);
    let sent = false;
    const send = (async () => { sent = true; throw new Error('This regression must not make network calls'); }) as unknown as typeof fetch;
    const stale = await f.models.streamSimple(oldModel, { messages: [{ role: 'user', content: 'Temporary test', timestamp: 1 }] }, { fetch: send }).result();
    expect(stale.stopReason).toBe('error'); expect(sent).toBe(false);
  } finally { await f.close(); }
});

test('unbound, foreign-destination and OAuth winners stay unchanged and block runtime inference', async () => {
  const winners: Credential[] = [
    { type: 'api_key', key: 'temporary-unbound-key', env: { ACCOUNT: 'keep-this' } },
    { type: 'api_key', key: 'temporary-foreign-key', env: { KILN_CUSTOM_BASE_URL: 'https://other.example/v1' } },
    { type: 'oauth', access: 'temporary-access', refresh: 'temporary-refresh', expires: Date.now() + 3600000 },
  ];
  for (const credential of winners) {
    const f = await fixture();
    try {
      f.hooks.before = async id => { await f.underlying.modify(id, async () => credential); };
      expect(await f.custom.importMissingKey(f.config.id, f.identity, 'temporary-incoming-key')).toBe(false);
      expect(await f.store.read(f.config.id)).toEqual(credential);
      expect(f.hooks.deletes).toBe(0);
      expect((await f.models.getAvailable()).some(model => model.provider === f.config.id)).toBe(false);
      expect((await f.custom.list())[0]?.problem).toContain('Re-enter');
    } finally { await f.close(); }
  }
});

test('successful atomic import remains fill-only, retains envelope metadata and binds its destination', async () => {
  const f = await fixture();
  try {
    const credential = { type: 'api_key' as const, key: 'temporary-import-key', env: { ACCOUNT: 'temporary-import-metadata', KILN_CUSTOM_BASE_URL: baseUrl } };
    const results = await Promise.all([
      f.custom.importMissingKey(f.config.id, f.identity, credential.key, credential),
      f.custom.importMissingKey(f.config.id, f.identity, 'temporary-second-key'),
    ]);
    expect(results).toEqual([true, false]);
    expect(await f.store.read(f.config.id)).toEqual(credential);
    expect((await f.models.getAuth(f.config.id))?.auth.apiKey).toBe(credential.key);
    expect(f.hooks.deletes).toBe(0);
  } finally { await f.close(); }
});

test('a failure after store modification never rolls back or deletes a later foreign winner', async () => {
  const f = await fixture();
  try {
    f.hooks.after = async id => {
      await f.underlying.modify(id, async () => winner);
      throw new Error('Simulated storage acknowledgement failure');
    };
    await expect(f.custom.importMissingKey(f.config.id, f.identity, 'temporary-incoming-key')).rejects.toThrow('acknowledgement');
    expect(await f.store.read(f.config.id)).toEqual(winner);
    expect(f.hooks.deletes).toBe(0);
    expect((await f.models.getAvailable()).some(model => model.provider === f.config.id)).toBe(false);
    const restartedModels = createModels({ credentials: f.store });
    const restarted = new CustomProviders(f.home, f.store, restartedModels); await restarted.ready;
    expect((await restartedModels.getAuth(f.config.id))?.auth.apiKey).toBe(winner.key);
  } finally { await f.close(); }
});

test('metadata persistence failure preserves the store-lock winner and fails closed without rollback', async () => {
  const f = await fixture();
  try {
    f.hooks.before = async id => { await f.underlying.modify(id, async () => winner); };
    await mkdir(join(f.home, 'custom-providers.json.tmp'));
    await expect(f.custom.importMissingKey(f.config.id, f.identity, 'temporary-incoming-key')).rejects.toThrow();
    expect(await f.store.read(f.config.id)).toEqual(winner);
    expect(f.hooks.deletes).toBe(0);
    expect((await f.models.getAvailable()).some(model => model.provider === f.config.id)).toBe(false);
  } finally { await f.close(); }
});
