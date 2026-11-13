/**
 * Antigravity's model catalogue, read from the account instead of assumed.
 *
 * The provider used to ship a fixed list of eight models and nothing else: `/models` answered from
 * that list, so a Refresh could never reveal anything a `gemini-3.9-flash`-shaped release added, and
 * models the account is entitled to but that list never mentioned were simply absent from the picker.
 * Worse, a model that *was* missing could still be asked for — routing falls back to the public id —
 * which made the omission look like a provider fault rather than a stale catalogue. This closes that:
 * `fetchAvailableModels` is read at refresh time, and the list the picker shows is the account's own.
 *
 * The shape the backend returns is a *runtime* catalogue, not a user-facing one. One public model
 * fans out to several backend ids, one per thinking level (`gemini-3.8-flash-low`,
 * `-medium`, `-high`), some ids are internal placeholders that 404 on the streaming endpoint, and
 * image models share the same map. So the read is a grouping problem, and the rules below are the
 * ones the wire actually needs:
 *
 * - a runtime id loses its thinking-level suffix to become the public id, and the suffix becomes
 *   that level's route;
 * - a model the account is not entitled to is absent from the answer, so the answer is the list —
 *   there is no client-side filtering for entitlement to duplicate;
 * - a public id the backend advertises without any level suffix routes every level to itself,
 *   which is what Claude's plain ids do;
 * - limits are taken from the *smallest* advertised value across a family's runtime ids, so a level
 *   that has a smaller window cannot be handed a prompt sized for the biggest one;
 * - models the endpoint advertises but which fail every request stay usable ids: the catalogue is a
 *   description, not a promise, and a transient 400 on one route is not a reason to hide it.
 */

import type { Model, ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** One model as `fetchAvailableModels` reports it. Every field is advisory. */
type AvailableModel = {
  displayName?: unknown;
  label?: unknown;
  modelName?: unknown;
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  supportsThinking?: unknown;
  supportsImages?: unknown;
  isInternal?: unknown;
  apiProvider?: unknown;
  /** Some releases name the runtime enum instead of the id the request wants. */
  model?: unknown;
};

type AvailableResponse = { models?: Record<string, AvailableModel>; agentModelSorts?: unknown };

export type AntigravityLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Public model id → the backend id to request at each thinking level. */
export type AntigravityRouting = {
  /** The id to send when no level is asked for, and the last resort for every level. */
  defaultRequestId: string;
  off?: string;
  routing: Partial<Record<AntigravityLevel, string>>;
};

/** What a discovered catalogue is: the models to show, and how to address each one. */
export type DiscoveredCatalog = {
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    input: Array<"text" | "image">;
    contextWindow: number;
    maxTokens: number;
  }>;
  routing: Record<string, AntigravityRouting>;
};

/** Suffix → the level it selects. Longer suffixes first: `extra-low` ends with `low` too. */
const THINKING_SUFFIXES: ReadonlyArray<readonly [string, AntigravityLevel]> = [
  ["extra-low", "low"],
  ["extra-high", "xhigh"],
  ["thinking", "high"],
  ["minimal", "minimal"],
  ["medium", "medium"],
  ["high", "high"],
  ["low", "low"],
];

/** The display-name form of a level, e.g. "Gemini 3.8 Flash (High)". */
const DISPLAY_LEVELS: ReadonlyArray<readonly [RegExp, AntigravityLevel]> = [
  [/\(\s*extra\s*low\s*\)/i, "low"],
  [/\(\s*extra\s*high\s*\)/i, "xhigh"],
  [/\(\s*thinking\s*\)/i, "high"],
  [/\(\s*minimal\s*\)/i, "minimal"],
  [/\(\s*medium\s*\)/i, "medium"],
  [/\(\s*high\s*\)/i, "high"],
  [/\(\s*low\s*\)/i, "low"],
];

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const tokenLimit = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * Whether a runtime id is a chat model a person could pick.
 *
 * The map mixes in internal placeholders (`MODEL_…`), analytics ids (`chat_…`, `tab_…`), image
 * endpoints and internal-only providers. Showing any of them would put a model in the picker that
 * cannot answer a prompt, and asking for one returns 404 from the streaming endpoint.
 */
