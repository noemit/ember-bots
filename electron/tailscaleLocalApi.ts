import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { discoverMacDaemonProof, type MacDaemonProof } from './tailscaleMacDiscovery';
import { LocalApiError } from './tailscaleLocalApiError';
export { LocalApiError } from './tailscaleLocalApiError';
export type { LocalApiErrorKind } from './tailscaleLocalApiError';

export type ServeConfig = Record<string, unknown>;
export type ServeSnapshot = { config: ServeConfig; etag: string };
export type LocalApiResponse = { status: number; etag?: string; body: string };
export type LocalApiTransport = (method: 'GET' | 'POST', endpoint: string, body?: string, etag?: string) => Promise<LocalApiResponse>;
export interface AtomicServeApi {
  read(): Promise<ServeSnapshot>;
  status(): Promise<{ nodeId: string; ip: string }>;
  compareAndSwap(snapshot: ServeSnapshot, next: ServeConfig): Promise<void>;
}
const CONFIG_PATH = '/localapi/v0/serve-config';
const STATUS_PATH = '/localapi/v0/status?peers=false';
const MAX_BYTES = 512 * 1024;
const ETAG = /^[a-f0-9]{64}$/;
export function isTailnetAddress(value: string): boolean {
  if (isIP(value) === 4) { const parts = value.split('.').map(Number); return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127; }
  return isIP(value) === 6 && !value.includes('%') && new URL('http://[' + value + ']').hostname.startsWith('[fd7a:115c:a1e0:');
}
export const configDigest = (body: string): string => createHash('sha256').update(body).digest('hex');

/** Fixed Unix endpoints. Mac GUI proxy auth uses only official same-user proof discovery. */
export function localApiSocket(platform: NodeJS.Platform): string {
  if (platform === 'linux') return '/var/run/tailscale/tailscaled.sock';
  if (platform === 'darwin') return '/var/run/tailscaled.socket';
  // Tailscale requests identification-level pipe access. Node's native pipe equivalence
  // is not verified, so Windows cannot substitute a broader-privilege native pipe connection.
  throw new LocalApiError('unsupported');
}

/** Exported transport seam is exercised only against disposable Unix test sockets. */
export function unixLocalApiTransport(socketPath: string, timeoutMs = 8_000): LocalApiTransport {
  return localHttpTransport({ socketPath }, timeoutMs);
}

/** Auth is scoped to a literal loopback connection and never exported or logged. */
export function macLocalApiTransport(proof: MacDaemonProof, timeoutMs = 8_000): LocalApiTransport {
  if (!Number.isSafeInteger(proof.port) || proof.port < 1 || proof.port > 65535 || !/^[a-f0-9]{10,256}$/i.test(proof.token)) throw new LocalApiError('invalid');
  return localHttpTransport({ port: proof.port, token: proof.token }, timeoutMs);
}
function localHttpTransport(connection: { socketPath: string } | { port: number; token: string }, timeoutMs: number): LocalApiTransport {
  return (method, endpoint, body, etag) => new Promise((resolve, reject) => {
    if (![CONFIG_PATH, STATUS_PATH].includes(endpoint) || (method === 'POST' && endpoint !== CONFIG_PATH)
      || (method === 'POST' && (!etag || !ETAG.test(etag))) || (body && Buffer.byteLength(body) > MAX_BYTES)) {
      reject(new LocalApiError('invalid')); return;
    }
    const request = http.request({
      ...('socketPath' in connection ? { socketPath: connection.socketPath, hostname: 'local-tailscaled.sock' } : { hostname: '127.0.0.1', port: connection.port }),
      path: endpoint, method, agent: false,
      headers: { ...('token' in connection ? { host: 'local-tailscaled.sock', authorization: 'Basic ' + Buffer.from(':' + connection.token).toString('base64') } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { request.destroy(); response.destroy(); reject(new LocalApiError('invalid')); }
        else chunks.push(chunk);
      });
      response.on('error', () => { clearTimeout(timer); reject(new LocalApiError('unavailable')); });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, etag: typeof response.headers.etag === 'string' ? response.headers.etag : undefined, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const timer = setTimeout(() => { request.destroy(); reject(new LocalApiError('timeout')); }, timeoutMs);
    timer.unref?.();
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new LocalApiError(error.code === 'EACCES' || error.code === 'EPERM' ? 'permission' : 'unavailable'));
    });
    request.end(body);
  });
}

