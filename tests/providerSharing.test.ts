import { expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProviderSharing, { type ProviderSharingProps } from '../src/components/ProviderSharing';
import {
  SINGLE_KILN_SHARING_GUIDANCE,
  parseSharingProviders,
  refreshOptionsForSharedTarget,
  runProviderShare,
  selectedTargets,
  selectionKey,
  sharingBlock,
  sharingCandidates,
  sharingHostMessage,
  sharingSetupGuidance,
  sameConfig,
  sameDefinition,
  type ShareWizardState,
  type SharingHost,
  type SharingProvider,
} from '../src/lib/providerSharing';
import type { Instance, PiEndpoint } from '../src/types';

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

test('post-share model refresh scopes upstream catalog discovery to newly added built-in API keys', () => {
  const customSelection = {
    providerId: binding.id,
    type: 'api_key' as const,
    configIdentity: binding,
    destinationConfigIdentity: { ...binding, id: 'custom-dest-id' },
  };
  const oauthSelection = { providerId: 'openai-codex', type: 'oauth' as const, experimental: true as const };

  expect(
    refreshOptionsForSharedTarget(
      {
        providers: [
          { providerId: 'deepinfra', type: 'api_key' },
          { providerId: 'fireworks-ai', type: 'api_key' },
          customSelection,
          oauthSelection,
        ],
      },
      4
    )
  ).toEqual({
    upstream: true,
    providers: ['deepinfra', 'fireworks'],
  });

  // OAuth-only or custom-only shares re-read GET /models without outbound provider/OAuth refresh.
  expect(refreshOptionsForSharedTarget({ providers: [oauthSelection, customSelection] }, 2)).toEqual({
    upstream: false,
  });

  // Fill-only no-ops (0 added) avoid upstream network calls.
  expect(
    refreshOptionsForSharedTarget({ providers: [{ providerId: 'openai', type: 'api_key' }] }, 0)
  ).toEqual({
    upstream: false,
  });
});

const withMockBridge = <T>(run: () => T): T => {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = {
    ember: {
      piRequest: async () => ({ ok: true, status: 200, data: { providers: [] } }),
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
};

const renderSharing = (props: Partial<ProviderSharingProps> & Pick<ProviderSharingProps, 'endpoints' | 'instances'>) =>
  withMockBridge(() => renderToStaticMarkup(React.createElement(ProviderSharing, { defaultOpen: true, ...props })));

test('fewer than two Kilns disables Compare providers and guides user to add another Kiln instead of dead-ending at Step 2', () => {
  const localEndpoint: PiEndpoint = { id: 'pi:local', label: 'This computer', url: 'http://127.0.0.1:3002', token: 'local-token' };
  const remoteEndpoint: PiEndpoint = { id: 'pi:tower', label: 'Tower', url: 'http://100.64.0.20:3002', token: 'tower-token' };
  const localPiInstance: Instance = { id: 'pi:local', label: 'This computer', url: 'http://127.0.0.1:3002', kind: 'pi', status: 'ready' };
  const openchamberInstance: Instance = { id: 'oc:1', label: 'OpenChamber', url: 'http://127.0.0.1:3000', kind: 'openchamber', status: 'ready' };

  expect(sharingCandidates([], [])).toHaveLength(0);
  expect(sharingCandidates([localEndpoint], [localPiInstance, openchamberInstance])).toHaveLength(1);
  expect(sharingSetupGuidance([])).toBe(SINGLE_KILN_SHARING_GUIDANCE);
  expect(sharingSetupGuidance([localEndpoint])).toBe(SINGLE_KILN_SHARING_GUIDANCE);
  expect(sharingSetupGuidance([localEndpoint, remoteEndpoint])).toBeNull();
  expect(SINGLE_KILN_SHARING_GUIDANCE).toContain('Settings → Computers and Containers');
  expect(SINGLE_KILN_SHARING_GUIDANCE).not.toMatch(/undefined|null|HTTP|Something went wrong|!/);

  for (const [endpoints, instances] of [
    [[], []],
    [[localEndpoint], []],
    [[localEndpoint], [localPiInstance, openchamberInstance]],
  ] as Array<[PiEndpoint[], Instance[]]>) {
    const html = renderSharing({ endpoints, instances });
    expect(html).toContain(SINGLE_KILN_SHARING_GUIDANCE);
    const compareBtn = html.match(/<button\b[^>]*>Compare providers<\/button>/)?.[0] ?? '';
    expect(compareBtn).toContain('disabled=""');
    expect(html).not.toContain('Choose the source Kiln');
  }

  const multiHtml = renderSharing({ endpoints: [localEndpoint, remoteEndpoint], instances: [localPiInstance] });
  expect(multiHtml).not.toContain(SINGLE_KILN_SHARING_GUIDANCE);
  const multiCompareBtn = multiHtml.match(/<button\b[^>]*>Compare providers<\/button>/)?.[0] ?? '';
  expect(multiCompareBtn).toBeTruthy();
  expect(multiCompareBtn).not.toContain('disabled=""');
});

test('share preserves reviewed wizard state on transient or partial errors and resets only when all targets succeed', async () => {
  const sourceHost = host('pi:source', [provider('openai'), provider('openai-codex', { type: 'oauth', experimental: true })], {
    endpoint: { id: 'pi:source', label: 'Laptop Kiln', url: 'https://100.64.0.10:3002', token: 'src-token' },
  });
  const destinationA = host('pi:dest-a', [], {
    endpoint: { id: 'pi:dest-a', label: 'Tower Kiln', url: 'https://100.64.0.11:3002', token: 'dest-a-token' },
  });
  const destinationB = host('pi:dest-b', [], {
    endpoint: { id: 'pi:dest-b', label: 'Studio Kiln', url: 'https://100.64.0.12:3002', token: 'dest-b-token' },
  });
  const hosts = [sourceHost, destinationA, destinationB];
  const selected = new Set([
    selectionKey('pi:dest-a', 'openai'),
    selectionKey('pi:dest-a', 'openai-codex'),
    selectionKey('pi:dest-b', 'openai'),
  ]);
  const wizardState: ShareWizardState = {
    hosts,
    step: 3,
    source: 'pi:source',
    destination: 'pi:dest-a',
    selected,
    experimental: true,
    notice: '',
  };
  const singleTarget = selectedTargets(hosts, 'pi:source', selected, true).filter(target => target.id === 'pi:dest-a');
  const multiTargets = selectedTargets(hosts, 'pi:source', selected, true);
  const endpoints = hosts.map(row => row.endpoint);

  const changed: string[] = [];

  // 1. HTTP failure keeps wizard open on review step with selections preserved
  const httpFail = await runProviderShare({
    state: wizardState,
    targets: singleTarget,
    send: async () => ({ ok: false, status: 503 }),
    onProviderChange: id => changed.push(id),
  });
  expect(httpFail.succeeded).toBe(false);
  expect(httpFail.state.hosts).toBe(hosts);
  expect(httpFail.state.step).toBe(3);
  expect(httpFail.state.selected).toBe(selected);
  expect(httpFail.state.experimental).toBe(true);
  expect(httpFail.state.notice).toContain('Laptop Kiln');
  expect(httpFail.state.notice).toMatch(/try again/i);
  expect(httpFail.state.notice).not.toMatch(/undefined|null|HTTP|\b503\b|!/);
  expect(changed).toEqual([]);

  const errorReviewHtml = renderSharing({ endpoints, instances: [], initialWizard: httpFail.state });
  expect(errorReviewHtml).toContain('Review before sharing');
  expect(errorReviewHtml).toContain('Share 2 reviewed selections');
  expect(errorReviewHtml).toContain(httpFail.state.notice);

  // 2. Thrown network error keeps wizard open on review step with selections preserved
  const networkFail = await runProviderShare({
    state: wizardState,
    targets: singleTarget,
    send: async () => { throw new Error('socket hang up'); },
    onProviderChange: id => changed.push(id),
  });
  expect(networkFail.succeeded).toBe(false);
  expect(networkFail.state.hosts).toBe(hosts);
  expect(networkFail.state.step).toBe(3);
  expect(networkFail.state.selected).toBe(selected);
  expect(networkFail.state.notice).toContain('Laptop Kiln did not answer');
  expect(changed).toEqual([]);

  // 3. Partial / target failure preserves wizard state and notifies only succeeded targets
  const partialFail = await runProviderShare({
    state: wizardState,
    targets: multiTargets,
    send: async () => ({
      ok: true,
      status: 200,
      data: { results: [{ id: 'pi:dest-a', ok: true, keys: 2 }, { id: 'pi:dest-b', ok: false }] },
    }),
    onProviderChange: id => changed.push(id),
  });
  expect(partialFail.succeeded).toBe(false);
  expect(partialFail.state.hosts).toBe(hosts);
  expect(partialFail.state.step).toBe(3);
  expect(partialFail.state.selected).toBe(selected);
  expect(partialFail.state.notice).toContain('Tower Kiln: 2 credentials added.');
  expect(partialFail.state.notice).toContain('Studio Kiln could not finish.');
  expect(changed).toEqual(['pi:dest-a']);

  // 4. Retry that succeeds for all selected targets resets wizard state cleanly
  changed.length = 0;
  const fullSuccess = await runProviderShare({
    state: httpFail.state,
    targets: singleTarget,
    send: async () => ({ ok: true, status: 200, data: { results: [{ id: 'pi:dest-a', ok: true, keys: 2 }] } }),
    onProviderChange: id => changed.push(id),
  });
  expect(fullSuccess.succeeded).toBe(true);
  expect(fullSuccess.state.hosts).toBeNull();
  expect(fullSuccess.state.step).toBe(0);
  expect(fullSuccess.state.selected.size).toBe(0);
  expect(fullSuccess.state.experimental).toBe(false);
  expect(fullSuccess.state.notice).toContain('Tower Kiln: 2 credentials added.');
  expect(changed).toEqual(['pi:dest-a']);

  const successHtml = renderSharing({ endpoints, instances: [], initialWizard: fullSuccess.state });
  expect(successHtml).not.toContain('Review before sharing');
  expect(successHtml).toContain('Tower Kiln: 2 credentials added.');
});

test('ProviderSharing native select and checkbox controls use Ember border, focus ring, and radius classes', () => {
  const sourceHost = host('pi:source', [provider('openai'), provider('openai-codex', { type: 'oauth', experimental: true })]);
  const destinationHost = host('pi:dest', []);
  const hosts = [sourceHost, destinationHost];
  const endpoints = hosts.map(row => row.endpoint);
  const expectedSelectClasses = [
    'border-input',
    'bg-background',
    'rounded-md',
    'px-2.5',
    'py-1.5',
    'text-xs',
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-ring',
  ];

  const step0Html = renderSharing({ endpoints, instances: [], initialWizard: { hosts, step: 0 } });
  for (const token of expectedSelectClasses) expect(step0Html).toContain(token);

  const step1Html = renderSharing({ endpoints, instances: [], initialWizard: { hosts, step: 1, source: 'pi:source' } });
  for (const token of expectedSelectClasses) expect(step1Html).toContain(token);

  const step2Html = renderSharing({
    endpoints,
    instances: [],
    initialWizard: { hosts, step: 2, source: 'pi:source', destination: 'pi:dest' },
  });
  expect(step2Html).toContain('type="checkbox"');
  for (const token of ['border-input', 'focus-visible:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring']) {
    expect(step2Html).toContain(token);
  }
});
