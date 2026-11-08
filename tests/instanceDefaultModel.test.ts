import { describe, expect, test } from 'bun:test';
import { effectiveInstanceDefaultModel, withInstanceDefaultModel } from '../src/lib/instanceDefaultModel';
import { newSessionModelPrefill } from '../src/lib/newSessionDefaults';

describe('instance default model', () => {
  test('uses the server fallback until Ember has an explicit override', () => {
    expect(effectiveInstanceDefaultModel(undefined, 'opencode/glm-5.3-flash')).toBe('opencode/glm-5.3-flash');
    expect(effectiveInstanceDefaultModel({}, null)).toBeNull();
    expect(effectiveInstanceDefaultModel({ model: { providerID: 'a', modelID: 'missing' } }, 'b/fallback')).toBe('a/missing');
  });
  test('preserves unrelated defaults, clears stale effort, and seeds new agents', () => {
    const original = { directory: '/work', bypass: true, markerColor: 2, preferredProvider: 'a', variant: 'high', model: { providerID: 'a', modelID: 'old', variant: 'high' } };
    const next = withInstanceDefaultModel(original, { providerID: 'b', modelID: 'new', variant: 'low' });
    expect(next).toEqual({ ...original, model: { providerID: 'b', modelID: 'new' }, variant: undefined });
    expect(newSessionModelPrefill(next)).toEqual({ key: 'b/new', variant: '' });
    expect(original.model.modelID).toBe('old');
    expect(original.variant).toBe('high');
  });
});
