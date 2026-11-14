import type { CredentialStore } from '@earendil-works/pi-ai';
import type { PeerEndpoint } from './agents';
import { hasEnvCredential } from './credentials';

/** Connections portable between machines; loopback and wildcard listeners are never identities. */
export const portablePeer = (value: unknown): PeerEndpoint | null => {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (![p.id, p.label, p.url, p.token].every(v => typeof v === 'string' && v.trim().length > 0)) return null;
  if (String(p.id).length > 120 || String(p.label).length > 120 || String(p.url).length > 500 || String(p.token).length > 4096) return null;
  try {
    const u = new URL(String(p.url));
    const host = u.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || ['0.0.0.0', '[::]', '[::1]'].includes(host)) return null;
    // API keys may travel over HTTPS or a private network, never plain public HTTP.
    const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host.endsWith('.ts.net');
    if (u.protocol === 'http:' && !privateHost) return null;
    return { id: String(p.id).trim(), label: String(p.label).trim(), url: u.toString().replace(/\/+$/, ''), token: String(p.token).trim() };
  } catch { return null; }
};

/** Existing URLs and credentials win. Distinct peers cannot silently reuse another peer's id. */
export const mergePeers = (existing: readonly PeerEndpoint[], incoming: readonly PeerEndpoint[]): PeerEndpoint[] => {
  const result = [...existing];
  for (const peer of incoming) {
    if (result.some(p => p.url.replace(/\/+$/, '') === peer.url.replace(/\/+$/, ''))) continue;
    let id = peer.id;
    for (let n = 2; result.some(p => p.id === id); n++) id = `${peer.id.slice(0, 110)}-${n}`;
    result.push({ ...peer, id });
  }
  return result;
};

export const storedApiKeys = async (store: CredentialStore) => {
  const keys: Array<{ providerId: string; key: string }> = [];
  for (const info of await store.list()) {
    // Custom keys are destination-bound; connection alignment does not transfer that configuration.
    if (info.type !== 'api_key' || info.providerId.startsWith('custom-')) continue;
    const credential = await store.read(info.providerId);
    if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.trim()) keys.push({ providerId: info.providerId, key: credential.key });
  }
  return keys;
};

/** Atomic fill-only writes preserve OAuth, locally configured keys and environment credentials. */
export const importApiKeys = async (store: CredentialStore, input: unknown): Promise<number> => {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Invalid provider list');
  const keys = input.map(value => {
    if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(value.providerId) || typeof value.key !== 'string' || !value.key.trim() || value.key.length > 16384) throw new Error('Invalid provider key');
    return { providerId: value.providerId, key: value.key };
  });
  let added = 0;
  for (const entry of keys) {
    if (entry.providerId.startsWith('custom-') || hasEnvCredential(entry.providerId)) continue;
    await store.modify(entry.providerId, async current => {
      if (current) return current;
      added++;
      return { type: 'api_key', key: entry.key };
    });
  }
  return added;
};

/** Direct host-to-host transfer. Response/error bodies never expose destination tokens or keys. */
export const shareApiKeys = async (store: CredentialStore, targets: readonly PeerEndpoint[], send: typeof fetch = fetch) => {
  const keys = await storedApiKeys(store);
  const results: Array<{ id: string; ok: boolean; keys?: number }> = [];
  for (const target of targets) {
    try {
      const response = await send(`${target.url}/alignment/import`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ peers: [], keys }),
      });
      if (!response.ok) { results.push({ id: target.id, ok: false }); continue; }
      const data = await response.json() as { keys?: number };
      results.push({ id: target.id, ok: true, keys: typeof data.keys === 'number' ? data.keys : 0 });
    } catch { results.push({ id: target.id, ok: false }); }
  }
  return results;
};
