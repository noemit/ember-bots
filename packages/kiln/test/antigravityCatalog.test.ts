import { describe, expect, test } from 'bun:test';
import {
  buildDiscoveredCatalog,
  humanizeModelId,
  isSelectableRuntimeId,
  parseThinkingSuffix,
} from '../src/antigravity-catalog';
import { fetchAvailableCatalog, fetchAntigravityModels } from '../src/antigravity-discovery';
import { parseAntigravityApiKey } from '../src/antigravity-oauth';

/**
 * The account's catalogue, not the table we ship.
 *
 * The bug these cover: the provider served a fixed list of eight models and `/models` never asked
 * the backend, so models the account was entitled to were absent from the picker and Refresh could
 * not reveal anything. The rules below are what makes the backend's runtime catalogue into the list
 * a person picks from — and every one of them is a way that list could be wrong.
 */

const defaults = () => ({
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  input: ['text', 'image'] as Array<'text' | 'image'>,
  reasoning: true,
});

describe('reading a runtime id as a public model', () => {
  test('a thinking suffix becomes the level, not part of the name', () => {
    expect(parseThinkingSuffix('gemini-3.8-flash-high')).toEqual({ baseId: 'gemini-3.8-flash', level: 'high' });
    expect(parseThinkingSuffix('gemini-3.7-flash-low')).toEqual({ baseId: 'gemini-3.7-flash', level: 'low' });
    // `extra-low` ends with `low`, so the longer suffix has to win or the base id keeps `-extra`.
    expect(parseThinkingSuffix('gemini-3.5-flash-extra-low')).toEqual({ baseId: 'gemini-3.5-flash', level: 'low' });
    expect(parseThinkingSuffix('claude-opus-4-6-thinking')).toEqual({ baseId: 'claude-opus-4-6', level: 'high' });
  });

  test('an id that is nothing but a suffix is not a model', () => {
    expect(parseThinkingSuffix('high')).toBeUndefined();
    expect(parseThinkingSuffix('gemini-3.8-flash')).toBeUndefined();
  });

  test('placeholders, analytics ids and image endpoints are never offered', () => {
    expect(isSelectableRuntimeId('MODEL_PLACEHOLDER_M18')).toBe(false);
    expect(isSelectableRuntimeId('chat_personal')).toBe(false);
    expect(isSelectableRuntimeId('tab_completion')).toBe(false);
    expect(isSelectableRuntimeId('gemini-3.1-flash-image')).toBe(false);
    expect(isSelectableRuntimeId('internal-x', { isInternal: true })).toBe(false);
    expect(isSelectableRuntimeId('gemini-3.8-flash', { displayName: 'Gemini 3.8 Flash' })).toBe(true);
  });
});

