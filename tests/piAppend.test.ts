import { describe, expect, test } from 'bun:test';
import { piLoadMessageAppend } from '../src/piApi';

/**
 * The incremental read is what makes a streaming refresh cost what changed instead of what exists:
 * a 40-entry tail measured 21.3MB on a session with screenshots, and nearly all of it was already on
 * screen. It is only safe to append when the server says the answer is complete (`next` absent), so
 * that flag is the contract this test pins.
 */
let paths: string[] = [];
let next: unknown;

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string) => {
      paths.push(path);
      return {
        ok: true,
        status: 200,
        data: {
          // Hearth answers newest-first; the mapper flips to chronological.
          entries: [
            { id: 8, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'second' }] }] },
            { id: 7, kind: 'pi.user', model: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }] },
          ],
          docs: {},
          ...(next === undefined ? {} : { next }),
        },
      };
    },
  },
};

describe('the incremental entry read', () => {
  test('asks for entries newer than the anchor, and never for the anchor itself', async () => {
    paths = [];
    next = undefined;
    const page = await piLoadMessageAppend('pi:test', '42', 6);
    expect(paths).toEqual(['/conversations/42/entries?limit=40&docs=1&since=6']);
    expect(page.complete).toBe(true);
    expect(page.messages.map((message) => message.text)).toEqual(['first', 'second']);
  });

  test('a `next` cursor means the answer was cut short, so the caller cannot append', async () => {
    next = [{ after: 7 }];
    const page = await piLoadMessageAppend('pi:test', '42', 6);
    expect(page.complete).toBe(false);
  });

  test('a limit is clamped to the host cap, so a caller cannot ask for too much by accident', async () => {
    paths = [];
    next = undefined;
    // Hearth rejects anything over 100 with a 400 (LIMIT_MAX, 0.35.0), so the guard is a clamp to
    // the cap rather than to the old 500.
    await piLoadMessageAppend('pi:test', '42', 6, 10_000);
    expect(paths[0]).toContain('limit=100');
  });
});
