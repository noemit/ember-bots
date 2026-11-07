import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importApiKeys, mergePeers, portablePeer, shareApiKeys, storedApiKeys } from '../src/alignment';
import { FileCredentialStore } from '../src/credentials';
const peer = (url: string, token = 'private-token') => ({ id: 'one', label: 'One', url, token });
test('portable peer validation rejects ambiguous addresses and public plaintext', () => {
  for (const url of ['http://localhost:3002', 'http://127.1:3002', 'http://[::1]:3002', 'http://example.com', 'https://user:pass@example.com', 'file:///tmp/foo']) expect(portablePeer(peer(url))).toBeNull();
  expect(portablePeer(peer('http://100.64.0.2:3002'))).not.toBeNull();
});
test('peer merge is idempotent and preserves existing URLs and tokens', () => {
  const old = peer('http://100.64.0.1:3002');
  const incoming = peer('http://100.64.0.2:3002');
  const merged = mergePeers([old], [peer(old.url, 'changed'), incoming]);
  expect(merged[0]).toEqual(old);
  expect(merged[1].id).not.toBe(old.id);
  expect(mergePeers(merged, [incoming])).toEqual(merged);
});
test('provider alignment never exports OAuth and never overwrites an existing credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-alignment-'));
  try {
    const store = new FileCredentialStore(join(home, 'auth.json'));
    await store.modify('openai', async () => ({ type: 'api_key', key: 'existing-key' }));
    await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'access-private', refresh: 'refresh-private', expires: Date.now() + 60000 }));
    expect(await storedApiKeys(store)).toEqual([{ providerId: 'openai', key: 'existing-key' }]);
    const sent: RequestInit[] = [];
    const send = (async (_url: unknown, init: RequestInit) => {
      sent.push(init);
      return sent.length === 1 ? Response.json({ keys: 1 }) : Response.redirect('https://elsewhere.example');
    }) as typeof fetch;
    const shared = await shareApiKeys(store, [peer('https://one.example'), { ...peer('https://two.example'), id: 'two' }], send);
    expect(shared).toEqual([{ id: 'one', ok: true, keys: 1 }, { id: 'two', ok: false }]);
    expect(sent[0].redirect).toBe('error');
    expect(String(sent[0].body)).not.toContain('refresh-private');
    expect(JSON.parse(String(sent[0].body)).keys).toEqual([{ providerId: 'openai', key: 'existing-key' }]);
    expect(JSON.stringify(shared)).not.toContain('private-token');
    const entries = [{ providerId: 'alignment-test', key: 'new-key' }, { providerId: 'openai', key: 'wrong-key' }, { providerId: 'openai-codex', key: 'wrong-key' }];
    const results = await Promise.all([importApiKeys(store, entries), importApiKeys(store, entries)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'existing-key' });
    expect((await store.read('openai-codex'))?.type).toBe('oauth');
    await expect(importApiKeys(store, [{ providerId: 'bad/id', key: 'no' }])).rejects.toThrow();
    expect(await new FileCredentialStore(join(home, 'auth.json')).read('alignment-test')).toEqual({ type: 'api_key', key: 'new-key' });
  } finally { await rm(home, { recursive: true, force: true }); }
});
