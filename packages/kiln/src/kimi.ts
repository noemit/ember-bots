import type { Model, ModelCost, ModelInputLimits, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";

/**
 * The Kimi/Moonshot slot: `https://api.moonshot.ai/v1` (or a compatible gateway) under Hearth's
 * own provider ids, so a Kimi key is not smuggled through `orcarouter`.
 *
 * Two entries, with separate endpoints and credentials for Moonshot's two products:
 *
 * - `moonshotai` — the platform API key (`sk-…`, pay-as-you-go). Hearth fetches `/models` at boot
 *   like `orcarouter` does; pi-ai's own `moonshotai` catalog is the offline fallback.
 * - `kimi-coding` — the Kimi *Code* coding-plan key (from the Kimi CLI login). No catalog read: a
 *   coding-plan key is not obliged to answer `/models`, and pi-ai's `kimi-coding` catalog (which
 *   speaks model ids like `k3`) is the right list anyway.
 *
 * `orcarouter` remains the generic "some OpenAI-compatible endpoint" slot. It is the wrong home for
 * Kimi: it advertises text input only, its limit fields are guesses, and its ids are bare, so the
 * same Kimi model appeared two or three times in the picker (once per provider). Both providers
 * here are registered with distinct ids and pi-ai's Kimi catalogs, so reasoning, image input,
 * thinking levels and the 1M window come from the catalog rather than from env vars.
 *
 * Everything in this file is pure: env parsing and a catalog entry -> pi-ai `Model`.
 */

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";

/** `KIMI_CODING_API_KEY`, `KIMI_API_KEY` and `MOONSHOT_API_KEY` are all accepted; a stored wins. */
export const KIMI_KEY_ENV = ["KIMI_CODING_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"];

/** The fields of one `GET /models` entry that Hearth reads (Moonshot's own shape). */
export type MoonshotCatalogEntry = {
  id: string;
  name?: string;
  context_length?: number;
  max_tokens?: number;
  limit?: { context?: number; output?: number };
  cost?: Partial<ModelCost>;
  modalities?: { input?: string[] };
  reasoning?: { type?: string } | null;
};

export type KimiOptions = {
  /** Base URL for the slot; `KIMI_BASE_URL` overrides, for a gateway in front of Moonshot. */
  baseUrl: string;
  /** `KIMI_CODING_BASE_URL`, separate because the coding plan is a different endpoint. */
  codingBaseUrl: string;
  /** `KIMI_REASONING=off` is an escape hatch for an endpoint that rejects `reasoning_effort`. */
  reasoning: boolean;
};

/** True when any of a slot's env vars holds a key (a stored credential is checked separately). */
export const kimiKeyPresent = (
  names: readonly string[],
  env: Record<string, string | undefined> = process.env
): boolean => names.some((name) => Boolean(trimmed(env[name])));

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

export const kimiOptions = (env: Record<string, string | undefined> = process.env): KimiOptions => {
  const reasoning = trimmed(env.KIMI_REASONING)?.toLowerCase();
  return {
    baseUrl: trimmed(env.KIMI_BASE_URL) ?? MOONSHOT_BASE_URL,
    codingBaseUrl: trimmed(env.KIMI_CODING_BASE_URL) ?? KIMI_CODING_BASE_URL,
    reasoning: !(reasoning === "off" || reasoning === "0" || reasoning === "false" || reasoning === "no"),
  };
};

/** Kimi's K2/K3 families reason; pi-ai's catalog entries say so, and this is the fallback for
 *  a live entry the shipped catalog does not describe. Only K3 takes the effort map below. */
export const kimiReasons = (id: string): boolean => /^kimi-k[23]/i.test(id);

const kimiTakesEffort = (id: string): boolean => /^kimi-k3/i.test(id);

/**
 * The wire shape a Kimi model needs behind a base URL pi-ai cannot recognise as Moonshot: the
 * top-level `reasoning_effort`, `max_tokens` as the output field, and the assistant's
 * `reasoning_content` echoed back on tool-calling turns (K3.x requires it).
 */
export const KIMI_COMPAT: OpenAICompletionsCompat = {
  supportsStrictMode: false,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
  requiresReasoningContentOnAssistantMessages: true,
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolAdditions: true,
};

/** K3.x accepts `low`, `high` and `max`; it cannot be asked to stop thinking, so `off` is `null`. */
export const KIMI_THINKING_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/** The resize limits pi-ai applies before sending an image to Kimi. */
export const KIMI_IMAGE_LIMITS: ModelInputLimits = {
  images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
};

/**
 * The coding-plan slot (`api.kimi.com/coding/v1`) from pi-ai's `kimi-coding` catalog, re-homed onto
 * `KIMI_CODING_BASE_URL` so a gateway reaches it too. Keep each entry's own compat: K3 takes an
 * effort field, while the K2 highspeed entry deliberately does not. The K3 shape is only a
 * fallback for a catalog entry that carries none.
 */
export const kimiCodingModel = (
  catalogModel: Model<"openai-completions">,
  options: KimiOptions
): Model<"openai-completions"> => ({
  ...catalogModel,
  baseUrl: options.codingBaseUrl,
  reasoning: catalogModel.reasoning && options.reasoning,
  compat: catalogModel.compat ?? KIMI_COMPAT,
  inputLimits: catalogModel.inputLimits ?? KIMI_IMAGE_LIMITS,
});

const positive = (value: unknown): number | undefined => {
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
};

/** Moonshot reports the window as `context_length` and again under `limit.context`. */
export const moonshotContextWindow = (entry: MoonshotCatalogEntry): number | undefined =>
  positive(entry.context_length) ?? positive(entry.limit?.context);

export const moonshotMaxTokens = (entry: MoonshotCatalogEntry): number | undefined =>
  positive(entry.max_tokens) ?? positive(entry.limit?.output);

/** Moonshot reports image input as a modality; absent means text only. */
export const moonshotInputs = (entry: MoonshotCatalogEntry): ("text" | "image")[] =>
  entry.modalities?.input?.includes("image") ? ["text", "image"] : ["text"];

const shippedMoonshotModels = new Map(
  moonshotaiProvider()
    .getModels()
    .map((model) => [model.id, model])
);

/**
 * One `/models` entry as a pi-ai model. Pricing, output limits and compat are inherited from
 * pi-ai's shipped `moonshotai` catalog when the id matches, or from the entry's own fields,
 * falling back to conservative defaults (262k window, 32k output, `KIMI_COMPAT` when reasoning).
 */
export const moonshotModel = (entry: MoonshotCatalogEntry, options: KimiOptions): Model<"openai-completions"> => {
  const id = entry.id;
  const shipped = shippedMoonshotModels.get(id);
  const reasoning = options.reasoning && (kimiReasons(id) || Boolean(entry.reasoning) || Boolean(shipped?.reasoning));
  const takesEffort = reasoning && kimiTakesEffort(id);
  const inputs: ("text" | "image")[] = entry.modalities?.input
    ? moonshotInputs(entry)
    : shipped?.input
      ? shipped.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
      : ["text"];
  const cost: ModelCost = entry.cost
    ? {
        input: entry.cost.input ?? shipped?.cost.input ?? 0,
        output: entry.cost.output ?? shipped?.cost.output ?? 0,
        cacheRead: entry.cost.cacheRead ?? shipped?.cost.cacheRead ?? 0,
        cacheWrite: entry.cost.cacheWrite ?? shipped?.cost.cacheWrite ?? 0,
      }
    : (shipped?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const thinkingLevelMap = reasoning
    ? takesEffort
      ? KIMI_THINKING_LEVELS
      : shipped?.thinkingLevelMap
    : undefined;
  return {
    provider: "moonshotai",
    id,
    name: entry.name ?? shipped?.name ?? id,
    api: "openai-completions",
    baseUrl: options.baseUrl,
    reasoning,
    input: inputs,
    cost,
    contextWindow: moonshotContextWindow(entry) ?? shipped?.contextWindow ?? 262_144,
    maxTokens: moonshotMaxTokens(entry) ?? shipped?.maxTokens ?? 32_768,
    ...(reasoning ? { compat: KIMI_COMPAT } : {}),
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    ...(inputs.includes("image") ? { inputLimits: shipped?.inputLimits ?? KIMI_IMAGE_LIMITS } : {}),
  };
};
