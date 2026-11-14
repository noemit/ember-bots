import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createProvider, type createModels, type Api, type ApiKeyCredential, type CredentialStore, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type CustomProvider = { id: string; name: string; baseUrl: string; modelIds: string[]; requiresApiKey?: boolean };
export type CustomProviderIdentity = Pick<CustomProvider, "id" | "name" | "baseUrl" | "modelIds">;
const DESTINATION = "KILN_CUSTOM_BASE_URL";
const changedMessage = "Kiln's custom provider changed or was removed. Refresh models and send again using its current configuration.";
const keyMessage = "Kiln cannot verify this provider's saved key and destination. Re-enter the API key in Settings → Providers, or explicitly choose keyless access.";
type Revision = {
  config: CustomProvider;
  key?: string;
  blocked: boolean;
  token: string;
  controller: AbortController;
  assertCurrent(): void;
};

/** LAN and plain HTTP are intentional: this is the user's inference host, not a public URL probe. */
export function customBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Use an HTTP or HTTPS base URL, including its API path (for example /v1).");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Use a complete HTTP or HTTPS base URL, including the host and API path."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Use HTTP or HTTPS without embedded credentials, query parameters or fragments. Put the API key in its own field.");
  }
  return url.toString().replace(/\/+$/, "");
}

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== "string" || !id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id))) {
    throw new Error("Enter at least one model ID, one per line, as your server names it.");
  }
  const ids = [...new Set(value.map(id => (id as string).trim()))];
  if (!ids.length) throw new Error("Discover models or enter a model ID manually before saving.");
  return ids;
}

