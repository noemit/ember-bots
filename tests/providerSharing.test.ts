import { expect, test } from 'bun:test';
import { parseSharingProviders, selectedTargets, selectionKey, sharingBlock, sharingHostMessage, sameConfig, sameDefinition, type SharingHost, type SharingProvider } from '../src/lib/providerSharing';

const provider = (providerId = 'any-new-provider', overrides: Partial<SharingProvider> = {}): SharingProvider => ({ providerId, type: 'api_key', source: 'stored', hasCredential: true, shareable: true, ...overrides });
const host = (id: string, providers: SharingProvider[] = [], overrides: Partial<SharingHost> = {}): SharingHost => ({ endpoint: { id, label: id, url: `https://${id}.example.com`, token: 'synthetic-connection-token' }, state: 'ready', providers, ...overrides });
const binding = { id: 'custom-example', name: 'Private models', baseUrl: 'https://models.example/v1', modelIds: ['small', 'large'] };

test('metadata parser requires reviewed metadata and environment discriminator, drops arbitrary payload fields', () => {
  expect(parseSharingProviders({ apiKeys: ['openai'] })).toBeNull();
  expect(parseSharingProviders({ providers: [{ providerId: 'openai', type: 'api_key', shareable: true }] })).toBeNull();
  const metadata = provider();
  expect(parseSharingProviders({ providers: [{ ...metadata, key: 'never-retain', token: 'never-retain', reason: 'unsafe host diagnostic' }] })).toEqual([metadata]);
  expect(JSON.stringify(parseSharingProviders({ providers: [{ ...metadata, credential: { key: 'never-retain' } }] }))).not.toContain('never-retain');
});

test('generic keys require exact source/destination selections and do not select defaults or other hosts', () => {
  const rows = [host('source', [provider(), provider('other-provider')]), host('destination'), host('unselected')];
  expect(selectedTargets(rows, 'source', new Set(), false)).toEqual([]);
  const targets = selectedTargets(rows, 'source', new Set([selectionKey('destination', 'any-new-provider')]), false);
  expect(targets).toEqual([{ ...rows[1].endpoint, providers: [{ providerId: 'any-new-provider', type: 'api_key' }] }]);
  expect(JSON.stringify(targets)).not.toMatch(/modelDefault|defaultModel|experimental/);
});

test('existing credentials, environment keys, unsupported and unavailable destinations cannot be selected', () => {
  const p = provider();
  const destinations = [host('existing', [p]), host('environment', [provider(p.providerId, { source: 'environment', shareable: false })]), host('old', [], { state: 'unsupported' }), host('down', [], { state: 'unavailable' })];
  const rows = [host('source', [p]), ...destinations];
  const selected = new Set(destinations.map(row => selectionKey(row.endpoint.id, p.providerId)));
  expect(selectedTargets(rows, 'source', selected, false)).toEqual([]);
  expect(sharingBlock(p, destinations[0], false)).toContain('Already available');
  expect(sharingBlock(p, destinations[1], false)).toContain('kept');
  expect(sharingBlock(provider('env-source', { source: 'environment', shareable: false }), host('empty'), false)).toContain('cannot be exported');
});

test('only Codex and Antigravity sign-ins can be opted in, each exact selection carries consent', () => {
  const oauth = ['openai-codex', 'antigravity', 'other-oauth'].map(id => provider(id, { type: 'oauth', experimental: true }));
  const rows = [host('source', oauth), host('destination')];
  const selected = new Set(oauth.map(p => selectionKey('destination', p.providerId)));
  expect(selectedTargets(rows, 'source', selected, false)).toEqual([]);
  expect(selectedTargets(rows, 'source', selected, true)[0].providers).toEqual(oauth.slice(0, 2).map(p => ({ providerId: p.providerId, type: 'oauth', experimental: true })));
});

test('custom sharing requires exactly matching binding on both hosts and forwards the reviewed binding', () => {
  const p = provider('custom-example', { configIdentity: binding });
  expect(sharingBlock(p, host('empty'), false)).toContain('configuration');
  for (const mismatch of [{ ...binding, name: 'Other name' }, { ...binding, baseUrl: 'https://other.example/v1' }, { ...binding, modelIds: ['small'] }, { ...binding, modelIds: [...binding.modelIds].reverse() }]) {
    expect(sharingBlock(p, host('dest', [provider(p.providerId, { source: 'missing', hasCredential: false, configIdentity: mismatch })]), false)).toContain('configuration');
  }
  const dest = host('destination', [provider(p.providerId, { source: 'missing', hasCredential: false, configIdentity: binding })]);
  expect(selectedTargets([host('source', [p]), dest], 'source', new Set([selectionKey('destination', p.providerId)]), false)[0].providers[0].configIdentity).toEqual(binding);
  expect(sameConfig(binding, { ...binding, modelIds: [...binding.modelIds].reverse() })).toBe(false);
  expect(sameDefinition(binding, { ...binding, modelIds: [...binding.modelIds].reverse() })).toBe(false);
});

test('custom providers map random per-host IDs only through one exact reviewed definition', () => {
  const p = provider('custom-example', { configIdentity: binding });
  const localBinding = { ...binding, id: 'custom-destination-random-id' };
  const local = provider(localBinding.id, { source: 'missing', hasCredential: false, configIdentity: localBinding });
  const rows = [host('source', [p]), host('destination', [local])];
  const selected = new Set([selectionKey('destination', p.providerId)]);
  expect(selectedTargets(rows, 'source', selected, false)[0].providers).toEqual([{ providerId: p.providerId, type: 'api_key', configIdentity: binding, destinationConfigIdentity: localBinding }]);
  expect(sameConfig(binding, localBinding)).toBe(false);
  expect(sameDefinition(binding, localBinding)).toBe(true);
  expect(sharingBlock(p, host('existing', [{ ...local, source: 'stored', hasCredential: true }]), false)).toContain('Already available');
  expect(sharingBlock(p, host('ambiguous', [local, { ...local, providerId: 'custom-duplicate', configIdentity: { ...localBinding, id: 'custom-duplicate' } }]), false)).toContain('multiple matching');
  expect(sharingBlock({ ...p, shareable: false }, rows[1], false)).toContain('cannot be exported');
});

test('recovery copy names the host, explains state and offers comparison after recovery without jargon', () => {
  for (const state of ['unsupported', 'unavailable'] as const) {
    const copy = sharingHostMessage(host('Studio Kiln', [], { state }));
    expect(copy).toContain('Studio Kiln');
    expect(copy).toMatch(/Update|Check/);
    expect(copy).toContain('compare again');
    expect(copy).not.toMatch(/undefined|null|HTTP|\b404\b|Something went wrong|!/);
  }
});
