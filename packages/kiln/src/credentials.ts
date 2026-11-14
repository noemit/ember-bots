/**
 * Hearth's provider credentials, persisted to `$HEARTH_HOME/auth.json` in pi-ai's `Credential`
 * shape (`{ [providerId]: Credential }` — "the shape of today's auth.json"). Wired into
 * `createModels({ credentials })`, so a stored credential wins over an env var
 * (`envApiKeyAuth` resolves stored-first), and OAuth refresh — which runs inside `modify` —
 * persists the rotated token.
 *
 * Atomic writes (temp + rename), mode 0600, and one serialized write per provider so concurrent
 * callers can't lose a credential.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
// The store interfaces are exported by `models.d.ts` only as a return/option type, so they are
// read off `createModels` rather than imported from a module path the package does not export.
type ModelsStore = NonNullable<Parameters<typeof import("@earendil-works/pi-ai").createModels>[0]>["modelsStore"] extends
  infer S
  ? NonNullable<S>
  : never;
type ModelsStoreEntry = Parameters<ModelsStore["write"]>[1];

export type HearthCredentialInfo = CredentialInfo & { expired?: boolean };

/**
 * Provider ID aliases from OpenCode (`auth.json`) onto Hearth's registered provider IDs.
 * OpenCode stores Fireworks under `"fireworks-ai"`, whereas Hearth registers `"fireworks"`.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "fireworks-ai": "fireworks",
};

export const normalizeProviderId = (providerId: string): string => PROVIDER_ALIASES[providerId] ?? providerId;

/** Environment variable names per provider, so `GET /providers` or callers can check if an env key is configured. */
export const PROVIDER_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  opencode: ["OPENCODE_API_KEY"],
  xai: ["XAI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  // Subscription-only: the credential is an OAuth token stored by a sign-in, never an env var.
  "openai-codex": [],
  // Google Antigravity: likewise a sign-in only. There is no API key for a Cloud Code Assist
  // consumer account, so listing an env var here would offer a field that cannot work.
  antigravity: [],
  "github-copilot": ["GITHUB_TOKEN"],
  meta: ["META_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "kimi-coding": ["KIMI_CODING_API_KEY", "KIMI_API_KEY"],
  moonshotai: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  orcarouter: ["ORCAROUTER_API_KEY"],
};

/** True when any environment variable for `providerId` holds a non-empty key. */
export const hasEnvCredential = (
  providerId: string,
  env: Record<string, string | undefined> = process.env
): boolean => {
  const vars = PROVIDER_ENV_VARS[normalizeProviderId(providerId)] ?? [];
  return vars.some((name) => Boolean(env[name]?.trim()));
};

/** True when an OAuth credential has a numeric `expires` timestamp at or before `now`. */
export const isCredentialExpired = (cred: Credential | undefined, now = Date.now()): boolean =>
  Boolean(cred && cred.type === "oauth" && typeof cred.expires === "number" && cred.expires <= now);

export const isCredential = (value: unknown): value is Credential => {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
};

export class FileCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private loaded?: Promise<void>;

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    this.loaded ??= Promise.resolve().then(() => {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
        for (const [providerId, value] of Object.entries(raw)) {
          if (isCredential(value)) this.credentials.set(providerId, value);
        }
        for (const [alias, canonical] of Object.entries(PROVIDER_ALIASES)) {
          const aliased = this.credentials.get(alias);
          if (aliased && !this.credentials.has(canonical)) {
            this.credentials.set(canonical, aliased);
            this.credentials.delete(alias);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
    return this.loaded;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.credentials), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Serialize per provider id; a rejection propagates to its caller but not to later writes. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(
      providerId,
      next.catch(() => undefined)
    );
    return next;
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    await this.load();
    return this.credentials.get(providerId) ?? this.credentials.get(normalizeProviderId(providerId));
  }

  async list(_options?: AuthOperationOptions): Promise<readonly HearthCredentialInfo[]> {
    await this.load();
    const now = Date.now();
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
      ...(isCredentialExpired(credential, now) ? { expired: true } : {}),
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    const canonical = normalizeProviderId(providerId);
    return this.enqueue(canonical, async () => {
      await this.load();
      const current = this.credentials.get(canonical);
      const next = await fn(current);
      if (next === undefined) return current;
      this.credentials.set(canonical, next);
      this.persist();
      return next;
    });
  }

  delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    const canonical = normalizeProviderId(providerId);
    return this.enqueue(canonical, async () => {
      await this.load();
      if (this.credentials.delete(canonical)) this.persist();
    });
  }
}

/** Map an OpenCode credential entry onto pi-ai's `Credential`. OpenCode names an api key
 *  `type: "api"`; pi-ai names it `api_key`. OAuth is already the same shape. */
const fromOpenCode = (entry: unknown): Credential | undefined => {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as Record<string, unknown>;
  if ((value.type === "api" || value.type === "api_key") && typeof value.key === "string") {
    return { type: "api_key", key: value.key };
  }
  if (
    value.type === "oauth" &&
    typeof value.refresh === "string" &&
    typeof value.access === "string" &&
    typeof value.expires === "number"
  ) {
    const { type: _type, ...rest } = value;
    return { type: "oauth", ...rest } as Credential;
  }
  return undefined;
};

/**
 * Copy provider credentials out of OpenCode's store into Hearth's, so Hearth stops depending on
 * OpenCode (see `PROVIDER_MIGRATION.md`). Never clobbers a credential Hearth already holds; returns
 * the provider ids it imported.
 */
export const importOpenCodeCredentials = async (
  store: CredentialStore,
  source = join(homedir(), ".local/share/opencode/auth.json")
): Promise<string[]> => {
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const imported: string[] = [];
  for (const [rawProviderId, entry] of Object.entries(auth)) {
    const credential = fromOpenCode(entry);
    if (!credential) continue;
    const providerId = normalizeProviderId(rawProviderId);
    // A portable key has no verified custom-server destination; only the custom editor may bind it.
    if (providerId.startsWith("custom-")) continue;
    await store.modify(providerId, async (current) => {
      if (current) return undefined; // already have one — keep it
      imported.push(providerId);
      return credential;
    });
  }
  return imported;
};

/**
 * pi-ai's model-catalog store, persisted next to the credentials (`$HEARTH_HOME/models-store.json`,
 * mode 0600). Without it the store is in-memory, so every boot re-runs the network catalog reads
 * BEFORE the server listens — with a slow or hostile provider that is a startup that never
 * finishes. With it, boot restores the last list at once and the catalog read overlaps the server.
 */
export class FileModelsStore implements ModelsStore {
  private readonly entries = new Map<string, ModelsStoreEntry>();
  private loaded?: Promise<void>;

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    this.loaded ??= Promise.resolve().then(() => {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, ModelsStoreEntry>;
        for (const [providerId, entry] of Object.entries(raw)) {
          if (entry && Array.isArray(entry.models)) this.entries.set(providerId, entry);
        }
      } catch {
        // No store yet, or an unreadable one: start empty (every provider falls back to its catalog).
      }
    });
    return this.loaded;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    await this.load();
    return this.entries.get(providerId);
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.load();
    this.entries.set(providerId, entry);
    this.persist();
  }

  async delete(providerId: string): Promise<void> {
    await this.load();
    if (this.entries.delete(providerId)) this.persist();
  }
}
