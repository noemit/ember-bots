import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { OllamaSettings, ollamaAddress } from '../src/ollama-settings';
import { probeLocalRuntime, type LocalRuntimeProbe } from '../src/local-models';

const home = mkdtempSync(join(tmpdir(), 'kiln-ollama-'));
const requests: { path: string; auth: string | null; body?: Record<string, unknown> }[] = [];
let tags: unknown = { models: [{ name: 'llama3.2:3b' }] };
let status = 200;
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push({ path, auth: request.headers.get('authorization'), ...(request.method === 'POST' ? { body: await request.json() as Record<string, unknown> } : {}) });
  if (path === '/api/tags') return Response.json(tags, { status });
  if (path === '/v1/chat/completions') return new Response('data: {"id":"mock","object":"chat.completion.chunk","created":1,"model":"llama3.2:3b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  return new Response('wrong path', { status: 404 });
} });
const address = 'http://127.0.0.1:' + upstream.port;
afterAll(() => { upstream.stop(true); rmSync(home, { recursive: true, force: true }); });

test('safe host-owned addresses allow local, LAN, container, IPv6 and TLS without API paths', () => {
  for (const value of ['http://localhost:11434', 'http://ollama:11434', 'http://192.168.1.2:11434', 'http://[::1]:11434', 'https://ollama.example']) expect(ollamaAddress(value + '/')).toBe(value);
  for (const value of ['file:///etc/passwd', 'http://user:secret@host', 'http://host?token=secret', 'http://host/v1', 'host:11434']) expect(() => ollamaAddress(value)).toThrow();
});

test('empty, wrong service, malformed entries, rejected access and absent Ollama stay distinct', async () => {
  tags = { models: [] };
  expect(await probeLocalRuntime('ollama', { baseUrl: address })).toMatchObject({ running: true, hasModels: false, models: [] });
  for (const invalid of [{ data: [] }, { models: [null] }, { models: [{ name: 7 }] }, { models: ['bad'] }]) {
    tags = invalid;
    const result = await probeLocalRuntime('ollama', { baseUrl: address });
    expect(result.running).toBe(true); expect(result.hasModels).toBe(false); expect(result.problem).toMatch(/Ollama|service/); expect(result.problem).toMatch(/Check|Test/);
  }
  status = 401; tags = { error: 'private-upstream-content' };
  const rejected = await probeLocalRuntime('ollama', { baseUrl: address });
  expect(rejected.problem).toContain('refused access'); expect(rejected.problem).not.toContain('private-upstream');
  status = 200;
  const absent = await probeLocalRuntime('ollama', { baseUrl: 'http://127.0.0.1:1' });
  expect(absent.running).toBe(false); expect(absent.problem).toContain('Ollama');
});

test('save, reload, edit, reset and real mocked inference keep one keyless built-in provider', async () => {
  tags = { models: [{ name: 'llama3.2:3b' }, { name: 'llama3.2:3b' }] };
  const previousEnv = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = address;
  try {
    const models = createModels();
    const probes: LocalRuntimeProbe[] = [];
    const settings = new OllamaSettings(home, models, probes); await settings.ready;
    expect(settings.state().customAddress).toBe(false);
    await settings.save(address);
    expect(JSON.parse(readFileSync(join(home, 'ollama.json'), 'utf8'))).toEqual({ baseUrl: address });
    expect(statSync(join(home, 'ollama.json')).mode & 0o777).toBe(0o600);
    expect(models.getProviders().map(provider => provider.id)).toEqual(['ollama']);
    const model = models.getModel('ollama', 'llama3.2:3b')!;
    expect(model.baseUrl).toBe(address + '/v1'); expect(model.input).toEqual(['text']); expect(model.reasoning).toBe(false);
    const response = await models.complete(model, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] });
    expect(response.stopReason).not.toBe('error');
    expect(requests.at(-1)).toMatchObject({ path: '/v1/chat/completions', auth: null, body: { model: 'llama3.2:3b' } });
    const reloaded = new OllamaSettings(home, createModels(), []); await reloaded.ready;
    expect(reloaded.state()).toMatchObject({ baseUrl: address, customAddress: true, models: ['llama3.2:3b'] });
    await settings.save('http://127.0.0.1:1');
    expect(settings.state().running).toBe(false); expect(models.getModels('ollama')).toEqual([]);
    const stale = await models.complete(model, { messages: [{ role: 'user', content: 'Never send', timestamp: Date.now() }] }).catch(() => null);
    expect(stale === null || stale.stopReason === 'error').toBe(true);
    await settings.save(undefined, true);
    expect(settings.state()).toMatchObject({ baseUrl: address, customAddress: false, hasModels: true });
    expect(models.getProviders().filter(provider => provider.id === 'ollama')).toHaveLength(1);
  } finally { if (previousEnv === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = previousEnv; }
});

