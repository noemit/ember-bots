import { afterEach, describe, expect, test } from 'bun:test';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import {
  KIMI_CODING_BASE_URL,
  KIMI_COMPAT,
  MOONSHOT_BASE_URL,
  kimiCodingModel,
  kimiOptions,
  kimiReasons,
  moonshotContextWindow,
  moonshotInputs,
  moonshotModel,
} from '../src/kimi';
import { kimiProviders, fetchMoonshotCatalog } from '../src/models';

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env.KIMI_BASE_URL;
  delete process.env.KIMI_CODING_BASE_URL;
  delete process.env.KIMI_REASONING;
  delete process.env.KIMI_API_KEY;
  delete process.env.KIMI_CODING_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  globalThis.fetch = originalFetch;
});

describe('env parsing', () => {
  test('no env at all points at Moonshot and K3 with reasoning on', () => {
    expect(kimiOptions({})).toEqual({
      baseUrl: MOONSHOT_BASE_URL,
      codingBaseUrl: KIMI_CODING_BASE_URL,
      reasoning: true,
    });
  });

  test('both base URLs can be moved to a gateway independently', () => {
    const options = kimiOptions({ KIMI_BASE_URL: 'https://gateway.test/v1/', KIMI_CODING_BASE_URL: 'https://plan.test/v1' });
    expect(options.baseUrl).toBe('https://gateway.test/v1/');
    expect(options.codingBaseUrl).toBe('https://plan.test/v1');
  });

  test('KIMI_REASONING=off is the escape hatch for an endpoint that rejects reasoning_effort', () => {
    expect(kimiOptions({ KIMI_REASONING: 'off' }).reasoning).toBe(false);
    expect(kimiOptions({ KIMI_REASONING: '0' }).reasoning).toBe(false);
    expect(kimiOptions({ KIMI_REASONING: 'on' }).reasoning).toBe(true);
  });
});

describe('the /models catalog', () => {
  // Verbatim from https://api.moonshot.ai/v1/models (2026-10-23): six models, every one image-capable,
  // the three K3 entries reasoning-only with low/high/max efforts, each reporting a 1M window.
  const kimiK3 = {
    id: 'kimi-k3',
    object: 'model',
    supports_image_in: true,
    supports_reasoning: true,
    context_length: 1_048_576,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    reasoning: { type: 'only', effort: { valid: ['low', 'high', 'max'], default: 'max' } },
    limit: { context: 1_048_576 },
  };
  const kimiK26 = { id: 'kimi-k2.6', context_length: 262_144, modalities: { input: ['text', 'image', 'video'] } };

  test('the window is read from context_length, then limit.context', () => {
    expect(moonshotContextWindow(kimiK3)).toBe(1_048_576);
    expect(moonshotContextWindow({ id: 'x', limit: { context: 131_072 } })).toBe(131_072);
    expect(moonshotContextWindow({ id: 'x' })).toBeUndefined();
    expect(moonshotContextWindow({ id: 'x', context_length: 0 })).toBeUndefined();
  });

  test('image input comes from the modalities, and absence means text only', () => {
    expect(moonshotInputs(kimiK3)).toEqual(['text', 'image']);
    expect(moonshotInputs(kimiK26)).toEqual(['text', 'image']);
    expect(moonshotInputs({ id: 'x' })).toEqual(['text']);
  });

  test('a catalog entry keeps its own id, 1M window, shipped pricing/maxTokens, image input and Kimi thinking levels', () => {
    const model = moonshotModel(kimiK3, kimiOptions({}));
    expect(model.provider).toBe('moonshotai');
    expect(model.id).toBe('kimi-k3');
    expect(model.baseUrl).toBe(MOONSHOT_BASE_URL);
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBe(1_048_576);
    expect(model.maxTokens).toBe(1_048_576);
    expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
    expect(model.input).toEqual(['text', 'image']);
    expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
    expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(model.compat?.maxTokensField).toBe('max_tokens');
    expect(model.inputLimits?.images?.resize?.maxWidth).toBe(2000);
  });

  test('K2.x reasons with KIMI_COMPAT and shipped pricing/limits, and KIMI_REASONING=off drops it entirely', () => {
    const k26 = moonshotModel(kimiK26, kimiOptions({}));
    expect(k26.contextWindow).toBe(262_144);
    expect(k26.maxTokens).toBe(262_144);
    expect(k26.cost).toEqual({ input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 });
    expect(k26.reasoning).toBe(true);
    expect(k26.compat).toEqual(KIMI_COMPAT);
    expect(k26.thinkingLevelMap).toBeUndefined();
    const off = moonshotModel(kimiK3, kimiOptions({ KIMI_REASONING: 'off' }));
    expect(off.reasoning).toBe(false);
    expect(off.compat).toBeUndefined();
    expect(off.thinkingLevelMap).toBeUndefined();
  });

  test('an entry that reports nothing falls back to Moonshot numbers rather than 128k', () => {
    const model = moonshotModel({ id: 'kimi-k3.9' }, kimiOptions({}));
    expect(model.contextWindow).toBe(262_144);
    expect(model.maxTokens).toBe(32_768);
    expect(model.compat).toEqual(KIMI_COMPAT);
    expect(kimiReasons('kimi-k3.9')).toBe(true);
  });
});

