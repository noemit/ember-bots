import { expect, test } from 'bun:test';
import { enqueueMessage, loadMessageQueue, removeQueuedMessage, reorderQueuedMessages, takeQueuedMessage } from '../src/api';
import { rememberPiInstances } from '../src/piApi';
import type { ModelOption } from '../src/types';

const calls: Array<{ method: string; path: string }> = [];
/** Submit bodies, so a test can see the content a queueing client actually sends. */
const submits: Array<Record<string, unknown>> = [];

const queuePayload = () => ({
  revision: 7,
  sessions: [
    {
      sessionId: '51',
      directory: '',
      model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
      thinkingLevel: 'high',
      sendingId: null,
      items: [{ id: 43, mode: 'followUp', text: 'queued follow-up' }],
    },
  ],
});

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path });
      if (path === '/queue') return { ok: true, status: 200, data: queuePayload() };
      if (path.endsWith('/submit')) {
        submits.push((init?.body ?? {}) as Record<string, unknown>);
        return { ok: true, status: 201, data: { submissionId: 43 } };
      }
      if (path.includes('/abort')) return { ok: true, status: 200, data: { ok: true } };
      if (path.endsWith('/queue/order')) return { ok: true, status: 200, data: { ok: true } };
      if (path.endsWith('/configure')) return { ok: true, status: 200, data: { ok: true } };
      return { ok: false, status: 404, data: null };
    },
  },
};
rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);

const model: ModelOption = {
  providerID: 'opencode-go',
  modelID: 'glm-5.3-flash',
  variant: undefined,
  label: 'GLM-5.3 Flash',
  details: {
    name: 'GLM-5.3 Flash',
    providerName: 'opencode-go',
    reasoning: true,
    toolcall: true,
    attachment: false,
    inputs: [],
    variants: ['low', 'high'],
  },
};

test('loadMessageQueue maps Hearth /queue onto the OpenChamber snapshot shape', async () => {
  const snapshot = await loadMessageQueue('pi:test');
  expect(snapshot?.revision).toBe(7);
  const session = snapshot?.sessions[0];
  expect(session?.sessionId).toBe('51');
  expect(session?.directory).toBe('');
  expect(session?.items[0]).toMatchObject({ id: '43', text: 'queued follow-up', content: 'queued follow-up' });
  expect(session?.items[0].sendConfig).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: 'high' });
});

test('enqueue submits a follow-up and returns the refreshed queue mutation', async () => {
  calls.length = 0;
  const result = await enqueueMessage('pi:test', '51', '', {
    text: 'queued follow-up',
    model,
    selectedModelId: 'opencode-go/glm-5.3-flash',
  });
  expect(result.ok).toBe(true);
  expect(result.data?.session.sessionId).toBe('51');
  expect(result.data?.itemId).toBe('43');
  expect(calls.map((entry) => entry.path)).toEqual(['/conversations/51/configure', '/conversations/51/submit', '/queue']);
});

test('a queued image is submitted as an image content part', async () => {
  submits.length = 0;
  const result = await enqueueMessage('pi:test', '51', '', {
    text: 'queued with a picture',
    model,
    selectedModelId: 'opencode-go/glm-5.3-flash',
    attachments: [{ filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
  });
  expect(result.ok).toBe(true);
  expect(submits.at(-1)?.content).toEqual([
    { type: 'text', text: 'queued with a picture' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ]);
});

test('remove and take abandon the queued submission over Hearth routes', async () => {
  calls.length = 0;
  const removed = await removeQueuedMessage('pi:test', '51', '43');
  expect(removed.ok).toBe(true);
  expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
    'POST /conversations/51/submissions/43/abort',
    'GET /queue',
  ]);

  calls.length = 0;
  const taken = await takeQueuedMessage('pi:test', '51', '43');
  expect(taken.ok).toBe(true);
  expect(taken.data?.item.text).toBe('queued follow-up');
  expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
    'GET /queue',
    'POST /conversations/51/submissions/43/abort',
    'GET /queue',
  ]);
});

test('reorder withdraws and re-submits in order over the queue/order route', async () => {
  calls.length = 0;
  const result = await reorderQueuedMessages('pi:test', '51', ['43', '44']);
  expect(result.ok).toBe(true);
  expect(result.data?.session.sessionId).toBe('51');
  // The queue is read first, so the request can carry the whole inbox order.
  expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
    'GET /queue',
    'PUT /conversations/51/queue/order',
    'GET /queue',
  ]);
});

