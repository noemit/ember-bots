import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ApiMethod } from './transport';
import type { ModelStatsStore } from './modelStats';
import { canonicalizePiPath, desktopOnlyPiRouteError } from './piPath';
import { isLoopbackPeer, isTrustedHttpsProxy, parseRemoteProxyOrigin, remoteBindAddress } from './remoteProxy';

const REMOTE_PORT = 57821;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_LOGIN_BODY_BYTES = 4096;
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
const MAX_LOGIN_VERIFY_IN_FLIGHT = 2;
const MAX_LOGIN_VERIFY_QUEUE = 4;
const DEFAULT_FAILED_LOGIN_DELAY_MS = 250;
const MAX_TRACKED_ATTEMPTS = 2048;
const MAX_ACTIVE_SESSIONS = 2048;

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

const STATIC_HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

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
  /** External HTTPS origin. Enables a loopback-only listener and exact proxy request validation. */
  proxyOrigin?: string;
  /** Pause applied after a failed password verification to throttle forwarded-IP scanning (default 250ms). */
  failedLoginDelayMs?: number;
  /** Maximum tracked login-attempt buckets and active sessions before evicting oldest entries (default 2048). */
  maxTrackedAttempts?: number;
  maxSessions?: number;
};

const SSE_HEARTBEAT_MS = 25_000;
type Session = { secure: boolean; expiresAt: number; startedAt: number; streams: Set<() => void> };
type Attempt = { count: number; inFlight: number; resetAt: number };

let verifyInFlight = 0;
const verifyWaiters: Array<() => void> = [];

const acquireVerifySlot = (): Promise<boolean> => {
  if (verifyInFlight < MAX_LOGIN_VERIFY_IN_FLIGHT) {
    verifyInFlight += 1;
    return Promise.resolve(true);
  }
  if (verifyWaiters.length >= MAX_LOGIN_VERIFY_QUEUE) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    verifyWaiters.push(() => {
      verifyInFlight += 1;
      resolve(true);
    });
  });
};

const releaseVerifySlot = (): void => {
  verifyInFlight = Math.max(0, verifyInFlight - 1);
  const next = verifyWaiters.shift();
  if (next) next();
};

/** A request failure that carries the status the client should see. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isTailscaleRangeIpv4 = (address: string): boolean => {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return value >= TAILSCALE_MIN && value <= TAILSCALE_MAX;
};

const queryLocalTailscaleDaemonIp = (): string | null => {
  const candidates =
    process.platform === 'darwin'
      ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
      : ['tailscale'];
  for (const bin of candidates) {
    try {
      const stdout = execFileSync(bin, ['ip', '-4'], {
        encoding: 'utf8',
        timeout: 1_500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => isTailscaleRangeIpv4(line));
      if (first) return first;
    } catch {
      // Try next candidate or fail closed below.
    }
  }
  return null;
};

/**
 * Resolve the local Tailscale IPv4 address only when the local Tailscale daemon confirms it and
 * the address is present on an active non-internal network interface. Never falls back to an
 * unverified `100.64.0.0/10` CGNAT/VPN adapter.
 */
export const resolveVerifiedTailscaleAddress = (deps?: {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  readDaemonIp?: () => string | null;
}): string | null => {
  const daemonIp = (deps?.readDaemonIp ?? queryLocalTailscaleDaemonIp)()?.trim() ?? null;
  if (!daemonIp || !isTailscaleRangeIpv4(daemonIp)) return null;
  const ifaces = deps?.interfaces ?? os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address === daemonIp) return daemonIp;
    }
  }
  return null;
};

const tailscaleAddress = (): string | null => resolveVerifiedTailscaleAddress();

const json = (response: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
};

