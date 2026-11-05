import { expect, test } from 'bun:test';
import { loadMessageTail } from './src/api';
import { rememberPiInstances } from './src/piApi';

// Newest-first, like Hearth's /conversations/:id/entries page.
const entries = [
  { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'one', timestamp: 1 }] },
  {
    id: 2,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'reply one' }], stopReason: 'stop', timestamp: 2 }],
  },
  { id: 3, kind: 'pi.user', model: [{ role: 'user', content: 'two', timestamp: 3 }] },
  {
    id: 4,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'reply two' }], stopReason: 'stop', timestamp: 4 }],
  },
];

let lastPath = '';

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string) => {
      lastPath = path;
      return { ok: true, status: 200, data: { entries: [...entries].reverse(), next: null } };
    },
  },
};
rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);

test('loadMessageTail uses the entries page and maps back to chronological order', async () => {
  const tail = await loadMessageTail('pi:test', '7');
  expect(lastPath).toContain('/conversations/7/entries?limit=');
  expect(tail.map((message) => message.text)).toEqual(['one', 'reply one', 'two', 'reply two']);
});
