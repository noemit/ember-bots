import type { PiEndpoint } from './transport';
import { readConnectionJson } from './connectionJson';
import { canonicalizePiPath, desktopOnlyPiRouteError, resolvePiUrl, type CanonicalPiPath } from './piPath';

export { canonicalizePiPath, desktopOnlyPiRouteError, resolvePiUrl, type CanonicalPiPath };

export type PiConnectionDraft = Pick<PiEndpoint, 'label' | 'url' | 'token'> & {
  access?: { clientId: string; clientSecret: string };
  hasAccessSecret?: boolean;
};
export type PiConnectionOutcome = 'ready' | 'unreachable' | 'auth-rejected' | 'wrong-service' | 'tls-error' | 'timeout';
export type PiConnectionTest = {
  outcome: PiConnectionOutcome;
  authLayer?: 'access' | 'kiln' | 'gateway';
  host: string;
  message: string;
  version?: string;
  commit?: string;
};

/** Shared by REST and WebSocket handshakes. Never put either credential in a URL. */
class ConnectionConfigurationError extends Error {
  constructor(readonly outcome: PiConnectionOutcome) { super('Connection configuration needs review'); }
}

export const piConnectionHeaders = (endpoint: PiConnectionDraft): Record<string, string> => {
  const url = new URL(endpoint.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ConnectionConfigurationError('wrong-service');
  if (endpoint.hasAccessSecret && !endpoint.access) throw new ConnectionConfigurationError('auth-rejected');
  if (endpoint.access) {
    // Access service tokens are a separate trust boundary, never plaintext transport.
    if (url.protocol !== 'https:') throw new ConnectionConfigurationError('tls-error');
    if (!endpoint.access.clientId?.trim() || !endpoint.access.clientSecret?.trim()) throw new ConnectionConfigurationError('auth-rejected');
  }
  if (!endpoint.token.trim() || /[\r\n]/.test(endpoint.token) || /[\r\n]/.test(endpoint.access?.clientId ?? '') || /[\r\n]/.test(endpoint.access?.clientSecret ?? '')) throw new ConnectionConfigurationError('auth-rejected');
  return {
    authorization: `Bearer ${endpoint.token}`,
    ...(endpoint.access ? {
      'CF-Access-Client-Id': endpoint.access.clientId,
      'CF-Access-Client-Secret': endpoint.access.clientSecret,
    } : {}),
  };
};

/** Keep arbitrary response bodies, URLs and native error messages out of diagnostics. */
export const connectionFailure = (error: unknown): PiConnectionOutcome => {
  if (error instanceof ConnectionConfigurationError) return error.outcome;
  const codes: string[] = [];
  let cursor = error;
  for (let depth = 0; depth < 5 && cursor && typeof cursor === 'object'; depth++) {
    const value = cursor as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    codes.push(String(value.name ?? ''), String(value.code ?? ''), String(value.message ?? ''));
    cursor = value.cause;
  }
  const diagnostic = codes.join(' ');
  if (/TimeoutError|AbortError|ETIMEDOUT|CONNECT_TIMEOUT/i.test(diagnostic)) return 'timeout';
  if (/CERT_|CERTIFICATE|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(diagnostic)) return 'tls-error';
  if (/redirect/i.test(diagnostic)) return 'wrong-service';
  return 'unreachable';
};

export const connectionMessage = (host: string, outcome: PiConnectionOutcome, authLayer?: PiConnectionTest['authLayer']): string => {
  if (outcome === 'auth-rejected' && authLayer === 'access') return host + '’s Cloudflare Access gate needs service-token authentication. Check Advanced and the host’s Access policy, then test again.';
  if (outcome === 'auth-rejected' && authLayer === 'kiln') return host + '’s Kiln rejected the bearer token. Copy its current Kiln token from the host, then test again.';
  switch (outcome) {
    case 'ready': return `${host} answered as Kiln and its authenticated conversation route is ready.`;
    case 'auth-rejected': return `${host} rejected the connection credentials. Check the Kiln bearer token and, if used, both Cloudflare Access credentials, then test again.`;
    case 'wrong-service': return `${host} did not answer as a ready Kiln service. Check the server address and any proxy or Access setup, then test again. Redirects are not followed.`;
    case 'tls-error': return `${host}'s secure connection could not be verified. Use HTTPS for Cloudflare Access, check the server certificate and your computer's clock, then test again.`;
    case 'timeout': return `${host} did not answer before the connection test timed out. Check that Kiln is running and reachable, then test again.`;
    case 'unreachable': return `Ember could not connect to ${host}. Check the server address, network and that Kiln is running, then test again.`;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A 200 page is not proof of Kiln: verify its health identity AND an authenticated route. */
export const testPiEndpoint = async (
  endpoint: PiConnectionDraft,
  options: { timeoutMs?: number; request?: typeof fetch } = {}
): Promise<PiConnectionTest> => {
  // A label is user-authored, never derive it from a credential-bearing URL.
  const host = endpoint.label.trim().slice(0, 160) || 'This Kiln';
  const result = (outcome: PiConnectionOutcome, authLayer?: PiConnectionTest['authLayer']): PiConnectionTest => ({ outcome, host, ...(authLayer ? { authLayer } : {}), message: connectionMessage(host, outcome, authLayer) });
  try {
    const base = new URL(endpoint.url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return result('wrong-service');
    const headers = piConnectionHeaders(endpoint);
    const request = options.request ?? fetch;
    const timeout = options.timeoutMs ?? 4_000;
    const deadline = Date.now() + timeout;
    const signal = AbortSignal.timeout(timeout);
    const read = async (path: string): Promise<{ outcome?: PiConnectionOutcome; authLayer?: PiConnectionTest['authLayer']; body?: unknown }> => {
      const targetUrl = resolvePiUrl(endpoint.url, path);
      if (!targetUrl) return { outcome: 'wrong-service' };
      const response = await request(targetUrl.toString(), { headers, redirect: 'manual', signal });
      const location = response.headers.get('location') ?? '';
      if (response.headers.has('cf-access-domain') || /\/cdn-cgi\/access\/|cloudflareaccess\.com/i.test(location)) {
        void response.body?.cancel().catch(() => {});
        return { outcome: 'auth-rejected', authLayer: 'access' };
      }
      if (response.status === 401 || response.status === 403) {
        let authLayer: PiConnectionTest['authLayer'] = 'gateway';
        if (response.headers.get('content-type')?.includes('json')) {
          const body = await readConnectionJson(response, 16 * 1024, Math.max(1, deadline - Date.now())).catch(() => null) as { error?: unknown } | null;
          if (body?.error === 'unauthorized') authLayer = 'kiln';
        } else void response.body?.cancel().catch(() => {});
        return { outcome: 'auth-rejected', authLayer };
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { outcome: 'wrong-service' }; }
      try { return { body: await readConnectionJson(response, 1024 * 1024, Math.max(1, deadline - Date.now())) }; }
      catch (error) { return { outcome: connectionFailure(error) === 'timeout' ? 'timeout' : 'wrong-service' }; }
    };
    const [health, ready] = await Promise.all([read('/health'), read('/conversations?limit=1')]);
    if (health.outcome) return result(health.outcome, health.authLayer);
    if (!isRecord(health.body) || health.body.ok !== true || !['hearth', 'kiln'].includes(String(health.body.service))) return result('wrong-service');
    if (ready.outcome) return result(ready.outcome, ready.authLayer);
    if (!isRecord(ready.body) || !Array.isArray(ready.body.conversations)) return result('wrong-service');
    // Only bounded build identifiers are allowed out of the health response.
    const secrets = [endpoint.token, endpoint.access?.clientId, endpoint.access?.clientSecret].filter((value): value is string => Boolean(value));
    const build = (value: unknown, pattern: RegExp): string | undefined => typeof value === 'string' && value.length <= 80 && pattern.test(value) && !secrets.some((secret) => value.includes(secret)) ? value : undefined;
    return {
      ...result('ready'),
      version: build(health.body.version, /^\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?$/),
      commit: build(health.body.commit, /^[0-9a-f]{7,40}$/i),
    };
  } catch (error) {
    return result(connectionFailure(error));
  }
};
