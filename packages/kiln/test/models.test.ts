import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { FileCredentialStore } from '../src/credentials';
import { hearthDefault, hearthModels, refreshProviders } from '../src/models';

const dirs: string[] = [];
const storeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-models-'));
  dirs.push(dir);
  return join(dir, 'auth.json');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.HEARTH_DEMO_API_KEY;
});

const demoProvider = () =>
  createProvider({
    id: 'hearth-demo',
    name: 'Hearth Demo',
    auth: { apiKey: envApiKeyAuth('Hearth Demo API key', ['HEARTH_DEMO_API_KEY']) },
    models: [],
    api: openAICompletionsApi(),
  });

test('a stored credential wins over the environment; env is the fallback', async () => {
  process.env.HEARTH_DEMO_API_KEY = 'env-key';

  const envOnly = createModels();
  envOnly.setProvider(demoProvider());
  expect((await envOnly.getAuth('hearth-demo'))?.auth.apiKey).toBe('env-key');

  const store = new FileCredentialStore(storeFile());
  await store.modify('hearth-demo', async () => ({ type: 'api_key', key: 'stored-key' }));
  const withStore = createModels({ credentials: store });
  withStore.setProvider(demoProvider());
  expect((await withStore.getAuth('hearth-demo'))?.auth.apiKey).toBe('stored-key');
});

test('hearthModels adopts OpenCode credentials into its own store on first boot', async () => {
  const file = storeFile();
  const source = join(file, '..', 'opencode-auth.json');
  writeFileSync(source, JSON.stringify({ deepseek: { type: 'api', key: 'sk-deep' }, xai: { type: 'api', key: 'sk-x' } }));

  const first = await hearthModels(file, source);
  expect(first.seeded.sort()).toEqual(['deepseek', 'xai']);
  expect(await first.store.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-deep' });

  // Second boot: nothing left to adopt, and the adopted key is retained (no clobber).
  const second = await hearthModels(file, source);
  expect(second.seeded).toEqual([]);
  expect(await second.store.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-deep' });
});

test('hearthModels registers opencode, kimi-coding, and moonshotai (and excludes opencode-go)', async () => {
  const file = storeFile();
  const { models, store } = await hearthModels(file, join(file, '..', 'missing.json'));
  const providerIds = models.getProviders().map((provider) => provider.id);
  expect(providerIds).toContain('opencode');
  expect(providerIds).toContain('kimi-coding');
  expect(providerIds).toContain('moonshotai');
  expect(providerIds).not.toContain('opencode-go');
  expect(hearthDefault()).toEqual({ model: { provider: 'opencode', modelId: 'glm-5.3-flash' } });

  await store.modify('moonshotai', async () => ({ type: 'api_key', key: 'sk-moon' }));
  await refreshProviders(models, store, {});
  expect((await models.getAuth('moonshotai'))?.auth.apiKey).toBe('sk-moon');
});
