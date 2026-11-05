import { test, expect, describe } from 'bun:test';

// mockPi.ts reads `window.location.search` at import time (the `?staleBusy` fixture), so the fake
// window has to exist before it loads.
(globalThis as { window?: unknown }).window = {
  location: { search: '' },
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
const { bridge, mockInternals } = await import('./src/dev/mockPi');

const piRequest = bridge.piRequest as unknown as (
  endpointId: string,
  path: string,
  init?: { method?: string; body?: unknown }
) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>;

const firstConversation = () => mockInternals.conversations[0];

describe('the mock mirrors Hearth’s entries contract', () => {
  // Hearth returns the conversation's documents alongside the entries page, and the client asks
  // for them with `docs=1` so a tail read can see `pi.live` — the generation streaming right now.
  // When the mock omitted them, every tail in dev and in the pi e2e suite looked like an older
  // Hearth with no in-flight generation, so the live-reasoning path had no coverage at all.
  test('docs come back with the entries page when docs=1 is asked for', async () => {
    const conversation = firstConversation();
    const response = await piRequest('pi:mock', `/conversations/${conversation.id}/entries?limit=8&docs=1`);
    expect(response.ok).toBe(true);
    expect(Object.keys(response.data.docs as Record<string, unknown>)).toContain('pi.live');
  });

  test('the page carries no docs when docs=1 is absent', async () => {
    const conversation = firstConversation();
    const response = await piRequest('pi:mock', `/conversations/${conversation.id}/entries?limit=8`);
    expect(response.data.docs).toBeUndefined();
  });

  test('an idle conversation has an empty pi.live, like Hearth', async () => {
    const conversation = firstConversation();
    const response = await piRequest('pi:mock', `/conversations/${conversation.id}/entries?limit=8&docs=1`);
    expect((response.data.docs as Record<string, unknown>)['pi.live']).toEqual({});
  });
});

describe('a running turn exposes live reasoning mid-turn', () => {
  // The mock streams into `pi.live.generation.message` and only commits an entry when the turn
  // ends — the same split Hearth has. This is what makes the reasoning visible while it is written.
  test('the entries page carries a thinking block before the turn ends', async () => {
    const conversation = firstConversation();
    conversation.liveGeneration = {
      provider: 'faux-hearth',
      model: 'glm-5.3-flash',
      thinking: 'Weighing the two migration paths…',
      text: '',
    };
    try {
      const response = await piRequest('pi:mock', `/conversations/${conversation.id}/entries?limit=8&docs=1`);
      const docs = response.data.docs as Record<string, { generation?: { message?: Record<string, unknown> } }>;
      const message = docs['pi.live'].generation?.message;
      expect(message?.role).toBe('assistant');
      expect(message?.content).toEqual([
        { type: 'thinking', thinking: 'Weighing the two migration paths…' },
      ]);
    } finally {
      conversation.liveGeneration = undefined;
    }
  });

  test('settling clears the slot', async () => {
    const conversation = firstConversation();
    expect(conversation.liveGeneration).toBeUndefined();
    const response = await piRequest('pi:mock', `/conversations/${conversation.id}/entries?limit=8&docs=1`);
    expect((response.data.docs as Record<string, unknown>)['pi.live']).toEqual({});
  });
});
