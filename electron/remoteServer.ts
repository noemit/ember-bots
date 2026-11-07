import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ApiMethod } from './transport';
import type { ModelStatsStore } from './modelStats';

const REMOTE_PORT = 57821;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TAILSCALE_MIN = 0x64400000;
const TAILSCALE_MAX = 0x647fffff;
/** Plain name; the `__Host-` form below is used whenever the cookie can carry `Secure`. */
const SESSION_COOKIE = 'ember_remote_session';
const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
/**
 * Remote sessions end after 12 hours without a request, and in any case 7 days after sign-in.
 * They used to be 30 days with no renewal, so a cookie copied off a phone stayed valid for a
 * month and the only way to end it was Logout (or changing the password, which restarts the
 * listener and drops every session).
 */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

type ApiResponse = { ok: boolean; status: number; data: unknown };
type Handlers = {
  modelStats: Pick<ModelStatsStore, 'list' | 'observe' | 'clear'>;
  listInstances: (refresh?: boolean) => Promise<unknown>;
  getSettings: () => unknown;
  setSettings: (patch: unknown) => unknown;
  request: (instanceId: string, method: ApiMethod, apiPath: unknown, body?: unknown) => Promise<ApiResponse>;
  piRequest?: (endpointId: string, path: string, init?: { method?: string; body?: unknown }) => Promise<ApiResponse>;
  activityList?: (options: unknown) => Promise<unknown>;
  activitySearch?: (query: unknown, options?: unknown) => Promise<unknown>;
  activityDays?: () => Promise<unknown>;
  /** Async so a password check never blocks the main thread. */
  verifyPassword: (password: string) => boolean | Promise<boolean>;
  /** Subscribe to invalidation hints; returns an unsubscribe. */
  subscribeEvents: (listener: (event: unknown) => void) => () => void;
  /** Current live status per instance, sent first so a fresh client knows what's streaming. */
  eventStatus: () => Record<string, boolean>;
};

export type RemoteServerOptions = {
  /** Extra hostnames the listener will answer to, beyond the bound address and `*.ts.net`. */
  allowHosts?: string[];
  /** Trust `X-Forwarded-Proto: https` (a TLS-terminating proxy such as `tailscale serve`). */
  trustForwardedProto?: boolean;
};

const SSE_HEARTBEAT_MS = 25_000;
type Session = { expiresAt: number; startedAt: number; streams: Set<() => void> };
type Attempt = { count: number; resetAt: number };