export const isSelectableRuntimeId = (id: string, info?: AvailableModel): boolean => {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(id)) return false;
  if (/^MODEL_/i.test(id)) return false;
  if (/^(chat_|tab_)/i.test(id)) return false;
  if (/image/i.test(id)) return false;
  if (/image/i.test(displayName(info) ?? "")) return false;
  if (info?.isInternal === true) return false;
  if (text(info?.apiProvider) === "API_PROVIDER_INTERNAL") return false;
  return true;
};

const displayName = (info: AvailableModel | undefined): string | undefined =>
  text(info?.displayName) ?? text(info?.label) ?? text(info?.modelName);

/** `gemini-3.8-flash-high` → the public id `gemini-3.8-flash` at level `high`. */
export const parseThinkingSuffix = (runtimeId: string): { baseId: string; level: AntigravityLevel } | undefined => {
  const lower = runtimeId.toLowerCase();
  for (const [suffix, level] of THINKING_SUFFIXES) {
    if (lower.endsWith(`-${suffix}`)) {
      const baseId = runtimeId.slice(0, -(suffix.length + 1));
      // A base id of nothing means the id *was* the suffix; that is not a model.
      if (baseId) return { baseId, level };
    }
  }
  return undefined;
};

const levelFromDisplayName = (name: string | undefined): AntigravityLevel | undefined => {
  if (!name) return undefined;
  for (const [pattern, level] of DISPLAY_LEVELS) if (pattern.test(name)) return level;
  return undefined;
};

/** The family a display name belongs to, with its level qualifier removed. */
const displayFamily = (name: string | undefined): string | undefined =>
  name
    ?.replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
    .trim()
    .toLowerCase() || undefined;

type Group = {
  publicId: string;
  variants: Partial<Record<AntigravityLevel, string>>;
  unsuffixed?: string;
  displayNames: string[];
  supportsThinking?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
};

const ensureGroup = (groups: Map<string, Group>, publicId: string): Group => {
  const existing = groups.get(publicId);
  if (existing) return existing;
  const created: Group = { publicId, variants: {}, displayNames: [] };
  groups.set(publicId, created);
  return created;
};

const absorbMetadata = (group: Group, info: AvailableModel | undefined, name: string | undefined): void => {
  if (name) group.displayNames.push(name);
  // A public model can route to any of its levels, so advertise the smallest limit supplied: a
  // prompt sized for the biggest window would be refused by the level that has the smaller one.
  const contextWindow = tokenLimit(info?.maxTokens);
  const maxOutputTokens = tokenLimit(info?.maxOutputTokens);
  if (contextWindow !== undefined) group.contextWindow = Math.min(group.contextWindow ?? contextWindow, contextWindow);
  if (maxOutputTokens !== undefined) group.maxOutputTokens = Math.min(group.maxOutputTokens ?? maxOutputTokens, maxOutputTokens);
  if (info?.supportsThinking === true) group.supportsThinking = true;
  else if (info?.supportsThinking === false && group.supportsThinking !== true) group.supportsThinking = false;
  if (info?.supportsImages === false) group.supportsImages = false;
  else if (info?.supportsImages === true && group.supportsImages === undefined) group.supportsImages = true;
};

/**
 * Fold a `-agent` id into its family.
 *
 * The backend advertises `gemini-pro-agent` for a family whose other levels are `gemini-3.1-pro-low`
 * and `-high`: the High level arrives under a name that belongs to no public id. Merging keeps one
 * entry in the picker instead of a stray "Gemini Pro Agent" next to the model it is a level of.
 */
