import { dirname, join } from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createModels, createProvider, envApiKeyAuth, type CredentialStore, type Model, type Models } from "@earendil-works/pi-ai";
import { FileCredentialStore, FileModelsStore, importOpenCodeCredentials } from "./credentials";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { antigravityProvider } from "./antigravity";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openCodeZenWithDiscovery } from "./model-discovery";
import {
  kimiCodingModel,
  kimiKeyPresent,
  kimiOptions,
  moonshotContextWindow,
  moonshotModel,
  type KimiOptions,
  type MoonshotCatalogEntry,
} from "./kimi";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_ENV_VAR,
  deepinfraModel,
  type DeepInfraCatalogEntry,
} from "./deepinfra";
import { orcarouterModel, orcarouterOptions, routerLimits, type RouterCatalogEntry } from "./orcarouter";
import { lmStudioProvider, ollamaProvider, probeLocalRuntimes, type LocalRuntimeProbe } from "./local-models";

// Embed the SDK OAuth flows before any provider can load one. Variable imports cannot
// resolve relative modules once Kiln or Tinder is compiled into a standalone executable.
registerBunOAuthFlows();

export type HearthDefault = { model: { provider: string; modelId: string } };

const envString = (name: string, env: Record<string, string | undefined> = process.env): string | undefined => {
  const value = env[name];
  return value && value.trim() ? value.trim() : undefined;
};

/**
 * The bearer header for a catalog fetch. pi-ai hands the resolved credential to
 * `fetchModels`, but a bare `fetch()` sends none - Moonshot answers 401 without it and the
 * provider silently falls back to its (stale) shipped catalog, hiding models the account has.
 */
const catalogAuth = (credential: unknown): Record<string, string> => {
  const key = credential as { type?: string; key?: string } | undefined;
  return key?.type === "api_key" && key.key ? { Authorization: `Bearer ${key.key}` } : {};
};

/**
 * The dynamic orcarouter provider (custom baseURL + env key + fetched catalog), when
 * ORCAROUTER_BASE_URL and ORCAROUTER_API_KEY are set. Fetched models carry the full Model
 * shape - api, baseUrl, cost, limits - as the Phase 0 spike established. What the slot
 * advertises beyond that (reasoning, image input, limit fallbacks) comes from the
 * ORCAROUTER_* env vars, mapped in ./orcarouter.ts.
 */
export const orcarouterProvider = (env: Record<string, string | undefined> = process.env) => {
  const baseUrl = envString("ORCAROUTER_BASE_URL", env);
  if (!baseUrl || !env.ORCAROUTER_API_KEY) return undefined;
  const options = orcarouterOptions(env);
  console.log(
    `[hearth] orcarouter ${baseUrl}: reasoning ${options.reasoning}, input ${options.input.join("+")}, ` +
      `fallback window ${options.contextWindow ?? "default"}, fallback output ${options.maxTokens ?? "default"}`
  );
  const router = createProvider({
    id: "orcarouter",
    name: "Orcarouter",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("Orcarouter API key", ["ORCAROUTER_API_KEY"]) },
    models: [],
    api: openAICompletionsApi(),
    fetchModels: async (ctx) => {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: catalogAuth(ctx.credential),
        signal: ctx.signal,
      });
      if (!response.ok) throw new Error(`orcarouter /models failed: ${response.status}`);
      const body = (await response.json()) as { data?: RouterCatalogEntry[] };
      const entries = Array.isArray(body.data) ? body.data : [];
      // A catalog that reports no limits leaves the built-in default in place; name what was not
      // reported rather than let a guessed 128k window look like the provider's own number.
      const guessed = entries
        .map((entry) => ({ id: entry.id, limits: routerLimits(entry, options) }))
        .filter(({ limits }) => limits.guessed.length > 0)
        .map(({ id, limits }) => `${id} (${limits.guessed.join(", ")})`);
      if (guessed.length > 0) {
        console.log(
          `[hearth] orcarouter: ${guessed.length} model(s) report no limit, using built-in defaults: ${guessed.join("; ")}`
        );
      }
      return entries.map((entry): Model<"openai-completions"> => orcarouterModel(entry, baseUrl, options));
    },
  });
  return router;
};