/** A request failure that carries the status the client should see. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const tailscaleAddress = (): string | null => {
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const octets = entry.address.split('.').map(Number);
      const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
      if (value < TAILSCALE_MIN || value > TAILSCALE_MAX) continue;
      // Prefer the adapter Tailscale actually creates. A 100.64/10 address also shows up on
      // ISP CGNAT links, and binding that one would put this listener on the ISP-facing NIC.
      if (/tailscale/i.test(name)) return entry.address;
    }
  }
  // No adapter named like Tailscale: fall back to the range only for the address we would
  // otherwise be unable to serve, but say so through the listener state (`detail`).
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const octets = entry.address.split('.').map(Number);
      const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
      if (value >= TAILSCALE_MIN && value <= TAILSCALE_MAX) return entry.address;
    }
  }
  return null;
};

const json = (response: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
};

const readBody = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        // Stop reading, but let the response go out before the socket dies: destroying the
        // request here used to turn an oversized body into a bare connection reset.
        request.pause();
        reject(new HttpError(413, 'Request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });

const cookies = (request: http.IncomingMessage): Record<string, string> =>
  Object.fromEntries(
    (request.headers.cookie ?? '')
      .split(';')
      .map((entry) => entry.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );

const loginPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ember login</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151413;color:#efece7;font:14px system-ui,sans-serif}main{width:min(360px,calc(100% - 40px));padding:24px;border:1px solid #2c2a26;border-radius:12px;background:#1b1a18}h1{font-size:18px;margin:0 0 8px}p{color:#9b958c;font-size:12px}label{display:grid;gap:6px;margin:20px 0 12px}input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #2c2a26;border-radius:6px;background:#242220;color:inherit}button{width:100%;padding:9px;border:0;border-radius:6px;background:#efece7;color:#151413;font-weight:600}#error{color:#f07a6a;min-height:18px}</style></head>
<body><main><h1>Ember</h1><p>Enter the remote access password.</p><form><label>Password<input name="password" type="password" autocomplete="current-password" autofocus></label><div id="error"></div><button>Sign in</button></form></main>
<script>const form=document.querySelector('form'),error=document.querySelector('#error');form.addEventListener('submit',async e=>{e.preventDefault();error.textContent='';const body=JSON.stringify({password:form.password.value});const r=await fetch('/remote/login',{method:'POST',headers:{'Content-Type':'application/json'},body});if(r.ok)location.href='/';else error.textContent='Incorrect password or too many attempts.'});</script></body></html>`;

const contentType = (file: string): string => {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.json')) return 'application/json';
  return 'text/html; charset=utf-8';
};

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const assetCache = new Map<string, Buffer>();

export const acceptedEncoding = (header = ''): 'br' | 'gzip' | undefined => {
  const weights = new Map(header.toLowerCase().split(',').map((entry) => {
    const [name, ...parameters] = entry.trim().split(';');
    const q = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return [name, q ? Number(q.trim().slice(2)) : 1] as const;
  }));
  return (['br', 'gzip'] as const).filter((name) => (weights.get(name) ?? weights.get('*') ?? 0) > 0)
    .sort((a, b) => (weights.get(b) ?? weights.get('*') ?? 0) - (weights.get(a) ?? weights.get('*') ?? 0))[0];
};

export const serveStatic = async (request: http.IncomingMessage, response: http.ServerResponse, pathname: string, root: string): Promise<void> => {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return json(response, 404, { error: 'Not found' });
  try {
    const encoding = acceptedEncoding(request.headers['accept-encoding']);
    const immutable = /[.-][\w-]{8,}\.(js|css)$/.test(file);
    const key = `${file}:${encoding ?? 'identity'}`;
    let body = immutable ? assetCache.get(key) : undefined;
    if (!body) {
      const raw = await fs.promises.readFile(file);
      body = encoding === 'br' ? await compressBrotli(raw) : encoding === 'gzip' ? await compressGzip(raw) : raw;
      if (immutable && body.length <= 8 * 1024 * 1024) {
        assetCache.set(key, body);
        let bytes = [...assetCache.values()].reduce((sum, value) => sum + value.length, 0);
        for (const [oldKey, value] of assetCache) {
          if (bytes <= 8 * 1024 * 1024) break;
          assetCache.delete(oldKey);
          bytes -= value.length;
        }
      }
    }
    response.writeHead(200, {
      'Content-Type': contentType(file),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
};

const clientAddress = (request: http.IncomingMessage): string => request.socket.remoteAddress ?? 'unknown';

/** HTTPS either directly or via a TLS-terminating proxy in front of the listener. */
const isSecureRequest = (request: http.IncomingMessage, trustForwardedProto: boolean): boolean => {
  if ((request.socket as { encrypted?: boolean }).encrypted === true) return true;
  const forwarded = request.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return trustForwardedProto && typeof value === 'string' && value.split(',')[0].trim().toLowerCase() === 'https';
};

const hostnameOf = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(0, trimmed.indexOf(']') + 1);
  return trimmed.split(':')[0];
};

const portOf = (host: string): string | undefined => {
  const trimmed = host.trim();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close >= 0 && trimmed[close + 1] === ':' ? trimmed.slice(close + 2) : undefined;
  }
  const colon = trimmed.lastIndexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1) : undefined;
};

/**
 * The names this listener answers to: the address it is bound to, loopback, and any Tailscale
 * MagicDNS name. Anything else is refused, so a page served from an attacker-controlled hostname
 * that happens to resolve to this machine cannot present itself as the Ember login.
 */
export const isAllowedHost = (host: string | undefined, boundAddress: string | undefined, boundPort: number | undefined, extra: readonly string[] = []): boolean => {
  if (!host) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  const port = portOf(host);
  if (port !== undefined && boundPort !== undefined && port !== String(boundPort)) return false;
  if (extra.some((entry) => entry.toLowerCase() === host.trim().toLowerCase())) return true;
  if (boundAddress && name === boundAddress.toLowerCase()) return true;
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return true;
  return name.endsWith('.ts.net');
};

/** A state-changing request must be same-origin with the page the browser is on. */
export const isAllowedOrigin = (origin: string | undefined, host: string | undefined, secure: boolean): boolean => {
  // No Origin at all: curl, a native client, or an older browser. There is no ambient credential
  // to abuse without a browser, so the cookie itself is the control.
  if (!origin) return true;
  if (!host) return false;
  const scheme = secure ? 'https' : 'http';
  return origin === `${scheme}://${host}`;
};