const mergeAgentSingletons = (groups: Map<string, Group>): void => {
  for (const [publicId, group] of [...groups.entries()]) {
    if (!publicId.endsWith("-agent") || group.supportsThinking === false) continue;
    const runtimeIds = [group.unsuffixed, ...Object.values(group.variants)].filter(
      (id): id is string => typeof id === "string"
    );
    if (runtimeIds.length !== 1) continue;
    const family = displayFamily(group.displayNames[0]);
    if (!family) continue;
    const target = [...groups.values()].find(
      (candidate) =>
        candidate.publicId !== publicId && candidate.displayNames.some((name) => displayFamily(name) === family)
    );
    if (!target) continue;
    const level =
      (Object.keys(group.variants) as AntigravityLevel[]).find(
        (candidate) => group.variants[candidate] === runtimeIds[0]
      ) ?? levelFromDisplayName(group.displayNames[0]);
    if (!level || target.variants[level]) continue;
    target.variants[level] = runtimeIds[0]!;
    absorbMetadata(
      target,
      {
        supportsThinking: group.supportsThinking,
        supportsImages: group.supportsImages,
        maxTokens: group.contextWindow,
        maxOutputTokens: group.maxOutputTokens,
      },
      group.displayNames[0]
    );
    groups.delete(publicId);
  }
};

/** The route for each level, falling back to the nearest level the family does have. */
const routingFromVariants = (group: Group): AntigravityRouting => {
  const { variants, unsuffixed, publicId } = group;
  const defaultRequestId = variants.low ?? variants.minimal ?? variants.medium ?? variants.high ?? unsuffixed ?? publicId;
  const pick = (...keys: AntigravityLevel[]): string => {
    for (const key of keys) {
      const id = variants[key];
      if (id) return id;
    }
    return unsuffixed ?? defaultRequestId;
  };
  return {
    defaultRequestId,
    off: pick("low", "minimal", "medium", "high"),
    routing: {
      minimal: pick("minimal", "low", "medium", "high"),
      low: pick("low", "minimal", "medium", "high"),
      medium: pick("medium", "low", "high", "minimal"),
      high: pick("high", "medium", "low", "minimal"),
      xhigh: pick("xhigh", "high", "medium", "low"),
    },
  };
};

const thinkingLevelMapFromLevels = (levels: ReadonlySet<string>): ThinkingLevelMap => {
  const map: ThinkingLevelMap = {};
  for (const level of PI_LEVELS) map[level] = levels.has(level) ? level : null;
  return map;
};

/**
 * The levels a model offers.
 *
 * An explicit `supportsThinking: false` wins over anything inferred, because a family can advertise
 * a `-high` runtime id for a model that does not reason — the suffix then names a *tier*, not a
 * level — and offering "High" on such a model promises something the request ignores.
 */
const advertisedLevels = (group: Group): Set<string> => {
  if (group.supportsThinking === false) return new Set();
  const levels = new Set<string>(Object.keys(group.variants));
  if (levels.size > 0) return levels;
  if (group.supportsThinking === true) levels.add("high");
  return levels;
};

/** Humanise a public id for a model the catalogue names nothing better than that. */
export const humanizeModelId = (id: string): string => {
  const tokens = id.split("-");
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const next = tokens[index + 1];
    if (token === "gpt" && next === "oss") {
      words.push("GPT-OSS");
      index += 1;
      continue;
    }
    if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) {
      words.push(`${token}.${next}`);
      index += 1;
      continue;
    }
    if (/^\d/.test(token)) {
      words.push(token.toUpperCase());
      continue;
    }
    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
};

/** Flash first, then Opus/Sonnet, then Pro, then everything else — newest version first. */
const modelRank = (id: string): [number, number] => {
  const version = (() => {
    const match = id.match(/^gemini-(\d+)(?:\.(\d+))?/i);
    return match ? Number(match[1]) * 1000 + Number(match[2] || 0) : 0;
  })();
  if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return [0, -version];
  if (id.startsWith("claude-opus")) return [1, 0];
  if (id.startsWith("claude-sonnet")) return [2, 0];
  if (id.startsWith("claude-")) return [3, 0];
  if (/^gemini-.*pro/i.test(id)) return [4, -version];
  if (id.startsWith("gemini-")) return [5, -version];
  if (id.startsWith("gpt-oss")) return [6, 0];
  return [7, 0];
};

