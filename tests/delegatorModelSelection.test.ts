import { expect, test } from 'bun:test';
import { DEFAULT_MODEL, type ModelOption } from '../src/types';
import { seedDelegatorChoices, delegatorModelsError } from '../src/lib/delegatorModels';
const a = { providerID: 'provider-a', modelID: 'a' };
const b = { providerID: 'provider-b', modelID: 'b' };
const models = [a, b].map(model => ({ ...model, details: { name: model.modelID } })) as ModelOption[];

test('both roles seed from the actual composer model, resolving server default', () => {
  expect(seedDelegatorChoices(undefined, 'provider-a/a', null, models)).toEqual({ harder: a, easier: a });
  expect(seedDelegatorChoices(undefined, DEFAULT_MODEL, 'provider-b/b', models)).toEqual({ harder: b, easier: b });
  expect(seedDelegatorChoices(undefined, DEFAULT_MODEL, null, models)).toEqual({ harder: undefined, easier: undefined });
});
test('each saved role wins independently, never silently falling back when unavailable', () => {
  expect(seedDelegatorChoices({ harder: b }, 'provider-a/a', null, models)).toEqual({ harder: b, easier: a });
  const removed = { providerID: 'old', modelID: 'gone' };
  const choices = seedDelegatorChoices({ harder: removed, easier: b }, 'provider-a/a', null, models);
  expect(choices).toEqual({ harder: removed, easier: b });
  expect(delegatorModelsError(choices, models)).toMatch(/unavailable.*Refresh models or choose another.*will not substitute/);
});
test('no loaded or suitable model blocks routing with a recovery, not a guess', () => {
  expect(delegatorModelsError({}, [])).toMatch(/Ember.*Choose.*refresh/);
  expect(delegatorModelsError({ harder: a, easier: a }, [])).toMatch(/unavailable/);
  expect(delegatorModelsError({ harder: a, easier: b }, models)).toBeNull();
  expect(delegatorModelsError({ harder: a, easier: a }, models)).toBeNull();
});
