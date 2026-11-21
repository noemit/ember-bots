import { describe, expect, test } from 'bun:test';
import {
  framesToHints,
  MAX_RESPONSE_BYTES,
  MAX_SOCKETS_PER_ENDPOINT,
  MAX_WATCHED_CONVERSATIONS,
  PiClient,
  RECENT_WATCHED_CONVERSATIONS,
  selectWatchedConversationIds,
  type PiHint,
} from '../electron/piClient';

/**
 * Hearth's stream frames → the hints the renderer already understands.
 *
 * Since Hearth 0.41.0 (pi-durable 1.5.0) the stream carries **state**, not events: a `view` on
 * attach, then `text` / `appended` / `changed`. The transport's whole job is this mapping, and the
 * two ways to get it wrong are visible in the UI: a missing entry means a column that stops
 * updating, an over-eager one means a REST read per token.
 */
const frames = (...list: unknown[]): string => JSON.stringify(list);

describe('what each frame becomes', () => {
  test('the attach view asks for one repair read, not for the transcript', () => {
    const hints = framesToHints('pi:test', '7', frames({ type: 'view', docs: { 'pi.live': {} }, conversation: { id: 7 } }));
    expect(hints.map((hint) => hint.type)).toEqual(['pi:view']);
    // The view carries no entries: history is the paged REST read.
    expect(hints[0]?.deltas).toBeUndefined();
  });

  test('streamed text becomes deltas the renderer applies without a read', () => {
    const hints = framesToHints(
      'pi:test',
      '7',
      frames({
        type: 'text',
        deltas: [
          { index: 0, kind: 'text', text: 'Hel' },
          { index: 1, kind: 'thinking', text: 'pondering' },
        ],
      })
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]?.type).toBe('pi:message_update');
    expect(hints[0]?.deltas).toEqual([
      { index: 0, kind: 'text', text: 'Hel' },
      { index: 1, kind: 'thinking', text: 'pondering' },
    ]);
  });

  test('a malformed or oversized delta batch still takes the REST path', () => {
    const bad = framesToHints('pi:test', '7', frames({ type: 'text', deltas: [{ index: 'x', text: 5 }] }));
    expect(bad[0]?.type).toBe('pi:message_update');
    expect(bad[0]?.deltas).toBeUndefined();
    const huge = framesToHints(
      'pi:test',
      '7',
      frames({ type: 'text', deltas: [{ index: 0, kind: 'text', text: 'x'.repeat(9_000) }] })
    );
    expect(huge[0]?.deltas).toBeUndefined();
  });

  test('an appended entry is the same hint a settled message used to be', () => {
    const hints = framesToHints('pi:test', '7', frames({ type: 'appended', entries: [{ id: 11 }] }));
    expect(hints.map((hint) => [hint.type, hint.sessionId])).toEqual([['pi:message_end', '7']]);
  });

  test('each changed kind keeps the weight the old event had', () => {
    const hints = framesToHints(
      'pi:test',
      '7',
      frames({ type: 'changed', kinds: ['inbox', 'run_start', 'compaction', 'conversation'] })
    );
    expect(hints.map((hint) => hint.type)).toEqual([
      'pi:inbox_update',
      'pi:run_start',
      'pi:compaction_end',
      'pi:submission',
    ]);
    // Duplicates collapse: one read per kind, not one per op behind it.
    const deduped = framesToHints('pi:test', '7', frames({ type: 'changed', kinds: ['live', 'live', 'usage'] }));
    expect(deduped.map((hint) => hint.type)).toEqual(['pi:tool_execution_update', 'pi:usage_changed']);
  });

  test('a frame this build does not know is ignored rather than guessed at', () => {
    expect(framesToHints('pi:test', '7', frames({ type: 'invented' }))).toEqual([]);
    expect(framesToHints('pi:test', '7', 'not json')).toEqual([]);
    expect(framesToHints('pi:test', '7', frames({ type: 'changed', kinds: ['something-new'] }))[0]?.type).toBe(
      'pi:tool_execution_update'
    );
  });

  test('milestone kinds still reach the activity log', () => {
    const hints = framesToHints('pi:test', '7', frames({ type: 'changed', kinds: ['run_start'] }));
    expect(hints[0]?.summary).toBe('started working');
  });
});