/**
 * DeepInfra: pi-ai ships no provider for it, so Hearth registers an OpenAI-compatible one with
 * DeepInfra's own catalog read (`GET /models`, see ./deepinfra.ts for the field mapping).
 *
 * Registered always, like every keyed built-in: the row has to exist before a key does, or there
 * is no field to paste one into. The last good list is persisted by the model store, and the read
 * runs in the background (`refreshModels`), so boot never depends on the network. A refresh that
 * fails keeps the previous list; a first boot offline starts with none and fills in later.
 */
export const deepinfraProvider = () =>
  createProvider({
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: DEEPINFRA_BASE_URL,
    auth: { apiKey: envApiKeyAuth("DeepInfra API key", [DEEPINFRA_ENV_VAR]) },
    models: [],
    api: openAICompletionsApi(),
    fetchModels: async (ctx) => {
      const response = await fetch(`${DEEPINFRA_BASE_URL}/models`, {
        headers: catalogAuth(ctx.credential),
        signal: ctx.signal,
      });
      if (!response.ok) throw new Error(`deepinfra /models failed: ${response.status}`);
      const body = (await response.json()) as { data?: DeepInfraCatalogEntry[] };
      const entries = Array.isArray(body.data) ? body.data : [];
      const models: Model<"openai-completions">[] = [];
      const guessed: string[] = [];
      for (const entry of entries) {
        const mapped = deepinfraModel(entry);
        if (!mapped) continue;
        models.push(mapped.model);
        if (mapped.guessed.length > 0) guessed.push(`${entry.id} (${mapped.guessed.join(', ')})`);
      }
      // Say what the catalog did not report rather than let a default look like DeepInfra's number.
      if (guessed.length > 0) {
        console.log(
          `[hearth] deepinfra: ${guessed.length} model(s) report no limit, using built-in defaults: ${guessed.join('; ')}`
        );
      }
      console.log(`[hearth] deepinfra: ${models.length} chat model(s) of ${entries.length} listed`);
      return models;
    },
  });

/**
 * The Moonshot platform provider (`moonshotai`), reading `/models` at boot or refresh and falling
 * back to pi-ai's shipped Moonshot catalog offline.
 */
export const createMoonshotProvider = (options: KimiOptions = kimiOptions()) =>
  createProvider({
    id: "moonshotai",
    name: "Moonshot AI (Kimi)",
    baseUrl: options.baseUrl,
    auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["KIMI_API_KEY", "MOONSHOT_API_KEY"]) },
    models: moonshotaiProvider().getModels(),
    api: openAICompletionsApi(),
    fetchModels: (ctx) => fetchMoonshotCatalog(options, ctx.credential, ctx.signal),
  });

/**
 * Kimi under its own provider ids, holding pi-ai's Moonshot catalog as the offline list.
 *
 * `moonshotai` (platform key) additionally reads `/models` at boot and serves what the account
 * lists - the same shape as the orcarouter slot, but with the provider's real ids (`kimi-k3`
 * stays `kimi-k3`), its real windows and its image support, so a Kimi conversation survives a
 * model switch to another host's Kimi entry instead of being pinned to `orcarouter/kimi-k3`.
 *
 * `kimi-coding` (coding-plan key) keeps pi-ai's list: a plan key need not answer `/models`, and
 * its ids (`k3`, `kimi-for-coding`) are what the plan serves.
 *
 * `kimi-coding` is registered always, with or without a key. Its credential can come from a
 * subscription sign-in instead of a key (pi-ai ships "Sign in with Kimi Code"), and gating the
 * provider on a key would hide the only button that can obtain one. Registering it unkeyed is what
 * every other built-in does: calls fail with an auth error until a credential exists, and the model
 * list skips providers whose credential does not resolve.
 *
 * `moonshotai` is registered by `kimiProviders` when a key is configured (env, or a stored
 * credential), and always registered in `hearthModels` / `refreshProviders` so `GET /providers`
 * lists it and `POST /providers/moonshotai` can add a key at runtime.
 */
