import type { ApiKeyCredential, Credential, CredentialStore } from '@earendil-works/pi-ai';
import { isIP } from 'node:net';
import type { PeerEndpoint } from './agents';
import { hasEnvCredential, normalizeProviderId, PROVIDER_ENV_VARS } from './credentials';

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
    const literal = host.startsWith('[') ? host.slice(1, -1) : host;
    // Mapped loopback/wildcard literals are not portable identities either.
    if (literal.startsWith('::ffff:')) return null;
    const ip = isIP(literal);
    const parts = host.split('.').map(Number);
    const privateHost = (ip === 4 && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127))) || (ip === 6 && /^f[cd]/.test(literal)) || (ip === 0 && host.endsWith('.ts.net'));
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

/** A cross-host key must not be introduced for a public plaintext or machine-local inference URL. */
export const shareableCustomUrl = (url: unknown): boolean => Boolean(portablePeer({ id: 'custom', label: 'Custom provider', url, token: 'metadata-only' }));

export type ConfigIdentity = { id: string; name: string; baseUrl: string; modelIds: string[] };
export type ProviderSelection = { providerId: string; type: 'api_key' | 'oauth'; experimental?: true; configIdentity?: ConfigIdentity; destinationConfigIdentity?: ConfigIdentity };
/** Custom config owners must serialize this guard with config edits/removal. Default is fail-closed. */
export type AlignmentConfig = {
  identities(): readonly ConfigIdentity[];
  withIdentity<T>(id: string, identity: ConfigIdentity, work: () => Promise<T>): Promise<T>;
  importMissingKey(id: string, identity: ConfigIdentity, key: string, credential?: ApiKeyCredential): Promise<boolean>;
};
const oauthProviders = new Set(['openai-codex', 'antigravity']);
const providerIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(id);
const custom = (id: string) => id.startsWith('custom-') || id === 'orcarouter';
const invalid = () => new Error('Kiln could not validate the provider review. Refresh providers and review the selection again.');
const selection = (value: unknown): ProviderSelection => {
  if (!value || typeof value !== 'object') throw invalid();
  const v = value as ProviderSelection;
  if (!providerIdValid(v.providerId) || !['api_key', 'oauth'].includes(v.type)) throw invalid();
  if (v.type === 'oauth' && (!oauthProviders.has(v.providerId) || v.experimental !== true)) throw invalid();
  if (v.type === 'api_key' && oauthProviders.has(v.providerId)) throw invalid();
  if (custom(v.providerId) && (!v.configIdentity || v.configIdentity.id !== v.providerId || !shareableCustomUrl(v.configIdentity.baseUrl))) throw invalid();
  return v;
};
const credentialValid = (credential: unknown, type: ProviderSelection['type']): credential is Credential => {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return false;
  const c = credential as Record<string, unknown>;
  if (c.type !== type || JSON.stringify(c).length > 65536) return false;
  if (type === 'api_key') return typeof c.key === 'string' && Boolean(c.key.trim()) && c.key.length <= 16384 &&
    (c.env === undefined || (c.env !== null && typeof c.env === 'object' && !Array.isArray(c.env) && Object.values(c.env).every(v => typeof v === 'string')));
  return typeof c.access === 'string' && Boolean(c.access.trim()) && c.access.length <= 16384 && typeof c.refresh === 'string' && Boolean(c.refresh.trim()) && c.refresh.length <= 16384 && typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0;
};
const providerMetadataValid = (id: string, c: Credential, identity?: ConfigIdentity) => {
  // Preserve the entire reviewed API-key envelope; the owner validates and publishes it atomically.
  if (custom(id)) return c.type === 'api_key' && Boolean(identity) && Boolean(c.key && c.key.length <= 8192 && !/[\r\n]/.test(c.key)) &&
    c.env?.KILN_CUSTOM_BASE_URL === identity?.baseUrl &&
    Object.entries(c.env ?? {}).every(([key, value]) => key.length <= 256 && value.length <= 16384) &&
    Object.keys(c).every(key => ['type', 'key', 'env'].includes(key));
  if (c.type !== 'oauth') return true;
  const text = (value: unknown) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 4096;
  if (id === 'openai-codex' && !text(c.accountId)) return false;
  if (id === 'antigravity' && (!text(c.projectId) || (c.email !== undefined && !text(c.email)))) return false;
  return true;
};
const guard = async <T>(s: ProviderSelection, config: AlignmentConfig | undefined, work: () => Promise<T>): Promise<T> => {
  if (!custom(s.providerId)) {
    if (s.configIdentity !== undefined) throw invalid();
    return work();
  }
  if (!config || !s.configIdentity) throw invalid();
  return config.withIdentity(s.providerId, s.configIdentity, work);
};