describe('the transport', () => {
  test('it forwards a frame batch as one hint per frame, in order', () => {
    const emitted: PiHint[] = [];
    const client = new PiClient((event) => emitted.push(event as PiHint));
    const internal = client as unknown as {
      forwardEvents: (endpointId: string, conversationId: string, message: string) => void;
    };
    internal.forwardEvents(
      'pi:test',
      '123',
      frames({ type: 'changed', kinds: ['run_start'] }, { type: 'text', deltas: [{ index: 0, kind: 'text', text: 'hi' }] })
    );
    expect(emitted.map((hint) => hint.type)).toEqual(['pi:run_start', 'pi:message_update']);
  });

  test('selectWatchedConversationIds watches on-screen ∪ busy ∪ the N most recent active conversations', () => {
    const all = Array.from({ length: 168 }, (_, index) => ({
      id: 1000 - index,
      busy: index === 50,
      needsInput: index === 90,
      archived: index === 2 ? 12345 : undefined,
    }));
    const watched = selectWatchedConversationIds(all, {
      openIds: new Set([1000 - 120]),
      recentLimit: RECENT_WATCHED_CONVERSATIONS,
    });
    // 16 recent non-archived + 1 busy (idx 50) + 1 needsInput (idx 90) + 1 open (idx 120) = 19
    expect(watched).toHaveLength(RECENT_WATCHED_CONVERSATIONS + 3);
    expect(watched).toContain(1000 - 50);
    expect(watched).toContain(1000 - 90);
    expect(watched).toContain(1000 - 120);
    // Archived conversation (idx 2) is excluded unless open or busy.
    expect(watched).not.toContain(1000 - 2);
  });
});

/**
 * A client may never hold more sockets for one host than its watch set justifies.
 *
 * On 2026-11-05 a 1.0.0 client held thousands of connections to one Hearth: the host's `/health`
 * went from milliseconds to timing out, and `systemd-oomd` killed it four times in an hour. Whether
 * that was a duplicate endpoint or a socket that never closed, the client had no ceiling of its
 * own, so nothing stopped it. These pin the ceiling, and pin that it binds without wedging.
 */