export const kimiProviders = (storedIds: string[], env: Record<string, string | undefined> = process.env) => {
  const options = kimiOptions(env);
  const providers = [];
  const coding = kimiCodingProvider();
  providers.push(
    createProvider({
      id: coding.id,
      name: coding.name,
      baseUrl: options.codingBaseUrl,
      // pi-ai's shipped auth, not a hand-built api-key one: `auth.oauth` is "Sign in with Kimi Code",
      // and dropping it here is what left `kimi-coding` unable to sign in at all (see ./login).
      auth: {
        apiKey: envApiKeyAuth("Kimi Code API key", ["KIMI_CODING_API_KEY", "KIMI_API_KEY"]),
        ...(coding.auth.oauth === undefined ? {} : { oauth: coding.auth.oauth }),
      },
      models: coding.getModels().map((model) => kimiCodingModel(model, options)),
      api: openAICompletionsApi(),
    })
  );
  // A stored credential (Ember's Providers settings, or `provider set`) wins; the env var is the
  // fallback, matching `envApiKeyAuth`.
  if (storedIds.includes("moonshotai") || kimiKeyPresent(["KIMI_API_KEY", "MOONSHOT_API_KEY"], env)) {
    providers.push(createMoonshotProvider(options));
  }
  return providers;
};

/**
 * Re-register conditional providers (such as `moonshotai`) after credentials change at runtime
 * (`POST /providers/:id` or `POST /providers/import`) and trigger a background catalog refresh.
 */
export const refreshProviders = async (
  models: Models & { setProvider?: (provider: ReturnType<typeof createMoonshotProvider>) => void },
  store?: CredentialStore,
  env: Record<string, string | undefined> = process.env
): Promise<void> => {
  const storedIds = store ? (await store.list().catch(() => [])).map((entry) => entry.providerId) : [];
  for (const provider of kimiProviders(storedIds, env)) {
    models.setProvider?.(provider);
  }
  if (!models.getProviders().some((provider) => provider.id === "moonshotai")) {
    models.setProvider?.(createMoonshotProvider(kimiOptions(env)));
  }
  await models.refresh({ allowNetwork: true }).catch(() => undefined);
};

/**
 * `GET /models` on the Moonshot platform (or whatever `KIMI_BASE_URL` names). A failure is
 * thrown so the provider keeps its stored dynamic list, or pi-ai's shipped catalog if there is none.
 */
export const fetchMoonshotCatalog = async (
  options: KimiOptions = kimiOptions(),
  credential?: unknown,
  signal?: AbortSignal
): Promise<Model<"openai-completions">[]> => {
  const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: catalogAuth(credential),
    signal,
  });
  if (!response.ok) throw new Error(`moonshotai /models failed: ${response.status}`);
  const body = (await response.json()) as { data?: MoonshotCatalogEntry[] };
  const entries = Array.isArray(body.data) ? body.data : [];
  if (entries.length === 0) throw new Error("moonshotai /models listed nothing");
  const guessed = entries.filter((entry) => moonshotContextWindow(entry) === undefined).map((entry) => entry.id);
  if (guessed.length > 0) {
    console.log(`[hearth] moonshotai: ${guessed.length} model(s) report no window, using 262144: ${guessed.join("; ")}`);
  }
  return entries.map((entry) => moonshotModel(entry, options));
};

/** The default agent model: HEARTH_DEFAULT_MODEL ("provider/modelId") or opencode (Zen). */
export const hearthDefault = (): HearthDefault => {
  const raw = envString("HEARTH_DEFAULT_MODEL") ?? "opencode/glm-5.3-flash";
  const separator = raw.indexOf("/");
  if (separator <= 0) return { model: { provider: "opencode", modelId: "glm-5.3-flash" } };
  return { model: { provider: raw.slice(0, separator), modelId: raw.slice(separator + 1) } };
};