export class TailscaleLocalApi implements AtomicServeApi {
  constructor(private readonly transport: LocalApiTransport) {}
  private async call(method: 'GET' | 'POST', endpoint: string, body?: string, etag?: string): Promise<LocalApiResponse> {
    const response = await this.transport(method, endpoint, body, etag);
    if (response.status === 412) throw new LocalApiError('conflict');
    if (response.status === 401 || response.status === 403) throw new LocalApiError('permission');
    if (response.status !== 200) throw new LocalApiError('unavailable');
    return response;
  }
  async read(): Promise<ServeSnapshot> {
    const response = await this.call('GET', CONFIG_PATH);
    // Official LocalAPI hashes the exact JSON bytes for If-Match. Refuse missing/changed
    // contracts rather than ever submitting an unconditional configuration replacement.
    if (!response.etag || !ETAG.test(response.etag) || response.etag !== configDigest(response.body)) throw new LocalApiError('unsupported');
    let config: unknown;
    try { config = JSON.parse(response.body); } catch { throw new LocalApiError('invalid'); }
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) throw new LocalApiError('invalid');
    const validateMaps = (value: ServeConfig, depth: number): void => {
      if (depth > 4) throw new LocalApiError('invalid');
      for (const name of ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']) {
        const field = value[name];
        if (field != null && (typeof field !== 'object' || Array.isArray(field))) throw new LocalApiError('invalid');
      }
      for (const child of Object.values((value.Foreground ?? {}) as ServeConfig)) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) throw new LocalApiError('invalid');
        validateMaps(child as ServeConfig, depth + 1);
      }
    };
    validateMaps((config ?? {}) as ServeConfig, 0);
    return { config: (config ?? {}) as ServeConfig, etag: response.etag };
  }
  async compareAndSwap(snapshot: ServeSnapshot, next: ServeConfig): Promise<void> {
    if (!ETAG.test(snapshot.etag)) throw new LocalApiError('invalid');
    await this.call('POST', CONFIG_PATH, JSON.stringify(next), snapshot.etag);
  }
  async status(): Promise<{ nodeId: string; ip: string }> {
    const response = await this.call('GET', STATUS_PATH);
    try {
      const value = JSON.parse(response.body) as { BackendState?: unknown; Self?: { ID?: unknown; TailscaleIPs?: unknown } };
      const id = value.Self?.ID;
      const ips = value.Self?.TailscaleIPs;
      const ip = Array.isArray(ips) ? ips.find((item): item is string => typeof item === 'string' && isTailnetAddress(item)) : undefined;
      if (value.BackendState !== 'Running' || typeof id !== 'string' || !id || id.length > 200 || !ip) throw new Error();
      return { nodeId: id, ip };
    } catch { throw new LocalApiError('unavailable'); }
  }
}

export function createLocalServeApi(platform: NodeJS.Platform = process.platform): AtomicServeApi | Promise<AtomicServeApi> {
  if (platform === 'darwin') return discoverMacDaemonProof().then(proof => proof
    ? new TailscaleLocalApi(macLocalApiTransport(proof)) : createUnixServeApi(platform));
  return createUnixServeApi(platform);
}
function createUnixServeApi(platform: NodeJS.Platform): AtomicServeApi {
  const socket = localApiSocket(platform);
  try {
    const endpoint = fs.lstatSync(socket);
    const parent = fs.statSync(path.dirname(socket));
    // A standard system daemon socket, not a user-supplied symlink or writable parent.
    if (!endpoint.isSocket() || endpoint.uid !== 0 || !parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) throw new LocalApiError('unsupported');
  } catch (error) {
    if (error instanceof LocalApiError) throw error;
    throw new LocalApiError(platform === 'darwin' ? 'unsupported' : 'unavailable');
  }
  return new TailscaleLocalApi(unixLocalApiTransport(socket));
}