/**
 * Hearth refuses a reorder that omits any queued message ("itemIds must list every queued message,
 * once"), and a steer waits in the same inbox — invisible to the composer's own row list. So the
 * full order is read and merged before the PUT: a steer may not be dropped from the list, and it may
 * not be moved either, since it was not part of the requested swap.
 */
test('a reorder sends every queued id, with the steer left where it was', async () => {
  const previous = window.ember.piRequest;
  const bodies: unknown[] = [];
  (window.ember as { piRequest: unknown }).piRequest = async (
    _endpointId: string,
    path: string,
    init?: { method?: string; body?: unknown }
  ) => {
    if (path === '/queue') {
      return {
        ok: true,
        status: 200,
        data: {
          revision: 12,
          sessions: [
            {
              sessionId: '51',
              directory: '',
              model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
              sendingId: null,
              items: [
                { id: 31, mode: 'steer', text: 'Memory*' },
                { id: 32, mode: 'followUp', text: 'first' },
                { id: 33, mode: 'followUp', text: 'second' },
              ],
            },
          ],
        },
      };
    }
    if (path.endsWith('/queue/order')) {
      bodies.push(init?.body);
      return { ok: true, status: 200, data: { revision: 13, session: { sessionId: '51', directory: '', items: [], sendingId: null } } };
    }
    return { ok: false, status: 404, data: null };
  };
  try {
    // The composer swaps the two follow-ups; it knows nothing about the steer at 31.
    const result = await reorderQueuedMessages('pi:test', '51', ['33', '32']);
    expect(result.ok).toBe(true);
    expect(bodies).toEqual([{ itemIds: ['31', '33', '32'] }]);
  } finally {
    (window.ember as { piRequest: unknown }).piRequest = previous;
  }
});

/**
 * A steer is a real inbox item: it waits for the running turn to pause, and until it was in this
 * list it was invisible in the composer *and* unwithdrawable, because `takeQueuedMessage` resolves
 * the row it is about to withdraw from here. A `write` is model-only context and has nothing to
 * render.
 */
test('a steer waiting for the turn to pause is part of the queue, and carries its mode', async () => {
  const previous = window.ember.piRequest;
  (window.ember as { piRequest: unknown }).piRequest = async (_endpointId: string, path: string) => {
    if (path !== '/queue') return { ok: false, status: 404, data: null };
    return {
      ok: true,
      status: 200,
      data: {
        revision: 9,
        sessions: [
          {
            sessionId: '61',
            directory: '',
            model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
            sendingId: null,
            items: [
              { id: 71, mode: 'steer', text: 'Memory*' },
              { id: 72, mode: 'followUp', text: 'then commit' },
              { id: 73, mode: 'write', text: 'reply context' },
            ],
          },
        ],
      },
    };
  };
  try {
    const snapshot = await loadMessageQueue('pi:test');
    const items = snapshot?.sessions[0]?.items ?? [];
    expect(items.map((item) => item.text)).toEqual(['Memory*', 'then commit']);
    expect(items[0].mode).toBe('steer');
    expect(items[1].mode).toBeUndefined();
  } finally {
    (window.ember as { piRequest: unknown }).piRequest = previous;
  }
});

/**
 * Queueing that *placed* the message (the client thought the session was busy; the host disagreed)
 * used to append a synthetic row for a message that was already running — a phantom "Queue:" row
 * that vanished on the next read. A placed submission is not a queue row.
 */
