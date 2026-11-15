import { DEFAULT_MODEL, modelRefKey, type ModelOption, type DelegatorModels } from '../types';
import { resolveComposerModel } from './modelSelection';

export type DelegatorChoices = DelegatorModels;

/** Missing preferences seed from the actual composer choice, never from a guessed model. */
export function seedDelegatorChoices(saved: DelegatorChoices | undefined, composer: string, defaultModel: string | null, models: ModelOption[]): DelegatorChoices {
  const key = composer === DEFAULT_MODEL ? defaultModel : composer;
  const selected = models.find(model => modelRefKey(model) === key);
  const seed = selected ? { providerID: selected.providerID, modelID: selected.modelID } : undefined;
  return { harder: saved?.harder ?? seed, easier: saved?.easier ?? seed };
}

export function delegatorModelsError(choices: DelegatorChoices, models: ModelOption[]): string | null {
  for (const role of ['harder', 'easier'] as const) {
    const model = choices[role];
    const label = role === 'harder' ? 'Harder tasks' : 'Easier tasks';
    if (!model) return `Ember needs a model for ${label}. Choose one below, or refresh models in the picker.`;
    const resolved = resolveComposerModel(modelRefKey(model), '', models, null);
    if (!resolved.model || resolved.error) return `${label}: ${resolved.error ?? `Selected model ${modelRefKey(model)} is unavailable. Refresh models or choose another model; Ember will not substitute one.`}`;
  }
  return null;
}