const readBody = (request: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
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

const LOGIN_SCRIPT = `const form=document.querySelector('form'),error=document.querySelector('#error'),button=form.querySelector('button');form.addEventListener('submit',async e=>{e.preventDefault();error.textContent='Signing in to Ember…';button.disabled=true;try{const body=JSON.stringify({password:form.password.value});const r=await fetch('/remote/login',{method:'POST',headers:{'Content-Type':'application/json'},body,cache:'no-store'});if(r.ok)location.href='/';else error.textContent=r.status===429?'Ember is pausing sign-in attempts. Wait a few minutes, then try Sign in again.':r.status===401?'Ember did not accept that password. Check the password set on the Ember computer, then try Sign in again.':'Ember could not sign you in. Check that the desktop app is running, then try Sign in again.';}catch{error.textContent='The Ember computer did not answer. Check your private connection and that Ember is running, then try Sign in again.';}finally{button.disabled=false;}});`;
const LOGIN_SCRIPT_HASH = createHash('sha256').update(LOGIN_SCRIPT, 'utf8').digest('base64');
const LOGIN_PAGE_CSP = `default-src 'self'; script-src 'self' 'sha256-${LOGIN_SCRIPT_HASH}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`;

const loginPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#151413"><title>Ember login</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151413;color:#efece7;font:14px system-ui,sans-serif}main{width:min(360px,calc(100% - 40px));padding:24px;border:1px solid #2c2a26;border-radius:12px;background:#1b1a18}h1{font-size:18px;margin:0 0 8px}p{color:#9b958c;font-size:12px}label{display:grid;gap:6px;margin:20px 0 12px}input{box-sizing:border-box;width:100%;min-height:44px;font-size:16px;padding:9px 10px;border:1px solid #2c2a26;border-radius:6px;background:#242220;color:inherit}button{width:100%;min-height:44px;padding:9px;border:0;border-radius:6px;background:#efece7;color:#151413;font-weight:600}#error{color:#f07a6a;min-height:18px}</style></head>
<body><main><h1>Ember</h1><p>Enter the remote access password.</p><form><label>Password<input name="password" type="password" autocomplete="current-password" autofocus></label><div id="error" role="status" aria-live="polite"></div><button>Sign in</button></form></main>
<script>${LOGIN_SCRIPT}</script></body></html>`;

const contentType = (file: string): string => {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.webmanifest')) return 'application/manifest+json';
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
    const type = contentType(file);
    const isHtml = type.startsWith('text/html');
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      ...SECURITY_HEADERS,
      ...(isHtml ? { 'Content-Security-Policy': STATIC_HTML_CSP } : {}),
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
};

const hasWhitespaceOrControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
};

const firstForwardedClient = (header: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]?.trim().toLowerCase();
  if (!first || first.length > 128 || hasWhitespaceOrControl(first)) return undefined;
  return first;
};

const loginClientKey = (request: http.IncomingMessage, trustedProxy: boolean): string => {
  if (trustedProxy && isLoopbackPeer(request.socket.remoteAddress)) {
    const forwarded =
      firstForwardedClient(request.headers['x-forwarded-for']) ??
      firstForwardedClient(request.headers['cf-connecting-ip']);
    if (forwarded) return `forwarded:${forwarded}`;
  }
  return `peer:${request.socket.remoteAddress ?? 'unknown'}`;
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
export const isAllowedHost = (host: string | undefined, boundAddress: string | undefined, boundPort: number | undefined): boolean => {
  if (!host) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  const port = portOf(host);
  if (port !== undefined && boundPort !== undefined && port !== String(boundPort)) return false;
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

export type RemoteHttpServer = http.Server & { revokeRemoteSessions: () => void };

export const createRemoteServer = (root: string, handlers: Handlers, options: RemoteServerOptions = {}): RemoteHttpServer => {
  const proxyOrigin = parseRemoteProxyOrigin(options.proxyOrigin);
  const failedLoginDelayMs = Math.max(0, options.failedLoginDelayMs ?? DEFAULT_FAILED_LOGIN_DELAY_MS);
  const maxTrackedAttempts = Math.max(1, options.maxTrackedAttempts ?? MAX_TRACKED_ATTEMPTS);
  const maxSessions = Math.max(1, options.maxSessions ?? MAX_ACTIVE_SESSIONS);
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, Attempt>();
  const pruneExpired = (now: number) => {
    for (const [key, attempt] of attempts) {
      if (attempt.resetAt <= now && attempt.inFlight <= 0) attempts.delete(key);
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
  const setAttempt = (key: string, attempt: Attempt, now: number) => {
    attempts.delete(key);
    attempts.set(key, attempt);
    if (attempts.size <= maxTrackedAttempts) return;
    pruneExpired(now);
    if (attempts.size <= maxTrackedAttempts) return;
    for (const [oldestKey, oldestAttempt] of attempts) {
      if (attempts.size <= maxTrackedAttempts) break;
      if (oldestKey === key || oldestAttempt.inFlight > 0) continue;
      attempts.delete(oldestKey);
    }
    for (const oldestKey of attempts.keys()) {
      if (attempts.size <= maxTrackedAttempts) break;
      if (oldestKey === key) continue;
      attempts.delete(oldestKey);
    }
  };
  const setSession = (token: string, session: Session, now: number) => {
    sessions.delete(token);
    sessions.set(token, session);
    if (sessions.size <= maxSessions) return;
    pruneExpired(now);
    for (const oldestToken of sessions.keys()) {
      if (sessions.size <= maxSessions) break;
      if (oldestToken === token) continue;
      revoke(oldestToken);
    }
  };
  const server = http.createServer(async (request, response) => {
    try {
      const bound = server.address();
      const boundAddress = bound && typeof bound === 'object' ? bound.address : undefined;
      const boundPort = bound && typeof bound === 'object' ? bound.port : undefined;
      // Proxy mode is an explicit, separate exposure: neither Host nor forwarding headers alone
      // can opt a direct client into HTTPS trust. The production socket is loopback-only too.
      const trustedProxy = Boolean(proxyOrigin && isTrustedHttpsProxy(proxyOrigin,
        request.socket.remoteAddress, request.headers.host, request.headers['x-forwarded-proto']));
      if (proxyOrigin ? !trustedProxy : !isAllowedHost(request.headers.host, boundAddress, boundPort)) {
        return json(response, 400, { error: 'Ember did not recognize this browser address. Check the desktop remote-access address and your proxy configuration.' });
      }
      const secure = trustedProxy || (request.socket as { encrypted?: boolean }).encrypted === true;
      const url = new URL(request.url ?? '/', 'http://localhost');
      const allowedOrigin = proxyOrigin
        ? !request.headers.origin || request.headers.origin === proxyOrigin
        : isAllowedOrigin(request.headers.origin, request.headers.host, secure);
      // Fetch Metadata covers cross-site GETs too. Origin is validated against configuration in
      // proxy mode, never an attacker-supplied X-Forwarded-Host or Forwarded header.
      if (request.headers['sec-fetch-site'] === 'cross-site' || !allowedOrigin) {
        return json(response, 403, { error: 'Ember refused a request from another website. Open your saved Ember address and try again.' });
      }
      response.setHeader('Cache-Control', 'no-store');
      const now = Date.now();
      pruneExpired(now);
      if (url.pathname === '/remote/login' && request.method === 'POST') {
        const source = loginClientKey(request, trustedProxy);
        const current = attempts.get(source);
        const reserved = current && current.resetAt > now
          ? current
          : { count: 0, inFlight: 0, resetAt: now + LOGIN_WINDOW_MS };
        if (reserved.count + reserved.inFlight >= MAX_LOGIN_ATTEMPTS) {
          response.setHeader('Retry-After', String(Math.max(1, Math.ceil((reserved.resetAt - now) / 1000))));
          return json(response, 429, { error: 'Too many login attempts' });
        }
        reserved.inFlight += 1;
        setAttempt(source, reserved, now);
        let reservationReleased = false;
        try {
          const input = await readBody(request, MAX_LOGIN_BODY_BYTES);
          const password = input && typeof input === 'object' ? String((input as Record<string, unknown>).password ?? '') : '';
          const acquired = await acquireVerifySlot();
          if (!acquired) {
            response.setHeader('Retry-After', '2');
            return json(response, 429, { error: 'Too many login attempts' });
          }
          try {
            const checkAt = Date.now();
            const activeAttempt = attempts.get(source);
            if (activeAttempt && activeAttempt.resetAt > checkAt && activeAttempt.count >= MAX_LOGIN_ATTEMPTS) {
              response.setHeader('Retry-After', String(Math.max(1, Math.ceil((activeAttempt.resetAt - checkAt) / 1000))));
              return json(response, 429, { error: 'Too many login attempts' });
            }
            const valid = await handlers.verifyPassword(password);
            const finishedAt = Date.now();
            reservationReleased = true;
            reserved.inFlight = Math.max(0, reserved.inFlight - 1);
            if (!valid) {
              const latest = attempts.get(source);
              const target = latest && latest.resetAt > finishedAt
                ? latest
                : { count: 0, inFlight: latest === reserved ? reserved.inFlight : 0, resetAt: finishedAt + LOGIN_WINDOW_MS };
              target.count += 1;
              setAttempt(source, target, finishedAt);
              if (failedLoginDelayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, failedLoginDelayMs));
              }
              return json(response, 401, { error: 'Invalid password' });
            }
            attempts.delete(source);
            const token = randomBytes(32).toString('base64url');
            setSession(token, { secure, expiresAt: finishedAt + SESSION_IDLE_MS, startedAt: finishedAt, streams: new Set() }, finishedAt);
            const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
            const flags = [`${name}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
              `Max-Age=${SESSION_ABSOLUTE_MS / 1000}`, ...(secure ? ['Secure'] : [])];
            response.setHeader('Set-Cookie', flags.join('; '));
            return json(response, 200, { ok: true });
          } finally {
            releaseVerifySlot();
          }
        } finally {
          if (!reservationReleased) {
            reserved.inFlight = Math.max(0, reserved.inFlight - 1);
            if (reserved.count === 0 && reserved.inFlight === 0 && attempts.get(source) === reserved) {
              attempts.delete(source);
            }
          }
        }
      }

      const jar = cookies(request);
      const token = jar[secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE];
      const session = token ? sessions.get(token) : undefined;
      const authenticated = Boolean(session && session.secure === secure && session.expiresAt > now && session.startedAt + SESSION_ABSOLUTE_MS > now);
      if (session && authenticated && token) {
        // Sliding idle window, capped by the absolute lifetime set at sign-in.
        session.expiresAt = Math.min(now + SESSION_IDLE_MS, session.startedAt + SESSION_ABSOLUTE_MS);
        sessions.delete(token);
        sessions.set(token, session);
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
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
            'Content-Security-Policy': LOGIN_PAGE_CSP,
          });
          response.end(loginPage());
        } else if (request.method === 'GET' || request.method === 'HEAD') {
          response.writeHead(302, {
            Location: '/remote/login',
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          });
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
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...SECURITY_HEADERS,
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
        const active = () => Boolean(token && session && sessions.get(token) === session && session.expiresAt > Date.now() && session.startedAt + SESSION_ABSOLUTE_MS > Date.now());
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
        const rawPath = typeof value.path === 'string' ? value.path : '';
        if (!endpointId || !rawPath.startsWith('/')) return json(response, 400, { error: 'Invalid request' });
        const desktopOnlyError = desktopOnlyPiRouteError(rawPath);
        if (desktopOnlyError) return json(response, 403, { error: desktopOnlyError });
        const canonical = canonicalizePiPath(rawPath);
        if (!canonical) return json(response, 400, { error: 'Invalid request' });
        const init = value.init && typeof value.init === 'object' ? (value.init as { method?: string; body?: unknown }) : undefined;
        return json(response, 200, await handlers.piRequest(endpointId, canonical.path, init));
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
  // End SSE responses explicitly before closing sockets. Node-compatible runtimes do not all
  // close streaming responses with closeAllConnections alone, and expiry is not a shutdown hook.
  return Object.assign(server, {
    revokeRemoteSessions: () => { for (const token of sessions.keys()) revoke(token); },
  });
};

export type StartRemoteServerResult =
  | { server: http.Server; address: string; warning?: string }
  | { server: null; reason: 'no-tailscale' };

export const startRemoteServer = (root: string, handlers: Handlers, options: RemoteServerOptions = {}): StartRemoteServerResult => {
  const address = remoteBindAddress(options.proxyOrigin, tailscaleAddress);
  if (!address) {
    console.warn('Remote Ember access disabled: no Tailscale IPv4 address found');
    return { server: null, reason: 'no-tailscale' };
  }
  const server = createRemoteServer(root, handlers, options);
  server.listen(REMOTE_PORT, address, () => console.log('Remote Ember access:', options.proxyOrigin ?? `http://${address}:${REMOTE_PORT}`));
  return { server, address };
};

export {
  REMOTE_PORT,
  MAX_BODY_BYTES,
  MAX_LOGIN_BODY_BYTES,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_WINDOW_MS,
  MAX_LOGIN_VERIFY_IN_FLIGHT,
  MAX_LOGIN_VERIFY_QUEUE,
  DEFAULT_FAILED_LOGIN_DELAY_MS,
  MAX_TRACKED_ATTEMPTS,
  MAX_ACTIVE_SESSIONS,
  SESSION_COOKIE,
  SECURE_SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
};
