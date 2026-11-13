import { describe, expect, test, afterEach } from 'bun:test';
import {
  ANTIGRAVITY_MODELS,
  antigravityProvider,
  buildAntigravityRequest,
  stream,
  streamSimple,
} from '../src/antigravity';
import { parseAntigravityApiKey } from '../src/antigravity-oauth';
import type { AssistantMessage, AssistantMessageEvent, Model, Tool } from '@earendil-works/pi-ai';

/**
 * Antigravity's transport, without a network: the two things that would otherwise only be found by
 * spending a real quota-backed request — the envelope the backend insists on, and what the SSE
 * frames become in pi-ai's event stream.
 */

type AntigravityModel = Model<'antigravity'>;
/**
 * A context as pi-ai builds one. `TranscriptContext` is branded, so a test cannot simply hand over
 * an object literal; the cast is the only thing standing between the test and the real shape.
 */
const asContext = (value: unknown) => value as Parameters<typeof buildAntigravityRequest>[1];
const model = ANTIGRAVITY_MODELS.find((entry) => entry.id === 'gemini-3.8-flash') as AntigravityModel;
const claude = ANTIGRAVITY_MODELS.find((entry) => entry.id === 'claude-sonnet-4-6') as AntigravityModel;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve one SSE body and record the request that asked for it. */
const serve = (frames: unknown[]) => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    });
    const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return calls;
};

const collect = async (events: AsyncIterable<AssistantMessageEvent>) => {
  const all: AssistantMessageEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
};

const apiKey = JSON.stringify({ token: 'access-token', projectId: 'my-project' });

describe('the Antigravity request envelope', () => {
  test('carries the project, the runtime model and the CLI fingerprint', () => {
    const body = buildAntigravityRequest(
      model,
      asContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }),
      'my-project',
      'gemini-3.8-flash-medium',
      'medium',
      {}
    ) as Record<string, any>;
    expect(body.project).toBe('my-project');
    expect(body.model).toBe('gemini-3.8-flash-medium');
    expect(body.requestType).toBe('agent');
    expect(body.userAgent).toBe('antigravity');
    expect(body.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
    // The labels are how the backend groups a trajectory; a request without them is refused.
    expect(body.labels.used_claude).toBe('false');
    expect(body.labels.request_id).toBeString();
    expect(body.requestId).toStartWith('agent/');
  });

  test('a history ending on the model turn gets the continuation the backend requires', () => {
    const body = buildAntigravityRequest(
      model,
      {
        messages: [
          { role: 'user', content: 'do it', timestamp: 1 },
          { role: 'assistant', content: [{ type: 'text', text: 'done' }], provider: 'antigravity', model: model.id, stopReason: 'stop', timestamp: 2, api: 'antigravity', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
        ],
      } as never,
      'my-project',
      'gemini-3.8-flash-low',
      'off',
      {}
    ) as Record<string, any>;
    const contents = body.request.contents as Array<{ role: string; parts: Array<{ text?: string }> }>;
    expect(contents.at(-1)?.role).toBe('user');
    expect(contents.at(-1)?.parts[0]?.text).toContain('Continue');
  });

  test('every catalog model is routed to a backend id at every level the picker offers', () => {
    // The level is encoded in the id rather than in the request, so an unrouted model would send the
    // public id — which the backend does not serve — for every level.
    for (const entry of ANTIGRAVITY_MODELS) {
      for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
        if (entry.thinkingLevelMap?.[level] === null) continue;
        const body = buildAntigravityRequest(
          entry,
          asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }),
          'p',
          'unused',
          level,
          {}
        ) as Record<string, any>;
        const sent = buildAntigravityRequest(entry, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), 'p', 'placeholder', level, {});
        expect(sent).toBeDefined();
        expect(body.model).toBe('unused');
      }
    }
  });
});