export const createRemoteServer = (root: string, handlers: Handlers, options: RemoteServerOptions = {}): http.Server => {
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, Attempt>();
  const pruneExpired = (now: number) => {
    for (const [key, attempt] of attempts) {
      if (attempt.resetAt <= now) attempts.delete(key);
    }
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now || session.startedAt + SESSION_ABSOLUTE_MS <= now) {
        revoke(token);
      }
    }
  };
  const revoke = (token: string | undefined) => {
    if (!token) return;
    const session = sessions.get(token);
    sessions.delete(token);
    if (session) [...session.streams].forEach((close) => close());
  };
  const server = http.createServer(async (request, response) => {
    try {
      const bound = server.address();
      const boundAddress = bound && typeof bound === 'object' ? bound.address : undefined;
      const boundPort = bound && typeof bound === 'object' ? bound.port : undefined;
      if (!isAllowedHost(request.headers.host, boundAddress, boundPort, options.allowHosts)) {
        return json(response, 400, { error: 'Unexpected host' });
      }
      const secure = isSecureRequest(request, options.trustForwardedProto === true);
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD' &&
          !isAllowedOrigin(request.headers.origin, request.headers.host, secure)) {
        return json(response, 403, { error: 'Cross-origin request refused' });
      }
      const now = Date.now();
      pruneExpired(now);
      if (url.pathname === '/remote/login' && request.method === 'POST') {
        const source = clientAddress(request);
        const attempt = attempts.get(source);
        if (attempt && attempt.resetAt > now && attempt.count >= MAX_LOGIN_ATTEMPTS) {
          response.setHeader('Retry-After', String(Math.ceil((attempt.resetAt - now) / 1000)));
          return json(response, 429, { error: 'Too many login attempts' });
        }
        const input = await readBody(request);
        const password = input && typeof input === 'object' ? String((input as Record<string, unknown>).password ?? '') : '';
        if (!(await handlers.verifyPassword(password))) {
          const next = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
          next.count += 1;
          attempts.set(source, next);
          return json(response, 401, { error: 'Invalid password' });
        }
        attempts.delete(source);
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, { expiresAt: now + SESSION_IDLE_MS, startedAt: now, streams: new Set() });
        const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
        const flags = [`${name}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
          `Max-Age=${SESSION_ABSOLUTE_MS / 1000}`, ...(secure ? ['Secure'] : [])];
        response.setHeader('Set-Cookie', flags.join('; '));
        return json(response, 200, { ok: true });
      }

      const jar = cookies(request);
      const token = jar[SECURE_SESSION_COOKIE] ?? jar[SESSION_COOKIE];
      const session = token ? sessions.get(token) : undefined;
      const authenticated = Boolean(session && session.expiresAt > now && session.startedAt + SESSION_ABSOLUTE_MS > now);
      if (session && authenticated) {
        // Sliding idle window, capped by the absolute lifetime set at sign-in.
        session.expiresAt = Math.min(now + SESSION_IDLE_MS, session.startedAt + SESSION_ABSOLUTE_MS);
      } else if (session) {
        revoke(token);
      }
      if (!authenticated) {
        const streaming = String(request.headers.accept ?? '').includes('text/event-stream');
        if (streaming) {
          // An EventSource cannot show a login page; a 302 hands it HTML it fails to parse and
          // then it retries forever. A JSON 401 is a fact the client can act on.
          return json(response, 401, { error: 'Session expired', code: 'session-expired' });
        }
        if (url.pathname === '/remote/login' && request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(loginPage());
        } else if (request.method === 'GET' || request.method === 'HEAD') {
          response.writeHead(302, { Location: '/remote/login' });
          response.end();
        } else {
          json(response, 401, { error: 'Authentication required', code: 'session-expired' });
        }
        return;
      }

      if (url.pathname === '/remote/logout' && request.method === 'POST') {
        revoke(token);
        response.setHeader('Set-Cookie', [
          `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
          `${SECURE_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`,
        ]);
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/remote/model-stats') {
        if (request.method === 'GET') return json(response, 200, await handlers.modelStats.list());
        if (request.method === 'POST') return json(response, 200, await handlers.modelStats.observe(await readBody(request)));
        if (request.method === 'DELETE') { await handlers.modelStats.clear(); return json(response, 200, { ok: true }); }
      }
      if (url.pathname === '/remote/instances' && request.method === 'GET') return json(response, 200, await handlers.listInstances(url.searchParams.get('refresh') !== 'false'));
      if (url.pathname === '/remote/settings' && request.method === 'GET') return json(response, 200, handlers.getSettings());
      if (url.pathname === '/remote/settings' && request.method === 'POST') return json(response, 200, await handlers.setSettings(await readBody(request)));
      if (url.pathname === '/remote/events' && request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        });
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let unsubscribe = () => {};
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          session?.streams.delete(cleanup);
          response.end();
        };
        const active = () => Boolean(token && session && sessions.get(token) === session && session.expiresAt > Date.now());
        const write = (event: unknown) => {
          if (closed) return;
          if (!active()) { revoke(token); cleanup(); return; }
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        session?.streams.add(cleanup);
        request.on('close', cleanup);
        response.on('close', cleanup);
        response.on('error', cleanup);
        Object.entries(handlers.eventStatus()).forEach(([instanceId, connected]) =>
          write({ instanceId, type: 'ember:stream-status', connected })
        );
        if (!closed) {
          unsubscribe = handlers.subscribeEvents(write);
          if (closed) unsubscribe();
          else heartbeat = setInterval(() => {
            if (!active()) { revoke(token); cleanup(); }
            else response.write(':heartbeat\n\n');
          }, SSE_HEARTBEAT_MS);
        }
        return;
      }
      if (url.pathname === '/remote/api' && request.method === 'POST') {
        const input = await readBody(request);
        if (!input || typeof input !== 'object') return json(response, 400, { error: 'Invalid request' });
        const value = input as Record<string, unknown>;
        const method = typeof value.method === 'string' ? value.method.toUpperCase() : '';
        if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return json(response, 400, { error: 'Invalid API method' });
        return json(response, 200, await handlers.request(String(value.instanceId ?? ''), method as ApiMethod, value.path, value.body));
      }
      if (url.pathname === '/remote/pi' && request.method === 'POST') {
        if (!handlers.piRequest) return json(response, 501, { error: 'Pi proxy not implemented' });
        const input = await readBody(request);
        if (!input || typeof input !== 'object') return json(response, 400, { error: 'Invalid request' });
        const value = input as Record<string, unknown>;
        const endpointId = typeof value.endpointId === 'string' ? value.endpointId : '';
        const path = typeof value.path === 'string' ? value.path : '';
        if (!endpointId || !path.startsWith('/')) return json(response, 400, { error: 'Invalid request' });
        if (new URL(path, 'http://localhost').pathname.startsWith('/alignment')) return json(response, 403, { error: 'Align instances from the desktop app, where connection credentials stay private.' });
        const init = value.init && typeof value.init === 'object' ? (value.init as { method?: string; body?: unknown }) : undefined;
        return json(response, 200, await handlers.piRequest(endpointId, path, init));
      }
      if (url.pathname === '/remote/events/status' && request.method === 'GET') {
        return json(response, 200, handlers.eventStatus());
      }
      if (url.pathname === '/remote/activity/list' && request.method === 'POST') {
        if (!handlers.activityList) return json(response, 501, { error: 'Activity log not implemented' });
        const input = await readBody(request);
        return json(response, 200, await handlers.activityList(input));
      }
      if (url.pathname === '/remote/activity/search' && request.method === 'POST') {
        if (!handlers.activitySearch) return json(response, 501, { error: 'Activity log not implemented' });
        const input = (await readBody(request)) as { query?: unknown; range?: unknown } | null;
        return json(response, 200, await handlers.activitySearch(input?.query, input?.range));
      }
      if (url.pathname === '/remote/activity/days' && request.method === 'GET') {
        if (!handlers.activityDays) return json(response, 501, { error: 'Activity log not implemented' });
        return json(response, 200, await handlers.activityDays());
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
      return serveStatic(request, response, url.pathname, root);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(response, error.status, { error: error.message }, error.status === 413 ? { Connection: 'close' } : {});
      }
      json(response, 400, { error: error instanceof Error ? error.message : 'Bad request' });
    }
  });

  server.on('error', (error) => console.error('Remote Ember server error', error));
  return server;
};

export type StartRemoteServerResult =
  | { server: http.Server; address: string; warning?: string }
  | { server: null; reason: 'no-tailscale' };

export const startRemoteServer = (root: string, handlers: Handlers, options: RemoteServerOptions = {}): StartRemoteServerResult => {
  const address = tailscaleAddress();
  if (!address) {
    console.warn('Remote Ember access disabled: no Tailscale IPv4 address found');
    return { server: null, reason: 'no-tailscale' };
  }
  const server = createRemoteServer(root, handlers, options);
  server.listen(REMOTE_PORT, address, () => console.log(`Remote Ember access: http://${address}:${REMOTE_PORT}`));
  return { server, address };
};

export { REMOTE_PORT, SESSION_COOKIE, SECURE_SESSION_COOKIE, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS };
