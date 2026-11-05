/**
 * The composer's context meter, as a pure derivation (unit-tested in `contextMeter.test.ts`).
 *
 * The two numbers the meter draws with come from different places: the token count is what the
 * *last turn* reported, and the window belongs to whatever model is *selected now*. Comparing them
 * across a model switch is comparing two unrelated quantities — and, worse, the old code fed that
 * ratio to an automatic compaction, so picking a small-window model could rewrite the session's
 * history on a denominator the turn never ran against.
 *
 * So a percentage exists only when both sides are the same model:
 * - the numerator is the last completed assistant turn's prompt + output tokens;
 * - the denominator is the selected model's window, and only when the selected model is the model
 *   that recorded the turn.
 *
 * Everything else is `unknown`, with the reason kept so the tooltip can say which fact is missing.
 * `none` is separate from `unknown` on purpose: a session that has not finished a turn yet has
 * nothing to report, so the meter stays out of the way rather than claiming ignorance.
 */
import type { ChatMessage, ModelRef, TokenUsage } from '../types';

/** The slice of a catalogue model the meter needs: its identity and its context window. */
export type ContextWindowSource = {
  providerID: string;
  modelID: string;
  details?: { contextTokens?: number };
};

export type ContextUnknownReason =
  /** The last completed turn reported no token usage (some providers don't). */
  | 'no-usage'
  /** The turn has usage but no recorded model, so there is no window to look up. */
  | 'no-turn-model'
  /** The composer is set to a different model than the one the turn ran on. */
  | 'model-changed'
  /** The model that ran the turn reports no context window. */
  | 'no-window';

export type ContextMeterState =
  /** No completed assistant turn yet: there is genuinely nothing to report. */
  | { kind: 'none' }
  | {
      kind: 'unknown';
      reason: ContextUnknownReason;
      /** The last turn's token count, when it reported one. */
      used?: number;
      turnModel?: ModelRef;
      selectedModel?: ModelRef;
    }
  | { kind: 'known'; used: number; limit: number; percent: number; model: ModelRef };

const refOf = (model: ContextWindowSource | undefined): ModelRef | undefined =>
  model ? { providerID: model.providerID, modelID: model.modelID } : undefined;

const sameModel = (a: ModelRef | undefined, b: ContextWindowSource | undefined): boolean =>
  Boolean(a && b && a.providerID === b.providerID && a.modelID === b.modelID);

/** Tokens the turn put in the window: its prompt (fresh + cached) plus what it wrote back. */
export const tokensInContext = (tokens: TokenUsage): number =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

/** Compact token counts for tooltips ("21k", "1.2M"). */
export const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return `${count}`;
};

/**
 * What the context meter can honestly say about `messages` under `selectedModel`.
 *
 * `selectedModel` is the model the *next* turn will run on (the composer's selection, or the
 * instance default while the composer is on "server default"). It supplies the window only when it
 * is also the model that ran the measured turn.
 */
export const contextMeterState = (
  messages: readonly ChatMessage[],
  selectedModel: ContextWindowSource | undefined
): ContextMeterState => {
  // The last *completed* turn: a live one has no usage yet, and the previous turn's count is what
  // is actually sitting in the window while it streams.
  let last: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && !message.live) {
      last = message;
      break;
    }
  }
  if (!last) return { kind: 'none' };

  const selected = refOf(selectedModel);
  const turnModel = last.model;
  const used = last.tokens ? tokensInContext(last.tokens) : 0;
  if (!last.tokens || used <= 0) {
    return { kind: 'unknown', reason: 'no-usage', turnModel, selectedModel: selected };
  }
  if (!turnModel) {
    return { kind: 'unknown', reason: 'no-turn-model', used, selectedModel: selected };
  }
  if (!sameModel(turnModel, selectedModel)) {
    return { kind: 'unknown', reason: 'model-changed', used, turnModel, selectedModel: selected };
  }
  const limit = selectedModel?.details?.contextTokens;
  if (!limit || limit <= 0) {
    return { kind: 'unknown', reason: 'no-window', used, turnModel, selectedModel: selected };
  }
  const percent = Math.max(0, Math.round((used / limit) * 100));
  return { kind: 'known', used, limit, percent, model: turnModel };
};

/** What the meter calls the state in which it has no honest percentage. */
export const CONTEXT_UNKNOWN_LABEL = 'Context unknown';

const modelName = (ref: ModelRef | undefined): string => ref?.modelID ?? 'an unrecorded model';

/** Why the meter can't say a percentage, in one clause the reader can act on. */
const unknownReason = (state: Extract<ContextMeterState, { kind: 'unknown' }>): string => {
  switch (state.reason) {
    case 'no-usage':
      return "the last turn didn't report token usage, so how full the context is isn't known";
    case 'no-turn-model':
      return "the last turn didn't record which model ran it, so there's no window to measure against";
    case 'model-changed':
      return `the last turn ran on ${modelName(state.turnModel)}, but the composer is set to ${modelName(
        state.selectedModel
      )} — Ember only measures a turn against the model that ran it`;
    case 'no-window':
      return `${modelName(state.turnModel)} reports no context window, so there's no percentage to show`;
  }
};

/** The hover text for the ring. Always ends by naming the click, which still works when unknown. */
export const contextMeterTooltip = (state: ContextMeterState): string => {
  if (state.kind === 'known') {
    return `Context ${state.percent}% used · ${formatTokenCount(state.used)} / ${formatTokenCount(
      state.limit
    )} on ${state.model.modelID} — click to compact`;
  }
  if (state.kind === 'unknown') {
    return `${CONTEXT_UNKNOWN_LABEL} — ${unknownReason(state)}. Click to compact anyway.`;
  }
  return 'Click to compact';
};

/** The screen-reader label: the same facts the tooltip gives, without relying on hover. */
export const contextMeterLabel = (state: ContextMeterState): string => {
  if (state.kind === 'known') return `Context ${state.percent}% used. Click to compact.`;
  if (state.kind === 'unknown') return `${CONTEXT_UNKNOWN_LABEL}: ${unknownReason(state)}. Click to compact.`;
  return 'Compact context';
};