describe('every socket a client opens is one the watch set asked for', () => {
  const serve = (conversations: { id: number }[], onOpen?: () => void, onClose?: () => void) => {
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        const { pathname } = new URL(request.url);
        if (pathname === '/conversations') return Response.json({ conversations });
        if (pathname.endsWith('/events') || pathname.endsWith('/tasks/stream')) {
          if (!srv.upgrade(request, { data: {} })) return new Response('no upgrade', { status: 426 });
          return undefined as unknown as Response;
        }
        return new Response('not found', { status: 404 });
      },
      websocket: { open: () => onOpen?.(), close: () => onClose?.(), message() {} },
    });
    return server;
  };

  test('the count never exceeds the cap, even across repeated restarts', async () => {
    const server = serve(Array.from({ length: 80 }, (_, index) => ({ id: index + 1 })));
    const client = new PiClient(() => {});
    try {
      await client.syncEndpoints([
        { id: 'pi:test', label: 'Test', url: `http://127.0.0.1:${server.port}/`, token: 't'.repeat(64) },
      ]);
      // `restartAll` closes and reopens every socket, which is exactly where a count that is never
      // released would drift up until the host drowned.
      for (let round = 0; round < 5; round += 1) {
        await Bun.sleep(150);
        expect(client.socketCount('pi:test')).toBeLessThanOrEqual(MAX_SOCKETS_PER_ENDPOINT);
        client.restartAll();
      }
      await Bun.sleep(150);
      expect(client.socketCount('pi:test')).toBeLessThanOrEqual(MAX_SOCKETS_PER_ENDPOINT);
      expect(MAX_SOCKETS_PER_ENDPOINT).toBeLessThanOrEqual(MAX_WATCHED_CONVERSATIONS + 2);

      client.closeAll();
      await Bun.sleep(150);
      // Every socket is released when the client stops, so a window closing leaves the host nothing
      // to carry.
      expect(client.socketCount('pi:test')).toBe(0);
    } finally {
      client.closeAll();
      server.stop(true);
    }
  });

  test('the cap binds without wedging: a budget of 3 holds the line and still connects everything', async () => {
    let live = 0;
    let peak = 0;
    const server = serve(
      Array.from({ length: 80 }, (_, index) => ({ id: index + 1 })),
      () => {
        live += 1;
        peak = Math.max(peak, live);
      },
      () => {
        live -= 1;
      }
    );
    const client = new PiClient(() => {}, undefined, undefined, { maxSocketsPerEndpoint: 3 });
    try {
      await client.syncEndpoints([
        { id: 'pi:test', label: 'Test', url: `http://127.0.0.1:${server.port}/`, token: 't'.repeat(64) },
      ]);
      for (let round = 0; round < 4; round += 1) {
        await Bun.sleep(100);
        expect(client.socketCount('pi:test')).toBeLessThanOrEqual(3);
      }
      // Held to three at the host too, not merely reported as three.
      expect(peak).toBeLessThanOrEqual(3);
    } finally {
      client.closeAll();
      server.stop(true);
    }
  });

  test('syncEndpoints never silently broadcasts bearer tokens or peer lists across configured hosts', async () => {
    const requestsA: Array<{ method: string; pathname: string; body: string }> = [];
    const requestsB: Array<{ method: string; pathname: string; body: string }> = [];
    const makeHost = (sink: Array<{ method: string; pathname: string; body: string }>) =>
      Bun.serve({
        port: 0,
        async fetch(request, srv) {
          const { pathname } = new URL(request.url);
          if (pathname.endsWith('/events') || pathname.endsWith('/tasks/stream')) {
            if (!srv.upgrade(request, { data: {} })) return new Response('no upgrade', { status: 426 });
            return undefined as unknown as Response;
          }
          sink.push({ method: request.method, pathname, body: await request.text() });
          if (pathname === '/conversations') return Response.json({ conversations: [] });
          return new Response('not found', { status: 404 });
        },
        websocket: { open() {}, close() {}, message() {} },
      });

    const hostA = makeHost(requestsA);
    const hostB = makeHost(requestsB);
    const client = new PiClient(() => {});
    const tokenA = 'local-secret-bearer-token-alpha';
    const tokenB = 'remote-secret-bearer-token-bravo';
    try {
      await client.syncEndpoints([
        { id: 'pi:local', label: 'This computer', url: `http://127.0.0.1:${hostA.port}`, token: tokenA },
        { id: 'pi:tower', label: 'Tower', url: `http://127.0.0.1:${hostB.port}`, token: tokenB },
      ]);
      await Bun.sleep(100);
      expect(requestsA.some((r) => r.pathname.startsWith('/directory/peers'))).toBe(false);
      expect(requestsB.some((r) => r.pathname.startsWith('/directory/peers'))).toBe(false);
      expect(JSON.stringify(requestsA)).not.toContain(tokenB);
      expect(JSON.stringify(requestsB)).not.toContain(tokenA);
    } finally {
      client.closeAll();
      hostA.stop(true);
      hostB.stop(true);
    }
  });

  test('PiClient.request refuses HTTP redirects with bearer headers and enforces the 32 MB response reader', async () => {
    expect(MAX_RESPONSE_BYTES).toBe(32 * 1024 * 1024);
    let leakedAuth: string | null = null;
    const attacker = Bun.serve({
      port: 0,
      fetch(req) {
        leakedAuth = req.headers.get('authorization');
        return Response.json({ conversations: [] });
      },
    });
    const redirector = Bun.serve({
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${attacker.port}/conversations`, 302);
      },
    });
    try {
      let seenRedirect: RequestInit['redirect'];
      const client = new PiClient(
        () => {},
        () => ({ id: 'pi:test', label: 'Tower', url: `http://127.0.0.1:${redirector.port}`, token: 'secret-kiln-token' }),
        undefined,
        {
          fetchImpl: ((input, init) => {
            seenRedirect = init?.redirect;
            return fetch(input, init);
          }) as typeof fetch,
        }
      );
      const redirected = await client.request('pi:test', '/conversations');
      expect(seenRedirect).toBe('error');
      expect(redirected.ok).toBe(false);
      expect(redirected.status).toBe(0);
      expect(leakedAuth).toBeNull();

      const headerCapped = new PiClient(
        () => {},
        () => ({ id: 'pi:test', label: 'Tower', url: 'http://127.0.0.1:3002', token: 'secret-kiln-token' }),
        undefined,
        {
          fetchImpl: (async () =>
            new Response('oversized', {
              status: 200,
              headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
            })) as typeof fetch,
        }
      );
      expect(await headerCapped.request('pi:test', '/conversations')).toEqual({
        ok: false,
        status: 413,
        data: { error: 'Response body is too large', source: 'ember' },
      });

      let cancelled = false;
      const streamCapped = new PiClient(
        () => {},
        () => ({ id: 'pi:test', label: 'Tower', url: 'http://127.0.0.1:3002', token: 'secret-kiln-token' }),
        undefined,
        {
          maxResponseBytes: 1024,
          fetchImpl: (async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(new Uint8Array(600));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { status: 200 }
            )) as typeof fetch,
        }
      );
      expect(await streamCapped.request('pi:test', '/conversations')).toEqual({
        ok: false,
        status: 413,
        data: { error: 'Response body is too large', source: 'ember' },
      });
      expect(cancelled).toBe(true);
    } finally {
      redirector.stop(true);
      attacker.stop(true);
    }
  });
});

