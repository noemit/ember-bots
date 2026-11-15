import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDelegatorModels, redactRemoteSettings, withoutDesktopOnlySettings } from '../electron/transport';
import { DEFAULT_SETTINGS } from '../src/hooks/useEmberSettings';
import type { EmberSettings } from '../src/types';

const model = { providerID: 'openai', modelID: 'gpt-5' };
const choices = {
  'pi:local': { harder: model },
  'pi:tower': { easier: { providerID: 'anthropic', modelID: 'claude-sonnet' } },
  'pi:both': { harder: model, easier: model },
} satisfies NonNullable<EmberSettings['delegatorModels']>;

test('optional roles and independent hosts survive a settings-file reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-delegator-settings-'));
  try {
    const file = join(directory, 'settings.json');
    const settings = { ...DEFAULT_SETTINGS, theme: 'clay', delegatorModels: parseDelegatorModels(choices) };
    await writeFile(file, JSON.stringify(settings));
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(parseDelegatorModels(stored.delegatorModels)).toEqual(choices);
    expect(stored.theme).toBe('clay');
    expect(stored.instanceDefaults).toEqual({});
    expect(DEFAULT_SETTINGS.delegatorModels).toEqual({});
    // Whole-map replacement can remove one role or host, and {} clears all preferences.
    expect(parseDelegatorModels({ 'pi:both': { easier: model } })).toEqual({ 'pi:both': { easier: model } });
    expect(parseDelegatorModels({})).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote settings preserve these non-secret choices in both directions', () => {
  expect(withoutDesktopOnlySettings({ delegatorModels: choices })).toEqual({ delegatorModels: choices });
  expect(redactRemoteSettings({ piEndpoints: [], delegatorModels: choices }).delegatorModels).toEqual(choices);
});

test('malformed containers and models are dropped without losing the valid sibling role', () => {
  for (const value of [undefined, null, false, 42, '', [], [choices]]) expect(parseDelegatorModels(value)).toEqual({});
  const invalid = [undefined, null, false, [], 'default', {}, { providerID: 'openai' },
    { ...model, providerID: '' }, { ...model, modelID: ' ' }, { ...model, providerID: 'default' },
    { ...model, modelID: 'default' }, { ...model, modelID: 12 }, { ...model, providerID: ' openai' },
    { ...model, modelID: 'gpt\n5' }, { ...model, providerID: 'x'.repeat(201) }, { ...model, modelID: 'x'.repeat(301) }];
  for (const harder of invalid) {
    expect(parseDelegatorModels({ local: { harder, easier: model } })).toEqual({ local: { easier: model } });
    expect(parseDelegatorModels({ local: { harder } })).toEqual({});
  }
  expect(parseDelegatorModels({ local: { harder: { ...model, variant: 'high', secret: 'ignored' }, unknown: model } }))
    .toEqual({ local: { harder: model } });
});

test('record keys, inherited identities and collection sizes are bounded safely', () => {
  const dangerous = JSON.parse('{"__proto__":{"harder":{"providerID":"p","modelID":"m"}},"constructor":{},"prototype":{}}');
  expect(parseDelegatorModels(dangerous)).toEqual({});
  expect(Object.getPrototypeOf(parseDelegatorModels(dangerous))).toBe(Object.prototype);
  expect(parseDelegatorModels({ '': { harder: model }, ' ': { harder: model }, ['x'.repeat(501)]: { harder: model } })).toEqual({});
  expect(parseDelegatorModels({ local: Object.create({ harder: model }) })).toEqual({});
  expect(parseDelegatorModels({ local: { harder: Object.create(model) } })).toEqual({});
  const atLimit = { providerID: 'x'.repeat(200), modelID: 'm'.repeat(300) };
  expect(parseDelegatorModels({ ['i'.repeat(500)]: { harder: atLimit } })).toEqual({ ['i'.repeat(500)]: { harder: atLimit } });
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`host-${i}`, { harder: model }]));
  expect(Object.keys(parseDelegatorModels(many))).toHaveLength(2000);
});

test('main uses the same validation for disk reads and settings patches', async () => {
  const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  expect(main).toContain('delegatorModels: parseDelegatorModels(root.delegatorModels)');
  expect(main).toContain('if (value.delegatorModels !== undefined) settings.delegatorModels = parseDelegatorModels(value.delegatorModels)');
});
