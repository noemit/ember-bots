import { describe, expect, test } from 'bun:test';
import { collectHistoryPages, piLoadMessageHistory } from './src/piApi';
import { applyTranscriptCommit } from './src/lib/transcriptCommit';
import type { PiEntry } from './src/lib/piMapping';
import type { ChatMessage } from './src/types';

/**
 * A "full" transcript read has to walk the entries route: `GET /conversations/:id` serves the
 * active window, which after a compaction is a fraction of the history. These tests pin the walk
 * (order, stopping, the cap, and whether it may claim completeness) and the state merge that keeps
 * `historyComplete` alive across later commits.
 */

const entry = (id: number): PiEntry => ({ id, kind: 'pi.user' });

const pages = (...pageIds: number[][]) => {
  let call = 0;
  const seenCursors: Array<unknown> = [];
  const fetchPage = async (cursor?: unknown) => {
    seenCursors.push(cursor);
    const ids = pageIds[call] ?? [];
    call += 1;
    return { entries: ids.map(entry), next: call < pageIds.length ? { after: call } : undefined };
  };
  return { fetchPage, seenCursors };
};

describe('the history walk', () => {
  test('one complete page is returned oldest-first and complete', async () => {
    const { fetchPage } = pages([5, 4, 3]);
    const result = await collectHistoryPages(fetchPage);
    expect(result.entries.map((item) => item.id)).toEqual([3, 4, 5]);
    expect(result.complete).toBe(true);
  });

  test('newest-first pages become one chronological transcript', async () => {
    // Page 1 is the newest (9,8,7), page 2 is older (6,5,4), page 3 the start (3,2,1).
    const { fetchPage } = pages([9, 8, 7], [6, 5, 4], [3, 2, 1]);
    const result = await collectHistoryPages(fetchPage);
    expect(result.entries.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.complete).toBe(true);
  });

  test('the cursor is passed back unchanged, page after page', async () => {
    const { fetchPage, seenCursors } = pages([9, 8], [7, 6], [5]);
    await collectHistoryPages(fetchPage);
    expect(seenCursors).toEqual([undefined, { after: 1 }, { after: 2 }]);
  });

  test('a cap stops the walk and refuses to call the history complete', async () => {
    const { fetchPage } = pages([9, 8], [7, 6], [5, 4], [3, 2]);
    const result = await collectHistoryPages(fetchPage, { maxEntries: 4 });
    expect(result.entries.map((item) => item.id)).toEqual([6, 7, 8, 9]);
    expect(result.complete).toBe(false);
  });

  test('reaching the start exactly at the cap is still complete', async () => {
    const { fetchPage } = pages([4, 3], [2, 1]);
    const result = await collectHistoryPages(fetchPage, { maxEntries: 4 });
    expect(result.entries.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(result.complete).toBe(true);
  });

  test('an empty page ends the walk rather than looping', async () => {
    const { fetchPage } = pages([4, 3], []);
    const result = await collectHistoryPages(fetchPage);
    expect(result.entries.map((item) => item.id)).toEqual([3, 4]);
    expect(result.complete).toBe(true);
  });

  test('a server that never stops answering is bounded, and reported incomplete', async () => {
    let call = 0;
    const fetchPage = async () => {
      call += 1;
      return { entries: [entry(call)], next: { after: call } };
    };
    const result = await collectHistoryPages(fetchPage);
    expect(result.complete).toBe(false);
    expect(result.entries.length).toBe(200);
  });

  test('a page that overlaps the previous one at the seam adds no duplicate', async () => {
    // Offset-based paging that pages by `offset` instead of by id overlaps by one entry at each
    // seam; the same entry must not become two messages.
    const { fetchPage } = pages([9, 8, 7], [7, 6, 5], [4, 3]);
    const result = await collectHistoryPages(fetchPage);
    expect(result.entries.map((item) => item.id)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(result.complete).toBe(true);
  });

  test('an empty page ends the read even when the host still sets a cursor', async () => {
    // An empty page is a host saying "nothing older", whatever else its envelope claims.
    const fetchPage = async () => ({ entries: [], next: { after: 9 } });
    const result = await collectHistoryPages(fetchPage);
    expect(result.entries).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

/**
 * The client-side defence against a host that repeats itself. This is not a mock-only concern: a
 * cursor the host ignores, an offset route whose windows overlap, or a proxy replaying a response all
 * hand back a page already collected, and appending it again duplicated a whole transcript — a
 * 4-entry conversation rendered as 800 messages, one 200-page cap's worth, with duplicate React keys.
 * The walk therefore stops on the first page that contributes nothing new, and refuses to call that
 * history complete: a host that repeats itself never said it reached the beginning.
 */
describe('a host that repeats itself cannot duplicate the transcript', () => {
  const repeated = () => {
    let calls = 0;
    const fetchPage = async () => {
      calls += 1;
      return { entries: [93, 92, 91, 90].map(entry), next: { before: 90 } };
    };
    return { fetchPage, calls: () => calls };
  };

  test('the walk stops on the first page with nothing new, deduped and incomplete', async () => {
    const host = repeated();
    const result = await collectHistoryPages(host.fetchPage);
    expect(result.entries.map((item) => item.id)).toEqual([90, 91, 92, 93]);
    expect(result.complete).toBe(false);
  });

  test('it stops after a second request, not after the 200-page cap', async () => {
    // The count is the point: the old walk made 200 requests to produce a 200× duplicated history.
    const host = repeated();
    await collectHistoryPages(host.fetchPage);
    expect(host.calls()).toBe(2);
  });

  test('a host that cycles the same two pages is caught on the second pass', async () => {
    // The failure mode need not be byte-identical pages: a host that ping-pongs between two windows
    // is caught as soon as a page brings nothing new, which is the first repeat.
    const window = [[9, 8, 7], [6, 5, 4]];
    let calls = 0;
    const fetchPage = async () => {
      const ids = window[calls % 2];
      calls += 1;
      return { entries: ids.map(entry), next: { before: 4 } };
    };
    const result = await collectHistoryPages(fetchPage);
    expect(result.entries.map((item) => item.id)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(result.complete).toBe(false);
    expect(calls).toBe(3);
  });
});

describe('a commit does not erase what it does not own', () => {
  const message: ChatMessage = {
    id: 'e1',
    role: 'user',
    text: 'hello',
    parts: [{ type: 'text', id: 'e1-0', text: 'hello' }],
    completed: true,
  };

  test('historyComplete survives an append commit', () => {
    const current = { messages: [], status: 'ready' as const, historyComplete: true };
    const next = applyTranscriptCommit(current, { messages: [message], status: 'ready' });
    expect(next.historyComplete).toBe(true);
    expect(next.messages).toEqual([message]);
  });

  test('a partial history stays partial across a commit', () => {
    const current = { messages: [], status: 'ready' as const, historyComplete: false };
    const next = applyTranscriptCommit(current, { messages: [message], status: 'ready' });
    expect(next.historyComplete).toBe(false);
  });

  test('a failure clears when the commit says so, and the message list is replaced', () => {
    const current = { messages: [], status: 'error' as const, failure: { kind: 'network' as const }, historyComplete: true };
    // `failure: undefined` is how the commit path clears a failure; omitting the key would leave the
    // previous value alone, which is the point of merging instead of rebuilding.
    const next = applyTranscriptCommit(current, { messages: [message], status: 'ready', failure: undefined });
    expect(next.failure).toBeUndefined();
    expect(next.status).toBe('ready');
    expect(next.messages).toEqual([message]);
    expect(next.historyComplete).toBe(true);
  });
});

/**
 * The first page of a full walk asks for the conversation's documents (`docs=1`): a few hundred
 * bytes, and the only way this read can see `pi.live` — the in-flight generation and its running
 * tool slots. Without it a full repair landing mid-turn mapped every open call as unsettled and
 * pushed a whole-history snapshot into a streaming turn with no idea a run was active, so a live
 * step was drawn as interrupted and the streaming answer blanked out.
 */
describe('the full walk carries the documents', () => {
  test('asks for docs on the first page only', async () => {
    const paths: string[] = [];
    const previous = (globalThis as { window?: { ember?: unknown } }).window?.ember;
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async (_endpointId: string, path: string) => {
          paths.push(path);
          const first = !path.includes('cursor=');
          return {
            ok: true,
            status: 200,
            data: first
              ? {
                  entries: [assistantWithToolEntry],
                  next: { after: 1 },
                  docs: { 'pi.live': { run: { inputs: [1] }, tools: [{ callId: 'call-1', status: 'running' }] } },
                }
              : { entries: [userEntry] },
          };
        },
      },
    };
    try {
      await piLoadMessageHistory('pi:test', '42');
    } finally {
      (globalThis as { window?: unknown }).window = previous === undefined ? undefined : { ember: previous };
    }
    expect(paths[0]).toContain('docs=1');
    expect(paths[1]).not.toContain('docs=1');
  });

  test('a call still running under pi.live is not drawn as interrupted', async () => {
    const previous = (globalThis as { window?: { ember?: unknown } }).window?.ember;
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async () => ({
          ok: true,
          status: 200,
          data: {
            entries: [assistantWithToolEntry],
            docs: {
              'pi.live': {
                run: { inputs: [1] },
                tools: [{ callId: 'call-1', status: 'running', output: 'partial' }],
              },
            },
          },
        }),
      },
    };
    try {
      const { messages } = await piLoadMessageHistory('pi:test', '42');
      const tool = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool');
      expect(tool?.type === 'tool' && tool.call.status).toBe('running');
    } finally {
      (globalThis as { window?: unknown }).window = previous === undefined ? undefined : { ember: previous };
    }
  });

  test('a finished turn with no run in flight still settles its dead call', async () => {
    const previous = (globalThis as { window?: { ember?: unknown } }).window?.ember;
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async () => ({ ok: true, status: 200, data: { entries: [assistantWithToolEntry], docs: {} } }),
      },
    };
    try {
      const { messages } = await piLoadMessageHistory('pi:test', '42');
      const tool = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool');
      expect(tool?.type === 'tool' && tool.call.status).toBe('interrupted');
    } finally {
      (globalThis as { window?: unknown }).window = previous === undefined ? undefined : { ember: previous };
    }
  });
});

const userEntry = {
  id: 1,
  kind: 'pi.user',
  model: [{ role: 'user', content: 'check the file', timestamp: 10 }],
};

const assistantWithToolEntry = {
  id: 2,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      timestamp: 20,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }],
    },
  ],
};
