import type {
  Model,
  ModelCost,
  ModelInputLimits,
  ModelInputModality,
  OpenAICompletionsCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

/**
 * The `deepinfra` slot: DeepInfra's OpenAI-compatible inference API
 * (`https://api.deepinfra.com/v1/openai`). pi-ai ships no provider for it, so Hearth registers one
 * itself — the same shape as `orcarouter`, but with DeepInfra's own catalog read rather than env
 * knobs, because the catalog is rich enough to describe each model:
 *
 * - `GET /models` reports `metadata.context_length`, `metadata.max_tokens`,
 *   `metadata.pricing.{input_tokens,output_tokens,cache_read_tokens}` and `metadata.tags`, all
 *   verified against the live endpoint (2026-11). Prices are **US dollars per million tokens**,
 *   which is the unit pi-ai's `cost` uses.
 * - The same list also carries embeddings, image/video/audio models and rerankers. Only `chat`
 *   models are Hearth models; the rest would offer a picker entry that cannot hold a conversation.
 * - Context and output limits are published for every chat model, so nothing falls back to a
 *   guessed window. A model that somehow reports none says so in the log.
 *
 * Everything here is pure: a catalog entry -> pi-ai `Model`. The network read lives in
 * `models.ts`, and the last good list is persisted by pi-ai's model store, so boot never needs
 * the network (an install with no cached list and no connectivity simply has no DeepInfra models
 * until the background refresh succeeds, exactly like every other fetched catalog).
 */

export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEEPINFRA_ENV_VAR = "DEEPINFRA_API_KEY";

/** Conservative fallbacks, used only when a chat entry reports no limit at all. */
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8_192;

/** Modalities pi-ai can send. DeepInfra tags vision models `vision`/`vlm`. */
const IMAGE_TAGS = new Set(["vision", "vlm"]);

/**
 * The resize limits pi-ai applies before attaching an image. DeepInfra accepts OpenAI vision
 * payloads; the numbers are the same ones Hearth uses for every other vision endpoint rather than
 * a DeepInfra-specific ceiling it does not publish.
 */
export const DEEPINFRA_IMAGE_LIMITS: ModelInputLimits = {
  images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
};

/**
 * DeepInfra documents `reasoning_effort` for reasoning models, and marks the ones that take it
 * with the `reasoning_effort` tag, so the standard OpenAI level map applies to exactly those.
 * A reasoning model without the tag reasons on its own and cannot be asked to stop.
 */
export const DEEPINFRA_THINKING_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: "high",
};

export const DEEPINFRA_EFFORT_COMPAT: OpenAICompletionsCompat = {
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
};

/** One `GET /models` entry, in DeepInfra's shape (fields Hearth reads only). */
export type DeepInfraCatalogEntry = {
  id: string;
  owned_by?: string;
  metadata?: {
    description?: string;
    context_length?: number | null;
    max_tokens?: number | null;
    pricing?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      cache_read_tokens?: number | null;
    } | null;
    tags?: string[] | null;
  } | null;
};

/** A limit as a positive whole number, or undefined. Junk and non-positive values are not limits. */
export const deepinfraLimit = (value: unknown): number | undefined => {
  const count = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
};

/** A per-million-token price, or undefined when absent or not a finite non-negative number. */
const price = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Chat models only: everything else (embed, image-gen, tts, stt, video-gen) cannot hold a turn. */
export const deepinfraIsChat = (entry: DeepInfraCatalogEntry): boolean =>
  Array.isArray(entry.metadata?.tags) && entry.metadata.tags.includes("chat");

export const deepinfraInputs = (entry: DeepInfraCatalogEntry): ModelInputModality[] =>
  (entry.metadata?.tags ?? []).some((tag) => IMAGE_TAGS.has(tag)) ? ["text", "image"] : ["text"];

/**
 * Pricing in pi-ai's unit (USD per million tokens), straight from the catalog. An unpublished
 * component stays at zero — the same "no cost rather than an invented one" rule the dynamic slot
 * follows — so a model with only input/output prices reports no cache price instead of guessing.
 */
export const deepinfraCost = (entry: DeepInfraCatalogEntry): ModelCost => {
  const pricing = entry.metadata?.pricing ?? undefined;
  return {
    input: price(pricing?.input_tokens) ?? 0,
    output: price(pricing?.output_tokens) ?? 0,
    cacheRead: price(pricing?.cache_read_tokens) ?? 0,
    cacheWrite: 0,
  };
};

export const deepinfraContextWindow = (entry: DeepInfraCatalogEntry): number | undefined =>
  deepinfraLimit(entry.metadata?.context_length);

export const deepinfraMaxTokens = (entry: DeepInfraCatalogEntry): number | undefined =>
  deepinfraLimit(entry.metadata?.max_tokens);

/**
 * A display name a person can pick out: the catalog has no `name`, so the id minus its
 * `publisher/` prefix is the model, which reads better than the raw route
 * (`anthropic/claude-opus-4-7` -> `claude-opus-4-7`). The id itself is never rewritten.
 */
export const deepinfraName = (entry: DeepInfraCatalogEntry): string => {
  const slash = entry.id.indexOf("/");
  return slash >= 0 && slash < entry.id.length - 1 ? entry.id.slice(slash + 1) : entry.id;
};

/**
 * One catalog entry as a pi-ai model, or null for anything that is not a chat model.
 *
 * `guessed` names the limits that fell through to a default, so the caller can log them rather
 * than leave a silent assumption in place.
 */
export const deepinfraModel = (
  entry: DeepInfraCatalogEntry
): { model: Model<"openai-completions">; guessed: ("contextWindow" | "maxTokens")[] } | null => {
  if (!deepinfraIsChat(entry)) return null;
  const tags = entry.metadata?.tags ?? [];
  const reasoning = tags.includes("reasoning");
  const takesEffort = tags.includes("reasoning_effort");
  const input = deepinfraInputs(entry);
  const contextWindow = deepinfraContextWindow(entry);
  const maxTokens = deepinfraMaxTokens(entry);
  const guessed: ("contextWindow" | "maxTokens")[] = [];
  if (contextWindow === undefined) guessed.push("contextWindow");
  if (maxTokens === undefined) guessed.push("maxTokens");
  return {
    model: {
      provider: "deepinfra",
      id: entry.id,
      name: deepinfraName(entry),
      api: "openai-completions",
      baseUrl: DEEPINFRA_BASE_URL,
      reasoning,
      input,
      cost: deepinfraCost(entry),
      contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(reasoning && takesEffort
        ? { thinkingLevelMap: DEEPINFRA_THINKING_LEVELS, compat: DEEPINFRA_EFFORT_COMPAT }
        : {}),
      ...(input.includes("image") ? { inputLimits: DEEPINFRA_IMAGE_LIMITS } : {}),
    },
    guessed,
  };
};

/** The whole catalog as Hearth models, chat entries only. */
export const deepinfraModels = (entries: readonly DeepInfraCatalogEntry[]): Model<"openai-completions">[] =>
  entries.flatMap((entry) => {
    const mapped = deepinfraModel(entry);
    return mapped ? [mapped.model] : [];
  });
