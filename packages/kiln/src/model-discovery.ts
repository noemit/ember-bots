import { isModelType, type Api, type Model, type ModelCost, type ModelInputLimits, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";

/**
 * Live model discovery for OpenCode's two Hearth providers: **OpenCode Go** (`opencode-go`) and
 * **OpenCode Zen** (`opencode`).
 *
 * pi-ai ships both catalogs as **static files inside the package**, so a model OpenCode adds
 * between pi-ai releases stays invisible until the dependency is bumped — and even the newest
 * pi-ai trails the services (it was 9 models behind Go and 6 behind Zen when this landed). Both
 * Hearth and pi-ai pin their versions, so rather than chase releases we ask OpenCode itself.
 *
 * `GET /inference/go/v1/models` and `GET /inference/v1/models`, authenticated with the same key
 * the provider uses, are the source of truth for *which* models exist. pi-ai stays the source of
 * truth for *how to call* a model it already describes (api, baseUrl, compat, limits). An id pi-ai
 * has never heard of is described from OpenCode's public catalog (models.dev) when it is listed
 * there, and from conservative defaults otherwise:
 *
 * - `api` (the wire API) comes from the catalog when models.dev names an endpoint this provider
 *   actually serves (its `api` URL matched against the site's base URLs — the sharpest signal,
 *   since Go and Zen serve the same ids over different protocols), else from the SDK name it
 *   gives (`npm`), and otherwise from the ids pi-ai *does* describe: every `qwen…` entry in Go is
 *   anthropic-messages, every `gpt-`/`grok-`/`muse-spark-` one is openai-responses, every
 *   `gemini…` one in Zen is google-generative-ai, and everything else speaks the endpoint's
 *   OpenAI-compatible route. A family that is mixed in the static catalog (`minimax-*` has both)
 *   or absent there falls back to openai-completions. Every inference is logged.
 * - context window, cost, reasoning and modalities come from models.dev, else 128k / 16k, zero
 *   cost, text-only, no reasoning.
 * - the *endpoint* is only half the story. models.dev publishes endpoints finer-grained than
 *   the bases the SDKs stream from, so an id whose endpoint matches no base is probed once
 *   (`probe` below) and offered only on a route of this provider's own that answered — that is
 *   how `minimax-m3.1-flash-free` arrives: models.dev names `…/inference/go/openai/v1`, and
 *   Go's own `…/inference/go/v1` answers `200`.
 * - a model needing a protocol its provider cannot stream is left out rather than offered and
 *   then failed at generation time. Both providers register four APIs (Anthropic, both OpenAI
 *   shapes and Google) as of pi-ai 1.3.0 — Go's Google API is what serves
 *   `gemini-4-argon-contributor` at `…/inference/go/v1`.
 *
 * Discovery is best-effort by construction: with no credential, offline, or on a response we
 * don't recognise, the static catalog stands untouched, so Hearth never serves an empty
 * provider. `HEARTH_DISCOVER_MODELS=0` turns it off.
 */

/** The two catalog endpoints, plus what `withDiscovery` needs to describe a model pi-ai omits. */
export type DiscoverySite = {
  providerId: string;
  /** Where the service lists its ids. */
  catalogUrl: string;
  /** api → base URL, for ids the service lists but pi-ai's static catalog doesn't describe. */
  baseUrls: Record<string, string>;
  /**
   * models.dev's per-model SDK names, mapped onto the protocols this provider registers. A name
   * that isn't here is a protocol we cannot stream, so the model is reported, not offered.
   */
  protocolsByNpm: Record<string, string>;
  /** The protocol assumed when neither the catalog nor the family decides. */
  defaultApi: string;
  /**
   * Extra endpoints this provider's own key answers on, beyond `catalogUrl`'s routes — Go serves
   * some models only at `…/inference/go/<protocol>/v1…`, which is a different path from its
   * catalog's `…/zen/go`. Each entry registers `api` and, when pi-ai already describes a model
   * with that api, reuses its base URL rather than inventing one.
   */
  routes?: Array<{ api: string; baseUrl: string }>;
  /** Whether a model listed only on a foreign endpoint may be probed for a usable route. */
  probe?: boolean;
};

export const OPENCODE_ZEN: DiscoverySite = {
  providerId: "opencode",
  catalogUrl: "https://opencode.ai/inference/v1/models",
  // The base URLs pi-ai 1.3.0 ships for this provider — the paired URLs are the ones its own Zen
  // catalog uses, so a synthesized model streams exactly like a shipped one.
  baseUrls: {
    "anthropic-messages": "https://opencode.ai/inference",
    "google-generative-ai": "https://opencode.ai/inference/v1",
    "openai-completions": "https://opencode.ai/inference/v1",
    "openai-responses": "https://opencode.ai/inference/v1",
  },
  protocolsByNpm: {
    "@ai-sdk/anthropic": "anthropic-messages",
    "@ai-sdk/google": "google-generative-ai",
    "@ai-sdk/openai": "openai-responses",
    "@ai-sdk/openai-compatible": "openai-completions",
  },
  defaultApi: "openai-completions",
};

/** OpenCode's public model catalog, keyed by provider id (`opencode`, `opencode-go`). */
export const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const CATALOG_TIMEOUT_MS = 10_000;
const METADATA_TIMEOUT_MS = 15_000;
/** Ids the services list that are not models: Zen carries a literal `test`. */
const PLACEHOLDER_IDS = new Set(["test"]);

/** What OpenCode's public catalog says about a model pi-ai doesn't describe yet. */
export type DiscoveredMetadata = {
  name?: string;
  /** The SDK models.dev says OpenCode serves this model with — i.e. its wire protocol. */
  npm?: string;
  /**
   * The endpoint models.dev says OpenCode serves this provider's models from. Only trusted when
   * it points at this Hearth provider's own host (see `apiFromCatalog`): a catalog entry that
   * names some other route's protocol would make us send the wrong shape to the right key.
   */
  endpoint?: string;
  /** True when models.dev named neither an SDK nor an endpoint for the model. */
  protocolUnlisted?: boolean;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<ModelCost>;
};

/** One id pi-ai doesn't describe: the api we gave it, and where that api came from. */
export type SynthesizedModel = {
  id: string;
  api: string;
  source: "catalog" | "family" | "default" | "probe";
  /** True when models.dev described the model, so its metadata is real rather than defaulted. */
  described: boolean;
  /**
   * True when nothing said what the model accepts, so `input` fell back to text only. Those turns
   * drop any image a client attaches (see `./images`' `blindModelReason`), so the ids belong in
   * the boot log next to the guessed apis and defaulted limits.
   */
  capabilitiesDefaulted: boolean;
};

/** The catalog to serve for one discovery round. */
export type CatalogOverlay<TApi extends Api = Api> = {
  models: Model<TApi>[];
  synthesized: SynthesizedModel[];
  /** Ids the static catalog lists but the service no longer serves. */
  dropped: string[];
  /** Ids the service serves that are not offered, each with why (a protocol, or a placeholder). */
  skipped: Array<{ id: string; reason: string }>;
  /** Ids a probe proved, and how — the boot log names them so a wrong guess stays visible. */
  probed?: ProbeResult[];
  /**
   * Ids the overlay would refuse, but which some route outside this provider might serve — the
   * caller probes these and re-overlays with the ones that answered (`proven`).
   */
  unproven: Array<{ id: string; endpoint: string }>;
};

/** A route a probe proved usable for an id: the api to speak, and where. */
export type ProvenRoute = { api: string; baseUrl: string };

/** Narrows a catalog api string to one this site can actually stream. */
const isSiteApi = (site: DiscoverySite, api: string): boolean => site.baseUrls[api] !== undefined;

/** `qwen3.8-flash` → `qwen`, `claude-haiku-5-5` → `claude`: the family an id belongs to. */
const family = (id: string): string => /^[a-z]+/.exec(id.toLowerCase())?.[0] ?? id.toLowerCase();

/**
 * The api models.dev says this provider serves the model with, or the reason we can't tell.
 *
 * models.dev describes an OpenCode model two ways: an SDK name (`npm`) and an endpoint URL
 * (`api`). Neither is reliable alone on this provider — `minimax-m3` is `@ai-sdk/anthropic` on
 * Go but a plain `…/openai/v1` endpoint on Zen, and the endpoints it publishes are finer-grained
 * than the base URLs the SDKs use (`…/inference/go/google/v1beta` vs the `…/inference/go/v1` that
 * pi-ai streams Google from). An endpoint that matches one of this site's base URLs is the
 * sharpest signal, because it says *which* route the model sits on. One that matches nothing is
 * not necessarily foreign: when the SDK name maps to a protocol this site can stream, that is the
 * protocol to speak, and the site's own base for it is where to speak it. Only when neither
 * signal names a streamable protocol is the id reported — or handed to a probe, which may find
 * that a route of the provider's own answers it anyway (see `probeRoutes`).
 */
const apiFromCatalog = (
  site: DiscoverySite,
  metadata: DiscoveredMetadata | undefined
): { api: string } | { unsupported: string } | undefined => {
  const npm = metadata?.npm;
  const fromNpm = npm !== undefined ? site.protocolsByNpm[npm] : undefined;
  if (metadata?.endpoint !== undefined) {
    const base = metadata.endpoint.replace(/\/+$/, "");
    const candidates = Object.entries(site.baseUrls)
      .filter(([, url]) => url.replace(/\/+$/, "") === base)
      .map(([api]) => api);
    if (candidates.length === 0) {
      // The endpoint names a route we don't use; the SDK name still says which protocol the model
      // speaks, and the service serves that protocol at our own base for it.
      if (fromNpm !== undefined) return { api: fromNpm };
      return { unsupported: `an endpoint Hearth cannot stream (${metadata.endpoint})` };
    }
    // One URL can front several protocols (every Zen `/v1` route does), so the endpoint alone is
    // ambiguous — the SDK name breaks the tie, and the site's default does so otherwise.
    if (candidates.length === 1) return { api: candidates[0]! };
    if (fromNpm !== undefined && candidates.includes(fromNpm)) return { api: fromNpm };
    const fallback = candidates.includes(site.defaultApi) ? site.defaultApi : candidates[0]!;
    return { api: fallback };
  }
  if (npm !== undefined) {
    if (fromNpm !== undefined) return { api: fromNpm };
    return { unsupported: npm };
  }
  // Neither an endpoint nor an SDK: nothing was said about the protocol, so the endpoint's own
  // OpenAI-compatible route is a guess we are entitled to make.
  if (metadata?.protocolUnlisted === true) return { api: site.defaultApi };
  return undefined;
};

/**
 * The wire API for a model pi-ai doesn't describe: the catalog's own answer when it has one,
 * else the family's, else the endpoint's OpenAI-compatible fallback. A catalog entry naming a
 * protocol this provider doesn't implement is reported instead of guessed.
 */
const apiForModel = (
  site: DiscoverySite,
  id: string,
  known: readonly Model<Api>[],
  metadata: DiscoveredMetadata | undefined
): { api: string; source: SynthesizedModel["source"] } | { unsupported: string } => {
  const fromCatalog = apiFromCatalog(site, metadata);
  // `apiFromCatalog` reports what it could not stream verbatim; the caller adds the "needs ".
  if (fromCatalog !== undefined) return "api" in fromCatalog ? { ...fromCatalog, source: "catalog" } : fromCatalog;
  const familyApis = new Set(known.filter((model) => family(model.id) === family(id)).map((model) => model.api));
  if (familyApis.size === 1) {
    const api = [...familyApis][0];
    if (api !== undefined && isSiteApi(site, api)) return { api, source: "family" };
  }
  return { api: site.defaultApi, source: "default" };
};

/** Default resize limits for synthesized image-capable models so pi-ai resizes images > 4.5MB instead of failing upstream. */
export const SYNTHESIZED_IMAGE_LIMITS: ModelInputLimits = {
  images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
};

/** Default thinking levels for synthesized reasoning models so Ember can offer thinking levels. */
export const SYNTHESIZED_THINKING_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: "high",
};

