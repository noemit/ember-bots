import {
  isModelType,
  type Api,
  type Credential,
  type Model,
  type ModelCost,
  type ModelInputLimits,
  type Provider,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { SYNTHESIZED_IMAGE_LIMITS, SYNTHESIZED_THINKING_LEVELS } from "./model-discovery";

/**
 * Live catalog discovery for built-in providers whose `@earendil-works/pi-ai` definitions ship
 * static build-time model snapshots.
 *
 * When a provider releases a model, two sources learn about it before a new Kiln binary ships:
 *
 * 1. **The provider's own `/models` endpoint**, which lists the new id on minute zero (often
 *    before public metadata catalogs merge a pull request).
 * 2. **`models.dev`**, which publishes tool-call support, reasoning effort levels, modalities,
 *    context/output limits and pricing across providers — including OAuth-backed providers or
 *    scoped API keys that cannot call `/v1/models`.
 *
 * Each wrapper keeps `pi-ai`'s shipped chat models intact (their battle-tested `compat`,
 * `headers`, `promptCache` and `thinkingLevelMap` win whenever an id is already known), overlays
 * new tool-capable chat models from `models.dev` and the provider's live `/models`, and persists
 * the result in `$HEARTH_HOME/models-store.json`. Offline or on error, the previous or shipped
 * catalog stands untouched.
 */

export const MODELS_DEV_V2_URL = "https://models.dev/experimental/v2.0/api.json";
export const MODELS_DEV_V1_URL = "https://models.dev/api.json";

const UPSTREAM_TIMEOUT_MS = 6_000;
const OPENROUTER_TIMEOUT_MS = 8_000;
const MODELS_DEV_TIMEOUT_MS = 8_000;
/** Coalesce concurrent provider refreshes within one manual Refresh click onto a single fetch. */
const FORCE_COALESCE_MS = 3_000;
const BACKGROUND_TTL_MS = 5 * 60_000;

const SELECTABLE_EFFORTS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export type NormalizedCatalogModel = {
  id: string;
  name: string;
  status?: string;
  toolCall: boolean;
  reasoning: boolean;
  efforts?: ReadonlyArray<ThinkingLevel | "none">;
  imageInput: boolean;
  textInput: boolean;
  textOutput: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost: ModelCost;
  protocols: string[];
};

export type ModelsDevSnapshot = ReadonlyMap<string, ReadonlyMap<string, NormalizedCatalogModel>>;

export type ModelsDevCache = {
  get(signal?: AbortSignal, force?: boolean): Promise<ModelsDevSnapshot | undefined>;
  clear(): void;
};

const discoveryEnabled = (): boolean => {
  const value = process.env.HEARTH_DISCOVER_MODELS?.trim().toLowerCase();
  return !value || !["0", "false", "no", "off"].includes(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const trimmed = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const zeroCost = (): ModelCost => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const timedSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

const fetchJson = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetch(url, { headers, signal: timedSignal(signal, timeoutMs) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json();
};

const firstCacheWritePrice = (cache: Record<string, unknown> | undefined): number | undefined => {
  if (!cache) return undefined;
  const pick = (raw: unknown): number | undefined => {
    if (typeof raw === "number") return nonNegativeNumber(raw);
    if (isRecord(raw)) {
      for (const value of Object.values(raw)) {
        const num = nonNegativeNumber(value);
        if (num !== undefined) return num;
      }
    }
    return undefined;
  };
  return pick(cache.write) ?? (isRecord(cache.explicit) ? pick(cache.explicit.write) : undefined);
};

const parseV2Cost = (rawCost: unknown): ModelCost => {
  if (!isRecord(rawCost) || !isRecord(rawCost.text)) return zeroCost();
  const input = isRecord(rawCost.text.input) ? rawCost.text.input : undefined;
  const output = isRecord(rawCost.text.output) ? rawCost.text.output : undefined;
  if (!input || !output) return zeroCost();
  if ((input.unit !== undefined && input.unit !== "token") || (output.unit !== undefined && output.unit !== "token")) {
    return zeroCost();
  }
  const baseInput = nonNegativeNumber(input.price) ?? 0;
  const baseOutput = nonNegativeNumber(output.price) ?? 0;
  const inputCache = isRecord(input.cache) ? input.cache : undefined;
  const explicitCache = inputCache && isRecord(inputCache.explicit) ? inputCache.explicit : undefined;
  const baseCacheRead = nonNegativeNumber(inputCache?.read) ?? nonNegativeNumber(explicitCache?.read) ?? 0;
  const baseCacheWrite = firstCacheWritePrice(inputCache) ?? 0;

  const tiersByThreshold = new Map<number, { above: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>();
  const contextThreshold = (when: unknown): number | undefined => {
    if (!isRecord(when) || Object.keys(when).length !== 1 || !isRecord(when.context)) return undefined;
    return nonNegativeNumber(when.context.gt ?? when.context.gte);
  };
  if (Array.isArray(input.overrides)) {
    for (const override of input.overrides) {
      if (!isRecord(override)) continue;
      const above = contextThreshold(override.when);
      if (above === undefined) continue;
      const tier = tiersByThreshold.get(above) ?? { above };
      const price = nonNegativeNumber(override.price);
      if (price !== undefined) tier.input = price;
      const cache = isRecord(override.cache) ? override.cache : undefined;
      const cacheRead = nonNegativeNumber(cache?.read);
      if (cacheRead !== undefined) tier.cacheRead = cacheRead;
      const cacheWrite = firstCacheWritePrice(cache);
      if (cacheWrite !== undefined) tier.cacheWrite = cacheWrite;
      tiersByThreshold.set(above, tier);
    }
  }
  if (Array.isArray(output.overrides)) {
    for (const override of output.overrides) {
      if (!isRecord(override)) continue;
      const above = contextThreshold(override.when);
      if (above === undefined) continue;
      const tier = tiersByThreshold.get(above) ?? { above };
      const price = nonNegativeNumber(override.price);
      if (price !== undefined) tier.output = price;
      tiersByThreshold.set(above, tier);
    }
  }
  const tiers = [...tiersByThreshold.values()].map((tier) => ({
    inputTokensAbove: tier.above,
    input: tier.input ?? baseInput,
    output: tier.output ?? baseOutput,
    cacheRead: tier.cacheRead ?? baseCacheRead,
    cacheWrite: tier.cacheWrite ?? baseCacheWrite,
  }));
  return tiers.length > 0
    ? { input: baseInput, output: baseOutput, cacheRead: baseCacheRead, cacheWrite: baseCacheWrite, tiers }
    : { input: baseInput, output: baseOutput, cacheRead: baseCacheRead, cacheWrite: baseCacheWrite };
};

const parseV1Cost = (rawCost: unknown): ModelCost => {
  if (!isRecord(rawCost)) return zeroCost();
  return {
    input: nonNegativeNumber(rawCost.input) ?? 0,
    output: nonNegativeNumber(rawCost.output) ?? 0,
    cacheRead: nonNegativeNumber(rawCost.cache_read) ?? 0,
    cacheWrite: nonNegativeNumber(rawCost.cache_write) ?? 0,
  };
};

const parseEffortList = (raw: unknown): ReadonlyArray<ThinkingLevel | "none"> | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(["none", ...SELECTABLE_EFFORTS]);
  const parsed = raw.filter((entry): entry is ThinkingLevel | "none" => typeof entry === "string" && allowed.has(entry));
  return parsed.length > 0 ? parsed : undefined;
};

export const effortThinkingLevelMap = (
  efforts: ReadonlyArray<ThinkingLevel | "none"> | undefined,
  mandatory?: boolean
): ThinkingLevelMap | undefined => {
  if (!efforts || efforts.length === 0) return mandatory ? { off: null } : undefined;
  const supported = new Set(efforts);
  if (!SELECTABLE_EFFORTS.some((level) => supported.has(level)) && !supported.has("none")) {
    return mandatory ? { off: null } : undefined;
  }
  const map: ThinkingLevelMap = {
    off: mandatory ? null : supported.has("none") ? "none" : null,
  };
  for (const level of SELECTABLE_EFFORTS) {
    map[level] = supported.has(level) ? level : null;
  }
  return map;
};

/** Parse either models.dev v2 (`capabilities`, `type`) or v1 (`tool_call`, `reasoning`) into one map. */
export const parseModelsDevSnapshot = (body: unknown): ModelsDevSnapshot => {
  const result = new Map<string, Map<string, NormalizedCatalogModel>>();
  if (!isRecord(body)) return result;
  for (const [providerId, providerValue] of Object.entries(body)) {
    if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue;
    const models = new Map<string, NormalizedCatalogModel>();
    for (const [keyId, raw] of Object.entries(providerValue.models)) {
      if (!isRecord(raw)) continue;
      const id = trimmed(raw.id) ?? keyId;
      if (!id) continue;
      const isV2 = typeof raw.type === "string" || isRecord(raw.capabilities);
      if (isV2 && raw.type !== undefined && raw.type !== "chat") continue;
      const modalities = isRecord(raw.modalities) ? raw.modalities : undefined;
      const inputMods = Array.isArray(modalities?.input) ? modalities.input.filter((m): m is string => typeof m === "string") : ["text"];
      const outputMods = Array.isArray(modalities?.output) ? modalities.output.filter((m): m is string => typeof m === "string") : ["text"];
      const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
      const toolsCap = capabilities && isRecord(capabilities.tools) ? capabilities.tools : undefined;
      const reasoningCap = capabilities && isRecord(capabilities.reasoning) ? capabilities.reasoning : undefined;
      const toolCall = isV2 ? toolsCap?.supported === true : raw.tool_call === true;
      const reasoning = isV2 ? reasoningCap?.supported === true : raw.reasoning === true;
      const efforts = isV2 ? parseEffortList(reasoningCap?.effort) : undefined;
      const limit = isRecord(raw.limit) ? raw.limit : undefined;
      const protocols = isRecord(raw.api) ? Object.keys(raw.api) : [];
      models.set(id, {
        id,
        name: trimmed(raw.name) ?? id,
        status: trimmed(raw.status),
        toolCall,
        reasoning,
        ...(efforts ? { efforts } : {}),
        imageInput: inputMods.some((m) => m === "image" || m.startsWith("image/")),
        textInput: inputMods.includes("text"),
        textOutput: outputMods.includes("text"),
        contextWindow: positiveInt(limit?.context),
        maxTokens: positiveInt(limit?.output),
        cost: isV2 ? parseV2Cost(raw.cost) : parseV1Cost(raw.cost),
        protocols,
      });
    }
    if (models.size > 0) result.set(providerId, models);
  }
  return result;
};

export const createModelsDevCache = (urls: readonly string[] = [MODELS_DEV_V2_URL, MODELS_DEV_V1_URL]): ModelsDevCache => {
  let cached: { snapshot: ModelsDevSnapshot; fetchedAt: number } | undefined;
  let inFlight: Promise<ModelsDevSnapshot | undefined> | undefined;

  return {
    async get(signal?: AbortSignal, force?: boolean): Promise<ModelsDevSnapshot | undefined> {
      const now = Date.now();
      const ttl = force ? FORCE_COALESCE_MS : BACKGROUND_TTL_MS;
      if (cached && now - cached.fetchedAt < ttl) return cached.snapshot;
      if (inFlight) return inFlight;

      const load = (async (): Promise<ModelsDevSnapshot | undefined> => {
        for (const url of urls) {
          if (signal?.aborted) return cached?.snapshot;
          try {
            const parsed = parseModelsDevSnapshot(await fetchJson(url, {}, MODELS_DEV_TIMEOUT_MS, signal));
            if (parsed.size > 0) {
              cached = { snapshot: parsed, fetchedAt: Date.now() };
              return parsed;
            }
          } catch {
            // Fall through to the fallback catalog URL or the previous snapshot.
          }
        }
        return cached?.snapshot;
      })();

      inFlight = load.finally(() => {
        if (inFlight === load) inFlight = undefined;
      });
      return inFlight;
    },
    clear(): void {
      cached = undefined;
      inFlight = undefined;
    },
  };
};

type LiveDiscoveredEntry = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  efforts?: ReadonlyArray<ThinkingLevel | "none">;
  imageInput?: boolean;
};

type AdditiveDiscoverySpec<TApi extends Api> = {
  providerId: string;
  modelsDevId?: string;
  /** Optional protocol filter on models.dev v2 entries (e.g. "responses" for direct OpenAI). */
  modelsDevProtocol?: string;
  modelsDevCache?: ModelsDevCache;
  includeCatalogEntry?: (entry: NormalizedCatalogModel) => boolean;
  fetchLiveEntries?: (credential: Credential, baseUrl: string | undefined, signal: AbortSignal) => Promise<LiveDiscoveredEntry[] | undefined>;
  includeLiveEntry?: (entry: LiveDiscoveredEntry, knownIds: ReadonlySet<string>) => boolean;
  /** When true, only offer models.dev entries that the live `/models` response also listed (if live succeeded). */
  intersectModelsDevWithLive?: boolean;
  synthesizeModel: (id: string, catalog: NormalizedCatalogModel | undefined, live: LiveDiscoveredEntry | undefined, shipped: readonly Model<TApi>[]) => Model<TApi> | undefined;
};

/**
 * Wrap a static `pi-ai` provider with additive live discovery:
 * - preserves every shipped chat model and non-chat model (classifiers, image generators),
 * - appends new chat models discovered from `models.dev` and/or the provider's `/models` endpoint,
 * - persists discovered chat models in `$HEARTH_HOME/models-store.json`.
 */
const withAdditiveDiscovery = <TApi extends Api>(
  provider: Provider<TApi>,
  spec: AdditiveDiscoverySpec<TApi>
): Provider<TApi> => {
  const shipped = provider.getModels();
  const nonChat = (provider.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat"));
  let dynamicModels: readonly Model<TApi>[] | undefined;

  const chat = (): readonly Model<TApi>[] => dynamicModels ?? shipped;

  return {
    ...provider,
    getModels: chat,
    getAllModels: () => [...chat(), ...nonChat],
    refreshModels: async (context) => {
      const stored = context.stored?.models.filter(
        (model) => model.provider === spec.providerId && isModelType(model, "chat")
      ) as unknown as Model<TApi>[] | undefined;
      if (stored !== undefined && stored.length > 0) {
        const mergedStored = mergeAdditive(shipped, stored);
        if (!(await context.publish({ update: () => { dynamicModels = mergedStored; } }))) return;
      }
      if (!context.allowNetwork || context.signal.aborted || !discoveryEnabled()) return;
      if (!context.credential) return;

      const [snapshot, liveEntries] = await Promise.all([
        spec.modelsDevId && spec.modelsDevCache
          ? spec.modelsDevCache.get(context.signal, context.force).catch(() => undefined)
          : Promise.resolve(undefined),
        spec.fetchLiveEntries
          ? spec.fetchLiveEntries(context.credential, context.baseUrl ?? provider.baseUrl, context.signal).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (context.signal.aborted) return;

      const catalogMap = spec.modelsDevId ? snapshot?.get(spec.modelsDevId) : undefined;
      if (!catalogMap && !liveEntries) return;

      const knownIds = new Set(shipped.map((model) => model.id));
      const liveById = new Map<string, LiveDiscoveredEntry>();
      for (const entry of liveEntries ?? []) {
        if (!liveById.has(entry.id)) liveById.set(entry.id, entry);
      }

      const additions: Model<TApi>[] = [];
      const addedIds = new Set<string>();

      if (catalogMap) {
        for (const entry of catalogMap.values()) {
          if (knownIds.has(entry.id) || addedIds.has(entry.id)) continue;
          if (!entry.toolCall || !entry.textInput || !entry.textOutput) continue;
          if (entry.status === "deprecated") continue;
          if (spec.modelsDevProtocol && entry.protocols.length > 0 && !entry.protocols.includes(spec.modelsDevProtocol)) {
            continue;
          }
          if (spec.intersectModelsDevWithLive && liveEntries && !liveById.has(entry.id)) continue;
          if (spec.includeCatalogEntry && !spec.includeCatalogEntry(entry)) continue;
          const synthesized = spec.synthesizeModel(entry.id, entry, liveById.get(entry.id), shipped);
          if (!synthesized) continue;
          additions.push(synthesized);
          addedIds.add(synthesized.id);
        }
      }

      if (liveEntries) {
        const alreadyPlaced = new Set([...knownIds, ...addedIds]);
        for (const live of liveEntries) {
          if (alreadyPlaced.has(live.id)) continue;
          if (spec.includeLiveEntry && !spec.includeLiveEntry(live, alreadyPlaced)) continue;
          const synthesized = spec.synthesizeModel(live.id, catalogMap?.get(live.id), live, shipped);
          if (!synthesized) continue;
          additions.push(synthesized);
          alreadyPlaced.add(synthesized.id);
        }
      }

      const nextModels = [...shipped, ...additions];
      if (additions.length > 0) {
        console.log(
          `[hearth] ${spec.providerId} discovered ${additions.length} new model(s): ${additions.map((m) => m.id).join(", ")}`
        );
      }
      await context.publish({
        persist: { models: nextModels, checkedAt: Date.now() },
        update: () => {
          dynamicModels = nextModels;
        },
      });
    },
  };
};

const mergeAdditive = <TApi extends Api>(
  shipped: readonly Model<TApi>[],
  stored: readonly Model<TApi>[]
): Model<TApi>[] => {
  const byShipped = new Set(shipped.map((model) => model.id));
  const extra = stored.filter((model) => !byShipped.has(model.id));
  return [...shipped, ...extra];
};

const openAiListEntries = async (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Array<Record<string, unknown>>> => {
  const body = await fetchJson(url, headers, UPSTREAM_TIMEOUT_MS, signal);
  const list = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : undefined;
  if (!list) throw new Error(`${url} did not return a model list`);
  return list.filter(isRecord);
};

// ---- 1. Anthropic --------------------------------------------------------------------

const ANTHROPIC_IMAGE_LIMITS: ModelInputLimits = {
  maxRequestBytes: 32 * 1024 * 1024,
  images: { maxPerRequest: 100, ...SYNTHESIZED_IMAGE_LIMITS.images },
};

const isModernClaudeAdaptive = (id: string): boolean =>
  /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[.-][789]|[5-9])/i.test(id);

export const anthropicWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(anthropicProvider(), {
    providerId: "anthropic",
    modelsDevId: "anthropic",
    modelsDevCache,
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
      const items = await openAiListEntries(
        `${host}/v1/models?limit=1000`,
        { "x-api-key": credential.key, "anthropic-version": "2023-06-01" },
        signal
      );
      return items
        .map((item): LiveDiscoveredEntry | undefined => {
          const id = trimmed(item.id);
          if (!id) return undefined;
          const caps = isRecord(item.capabilities) ? item.capabilities : undefined;
          const imageCap = caps && isRecord(caps.image_input) ? caps.image_input : undefined;
          const thinkingCap = caps && isRecord(caps.thinking) ? caps.thinking : undefined;
          return {
            id,
            name: trimmed(item.display_name),
            contextWindow: positiveInt(item.max_input_tokens),
            maxTokens: positiveInt(item.max_tokens),
            reasoning: typeof thinkingCap?.supported === "boolean" ? thinkingCap.supported : undefined,
            imageInput: typeof imageCap?.supported === "boolean" ? imageCap.supported : undefined,
          };
        })
        .filter((entry): entry is LiveDiscoveredEntry => entry !== undefined);
    },
    includeLiveEntry: (entry) => /^claude-/i.test(entry.id),
    synthesizeModel: (id, catalog, live) => {
      const adaptive = isModernClaudeAdaptive(id);
      const reasoning = catalog?.reasoning ?? live?.reasoning ?? adaptive;
      const imageInput = catalog?.imageInput ?? live?.imageInput ?? true;
      const input: Array<"text" | "image"> = imageInput ? ["text", "image"] : ["text"];
      const thinkingLevelMap =
        effortThinkingLevelMap(catalog?.efforts) ??
        (adaptive
          ? {
              ...(id.toLowerCase().includes("haiku") ? {} : { off: null }),
              minimal: null,
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            }
          : reasoning
            ? SYNTHESIZED_THINKING_LEVELS
            : undefined);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? live?.name ?? id,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input,
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? live?.contextWindow ?? 200_000,
        maxTokens: catalog?.maxTokens ?? live?.maxTokens ?? 64_000,
        promptCache: { short: 300, long: 3600 },
        compat: {
          supportsStrictTools: true,
          ...(adaptive
            ? {
                forceAdaptiveThinking: true,
                supportsTemperature: false,
                supportsMidConvoSystemMessages: true,
                supportsMidConvoToolChanges: true,
              }
            : {}),
        },
        ...(imageInput ? { inputLimits: ANTHROPIC_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 2. OpenAI -----------------------------------------------------------------------

const OPENAI_IMAGE_LIMITS: ModelInputLimits = {
  maxRequestBytes: 512 * 1024 * 1024,
  images: { maxPerRequest: 1500, ...SYNTHESIZED_IMAGE_LIMITS.images },
};

const OPENAI_EXCLUDED = new Set(["gpt-5.6"]);
const OPENAI_NON_CHAT_RE =
  /(?:realtime|audio|transcribe|tts|whisper|embedding|moderation|image|dall-e|sora|search|instruct|babbage|davinci|computer-use)/i;

export const openaiWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(openaiProvider(), {
    providerId: "openai",
    modelsDevId: "openai",
    modelsDevProtocol: "responses",
    modelsDevCache,
    includeCatalogEntry: (entry) => !OPENAI_EXCLUDED.has(entry.id) && !OPENAI_NON_CHAT_RE.test(entry.id),
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
      const items = await openAiListEntries(`${host}/models`, { Authorization: `Bearer ${credential.key}` }, signal);
      return items
        .map((item) => trimmed(item.id))
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id }));
    },
    includeLiveEntry: (entry, knownIds) => {
      const { id } = entry;
      if (OPENAI_EXCLUDED.has(id) || OPENAI_NON_CHAT_RE.test(id)) return false;
      if (!/^(?:gpt-(?:[5-9]|[1-9]\d)|o[3-9]|chatgpt-)/i.test(id)) return false;
      const undated = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
      if (undated !== id && knownIds.has(undated)) return false;
      return true;
    },
    synthesizeModel: (id, catalog) => {
      const isModernGpt = /^gpt-(?:[6-9]|5\.[6-9])/i.test(id);
      const isNonReasoningChat = /-chat(?:-|$)|non-reasoning/i.test(id);
      const reasoning = catalog?.reasoning ?? !isNonReasoningChat;
      const imageInput = catalog ? catalog.imageInput : true;
      const thinkingLevelMap =
        effortThinkingLevelMap(catalog?.efforts) ??
        (reasoning && isModernGpt
          ? { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }
          : reasoning
            ? SYNTHESIZED_THINKING_LEVELS
            : undefined);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? id,
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? 400_000,
        maxTokens: catalog?.maxTokens ?? 128_000,
        compat: { supportsStrictMode: true },
        ...(imageInput ? { inputLimits: OPENAI_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 3. OpenAI Codex (ChatGPT subscription) ------------------------------------------

export const openaiCodexWithDiscovery = () =>
  withAdditiveDiscovery(openaiCodexProvider(), {
    providerId: "openai-codex",
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "oauth" || !credential.access) return undefined;
      const host = (baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
      const accountId = typeof credential.accountId === "string" && credential.accountId ? credential.accountId : undefined;
      const body = await fetchJson(
        `${host}/codex/models`,
        {
          Authorization: `Bearer ${credential.access}`,
          Accept: "application/json",
          ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        },
        UPSTREAM_TIMEOUT_MS,
        signal
      );
      const rawList = isRecord(body)
        ? Array.isArray(body.models)
          ? body.models
          : Array.isArray(body.data)
            ? body.data
            : undefined
        : undefined;
      if (!rawList) return undefined;
      const entries: LiveDiscoveredEntry[] = [];
      for (const item of rawList) {
        if (!isRecord(item)) continue;
        const id = trimmed(item.slug) ?? trimmed(item.id);
        if (!id || OPENAI_NON_CHAT_RE.test(id)) continue;
        entries.push({
          id,
          name: trimmed(item.display_name) ?? trimmed(item.title) ?? trimmed(item.name),
          contextWindow: positiveInt(item.context_window) ?? positiveInt(item.context_length),
          maxTokens: positiveInt(item.max_output_tokens) ?? positiveInt(item.max_tokens),
          reasoning: true,
          imageInput: true,
        });
      }
      return entries;
    },
    includeLiveEntry: (entry) => /^(?:gpt-|o[3-9]|codex)/i.test(entry.id),
    synthesizeModel: (id, _catalog, live) => ({
      type: "chat",
      id,
      name: live?.name ?? id,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost: zeroCost(),
      contextWindow: live?.contextWindow ?? 272_000,
      maxTokens: live?.maxTokens ?? 128_000,
      compat: { supportsMidConvoSystemMessages: true },
      inputLimits: OPENAI_IMAGE_LIMITS,
    }),
  });

// ---- 4. Google Gemini API ------------------------------------------------------------

const GOOGLE_IMAGE_LIMITS: ModelInputLimits = {
  maxRequestBytes: 20 * 1024 * 1024,
  images: { maxPerRequest: 3600, ...SYNTHESIZED_IMAGE_LIMITS.images },
};

const GOOGLE_NON_CHAT_RE =
  /(?:embedding|imagen|veo|aqa|tts|audio|live|image-generation|-image$|-image-preview|learnlm|bisheng|bison|gecko)/i;

export const googleWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(googleProvider(), {
    providerId: "google",
    modelsDevId: "google",
    modelsDevCache,
    includeCatalogEntry: (entry) => !GOOGLE_NON_CHAT_RE.test(entry.id),
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
      const body = await fetchJson(
        `${host}/models?pageSize=1000`,
        { "x-goog-api-key": credential.key },
        UPSTREAM_TIMEOUT_MS,
        signal
      );
      const rawModels = isRecord(body) && Array.isArray(body.models) ? body.models : undefined;
      if (!rawModels) return undefined;
      const entries: LiveDiscoveredEntry[] = [];
      for (const item of rawModels) {
        if (!isRecord(item)) continue;
        const rawName = trimmed(item.name);
        if (!rawName) continue;
        const id = rawName.replace(/^models\//, "");
        const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : undefined;
        if (methods && !methods.includes("generateContent")) continue;
        entries.push({
          id,
          name: trimmed(item.displayName),
          contextWindow: positiveInt(item.inputTokenLimit),
          maxTokens: positiveInt(item.outputTokenLimit),
          reasoning: typeof item.thinking === "boolean" ? item.thinking : undefined,
        });
      }
      return entries;
    },
    includeLiveEntry: (entry) =>
      /^(?:gemini-(?:[2-9]|[1-9]\d|flash|pro)|gemma-(?:[3-9]|[1-9]\d))/i.test(entry.id) &&
      !GOOGLE_NON_CHAT_RE.test(entry.id),
    synthesizeModel: (id, catalog, live) => {
      const reasoning = catalog?.reasoning ?? live?.reasoning ?? /^gemini-(?:[3-9]|2\.5)/i.test(id);
      const imageInput = catalog ? catalog.imageInput : true;
      const thinkingLevelMap =
        effortThinkingLevelMap(catalog?.efforts) ??
        (/gemma-?4/i.test(id)
          ? { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" }
          : reasoning
            ? { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }
            : undefined);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? live?.name ?? id,
        api: "google-generative-ai",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? live?.contextWindow ?? 1_048_576,
        maxTokens: catalog?.maxTokens ?? live?.maxTokens ?? 65_536,
        ...(imageInput ? { inputLimits: GOOGLE_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 5. OpenRouter -------------------------------------------------------------------

type OpenRouterPricing = {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  overrides?: Array<{
    min_prompt_tokens?: number;
    utc_start?: unknown;
    utc_end?: unknown;
    utc_days?: unknown;
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  }>;
};

type OpenRouterEntry = {
  id: string;
  name?: string;
  supported_parameters?: string[];
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
  pricing?: OpenRouterPricing;
  context_length?: number | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  reasoning?: {
    mandatory?: boolean;
    supported_efforts?: Array<ThinkingLevel | "none">;
  };
};

const perMillion = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? "");
  return parsed >= 0 ? Number((parsed * 1_000_000).toFixed(6)) : fallback;
};

const openRouterCost = (pricing: OpenRouterPricing | undefined): ModelCost => {
  const base = {
    input: perMillion(pricing?.prompt, 0),
    output: perMillion(pricing?.completion, 0),
    cacheRead: perMillion(pricing?.input_cache_read, 0),
    cacheWrite: perMillion(pricing?.input_cache_write, 0),
  };
  const tiers = (pricing?.overrides ?? []).flatMap((override) => {
    if (
      override.min_prompt_tokens === undefined ||
      override.utc_start !== undefined ||
      override.utc_end !== undefined ||
      override.utc_days !== undefined
    ) {
      return [];
    }
    return [
      {
        inputTokensAbove: override.min_prompt_tokens,
        input: perMillion(override.prompt, base.input),
        output: perMillion(override.completion, base.output),
        cacheRead: perMillion(override.input_cache_read, base.cacheRead),
        cacheWrite: perMillion(override.input_cache_write, base.cacheWrite),
      },
    ];
  });
  return tiers.length > 0 ? { ...base, tiers } : base;
};

const fetchOpenRouterEntries = async (
  baseUrl: string,
  token: string | undefined,
  signal: AbortSignal
): Promise<{ entries: OpenRouterEntry[]; userScoped: boolean }> => {
  const base = baseUrl.replace(/\/+$/, "");
  if (token) {
    const userRes = await fetch(`${base}/models/user`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: timedSignal(signal, OPENROUTER_TIMEOUT_MS),
    });
    if (userRes.ok) {
      const body = (await userRes.json()) as { data?: unknown };
      if (Array.isArray(body?.data)) {
        return {
          entries: body.data.filter((item): item is OpenRouterEntry => isRecord(item) && typeof item.id === "string"),
          userScoped: true,
        };
      }
    } else if (userRes.status !== 401 && userRes.status !== 403 && userRes.status !== 404) {
      throw new Error(`OpenRouter /models/user answered ${userRes.status}`);
    }
  }
  const pubRes = await fetch(`${base}/models`, {
    headers: { accept: "application/json" },
    signal: timedSignal(signal, OPENROUTER_TIMEOUT_MS),
  });
  if (!pubRes.ok) throw new Error(`OpenRouter /models answered ${pubRes.status}`);
  const body = (await pubRes.json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new Error("OpenRouter /models returned an invalid list");
  return {
    entries: body.data.filter((item): item is OpenRouterEntry => isRecord(item) && typeof item.id === "string"),
    userScoped: false,
  };
};

export const openrouterWithDiscovery = () => {
  const baseProvider = openrouterProvider();
  const shipped = baseProvider.getModels();
  const nonChat = (baseProvider.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat"));
  let dynamicModels: readonly Model<"anthropic-messages" | "openai-completions">[] | undefined;

  const chat = () => dynamicModels ?? shipped;

  return {
    ...baseProvider,
    getModels: chat,
    getAllModels: () => [...chat(), ...nonChat],
    refreshModels: async (context) => {
      const stored = context.stored?.models.filter(
        (model) => model.provider === "openrouter" && isModelType(model, "chat")
      ) as unknown as Model<"anthropic-messages" | "openai-completions">[] | undefined;
      if (stored !== undefined && stored.length > 0) {
        if (!(await context.publish({ update: () => { dynamicModels = stored; } }))) return;
      }
      if (!context.allowNetwork || context.signal.aborted || !discoveryEnabled()) return;
      const token =
        context.credential?.type === "oauth"
          ? context.credential.access
          : context.credential?.type === "api_key"
            ? context.credential.key
            : undefined;
      if (!token) return;

      const baseUrl = context.baseUrl ?? baseProvider.baseUrl ?? "https://openrouter.ai/api/v1";
      const fetched = await fetchOpenRouterEntries(baseUrl, token, context.signal).catch((error: unknown) => {
        console.log(`[hearth] openrouter discovery skipped (${error instanceof Error ? error.message : error})`);
        return undefined;
      });
      if (!fetched || fetched.entries.length === 0 || context.signal.aborted) return;

      const shippedById = new Map(shipped.map((model) => [model.id, model]));
      const liveById = new Map(fetched.entries.map((entry) => [entry.id, entry]));
      const next: Model<"anthropic-messages" | "openai-completions">[] = [];
      const placed = new Set<string>();

      for (const model of shipped) {
        const entry = liveById.get(model.id);
        if (!entry) {
          if (!fetched.userScoped) {
            next.push(model);
            placed.add(model.id);
          }
          continue;
        }
        next.push({
          ...model,
          contextWindow: entry.top_provider?.context_length || entry.context_length || model.contextWindow,
          maxTokens: entry.top_provider?.max_completion_tokens || model.maxTokens,
          cost: entry.pricing ? openRouterCost(entry.pricing) : model.cost,
        });
        placed.add(model.id);
      }

      let addedCount = 0;
      for (const entry of fetched.entries) {
        if (placed.has(entry.id) || shippedById.has(entry.id)) continue;
        if (!entry.supported_parameters?.includes("tools")) continue;
        const imageInput =
          Boolean(entry.architecture?.modality?.includes("image")) ||
          Boolean(entry.architecture?.input_modalities?.includes("image"));
        const input: Array<"text" | "image"> = imageInput ? ["text", "image"] : ["text"];
        const useAnthropic = /^~?anthropic\//.test(entry.id) && !entry.id.endsWith(":batch");
        const reasoning = Boolean(entry.supported_parameters?.includes("reasoning")) || Boolean(entry.reasoning?.mandatory);
        const efforts = parseEffortList(entry.reasoning?.supported_efforts);
        const thinkingLevelMap = effortThinkingLevelMap(efforts, entry.reasoning?.mandatory === true);
        const model: Model<"anthropic-messages" | "openai-completions"> = useAnthropic
          ? {
              type: "chat",
              id: entry.id,
              name: trimmed(entry.name) ?? entry.id,
              api: "anthropic-messages",
              provider: "openrouter",
              baseUrl: "https://openrouter.ai/api",
              reasoning,
              ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
              input,
              cost: openRouterCost(entry.pricing),
              contextWindow: entry.top_provider?.context_length || entry.context_length || 128_000,
              maxTokens: entry.top_provider?.max_completion_tokens || 16_384,
              compat: { sendSessionAffinityHeaders: true },
              ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
            }
          : {
              type: "chat",
              id: entry.id,
              name: trimmed(entry.name) ?? entry.id,
              api: "openai-completions",
              provider: "openrouter",
              baseUrl: "https://openrouter.ai/api/v1",
              reasoning,
              ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
              input,
              cost: openRouterCost(entry.pricing),
              contextWindow: entry.top_provider?.context_length || entry.context_length || 128_000,
              maxTokens: entry.top_provider?.max_completion_tokens || 16_384,
              compat: {
                ...(/^(?:anthropic|openai)\//.test(entry.id) ? {} : { supportsDeveloperRole: false }),
                thinkingFormat: "openrouter",
                supportsStrictMode: true,
                ...(/^~?anthropic\//.test(entry.id) ? { cacheControlFormat: "anthropic" } : {}),
                sendSessionAffinityHeaders: true,
              },
              ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
            };
        next.push(model);
        placed.add(entry.id);
        addedCount += 1;
      }

      if (addedCount > 0) {
        console.log(`[hearth] openrouter discovered ${addedCount} new model(s) (${next.length} total)`);
      }
      await context.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => {
          dynamicModels = next;
        },
      });
    },
  } satisfies Provider<"anthropic-messages" | "openai-completions">;
};

// ---- 6. xAI --------------------------------------------------------------------------

const XAI_EXCLUDED = new Set([
  "grok-3",
  "grok-3-fast",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-0309-reasoning",
  "grok-build-0.1",
  "grok-code-fast-1",
]);
const XAI_NON_CHAT_RE = /(?:image|imagine|video|embed|vision-beta)/i;

export const xaiWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(xaiProvider(), {
    providerId: "xai",
    modelsDevId: "xai",
    modelsDevCache,
    includeCatalogEntry: (entry) => !XAI_EXCLUDED.has(entry.id) && !XAI_NON_CHAT_RE.test(entry.id),
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");
      const items = await openAiListEntries(`${host}/models`, { Authorization: `Bearer ${credential.key}` }, signal);
      return items
        .map((item) => trimmed(item.id))
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id }));
    },
    includeLiveEntry: (entry) =>
      /^grok-(?:[4-9]|[1-9]\d)/i.test(entry.id) && !XAI_EXCLUDED.has(entry.id) && !XAI_NON_CHAT_RE.test(entry.id),
    synthesizeModel: (id, catalog) => {
      const nonReasoning = /non-reasoning/i.test(id);
      const reasoning = catalog?.reasoning ?? !nonReasoning;
      const imageInput = catalog ? catalog.imageInput : true;
      const thinkingLevelMap =
        effortThinkingLevelMap(catalog?.efforts) ?? { off: null, minimal: null };
      return {
        type: "chat",
        id,
        name: catalog?.name ?? id,
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning,
        thinkingLevelMap,
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? 256_000,
        maxTokens: catalog?.maxTokens ?? 32_768,
        compat: { supportsLongCacheRetention: false },
        ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 7. DeepSeek ---------------------------------------------------------------------

const DEEPSEEK_NON_CHAT_RE = /(?:embed|ocr|janus)/i;

export const deepseekWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(deepseekProvider(), {
    providerId: "deepseek",
    modelsDevId: "deepseek",
    modelsDevCache,
    includeCatalogEntry: (entry) => !DEEPSEEK_NON_CHAT_RE.test(entry.id),
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
      const items = await openAiListEntries(`${host}/models`, { Authorization: `Bearer ${credential.key}` }, signal);
      return items
        .map((item) => trimmed(item.id))
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id }));
    },
    includeLiveEntry: (entry) => /^deepseek-/i.test(entry.id) && !DEEPSEEK_NON_CHAT_RE.test(entry.id),
    synthesizeModel: (id, catalog) => {
      const reasoning = catalog?.reasoning ?? (/reasoner|v4|r1|r2/i.test(id) || !/chat/i.test(id));
      const imageInput = catalog?.imageInput ?? false;
      const thinkingLevelMap = effortThinkingLevelMap(catalog?.efforts);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? id,
        api: "openai-completions",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? 128_000,
        maxTokens: catalog?.maxTokens ?? 64_000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek",
          supportsStrictMode: true,
        },
        ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 8. Fireworks --------------------------------------------------------------------

export const fireworksWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(fireworksProvider(), {
    providerId: "fireworks",
    modelsDevId: "fireworks-ai",
    modelsDevCache,
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://api.fireworks.ai/inference").replace(/\/+$/, "");
      const url = host.endsWith("/v1") ? `${host}/models` : `${host}/v1/models`;
      const items = await openAiListEntries(url, { Authorization: `Bearer ${credential.key}` }, signal);
      return items
        .filter((item) => item.supports_tools === true && item.supports_chat !== false)
        .map((item): LiveDiscoveredEntry | undefined => {
          const id = trimmed(item.id);
          if (!id) return undefined;
          return {
            id,
            contextWindow: positiveInt(item.context_length),
            imageInput: item.supports_image_input === true,
          };
        })
        .filter((entry): entry is LiveDiscoveredEntry => entry !== undefined);
    },
    synthesizeModel: (id, catalog, live) => {
      const useOpenAi = id.includes("glm-") || id.includes("kimi-k3");
      const reasoning = catalog?.reasoning ?? false;
      const imageInput = catalog?.imageInput ?? live?.imageInput ?? false;
      const thinkingLevelMap = effortThinkingLevelMap(catalog?.efforts);
      if (useOpenAi) {
        return {
          type: "chat",
          id,
          name: catalog?.name ?? id,
          api: "openai-completions",
          provider: "fireworks",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          reasoning,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          input: imageInput ? ["text", "image"] : ["text"],
          cost: catalog?.cost ?? zeroCost(),
          contextWindow: catalog?.contextWindow ?? live?.contextWindow ?? 128_000,
          maxTokens: catalog?.maxTokens ?? 16_384,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            sendSessionAffinityHeaders: true,
            supportsLongCacheRetention: false,
            supportsStrictMode: true,
            ...(id.includes("kimi-k3") ? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "openai" } : {}),
          },
          ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
        };
      }
      const adaptive = Boolean(catalog?.efforts?.length);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? id,
        api: "anthropic-messages",
        provider: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference",
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? live?.contextWindow ?? 128_000,
        maxTokens: catalog?.maxTokens ?? 16_384,
        compat: {
          allowEmptySignature: true,
          sendSessionAffinityHeaders: true,
          supportsEagerToolInputStreaming: false,
          supportsCacheControlOnTools: false,
          supportsLongCacheRetention: false,
          ...(adaptive ? { forceAdaptiveThinking: true } : {}),
        },
        ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 9. NVIDIA NIM -------------------------------------------------------------------

const NVIDIA_UNSUPPORTED = new Set([
  "abacusai/dracarys-llama-3.1-70b-instruct",
  "bytedance/seed-oss-36b-instruct",
  "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro",
  "google/gemma-2-2b-it",
  "google/gemma-3n-e2b-it",
  "google/gemma-3n-e4b-it",
  "google/gemma-4-31b-it",
  "meta/llama-3.2-1b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "microsoft/phi-4-mini-instruct",
  "minimaxai/minimax-m2.7",
  "mistralai/mistral-nemotron",
  "nvidia/nemotron-mini-4b-instruct",
  "qwen/qwen3-next-80b-a3b-instruct",
  "qwen/qwen3.5-397b-a17b",
  "sarvamai/sarvam-m",
  "upstage/solar-10.7b-instruct",
]);

const normalizeNvidiaId = (id: string): string => id.toLowerCase().replaceAll("_", ".");

export const nvidiaWithDiscovery = (modelsDevCache: ModelsDevCache) => {
  const baseProvider = nvidiaProvider();
  const shipped = baseProvider.getModels();
  let dynamicModels: readonly Model<"openai-completions">[] | undefined;

  return {
    ...baseProvider,
    getModels: () => dynamicModels ?? shipped,
    getAllModels: () => dynamicModels ?? shipped,
    refreshModels: async (context) => {
      const stored = context.stored?.models.filter(
        (model) => model.provider === "nvidia" && isModelType(model, "chat")
      ) as unknown as Model<"openai-completions">[] | undefined;
      if (stored !== undefined && stored.length > 0) {
        const merged = mergeAdditive(shipped, stored);
        if (!(await context.publish({ update: () => { dynamicModels = merged; } }))) return;
      }
      if (!context.allowNetwork || context.signal.aborted || !discoveryEnabled() || !context.credential) return;

      const host = (context.baseUrl ?? baseProvider.baseUrl ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
      const headers: Record<string, string> = context.credential.type === "api_key" && context.credential.key
        ? { Authorization: `Bearer ${context.credential.key}` }
        : {};
      const [snapshot, liveItems] = await Promise.all([
        modelsDevCache.get(context.signal, context.force).catch(() => undefined),
        openAiListEntries(`${host}/models`, headers, context.signal).catch(() => undefined),
      ]);
      if (context.signal.aborted || (!snapshot && !liveItems)) return;

      const liveIds = new Map<string, string>();
      for (const item of liveItems ?? []) {
        const id = trimmed(item.id);
        if (!id) continue;
        liveIds.set(id, id);
        liveIds.set(normalizeNvidiaId(id), id);
      }

      const knownIds = new Set(shipped.map((m) => m.id));
      const additions: Model<"openai-completions">[] = [];
      const catalogMap = snapshot?.get("nvidia");
      if (catalogMap) {
        for (const entry of catalogMap.values()) {
          if (!entry.toolCall || !entry.textInput || !entry.textOutput || entry.status === "deprecated") continue;
          const resolvedId = liveItems
            ? liveIds.get(entry.id) ?? liveIds.get(normalizeNvidiaId(entry.id))
            : entry.id;
          if (!resolvedId || NVIDIA_UNSUPPORTED.has(resolvedId) || knownIds.has(resolvedId)) continue;
          knownIds.add(resolvedId);
          additions.push({
            type: "chat",
            id: resolvedId,
            name: entry.name === entry.id ? resolvedId : entry.name,
            api: "openai-completions",
            provider: "nvidia",
            baseUrl: host,
            headers: { "NVCF-POLL-SECONDS": "3600" },
            reasoning: entry.reasoning,
            input: entry.imageInput ? ["text", "image"] : ["text"],
            cost: entry.cost,
            contextWindow: entry.contextWindow ?? 128_000,
            maxTokens: entry.maxTokens ?? 16_384,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens",
              supportsStrictMode: false,
              supportsLongCacheRetention: false,
            },
            ...(entry.imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
          });
        }
      }

      const next = [...shipped, ...additions];
      await context.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => {
          dynamicModels = next;
        },
      });
    },
  } satisfies Provider<"openai-completions">;
};

// ---- 10. Meta ------------------------------------------------------------------------

const META_NON_CHAT_RE = /(?:guard|prompt-guard|embed|audio|speech)/i;

export const metaWithDiscovery = (modelsDevCache: ModelsDevCache) =>
  withAdditiveDiscovery(metaProvider(), {
    providerId: "meta",
    modelsDevId: "meta",
    modelsDevCache,
    includeCatalogEntry: (entry) => !META_NON_CHAT_RE.test(entry.id),
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      if (credential.type !== "api_key" || !credential.key) return undefined;
      const host = (baseUrl ?? "https://api.meta.ai/v1").replace(/\/+$/, "");
      const items = await openAiListEntries(`${host}/models`, { Authorization: `Bearer ${credential.key}` }, signal);
      return items
        .map((item) => trimmed(item.id))
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id }));
    },
    includeLiveEntry: (entry) => /^(?:llama|muse)/i.test(entry.id) && !META_NON_CHAT_RE.test(entry.id),
    synthesizeModel: (id, catalog) => {
      const reasoning = catalog?.reasoning ?? /muse|reason/i.test(id);
      const imageInput = catalog?.imageInput ?? true;
      const thinkingLevelMap = effortThinkingLevelMap(catalog?.efforts);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? id,
        api: "openai-responses",
        provider: "meta",
        baseUrl: "https://api.meta.ai/v1",
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? 128_000,
        maxTokens: catalog?.maxTokens ?? 16_384,
        ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
      };
    },
  });

// ---- 11. GitHub Copilot --------------------------------------------------------------

const COPILOT_STATIC_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const copilotBaseUrlFromToken = (token: string | undefined, fallback: string): string => {
  if (!token) return fallback;
  const match = /(?:^|;)\s*proxy-ep=([^;\s]+)/i.exec(token);
  if (!match?.[1]) return fallback;
  const host = match[1].replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return `https://${host}`;
};

const copilotApi = (id: string): "anthropic-messages" | "openai-responses" | "openai-completions" => {
  if (/^claude-(?:haiku|sonnet|opus|fable|mythos)-[4-9](?:[.-]|$)/i.test(id)) return "anthropic-messages";
  if (/^(?:gpt-|grok-|oswe|mai-)/i.test(id)) return "openai-responses";
  return "openai-completions";
};

export const githubCopilotWithDiscovery = (modelsDevCache: ModelsDevCache) => {
  const baseProvider = githubCopilotProvider();
  let liveEntitledIds = new Set<string>();

  const discovered = withAdditiveDiscovery(baseProvider, {
    providerId: "github-copilot",
    modelsDevId: "github-copilot",
    modelsDevCache,
    intersectModelsDevWithLive: true,
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      const token =
        credential.type === "oauth"
          ? credential.access
          : credential.type === "api_key"
            ? credential.key
            : undefined;
      if (!token) return undefined;
      const host = copilotBaseUrlFromToken(token, baseUrl ?? "https://api.individual.githubcopilot.com").replace(/\/+$/, "");
      const items = await openAiListEntries(
        `${host}/models`,
        {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...COPILOT_STATIC_HEADERS,
          "X-GitHub-Api-Version": "2025-05-01",
        },
        signal
      );
      const entries: LiveDiscoveredEntry[] = [];
      const entitled = new Set<string>();
      for (const item of items) {
        const id = trimmed(item.id);
        if (!id) continue;
        const caps = isRecord(item.capabilities) ? item.capabilities : undefined;
        if (caps?.type !== undefined && caps.type !== "chat") continue;
        const supports = caps && isRecord(caps.supports) ? caps.supports : undefined;
        if (supports?.tool_calls === false) continue;
        if (/(?:embedding|decision)/i.test(id)) continue;
        const limits = caps && isRecord(caps.limits) ? caps.limits : undefined;
        entitled.add(id);
        entries.push({
          id,
          name: trimmed(item.name),
          contextWindow: positiveInt(limits?.max_context_window_tokens),
          maxTokens: positiveInt(limits?.max_output_tokens),
          imageInput: Boolean(supports?.vision),
          reasoning: Boolean(supports?.thinking),
        });
      }
      liveEntitledIds = entitled;
      return entries;
    },
    synthesizeModel: (id, catalog, live) => {
      const api = copilotApi(id);
      const reasoning = catalog?.reasoning ?? live?.reasoning ?? false;
      const imageInput = catalog?.imageInput ?? live?.imageInput ?? false;
      const thinkingLevelMap = effortThinkingLevelMap(catalog?.efforts);
      return {
        type: "chat",
        id,
        name: catalog?.name ?? live?.name ?? id,
        api,
        provider: "github-copilot",
        baseUrl: "https://api.individual.githubcopilot.com",
        headers: { ...COPILOT_STATIC_HEADERS },
        reasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? live?.contextWindow ?? 128_000,
        maxTokens: catalog?.maxTokens ?? live?.maxTokens ?? 16_384,
        ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
      };
    },
  });

  const baseFilter = baseProvider.filterModels;
  return {
    ...discovered,
    ...(baseFilter
      ? {
          filterModels: (
            models: readonly Model<"anthropic-messages" | "openai-completions" | "openai-responses">[],
            credential: Credential | undefined
          ) => {
            const allowedByCredential = new Set(baseFilter(models, credential).map((m) => m.id));
            return models.filter((model) => allowedByCredential.has(model.id) || liveEntitledIds.has(model.id));
          },
        }
      : {}),
  };
};

// ---- 12. Kimi Coding -----------------------------------------------------------------

export const withKimiCodingDiscovery = (
  provider: Provider<"openai-completions">,
  codingBaseUrl: string,
  modelsDevCache: ModelsDevCache
): Provider<"openai-completions"> =>
  withAdditiveDiscovery(provider, {
    providerId: provider.id,
    modelsDevId: "kimi-code-plan-global",
    modelsDevCache,
    fetchLiveEntries: async (credential, baseUrl, signal) => {
      const token =
        credential.type === "oauth"
          ? credential.access
          : credential.type === "api_key"
            ? credential.key
            : undefined;
      if (!token) return undefined;
      const host = (baseUrl ?? codingBaseUrl).replace(/\/+$/, "");
      const items = await openAiListEntries(`${host}/models`, { Authorization: `Bearer ${token}` }, signal);
      return items
        .map((item): LiveDiscoveredEntry | undefined => {
          const id = trimmed(item.id);
          if (!id) return undefined;
          return {
            id,
            name: trimmed(item.display_name) ?? trimmed(item.name),
            contextWindow: positiveInt(item.context_length),
          };
        })
        .filter((entry): entry is LiveDiscoveredEntry => entry !== undefined);
    },
    synthesizeModel: (id, catalog, live) => {
      const isK3Style = Boolean(catalog?.efforts?.length) || /^k3(?:\.\d+)?(?:-|$)/i.test(id);
      const effortLevels = effortThinkingLevelMap(catalog?.efforts);
      const imageInput = catalog?.imageInput ?? true;
      return {
        type: "chat",
        id,
        name: catalog?.name ?? live?.name ?? id,
        api: "openai-completions",
        provider: provider.id,
        baseUrl: codingBaseUrl,
        reasoning: true,
        thinkingLevelMap: { ...effortLevels, off: null },
        input: imageInput ? ["text", "image"] : ["text"],
        cost: catalog?.cost ?? zeroCost(),
        contextWindow: catalog?.contextWindow ?? live?.contextWindow ?? 262_144,
        maxTokens: catalog?.maxTokens ?? 131_072,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: isK3Style,
          maxTokensField: "max_tokens",
          supportsStrictMode: true,
          thinkingFormat: isK3Style ? "openai" : "deepseek",
          supportsMidConvoSystemMessages: true,
          ...(isK3Style ? { requiresReasoningContentOnAssistantMessages: true, supportsMidConvoToolAdditions: true } : {}),
        },
        ...(imageInput ? { inputLimits: SYNTHESIZED_IMAGE_LIMITS } : {}),
      };
    },
  });