/**
 * Group the runtime catalogue into the models a person picks.
 *
 * `recommendedIds` comes from the answer's `agentModelSorts`: when the backend supplies a curated
 * list, that list is the catalogue (it is what the first-party client shows), and falling back to
 * the whole map happens only when the recommended set groups into nothing.
 */
export const buildDiscoveredCatalog = (
  raw: Record<string, AvailableModel>,
  fallback: {
    /** Used only for limits and price a brand-new family does not report. */
    defaults: (publicId: string) => { contextWindow?: number; maxTokens?: number; input?: Array<"text" | "image">; reasoning?: boolean };
  },
  agentModelSorts?: unknown
): DiscoveredCatalog => {
  const recommended = extractRecommendedIds(agentModelSorts);

  const collect = (filter?: ReadonlySet<string>): Map<string, Group> => {
    const groups = new Map<string, Group>();
    for (const [runtimeId, info] of Object.entries(raw)) {
      if (!isSelectableRuntimeId(runtimeId, info)) continue;
      if (filter && !filter.has(runtimeId)) continue;
      const name = displayName(info);
      // `-tiered` is the same model under a billing split, not a separate one: it contributes
      // limits and a route, never an id of its own.
      if (runtimeId.endsWith("-tiered")) {
        const group = ensureGroup(groups, runtimeId.slice(0, -"-tiered".length));
        absorbMetadata(group, info, name);
        group.unsuffixed ??= runtimeId;
        continue;
      }
      const suffix = parseThinkingSuffix(runtimeId);
      const group = ensureGroup(groups, suffix?.baseId ?? runtimeId);
      absorbMetadata(group, info, name);
      const level = levelFromDisplayName(name) ?? suffix?.level;
      if (level) group.variants[level] = runtimeId;
      else group.unsuffixed = runtimeId;
    }
    mergeAgentSingletons(groups);
    return groups;
  };

  let groups = collect(recommended);
  if (groups.size === 0 && recommended) groups = collect();

  const models: DiscoveredCatalog["models"] = [];
  const routing: Record<string, AntigravityRouting> = {};
  for (const group of groups.values()) {
    const levels = advertisedLevels(group);
    const defaults = fallback.defaults(group.publicId);
    const reasoning = group.supportsThinking === false ? false : levels.size > 0 || group.supportsThinking === true || Boolean(defaults.reasoning);
    const family = group.displayNames.map(displayFamily).find(Boolean);
    const input: Array<"text" | "image"> = (group.supportsImages ?? defaults.input?.includes("image") ?? true) ? ["text", "image"] : ["text"];
    models.push({
      id: group.publicId,
      name: `${family ? titleCase(family) : humanizeModelId(group.publicId)} (Antigravity)`,
      reasoning,
      ...(reasoning ? { thinkingLevelMap: thinkingLevelMapFromLevels(levels) } : {}),
      input,
      contextWindow: group.contextWindow ?? defaults.contextWindow ?? 128_000,
      maxTokens: group.maxOutputTokens ?? defaults.maxTokens ?? 8_192,
    });
    routing[group.publicId] = routingFromVariants(group);
  }

  models.sort((a, b) => {
    const [rankA, versionA] = modelRank(a.id);
    const [rankB, versionB] = modelRank(b.id);
    return rankA !== rankB ? rankA - rankB : versionA !== versionB ? versionA - versionB : a.id.localeCompare(b.id);
  });
  return { models, routing };
};

const titleCase = (value: string): string => value.replace(/\b([a-z])/g, (char) => char.toUpperCase());

/** Every id the answer's curated groups mention. */
const extractRecommendedIds = (agentModelSorts: unknown): Set<string> | undefined => {
  if (!Array.isArray(agentModelSorts)) return undefined;
  const ids = new Set<string>();
  for (const sort of agentModelSorts) {
    if (!isRecord(sort) || !Array.isArray(sort.groups)) continue;
    for (const group of sort.groups) {
      if (!isRecord(group) || !Array.isArray(group.modelIds)) continue;
      for (const id of group.modelIds) if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids.size > 0 ? ids : undefined;
};

export type { ModelCost };
