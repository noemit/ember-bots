import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CompactionSettings, effectiveCompaction, PI_COMPACTION_DEFAULTS, validateCompactionPreference } from '../src/compaction-settings';
import { hearthConfig } from '../src/config';
import { startHearthServer } from '../src/server';

const preference = { compactAtTokens: 70000, keepRecentTokens: 5000 };
test('compiled policy defaults and absolute model mappings preserve output reserve', async () => {
  const source = readFileSync(join(import.meta.dir, '../node_modules/@earendil-works/pi-durable/dist/harness/agent.js'), 'utf8');
  for (const [key, value] of Object.entries(PI_COMPACTION_DEFAULTS)) expect(source).toContain(`${key}: ${value}`);
  expect(effectiveCompaction(preference, 200000)).toEqual({ compactAtTokens: 70000, keepRecentTokens: 5000, blockingAtTokens: 183616, reserveTokens: 16384, backgroundTokens: 113616 });
  expect(effectiveCompaction(preference, 20000)).toMatchObject({ compactAtTokens: 3616, keepRecentTokens: 1808, backgroundTokens: 0 });
  expect(effectiveCompaction(preference, 8192)).toBeUndefined();
  expect(effectiveCompaction(preference, NaN)).toBeUndefined();
  expect(validateCompactionPreference(null)).toBeUndefined();
  for (const value of [undefined, {}, { ...preference, enabled: false }, { compactAtTokens: 5000, keepRecentTokens: 5000 }, { compactAtTokens: 70000.5, keepRecentTokens: 5 }, { compactAtTokens: 70000, keepRecentTokens: 0 }]) expect(() => validateCompactionPreference(value)).toThrow();
});

test('authenticated host settings persist, affect real automatic generation and retain the recent tail', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-compaction-settings-'));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: 'large', contextWindow: 200000 }, { id: 'small', contextWindow: 20000 }] });
  models.setProvider(faux.provider);
  const settings = new CompactionSettings(home, models);
  expect(settings.settings()).toEqual({}); // Native enabled/defaults untouched before human edits.
  const storage = await openNodeSqliteStorage(join(home, 'test.sqlite'));
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: () => settings.settings() }, context);
  const server = startHearthServer({ config: hearthConfig({ home, port: 0, workspace: home }), token: 'test-token', storage, harness, models, compactionSettings: settings, defaultAgent: { model: { provider: 'faux', modelId: 'large' } } });
  const request = (path: string, method = 'GET', body?: unknown, auth = true) => fetch(server.url + path, { method, headers: { ...(auth ? { authorization: 'Bearer test-token' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path: string, method = 'GET', body?: unknown): Promise<any> => { const response = await request(path, method, body); expect(response.ok).toBe(true); return response.json(); };
  try {
    expect((await request('/settings/compaction', 'GET', undefined, false)).status).toBe(401);
    expect((await request('/settings/compaction', 'PUT', { preference }, false)).status).toBe(401);
    expect((await request('/settings/compaction', 'PUT', { preference: { ...preference, keepRecentTokens: 70000 } })).status).toBe(400);
    expect((await json('/settings/compaction')).preference).toBeNull();
    await json('/settings/compaction', 'PUT', { preference });
    expect(new CompactionSettings(home, models).state().preference).toEqual(preference);
    expect(statSync(join(home, 'compaction.json')).mode & 0o777).toBe(0o600);
    expect(settings.settings().compaction?.modelOverrides?.['faux/large']).toMatchObject({ backgroundTokens: 113616, keepRecentTokens: 5000 });
    expect(settings.settings().compaction?.modelOverrides?.['faux/small']).toMatchObject({ backgroundTokens: 0, keepRecentTokens: 1808 });
    // An existing conversation reads the newly saved host policy at its next request.
    const { id } = await json('/conversations', 'POST', { model: { provider: 'faux', modelId: 'large' } });
    await json('/settings/compaction', 'PUT', { preference: { compactAtTokens: 1024, keepRecentTokens: 30 } });
    for (let i = 0; i < 5; i++) await json(`/conversations/${id}/submit`, 'POST', { type: 'write', entry: { kind: 'test.history', model: [{ role: 'user', content: `old-${i} ${'history '.repeat(300)}`, timestamp: Date.now() }] } });
    const conversation = await harness.conversation(id, context);
    const before = await conversation!.context(context);
    const recentId = before.entries.at(-1)!.id;
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('Preserved decisions.')));
    await json(`/conversations/${id}/submit`, 'POST', { type: 'input', content: [{ type: 'text', text: 'Continue' }] });
    let compacted = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const view = await conversation!.context(context);
      if (view.head?.kind === 'pi.compaction') {
        expect(view.head.data).toMatchObject({ reason: 'threshold' });
        expect(view.entries.some(entry => entry.id === recentId)).toBe(true);
        expect(view.messages.some(message => JSON.stringify(message).includes('old-0'))).toBe(false);
        compacted = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(compacted).toBe(true);
    let summary: any;
    for (let tries = 0; tries < 100; tries++) {
      summary = (await json('/conversations')).conversations.find((item: any) => item.id === id);
      if (summary.contextCompaction) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(summary.contextCompaction.reason).toBe('threshold');
    expect(summary.currentContextTokens).toBeLessThan(3440);
    // A switch uses the same host preference, mapped safely to the newly selected model.
    await json(`/conversations/${id}/configure`, 'POST', { model: { provider: 'faux', modelId: 'small' } });
    expect(settings.settings().compaction?.modelOverrides?.['faux/small']).toMatchObject({ keepRecentTokens: 30 });
    const history = await conversation!.entries({}, 100, undefined, context);
    expect(history.items.some(entry => JSON.stringify(entry).includes('old-0'))).toBe(true);
    await json('/settings/compaction', 'PUT', { preference: null });
    expect(new CompactionSettings(home, models).settings()).toEqual({});
  } finally { await server.close(); await harness.close(context); await rm(home, { recursive: true, force: true }); }
}, 15000);

test('malformed compaction.json is quarantined aside and falls back to Pi defaults instead of crashing Kiln on boot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-compaction-corrupt-'));
  const models = createModels();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const file = join(home, 'compaction.json');
    const corruptBytes = '{"compactAtTokens": 70000, broken-json';
    writeFileSync(file, corruptBytes, { mode: 0o600 });

    const settings = new CompactionSettings(home, models);
    expect(settings.state().preference).toBeNull();
    expect(settings.settings()).toEqual({});
    expect(existsSync(file)).toBe(false);

    const quarantined = readdirSync(home).filter(name => name.startsWith('compaction.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(home, quarantined[0]), 'utf8')).toBe(corruptBytes);
    expect(warnings.some(line => line.includes('Kiln') && line.includes('compaction.json'))).toBe(true);

    // Subsequent saves still succeed cleanly.
    settings.save(preference);
    expect(new CompactionSettings(home, models).state().preference).toEqual(preference);
  } finally {
    console.warn = originalWarn;
    await rm(home, { recursive: true, force: true });
  }
});
