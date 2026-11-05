import type { ModelRef } from '../types';

/**
 * How a model and the reasoning level it ran at are spelled wherever both are shown: the transcript
 * footer, the queued-message row, the edit dialog's "keeps …" line. One helper, so the vocabulary
 * cannot drift — a footer that said `high` while the queue row said `High` (or a header that spelled
 * the level `default`) would be three answers to one question.
 *
 * The level comes from `ModelRef.variant`, which `piMapping` fills from a finished turn's own
 * `thinkingLevel` (falling back to `providerThinkingLevel`), so it names the level that turn actually
 * used rather than the composer's current selection.
 *
 * `undefined`/blank means the level is *unknown* — a turn written before the host recorded one, or a
 * model without reasoning — and then the level is left out entirely. It is never synthesized:
 * "default" would be a claim about the turn that the data does not support. A literal `"default"` is
 * treated the same way, because it means "the model's own default", which is not a level either.
 */
export const modelLabel = (ref: ModelRef | undefined, fallback = 'Model unavailable'): string => {
  if (!ref) return fallback;
  const base = `${ref.providerID} / ${ref.modelID}`;
  const level = (ref.variant ?? '').trim();
  if (!level || level.toLowerCase() === 'default') return base;
  return `${base} · ${level}`;
};
