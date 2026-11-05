import { afterAll, describe, expect, test } from 'bun:test';
import { piLoadMessageHistory } from './src/piApi';
import type { PiEntry } from './src/lib/piMapping';

/**
 * The full-history read as it actually reaches a host: the request shape, what the walk does with a
 * page it has already seen, and whether the dev mock obeys the cursor it hands out.
 *
 * The repeat case is the one that showed on screen. `src/dev/mockPi.ts` ignored the cursor and always
 * answered `next: null`, so every full read of a 4-entry conversation walked 200 identical pages and
 * the transcript rendered 800 messages (indices 1–15 and 784–800 visible, duplicate React keys for
 * `e90`–`e93`, "Crew report" resolving to 8 elements). These tests pin both halves of the fix.
 */

const entry = (id: number): PiEntry => ({
  id,
  kind: 'pi.user',
  // A real entry carries the model messages; a bare `{ id }` maps to no message at all.
  model: [{ role: 'user', content: `entry ${id}`, timestamp: id }],
});

/** Every request a fake bridge saw, so the walk's cost is asserted and not just its output. */
const calls: string[] = [];

const setBridge = (piRequest: (path: string) => Promise<{ ok: boolean; status: number; data: unknown }>) => {
  const previous = (globalThis as { window?: { ember?: unknown } }).window?.ember;
  (globalThis as { window?: unknown }).window = { ember: { piRequest: (_endpointId: string, path: string) => piRequest(path) } };
  return () => {
    if (previous === undefined) delete (globalThis as { window?: { ember?: unknown } }).window;
    else (globalThis as { window?: unknown }).window = { ember: previous };
  };
};

describe('the full history read', () => {
  test('a host that repeats its first page for ever costs two requests, not two hundred', async () => {
    calls.length = 0;
    const page = [93, 92, 91, 90].map(entry);
    const restore = setBridge(async (path) => {
      calls.push(path);
      // The bug, exactly: the cursor is ignored and `next` is set whatever was asked for.
      return { ok: true, status: 200, data: { entries: page, next: { before: 90 } } };
    });
    try {
      const { messages, complete } = await piLoadMessageHistory('pi:test', '16');
      // Four messages, in chronological order — not 800 copies of the same four.
      expect(messages.map((message) => message.id)).toEqual(['e90', 'e91', 'e92', 'e93']);
      // A host that repeats itself never said it reached the beginning, so the read is not complete:
      // the transcript offers "load earlier messages" rather than pretending it holds everything.
      expect(complete).toBe(false);
    } finally {
      restore();
    }
    expect(calls.length).toBe(2);
  });

  test('the request shape a real host depends on is unchanged', async () => {
    calls.length = 0;
    const restore = setBridge(async (path) => {
      calls.push(path);
      const first = !path.includes('cursor=');
      return {
        ok: true,
        status: 200,
        data: first
          ? { entries: [entry(9), entry(8)], next: { before: 8 }, docs: {} }
          : { entries: [entry(7)], docs: {} },
      };
    });
    try {
      const { messages, complete } = await piLoadMessageHistory('pi:test', '42');
      expect(messages.map((message) => message.id)).toEqual(['e7', 'e8', 'e9']);
      expect(complete).toBe(true);
    } finally {
      restore();
    }
    // Hearth caps one page at 100 since 0.35.0 (a row can carry megabytes of base64, and the read
    // parses every row it selects); asking for more is a 400, not a clamp. The walk pages at the cap.
    expect(calls).toEqual([
      '/conversations/42/entries?limit=100&docs=1',
      '/conversations/42/entries?limit=100&cursor=%7B%22before%22%3A8%7D',
    ]);
  });

  test('a genuine last page reports the history complete', async () => {
    const restore = setBridge(async () => ({ ok: true, status: 200, data: { entries: [entry(2), entry(1)], docs: {} } }));
    try {
      const { messages, complete } = await piLoadMessageHistory('pi:test', '42');
      expect(messages.map((message) => message.id)).toEqual(['e1', 'e2']);
      expect(complete).toBe(true);
    } finally {
      restore();
    }
  });
});