/** A chat model assembled from discovery metadata, with everything unknown left conservative. */
const synthesize = <TApi extends Api>(
  site: DiscoverySite,
  id: string,
  api: string,
  metadata: DiscoveredMetadata | undefined
): Model<TApi> => {
  const reasoning = metadata?.reasoning ?? false;
  const input = metadata?.input ?? ["text"];
  return {
    id,
    name: metadata?.name ?? id,
    // `api` is either a catalog protocol or one of this site's own base URLs.
    api: api as TApi,
    provider: site.providerId,
    baseUrl: site.baseUrls[api] ?? site.baseUrls[site.defaultApi]!,
    reasoning,
    input,
    cost: {
      input: metadata?.cost?.input ?? 0,
      output: metadata?.cost?.output ?? 0,
      cacheRead: metadata?.cost?.cacheRead ?? 0,
      cacheWrite: metadata?.cost?.cacheWrite ?? 0,
    },
    contextWindow: metadata?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: metadata?.maxTokens ?? DEFAULT_MAX_TOKENS,
    type: "chat",
    ...(reasoning ? { thinkingLevelMap: SYNTHESIZED_THINKING_LEVELS } : {}),
    ...(input.includes("image") ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
  };
};

/**
 * Merge the live id list into the static catalog: pi-ai's entries for everything it already
 * describes (they carry api, compat and limits), synthesized entries for the rest, and nothing
 * for ids the service dropped. Static order comes first so the picker barely moves; new models
 * are appended in the order the service lists them. Pure, so it is tested without a network.
 */
export const overlayCatalog = <TApi extends Api>(
  site: DiscoverySite,
  staticModels: readonly Model<TApi>[],
  liveIds: readonly string[],
  metadata: ReadonlyMap<string, DiscoveredMetadata>,
  proven: ReadonlyMap<string, ProvenRoute> = new Map()
): CatalogOverlay<TApi> => {
  const live = new Set(liveIds);
  const described = new Map(staticModels.map((model) => [model.id, model]));
  const models: Model<TApi>[] = staticModels.filter((model) => live.has(model.id));
  const synthesized: SynthesizedModel[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const unproven: Array<{ id: string; endpoint: string }> = [];
  for (const id of liveIds) {
    if (described.has(id)) continue;
    if (PLACEHOLDER_IDS.has(id)) {
      skipped.push({ id, reason: "placeholder, not a model" });
      continue;
    }
    const found = metadata.get(id);
    const route = proven.get(id);
    const picked = route !== undefined ? { ...route, source: "probe" as const } : apiForModel(site, id, staticModels, found);
    if ("unsupported" in picked) {
      // An endpoint this provider doesn't serve may still be servable by *some* route: the caller
      // proves it (see `probeRoutes`) and re-overlays, or the id stays unoffered.
      const endpoint = found?.endpoint;
      if (endpoint !== undefined && site.probe === true) unproven.push({ id, endpoint });
      else skipped.push({ id, reason: `needs ${picked.unsupported}` });
      continue;
    }
    const model = synthesize<TApi>(site, id, picked.api, found);
    if (route !== undefined) model.baseUrl = route.baseUrl;
    models.push(model);
    synthesized.push({
      id,
      api: picked.api,
      source: picked.source,
      described: found !== undefined,
      capabilitiesDefaulted: found?.input === undefined,
    });
  }
  const dropped = staticModels.filter((model) => !live.has(model.id)).map((model) => model.id);
  return { models, synthesized, dropped, skipped, unproven };
};

/** `id → metadata` for one provider out of a models.dev catalog body. Pure, so tests can feed a fixture. */
export const catalogMetadata = (providerId: string, catalog: unknown): Map<string, DiscoveredMetadata> => {
  const entries = (catalog as Record<string, { models?: Record<string, unknown> } | undefined> | null)?.[providerId]?.models;
  const metadata = new Map<string, DiscoveredMetadata>();
  if (!entries || typeof entries !== "object") return metadata;
  for (const [id, raw] of Object.entries(entries)) {
    const entry = raw as {
      name?: unknown;
      reasoning?: unknown;
      provider?: { npm?: unknown; api?: unknown };
      modalities?: { input?: unknown };
      limit?: { context?: unknown; output?: unknown };
      cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
    };
    const number = (value: unknown): number | undefined => (typeof value === "number" && value >= 0 ? value : undefined);
    const input = Array.isArray(entry.modalities?.input)
      ? entry.modalities.input.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image")
      : undefined;
    const npm = entry.provider?.npm;
    const endpoint = entry.provider?.api;
    const named = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    metadata.set(id, {
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined,
      npm: named(npm),
      endpoint: named(endpoint),
      protocolUnlisted: named(npm) === undefined && named(endpoint) === undefined,
      reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
      input: input && input.length > 0 ? input : undefined,
      contextWindow: number(entry.limit?.context),
      maxTokens: number(entry.limit?.output),
      cost: {
        input: number(entry.cost?.input),
        output: number(entry.cost?.output),
        cacheRead: number(entry.cost?.cache_read),
        cacheWrite: number(entry.cost?.cache_write),
      },
    });
  }
  return metadata;
};

/** One GET with a caller-independent deadline, so a slow upstream can't stall startup. */
const getJson = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetch(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json();
};

/** The ids a service currently serves, authenticated with the provider's key. */
export const fetchCatalogIds = async (site: DiscoverySite, key: string, signal?: AbortSignal): Promise<string[]> => {
  // OpenCode asks clients to identify themselves (and to send a session id on generations; a
  // catalog listing needs none) — see https://opencode.ai/v2/docs/console/go/.
  const body = await getJson(site.catalogUrl, { authorization: `Bearer ${key}`, "user-agent": "hearth" }, CATALOG_TIMEOUT_MS, signal);
  const data = (body as { data?: Array<{ id?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) throw new Error(`${site.catalogUrl} did not return a model list`);
  return [...new Set(data.map((entry) => entry?.id).filter((id): id is string => typeof id === "string" && id.length > 0))];
};

/** Metadata for the given ids from OpenCode's public catalog (a large body; only fetched when needed). */
export const fetchCatalogMetadata = async (
  site: DiscoverySite,
  ids: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, DiscoveredMetadata>> => {
  const catalog = catalogMetadata(site.providerId, await getJson(MODELS_DEV_URL, {}, METADATA_TIMEOUT_MS, signal));
  const wanted = new Set(ids);
  return new Map([...catalog].filter(([id]) => wanted.has(id)));
};

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 4;
/** How an id's route got proven, for the boot log. */
export type ProbeResult = { id: string; route: ProvenRoute; detail: string; requests: number };

/**
 * Prove which of this provider's own endpoints answer for ids models.dev placed on an endpoint
 * the key is refused on. It sends one minimal, real completion per (id, route) and keeps the
 * first route that answers `ok`; anything else (a refusal, a protocol error, a timeout) rules
 * that route out. Costs a handful of tiny requests, once per id, on the boot that first sees it
 * — `site.routes` is the closed set of candidates, so a model is never discovered by probing.
 */
export const probeRoutes = async (
  site: DiscoverySite,
  key: string,
  ids: ReadonlyArray<{ id: string; endpoint: string }>,
  routes: ReadonlyArray<{ api: string; baseUrl: string }>,
  signal?: AbortSignal
): Promise<Map<string, ProbeResult>> => {
  const proven = new Map<string, ProbeResult>();
  const queue = [...ids];
  // Four at a time: a boot that first sees a new batch must not fire two dozen requests at once.
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const { id, endpoint } = next;
      let requests = 0;
      for (const route of routes) {
        if (signal?.aborted) return;
        requests += 1;
        const detail = await probeCompletion(route, key, id, signal);
        if (detail === "ok") {
          proven.set(id, { id, route, requests, detail: `${route.api} at ${route.baseUrl}` });
          break;
        }
        // A refusal is about the route, not this id: another protocol at the same host may still
        // answer (`ModelProtocolUnsupported` is per protocol), so keep going.
      }
      if (!proven.has(id)) {
        console.log(`[hearth] ${site.providerId} probe: ${id} answers on none of this provider's routes (catalog says ${endpoint})`);
      }
    }
  });
  await Promise.all(workers);
  return proven;
};

/** One capped completion. `ok`, or why the route can't serve the id. */
const probeCompletion = async (
  route: { api: string; baseUrl: string },
  key: string,
  id: string,
  signal?: AbortSignal
): Promise<string> => {
  // Every OpenCode route speaks the OpenAI chat shape on the wire except anthropic-messages,
  // whose /v1/messages body differs; both are cheap to build and both are real requests.
  const anthropic = route.api === "anthropic-messages";
  const url = anthropic ? `${route.baseUrl.replace(/\/+$/, "")}/messages` : `${route.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = anthropic
    ? { model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }
    : { model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "user-agent": "hearth",
        "x-opencode-session": crypto.randomUUID(),
        ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return `refused ${response.status}`;
    // Drain, so the connection isn't left half-read under a keep-alive agent.
    await response.text();
    return "ok";
  } catch (error) {
    return `no answer (${error instanceof Error ? error.message : error})`;
  }
};

/**
 * One discovery round: the live id list, then metadata for the ids pi-ai can't describe, then a
 * probe of the ones only a foreign endpoint describes. Throws when the catalog is unusable — the
 * caller keeps the static catalog in that case.
 */
export const liveCatalog = async <TApi extends Api>(
  site: DiscoverySite,
  staticModels: readonly Model<TApi>[],
  key: string,
  signal?: AbortSignal
): Promise<CatalogOverlay<TApi>> => {
  const ids = await fetchCatalogIds(site, key, signal);
  if (ids.length === 0) throw new Error(`${site.catalogUrl} listed no models`);
  const unknown = ids.filter((id) => !staticModels.some((model) => model.id === id));
  const metadata = unknown.length > 0 ? await fetchCatalogMetadata(site, unknown, signal).catch(() => new Map<string, DiscoveredMetadata>()) : new Map();
  const first = overlayCatalog(site, staticModels, ids, metadata);
  if (first.unproven.length === 0 || !site.routes?.length) return first;
  // Only ids whose catalog protocol is a *foreign* endpoint are worth a probe; an id that needs a
  // protocol we refuse for its own route is left refused.
  const probes = await probeRoutes(site, key, first.unproven, site.routes, signal);
  if (probes.size === 0) return first;
  const proven = new Map([...probes].map(([id, result]) => [id, result.route]));
  const overlay = overlayCatalog(site, staticModels, ids, metadata, proven);
  overlay.probed = [...probes.values()];
  return overlay;
};

const discoveryEnabled = (): boolean => {
  const value = process.env.HEARTH_DISCOVER_MODELS?.trim().toLowerCase();
  return !value || !["0", "false", "no", "off"].includes(value);
};

/**
 * pi-ai's provider plus discovery. Everything but the catalog is the built-in provider untouched
 * (`stream` resolves the wire API per model from pi-ai's own map, so a synthesized model streams
 * through the same implementation as a shipped one); the wrapper only replaces the chat catalog —
 * non-chat models, such as Zen's classifiers, stay exactly as pi-ai lists them — and adds
 * `refreshModels`, which pi-ai runs on every boot, before the server answers, so `GET /models` is
 * already up to date.
 */
export const withDiscovery = <TApi extends Api>(provider: Provider<TApi>, site: DiscoverySite): Provider<TApi> => {
  const shipped = provider.getModels();
  const other = (provider.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat"));
  // undefined means "nothing discovered yet": the static catalog is served as-is.
  let discovered: readonly Model<TApi>[] | undefined;
  const chat = (): readonly Model<TApi>[] => discovered ?? shipped;

  return {
    ...provider,
    getModels: chat,
    getAllModels: () => [...chat(), ...other],
    refreshModels: async (context) => {
      // Offline phase: pi-ai replays whatever the store holds from an earlier run, which is all
      // we have before the network is allowed. Only our own rounds are stored, so the narrowing
      // cast is safe.
      const stored = context.stored?.models.filter(
        (model) => model.provider === site.providerId && isModelType(model, "chat")
      ) as unknown as Model<TApi>[] | undefined;
      if (stored !== undefined && stored.length > 0) await context.publish({ update: () => (discovered = stored) });
      if (!context.allowNetwork || context.signal.aborted) return;
      if (!discoveryEnabled()) {
        console.log(`[hearth] ${site.providerId} discovery off (HEARTH_DISCOVER_MODELS) — serving pi-ai's catalog`);
        return;
      }
      // Without a key there is nothing to ask the service with (a stored key and OPENCODE_API_KEY
      // both surface here, resolved by pi-ai).
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : undefined;
      if (key === undefined) return;
      const overlay = await liveCatalog(site, shipped, key, context.signal).catch((error: unknown) => {
        console.log(`[hearth] ${site.providerId} discovery skipped (${error instanceof Error ? error.message : error})`);
        return undefined;
      });
      if (!overlay) return;
      report(site, overlay, shipped.length);
      await context.publish({
        persist: { models: overlay.models, checkedAt: Date.now() },
        update: () => (discovered = overlay.models),
      });
    },
  };
};

