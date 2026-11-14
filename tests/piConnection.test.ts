import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiClient } from '../electron/piClient';
import { connectionFailure, connectionMessage, piConnectionHeaders, testPiEndpoint } from '../electron/piConnection';

const draft = { label: 'Fixture Kiln', url: 'https://fixture.invalid', token: 'kiln-secret', access: { clientId: 'access-id', clientSecret: 'access-secret' } };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const fixture = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  return { server, endpoint: { label: 'Fixture Kiln', url: `http://127.0.0.1:${server.port}`, token: 'fixture-token' } };
};

describe('separate transport credentials', () => {
  test('Access headers never replace Kiln bearer or enter a URL', () => {
    expect(piConnectionHeaders(draft)).toEqual({ authorization: 'Bearer kiln-secret', 'CF-Access-Client-Id': 'access-id', 'CF-Access-Client-Secret': 'access-secret' });
    expect(() => piConnectionHeaders({ ...draft, url: 'http://127.0.0.1' })).toThrow();
    expect(() => piConnectionHeaders({ ...draft, access: { clientId: 'id', clientSecret: '' } })).toThrow();
    expect(() => piConnectionHeaders({ ...draft, url: 'https://user:password@fixture.invalid' })).toThrow();
  });

  test('REST and both authenticated readiness requests carry separate Access headers', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer kiln-secret');
      expect(headers.get('cf-access-client-id')).toBe('access-id');
      expect(headers.get('cf-access-client-secret')).toBe('access-secret');
      expect(init?.redirect).toBe('error');
      expect(String(input)).not.toContain('secret');
      seen.push(String(input));
      return Response.json(String(input).endsWith('/health') ? { ok: true, service: 'hearth', version: '1.0.0' } : { conversations: [] });
    }) as typeof fetch;
    expect((await testPiEndpoint(draft)).outcome).toBe('ready');
    const client = new PiClient(() => {}, () => ({ ...draft, id: 'pi:fixture' }));
    expect((await client.request('pi:fixture', '/conversations')).ok).toBe(true);
    expect(seen).toHaveLength(3);
  });

  test('HTTP or locked Access never sends a bearer-only fallback', async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return Response.json({}); }) as typeof fetch;
    expect((await testPiEndpoint({ ...draft, url: 'http://127.0.0.1' })).outcome).toBe('tls-error');
    expect((await testPiEndpoint({ ...draft, access: { clientId: 'id', clientSecret: '' } })).outcome).toBe('auth-rejected');
    expect(requests).toBe(0);
  });
});

