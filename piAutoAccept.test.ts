import { expect, test } from 'bun:test';
import { loadAutoAcceptPolicy, setAutoAccept } from './src/api';
import { rememberPiInstances } from './src/piApi';

const calls: Array<{ method: string; path: string; body?: unknown }> = [];

// Hearth carries each conversation's server-side YOLO flag on the summary; a missing flag is off.
const conversationsPayload = () => ({
  conversations: [
    { id: 51, autoAccept: true, model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' } },
    { id: 52, model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' } },
  ],
});

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body });
      if (path === '/conversations') return { ok: true, status: 200, data: conversationsPayload() };
      if (path.endsWith('/auto-accept')) return { ok: true, status: 200, data: { ok: true } };
      return { ok: false, status: 404, data: null };
    },
  },
};
rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);

test('loadAutoAcceptPolicy maps Hearth conversation summaries onto the per-session policy', async () => {
  const policy = await loadAutoAcceptPolicy('pi:test');
  expect(policy).toEqual({ supported: true, sessions: { '51': true, '52': false } });
});

test('setAutoAccept dispatches PUT to the conversation auto-accept route', async () => {
  calls.length = 0;
  const result = await setAutoAccept('pi:test', '51', true);
  expect(result.ok).toBe(true);
  expect(calls).toEqual([
    { method: 'PUT', path: '/conversations/51/auto-accept', body: { enabled: true } },
  ]);
});
