import { describe, expect, test } from 'bun:test';
import { providersForPicker, resolvePreferredProvider } from '../src/lib/providerPreference';

/**
 * A preferred provider is stored as a provider *id*, not a model id, because an instance's
 * catalogue differs from its neighbour's — a literal `provider/model` copied across devices is
 * absent or wrong on most of them. These pin the resolution rules.
 */

const models = [
  { providerID: 'opencode-go', modelID: 'glm-5.3-flash' },
  { providerID: 'opencode-go', modelID: 'qwen3.8-max' },
  { providerID: 'xai', modelID: 'grok-4.6' },
  { providerID: 'deepseek', modelID: 'deepseek-flash' },
];

describe('preferred provider', () => {
  test('no preference follows the instance default', () => {
    expect(resolvePreferredProvider(models, undefined, 'deepseek-flash')).toMatchObject({
      providerID: 'deepseek',
    });
    expect(resolvePreferredProvider(models, 'instance', 'deepseek-flash')).toMatchObject({
      providerID: 'deepseek',
    });
  });

  test('a preference picks that provider, regardless of the instance default', () => {
    expect(resolvePreferredProvider(models, { providerID: 'xai' }, 'deepseek-flash')).toMatchObject({
      providerID: 'xai',
      modelID: 'grok-4.6',
    });
  });

  test('a preference the instance does not offer falls through to the instance default', () => {
    // The whole point of storing the provider rather than the model: this must not break.
    const result = resolvePreferredProvider(models, { providerID: 'anthropic' }, 'deepseek-flash');
    expect(result).toBeUndefined();
  });

  test('with no default and no matching provider there is nothing to return', () => {
    expect(resolvePreferredProvider(models, { providerID: 'anthropic' }, null)).toBeUndefined();
    expect(resolvePreferredProvider([], undefined, 'deepseek-flash')).toBeUndefined();
  });

  test('an instance default that belongs to the preferred provider wins over the first listed', () => {
    // opencode-go lists glm first, but the instance names qwen; honour the instance.
    const result = resolvePreferredProvider(models, { providerID: 'opencode-go' }, 'qwen3.8-max');
    expect(result).toMatchObject({ providerID: 'opencode-go', modelID: 'qwen3.8-max' });
  });

  test('the picker lists each offered provider once with its model count, sorted', () => {
    expect(providersForPicker(models)).toEqual([
      { providerID: 'deepseek', count: 1 },
      { providerID: 'opencode-go', count: 2 },
      { providerID: 'xai', count: 1 },
    ]);
  });
});
