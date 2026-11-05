import { afterEach, expect, test } from 'bun:test';
import type { AnyModel, Api, Model } from '@earendil-works/pi-ai';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import {
  catalogMetadata,
  liveCatalog,
  probeRoutes,
  openCodeZenWithDiscovery,
  OPENCODE_ZEN,
  overlayCatalog,
  SYNTHESIZED_IMAGE_LIMITS,
  SYNTHESIZED_THINKING_LEVELS,
  type DiscoverySite,
} from '../src/model-discovery';

/** A model of the shape pi-ai ships; only the fields the overlay cares about vary. */
const shipped = (id: string, api: Api, baseUrl: string): Model<Api> => ({
  id,
  name: id,
  api,
  provider: 'opencode',
  baseUrl,
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 131_072,
});

/** A miniature stand-in for pi-ai's Zen catalog: one per api, one mixed and one bare family. */
const zenCatalog = (): Model<Api>[] => [
  shipped('claude-haiku-4-5', 'anthropic-messages', 'https://opencode.ai/inference'),
  shipped('gemini-3.7-flash', 'google-generative-ai', 'https://opencode.ai/inference/v1'),
  shipped('gemini-3.6-flash', 'google-generative-ai', 'https://opencode.ai/inference/v1'),
  shipped('minimax-m3', 'anthropic-messages', 'https://opencode.ai/inference'),
  shipped('minimax-m2.7', 'openai-completions', 'https://opencode.ai/inference/v1'),
  shipped('gpt-5.4', 'openai-responses', 'https://opencode.ai/inference/v1'),
];

