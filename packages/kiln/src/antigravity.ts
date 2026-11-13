/**
 * Google Antigravity: the Cloud Code Assist transport, registered as pi-ai provider `antigravity`.
 *
 * pi-ai ships no provider for it, so Hearth supplies one the way `deepinfra.ts` does — a catalog
 * plus `createProvider` — except that the wire is not OpenAI-shaped. It is Gemini's
 * `generateContent` request, wrapped in the Cloud Code Assist `{ project, model, request }` envelope.
 * Antigravity CLI sends, streaming SSE where each frame is `{ response: GenerateContentResponse }`.
 * The shape below is re-implemented from the community `pi-antigravity` extension; nothing is
 * imported from it.
 *
 * Three things are Antigravity-specific and worth knowing before reading the request builder:
 *
 * - One public model id fans out to several backend ids, one per thinking level
 *   (`gemini-3.8-flash` → `gemini-3.8-flash-low`), so the routing table is what `streamSimple`
 *   consults before anything is sent.
 * - The backend rejects a request that is a bare model turn or ends on a tool call, so the
 *   conversation gets a natural-language user turn when the history does not already end in one.
 * - The outer Cloud Code Assist envelope stays minimal; optional trajectory metadata belongs in
 *   the nested Vertex request, not beside `project`, `model` and `request`.
 */

