import { DEFAULT_MODEL, modelRefKey } from '../types';
import type { ModelOption, ModelRef } from '../types';

export const selectedModelError = (selectedModelId: string | undefined, model: ModelRef | undefined): string | null =>
  selectedModelId && selectedModelId !== DEFAULT_MODEL && (!model || modelRefKey(model) !== selectedModelId)
    ? `Selected model ${selectedModelId} is unavailable. Refresh models or choose another model; Ember will not substitute one.`
    : null;

/**
 * Hearth's "no reasoning" level. It never appears in a model's `thinkingLevelMap` because that map
 * only lists the levels which set a provider parameter — "off" sets none — yet conversations carry
 * it (`thinkingLevel: 'off'`, which is how workers are usually started). So it is an *implicit*
 * level, exactly like the model default: valid on any model, and forwarded as-is so a session that
 * is already off stays off.
 */
export const REASONING_OFF = 'off';

const normalizeVariant = (variant: string | null | undefined): string => {
  const normalized = (variant ?? '').trim().toLowerCase();
  return normalized === 'default' ? '' : normalized;
};

const isReasoningOff = (variant: string | null | undefined): boolean =>
  normalizeVariant(variant) === REASONING_OFF;

/** Case-insensitive equality where empty, unset and 'default' all mean "model default". */
export const sameVariant = (a?: string | null, b?: string | null): boolean => normalizeVariant(a) === normalizeVariant(b);

/**
 * Reasoning-effort spellings differ across sources ('High' saved by a scheduled task vs 'high'
 * advertised by the catalogue). Match ignoring case and return the canonical spelling. OpenCode 2
 * never advertises a 'default' level, so 'default'/'Default' resolves to '' (send no variant);
 * `undefined` means the level is genuinely unavailable.
 */
export const canonicalVariant = (variants: string[] | undefined, variant: string): string | undefined => {
  const advertised = variants?.find((entry) => sameVariant(entry, variant));
  if (advertised !== undefined) return advertised;
  // "no reasoning" needs no catalogue entry (see REASONING_OFF).
  if (isReasoningOff(variant)) return REASONING_OFF;
  return normalizeVariant(variant) ? undefined : '';
};

export const resolveComposerModel = (selectedModelId: string, variant: string, models: ModelOption[], defaultModelId: string | null) => {
  // With no loaded catalogue yet, do not claim the chosen model or variant is unavailable.
  if (models.length === 0) {
    return { model: undefined, error: null };
  }
  const target = models.find((model) => modelRefKey(model) === (selectedModelId === DEFAULT_MODEL ? defaultModelId : selectedModelId));
  const model = selectedModelId === DEFAULT_MODEL ? undefined : target;
  const error = selectedModelError(selectedModelId, model) ?? (
    canonicalVariant(target?.details.variants, variant) === undefined
      ? `Selected reasoning level ${variant} is unavailable for ${selectedModelId}. Choose a supported level; Ember will not change it automatically.`
      : null
  );
  return { model, error };
};