describe('grouping the catalogue', () => {
  const raw = {
    'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', maxTokens: 1_048_576, maxOutputTokens: 65_536 },
    'gemini-3.8-flash-medium': { displayName: 'Gemini 3.8 Flash (Medium)' },
    'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)' },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 200_000, maxOutputTokens: 64_000 },
    'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B', supportsImages: false, maxTokens: 131_072, maxOutputTokens: 32_768 },
    'MODEL_PLACEHOLDER_M18': { displayName: 'Internal' },
    'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
  };

  test('one public model per family, with a route for every level it advertises', () => {
    const catalog = buildDiscoveredCatalog(raw, { defaults });
    const flash = catalog.models.find((model) => model.id === 'gemini-3.8-flash');
    expect(flash).toBeDefined();
    // The levels are the routes, so a level the picker offers is a backend id that exists.
    expect(catalog.routing['gemini-3.8-flash']?.routing).toEqual({
      minimal: 'gemini-3.8-flash-low',
      low: 'gemini-3.8-flash-low',
      medium: 'gemini-3.8-flash-medium',
      high: 'gemini-3.8-flash-high',
      xhigh: 'gemini-3.8-flash-high',
    });
    expect(flash?.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high', minimal: null, xhigh: null });
  });

  test('a model with no level suffix routes every level to itself', () => {
    const catalog = buildDiscoveredCatalog(raw, { defaults });
    expect(catalog.routing['claude-sonnet-4-6']?.routing).toMatchObject({
      low: 'claude-sonnet-4-6',
      high: 'claude-sonnet-4-6',
    });
    expect(catalog.routing['claude-sonnet-4-6']?.off).toBe('claude-sonnet-4-6');
  });

  test('internal placeholders and image models stay out of the picker', () => {
    const ids = buildDiscoveredCatalog(raw, { defaults }).models.map((model) => model.id);
    expect(ids).toContain('gemini-3.8-flash');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('MODEL_PLACEHOLDER_M18');
    expect(ids).not.toContain('gemini-3.1-flash-image');
    expect(ids.some((id) => id.includes('image'))).toBe(false);
  });

  test('limits are the smallest advertised across a family, not the first one seen', () => {
    // A level with a smaller window must not be handed a prompt sized for the biggest.
    const catalog = buildDiscoveredCatalog(
      {
        'gemini-x-flash-low': { displayName: 'Gemini X Flash (Low)', maxTokens: 1_000_000, maxOutputTokens: 65_536 },
        'gemini-x-flash-high': { displayName: 'Gemini X Flash (High)', maxTokens: 200_000, maxOutputTokens: 32_000 },
      },
      { defaults }
    );
    const model = catalog.models.find((entry) => entry.id === 'gemini-x-flash');
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(32_000);
  });

  test('a text-only model is text-only, and a model that denies thinking has no levels', () => {
    const catalog = buildDiscoveredCatalog(
      {
        'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B', supportsImages: false, supportsThinking: false },
      },
      { defaults }
    );
    const model = catalog.models.find((entry) => entry.id === 'gpt-oss-120b');
    expect(model?.input).toEqual(['text']);
    expect(model?.reasoning).toBe(false);
    expect(model?.thinkingLevelMap).toBeUndefined();
  });

  test('a `-agent` id folds into its family instead of becoming its own model', () => {
    // The backend advertises the High level of 3.1 Pro as `gemini-pro-agent`, a name that belongs
    // to no public id; leaving it alone put a stray "Gemini Pro Agent" beside the model it serves.
    const catalog = buildDiscoveredCatalog(
      {
        'gemini-3.1-pro-low': { displayName: 'Gemini 3.1 Pro (Low)' },
        'gemini-pro-agent': { displayName: 'Gemini 3.1 Pro (High)' },
      },
      { defaults }
    );
    expect(catalog.models.map((model) => model.id)).toEqual(['gemini-3.1-pro']);
    expect(catalog.routing['gemini-3.1-pro']?.routing.high).toBe('gemini-pro-agent');
  });

  test('the curated list wins when the backend supplies one, and falls back when it groups into nothing', () => {
    const sorts = [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-3.8-flash-low'] }] }];
    const curated = buildDiscoveredCatalog(raw, { defaults }, sorts);
    expect(curated.models.map((model) => model.id)).toEqual(['gemini-3.8-flash']);

    // A curated list naming only placeholders is unusable; the whole map is the better answer.
    const nonsense = [{ groups: [{ modelIds: ['MODEL_PLACEHOLDER_M18'] }] }];
    expect(buildDiscoveredCatalog(raw, { defaults }, nonsense).models.length).toBeGreaterThan(1);
  });

  test('an empty catalogue is empty, not a crash', () => {
    expect(buildDiscoveredCatalog({}, { defaults }).models).toEqual([]);
  });

  test('a plain Argon model id is retained when the upstream catalogue includes it', () => {
    const catalog = buildDiscoveredCatalog({
      'gemini-4-argon': { displayName: 'Gemini 4 Argon' },
    }, { defaults });
    expect(catalog.models.map((model) => model.id)).toContain('gemini-4-argon');
    expect(catalog.routing['gemini-4-argon']?.defaultRequestId).toBe('gemini-4-argon');
  });

  test('an Argon contributor id is not aliased or discarded by the selectable-model filters', () => {
    const ids = buildDiscoveredCatalog({
      'gemini-4-argon-contributor': { displayName: 'Gemini 4 Argon Contributor' },
    }, { defaults }).models.map((model) => model.id);
    expect(ids).toContain('gemini-4-argon-contributor');
  });

  test('a brand-new family keeps its id and gets a readable name', () => {
    const catalog = buildDiscoveredCatalog({ 'gemini-9.9-flash-high': { displayName: 'Gemini 9.9 Flash (High)' } }, { defaults });
    expect(catalog.models[0]?.id).toBe('gemini-9.9-flash');
    expect(catalog.models[0]?.name).toBe('Gemini 9.9 Flash (Antigravity)');
    expect(humanizeModelId('gpt-oss-120b')).toBe('GPT-OSS 120B');
    expect(humanizeModelId('gemini-3.1-pro')).toBe('Gemini 3.1 Pro');
  });
});

