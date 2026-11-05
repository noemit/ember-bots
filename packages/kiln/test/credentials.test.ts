import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import {
  FileCredentialStore,
  FileModelsStore,
  hasEnvCredential,
  importOpenCodeCredentials,
  isCredentialExpired,
} from '../src/credentials';

const dirs: string[] = [];
const storeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-cred-'));
  dirs.push(dir);
  return join(dir, 'auth.json');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('stores api_key and oauth credentials, persists privately, and lists metadata', async () => {
  const file = storeFile();
  const store = new FileCredentialStore(file);
  expect(await store.read('opencode')).toBeUndefined();

  const future = Date.now() + 60_000;
  await store.modify('opencode', async () => ({ type: 'api_key', key: 'sk-test' }));
  await store.modify('xai', async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: future }));

  expect(await store.read('opencode')).toEqual({ type: 'api_key', key: 'sk-test' });
  expect((await store.list()).map((entry) => [entry.providerId, entry.type])).toEqual([
    ['opencode', 'api_key'],
    ['xai', 'oauth'],
  ]);

  // Persisted, private (no group/other access on POSIX), and readable by a fresh store.
  expect(JSON.parse(readFileSync(file, 'utf8'))['opencode']).toEqual({ type: 'api_key', key: 'sk-test' });
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  expect(await new FileCredentialStore(file).read('xai')).toEqual({ type: 'oauth', refresh: 'r', access: 'a', expires: future });
});

test('maps fireworks-ai alias to fireworks on load and on import without clobbering existing fireworks', async () => {
  const file = storeFile();
  writeFileSync(file, JSON.stringify({ 'fireworks-ai': { type: 'api_key', key: 'fw-from-file' } }));
  const store = new FileCredentialStore(file);
  expect(await store.read('fireworks')).toEqual({ type: 'api_key', key: 'fw-from-file' });
  expect((await store.list()).map((entry) => entry.providerId)).toEqual(['fireworks']);

  // Import into a fresh store maps fireworks-ai -> fireworks.
  const file2 = storeFile();
  const store2 = new FileCredentialStore(file2);
  const source = join(file2, '..', 'opencode-fw.json');
  writeFileSync(source, JSON.stringify({ 'fireworks-ai': { type: 'api', key: 'fw-from-opencode' } }));
  expect(await importOpenCodeCredentials(store2, source)).toEqual(['fireworks']);
  expect(await store2.read('fireworks')).toEqual({ type: 'api_key', key: 'fw-from-opencode' });
});

test('marks expired OAuth credentials and detects env credentials', async () => {
  const file = storeFile();
  const store = new FileCredentialStore(file);
  await store.modify('xai', async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: 100 }));
  await store.modify('kimi-coding', async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000 }));

  const listed = await store.list();
  expect(listed.find((entry) => entry.providerId === 'xai')?.expired).toBe(true);
  expect(listed.find((entry) => entry.providerId === 'kimi-coding')?.expired).toBeUndefined();
  expect(isCredentialExpired({ type: 'oauth', refresh: 'r', access: 'a', expires: 100 }, 200)).toBe(true);
  expect(isCredentialExpired({ type: 'oauth', refresh: 'r', access: 'a', expires: 300 }, 200)).toBe(false);
  expect(isCredentialExpired({ type: 'api_key', key: 'k' }, 200)).toBe(false);

  expect(hasEnvCredential('fireworks', { FIREWORKS_API_KEY: 'sk-fw' })).toBe(true);
  expect(hasEnvCredential('fireworks-ai', { FIREWORKS_API_KEY: 'sk-fw' })).toBe(true);
  expect(hasEnvCredential('fireworks', {})).toBe(false);
});

test('modify returning undefined leaves the entry unchanged', async () => {
  const file = storeFile();
  const store = new FileCredentialStore(file);
  await store.modify('deepseek', async () => ({ type: 'api_key', key: 'k' }));
  expect(await store.modify('deepseek', async () => undefined)).toEqual({ type: 'api_key', key: 'k' });
});

test('delete removes a credential', async () => {
  const file = storeFile();
  const store = new FileCredentialStore(file);
  await store.modify('google', async () => ({ type: 'api_key', key: 'k' }));
  await store.delete('google');
  expect(await store.read('google')).toBeUndefined();
  expect(await store.list()).toEqual([]);
});

test('concurrent modifies to one provider serialize without losing the file', async () => {
  const file = storeFile();
  const store = new FileCredentialStore(file);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) => store.modify('openai', async () => ({ type: 'api_key', key: `k${index}` })))
  );
  expect((await store.read('openai'))?.type).toBe('api_key');
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['openai']);
});

test('ignores malformed entries on load', async () => {
  const file = storeFile();
  writeFileSync(file, JSON.stringify({ good: { type: 'api_key', key: 'k' }, bad: { nope: true }, also: 'string' }));
  const store = new FileCredentialStore(file);
  expect((await store.list()).map((entry) => entry.providerId)).toEqual(['good']);
});

test('model catalogs persist privately, reload, and delete', async () => {
  const file = join(storeFile(), '..', 'models-store.json');
  const store = new FileModelsStore(file);
  const model = moonshotaiProvider().getModels()[0]!;
  await store.write('moonshotai', { models: [model], checkedAt: 123 });

  if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  expect(await new FileModelsStore(file).read('moonshotai')).toEqual({ models: [model], checkedAt: 123 });

  await store.delete('moonshotai');
  expect(await new FileModelsStore(file).read('moonshotai')).toBeUndefined();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
});

test('imports OpenCode credentials (api -> api_key, oauth passthrough) without clobbering', async () => {
  const file = storeFile();
  const store = new FileCredentialStore(file);
  await store.modify('opencode', async () => ({ type: 'api_key', key: 'mine' }));

  const source = join(file, '..', 'opencode-auth.json');
  writeFileSync(
    source,
    JSON.stringify({
      opencode: { type: 'api', key: 'theirs' },
      deepseek: { type: 'api', key: 'sk-deep' },
      xai: { type: 'oauth', refresh: 'r', access: 'a', expires: 42, accountId: 'acct' },
      lmstudio: { type: 'api', key: 'sk-local' },
      broken: { type: 'nope' },
    })
  );

  const imported = await importOpenCodeCredentials(store, source);
  expect(imported.sort()).toEqual(['deepseek', 'lmstudio', 'xai']);
  // Existing credential kept (no clobber).
  expect(await store.read('opencode')).toEqual({ type: 'api_key', key: 'mine' });
  expect(await store.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-deep' });
  expect(await store.read('xai')).toEqual({ type: 'oauth', refresh: 'r', access: 'a', expires: 42, accountId: 'acct' });
  expect(await store.read('broken')).toBeUndefined();

  // A missing source is a no-op, not a throw.
  expect(await importOpenCodeCredentials(store, join(file, '..', 'missing.json'))).toEqual([]);
});