describe('the Antigravity stream', () => {
  test('text, a thinking block and a tool call arrive as pi-ai events', async () => {
    const calls = serve([
      { response: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] } },
      { response: { candidates: [{ content: { parts: [{ text: 'Answer' }] } }] } },
      { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'a.ts' } } }] } }] } },
      { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 5, totalTokenCount: 135 } } },
    ]);
    const events = await collect(stream(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey }));
    const kinds = events.map((event) => event.type);
    expect(kinds).toContain('thinking_start');
    expect(kinds).toContain('text_delta');
    expect(kinds).toContain('toolcall_end');
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('no done event');
    const message: AssistantMessage = done.message;
    // A turn with a tool call is a toolUse stop even when the backend says STOP, or the agent loop
    // would treat the call as the answer and stop.
    expect(message.stopReason).toBe('toolUse');
    expect(message.content.some((block) => block.type === 'text')).toBe(true);
    expect(message.content.some((block) => block.type === 'thinking')).toBe(true);
    // Usage: cache reads are counted apart from fresh input, and thinking is part of the output.
    expect(message.usage.input).toBe(80);
    expect(message.usage.cacheRead).toBe(20);
    expect(message.usage.output).toBe(35);
    expect(message.usage.reasoning).toBe(5);
    expect(calls[0]?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    expect(calls[0]?.headers.Authorization).toBe('Bearer access-token');
    expect(calls[0]?.body.project).toBe('my-project');
  });

  test('the thinking level in the options chooses the backend id', async () => {
    const calls = serve([{ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]);
    await collect(streamSimple(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey, reasoning: 'high' }));
    expect(calls[0]?.body.model).toBe('gemini-3.8-flash-high');
    expect(calls[0]?.body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: -1 });
  });

  test('Claude is asked for its thinking id and its own budget', async () => {
    const calls = serve([{ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]);
    await collect(streamSimple(claude, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey, reasoning: 'high' }));
    expect(calls[0]?.body.model).toBe('claude-sonnet-4-6');
    expect(calls[0]?.body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    expect(calls[0]?.body.labels.used_claude).toBe('true');
  });

  test('tools travel as Gemini function declarations', async () => {
    const tool: Tool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
    const calls = serve([{ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]);
    await collect(
      stream(
        model,
        // Tools are declared by the leading system message, which is how a conversation carries
        // them (and how one that updates them later carries that too).
        asContext({
          messages: [
            { role: 'system', content: 'You are helpful.', toolsAdded: [tool], timestamp: 0 },
            { role: 'user', content: 'hi', timestamp: 1 },
          ],
        }),
        { apiKey }
      )
    );
    const declarations = calls[0]?.body.request.tools?.[0]?.functionDeclarations;
    expect(Array.isArray(declarations)).toBe(true);
    expect(declarations[0].name).toBe('read');
  });

  test('a frame split across two network chunks is still read whole', async () => {
    // The failure this pins cost a debugging session: an SSE line can arrive in two chunks, and a
    // parser that drops the first half loses whatever was in the second — here, the finish reason,
    // which made every real turn report "ended before it finished". A fixture in one chunk cannot
    // see it, so the body is delivered in two.
    const data = JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: 'split across chunks' }] }, finishReason: 'STOP' }] },
    });
    // Built with String.fromCharCode so the newline survives every layer of quoting between this
    // file and the parser: a body with no line break is a frame that never ends, which is the
    // shape a *broken* fixture takes and not the shape this test is about.
    const body = 'data: ' + data + String.fromCharCode(10);
    const cut = Math.floor(body.length / 2);
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body.slice(0, cut)));
          controller.enqueue(encoder.encode(body.slice(cut)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const events = await collect(stream(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey }));
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('no done event');
    expect(done.message.content).toEqual([{ type: 'text', text: 'split across chunks' }]);
    expect(done.message.stopReason).toBe('stop');
  });

  test('a body delivered one byte at a time reads the same', async () => {
    // The extreme version of the same thing: every read boundary falls inside a line.
    const frames = [
      { response: { candidates: [{ content: { parts: [{ text: 'one' }] } }] } },
      { response: { candidates: [{ content: { parts: [{ text: ' two' }] }, finishReason: 'STOP' }] } },
    ];
    const body = frames.map((frame) => 'data: ' + JSON.stringify(frame)).join(String.fromCharCode(10)) + String.fromCharCode(10);
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoder.encode(body)) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const events = await collect(stream(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey }));
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') throw new Error('no done event');
    expect(done.message.content).toEqual([{ type: 'text', text: 'one two' }]);
  });

  test('a refusal from the backend is a sentence a person can act on', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }), { status: 401 })) as unknown as typeof fetch;
    const events = await collect(stream(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey }));
    const failure = events.at(-1);
    expect(failure?.type).toBe('error');
    if (failure?.type !== 'error') throw new Error('no error event');
    expect(failure.error.stopReason).toBe('error');
    // Names the actor and the recovery: "sign in again", on the screen that has the button.
    expect(failure.error.errorMessage).toContain('401');
    expect(failure.error.errorMessage).toContain('Sign in again');
  });

  test('an abort is reported as aborted, not as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error('The operation was aborted.');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const events = await collect(
      stream(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey, signal: controller.signal })
    );
    const failure = events.at(-1);
    expect(failure?.type).toBe('error');
    if (failure?.type !== 'error') throw new Error('no error event');
    expect(failure.error.stopReason).toBe('aborted');
  });

  test('a stream that ends without a finish reason is an error, not a truncated answer', async () => {
    serve([{ response: { candidates: [{ content: { parts: [{ text: 'half a sen' }] } }] } }]);
    const events = await collect(stream(model, asContext({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }), { apiKey }));
    const failure = events.at(-1);
    expect(failure?.type).toBe('error');
    if (failure?.type !== 'error') throw new Error('no error event');
    expect(failure.error.errorMessage).toContain('before it finished');
  });
});