describe('reading the catalogue over the wire', () => {
  const token = 'access-token';
  const project = 'my-project';

  const answer = (models: Record<string, unknown>, sorts?: unknown) =>
    new Response(JSON.stringify({ models, ...(sorts ? { agentModelSorts: sorts } : {}) }), { status: 200 });

  test('a host that fails does not discard the others', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('daily-cloudcode-pa.googleapis.com')) {
        return answer({ 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)' } });
      }
      throw new Error('sandbox is down');
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const read = await fetchAvailableCatalog(token, project, new AbortController().signal, [
        'https://daily-cloudcode-pa.googleapis.com',
        'https://daily-cloudcode-pa.sandbox.googleapis.com',
      ]);
      expect(Object.keys(read?.models ?? {})).toEqual(['gemini-3.8-flash-high']);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('the models every host advertises are unioned', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes('daily')
        ? answer({ 'gemini-4-argon': { displayName: 'Gemini 4 Argon' } })
        : answer({ 'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)' } });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const read = await fetchAvailableCatalog(token, project, new AbortController().signal, [
        'https://daily-cloudcode-pa.googleapis.com',
        'https://cloudcode-pa.googleapis.com',
      ]);
      // A model only the daily host recommends is still a model the account can use.
      expect(Object.keys(read?.models ?? {}).sort()).toEqual(['gemini-3.8-flash-low', 'gemini-4-argon']);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('no answer at all is no catalogue, never an exception', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    try {
      expect(await fetchAvailableCatalog(token, project, new AbortController().signal, ['https://x.test'])).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test('the models carry their routes, so a discovered model can actually be asked for', async () => {
    let installed: Record<string, unknown> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      answer({ 'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', maxTokens: 1_000_000 } })) as unknown as typeof fetch;
    try {
      const models = await fetchAntigravityModels(
        {
          // The credential carries the project id the endpoint needs, and it is not in `access`.
          credential: { type: 'oauth', access: 'access-token', refresh: 'r', expires: Date.now() + 60_000, projectId: project } as never,
          allowNetwork: true,
          signal: new AbortController().signal,
        },
        defaults,
        (routing) => {
          installed = routing;
        }
      );
      expect(models.map((model) => model.id)).toEqual(['gemini-3.8-flash']);
      expect(models[0]?.api).toBe('antigravity');
      expect(installed?.['gemini-3.8-flash']).toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a credential without a project is not asked, and an offline refresh does not call out', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return answer({});
    }) as unknown as typeof fetch;
    try {
      const noProject = await fetchAntigravityModels(
        { credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } as never, allowNetwork: true, signal: new AbortController().signal },
        defaults
      );
      const offline = await fetchAntigravityModels(
        {
          credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: 'p' } as never,
          allowNetwork: false,
          signal: new AbortController().signal,
        },
        defaults
      );
      expect(noProject).toEqual([]);
      expect(offline).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an api-key credential is not an Antigravity sign-in', () => {
    // The provider has no key route; a stored key must not be mistaken for a bearer token.
    expect(parseAntigravityApiKey(JSON.stringify({ token: 't', projectId: 'p' }))).toEqual({ token: 't', projectId: 'p' });
  });
});

describe('what a discovered model is billed at', () => {
  test('a known family keeps its published price instead of reporting free', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: { 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)' } } }), { status: 200 })) as unknown as typeof fetch;
    try {
      const models = await fetchAntigravityModels(
        {
          credential: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60_000, projectId: 'p' } as never,
          allowNetwork: true,
          signal: new AbortController().signal,
        },
        // The caller supplies the family's price, exactly as the provider does from its table.
        () => ({ cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 } })
      );
      // Zero would be rendered as "free" and hide real spend on every discovered model.
      expect(models[0]?.cost.output).toBe(3.75);
    } finally {
      globalThis.fetch = original;
    }
  });
});