import { randomUUID } from "node:crypto";
import {
  calculateCost,
  clampThinkingLevel,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  createProvider,
  getCurrentTools,
  getSupportedThinkingLevels,
  getSystemMessageText,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ModelCost,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type StreamOptions,
  type ThinkingLevelMap,
  type ThinkingLevel,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { convertMessages, convertTools, mapStopReasonString } from "@earendil-works/pi-ai/api/google-shared";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { credentialProjectId, antigravityOAuth, parseAntigravityApiKey } from "./antigravity-oauth";
import { fetchAntigravityModels } from "./antigravity-discovery";
import type { AntigravityRouting } from "./antigravity-catalog";

export const ANTIGRAVITY_API = "antigravity";
const PROVIDER_ID = "antigravity";
const BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

/**
 * Mimicking the CLI is the point: the Cloud Code Assist backend gates catalog visibility and
 * request acceptance on this fingerprint, not on anything the account controls.
 */
const USER_AGENT = "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; auth=consumer)";
/** Guards an error body before it reaches a transcript. */
const MAX_ERROR_BODY = 600;
const CONTINUATION_TEXT = "Continue the active task using the available instructions and context.";

// --- catalog -----------------------------------------------------------------------------------

/**
 * Per-model list prices in USD per MILLION tokens, from the same sources pi-ai's own catalogs use
 * (LiteLLM, which tracks Google's published pricing). Gemini bills cached content as storage per
 * hour rather than per token, so `cacheWrite` mirrors `input` — there is no separate write rate.
 */
const gemini38FlashCost: ModelCost = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
const gemini37FlashCost: ModelCost = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
const gemini36FlashCost: ModelCost = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
const gemini35FlashCost: ModelCost = { input: 1.5, output: 9.0, cacheRead: 0.15, cacheWrite: 1.5 };
const gemini31ProCost: ModelCost = { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.0 };
const claudeSonnetCost: ModelCost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const claudeOpusCost: ModelCost = { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 };
const gptOssCost: ModelCost = { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 };

/**
 * The values are the thinking levels the backend advertises, not the effort itself: a `null` level
 * is one the model does not offer, so the picker must not show it.
 */
const thinkingLevelMaps = {
  lowMediumHigh: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  lowHigh: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
  thinking: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
  medium: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
} satisfies Record<string, ThinkingLevelMap>;

/**
 * Public model id → the backend model id to request at each thinking level, plus the id used when
 * no level is chosen. `off` is present only where the backend serves a plain id.
 */
type Routing = { readonly routing: Partial<Record<ModelThinkingLevel, string>>; readonly defaultRequestId: string; readonly off?: string };

/**
 * What the catalogue read learned, layered over the static table below.
 *
 * The static table is what a fresh install can address before any network call; a discovery
 * replaces it with the account's own ids, and falls back to the static entry for anything the
 * account did not advertise (a model removed by discovery is not addressable, but the static route
 * still names a valid backend id if a session already carries that model).
 */
let discoveredRouting: Record<string, AntigravityRouting> | undefined;

/** Install (or clear) the routes a catalogue read produced. */
export const setDiscoveredRouting = (routing: Record<string, AntigravityRouting> | undefined): void => {
  discoveredRouting = routing;
};

const ANTIGRAVITY_ROUTING: Readonly<Record<string, Routing>> = {
  "gemini-3.8-flash": {
    off: "gemini-3.8-flash-low",
    routing: {
      minimal: "gemini-3.8-flash-low",
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
      xhigh: "gemini-3.8-flash-high",
    },
    defaultRequestId: "gemini-3.8-flash-low",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-low",
    routing: {
      minimal: "gemini-3.7-flash-low",
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
      xhigh: "gemini-3.7-flash-high",
    },
    defaultRequestId: "gemini-3.7-flash-low",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-low",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3.5-flash-extra-low",
  },
  "gemini-3.1-pro": {
    // `gemini-3.1-pro-high` is advertised but 400s for agent streams; `gemini-pro-agent` is the
    // backend id that actually serves the High level.
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-3.1-pro-low",
  },
  "claude-opus-4-6": {
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6",
    routing: {
      minimal: "claude-sonnet-4-6",
      low: "claude-sonnet-4-6",
      medium: "claude-sonnet-4-6",
      high: "claude-sonnet-4-6",
      xhigh: "claude-sonnet-4-6",
    },
    defaultRequestId: "claude-sonnet-4-6",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

/**
 * The reasoning level a request was made at. pi-ai's `ThinkingLevel` has no "off" — a model with
 * reasoning support always runs at *some* level — so "off" is this file's own name for the level
 * the picker offers as "Off", and it selects the plain runtime id.
 */
type AntigravityLevel = ModelThinkingLevel;

/** The backend id for `modelId` at `level`, falling back to the level's own id. */
function runtimeModelId(modelId: string, level: AntigravityLevel | undefined): string {
  const discovered = discoveredRouting?.[modelId];
  if (discovered) {
    if (!level || level === "off") return discovered.off ?? discovered.defaultRequestId;
    const routed = discovered.routing[level as keyof AntigravityRouting["routing"]];
    return routed ?? discovered.defaultRequestId;
  }
  const route = ANTIGRAVITY_ROUTING[modelId];
  if (!route) return modelId;
  if (!level || level === "off") return route.off ?? route.defaultRequestId;
  return route.routing[level] ?? route.defaultRequestId;
}

/** One catalog entry. `input` varies because GPT-OSS 120B takes text only. */
function modelEntry(
  id: string,
  name: string,
  cost: ModelCost,
  thinkingLevelMap: ThinkingLevelMap,
  contextWindow: number,
  maxTokens: number,
  input: readonly ("text" | "image")[] = ["text", "image"]
): Model<typeof ANTIGRAVITY_API> {
  return {
    id,
    name,
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    input: [...input],
    reasoning: true,
    thinkingLevelMap,
    cost,
    contextWindow,
    maxTokens,
  };
}

/** Same set as `agy models`, collapsed to the public ids the picker offers. */
export const ANTIGRAVITY_MODELS: readonly Model<typeof ANTIGRAVITY_API>[] = [
  modelEntry("gemini-3.8-flash", "Gemini 3.8 Flash (Antigravity)", gemini38FlashCost, thinkingLevelMaps.lowMediumHigh, 1_048_576, 65_536),
  modelEntry("gemini-3.7-flash", "Gemini 3.7 Flash (Antigravity)", gemini37FlashCost, thinkingLevelMaps.lowMediumHigh, 1_048_576, 65_536),
  modelEntry("gemini-3.6-flash", "Gemini 3.6 Flash (Antigravity)", gemini36FlashCost, thinkingLevelMaps.lowMediumHigh, 1_048_576, 65_536),
  modelEntry("gemini-3.5-flash", "Gemini 3.5 Flash (Antigravity)", gemini35FlashCost, thinkingLevelMaps.lowMediumHigh, 1_048_576, 65_536),
  modelEntry("gemini-3.1-pro", "Gemini 3.1 Pro (Antigravity)", gemini31ProCost, thinkingLevelMaps.lowHigh, 1_048_576, 65_535),
  modelEntry("claude-sonnet-4-6", "Claude Sonnet 4.6 (Antigravity)", claudeSonnetCost, thinkingLevelMaps.thinking, 200_000, 64_000),
  modelEntry("claude-opus-4-6", "Claude Opus 4.6 (Antigravity)", claudeOpusCost, thinkingLevelMaps.thinking, 250_000, 64_000),
  modelEntry("gpt-oss-120b", "GPT-OSS 120B (Antigravity)", gptOssCost, thinkingLevelMaps.medium, 131_072, 32_768, ["text"]),
];

// --- request -----------------------------------------------------------------------------------

/** Gemini's wire shapes, as far as this file writes them. */
type WirePart = {
  text?: string;
  thought?: true;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, string>; id?: string };
};
type WireContent = { role: "user" | "model"; parts: WirePart[] };

/** Claude and GPT-OSS need function-call ids echoed back; Gemini tolerates, but does not need them. */
function needsToolCallIds(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

/** Whether a level asks for any thinking at all; "off" and "unset" both mean none. */
function thinkingRequested(level: AntigravityLevel | undefined): boolean {
  return level !== undefined && level !== "off";
}

const THINKING_OFF = { includeThoughts: false, thinkingBudget: 0 } as const;

/**
 * The thinking budget to send for a runtime id. The backend refuses a budget of 0 on some models
 * and a budget of -1 ("as much as you want") on others, so the value is per family: Claude and
 * GPT-OSS take a small fixed budget, Pro takes its odd 1001/10001 pair, Flash accepts -1, and an
 * unknown id gets no thinking config at all rather than a guess.
 */
function thinkingConfig(
  runtimeModel: string,
  level: AntigravityLevel | undefined
): { includeThoughts: boolean; thinkingBudget: number } | undefined {
  const isClaudeOrOss = runtimeModel.startsWith("claude-") || runtimeModel.startsWith("gpt-oss-");
  if (!thinkingRequested(level)) {
    // Claude and GPT-OSS still require the field; for Gemini, its absence means off.
    return isClaudeOrOss ? THINKING_OFF : undefined;
  }
  const high = level === "high" || level === "xhigh";
  if (runtimeModel.startsWith("claude-")) return { includeThoughts: true, thinkingBudget: 1024 };
  if (runtimeModel.startsWith("gpt-oss-")) return { includeThoughts: true, thinkingBudget: 8192 };
  if (runtimeModel.startsWith("gemini-3.5-flash") || runtimeModel === "gemini-3-flash-agent") {
    return { includeThoughts: true, thinkingBudget: high ? 10_000 : level === "medium" ? 4_000 : 1_000 };
  }
  if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") {
    return { includeThoughts: true, thinkingBudget: high ? 10_001 : 1_001 };
  }
  if (runtimeModel.startsWith("gemini-")) {
    return { includeThoughts: true, thinkingBudget: high ? -1 : level === "medium" ? 4_000 : 1_000 };
  }
  return undefined;
}

/**
 * Antigravity rejects two histories Gemini itself tolerates: a model turn that is not preceded by a
 * user turn (tool-call-only compaction drops that boundary, and the request is then a function call
 * with nothing to answer), and a request whose last turn is the model's. Both are repaired here,
 * after the shared converter, rather than in a second converter.
 */
function repairTurnBoundaries(contents: WireContent[]): WireContent[] {
  for (let index = 0; index < contents.length; index += 1) {
    const turn = contents[index];
    if (turn?.role === "model" && turn.parts.some((part) => part.functionCall) && contents[index - 1]?.role !== "user") {
      contents.splice(index, 0, { role: "user", parts: [{ text: CONTINUATION_TEXT }] });
      index += 1;
    }
  }
  const hasUserText = contents.some(
    (turn) => turn.role === "user" && turn.parts.some((part) => (part.text ?? "").trim() !== "")
  );
  if (!hasUserText && contents.length > 0) {
    const userTurn = contents.find((turn) => turn.role === "user");
    if (userTurn) userTurn.parts.push({ text: CONTINUATION_TEXT });
    else contents.unshift({ role: "user", parts: [{ text: CONTINUATION_TEXT }] });
  }
  if (contents.at(-1)?.role === "model") contents.push({ role: "user", parts: [{ text: CONTINUATION_TEXT }] });
  return contents;
}

/** Build the `v1internal:streamGenerateContent` body. Pure, so it can be read as the wire contract. */
export function buildAntigravityRequest(
  model: AntigravityModel,
  context: TranscriptContext,
  projectId: string,
  runtimeModel: string,
  level: AntigravityLevel | undefined,
  options: StreamOptions
): Record<string, unknown> {
  const messages = collapseSystemMessages(context).messages;
  // Antigravity's contents are exactly Gemini's, so the shared converter does the five conversions
  // instead of a second copy of them here. It is typed for Google's own API ids; the only field it
  // reads from the model is provider/id, which Antigravity's catalog sets like any other.
  const asGemini = model as unknown as Model<"google-generative-ai">;
  const contents = repairTurnBoundaries(convertMessages(asGemini, context) as WireContent[]);

  const systemMessage = messages[0]?.role === "system" ? messages[0] : undefined;
  const system = systemMessage ? getSystemMessageText(systemMessage) : "";
  // The tools are the transcript's: a conversation carries its own tool declarations (and any
  // update to them) as messages, so the current set is derived rather than passed alongside.
  const declarations = getCurrentTools(messages);
  // Claude and GPT-OSS are served through a translation layer that wants OpenAPI-shaped parameters;
  // Gemini takes full JSON Schema.
  const tools = declarations.length > 0 ? convertTools(declarations, needsToolCallIds(runtimeModel)) : undefined;

  const generationConfig: Record<string, unknown> = { maxOutputTokens: options.maxTokens ?? model.maxTokens };
  if (options.temperature !== undefined) generationConfig["temperature"] = options.temperature;
  const thinking = thinkingConfig(runtimeModel, level);
  if (thinking) generationConfig["thinkingConfig"] = thinking;

  const request: Record<string, unknown> = { contents, generationConfig };
  if (system) request["systemInstruction"] = { role: "user", parts: [{ text: system }] };
  if (tools) request["tools"] = tools;
  // pi-ai's StreamOptions has no tool choice (only SimpleStreamOptions does) and the simple options
  // are carried straight through, so the field is read wherever a host put it.
  if ((options as { toolChoice?: string }).toolChoice === "none") {
    request["toolConfig"] = { functionCallingConfig: { mode: "NONE" } };
  }

  // Keep the outer envelope to fields verified in public Cloud Code Assist client/proxy
  // implementations. The user-reported error rejects outer `labels`; optional Vertex labels,
  // when needed, belong in `request` and are not sent here.
  return {
    project: projectId,
    model: runtimeModel,
    request,
  };
}

// --- response ----------------------------------------------------------------------------------

type UsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

/** An SSE frame is either { response } or the response itself. */
type StreamChunk = Partial<GenerateResponse> & {
  error?: { code?: number; message?: string };
  response?: GenerateResponse;
};

type GeneratePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
};

type GenerateResponse = {
  candidates?: Array<{
    content?: { parts?: GeneratePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
  responseId?: string;
};

let toolCallCounter = 0;

/** Tool ids the backend omits must still be unique, or two parallel calls collapse into one. */
function toolCallId(name: string, providedId: string | undefined, used: Set<string>): string {
  if (providedId && !used.has(providedId)) return providedId;
  return `${name}_${Date.now()}_${++toolCallCounter}`;
}

function bounded(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_ERROR_BODY ? `${trimmed.slice(0, MAX_ERROR_BODY)}…` : trimmed;
}

/** Thrown by the line reader when a frame is split across two network chunks, not rejected by it. */
class PartialFrame extends Error {}

/**
 * Read the SSE body into `output`. Throws on anything the caller must turn into a stream error, so
 * the single try/catch in `stream` owns the one place where a partial message becomes an error
 * event. Returns nothing: the events are pushed as they arrive.
 */
async function readSse(
  model: AntigravityModel,
  body: ReadableStream<Uint8Array>,
  events: AssistantMessageEventStream,
  output: AssistantMessage,
  signal: AbortSignal | undefined
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let block: { type: "text" | "thinking"; index: number } | undefined;
  let started = false;
  const blocks = output.content;
  const usedIds = new Set<string>();
  // The chunk that carries the assistant text and the one that carries the finish reason are often
  // separate frames, so an ending frame must not reset the parsed content to "no response yet".
  let sawChunk = false;
  let finished = false;

  const endBlock = () => {
    if (!block) return;
    if (block.type === "text") {
      const content = blocks[block.index];
      events.push({
        type: "text_end",
        contentIndex: block.index,
        content: content?.type === "text" ? content.text : "",
        partial: output,
      });
    } else {
      const content = blocks[block.index];
      events.push({
        type: "thinking_end",
        contentIndex: block.index,
        content: content?.type === "thinking" ? content.thinking : "",
        partial: output,
      });
    }
    block = undefined;
  };

  const handleChunk = (chunk: StreamChunk) => {
    if (chunk.error) {
      const message = chunk.error.message ? bounded(chunk.error.message) : "Antigravity reported an error.";
      throw new Error(message);
    }
    // A frame either nests its payload under "response" or is the payload itself.
    const response = chunk.response ?? chunk;
    sawChunk = true;
    if (!started) {
      events.push({ type: "start", partial: output });
      started = true;
    }
    if (response.modelVersion) output.responseModel = response.modelVersion;
    if (response.responseId) output.responseId ??= response.responseId;

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.text !== undefined) {
        const type = part.thought === true ? "thinking" : "text";
        if (!block || block.type !== type) {
          endBlock();
          blocks.push(type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
          const contentIndex = blocks.length - 1;
          block = { type, index: contentIndex };
          events.push({ type: type === "thinking" ? "thinking_start" : "text_start", contentIndex, partial: output });
        }
        const target = blocks[block.index];
        if (target?.type === "thinking") {
          // Some backends send the signature only on the first delta of a part, so keep the last
          // one seen instead of overwriting it with undefined.
          target.thinking += part.text;
          if (part.thoughtSignature) target.thinkingSignature = part.thoughtSignature;
          events.push({ type: "thinking_delta", contentIndex: block.index, delta: part.text, partial: output });
        } else if (target?.type === "text") {
          target.text += part.text;
          if (part.thoughtSignature) target.textSignature = part.thoughtSignature;
          events.push({ type: "text_delta", contentIndex: block.index, delta: part.text, partial: output });
        }
      }
      if (part.functionCall) {
        endBlock();
        const call: ToolCall = {
          type: "toolCall",
          id: toolCallId(part.functionCall.name ?? "", part.functionCall.id, usedIds),
          name: part.functionCall.name ?? "",
          arguments: (part.functionCall.args ?? {}) as ToolCall["arguments"],
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        };
        usedIds.add(call.id);
        blocks.push(call);
        const contentIndex = blocks.length - 1;
        events.push({ type: "toolcall_start", contentIndex, partial: output });
        events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
        events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
      }
    }

    const finishReason = chunk.response?.candidates?.[0]?.finishReason;
    if (finishReason) {
      output.rawStopReason = finishReason;
      output.stopReason = mapStopReasonString(finishReason);
      if (blocks.some((item) => item.type === "toolCall") && output.stopReason === "stop") output.stopReason = "toolUse";
    }

    const usage = response.usageMetadata;
    if (usage) {
      const cacheRead = usage.cachedContentTokenCount ?? 0;
      const reasoning = usage.thoughtsTokenCount ?? 0;
      output.usage = {
        input: (usage.promptTokenCount ?? 0) - cacheRead,
        output: (usage.candidatesTokenCount ?? 0) + reasoning,
        cacheRead,
        cacheWrite: 0,
        reasoning,
        totalTokens: usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0) + reasoning,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      calculateCost(model, output.usage);
    }

    if (signal?.aborted) throw new Error("Request was aborted.");
  };

  /** One SSE line, or one fragment of one: the buffer holds everything not yet consumed. */
  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const json = line.slice(5).trim();
    if (json === "[DONE]") {
      // The sentinel ends the stream; whatever follows is not part of this response.
      finished = true;
      return;
    }
    if (!json) return;
    try {
      handleChunk(JSON.parse(json) as StreamChunk);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // A frame split across two network chunks is not a failure: the rest of it is still coming,
        // so the line is put back and read again after the next read. Only a frame that is still
        // broken once the stream has ended is lost, and then the missing finishReason says so.
        throw new PartialFrame();
      }
      throw error;
    }
  };

  for (;;) {
    if (finished) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      try {
        consumeLine(line);
      } catch (error) {
        if (!(error instanceof PartialFrame)) throw error;
        // Re-join this fragment with whatever follows it. Keeping the line (rather than dropping it)
        // is the whole fix: the rest of the frame is in the next read, and a line rejoined without
        // its own prefix leaves a sentence where a JSON document should be.
        buffer = line + "\n" + buffer;
        break;
      }
    }
  }
  // The stream ended. A trailing line with no newline after it is still a frame.
  buffer += decoder.decode();
  if (!finished && buffer.trim()) {
    try {
      consumeLine(buffer.replace(/\r$/, ""));
    } catch (error) {
      if (!(error instanceof PartialFrame)) throw error;
    }
  }

  endBlock();
  if (!started && !sawChunk) throw new Error("Antigravity closed the connection without sending anything. Try again.");
  if (output.stopReason === "pending" && output.content.every((block) => block.type === "toolCall")) {
    // An agent turn that ends on tool calls frequently arrives without a finish reason; the calls
    // are the completion signal the backend forgot to send.
    output.rawStopReason = output.rawStopReason ?? "STOP";
    output.stopReason = "toolUse";
  }
  if (output.stopReason === "pending") {
    throw new Error("Antigravity ended the response before it finished. Try again.");
  }
}