const PROBING_ZEN: DiscoverySite = {
  ...OPENCODE_ZEN,
  routes: [
    { api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/v1' },
    { api: 'anthropic-messages', baseUrl: 'https://opencode.ai/inference' },
  ],
  probe: true,
};

const noFetch = (): [string[], () => void] => {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return [calls, () => (globalThis.fetch = real)];
};

afterEach(() => {
  delete process.env.HEARTH_DISCOVER_MODELS;
});

test('the overlay keeps pi-ai entries, adds live ones, drops what the service no longer serves', () => {
  const staticModels = zenCatalog();
  const overlay = overlayCatalog(OPENCODE_ZEN, staticModels, ['claude-haiku-4-5', 'gpt-5.4', 'gemini-3.8-pro'], new Map());

  expect(overlay.models.map((model) => model.id)).toEqual(['claude-haiku-4-5', 'gpt-5.4', 'gemini-3.8-pro']);
  // The survivors are pi-ai's own entries, untouched — api, baseUrl, cost and limits included.
  expect(overlay.models[0]).toEqual(staticModels[0]);
  expect(overlay.models[1]).toEqual(staticModels[5]);
  expect(overlay.dropped.sort()).toEqual(['gemini-3.6-flash', 'gemini-3.7-flash', 'minimax-m2.7', 'minimax-m3']);
});

test('a model pi-ai has never seen borrows its family api, and falls back when the family is mixed', () => {
  const overlay = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ['gemini-3.8-pro', 'minimax-m2.5', 'omen-alpha'], new Map());

  const [gemini, minimax, omen] = overlay.models.slice(-3);
  // Every gemini… entry in the Zen catalog speaks google-generative-ai, so the new one does too.
  expect(gemini).toMatchObject({ id: 'gemini-3.8-pro', api: 'google-generative-ai', baseUrl: 'https://opencode.ai/inference/v1' });
  // minimax-* is mixed upstream (m3 anthropic, m2.7 openai) and omen-alpha has no relatives:
  // both take the endpoint's OpenAI-compatible route.
  expect(minimax).toMatchObject({ id: 'minimax-m2.5', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/v1' });
  expect(omen).toMatchObject({ id: 'omen-alpha', api: 'openai-completions' });
  expect(overlay.synthesized).toEqual([
    { id: 'gemini-3.8-pro', api: 'google-generative-ai', source: 'family', described: false, capabilitiesDefaulted: true },
    { id: 'minimax-m2.5', api: 'openai-completions', source: 'default', described: false, capabilitiesDefaulted: true },
    { id: 'omen-alpha', api: 'openai-completions', source: 'default', described: false, capabilitiesDefaulted: true },
  ]);
});

test('a catalog endpoint picks the protocol, and a Google SDK name gets Gemini onto Zen', () => {
  const metadata = new Map([
    ['minimax-m3.1-flash-free', { name: 'MiniMax M3.1 Flash Free', endpoint: 'https://opencode.ai/inference/openai/v1' }],
    ['gemini-4-argon-contributor', { name: 'Gemini 4 Argon Contributor', npm: '@ai-sdk/google', endpoint: 'https://opencode.ai/inference/google/v1beta' }],
  ]);
  const ids = ['minimax-m3.1-flash-free', 'gemini-4-argon-contributor'];

  // Probing site places Gemini via SDK name and queues the unmatched endpoint for probing.
  const probing = overlayCatalog(PROBING_ZEN, zenCatalog(), ids, metadata);
  expect(probing.models.map((model) => model.id)).toEqual(['gemini-4-argon-contributor']);
  expect(probing.models[0]).toMatchObject({
    id: 'gemini-4-argon-contributor',
    api: 'google-generative-ai',
    baseUrl: 'https://opencode.ai/inference/v1',
  });
  expect(probing.skipped).toEqual([]);
  expect(probing.unproven).toEqual([
    { id: 'minimax-m3.1-flash-free', endpoint: 'https://opencode.ai/inference/openai/v1' },
  ]);

  // A provider that doesn't probe still places Gemini; it reports only the id nothing describes.
  const unprobed = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ids, metadata);
  expect(unprobed.unproven).toEqual([]);
  expect(unprobed.models.map((model) => model.id)).toEqual(['gemini-4-argon-contributor']);
  expect(unprobed.skipped.map((entry) => entry.id)).toEqual(['minimax-m3.1-flash-free']);

  // Zen serves the OpenAI route at its /v1 base URL, so a `…/v1` endpoint is one it can stream.
  const zen = overlayCatalog(
    OPENCODE_ZEN,
    zenCatalog(),
    ['minimax-m3.1-flash-free'],
    new Map([['minimax-m3.1-flash-free', { name: 'MiniMax M3.1 Flash Free', endpoint: 'https://opencode.ai/inference/v1' }]])
  );
  expect(zen.skipped).toEqual([]);
  expect(zen.models.at(-1)).toMatchObject({
    id: 'minimax-m3.1-flash-free',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/inference/v1',
  });
});

test('a probed route offers a model the catalog put on a foreign endpoint', async () => {
  const metadata = new Map([
    ['minimax-m3.1-flash-free', { name: 'MiniMax M3.1 Flash Free', endpoint: 'https://opencode.ai/inference/openai/v1' }],
    ['gemini-4-argon-contributor', { endpoint: 'https://opencode.ai/inference/google/v1beta' }],
  ]);
  const ids = ['minimax-m3.1-flash-free', 'gemini-4-argon-contributor'];
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  const stub = (input: string | URL | Request, _init?: RequestInit): Response | undefined => {
    const url = String(input);
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    if (url.includes('models.dev')) {
      const models = Object.fromEntries([...metadata].map(([id, entry]) => [id, { name: entry.name, provider: { api: entry.endpoint } }]));
      return new Response(JSON.stringify({ opencode: { models } }), { status: 200 });
    }
    return undefined;
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const canned = stub(input, init);
    if (canned) return canned;
    const url = String(input);
    seen.push(`${url} ${JSON.parse(String(init?.body ?? '{}')).model ?? ''}`);
    const ok = url === 'https://opencode.ai/inference/v1/chat/completions' && !seen.at(-1)?.includes('gemini');
    return new Response(ok ? '{"choices":[]}' : '{"error":"nope"}', { status: ok ? 200 : 403 });
  }) as unknown as typeof fetch;
  try {
    const overlay = await liveCatalog(PROBING_ZEN, zenCatalog(), 'sk-test');
    expect(overlay.models.at(-1)).toMatchObject({
      id: 'minimax-m3.1-flash-free',
      api: 'openai-completions',
      baseUrl: 'https://opencode.ai/inference/v1',
      name: 'MiniMax M3.1 Flash Free',
    });
    expect(overlay.synthesized.at(-1)).toMatchObject({ api: 'openai-completions', source: 'probe' });
    expect(overlay.models.map((model) => model.id)).not.toContain('gemini-4-argon-contributor');
    expect(overlay.probed?.map((result) => result.id)).toEqual(['minimax-m3.1-flash-free']);
    expect(seen.every((entry) => /minimax-m3\.1|gemini-4-argon/.test(entry))).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(6);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the probe gives up after trying routes when refused', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('{"type":"error","error":{"type":"FreeTierError"}}', { status: 403 });
  }) as unknown as typeof fetch;
  try {
    const proven = await probeRoutes(
      PROBING_ZEN,
      'sk-test',
      [{ id: 'minimax-m3.1-flash-free', endpoint: 'https://opencode.ai/inference/openai/v1' }],
      PROBING_ZEN.routes!
    );
    expect(proven.size).toBe(0);
    expect(calls.length).toBe(PROBING_ZEN.routes!.length);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a model whose catalog protocol is unlisted is offered on the OpenAI-compatible route', () => {
  const metadata = new Map([['minimax-m3.1-flash-free', { name: 'MiniMax M3.1 Flash Free', protocolUnlisted: true }]]);
  const overlay = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ['minimax-m3.1-flash-free'], metadata);

  expect(overlay.skipped).toEqual([]);
  expect(overlay.models.at(-1)).toMatchObject({
    id: 'minimax-m3.1-flash-free',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/inference/v1',
    name: 'MiniMax M3.1 Flash Free',
  });
  expect(overlay.synthesized[0]).toMatchObject({ api: 'openai-completions', source: 'catalog' });
});