export async function discoverCustomModels(base: unknown, key?: string, guard?: { signal: AbortSignal; assertCurrent(): void }): Promise<{ modelIds: string[]; error?: string }> {
  const baseUrl = customBaseUrl(base);
  const recovery = "Check the API path and key, retry discovery, or enter model IDs manually.";
  let response: Response;
  try {
    guard?.assertCurrent();
    response = await fetch(`${baseUrl}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(guard ? [guard.signal] : [])]), redirect: "error",
    });
  } catch {
    if (guard?.signal.aborted) return { modelIds: [], error: changedMessage };
    return { modelIds: [], error: `Kiln could not reach ${baseUrl}. Check that the server is running and reachable from this Kiln, then retry or enter model IDs manually.` };
  }
  if (guard?.signal.aborted) return { modelIds: [], error: changedMessage };
  if (!response.ok) return { modelIds: [], error: `${baseUrl} answered but refused model discovery. ${recovery}` };
  try {
    // Bound untrusted discovery responses before parsing them.
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error();
    const ids = modelIds(body.data.map((entry: unknown) => entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined));
    guard?.assertCurrent();
    return { modelIds: ids };
  } catch {
    if (guard?.signal.aborted) return { modelIds: [], error: changedMessage };
    return { modelIds: [], error: `${baseUrl} answered, but not with a usable OpenAI model list. ${recovery}` };
  }
}

/** A provider revision never reads a live credential: destination and secret are one snapshot. */
function customProvider(revision: Revision) {
  const { config } = revision;
  const models = config.modelIds.map(id => ({
    type: "chat" as const, id, name: id, provider: config.id, api: "openai-completions" as const, baseUrl: config.baseUrl,
    customProviderRevision: revision.token,
    contextWindow: 8192, maxTokens: 4096, input: ["text" as const], reasoning: false,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" as const },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const provider = createProvider({
    id: config.id, name: config.name, baseUrl: config.baseUrl, models, api: openAICompletionsApi(),
    auth: { apiKey: { name: "Optional API key", async resolve() {
      revision.assertCurrent();
      if (revision.blocked) return undefined;
      // The SDK needs a client key; a null header removes the placeholder from keyless requests.
      return { auth: revision.key ? { apiKey: revision.key } : { apiKey: "unused", headers: { Authorization: null } }, source: "custom" };
    } } },
  });
  function guarded<T extends { signal?: AbortSignal; fetch?: typeof fetch } | undefined>(model: Model<Api>, options: T) {
    revision.assertCurrent();
    if (revision.blocked) throw new Error(keyMessage);
    if (model.baseUrl !== config.baseUrl || (model as Model<Api> & { customProviderRevision?: string }).customProviderRevision !== revision.token) throw new Error(changedMessage);
    const send = options?.fetch ?? globalThis.fetch;
    const signal = AbortSignal.any([revision.controller.signal, ...(options?.signal ? [options.signal] : [])]);
    const guardedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      // Runs after SDK/lazy imports, payload hooks and retries, immediately before every dispatch.
      // No await separates this check from fetch. Revocation also aborts in-flight requests.
      revision.assertCurrent();
      signal.throwIfAborted();
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const expected = new URL(config.baseUrl + "/chat/completions").toString();
      const authorization = revision.key ? "Bearer " + revision.key : null;
      if (request.url !== expected || request.headers.get("authorization") !== authorization) throw new Error(changedMessage);
      return send(request, { redirect: "error", signal: AbortSignal.any([signal, request.signal]) });
    }) as typeof fetch;
    return { ...options, fetch: guardedFetch, signal } as T & { fetch: typeof fetch; signal: AbortSignal };
  }
  const stream = provider.stream;
  const streamSimple = provider.streamSimple;
  provider.stream = (model, context, options) => stream(model, context, guarded(model, options));
  provider.streamSimple = (model, context, options) => streamSimple(model, context, guarded(model, options));
  return provider;
}

/** Metadata and secrets are published atomically as revocable in-memory revisions. */
export class CustomProviders {
  private entries: CustomProvider[];
  private readonly live = new Map<string, Revision>();
  private chain: Promise<unknown>;
  private loaded = false;
  private readonly file: string;
  readonly ready: Promise<void>;
  constructor(home: string, private readonly store: CredentialStore, private readonly models: ReturnType<typeof createModels>) {
    this.file = join(home, "custom-providers.json");
    let raw: unknown = [];
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!Array.isArray(raw)) throw new Error("Kiln's custom provider file is invalid; restore it from a backup.");
    this.entries = raw.map(value => this.validate(value, value.id));
    this.ready = Promise.resolve().then(async () => {
      for (const config of this.entries) {
        const credential = await store.read(config.id);
        const valid = credential?.type === "api_key" && credential.env?.[DESTINATION] === config.baseUrl && Boolean(credential.key);
        // Never guess the destination of an unbound/partially committed key after a crash.
        const blocked = Boolean(credential && !valid || config.requiresApiKey && !valid);
        this.publish(config, valid && credential.type === "api_key" ? credential.key : undefined, blocked);
      }
      this.loaded = true;
    });
    this.chain = this.ready;
  }
  private publish(config: CustomProvider, key?: string, blocked = false) {
    const revision: Revision = {
      config, key, blocked, token: randomUUID(), controller: new AbortController(),
      assertCurrent: () => {
        if (this.live.get(config.id) !== revision || revision.controller.signal.aborted) throw new Error(changedMessage);
      },
    };
    this.live.set(config.id, revision);
    this.models.setProvider(customProvider(revision));
  }
  private revoke(id: string) {
    const previous = this.live.get(id);
    this.live.delete(id);
    previous?.controller.abort(new Error(changedMessage));
    this.models.deleteProvider(id);
    return previous;
  }
  private validate(value: Record<string, unknown>, id: string): CustomProvider {
    if (!/^custom-[a-f0-9-]{36}$/.test(id)) throw new Error("Kiln does not recognize this custom provider. Refresh providers and try again.");
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name)) throw new Error("Give this provider a display name (up to 100 characters).");
    return { id, name: value.name.trim(), baseUrl: customBaseUrl(value.baseUrl), modelIds: modelIds(value.modelIds), ...(value.requiresApiKey === true ? { requiresApiKey: true } : {}) };
  }
  list() {
    return this.serialized(async () => this.entries.map(entry => {
      const revision = this.live.get(entry.id);
      return { ...entry, modelIds: [...entry.modelIds], hasApiKey: Boolean(revision?.key || revision?.blocked), ...(revision?.blocked ? { problem: keyMessage } : {}) };
    }));
  }
  /** Non-secret metadata for alignment previews. Mutating a returned identity cannot alter this owner. */
  identities(): CustomProviderIdentity[] {
    if (!this.loaded) throw new Error("Kiln is still loading custom providers. Wait for it to finish, then refresh.");
    return this.entries.map(({ id, name, baseUrl, modelIds }) => ({ id, name, baseUrl, modelIds: [...modelIds] }));
  }
  private checkedIdentity(id: string, identity: unknown): Revision {
    const current = this.live.get(id);
    const expected = identity && typeof identity === "object" ? identity as Record<string, unknown> : undefined;
    if (!current || !expected || expected.id !== id || expected.name !== current.config.name ||
      expected.baseUrl !== current.config.baseUrl || !Array.isArray(expected.modelIds) ||
      expected.modelIds.length !== current.config.modelIds.length ||
      expected.modelIds.some((model, index) => model !== current.config.modelIds[index])) {
      throw new Error("Kiln's custom provider configuration changed. Review its destination and models again before sharing credentials.");
    }
    current.assertCurrent();
    return current;
  }
  /** Read-only alignment callback; never nest save/remove/list/importMissingKey inside this lock. */
  withIdentity<T>(id: string, identity: unknown, read: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const current = this.checkedIdentity(id, identity);
      const credential = await this.store.read(id);
      if (current.blocked || (current.key
        ? credential?.type !== "api_key" || credential.key !== current.key || credential.env?.[DESTINATION] !== current.config.baseUrl
        : credential !== undefined)) throw new Error(keyMessage);
      return read();
    });
  }
  /** Fill-only reviewed import: never assign a foreign ID or write an unbound key through the store. */
  importMissingKey(id: string, identity: unknown, key: string, credential?: ApiKeyCredential): Promise<boolean> {
    return this.serialized(async () => {
      const current = this.checkedIdentity(id, identity);
      if (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw new Error("Enter a valid API key before importing this custom provider credential.");
      if (credential && (credential.type !== "api_key" || credential.key !== key ||
        credential.env !== undefined && (!credential.env || typeof credential.env !== "object" || Array.isArray(credential.env) ||
          Object.entries(credential.env).some(([name, value]) => name.length > 256 || typeof value !== "string" || value.length > 16384)) ||
        credential.env?.[DESTINATION] !== undefined && credential.env[DESTINATION] !== current.config.baseUrl)) throw new Error(keyMessage);
      if (current.key || current.blocked) return false;
      const config = { ...current.config, requiresApiKey: true };
      const incoming: ApiKeyCredential = { type: "api_key", key, env: { ...credential?.env, [DESTINATION]: config.baseUrl } };
      let installed = false;
      this.revoke(id);
      try {
        // The store lock, not an earlier read or the configuration lock, decides fill-only.
        // Never route this through saveLocked: its replacement/rollback semantics can erase
        // a different writer that wins between preflight and this modify callback.
        const stored = await this.store.modify(id, async existing => {
          if (existing !== undefined) return undefined;
          // Persist the keyed requirement before installing the credential. A crash or failed
          // store write then blocks on boot instead of falling back to keyless inference.
          this.persist(this.entries.map(entry => entry.id === id ? config : entry));
          installed = true;
          return incoming;
        });
        if (!installed) this.persist(this.entries.map(entry => entry.id === id ? config : entry));
        const bound = stored?.type === "api_key" && typeof stored.key === "string" && Boolean(stored.key) && stored.env?.[DESTINATION] === config.baseUrl;
        // Reconcile a racing winner without modifying it. Unbound/OAuth/foreign-destination
        // winners remain untouched in storage and cannot become a keyless runtime fallback.
        this.publish(config, bound && stored.type === "api_key" ? stored.key : undefined, !bound);
        return installed;
      } catch (error) {
        // Do not roll back or delete here: another writer may own the store by now.
        this.publish(config, undefined, true);
        throw error;
      }
    });
  }
  /** One serialized snapshot replaces the unsafe list-then-key read in the HTTP route. */
  async discover(base: unknown, apiKey?: unknown, id?: unknown) {
    const target = await this.serialized(async () => {
      const baseUrl = customBaseUrl(base);
      if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 8192 || /[\r\n]/.test(apiKey))) throw new Error("Enter a valid API key, or leave it empty for a keyless server.");
      const revision = typeof id === "string" ? this.live.get(id) : undefined;
      if (id !== undefined && !revision) throw new Error(changedMessage);
      revision?.assertCurrent();
      if (apiKey === undefined && revision && (revision.config.baseUrl !== baseUrl || revision.blocked)) throw new Error(keyMessage);
      return { baseUrl, key: typeof apiKey === "string" ? apiKey : revision?.key, revision };
    });
    const guard = target.revision ? { signal: target.revision.controller.signal, assertCurrent: target.revision.assertCurrent } : undefined;
    return discoverCustomModels(target.baseUrl, target.key, guard);
  }
  private persist(entries: CustomProvider[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.entries = entries;
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => { await this.ready; return work(); }); this.chain = next.catch(() => {}); return next;
  }
  private async writeKey(id: string, key: string | undefined, baseUrl: string, credential?: ApiKeyCredential) {
    if (key) await this.store.modify(id, async () => ({ type: "api_key", key, env: { ...credential?.env, [DESTINATION]: baseUrl } }));
    else await this.store.delete(id);
  }
  save(value: Record<string, unknown>, id?: string) {
    return this.serialized(() => this.saveLocked(value, id));
  }
  private async saveLocked(value: Record<string, unknown>, id?: string, importedCredential?: ApiKeyCredential) {
    const old = id ? this.live.get(id) : undefined;
    if (id && !old) throw new Error("Kiln no longer has this provider. Refresh providers before editing it.");
    const config = this.validate(value, id ?? "custom-" + randomUUID());
    if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 8192 || /[\r\n]/.test(value.apiKey))) throw new Error("Enter a valid API key, or leave it empty for a keyless server.");
    if (old && value.apiKey === undefined && old.blocked) throw new Error(keyMessage);
    if (old && old.config.baseUrl !== config.baseUrl && value.apiKey === undefined && old.key) throw new Error("The base URL changed. Re-enter the API key for this destination, or choose keyless access.");
    const key = typeof value.apiKey === "string" ? value.apiKey || undefined : old?.key;
    config.requiresApiKey = Boolean(key);
    const previousCredential = await this.store.read(config.id);
    // Retire before the first secret mutation, not after publishing the new metadata.
    this.revoke(config.id);
    try {
      const envelope = importedCredential ?? (old?.config.baseUrl === config.baseUrl && previousCredential?.type === "api_key" ? previousCredential : undefined);
      await this.writeKey(config.id, key, config.baseUrl, envelope);
      this.persist([...this.entries.filter(entry => entry.id !== config.id), config]);
    } catch (error) {
      // Failed rollback stays revoked; destination binding also prevents a mismatched boot.
      try {
        if (previousCredential) await this.store.modify(config.id, async () => previousCredential);
        else await this.store.delete(config.id);
      } catch (rollbackError) {
        if (old) this.publish(old.config, undefined, true);
        throw rollbackError;
      }
      if (old) this.publish(old.config, old.key, old.blocked);
      throw error;
    }
    this.publish(config, key);
    return { ...config, modelIds: [...config.modelIds], hasApiKey: Boolean(key) };
  }
  remove(id: string) {
    return this.serialized(async () => {
      const old = this.live.get(id);
      if (!old) throw new Error("Kiln no longer has this provider. Refresh providers to see the current list.");
      const previousCredential = await this.store.read(id);
      this.revoke(id);
      try {
        await this.store.delete(id);
        this.persist(this.entries.filter(entry => entry.id !== id));
      } catch (error) {
        try { if (previousCredential) await this.store.modify(id, async () => previousCredential); }
        catch (rollbackError) { this.publish(old.config, undefined, true); throw rollbackError; }
        this.publish(old.config, old.key, old.blocked);
        throw error;
      }
    });
  }
}