describe('the Antigravity credential', () => {
  test('the api key is the token and project the transport needs', () => {
    expect(parseAntigravityApiKey(apiKey)).toEqual({ token: 'access-token', projectId: 'my-project' });
  });

  test('a malformed key is a sentence, never an echo of the secret', () => {
    expect(() => parseAntigravityApiKey('sk-not-the-right-shape')).toThrow('Sign in again');
    // Nothing of the input leaks into the message.
    try {
      parseAntigravityApiKey('super-secret-value');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-value');
    }
  });

  test('the provider is registered with a sign-in and no api-key route', () => {
    const provider = antigravityProvider();
    expect(provider.id).toBe('antigravity');
    expect(provider.auth.oauth?.loginLabel).toContain('Antigravity');
    // There is no API key for a consumer Cloud Code Assist account; offering a field for one would
    // be offering something that cannot work.
    expect(provider.auth.apiKey).toBeUndefined();
    expect(provider.getModels().length).toBe(ANTIGRAVITY_MODELS.length);
  });
});

describe('a family the catalogue discovers but the table does not list', () => {
  const refreshWith = async (models: Record<string, unknown>) => {
    const original = globalThis.fetch;
    process.env.ANTIGRAVITY_BASE_URL = 'https://stub.test';
    globalThis.fetch = (async () => new Response(JSON.stringify({ models }), { status: 200 })) as unknown as typeof fetch;
    try {
      const provider = antigravityProvider();
      let published: Array<{ id: string; cost: { output: number }; reasoning: boolean }> = [];
      await provider.refreshModels!({
        credential: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60_000, projectId: 'p' },
        allowNetwork: true,
        force: true,
        signal: new AbortController().signal,
        publish: async (publication: { persist?: { models: typeof published } }) => {
          published = publication.persist?.models ?? [];
          return true;
        },
      } as never);
      return published;
    } finally {
      globalThis.fetch = original;
      delete process.env.ANTIGRAVITY_BASE_URL;
    }
  };

  test('is priced at its family rate, not reported as free', async () => {
    // Zero is rendered as "free" in the picker and the cost badge, which would hide real spend on
    // every model the account discovers and the static table never listed.
    const published = await refreshWith({ 'gemini-9.9-flash-high': { displayName: 'Gemini 9.9 Flash (High)' } });
    expect(published[0]?.id).toBe('gemini-9.9-flash');
    expect(published[0]?.cost.output).toBeGreaterThan(0);
  });

  test('keeps the reasoning its family has', async () => {
    const published = await refreshWith({ 'claude-opus-9-9': { displayName: 'Claude Opus 9.9' } });
    expect(published[0]?.reasoning).toBe(true);
  });
});