describe('the two provider slots', () => {
  test('kimi-coding is registered without a key; moonshotai is not', () => {
    // kimi-coding can earn its credential from a subscription sign-in (pi-ai ships "Sign in with Kimi
    // Code"), so hiding it until a key exists would hide the only button that obtains one.
    expect(kimiProviders([], {}).map((provider) => provider.id)).toEqual(['kimi-coding']);
  });

  test("kimi-coding keeps pi-ai's shipped OAuth instead of dropping it on the rebuild", () => {
    const [coding] = kimiProviders([], {});
    expect(coding.auth.oauth?.loginLabel).toBe('Sign in with Kimi Code');
    expect(typeof coding.auth.oauth?.login).toBe('function');
  });

  test('a moonshot platform key adds moonshotai alongside the always-on coding slot', () => {
    expect(kimiProviders([], { KIMI_API_KEY: 'sk-x' }).map((provider) => provider.id)).toEqual(['kimi-coding', 'moonshotai']);
    expect(kimiProviders([], { MOONSHOT_API_KEY: 'sk-x' }).map((provider) => provider.id)).toEqual(['kimi-coding', 'moonshotai']);
  });

  test('a coding-plan key registers kimi-coding only', () => {
    expect(kimiProviders([], { KIMI_CODING_API_KEY: 'kc-x' }).map((provider) => provider.id)).toEqual(['kimi-coding']);
  });

  test('a stored credential registers its slot with no env var set at all', () => {
    const ids = kimiProviders(['moonshotai', 'kimi-coding'], {}).map((provider) => provider.id);
    expect(ids).toEqual(['kimi-coding', 'moonshotai']);
  });

  test("moonshotai holds pi-ai's Moonshot catalog; kimi-coding its plan catalog and the plan URL", () => {
    const [coding, moonshot] = kimiProviders(['moonshotai', 'kimi-coding'], {});
    expect(moonshot.baseUrl).toBe(MOONSHOT_BASE_URL);
    expect(moonshot.getModels().map((model) => model.id)).toEqual(moonshotaiProvider().getModels().map((model) => model.id));
    expect(moonshot.getModels().every((model) => model.provider === 'moonshotai')).toBe(true);
    expect(coding.baseUrl).toBe(KIMI_CODING_BASE_URL);
    // The list is pi-ai's `kimi-coding` catalog, re-homed: compare against it rather than pinning a
    // snapshot, so a model upstream adds appears here without the test calling it a regression.
    expect(coding.getModels().map((model) => model.id)).toEqual(kimiCodingProvider().getModels().map((model) => model.id));
    // Re-homed, so a gateway URL reaches it, and the Kimi wire shape survives that.
    const k3 = coding.getModels().find((model) => model.id === 'k3')!;
    expect(k3.baseUrl).toBe(KIMI_CODING_BASE_URL);
    expect(k3.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(k3.contextWindow).toBe(1_048_576);
  });

  test('KIMI_CODING_BASE_URL moves the plan slot without touching moonshotai', () => {
    const [coding, moonshot] = kimiProviders(['moonshotai', 'kimi-coding'], { KIMI_CODING_BASE_URL: 'https://plan.test/v1' });
    expect(coding.baseUrl).toBe('https://plan.test/v1');
    expect(coding.getModels()[0]?.baseUrl).toBe('https://plan.test/v1');
    expect(moonshot.baseUrl).toBe(MOONSHOT_BASE_URL);
  });

  test('kimiCodingModel keeps the catalog limits and per-model compat on a foreign base URL', () => {
    const catalog = kimiCodingProvider().getModels().find((model) => model.id === 'k3')!;
    const model = kimiCodingModel(catalog, { ...kimiOptions({}), codingBaseUrl: 'https://gateway.test/v1' });
    expect(model.baseUrl).toBe('https://gateway.test/v1');
    expect(model.contextWindow).toBe(catalog.contextWindow);
    expect(model.compat?.thinkingFormat).toBe('openai');
    expect(model.inputLimits?.images?.resize?.maxBytes).toBe(4_718_592);
    expect(kimiCodingModel(catalog, { ...kimiOptions({}), reasoning: false }).reasoning).toBe(false);
  });

  test('kimiCodingModel does not give the K2 highspeed entry K3-only wire options', () => {
    const catalog = kimiCodingProvider().getModels().find((model) => model.id === 'kimi-for-coding-highspeed')!;
    const model = kimiCodingModel(catalog, { ...kimiOptions({}), codingBaseUrl: 'https://gateway.test/v1' });
    expect(catalog.compat?.supportsReasoningEffort).toBe(false);
    expect(model.compat?.supportsReasoningEffort).toBe(false);
    expect(model.compat?.thinkingFormat).toBe('deepseek');
    expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
  });
});

test('moonshotai reads /models with its resolved credential and serves what it lists', async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(`${MOONSHOT_BASE_URL}/models`);
    expect(init?.headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect(init?.signal).toBe(signal);
    return new Response(
      JSON.stringify({ data: [{ id: 'kimi-k3', context_length: 1_048_576, modalities: { input: ['text', 'image'] }, reasoning: { type: 'only' } }] }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  const signal = controller.signal;
  const fetchedIds: string[] = [];
  const moonshot = kimiProviders(['moonshotai'], {}).find((provider) => provider.id === 'moonshotai')!;
  await moonshot.refreshModels?.({
    credential: { type: 'api_key', key: 'sk-test' },
    publish: async (publication) => {
      if (publication.persist) fetchedIds.push(...publication.persist.models.map((model) => model.id));
      publication.update?.();
      return true;
    },
    allowNetwork: true,
    signal,
  });
  expect(fetchedIds).toEqual(['kimi-k3']);
  const fetched = moonshot.getModels().find((model) => model.id === 'kimi-k3');
  expect(fetched?.contextWindow).toBe(1_048_576);
  expect(fetched?.input).toEqual(['text', 'image']);
});

test('a /models failure or an empty list leaves the shipped catalog in place', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  await expect(fetchMoonshotCatalog(kimiOptions({}))).rejects.toThrow('moonshotai /models failed: 500');
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
  await expect(fetchMoonshotCatalog(kimiOptions({}))).rejects.toThrow('listed nothing');
});