/** Never read credentials or resolve auth for a preview. */
export const alignmentProviders = async (store: CredentialStore, config?: AlignmentConfig) => {
  const identities = config?.identities() ?? [];
  const stored = await store.list();
  const rows: Array<{ providerId: string; type: 'api_key' | 'oauth'; source: 'stored' | 'environment' | 'missing' }> = stored.map(info => ({ ...info, source: 'stored' }));
  for (const providerId of Object.keys(PROVIDER_ENV_VARS)) {
    if (!rows.some(r => r.providerId === providerId) && hasEnvCredential(providerId)) rows.push({ providerId, type: 'api_key', source: 'environment' });
  }
  for (const identity of identities) {
    if (!rows.some(r => r.providerId === identity.id)) rows.push({ providerId: identity.id, type: 'api_key', source: 'missing' });
  }
  return rows.map(info => {
    const identity = identities.find(c => c.id === info.providerId);
    const shareable = info.source !== 'environment' && (info.type === 'api_key' ? !oauthProviders.has(info.providerId) : oauthProviders.has(info.providerId)) && (!custom(info.providerId) || Boolean(identity && shareableCustomUrl(identity.baseUrl)));
    return { providerId: info.providerId, type: info.type, source: info.source, hasCredential: info.source !== 'missing', shareable,
      ...(info.type === 'oauth' && oauthProviders.has(info.providerId) ? { experimental: true as const } : {}),
      ...(identity ? { configIdentity: identity } : {}),
      ...(!shareable ? { reason: identity && !shareableCustomUrl(identity.baseUrl)
        ? 'Sharing needs a matching HTTPS or private-network provider address, not public HTTP or a machine-local address.'
        : 'This provider needs a separate sign-in, a stored key, or matching custom configuration.' } : {}),
    };
  });
};

/** Compatibility helper; custom keys cannot escape without a reviewed config binding. */
export const storedApiKeys = async (store: CredentialStore) => {
  const keys: Array<{ providerId: string; key: string }> = [];
  for (const info of await store.list()) {
    if (info.type !== 'api_key' || oauthProviders.has(info.providerId) || custom(info.providerId)) continue;
    const credential = await store.read(info.providerId);
    if (credentialValid(credential, 'api_key') && credential.type === 'api_key') keys.push({ providerId: info.providerId, key: credential.key! });
  }
  return keys;
};