test('a placed enqueue adds no queue row', async () => {
  const previous = window.ember.piRequest;
  (window.ember as { piRequest: unknown }).piRequest = async (
    _endpointId: string,
    path: string,
    init?: { method?: string }
  ) => {
    if (path.endsWith('/submit')) {
      submits.push((init?.body as Record<string, unknown>) ?? {});
      return { ok: true, status: 201, data: { submissionId: 88, status: 'placed', mode: 'followUp' } };
    }
    if (path === '/queue') {
      // The host's inbox does not list it: it is not queued, it is running.
      return { ok: true, status: 200, data: { revision: 10, sessions: [] } };
    }
    return { ok: true, status: 200, data: { ok: true } };
  };
  try {
    const result = await enqueueMessage('pi:test', '51', '', {
      text: 'this one ran instead',
      model,
      selectedModelId: 'opencode-go/glm-5.3-flash',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.itemId).toBe('');
    expect(result.data?.session.items).toEqual([]);
  } finally {
    (window.ember as { piRequest: unknown }).piRequest = previous;
  }
});

/**
 * Hearth answers `POST …/submissions/:id/abort` with HTTP 200 and `{ ok: false, result:
 * "already_settled" }` when the submission has already run. A 200 is not a withdrawal: reporting it
 * as one made Cancel claim it removed a message that had been placed, and "Send now" hand the
 * payload back so the client sent the message a second time.
 */
test('a withdrawal the host says did not happen is a conflict, not a success', async () => {
  const previous = window.ember.piRequest;
  (window.ember as { piRequest: unknown }).piRequest = async (_endpointId: string, path: string) => {
    if (path.includes('/submissions/')) {
      return { ok: true, status: 200, data: { ok: false, result: 'already_settled' } };
    }
    if (path === '/queue') {
      return {
        ok: true,
        status: 200,
        data: {
          revision: 4,
          sessions: [
            {
              sessionId: '51',
              directory: '',
              model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
              sendingId: null,
              items: [{ id: 43, mode: 'followUp', text: 'queued follow-up' }],
            },
          ],
        },
      };
    }
    return { ok: false, status: 404, data: null };
  };
  try {
    const removed = await removeQueuedMessage('pi:test', '51', '43');
    expect(removed.ok).toBe(false);
    expect(removed.status).toBe(409);
    expect(removed.data).toBeNull();

    const taken = await takeQueuedMessage('pi:test', '51', '43');
    // `takeQueuedMessage` returns a taken payload only when the withdrawal really happened.
    expect(taken.ok).toBe(false);
    expect(taken.status).toBe(409);
    expect(taken.data).toBeNull();
  } finally {
    (window.ember as { piRequest: unknown }).piRequest = previous;
  }
});

test('a withdrawal the host confirms still succeeds', async () => {
  const previous = window.ember.piRequest;
  const paths: string[] = [];
  (window.ember as { piRequest: unknown }).piRequest = async (_endpointId: string, path: string) => {
    paths.push(path);
    if (path.includes('/submissions/')) {
      return { ok: true, status: 200, data: { ok: true, result: 'aborted' } };
    }
    if (path === '/queue') return { ok: true, status: 200, data: { revision: 4, sessions: [] } };
    return { ok: false, status: 404, data: null };
  };
  try {
    const removed = await removeQueuedMessage('pi:test', '51', '43');
    expect(removed.ok).toBe(true);
    expect(removed.data?.itemId).toBe('43');
  } finally {
    (window.ember as { piRequest: unknown }).piRequest = previous;
  }
});

/**
 * A queued message carries the context it was written with. `piSendPrompt` writes the reply and
 * queued contexts as `write` entries (hidden from the transcript, read by the model through
 * `entry.model`); `piEnqueueMessage` used to submit the text alone, so a queued reply or edit lost
 * its context silently.
 */
test('a queued message writes its reply and queued context before it is submitted', async () => {
  const previous = window.ember.piRequest;
  const writes: Array<Record<string, unknown>> = [];
  let submitted: Record<string, unknown> | undefined;
  (window.ember as { piRequest: unknown }).piRequest = async (
    _endpointId: string,
    path: string,
    init?: { body?: unknown }
  ) => {
    const body = (init?.body ?? {}) as Record<string, unknown>;
    if (path.endsWith('/submit') && body.type === 'write') {
      writes.push(body);
      return { ok: true, status: 201, data: { submissionId: 9, status: 'done' } };
    }
    if (path.endsWith('/submit')) {
      submitted = body;
      return { ok: true, status: 201, data: { submissionId: 43, status: 'queued' } };
    }
    if (path === '/queue') return { ok: true, status: 200, data: { revision: 5, sessions: [] } };
    return { ok: true, status: 200, data: { ok: true } };
  };
  try {
    await enqueueMessage('pi:test', '51', '', {
      text: 'queued with context',
      model,
      selectedModelId: 'opencode-go/glm-5.3-flash',
      replyContext: 'the quoted message',
      queuedContext: [{ kind: 'context', text: 'the diff', instructions: 'read this first' }],
    });
    expect(writes).toHaveLength(3);
    for (const write of writes) {
      const entry = write.entry as { kind: string; data: { text: string }; model: Array<{ role: string; content: Array<{ text: string }> }> };
      expect(entry.kind).toBe('ember.reply-context');
      // What the transcript suppresses…
      expect(entry.data.text.length).toBeGreaterThan(0);
      // …and what the model actually reads.
      expect(entry.model[0].content[0].text).toBe(entry.data.text);
    }
    expect((writes[0].entry as { data: { text: string } }).data.text).toContain('the quoted message');
    expect((writes[1].entry as { data: { text: string } }).data.text).toBe('read this first');
    expect(submitted).toMatchObject({ type: 'input', content: 'queued with context', whenBusy: 'followUp' });
  } finally {
    (window.ember as { piRequest: unknown }).piRequest = previous;
  }
});
