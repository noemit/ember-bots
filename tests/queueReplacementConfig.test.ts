import { expect, test } from 'bun:test';
import { queueReplacementConfig } from '../src/lib/queueMerge';
import type { ModelOption } from '../src/types';

const model = (modelID: string, variants: string[]): ModelOption => ({
  providerID: 'host', modelID, label: modelID,
  details: { name: modelID, providerName: 'Host', reasoning: true, toolcall: true, attachment: true, inputs: ['text', 'image'], variants },
});
const models = [model('original', ['high', 'max']), model('other', ['low', 'high'])];
const original = { providerID: 'host', modelID: 'original', variant: 'High', agent: 'build' };

test('an unchanged edit retains the exact original model, effort spelling and agent', () => {
  const result = queueReplacementConfig(original, undefined, models);
  expect(result.error).toBeNull();
  expect(result.config).toBe(original);
});

test('explicit model and effort changes retain agent and clear old effort when default is chosen', () => {
  expect(queueReplacementConfig(original, { modelId: 'host/other', variant: 'low' }, models)).toEqual({
    config: { ...original, modelID: 'other', variant: 'low' }, error: null,
  });
  expect(queueReplacementConfig(original, { modelId: 'host/other', variant: '' }, models).config.variant).toBe('');
  expect(queueReplacementConfig(original, { modelId: 'host/other', variant: 'off' }, models).config.variant).toBe('off');
});

test('missing models and incompatible reasoning refuse substitution and offer recovery', () => {
  for (const [selection, catalogue] of [
    [{ modelId: 'host/missing', variant: 'high' }, models],
    [{ modelId: 'host/other', variant: 'max' }, models],
    [undefined, []],
  ] as const) {
    const result = queueReplacementConfig(original, selection, catalogue);
    expect(result.config).toBe(original);
    expect(result.error).toMatch(/Selected (model|reasoning level)/);
    expect(result.error).toMatch(/Refresh|Choose/);
    expect(result.error).toMatch(/will not/);
  }
});