// --- provider ----------------------------------------------------------------------------------

/** The `model` argument of the two stream functions, already resolved by pi-ai. */
type AntigravityModel = Model<typeof ANTIGRAVITY_API>;

/**
 * The level a request runs at: whatever `streamSimple` resolved, else the model's own "Off" level,
 * which every entry in this catalog maps so it is always a valid id to ask for.
 */
function requestedLevel(model: AntigravityModel, options: StreamOptions | undefined): AntigravityLevel {
  const reasoning = (options as { reasoning?: ThinkingLevel } | undefined)?.reasoning;
  if (reasoning) return clampThinkingLevel(model, reasoning);
  return model.thinkingLevelMap?.off === null ? (getSupportedThinkingLevels(model)[0] ?? "off") : "off";
}

export function stream(model: AntigravityModel, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream {
  const events = createAssistantMessageEventStream();
  const signal = options?.signal;
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      const apiKey = options?.apiKey;
      if (!apiKey) throw new Error("Antigravity is not signed in. Sign in from Ember's Providers screen.");
      const credentials = parseAntigravityApiKey(apiKey);
      const level = requestedLevel(model, options);
      const runtimeModel = runtimeModelId(model.id, level);
      let body = buildAntigravityRequest(model, context, credentials.projectId, runtimeModel, level, options ?? {});
      const replaced = await options?.onPayload?.(body, model);
      if (replaced !== undefined) body = replaced as Record<string, unknown>;

      const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal,
      });
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
      if (!response.ok || !response.body) {
        const detail = bounded(await response.text().catch(() => ""));
        throw new Error(
          response.status === 401 || response.status === 403
            ? `Antigravity refused this sign-in (${response.status}). Sign in again from Ember's Providers screen.${detail ? ` Google said: ${detail}` : ""}`
            : `Antigravity answered ${response.status}${detail ? `: ${detail}` : " with no details."}`
        );
      }
      await readSse(model, response.body, events, output, signal);

      events.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      events.end();
    } catch (error) {
      output.stopReason = signal?.aborted ? "aborted" : "error";
      output.errorMessage = signal?.aborted ? "Stopped." : error instanceof Error ? error.message : String(error);
      events.push({ type: "error", reason: output.stopReason, error: output });
      events.end();
    }
  })();

  return events;
}