describe('verified readiness and safe diagnostics', () => {
  test('real fixture requires bearer for health and conversation routes', async () => {
    const { server, endpoint } = fixture((request) => {
      if (request.headers.get('authorization') !== 'Bearer fixture-token') return new Response('secret echoed here', { status: 401 });
      return Response.json(new URL(request.url).pathname === '/health' ? { ok: true, service: 'hearth', version: '1.2.3' } : { conversations: [] });
    });
    try {
      expect((await testPiEndpoint({ ...endpoint, token: 'wrong' })).outcome).toBe('auth-rejected');
      expect((await testPiEndpoint(endpoint)).outcome).toBe('ready');
      expect((await new PiClient(() => {}).probe(endpoint)).healthy).toBe(true);
    } finally { server.stop(true); }
  });

  test('random successful pages and unready authenticated routes are not Kiln', async () => {
    for (const body of [{}, { ok: true }, '<html>login</html>']) {
      globalThis.fetch = (async () => typeof body === 'string' ? new Response(body) : Response.json(body)) as typeof fetch;
      expect((await testPiEndpoint(draft)).outcome).toBe('wrong-service');
    }
    let call = 0;
    globalThis.fetch = (async () => ++call === 1 ? Response.json({ ok: true, service: 'hearth' }) : new Response('denied', { status: 403 })) as typeof fetch;
    expect((await testPiEndpoint(draft)).outcome).toBe('auth-rejected');
  });

  test('REST and probe refuse cross-origin redirects without forwarding auth', async () => {
    let leaked = 0;
    const target = fixture(() => { leaked++; return Response.json({ ok: true, service: 'hearth' }); });
    const source = fixture(() => Response.redirect(`${target.endpoint.url}/capture?secret=do-not-show`, 302));
    try {
      const result = await testPiEndpoint(source.endpoint);
      expect(result.outcome).toBe('wrong-service');
      const client = new PiClient(() => {}, () => ({ ...source.endpoint, id: 'pi:fixture' }));
      const response = await client.request('pi:fixture', '/health');
      expect(response.ok).toBe(false);
      expect(leaked).toBe(0);
      expect(JSON.stringify([result, response])).not.toContain('do-not-show');
    } finally { source.server.stop(true); target.server.stop(true); }
  });

  test('same-origin redirects are refused too', async () => {
    let followed = 0;
    const { server, endpoint } = fixture((request) => {
      if (new URL(request.url).pathname === '/capture') { followed++; return Response.json({}); }
      return Response.redirect(new URL('/capture', request.url).href, 302);
    });
    try {
      expect((await testPiEndpoint(endpoint)).outcome).toBe('wrong-service');
      expect(followed).toBe(0);
    } finally { server.stop(true); }
  });

  test('health metadata cannot echo credentials or URLs into test results', async () => {
    globalThis.fetch = (async (input) => Response.json(String(input).endsWith('/health')
      ? { ok: true, service: 'hearth', version: draft.token, commit: 'https://user:secret@fixture.invalid' }
      : { conversations: [] })) as typeof fetch;
    const result = await testPiEndpoint(draft);
    expect(result.outcome).toBe('ready');
    expect(result.version).toBeUndefined();
    expect(result.commit).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/kiln-secret|secret@/);
  });

  test('timeouts, TLS failures and dropped connections use host-named actionable redacted copy', async () => {
    for (const [error, outcome] of [
      [new DOMException('https://secret@private.invalid access-secret', 'TimeoutError'), 'timeout'],
      [Object.assign(new Error('kiln-secret'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), 'tls-error'],
      [new Error('https://secret@private.invalid access-secret'), 'unreachable'],
    ] as const) {
      globalThis.fetch = (async () => { throw error; }) as typeof fetch;
      const result = await testPiEndpoint(draft);
      expect(result.outcome).toBe(outcome);
      expect(result.message).toContain('Fixture Kiln');
      expect(result.message).toMatch(/check|test again/i);
      expect(JSON.stringify(result)).not.toMatch(/access-secret|kiln-secret|private\.invalid/);
      expect(connectionFailure(error)).toBe(outcome);
    }
    expect(connectionMessage('Tower', 'auth-rejected')).toMatch(/Tower.*Check/);
  });

  test('real fixture timeout is bounded', async () => {
    const { server, endpoint } = fixture(async () => { await Bun.sleep(100); return Response.json({}); });
    try { expect((await testPiEndpoint(endpoint, { timeoutMs: 10 })).outcome).toBe('timeout'); }
    finally { server.stop(true); }
  });
});

