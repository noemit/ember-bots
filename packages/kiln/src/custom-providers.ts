import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createProvider, type createModels, type CredentialStore, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type CustomProvider = { id: string; name: string; baseUrl: string; modelIds: string[] };

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

export async function discoverCustomModels(base: unknown, key?: string): Promise<{ modelIds: string[]; error?: string }> {
  const baseUrl = customBaseUrl(base);
  const recovery = "Check the API path and key, retry discovery, or enter model IDs manually.";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8_000), redirect: "error",
    });
  } catch {
    return { modelIds: [], error: `Kiln could not reach ${baseUrl}. Check that the server is running and reachable from this Kiln, then retry or enter model IDs manually.` };
  }
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
    return { modelIds: ids };
  } catch {
    return { modelIds: [], error: `${baseUrl} answered, but not with a usable OpenAI model list. ${recovery}` };
  }
}

export function customProvider(config: CustomProvider) {
  const models: Model<"openai-completions">[] = config.modelIds.map(id => ({
    type: "chat", id, name: id, provider: config.id, api: "openai-completions", baseUrl: config.baseUrl,
    contextWindow: 8192, maxTokens: 4096, input: ["text"], reasoning: false,
    // Use the portable chat-completions surface, not OpenAI-only storage/effort fields.
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  return createProvider({
    id: config.id, name: config.name, baseUrl: config.baseUrl, models, api: openAICompletionsApi(),
    auth: { apiKey: { name: "Optional API key", async resolve({ credential }) {
      // The OpenAI SDK requires a nonempty client key even for keyless servers.
      // Its null header override removes the synthetic bearer from the actual request.
      return { auth: credential?.type === "api_key" ? { apiKey: credential.key } : { apiKey: "unused", headers: { Authorization: null } }, source: "custom" };
    } } },
  });
}

/** Only metadata lives here. Keys stay in Kiln's existing private credential store. */
export class CustomProviders {
  private entries: CustomProvider[];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(home: string, private readonly store: CredentialStore, private readonly models: ReturnType<typeof createModels>) {
    this.file = join(home, "custom-providers.json");
    let raw: unknown = [];
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!Array.isArray(raw)) throw new Error("Kiln's custom provider file is invalid; restore it from a backup.");
    this.entries = raw.map(value => this.validate(value, value.id));
    for (const config of this.entries) models.setProvider(customProvider(config));
  }
  private validate(value: Record<string, unknown>, id: string): CustomProvider {
    if (!/^custom-[a-f0-9-]{36}$/.test(id)) throw new Error("Kiln does not recognize this custom provider. Refresh providers and try again.");
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name)) throw new Error("Give this provider a display name (up to 100 characters).");
    return { id, name: value.name.trim(), baseUrl: customBaseUrl(value.baseUrl), modelIds: modelIds(value.modelIds) };
  }
  async list() {
    return Promise.all(this.entries.map(async entry => ({ ...entry, hasApiKey: (await this.store.read(entry.id))?.type === "api_key" })));
  }
  async key(id?: string): Promise<string | undefined> {
    if (!id || !this.entries.some(entry => entry.id === id)) return undefined;
    const credential = await this.store.read(id);
    return credential?.type === "api_key" ? credential.key : undefined;
  }
  private persist(entries: CustomProvider[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.entries = entries;
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work); this.chain = next.catch(() => {}); return next;
  }
  save(value: Record<string, unknown>, id?: string) {
    return this.serialized(async () => {
      const old = id ? this.entries.find(entry => entry.id === id) : undefined;
      if (id && !old) throw new Error("Kiln no longer has this provider. Refresh providers before editing it.");
      const config = this.validate(value, id ?? `custom-${randomUUID()}`);
      if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 8192 || /[\r\n]/.test(value.apiKey))) throw new Error("Enter a valid API key, or leave it empty for a keyless server.");
      // Never carry a saved key to a different destination without explicit consent.
      if (old && old.baseUrl !== config.baseUrl && value.apiKey === undefined && await this.key(old.id)) throw new Error("The base URL changed. Re-enter the API key for this destination, or choose keyless access.");
      const provider = customProvider(config);
      const previousKey = await this.store.read(config.id);
      try {
        if (typeof value.apiKey === "string") {
          if (value.apiKey) await this.store.modify(config.id, async () => ({ type: "api_key", key: String(value.apiKey) }));
          else await this.store.delete(config.id);
        }
        this.persist([...this.entries.filter(entry => entry.id !== config.id), config]);
      } catch (error) {
        if (previousKey) await this.store.modify(config.id, async () => previousKey);
        else await this.store.delete(config.id);
        throw error;
      }
      this.models.setProvider(provider);
      return { ...config, hasApiKey: Boolean(await this.key(config.id)) };
    });
  }
  remove(id: string) {
    return this.serialized(async () => {
      if (!this.entries.some(entry => entry.id === id)) throw new Error("Kiln no longer has this provider. Refresh providers to see the current list.");
      const previousKey = await this.store.read(id);
      await this.store.delete(id);
      try { this.persist(this.entries.filter(entry => entry.id !== id)); }
      catch (error) {
        if (previousKey) await this.store.modify(id, async () => previousKey);
        throw error;
      }
      this.models.deleteProvider(id);
    });
  }
}
