/** The rule that decides which model a new agent gets when no explicit default is set. */

/** How a preferred provider picks its model on a given instance. */
export type ProviderPreference =
  /** Follow the instance's own server default. */
  | 'instance'
  /** Prefer one provider, falling back to the instance default when it has no models here. */
  | { providerID: string };

export type ModelOption = {
  providerID: string;
  modelID: string;
  label?: string;
};

/**
 * Pick a model from `models` honouring a preferred provider.
 *
 * Why this exists: "default provider" cannot be a stored model id. An instance exposes a different
 * catalogue (and different tiers of the same provider) than its neighbours, so a literal
 * `provider/model` copied across instances is either absent or subtly wrong on most of them. Storing
 * the *provider* and resolving the model per instance keeps the intent ("use my subscription")
 * while staying valid everywhere.
 *
 * The chosen model is the provider's own default when it names one, else the first it lists — the
 * same rule the disallowed-model path uses so behaviour is consistent.
 */
export const resolvePreferredProvider = (
  models: readonly ModelOption[],
  preference: ProviderPreference | undefined,
  defaultModelId?: string | null
): ModelOption | undefined => {
  if (!preference || preference === 'instance') {
    if (defaultModelId) return models.find((model) => model.modelID === defaultModelId);
    return undefined;
  }
  const offered = models.filter((model) => model.providerID === preference.providerID);
  if (offered.length === 0) return undefined;
  // A provider that also declares the instance default wins when it lists that model.
  if (defaultModelId) {
    const preferred = offered.find((model) => model.modelID === defaultModelId);
    if (preferred) return preferred;
  }
  return offered[0];
};

/**
 * The providers an instance actually offers, for the picker. Sorted so the list is stable; a
 * provider with a stored credential already sorts first because the instance put it there.
 */
export const providersForPicker = (models: readonly ModelOption[]): Array<{ providerID: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.providerID, (counts.get(model.providerID) ?? 0) + 1);
  return [...counts.entries()]
    .map(([providerID, count]) => ({ providerID, count }))
    .sort((a, b) => a.providerID.localeCompare(b.providerID));
};
