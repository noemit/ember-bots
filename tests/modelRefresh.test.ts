import { describe, expect, test } from 'bun:test';
import { refreshInstanceModels } from '../src/api';
import { piRefreshModels, rememberPiInstances } from '../src/piApi';

type Call = { endpointId: string; path: string; method?: string; body?: unknown };

const withPiBridge = (
  handler: (call: Call) => Promise<{ ok: boolean; status: number; data: unknown }>
): (() => void) => {
  const previous = (globalThis as { window?: { ember?: unknown } }).window?.ember;
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: (endpointId: string, path: string, init?: { method?: string; body?: unknown }) =>
        handler({ endpointId, path, method: init?.method, body: init?.body }),
    },
  };
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = { ember: previous };
  };
};

describe('dynamic model refresh', () => {
  test('refreshInstanceModels dispatches POST /models/refresh on Kiln endpoints and maps newly discovered models', async () => {
    const calls: Call[] = [];
    rememberPiInstances([{ id: 'pi:local', kind: 'pi' }]);
    const restore = withPiBridge(async (call) => {
      calls.push(call);
      return {
        ok: true,
        status: 200,
        data: {
          models: [
            {
              id: 'claude-opus-6',
              name: 'Claude Opus 6',
              provider: 'anthropic',
              api: 'anthropic-messages',
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 1_000_000,
              maxTokens: 128_000,
              cost: { input: 5, output: 25 },
            },
          ],
          default: { provider: 'anthropic', modelId: 'claude-opus-6' },
        },
      };
    });

    try {
      const result = await refreshInstanceModels('pi:local');
      expect(calls).toEqual([{ endpointId: 'pi:local', path: '/models/refresh', method: 'POST', body: {} }]);
      expect(result?.defaultModelId).toBe('anthropic/claude-opus-6');
      expect(result?.models.map((m) => `${m.providerID}/${m.modelID}`)).toEqual(['anthropic/claude-opus-6']);

      await refreshInstanceModels('pi:local', ['deepinfra', 'moonshotai']);
      expect(calls[1]).toEqual({
        endpointId: 'pi:local',
        path: '/models/refresh',
        method: 'POST',
        body: { providers: ['deepinfra', 'moonshotai'] },
      });
    } finally {
      restore();
    }
  });

  test('piRefreshModels falls back to GET /models when connected to an older Kiln without POST /models/refresh', async () => {
    const calls: Call[] = [];
    const restore = withPiBridge(async (call) => {
      calls.push(call);
      if (call.path === '/models/refresh') {
        return { ok: false, status: 404, data: { error: 'not found' } };
      }
      return {
        ok: true,
        status: 200,
        data: {
          models: [
            {
              id: 'gpt-6.1-sol',
              name: 'GPT-6.1 Sol',
              provider: 'openai',
              api: 'openai-responses',
              reasoning: true,
              input: ['text', 'image'],
              contextWindow: 400_000,
              maxTokens: 128_000,
              cost: { input: 2, output: 10 },
            },
          ],
          default: { provider: 'openai', modelId: 'gpt-6.1-sol' },
        },
      };
    });

    try {
      const result = await piRefreshModels('pi:older-remote');
      expect(calls.map((c) => `${c.method ?? 'GET'} ${c.path}`)).toEqual([
        'POST /models/refresh',
        'GET /models',
      ]);
      expect(result?.models.map((m) => `${m.providerID}/${m.modelID}`)).toEqual(['openai/gpt-6.1-sol']);
    } finally {
      restore();
    }
  });
});
