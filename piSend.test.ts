import { expect, test } from 'bun:test';
import { sendPrompt, abortSession } from './src/api';
import { rememberPiInstances } from './src/piApi';

const bodies: Array<Record<string, unknown>> = [];

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/submit')) {
        bodies.push((init?.body ?? {}) as Record<string, unknown>);
        return { ok: true, status: 201, data: { submissionId: 1 } };
      }
      return { ok: true, status: 200, data: {} };
    },
  },
};
rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);

test('a plain Hearth send queues when busy; Alt+Enter steers', async () => {
  await sendPrompt('pi:test', '7', { text: 'queue me', selectedModelId: 'opencode-go/glm-5.3-flash' });
  await sendPrompt('pi:test', '7', { text: 'now', selectedModelId: 'opencode-go/glm-5.3-flash', steer: true });
  expect(bodies[0]).toMatchObject({ type: 'input', content: 'queue me', whenBusy: 'followUp' });
  expect(bodies[1]).toMatchObject({ type: 'input', content: 'now', whenBusy: 'steer' });
});

test('an attachment rides the send as an image content part', async () => {
  await sendPrompt('pi:test', '7', {
    text: '',
    selectedModelId: 'opencode-go/glm-5.3-flash',
    attachments: [{ filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
  });
  // An image-only message is valid: no text part is invented for it.
  expect(bodies.at(-1)).toMatchObject({
    type: 'input',
    content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    whenBusy: 'followUp',
  });
});

test('text and an image become parts, text first', async () => {
  await sendPrompt('pi:test', '7', {
    text: 'what is this?',
    selectedModelId: 'opencode-go/glm-5.3-flash',
    attachments: [{ filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
  });
  expect(bodies.at(-1)?.content).toEqual([
    { type: 'text', text: 'what is this?' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ]);
});

test('an attachment with no inline payload falls back to plain text', async () => {
  await sendPrompt('pi:test', '7', {
    text: 'no payload',
    selectedModelId: 'opencode-go/glm-5.3-flash',
    attachments: [{ filename: 'shot.png', mime: 'image/png', url: 'https://example.com/shot.png' }],
  });
  expect(bodies.at(-1)?.content).toBe('no payload');
});

test('an attachment that is not an image is refused with a reason that names it', async () => {
  const before = bodies.length;
  const result = await sendPrompt('pi:test', '7', {
    text: 'see attached',
    selectedModelId: 'opencode-go/glm-5.3-flash',
    attachments: [{ filename: 'notes.txt', mime: 'text/plain', url: 'data:text/plain;base64,aGk=' }],
  });
  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect((result.data as { error: string }).error).toContain('notes.txt');
  expect((result.data as { error: string }).error).toContain('Only images');
  // Refused before the wire: nothing was submitted.
  expect(bodies.length).toBe(before);
});

test('aborting a Hearth conversation POSTs the abort route and reads what it kept', async () => {
  const previous = window.ember;
  let aborted = '';
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: async (_endpointId: string, path: string, init?: { method?: string }) => {
        if (init?.method === 'POST' && path.endsWith('/abort')) aborted = path;
        return { ok: true, status: 200, data: { ok: true, parked: 1, parkedText: ['Memory*'] } };
      },
    },
  };
  // The receipt is the whole point: an `ok` alone leaves the caller guessing whether the stop kept
  // the unsent messages, and that guess is what reported a held steer as "Not sent".
  expect(await abortSession({ id: '7', instanceId: 'pi:test' } as never)).toEqual({
    ok: true,
    parked: 1,
    parkedText: ['Memory*'],
  });
  expect(aborted).toBe('/conversations/7/abort');
  window.ember = previous;
});

test('a stop that says nothing about the queue is read as having kept nothing', async () => {
  const previous = window.ember;
  (globalThis as { window?: unknown }).window = {
    ember: { piRequest: async () => ({ ok: true, status: 200, data: { ok: true } }) },
  };
  expect(await abortSession({ id: '7', instanceId: 'pi:test' } as never)).toEqual({
    ok: true,
    parked: 0,
    parkedText: [],
  });
  window.ember = previous;
});

/**
 * A reply (or queued-message) context is submitted as a `write` entry: hidden from the transcript,
 * read by the agent. Hearth hands a write entry's text to the model through `entry.model`, so a
 * context that carried only `data` was stored, suppressed, and silently unread — an instruction the
 * user watched themselves write that never reached the model.
 */
test('a reply context reaches the model through entry.model, and stays hidden from the transcript', async () => {
  bodies.length = 0;
  await sendPrompt('pi:test', '7', {
    text: 'and the second one?',
    selectedModelId: 'opencode-go/glm-5.3-flash',
    replyContext: 'the first message',
  });
  const write = bodies.find((body) => body.type === 'write');
  expect(write).toBeDefined();
  const entry = (write?.entry ?? {}) as Record<string, unknown>;
  // The transcript suppression key is kept…
  expect(entry.kind).toBe('ember.reply-context');
  expect((entry.data as { text?: string }).text).toContain('the first message');
  // …and the model actually receives the words.
  const model = entry.model as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  expect(model[0].role).toBe('user');
  expect(model[0].content[0].type).toBe('text');
  expect(model[0].content[0].text).toContain('the first message');
  expect(model[0].content[0].text).toBe((entry.data as { text: string }).text);
});

test('queued-message instructions ride the same shape', async () => {
  bodies.length = 0;
  await sendPrompt('pi:test', '7', {
    text: 'the answer',
    selectedModelId: 'opencode-go/glm-5.3-flash',
    queuedContext: [{ text: 'the queued question', instructions: 'answer this queued message' }],
  });
  const writes = bodies.filter((body) => body.type === 'write');
  expect(writes.length).toBe(2);
  for (const write of writes) {
    const entry = write.entry as { data: { text: string }; model?: Array<{ content: Array<{ text: string }> }> };
    expect(entry.model?.[0]?.content[0]?.text).toBe(entry.data.text);
  }
});

/**
 * The reasoning level is a conversation setting of its own. A send that picks `high` while the model
 * stays on `Server default` used to skip `/configure` entirely (the old guard was `if (input.model)`),
 * so the level was dropped and the turn ran at whatever the conversation already had.
 */
test('a reasoning level alone reaches /configure, with no model', async () => {
  const previous = window.ember;
  const calls: Array<{ path: string; body: unknown }> = [];
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: async (_endpointId: string, path: string, init?: { body?: unknown }) => {
        calls.push({ path, body: init?.body });
        return { ok: true, status: 201, data: { submissionId: 1 } };
      },
    },
  };
  try {
    await sendPrompt('pi:test', '7', { text: 'think hard', selectedModelId: 'default', variant: 'high' });
    expect(calls[0]).toEqual({
      path: '/conversations/7/configure',
      body: { thinkingLevel: 'high' },
    });
    expect(calls[1]?.path).toBe('/conversations/7/submit');
  } finally {
    window.ember = previous;
  }
});

test('a model and a level travel together in one configure call', async () => {
  const previous = window.ember;
  const calls: Array<{ path: string; body: unknown }> = [];
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: async (_endpointId: string, path: string, init?: { body?: unknown }) => {
        calls.push({ path, body: init?.body });
        return { ok: true, status: 201, data: { submissionId: 1 } };
      },
    },
  };
  try {
    await sendPrompt('pi:test', '7', {
      text: 'think hard',
      selectedModelId: 'opencode-go/glm-5.3-flash',
      model: {
        providerID: 'opencode-go',
        modelID: 'glm-5.3-flash',
        label: 'GLM',
        details: { name: 'GLM', providerName: 'opencode-go', reasoning: true, toolcall: true, attachment: false, inputs: [], variants: ['high'] },
      },
      variant: 'high',
    });
    expect(calls[0]).toEqual({
      path: '/conversations/7/configure',
      body: { model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' }, thinkingLevel: 'high' },
    });
    // One configure, not one per setting.
    expect(calls.filter((call) => call.path.endsWith('/configure'))).toHaveLength(1);
  } finally {
    window.ember = previous;
  }
});

test('a plain send with neither a model nor a level makes no configure call', async () => {
  const previous = window.ember;
  const paths: string[] = [];
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: async (_endpointId: string, path: string) => {
        paths.push(path);
        return { ok: true, status: 201, data: { submissionId: 1 } };
      },
    },
  };
  try {
    await sendPrompt('pi:test', '7', { text: 'hello', selectedModelId: 'default' });
    expect(paths.some((path) => path.endsWith('/configure'))).toBe(false);
  } finally {
    window.ember = previous;
  }
});
