import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, InMemoryCredentialStore, type CredentialStore } from '@earendil-works/pi-ai';
import { CustomProviders } from '../src/custom-providers';
import { alignmentProviders, importCredentials, shareApiKeys, shareableCustomUrl, type ProviderSelection } from '../src/alignment';

const definition = { name: 'Reviewed models', baseUrl: 'https://models.example/v1', modelIds: ['one', 'two'], apiKey: '' };
const peer = { id: 'destination', label: 'Destination', url: 'https://destination.example', token: 'fake-destination-token' };
const host = async (store: CredentialStore = new InMemoryCredentialStore()) => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-alignment-custom-'));
  const models = createModels({ credentials: store });
  const custom = new CustomProviders(home, store, models);
  await custom.ready;
  const config = await custom.save(definition);
  const identity = custom.identities().find(c => c.id === config.id)!;
  return { store, models, custom, identity, close: () => rm(home, { recursive: true, force: true }) };
};

test('actual managers map reviewed different local UUIDs, preserve env metadata and republish destination auth', async () => {
  const source = await host();
  const dest = await host();
  try {
    expect(source.identity.id).not.toBe(dest.identity.id);
    const envelope = { type: 'api_key' as const, key: 'fake-source-key', env: { KILN_CUSTOM_BASE_URL: definition.baseUrl, ACCOUNT_METADATA: 'fake-private-account' } };
    await source.custom.importMissingKey(source.identity.id, source.identity, envelope.key, envelope);
    const before = dest.models.getProvider(dest.identity.id);
    const selection: ProviderSelection = { providerId: source.identity.id, type: 'api_key', configIdentity: source.identity, destinationConfigIdentity: dest.identity };
    const send = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.credentials[0]).toMatchObject({ providerId: dest.identity.id, configIdentity: dest.identity, credential: envelope });
      expect(body.credentials[0].destinationConfigIdentity).toBeUndefined();
      expect(String(init.body)).not.toContain(source.identity.id);
      return Response.json({ keys: await importCredentials(dest.store, body.credentials, dest.custom) });
    }) as typeof fetch;
    const calls = await Promise.all([
      shareApiKeys(source.store, [{ ...peer, providers: [selection] }], send, source.custom),
      shareApiKeys(source.store, [{ ...peer, providers: [selection] }], send, source.custom),
    ]);
    expect(calls.every(result => result[0].ok)).toBe(true);
    expect(calls.reduce((sum, result) => sum + (result[0].keys ?? 0), 0)).toBe(1);
    expect(await dest.store.read(dest.identity.id)).toEqual(envelope);
    expect(await dest.store.read(source.identity.id)).toBeUndefined();
    expect(dest.models.getProvider(dest.identity.id)).not.toBe(before);
    expect((await dest.models.getAuth(dest.identity.id))?.auth.apiKey).toBe(envelope.key);
    expect(await source.store.read(source.identity.id)).toEqual(envelope);
    expect(JSON.stringify(await alignmentProviders(dest.store, dest.custom))).not.toContain('fake-private-account');
  } finally { await source.close(); await dest.close(); }
});

