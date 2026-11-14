import { expect, test } from 'bun:test';
import { InMemoryCredentialStore, type CredentialStore } from '@earendil-works/pi-ai';
import { alignmentProviders, importApiKeys, importCredentials, shareApiKeys, type AlignmentConfig } from '../src/alignment';

const oauth = { type: 'oauth' as const, access: 'fake-access', refresh: 'fake-refresh', expires: 1, accountId: 'fake-account', projectId: 'fake-project', email: 'fake@example.test', extra: { preserved: true } };
const target = { id: 'dest', label: 'Destination', url: 'https://dest.example', token: 'fake-peer-token' };
const selected = { providerId: 'openai-codex', type: 'oauth' as const, experimental: true as const };

test('metadata never reads or resolves credentials and identifies environment and missing config', async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fake-environment-secret';
  try {
    const store = { list: async () => [{ providerId: 'antigravity', type: 'oauth' }, { providerId: 'github-copilot', type: 'oauth' }], read: async () => { throw new Error('must not read'); } } as unknown as CredentialStore;
    const config: AlignmentConfig = { identities: () => [{ id: 'custom-test', name: 'Test', baseUrl: 'https://models.example/v1', modelIds: ['one'] }], withIdentity: async (_id, _identity, work) => work(), importMissingKey: async () => false };
    const rows = await alignmentProviders(store, config);
    expect(rows.find(r => r.providerId === 'openai')).toMatchObject({ source: 'environment', hasCredential: true, shareable: false });
    expect(rows.find(r => r.providerId === 'custom-test')).toMatchObject({ source: 'missing', hasCredential: false, shareable: true });
    expect(rows.find(r => r.providerId === 'github-copilot')?.shareable).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('fake-environment-secret');
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test('reviewed source sends complete envelopes to fake destination and never to response', async () => {
  const source = new InMemoryCredentialStore();
  const destination = new InMemoryCredentialStore();
  await source.modify('openai-codex', async () => oauth);
  const envelope = { type: 'api_key' as const, key: 'fake-api-key', env: { account: 'fake-account' } };
  await source.modify('generic-provider', async () => envelope);
  let calls = 0;
  const send = (async (url: unknown, init: RequestInit) => {
    calls++;
    expect(url).toBe('https://dest.example/alignment/import');
    expect(init.headers).toMatchObject({ authorization: 'Bearer fake-peer-token' });
    expect(init.redirect).toBe('error');
    const input = JSON.parse(String(init.body));
    return Response.json({ keys: await importCredentials(destination, input.credentials) });
  }) as typeof fetch;
  const results = await shareApiKeys(source, [{ ...target, providers: [selected, { providerId: 'generic-provider', type: 'api_key' }] }], send);
  expect(results).toEqual([{ id: 'dest', ok: true, keys: 2 }]);
  expect(await destination.read('openai-codex')).toEqual(oauth);
  expect(await destination.read('generic-provider')).toEqual(envelope);
  expect(JSON.stringify(results)).not.toContain('fake-');
  expect(calls).toBe(1);
  await expect(shareApiKeys(source, [target as never], send)).rejects.toThrow();
  await expect(shareApiKeys(source, [{ ...target, providers: [{ ...selected, experimental: undefined }] }], send)).rejects.toThrow();
  await expect(shareApiKeys(source, [{ ...target, providers: [{ ...selected, providerId: 'github-copilot' }] }], send)).rejects.toThrow();
  expect(calls).toBe(1);
});

test('imports validate entire batches, preserve current/env values under lock and reject legacy custom bypass', async () => {
  const store = new InMemoryCredentialStore();
  const invalids: unknown[] = [null, {}, { providerId: 'x', credential: { type: 'api_key', key: 42 } }, { providerId: 'x', credential: { type: 'api_key', key: 'fake', env: [] } }, { ...selected, credential: { ...oauth, expires: '1' } }, { ...selected, experimental: false, credential: oauth }, { ...selected, providerId: 'github-copilot', credential: oauth }];
  for (const invalid of invalids) {
    await expect(importCredentials(store, [{ providerId: 'valid-first', credential: { type: 'api_key', key: 'fake-key' } }, invalid])).rejects.toThrow();
    expect(await store.read('valid-first')).toBeUndefined();
  }
  for (const providerId of ['custom-test', 'orcarouter']) await expect(importApiKeys(store, [{ providerId, key: 'fake-key' }])).rejects.toThrow();
  const entries = [{ ...selected, credential: oauth }];
  const counts = await Promise.all([importCredentials(store, entries), importCredentials(store, entries)]);
  expect(counts.reduce((a, b) => a + b)).toBe(1);
  expect(await importCredentials(store, [{ ...selected, credential: { ...oauth, access: 'replacement' } }])).toBe(0);
  expect(await store.read('openai-codex')).toEqual(oauth);

  const old = process.env.OPENAI_API_KEY;
  const race: CredentialStore = {
    ...store,
    read: store.read.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
    modify: (id, fn) => store.modify(id, async current => { process.env.OPENAI_API_KEY = 'fake-race-env'; return fn(current); }),
  };
  try {
    delete process.env.OPENAI_API_KEY;
    expect(await importApiKeys(race, [{ providerId: 'openai', key: 'fake-incoming' }])).toBe(0);
    expect(await store.read('openai')).toBeUndefined();
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test('custom binding mismatches fail closed, and destinations fail independently without secret errors', async () => {
  const store = new InMemoryCredentialStore();
  const identity = { id: 'custom-11111111-1111-1111-1111-111111111111', name: 'Test', baseUrl: 'https://models.example/v1', modelIds: ['one'] };
  const config: AlignmentConfig = { identities: () => [identity], withIdentity: async (_id, candidate, work) => { if (JSON.stringify(candidate) !== JSON.stringify(identity)) throw new Error('fake-private-error'); return work(); }, importMissingKey: async (id, candidate, key) => {
    if (JSON.stringify(candidate) !== JSON.stringify(identity)) throw new Error('fake-private-error');
    let added = false;
    await store.modify(id, async current => { if (current) return undefined; added = true; return { type: 'api_key', key, env: { KILN_CUSTOM_BASE_URL: candidate.baseUrl } }; });
    return added;
  } };
  const entry = { providerId: identity.id, configIdentity: identity, credential: { type: 'api_key', key: 'fake-key', env: { KILN_CUSTOM_BASE_URL: identity.baseUrl } } };
  await expect(importCredentials(store, [{ ...entry, configIdentity: { ...identity, baseUrl: 'https://elsewhere.example' } }], config)).rejects.toThrow();
  expect(await store.read(identity.id)).toBeUndefined();
  await expect(importCredentials(store, [{ ...entry, credential: { ...entry.credential, unsupported: 'fake-metadata' } }], config)).rejects.toThrow();
  expect(await store.read(identity.id)).toBeUndefined();
  expect(await importCredentials(store, [entry], config)).toBe(1);
  const send = (async (url: unknown) => { if (String(url).includes('dest.example')) throw new Error('fake-key fake-peer-token'); return Response.json({ keys: 1 }); }) as typeof fetch;
  const results = await shareApiKeys(store, [{ ...target, providers: [{ providerId: identity.id, type: 'api_key', configIdentity: identity, destinationConfigIdentity: identity }] }, { ...target, id: 'second', url: 'https://second.example', providers: [{ providerId: identity.id, type: 'api_key', configIdentity: identity, destinationConfigIdentity: identity }] }], send, config);
  expect(results).toEqual([{ id: 'dest', ok: false }, { id: 'second', ok: true, keys: 1 }]);
});

test('canonical duplicate batches and malformed OAuth metadata produce no partial writes', async () => {
  const store = new InMemoryCredentialStore();
  await expect(importApiKeys(store, [{ providerId: 'fireworks', key: 'fake-a' }, { providerId: 'fireworks-ai', key: 'fake-b' }])).rejects.toThrow();
  expect(await store.list()).toEqual([]);
  for (const credential of [{ ...oauth, accountId: null }, { ...oauth, expires: Infinity }, { ...oauth, refresh: '' }, { ...oauth, access: 'a'.repeat(16385) }]) {
    await expect(importCredentials(store, [{ ...selected, credential }])).rejects.toThrow();
  }
  await expect(importCredentials(store, [{ providerId: 'antigravity', experimental: true, credential: { ...oauth, projectId: 42 } }])).rejects.toThrow();
  expect(await store.list()).toEqual([]);
  await store.modify('fireworks', async () => ({ type: 'api_key', key: 'fake-existing' }));
  expect(await importApiKeys(store, [{ providerId: 'fireworks-ai', key: 'fake-replacement' }])).toBe(0);
  expect(await store.read('fireworks')).toEqual({ type: 'api_key', key: 'fake-existing' });
  expect(await store.read('fireworks-ai')).toBeUndefined();
});

test('a destination storage failure retains successful fills and retry never overwrites them', async () => {
  const store = new InMemoryCredentialStore();
  const broken: CredentialStore = {
    read: store.read.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
    modify: (id, fn) => { if (id === 'second') throw new Error('fake-disk-failure'); return store.modify(id, fn); },
  };
  const entries = [{ providerId: 'first', credential: { type: 'api_key' as const, key: 'fake-first' } }, { providerId: 'second', credential: { type: 'api_key' as const, key: 'fake-second' } }];
  await expect(importCredentials(broken, entries)).rejects.toThrow();
  expect(await store.read('first')).toEqual(entries[0].credential);
  expect(await store.read('second')).toBeUndefined();
  expect(await importCredentials(store, entries)).toBe(1);
  expect(await store.read('first')).toEqual(entries[0].credential);
});

test('remote response bodies are bounded and not exposed, and late-added providers stay unselected', async () => {
  const store = new InMemoryCredentialStore();
  await store.modify('selected', async () => ({ type: 'api_key', key: 'fake-selected' }));
  await store.modify('late', async () => ({ type: 'api_key', key: 'fake-unreviewed' }));
  const send = (async (_url: unknown, init: RequestInit) => {
    expect(String(init.body)).not.toContain('fake-unreviewed');
    return new Response('fake-secret-remote-response'.repeat(500));
  }) as typeof fetch;
  const results = await shareApiKeys(store, [{ ...target, providers: [{ providerId: 'selected', type: 'api_key' }] }], send);
  expect(results).toEqual([{ id: 'dest', ok: false }]);
  expect(JSON.stringify(results)).not.toContain('fake-');
});

test('OAuth-only providers reject stored API-key type combinations without blocking generic keys', async () => {
  const store = new InMemoryCredentialStore();
  let calls = 0;
  const send = (async (_url: unknown) => { calls++; return Response.json({ keys: 1 }); }) as typeof fetch;
  for (const providerId of ['openai-codex', 'antigravity']) {
    await expect(importApiKeys(store, [{ providerId, key: 'fake-invalid-key' }])).rejects.toThrow();
    await expect(importCredentials(store, [{ providerId, credential: { type: 'api_key', key: 'fake-invalid-key' } }])).rejects.toThrow();
    await store.modify(providerId, async () => ({ type: 'api_key', key: 'fake-invalid-stored-key' }));
    const row = (await alignmentProviders(store)).find(info => info.providerId === providerId);
    expect(row).toMatchObject({ type: 'api_key', shareable: false });
    await expect(shareApiKeys(store, [{ ...target, providers: [{ providerId, type: 'api_key' }] }], send)).rejects.toThrow();
  }
  expect(calls).toBe(0);
  expect(await importApiKeys(store, [{ providerId: 'generic-custom-service', key: 'fake-valid-key' }])).toBe(1);
});