test('OPENCODE_ZEN speaks Gemini, OpenAI-compatible, and OpenAI responses via catalog npm', () => {
  const metadata = new Map([
    ['gemini-4-argon', { name: 'Gemini 4 Argon', npm: '@ai-sdk/google' }],
    ['kimi-k2.6', { name: 'Kimi K2.6', npm: '@ai-sdk/openai-compatible' }],
    ['gpt-7-thing', { name: 'GPT 7', npm: '@ai-sdk/openai' }],
  ]);
  const ids = ['gemini-4-argon', 'kimi-k2.6', 'gpt-7-thing'];

  const zen = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ids, metadata);
  expect(zen.models.slice(-3)).toMatchObject([
    { id: 'gemini-4-argon', api: 'google-generative-ai', baseUrl: 'https://opencode.ai/inference/v1' },
    { id: 'kimi-k2.6', api: 'openai-completions' },
    { id: 'gpt-7-thing', api: 'openai-responses' },
  ]);
  expect(zen.skipped).toEqual([]);
});

test('an unknown family member still finds its protocol in the static catalog', () => {
  const overlay = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ['gemini-4-argon'], new Map());

  // No models.dev answer, but every gemini… entry in Zen's catalog is google-generative-ai.
  expect(overlay.models.at(-1)).toMatchObject({
    id: 'gemini-4-argon',
    api: 'google-generative-ai',
    baseUrl: 'https://opencode.ai/inference/v1',
  });
  expect(overlay.synthesized[0]).toMatchObject({ api: 'google-generative-ai', source: 'family', described: false });
});

test('a placeholder id the service carries is not offered as a model', () => {
  const overlay = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ['test', 'gpt-5.4'], new Map());

  expect(overlay.models.map((model) => model.id)).toEqual(['gpt-5.4']);
  expect(overlay.skipped).toEqual([{ id: 'test', reason: 'placeholder, not a model' }]);
});