/**
 * The simple entry point: the only thing to decide before `stream` is *which* backend id to ask
 * for, because the thinking level is encoded in the id rather than in the request.
 */
export function streamSimple(model: AntigravityModel, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const base = buildBaseOptions(model, context, options, options?.apiKey);
  return stream(model, context, { ...base, reasoning: requestedLevel(model, options) } as StreamOptions & { reasoning: AntigravityLevel });
}

export function antigravityProvider() {
  return createProvider<typeof ANTIGRAVITY_API>({
    id: PROVIDER_ID,
    name: "Google (Antigravity)",
    baseUrl: BASE_URL,
    auth: { oauth: antigravityOAuth },
    models: ANTIGRAVITY_MODELS,
    api: { stream, streamSimple },
    /**
     * The account's own catalogue, read on every refresh.
     *
     * Without this the picker only ever showed the static table, so a model the account is entitled
     * to but the table never listed was invisible — and a new release could not appear on Refresh at
     * all. The read installs its routing at the same time, so a discovered model can actually be
     * addressed: a catalogue entry with no route would send the public id, which the backend does
     * not serve.
     */
    fetchModels: async (context) => {
      const models = await fetchAntigravityModels(
        {
          ...(context.credential === undefined ? {} : { credential: context.credential }),
          allowNetwork: context.allowNetwork,
          signal: context.signal,
        },
        (publicId) => {
          const staticModel = ANTIGRAVITY_MODELS.find((entry) => entry.id === publicId);
          if (staticModel) {
            return {
              contextWindow: staticModel.contextWindow,
              maxTokens: staticModel.maxTokens,
              input: staticModel.input,
              reasoning: staticModel.reasoning,
              cost: staticModel.cost,
            };
          }
          // A family this table does not list still has a kind and a rate. Falling back to the
          // family's price keeps a new Flash from being reported as free, and its reasoning from
          // being reported as absent — the two things the picker and the cost badge read.
          return {
            ...(familyCost(publicId) ? { cost: familyCost(publicId) } : {}),
            reasoning: familyReasons(publicId),
          };
        },
        setDiscoveredRouting
      );
      return models;
    },
  });
}


/**
 * The published rate for a family the static table does not list, by the shape of its id.
 *
 * Returning nothing (not zero) for a genuinely unknown family is deliberate: zero is rendered as
 * "free", which would hide real spend, while absent is rendered as unknown.
 */
function familyCost(publicId: string): ModelCost | undefined {
  if (/claude-opus/i.test(publicId)) return claudeOpusCost;
  if (/claude/i.test(publicId)) return claudeSonnetCost;
  if (/gpt-oss/i.test(publicId)) return gptOssCost;
  if (/flash/i.test(publicId)) return gemini38FlashCost;
  if (/gemini.*pro/i.test(publicId)) return gemini31ProCost;
  return undefined;
}

/** Whether a family the table does not list is a reasoning family. */
function familyReasons(publicId: string): boolean {
  return /^(gemini|claude|gpt-oss)/i.test(publicId);
}

/** Re-exported so callers that only import the provider still reach the login flow. */
export { antigravityOAuth, parseAntigravityApiKey } from "./antigravity-oauth";