/**
 * The dev mock, driven through its own bridge. `mockPi.ts` reads `window.location.search` at import
 * time, so a window has to exist before it loads.
 */
const previousWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: { ember?: unknown } }).window = {
  location: { search: '' },
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
const { bridge: mockBridge, mockInternals } = await import('./src/dev/mockPi');

afterAll(() => {
  (globalThis as { window?: unknown }).window = previousWindow;
});

const mockRequest = (path: string) =>
  (mockBridge.piRequest as unknown as (
    endpointId: string,
    path: string
  ) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>)('pi:hearth', path);

describe('the mock honours its own cursor', () => {
  test('it pages a conversation newest-first, and stops offering a next on the last page', async () => {
    const first = await mockRequest('/conversations/16/entries?limit=2&docs=1');
    expect(first.ok).toBe(true);
    const firstIds = (first.data.entries as PiEntry[]).map((item) => item.id);
    expect(firstIds).toEqual([93, 92]);
    expect(first.data.docs).toBeDefined();
    const next = first.data.next as { before: number } | undefined;
    expect(next).toEqual({ before: 92 });

    const second = await mockRequest(`/conversations/16/entries?limit=2&cursor=${encodeURIComponent(JSON.stringify(next))}`);
    expect((second.data.entries as PiEntry[]).map((item) => item.id)).toEqual([91, 90]);
    // Nothing older remains, so the host says so with the absence of a cursor, not `null`.
    expect(second.data.next).toBeUndefined();
    expect(second.data.docs).toBeUndefined();
  });

  test('a whole conversation reads as one complete page', async () => {
    const response = await mockRequest('/conversations/16/entries?limit=250&docs=1');
    expect((response.data.entries as PiEntry[]).map((item) => item.id)).toEqual([93, 92, 91, 90]);
    expect(response.data.next).toBeUndefined();
  });

  test('a cursor the mock cannot read starts at the newest entry, never at the end', async () => {
    for (const cursor of ['', 'not-json', '%7B%7D']) {
      const response = await mockRequest(`/conversations/16/entries?limit=2&cursor=${cursor}`);
      expect((response.data.entries as PiEntry[]).map((item) => item.id)).toEqual([93, 92]);
    }
  });

  test('`since` returns only the entries newer than the anchor, so an append cannot duplicate', async () => {
    const response = await mockRequest('/conversations/16/entries?limit=40&docs=1&since=91');
    expect((response.data.entries as PiEntry[]).map((item) => item.id)).toEqual([93, 92]);
    expect(response.data.next).toBeUndefined();

    // Nothing newer than the newest entry: an empty, complete answer — the cheap "nothing changed".
    const quiet = await mockRequest('/conversations/16/entries?limit=40&docs=1&since=93');
    expect(quiet.data.entries).toEqual([]);
    expect(quiet.data.next).toBeUndefined();
  });
});

describe('the full read against the mock', () => {
  test('conversation 16 reads as its four entries, once each, complete', async () => {
    const leader = mockInternals.conversations.find((conversation) => conversation.title === 'Crew: auth refactor');
    expect(leader?.id).toBe(16);
    const seen: string[] = [];
    const restore = setBridge(async (path) => {
      seen.push(path);
      return mockRequest(path) as Promise<{ ok: boolean; status: number; data: unknown }>;
    });
    let read: Awaited<ReturnType<typeof piLoadMessageHistory>>;
    try {
      read = await piLoadMessageHistory('pi:hearth', String(leader?.id));
    } finally {
      restore();
    }
    // The fixture is four entries; the bug rendered four hundred pages of them.
    expect(read.messages.map((message) => message.id)).toEqual(['e90', 'e91', 'e92', 'e93']);
    expect(read.complete).toBe(true);
    expect(seen.length).toBe(1);
  });
});