/** OpenCode Zen: discovery over pi-ai's `opencode` provider. */
export const openCodeZenWithDiscovery = () => withDiscovery(opencodeProvider(), OPENCODE_ZEN);

/** Says what discovery changed, and which of the synthesized ids are guesses. */
const report = <TApi extends Api>(site: DiscoverySite, overlay: CatalogOverlay<TApi>, staticCount: number): void => {
  const dropped = overlay.dropped.length > 0 ? `, dropped ${overlay.dropped.join(", ")}` : "";
  console.log(`[hearth] ${site.providerId} catalog: ${overlay.models.length} model(s), ${staticCount} described by pi-ai${dropped}`);
  if (overlay.synthesized.length === 0) return;
  console.log(
    `[hearth] ${site.providerId} discovered: ${overlay.synthesized.map((model) => `${model.id}→${model.api}`).join(", ")}`
  );
  // Two different uncertainties, worth telling apart when a model misbehaves: the wire API
  // (raised by unknown/mixed families) and the metadata (ids missing from models.dev).
  const guessed = overlay.synthesized.filter((model) => model.source === "default").map((model) => model.id);
  if (guessed.length > 0) console.log(`[hearth] ${site.providerId} api guessed (${site.defaultApi}): ${guessed.join(", ")}`);
  const defaulted = overlay.synthesized.filter((model) => !model.described).map((model) => model.id);
  if (defaulted.length > 0) {
    const limits = `${DEFAULT_CONTEXT_WINDOW} ctx / ${DEFAULT_MAX_TOKENS} max`;
    console.log(`[hearth] ${site.providerId} limits defaulted (${limits}): ${defaulted.join(", ")}`);
  }
  // Nothing said what these accept, so they are served text only — and a client's image is dropped
  // for them without an error. Named separately from the defaulted limits: this one changes what a
  // turn can carry, and is worth verifying against the service before trusting it.
  const blind = overlay.synthesized.filter((model) => model.capabilitiesDefaulted).map((model) => model.id);
  if (blind.length > 0) {
    console.log(`[hearth] ${site.providerId} image input unknown, served as text only: ${blind.join(", ")}`);
  }
  for (const result of overlay.probed ?? []) {
    console.log(
      `[hearth] ${site.providerId} probed: ${result.id} answers on ${result.detail} (${result.requests} request(s), catalog listed it elsewhere)`
    );
  }
  if (overlay.skipped.length > 0) {
    console.log(`[hearth] ${site.providerId} not offered: ${overlay.skipped.map((model) => `${model.id} (${model.reason})`).join(", ")}`);
  }
};