/** Validate the entire batch first. Check env inside the atomic credential lock, not before it. */
export const importCredentials = async (store: CredentialStore, input: unknown, config?: AlignmentConfig): Promise<number> => {
  if (!Array.isArray(input) || input.length > 100) throw invalid();
  const seen = new Set<string>();
  const entries = input.map(value => {
    const s = selection({ ...value, type: value?.credential?.type });
    if (s.destinationConfigIdentity !== undefined) throw invalid();
    const canonical = normalizeProviderId(s.providerId);
    if (seen.has(canonical)) throw invalid();
    seen.add(canonical);
    if (!credentialValid(value.credential, s.type) || !providerMetadataValid(s.providerId, value.credential, s.configIdentity)) throw invalid();
    return { ...s, providerId: canonical, credential: structuredClone(value.credential) as Credential };
  });
  // Preflight bindings before any writes. Recheck under config serialization for each actual write.
  for (const entry of entries) await guard(entry, config, async () => {});
  let added = 0;
  for (const entry of entries) {
    if (custom(entry.providerId)) {
      if (entry.credential.type !== 'api_key' || !entry.credential.key || !entry.configIdentity || !config) throw invalid();
      if (await config.importMissingKey(entry.providerId, entry.configIdentity, entry.credential.key, entry.credential)) added++;
      continue;
    }
    await guard(entry, config, () => store.modify(entry.providerId, async current => {
      if (current || hasEnvCredential(entry.providerId)) return undefined;
      added++;
      return entry.credential;
    }));
  }
  return added;
};
export const importApiKeys = async (store: CredentialStore, input: unknown): Promise<number> => {
  if (!Array.isArray(input) || input.length > 100) throw invalid();
  return importCredentials(store, input.map(v => {
    if (!v || custom(String(v.providerId))) throw invalid();
    return { providerId: v.providerId, credential: { type: 'api_key', key: v.key } };
  }));
};

export type ShareTarget = PeerEndpoint & { providers: ProviderSelection[] };
/** Explicit source+destination review, no redirects and no credential-bearing response/error bodies. */
export const shareApiKeys = async (store: CredentialStore, targets: readonly ShareTarget[], send: typeof fetch = fetch, config?: AlignmentConfig) => {
  if (!Array.isArray(targets) || targets.length > 100) throw invalid();
  const reviewed = targets.map(target => {
    const peer = portablePeer(target);
    if (!peer || !Array.isArray(target.providers) || !target.providers.length || target.providers.length > 100) throw invalid();
    const providers: ProviderSelection[] = target.providers.map(selection);
    for (const p of providers) {
      if (custom(p.providerId)) {
        const source = p.configIdentity;
        const destination = p.destinationConfigIdentity;
        if (!source || !destination || !/^custom-[a-f0-9-]{36}$/.test(destination.id) || source.name !== destination.name ||
          source.baseUrl !== destination.baseUrl || !Array.isArray(source.modelIds) || !Array.isArray(destination.modelIds) ||
          source.modelIds.length !== destination.modelIds.length || source.modelIds.some((id, index) => id !== destination.modelIds[index])) throw invalid();
      } else if (p.destinationConfigIdentity !== undefined) throw invalid();
    }
    if (new Set(providers.map(p => normalizeProviderId(p.providerId))).size !== providers.length ||
      new Set(providers.map(p => normalizeProviderId(p.destinationConfigIdentity?.id ?? p.providerId))).size !== providers.length) throw invalid();
    return { ...peer, providers };
  });
  const results: Array<{ id: string; ok: boolean; keys?: number }> = [];
  for (const target of reviewed) {
    try {
      const credentials = [];
      for (const s of target.providers) {
        const credential = await guard(s, config, async () => structuredClone(await store.read(s.providerId)));
        if (!credentialValid(credential, s.type) || !providerMetadataValid(s.providerId, credential, s.configIdentity)) throw invalid();
        credentials.push({
          providerId: s.destinationConfigIdentity?.id ?? s.providerId,
          type: s.type,
          experimental: s.experimental,
          configIdentity: s.destinationConfigIdentity ?? s.configIdentity,
          credential,
        });
      }
      const response = await send(target.url + '/alignment/import', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: 'Bearer ' + target.token, 'content-type': 'application/json' },
        body: JSON.stringify({ peers: [], credentials }),
      });
      if (!response.ok) { results.push({ id: target.id, ok: false }); continue; }
      // Do not parse arbitrary remote error bodies (which may echo the request).
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4096) { await reader.cancel(); throw invalid(); }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const data = JSON.parse(text) as { keys?: number };
      results.push({ id: target.id, ok: true, keys: Number.isInteger(data.keys) && data.keys! >= 0 && data.keys! <= credentials.length ? data.keys : 0 });
    } catch { results.push({ id: target.id, ok: false }); }
  }
  return results;
};
