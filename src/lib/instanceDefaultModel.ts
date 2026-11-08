import { modelRefKey } from '../types';
import type { InstanceDefaults, ModelRef } from '../types';

/** Ember's new-agent override wins; the host supplies the fallback. */
export const effectiveInstanceDefaultModel = (defaults: InstanceDefaults | undefined, serverDefault: string | null | undefined): string | null =>
  defaults?.model ? modelRefKey(defaults.model) : serverDefault ?? null;

/** A model-only action must not carry effort from a different model. */
export const withInstanceDefaultModel = (defaults: InstanceDefaults | undefined, model: ModelRef): InstanceDefaults => ({
  ...defaults,
  model: { providerID: model.providerID, modelID: model.modelID },
  variant: undefined,
});