describe('authenticated WebSocket transport', () => {
  test('real TLS fixture receives separate Access headers on task and conversation streams, not query tokens', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ember-access-fixture-'));
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });

    const seen: { path: string; bearer: string | null; clientId: string | null; clientSecret: string | null; search: string }[] = [];
    let redirectTo: string | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      tls: { key: readFileSync(key), cert: readFileSync(cert) },
      fetch(request, server) {
        const url = new URL(request.url);
        seen.push({ path: url.pathname, bearer: request.headers.get('authorization'), clientId: request.headers.get('cf-access-client-id'), clientSecret: request.headers.get('cf-access-client-secret'), search: url.search });
        if (request.headers.get('authorization') !== 'Bearer kiln-secret' || request.headers.get('cf-access-client-id') !== 'access-id' || request.headers.get('cf-access-client-secret') !== 'access-secret') return new Response('denied', { status: 403 });
        if (url.pathname === '/health') return Response.json({ ok: true, service: 'hearth' });
        if (url.pathname === '/conversations') return Response.json({ conversations: [{ id: 7 }] });
        if (redirectTo) return Response.redirect(redirectTo, 302);
        if (server.upgrade(request)) return undefined;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: { open(socket) { socket.send(JSON.stringify({ type: 'view' })); }, message() {} },
    });
    // Exercise real Node + Undici (Electron's runtime), not Bun's built-in undici shim.
    const entry = join(directory, 'entry.ts');
    await Bun.write(entry, `import { PiClient } from ${JSON.stringify(join(process.cwd(), 'electron/piClient.ts'))};
      import { testPiEndpoint } from ${JSON.stringify(join(process.cwd(), 'electron/piConnection.ts'))};
      const events = [];
      const endpoint = ${JSON.stringify({ ...draft, id: 'pi:fixture', url: 'https://127.0.0.1:' + server.port })};
      const good = await testPiEndpoint(endpoint);
      const denied = await testPiEndpoint({...endpoint, access:{...endpoint.access,clientSecret:'incorrect'}});
      const bearerOnly = await testPiEndpoint({...endpoint,access:undefined});
      const client = new PiClient(event => events.push(event.type));
      await client.syncEndpoints([endpoint]);
      for(let n=0;n<100 && (!events.includes('pi:view') || !events.includes('pi:tasks'));n++) await new Promise(r=>setTimeout(r,10));
      client.closeAll();
      console.log(JSON.stringify({ events, good, denied, bearerOnly }));
    `);
    const bundled = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm', external: ['undici'] });
    expect(bundled.success).toBe(true);
    // Resolve the external dependency from this worktree without changing production defaults.
    const moduleDirectory = join(process.cwd(), 'node_modules');
    const runner = join(directory, 'runner.mjs');
    const code = (await bundled.outputs[0].text()).replace(/from ["']undici["']/g, 'from ' + JSON.stringify(join(moduleDirectory, 'undici/index.js')));
    await Bun.write(runner, code);
    try {
      const child = Bun.spawn(['node', runner], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(errors).not.toContain('Error');
      const result = JSON.parse(output.trim());
      const events = result.events as string[];
      expect(result.good.outcome).toBe('ready');
      expect(result.denied.outcome).toBe('auth-rejected');
      expect(result.bearerOnly.outcome).toBe('auth-rejected');
      const streams = seen.filter((entry) => /events|stream/.test(entry.path));
      expect(streams.map((entry) => entry.path).sort()).toEqual(['/conversations/7/events', '/tasks/stream']);
      for (const entry of streams) {
        expect(entry.bearer).toBe('Bearer kiln-secret');
        expect(entry.clientId).toBe('access-id');
        expect(entry.clientSecret).toBe('access-secret');
        expect(entry.search).toBe('');
      }
      expect(events).toContain('pi:view');
      expect(events).toContain('pi:tasks');
      let leaked = 0;
      const target = fixture(() => { leaked++; return new Response('capture'); });
      try {
        redirectTo = `${target.endpoint.url}/capture`;
        const redirected = Bun.spawn(['node', runner], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: 'pipe', stderr: 'pipe' });
        const redirectedOutput = await new Response(redirected.stdout).text();
        await new Response(redirected.stderr).text();
        expect(await redirected.exited).toBe(0);
        expect(JSON.parse(redirectedOutput).events).not.toContain('pi:view');
        expect(leaked).toBe(0);
      } finally { target.server.stop(true); }
    } finally {
      server.stop(true); rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test('WebSocket redirects do not forward bearer credentials', async () => {
    let targetCalls = 0;
    const target = fixture(() => { targetCalls++; return new Response('not a socket'); });
    const source = fixture((request) => new URL(request.url).pathname === '/conversations' ? Response.json({ conversations: [{ id: 7 }] }) : Response.redirect(`${target.endpoint.url}/capture`, 302));
    const client = new PiClient(() => {});
    try {
      await client.syncEndpoints([{ ...source.endpoint, id: 'pi:fixture' }]);
      await Bun.sleep(150);
      expect(targetCalls).toBe(0);
      expect(client.status()['pi:fixture']).not.toBe(true);
    } finally { client.closeAll(); source.server.stop(true); target.server.stop(true); }
  });
});