test('custom mapping rejects missing or changed reviewed config without installing a foreign definition', async () => {
  const source = await host();
  const dest = await host();
  try {
    await source.custom.importMissingKey(source.identity.id, source.identity, 'fake-source-key');
    const selection: ProviderSelection = { providerId: source.identity.id, type: 'api_key', configIdentity: source.identity, destinationConfigIdentity: dest.identity };
    let calls = 0;
    const send = (async (_url: unknown, init: RequestInit) => {
      calls++;
      try { return Response.json({ keys: await importCredentials(dest.store, JSON.parse(String(init.body)).credentials, dest.custom) }); }
      catch { return Response.json({ error: 'Review the destination again' }, { status: 400 }); }
    }) as typeof fetch;
    for (const identity of [{ ...dest.identity, name: 'Different' }, { ...dest.identity, baseUrl: definition.baseUrl + '/other' }, { ...dest.identity, modelIds: ['two', 'one'] }]) {
      await expect(shareApiKeys(source.store, [{ ...peer, providers: [{ ...selection, destinationConfigIdentity: identity }] }], send, source.custom)).rejects.toThrow();
    }
    await expect(shareApiKeys(source.store, [{ ...peer, providers: [{ ...selection, destinationConfigIdentity: undefined }] }], send, source.custom)).rejects.toThrow();
    expect(calls).toBe(0);
    await dest.custom.save({ ...definition, name: 'Changed after review' }, dest.identity.id);
    expect(await shareApiKeys(source.store, [{ ...peer, providers: [selection] }], send, source.custom)).toEqual([{ id: peer.id, ok: false }]);
    expect(await dest.store.read(dest.identity.id)).toBeUndefined();
    expect(await dest.store.read(source.identity.id)).toBeUndefined();
    await dest.custom.remove(dest.identity.id);
    expect(await shareApiKeys(source.store, [{ ...peer, providers: [selection] }], send, source.custom)).toEqual([{ id: peer.id, ok: false }]);
    expect(dest.custom.identities()).toEqual([]);
    const sentBeforeSourceEdit = calls;
    await source.custom.save({ ...definition, name: 'Source changed after review' }, source.identity.id);
    expect(await shareApiKeys(source.store, [{ ...peer, providers: [selection] }], send, source.custom)).toEqual([{ id: peer.id, ok: false }]);
    expect(calls).toBe(sentBeforeSourceEdit);
  } finally { await source.close(); await dest.close(); }
});

test('unsafe custom URLs are marked ineligible and rejected on source and destination before secret transfer', async () => {
  const source = await host();
  try {
    for (const url of ['http://models.example/v1', 'http://10.attacker.example/v1', 'https://localhost/v1', 'https://127.0.0.1/v1']) expect(shareableCustomUrl(url)).toBe(false);
    for (const url of ['https://models.example/v1', 'http://10.2.3.4/v1', 'http://100.64.2.3/v1']) expect(shareableCustomUrl(url)).toBe(true);
    const unsafe = await source.custom.save({ ...definition, baseUrl: 'http://models.example/v1', apiKey: 'fake-unsafe-key' });
    const identity = source.custom.identities().find(c => c.id === unsafe.id)!;
    expect((await alignmentProviders(source.store, source.custom)).find(row => row.providerId === unsafe.id)?.shareable).toBe(false);
    let sent = false;
    const send = (async (_url: unknown) => { sent = true; return Response.json({ keys: 1 }); }) as typeof fetch;
    await expect(shareApiKeys(source.store, [{ ...peer, providers: [{ providerId: unsafe.id, type: 'api_key', configIdentity: identity, destinationConfigIdentity: identity }] }], send, source.custom)).rejects.toThrow();
    await expect(importCredentials(source.store, [{ providerId: unsafe.id, configIdentity: identity, credential: { type: 'api_key', key: 'fake-incoming', env: { KILN_CUSTOM_BASE_URL: identity.baseUrl } } }], source.custom)).rejects.toThrow();
    expect(sent).toBe(false);
    expect((await source.store.read(unsafe.id))?.type).toBe('api_key');
  } finally { await source.close(); }
});

test('custom import preserves a credential that wins the store lock after preflight', async () => {
  const underlying = new InMemoryCredentialStore();
  let armed = false;
  const winner = { type: 'api_key' as const, key: 'fake-race-winner', env: { KILN_CUSTOM_BASE_URL: definition.baseUrl } };
  const store: CredentialStore = {
    read: underlying.read.bind(underlying), list: underlying.list.bind(underlying), delete: underlying.delete.bind(underlying),
    async modify(id, fn, options) {
      if (armed) { armed = false; await underlying.modify(id, async () => winner); }
      return underlying.modify(id, fn, options);
    },
  };
  const dest = await host(store);
  try {
    armed = true;
    const entry = { providerId: dest.identity.id, configIdentity: dest.identity, credential: { type: 'api_key', key: 'fake-incoming', env: { KILN_CUSTOM_BASE_URL: definition.baseUrl } } };
    expect(await importCredentials(store, [entry], dest.custom)).toBe(0);
    expect(await store.read(dest.identity.id)).toEqual(winner);
  } finally { await dest.close(); }
});
