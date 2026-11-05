import type {
  Model,
  ModelInputLimits,
  ModelInputModality,
  OpenAICompletionsCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

/**
 * The `orcarouter` slot: a dynamic OpenAI-compatible endpoint whose catalog Hearth fetches at
 * boot, described entirely by env vars (see README, "Providers"). It exists so a model Hearth
 * does not ship a catalog entry for - Kimi K3.1 Pro is the reference case - is reachable
 * without a rebuild or a config file.
 *
 * Everything here is pure: env parsing, then catalog entry + settings -> pi-ai `Model`. The
 * network read of `GET /models` stays in `models.ts`.
 *
 * Where no limit is reported and none is configured, a model known to be larger than the generic
 * default gets its verified window instead (see VERIFIED_LIMITS); everything else falls back to
 * the pre-0.23.0 defaults (128k of context, 8k of output) and says so in the log.
 *
 * An existing `ORCAROUTER_BASE_URL`/`ORCAROUTER_API_KEY` setup keeps working:
 * `ORCAROUTER_REASONING` defaults to `auto`, which reasons only for a model that always reasons
 * (Kimi K3 and K3.1 return `reasoning_content` on every request, so a model record without
 * `reasoning: true` would throw that away).
 */

/** The fields of one `GET /models` entry that Hearth reads. */
export type RouterCatalogEntry = {
  id: string;
  context_window?: number;
  max_tokens?: number;
};

/**
 * `ORCAROUTER_REASONING`: `auto` reasons for a model that always reasons and not for any other,
 * `on` reasons for every model the endpoint lists, `off` for none.
 */
export type RouterReasoning = "auto" | "on" | "off";

/** What the env vars ask for. All of it is optional; the defaults are today's behaviour. */
export type RouterOptions = {
  reasoning: RouterReasoning;
  /** `ORCAROUTER_INPUT`: `text` (default) or `text,image`. */
  input: ModelInputModality[];
  /** `ORCAROUTER_CONTEXT_WINDOW`: used only when the catalog reports no window. */
  contextWindow?: number;
  /** `ORCAROUTER_MAX_TOKENS`: used only when the catalog reports no output cap. */
  maxTokens?: number;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
/**
 * A reasoning pass and the answer share one output budget, and a thinking model spends most of
 * it before it says anything (Kimi's docs recommend at least 16k for exactly this reason). So
 * with reasoning on and no other source for a cap, the fallback is raised rather than reusing
 * the 8k that suits a non-reasoning model - 8k truncates a long reasoning turn before it reaches
 * an answer or a tool call.
 */
const DEFAULT_REASONING_MAX_TOKENS = 32_768;

/**
 * Windows verified against the provider itself, for models whose catalog entry reports no limit
 * and where the generic 128k would be badly wrong. Kimi K3 is 1M (its parameter reference says so
 * for `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` and `kimi-k3`), which matters because 128k of
 * context would make Hearth compact a conversation at an eighth of the room available.
 */
export const VERIFIED_LIMITS: { match: RegExp; contextWindow: number }[] = [
  { match: /^kimi-k3/i, contextWindow: 1_048_576 },
];

/**
 * Kimi K3.x accepts `low`, `high` and `max` for the top-level `reasoning_effort` field and always
 * thinks, so `off` cannot be requested and the levels it does not name are marked unsupported.
 * pi-ai clamps a requested level onto these (`getSupportedThinkingLevels`), which is why the
 * unlisted ones are `null` rather than absent: `null` means "not supported", `undefined` would
 * mean "same name on the wire".
 */
export const KIMI_THINKING_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/**
 * The Kimi shape: OpenAI's own top-level `reasoning_effort` (pi-ai's `openai` thinking format),
 * with `max_tokens` as the output field and the assistant's `reasoning_content` echoed back,
 * which K3.x requires on every multi-turn and tool-calling request. These are the values pi-ai
 * ships for `kimi-k3`; they are explicit here because pi-ai infers them from a Moonshot base URL,
 * which a proxy or gateway would hide.
 */
export const KIMI_COMPAT: OpenAICompletionsCompat = {
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
  requiresReasoningContentOnAssistantMessages: true,
  maxTokensField: "max_tokens",
};

export const GENERIC_THINKING_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: "high",
};

/** The same wire shape for a non-Kimi reasoning model: nothing provider-specific, standard level map. */
export const GENERIC_REASONING_COMPAT: OpenAICompletionsCompat = {
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
};

/**
 * Image limits pi-ai ships for Kimi (2000px, 4.5 MiB): pi-ai resizes to these before sending, so
 * a photo off a phone does not come back as a provider error. Only attached when image input is
 * configured.
 */
export const IMAGE_INPUT_LIMITS: ModelInputLimits = {
  images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
};

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/**
 * `ORCAROUTER_REASONING`: `on`/`1`/`true`/`yes` is `on`, `off`/`0`/`false`/`no` is `off`, and
 * unset, `auto` or anything unrecognised is `auto`.
 */
export const routerReasoningMode = (value: string | undefined): RouterReasoning => {
  const text = trimmed(value)?.toLowerCase();
  if (text === "on" || text === "1" || text === "true" || text === "yes") return "on";
  if (text === "off" || text === "0" || text === "false" || text === "no") return "off";
  return "auto";
};

/**
 * A model that always reasons: Kimi K3 and K3.1. They take no `thinking` switch and answer with
 * `reasoning_content` on every request (verified against the live endpoint: a plain
 * `max_tokens: 8` call came back with empty `content`, a `reasoning_content` string and
 * `completion_tokens_details.reasoning_tokens`), so reasoning is on for them unless an operator
 * says otherwise.
 */
export const alwaysReasons = (id: string): boolean => /^kimi-k3/i.test(id);

/** Whether a given model ends up reasoning: the configured mode, else what the model does anyway. */
export const routerReasoning = (id: string, options: RouterOptions): boolean =>
  options.reasoning === "auto" ? alwaysReasons(id) : options.reasoning !== "off";

/** `text,image` -> `["text", "image"]`. Text is always accepted; unknown words are ignored. */
export const routerInputs = (value: string | undefined): ModelInputModality[] => {
  const words = (trimmed(value) ?? "").split(",").map((word) => word.trim().toLowerCase());
  return words.includes("image") ? ["text", "image"] : ["text"];
};

/**
 * A limit as a positive whole number, or undefined. `0`, `-1`, `12.5`, `1e6` and junk are not
 * limits, and neither is anything a catalog sends that is not a number.
 */
export const routerLimit = (value: unknown): number | undefined => {
  const text = typeof value === "number" ? value : typeof value === "string" ? value.trim() : undefined;
  const count = typeof text === "string" && !/^\d+$/.test(text) ? NaN : Number(text);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
};

export const orcarouterOptions = (
  env: Record<string, string | undefined> = process.env
): RouterOptions => ({
  reasoning: routerReasoningMode(env.ORCAROUTER_REASONING),
  input: routerInputs(env.ORCAROUTER_INPUT),
  contextWindow: routerLimit(env.ORCAROUTER_CONTEXT_WINDOW),
  maxTokens: routerLimit(env.ORCAROUTER_MAX_TOKENS),
});

/**
 * A model's limits: the catalog's own numbers when it reports them, else the configured fallback,
 * else a verified window for a model known to be larger, else the built-in default. `guessed`
 * names the limits that fell through to a default - not the configured or verified ones - so the
 * caller can log them instead of leaving a silent assumption in place.
 */
export const routerLimits = (
  entry: RouterCatalogEntry,
  options: RouterOptions
): { contextWindow: number; maxTokens: number; guessed: ("contextWindow" | "maxTokens")[] } => {
  const reportedContext = routerLimit(entry.context_window);
  const reportedMax = routerLimit(entry.max_tokens);
  const verified = VERIFIED_LIMITS.find((known) => known.match.test(entry.id))?.contextWindow;
  const guessed: ("contextWindow" | "maxTokens")[] = [];
  // Only an unreported limit that also fell back to a default counts: a configured fallback is a
  // decision the operator made, and a verified window is the provider's own number, so neither is
  // a guess.
  if (reportedContext === undefined && options.contextWindow === undefined && verified === undefined) {
    guessed.push("contextWindow");
  }
  if (reportedMax === undefined && options.maxTokens === undefined) guessed.push("maxTokens");
  return {
    contextWindow: reportedContext ?? options.contextWindow ?? verified ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      reportedMax ?? options.maxTokens ?? (routerReasoning(entry.id, options) ? DEFAULT_REASONING_MAX_TOKENS : DEFAULT_MAX_TOKENS),
    guessed,
  };
};

/**
 * One catalog entry as a pi-ai model. The reasoning shape is keyed off the model id, not the
 * endpoint: `kimi-k3*` is the family whose effort field, level map and reasoning echo are known,
 * and it keeps them behind a gateway the same way it does on `api.moonshot.ai`. Cost stays at
 * zero: a dynamic endpoint publishes no pricing, so Hearth reports no cost rather than an
 * invented one.
 */
export const orcarouterModel = (
  entry: RouterCatalogEntry,
  baseUrl: string,
  options: RouterOptions
): Model<"openai-completions"> => {
  const { contextWindow, maxTokens } = routerLimits(entry, options);
  const reasoning = routerReasoning(entry.id, options);
  const kimi = alwaysReasons(entry.id);
  return {
    provider: "orcarouter",
    id: entry.id,
    name: entry.id,
    api: "openai-completions",
    baseUrl,
    reasoning,
    input: options.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(reasoning && kimi ? { thinkingLevelMap: KIMI_THINKING_LEVELS, compat: KIMI_COMPAT } : {}),
    ...(reasoning && !kimi ? { thinkingLevelMap: GENERIC_THINKING_LEVELS, compat: GENERIC_REASONING_COMPAT } : {}),
    ...(options.input.includes("image") ? { inputLimits: IMAGE_INPUT_LIMITS } : {}),
  };
};