/**
 * Every provider Hearth serves. Built-ins are always registered — a provider without its
 * credential simply answers its calls with an auth error and is skipped by refresh — and
 * orcarouter only when its endpoint is configured.
 */
export const hearthModels = async (
  authFile: string,
  openCodeSource?: string
): Promise<{
  models: Models;
  seeded: string[];
  store: FileCredentialStore;
  /**
   * What the local-runtime probe found at boot (Ollama, LM Studio). Not a model list: it is the
   * reason a runtime is *absent* from the picker, so a status screen can say "Ollama is running but
   * has no models" instead of leaving an empty list to interpret.
   */
  localRuntimes: LocalRuntimeProbe[];
}> => {
  const store = new FileCredentialStore(authFile);
  // Retired the env bridge: instead of copying OpenCode's keys into the environment, adopt them
  // into Hearth's own store on first boot (idempotent, no-clobber) so a device that hasn't run
  // `provider import` still works. Remove this once every device has migrated (PROVIDER_MIGRATION.md).
  const seeded = await importOpenCodeCredentials(store, openCodeSource);
  // A stored credential wins over an env var (`envApiKeyAuth` resolves stored-first); env stays
  // as the fallback. The model-catalog store lives next to the credentials so boot can restore
  // the last known lists without network access; the network refresh runs in the background
  // instead of gating startup (see `main` in ./index.ts).
  const models = createModels({
    credentials: store,
    modelsStore: new FileModelsStore(join(dirname(authFile), "models-store.json")),
  });
  // OpenCode Zen asks the service which models exist (see ./model-discovery.ts);
  // every other provider serves the catalog pi-ai ships.
  models.setProvider(openCodeZenWithDiscovery());
  models.setProvider(xaiProvider());
  models.setProvider(openaiProvider());
  // NVIDIA's NIM catalogue is free at the point of signup and rotates models regularly (a free model
  // appears and is retired without notice), so it is registered the same way every keyed provider is:
  // listed always, offered only once a credential resolves.
  models.setProvider(nvidiaProvider());
  // Subscription providers, registered so their **sign-in buttons exist at all**: `/providers` can
  // only offer what is registered, so "why is there no ChatGPT button" was really "the provider was
  // never listed". Which ones can *finish* is decided in `login.ts` (`CAN_COMPLETE`, `OBSTRUCTIONS`).
  models.setProvider(anthropicProvider());
  models.setProvider(openaiCodexProvider());
  models.setProvider(githubCopilotProvider());
  // Google Antigravity is not in pi-ai: its Cloud Code Assist transport is Hearth's own
  // (./antigravity.ts), so the provider is registered here like DeepInfra is.
  models.setProvider(antigravityProvider());
  models.setProvider(metaProvider());
  models.setProvider(openrouterProvider());
  // pi-ai has no DeepInfra provider (see ./deepinfra.ts); Hearth registers its own.
  models.setProvider(deepinfraProvider());
  models.setProvider(deepseekProvider());
  models.setProvider(googleProvider());
  models.setProvider(fireworksProvider());
  const storedIds = (await store.list().catch(() => [])).map((entry) => entry.providerId);
  for (const provider of kimiProviders(storedIds)) models.setProvider(provider);
  if (!models.getProviders().some((provider) => provider.id === "moonshotai")) {
    models.setProvider(createMoonshotProvider());
  }
  const router = orcarouterProvider();
  if (router) models.setProvider(router);
  // Local runtimes have no account, so "registered" cannot mean "has a credential" — it means
  // something is listening right now. A probe is local and cheap (loopback, 1.5s), and doing it
  // here is what keeps a stopped Ollama out of the picker instead of offering models that would
  // fail on send. The results ride along so `/providers` can explain *why* one is missing.
  const localRuntimes = await probeLocalRuntimes();
  for (const runtime of localRuntimes) {
    if (!runtime.running || !runtime.hasModels) continue;
    models.setProvider(runtime.id === "ollama" ? ollamaProvider({ baseUrl: runtime.baseUrl }) : lmStudioProvider({ baseUrl: runtime.baseUrl }));
  }
  return { models, seeded, store, localRuntimes };
};