test('catalog metadata fills a synthesized model (including inputLimits and thinkingLevelMap); everything unknown stays conservative', () => {
  const metadata = new Map([
    [
      'qwen3.7-max',
      {
        name: 'Qwen3.7 Max',
        reasoning: true,
        input: ['text', 'image'] as Array<'text' | 'image'>,
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        cost: { input: 2.5, output: 7.5, cacheRead: 0.25, cacheWrite: 0 },
      },
    ],
  ]);
  const overlay = overlayCatalog(OPENCODE_ZEN, zenCatalog(), ['qwen3.7-max', 'omen-alpha'], metadata);
  const [described, bare] = overlay.models.slice(-2);

  expect(described).toMatchObject({
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: { input: 2.5, output: 7.5, cacheRead: 0.25, cacheWrite: 0 },
    type: 'chat',
    thinkingLevelMap: SYNTHESIZED_THINKING_LEVELS,
    inputLimits: SYNTHESIZED_IMAGE_LIMITS,
  });
  expect(bare).toMatchObject({
    id: 'omen-alpha',
    name: 'omen-alpha',
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  expect(bare.thinkingLevelMap).toBeUndefined();
  expect(bare.inputLimits).toBeUndefined();
  expect(overlay.synthesized.map((model) => model.described)).toEqual([true, false]);
  expect(overlay.synthesized.map((model) => model.capabilitiesDefaulted)).toEqual([false, true]);
});

test('catalogMetadata reads one provider out of models.dev, ignoring malformed entries', () => {
  const catalog = {
    opencode: {
      models: {
        'kimi-k2.6': {
          name: 'Kimi K2.6',
          reasoning: true,
          modalities: { input: ['text', 'image', 'pdf'] },
          limit: { context: 262_144, output: 65_536 },
          cost: { input: 0.95, output: 4, cache_read: 0.1, cache_write: 0 },
        },
        'glm-5.1': { name: '', reasoning: 'yes', modalities: { input: 'text' }, limit: { context: -1 }, cost: { output: 'free' } },
        'video-only': { modalities: { input: ['video'] } },
        'claude-haiku-5-5': { name: 'Claude Haiku 5.5', provider: { npm: '@ai-sdk/anthropic' } },
      },
    },
    other: { models: { 'gemini-4-argon': { name: 'Gemini 4 Argon', provider: { npm: '@ai-sdk/google' } } } },
  };
  const metadata = catalogMetadata('opencode', catalog);

  expect(metadata.get('kimi-k2.6')).toEqual({
    name: 'Kimi K2.6',
    npm: undefined,
    endpoint: undefined,
    protocolUnlisted: true,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 65_536,
    cost: { input: 0.95, output: 4, cacheRead: 0.1, cacheWrite: 0 },
  });
  expect(metadata.get('glm-5.1')).toEqual({
    name: undefined,
    npm: undefined,
    endpoint: undefined,
    protocolUnlisted: true,
    reasoning: undefined,
    input: undefined,
    contextWindow: undefined,
    maxTokens: undefined,
    cost: { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined },
  });
  expect(metadata.get('video-only')?.input).toBeUndefined();
  expect(metadata.get('claude-haiku-5-5')?.npm).toBe('@ai-sdk/anthropic');
  expect(catalogMetadata('opencode', { opencode: { models: { x: { provider: { api: 'https://opencode.ai/inference/v1' } } } } }).get('x'))
    .toMatchObject({ endpoint: 'https://opencode.ai/inference/v1', protocolUnlisted: false });
  expect(metadata.has('gemini-4-argon')).toBe(false);
  expect(catalogMetadata('other', catalog).get('gemini-4-argon')?.npm).toBe('@ai-sdk/google');
  expect(catalogMetadata('opencode', { opencode: {} }).size).toBe(0);
  expect(catalogMetadata('opencode', null).size).toBe(0);
});

test('the provider serves the static catalog, and refresh never touches the network without a key', async () => {
  const provider = openCodeZenWithDiscovery();
  const staticIds = provider.getModels().map((model) => model.id);
  const [calls, restore] = noFetch();
  try {
    await provider.refreshModels!({ publish: async () => true, allowNetwork: true, signal: new AbortController().signal });
    expect(calls).toEqual([]);
    expect(provider.getModels().map((model) => model.id)).toEqual(staticIds);
  } finally {
    restore();
  }
});

test('HEARTH_DISCOVER_MODELS=0 turns discovery off', async () => {
  process.env.HEARTH_DISCOVER_MODELS = '0';
  const provider = openCodeZenWithDiscovery();
  const staticIds = provider.getModels().map((model) => model.id);
  const [calls, restore] = noFetch();
  try {
    await provider.refreshModels!({
      credential: { type: 'api_key', key: 'sk-test' },
      publish: async () => true,
      allowNetwork: true,
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([]);
    expect(provider.getModels().map((model) => model.id)).toEqual(staticIds);
  } finally {
    restore();
  }
});

test('a live catalog replaces the served list, and an unusable one leaves it alone', async () => {
  const provider = openCodeZenWithDiscovery();
  const staticIds = provider.getModels().map((model) => model.id);
  const realFetch = globalThis.fetch;
  const round = async (body: unknown, status = 200): Promise<void> => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await provider.refreshModels!({
      credential: { type: 'api_key', key: 'sk-test' },
      publish: async (publication) => {
        publication.update?.();
        return true;
      },
      allowNetwork: true,
      signal: new AbortController().signal,
    });
  };
  try {
    // A list we cannot read (or an empty one) must not empty the provider.
    await round({ error: 'nope' });
    expect(provider.getModels().map((model) => model.id)).toEqual(staticIds);
    await round({ data: [] });
    expect(provider.getModels().map((model) => model.id)).toEqual(staticIds);

    await round({ data: [{ id: staticIds[0] }, { id: 'brand-new-model' }] });
    expect(provider.getModels().map((model) => model.id)).toEqual([staticIds[0], 'brand-new-model']);
    expect(provider.getAllModels!().every((model) => model.provider === 'opencode')).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('discovery replaces only the chat catalog — Zen keeps its classifier models', () => {
  const asShipped = opencodeProvider();
  const wrapped = openCodeZenWithDiscovery();
  const classifiers = (models: readonly AnyModel[]): string[] =>
    models.filter((model) => model.type === 'classifier').map((model) => model.id).sort();

  // Zen also serves classifier models (typesafe-system-one); discovery is about chat models and
  // must not quietly drop the rest.
  expect(classifiers(asShipped.getAllModels!()).length).toBeGreaterThan(0);
  expect(classifiers(wrapped.getAllModels!())).toEqual(classifiers(asShipped.getAllModels!()));
  expect(wrapped.getAllModels!().map((model) => model.id).sort()).toEqual(asShipped.getAllModels!().map((model) => model.id).sort());
});