describe('PiClient shutdown, endpoint-edit races, and watchTimer cleanup', () => {
  test('closeAll() mid-refresh bails out before opening conversation watches or starting watchTimer', async () => {
    let seenConversationsFetch!: () => void;
    const conversationsRequested = new Promise<void>((resolve) => {
      seenConversationsFetch = resolve;
    });
    let releaseConversations!: () => void;
    const conversationsGate = new Promise<void>((resolve) => {
      releaseConversations = resolve;
    });
    const openedConversationStreams: string[] = [];

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, srv) {
        const { pathname } = new URL(request.url);
        if (pathname === '/conversations') {
          seenConversationsFetch();
          await conversationsGate;
          return Response.json({ conversations: [{ id: 1 }, { id: 2 }] });
        }
        if (pathname.endsWith('/events') || pathname.endsWith('/tasks/stream')) {
          if (pathname.endsWith('/events')) openedConversationStreams.push(pathname);
          if (!srv.upgrade(request, { data: {} })) return new Response('no upgrade', { status: 426 });
          return undefined as unknown as Response;
        }
        return new Response('not found', { status: 404 });
      },
      websocket: { open() {}, close() {}, message() {} },
    });

    const client = new PiClient(() => {});
    try {
      const syncing = client.syncEndpoints([
        { id: 'pi:test', label: 'Test', url: `http://127.0.0.1:${server.port}`, token: 'tok' },
      ]);
      await conversationsRequested;
      // Shut down while GET /conversations is still in flight.
      client.closeAll();
      releaseConversations();
      await syncing;
      await Bun.sleep(80);

      expect(openedConversationStreams).toEqual([]);
      expect(client.socketCount('pi:test')).toBe(0);
      expect(client.hasWatchTimer()).toBe(false);
    } finally {
      client.closeAll();
      server.stop(true);
    }
  });

  test('changing an endpoint URL or token mid-refresh discards the stale watch set without tearing down the new one', async () => {
    let seenOldFetch!: () => void;
    const oldFetchStarted = new Promise<void>((resolve) => {
      seenOldFetch = resolve;
    });
    let releaseOldFetch!: () => void;
    const oldFetchGate = new Promise<void>((resolve) => {
      releaseOldFetch = resolve;
    });

    const newServerPaths: string[] = [];
    let newConvClosed = 0;

    const oldServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, srv) {
        const { pathname } = new URL(request.url);
        if (pathname === '/conversations') {
          seenOldFetch();
          await oldFetchGate;
          return Response.json({ conversations: [{ id: 101 }] });
        }
        if (pathname.endsWith('/events') || pathname.endsWith('/tasks/stream')) {
          if (!srv.upgrade(request, { data: {} })) return new Response('no upgrade', { status: 426 });
          return undefined as unknown as Response;
        }
        return new Response('not found', { status: 404 });
      },
      websocket: { open() {}, close() {}, message() {} },
    });

    const newServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, srv) {
        const { pathname } = new URL(request.url);
        newServerPaths.push(pathname);
        if (pathname === '/conversations') {
          return Response.json({ conversations: [{ id: 202 }] });
        }
        if (pathname.endsWith('/events') || pathname.endsWith('/tasks/stream')) {
          if (request.headers.get('authorization') !== 'Bearer new-token') {
            return new Response('unauthorized', { status: 401 });
          }
          if (!srv.upgrade(request, { data: { pathname } })) return new Response('no upgrade', { status: 426 });
          return undefined as unknown as Response;
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open() {},
        close(ws) {
          if ((ws.data as { pathname?: string })?.pathname === '/conversations/202/events') {
            newConvClosed += 1;
          }
        },
        message() {},
      },
    });

    const client = new PiClient(() => {});
    try {
      const firstSync = client.syncEndpoints([
        { id: 'pi:test', label: 'Test', url: `http://127.0.0.1:${oldServer.port}`, token: 'old-token' },
      ]);
      await oldFetchStarted;

      // Edit the endpoint mid-request to point at newServer with a rotated token.
      await client.syncEndpoints([
        { id: 'pi:test', label: 'Test', url: `http://127.0.0.1:${newServer.port}`, token: 'new-token' },
      ]);
      await Bun.sleep(60);

      // Now let the slow `/conversations` from oldServer resolve with conversation 101.
      releaseOldFetch();
      await firstSync;
      await Bun.sleep(80);

      expect(newServerPaths).toContain('/conversations/202/events');
      expect(newServerPaths).not.toContain('/conversations/101/events');
      expect(newConvClosed).toBe(0);
    } finally {
      client.closeAll();
      oldServer.stop(true);
      newServer.stop(true);
    }
  });

  test('syncEndpoints([]) clears watchTimer and releases all sockets, including when superseding an in-flight sync', async () => {
    let releaseSlow!: () => void;
    let blockConversations = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, srv) {
        const { pathname } = new URL(request.url);
        if (pathname === '/conversations') {
          if (blockConversations) {
            await new Promise<void>((resolve) => {
              releaseSlow = resolve;
            });
          }
          return Response.json({ conversations: [{ id: 7 }] });
        }
        if (pathname.endsWith('/events') || pathname.endsWith('/tasks/stream')) {
          if (!srv.upgrade(request, { data: {} })) return new Response('no upgrade', { status: 426 });
          return undefined as unknown as Response;
        }
        return new Response('not found', { status: 404 });
      },
      websocket: { open() {}, close() {}, message() {} },
    });

    const endpoint = {
      id: 'pi:test',
      label: 'Test',
      url: `http://127.0.0.1:${server.port}`,
      token: 'token',
    };
    const client = new PiClient(() => {});
    try {
      await client.syncEndpoints([endpoint]);
      await Bun.sleep(60);
      expect(client.hasWatchTimer()).toBe(true);
      expect(client.socketCount('pi:test')).toBeGreaterThan(0);

      await client.syncEndpoints([]);
      await Bun.sleep(60);
      expect(client.hasWatchTimer()).toBe(false);
      expect(client.socketCount('pi:test')).toBe(0);

      // Superseding an in-flight syncEndpoints([endpoint]) with syncEndpoints([]) keeps watchTimer off.
      blockConversations = true;
      const inFlight = client.syncEndpoints([endpoint]);
      await Bun.sleep(20);
      await client.syncEndpoints([]);
      releaseSlow?.();
      await inFlight;
      await Bun.sleep(60);
      expect(client.hasWatchTimer()).toBe(false);
      expect(client.socketCount('pi:test')).toBe(0);
      expect(client.status()).toEqual({});
    } finally {
      client.closeAll();
      server.stop(true);
    }
  });
});