test('catalogue refresh replaces installed IDs and cached destinations never override the saved host', async () => {
  const { InMemoryModelsStore } = await import('@earendil-works/pi-ai');
  const { ollamaProvider } = await import('../src/local-models');
  const cache = new InMemoryModelsStore();
  const models = createModels({ modelsStore: cache });
  tags = { models: [{ name: 'old-installed' }] };
  models.setProvider(ollamaProvider({ baseUrl: address, modelIds: ['old-installed'] }));
  await models.refresh();
  const old = models.getModel('ollama', 'old-installed')!;
  tags = { models: [] };
  await models.refresh();
  expect(models.getModels('ollama')).toEqual([]);
  const refused = await models.complete(old, { messages: [{ role: 'user', content: 'Do not send', timestamp: Date.now() }] }).catch(() => null);
  expect(refused === null || refused.stopReason === 'error').toBe(true);
  tags = { models: [{ name: 'new-installed' }] };
  await models.refresh();
  expect(models.getModels('ollama').map(model => model.id)).toEqual(['new-installed']);
  models.setProvider(ollamaProvider({ baseUrl: 'http://new.invalid:11434', modelIds: ['new-installed'] }));
  await models.refresh({ allowNetwork: false });
  expect(models.getModels('ollama').map(model => model.baseUrl)).toEqual(['http://new.invalid:11434/v1']);
  const count = requests.length;
  const rejected = await models.complete(old, { messages: [{ role: 'user', content: 'Do not send', timestamp: Date.now() }] }).catch(() => null);
  expect(rejected === null || rejected.stopReason === 'error').toBe(true);
  expect(requests.length).toBe(count);
});

test('invalid optional environment URLs cannot block Kiln startup or leak embedded credentials', async () => {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = 'http://secret:password@ollama:bad';
  const invalidHome = mkdtempSync(join(tmpdir(), 'kiln-invalid-ollama-'));
  try {
    const settings = new OllamaSettings(invalidHome, createModels(), []); await settings.ready;
    expect(settings.state().running).toBe(false);
    expect(settings.state().problem).toContain('Change address');
    expect(JSON.stringify(settings.state())).not.toMatch(/secret|password/);
    tags = { models: [] };
    await settings.save(address);
    expect(settings.state()).toMatchObject({ running: true, hasModels: false, baseUrl: address });
    const lm = await probeLocalRuntime('lmstudio', { baseUrl: 'http://host:invalid' });
    expect(lm.running).toBe(false); expect(lm.problem).toContain('Correct');
  } finally { if (previous === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = previous; rmSync(invalidHome, { recursive: true, force: true }); }
});

test('authenticated Ollama routes keep host configuration separate from current and default models', async () => {
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { createRegistry, Harness } = await import('@earendil-works/pi-durable');
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node');
  const { hearthConfig } = await import('../src/config');
  const { startHearthServer } = await import('../src/server');
  const routeHome = mkdtempSync(join(tmpdir(), 'kiln-ollama-routes-'));
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = address;
  tags = { models: [{ name: 'llama3.2:3b' }] };
  const models = createModels();
  const settings = new OllamaSettings(routeHome, models, []); await settings.ready;
  const storage = await openNodeSqliteStorage(join(routeHome, 'test.sqlite'));
  const harness = await Harness.open(storage, { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? routeHome }) }, BACKGROUND_CONTEXT);
  const token = 'ollama-test-0123456789abcdef0123456789abcdef';
  const defaultModel = { provider: 'existing', modelId: 'unchanged' };
  const server = startHearthServer({ config: hearthConfig({ home: routeHome, port: 0, workspace: routeHome }), token, storage, harness, models, ollamaSettings: settings, defaultAgent: { model: defaultModel } });
  const api = (path: string, method = 'GET', body?: unknown) => fetch(server.url + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    expect((await fetch(server.url + '/local-runtimes/ollama')).status).toBe(401);
    expect((await api('/local-runtimes/ollama', 'PUT', { baseUrl: address })).status).toBe(200);
    const catalog = await (await api('/models')).json() as { default: unknown; models: { provider: string; id: string; baseUrl: string }[] };
    expect(catalog.default).toEqual(defaultModel);
    expect(catalog.models).toMatchObject([{ provider: 'ollama', id: 'llama3.2:3b', baseUrl: address + '/v1' }]);
    const invalid = await api('/local-runtimes/ollama', 'PUT', { baseUrl: 'http://user:secret@host' });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('secret');
    expect((await api('/local-runtimes/ollama', 'DELETE')).status).toBe(200);
    expect(await (await api('/local-runtimes/ollama')).json()).toMatchObject({ baseUrl: address, customAddress: false });
    expect((await (await api('/providers')).json() as { default: unknown }).default).toEqual(defaultModel);
  } finally {
    await server.close(); await harness.close(BACKGROUND_CONTEXT);
    if (previous === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = previous;
    rmSync(routeHome, { recursive: true, force: true });
  }
});
