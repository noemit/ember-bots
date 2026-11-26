import { expect, test } from 'bun:test';
import { version as kilnVersion } from '../packages/kiln/package.json';
import { BUNDLED_KILN_VERSION, kilnUpdateState } from '../src/lib/kilnUpdateNotice';
import { testPiEndpoint } from '../electron/piConnection';
import { reconcilePiInstanceSnapshot } from '../electron/settingsFile';
import type { Instance } from '../src/types';

const host = (version?: string, fields: Partial<Instance> = {}): Instance => ({
  id: 'pi:studio', kind: 'pi', label: 'Studio', url: 'http://studio.invalid',
  status: 'ready', attachable: true, version, ...fields,
});

test('compares stable releases from Kiln’s own manifest, numerically and without ranking build metadata', () => {
  expect(BUNDLED_KILN_VERSION).toBe(kilnVersion);
  expect(kilnUpdateState(host(kilnVersion))).toBe('equal');
  expect(kilnUpdateState(host(kilnVersion + '+build.12'))).toBe('equal');
  const [major, minor, patch] = kilnVersion.split('.').map(Number);
  expect(kilnUpdateState(host([major + 1, 0, 0].join('.')))).toBe('newer');
  expect(kilnUpdateState(host([major, minor, patch + 1].join('.')))).toBe('newer');
  // For 1.14.x, lexical sorting would put 1.9.99 *after* the bundled version.
  if (minor >= 10) expect(kilnUpdateState(host([major, 9, 99].join('.')))).toBe('older');
  if (major > 0) expect(kilnUpdateState(host([major - 1, 100, 0].join('.')))).toBe('older');
  if (minor > 0) expect(kilnUpdateState(host([major, minor - 1, 999].join('.')))).toBe('older');
});

test('only a ready, separately configured Kiln is eligible for a recommendation', () => {
  for (const version of [undefined, '', 'beeface', '1234567', '1.2', '1.02.0', '1.1.0-rc.1', '1.2.3+', '9007199254740992.0.0']) {
    expect(kilnUpdateState(host(version))).toBe('unknown');
  }
  for (const status of ['checking', 'unreachable', 'unsupported'] as const) {
    expect(kilnUpdateState(host('0.1.0', { status }))).toBe('unavailable');
  }
  expect(kilnUpdateState(host('0.1.0', { id: 'pi:local' }))).toBe('not-applicable');
  expect(kilnUpdateState(host('0.1.0', { id: 'pi:custom-local-name', bundledKiln: true }))).toBe('not-applicable');
  expect(kilnUpdateState(host('0.1.0', { url: 'http://127.0.0.1:49000' }))).toBe('older'); // A tunnel isn't proof of ownership.
  for (const kind of ['local', 'ssh', 'remote', 'relay'] as const) {
    expect(kilnUpdateState(host('0.1.0', { kind }))).toBe('not-applicable');
  }
});

test('editing a connection cannot show the previous address’s update notice for its replacement', () => {
  const studio = host('0.1.0');
  const endpoint = { id: studio.id, label: studio.label, url: studio.url!, token: 'fixture' };
  const [renamed] = reconcilePiInstanceSnapshot([studio], [{ ...endpoint, label: 'Studio Mac' }]);
  expect(kilnUpdateState(renamed)).toBe('older');
  const [replacement] = reconcilePiInstanceSnapshot([studio], [{ ...endpoint, url: 'http://other.invalid' }]);
  expect(replacement.version).toBeUndefined();
  expect(kilnUpdateState(replacement)).toBe('unavailable');
});

test('normal authenticated reads observe a changed remote version without issuing any remote write', async () => {
  const endpoint = { label: 'Studio', url: 'https://studio.invalid/kiln', token: 'fixture-only' };
  const calls: string[] = [];
  let reported = '0.1.0';
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    calls.push((init?.method ?? 'GET') + ' ' + pathname);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-only');
    expect(init?.redirect).toBe('manual');
    return Response.json(pathname.endsWith('/health')
      ? { ok: true, service: 'hearth', version: reported } : { conversations: [] });
  }) as typeof fetch;
  const check = async () => {
    const result = await testPiEndpoint(endpoint, { request });
    expect(result.outcome).toBe('ready');
    return kilnUpdateState(host(result.version));
  };
  expect(await check()).toBe('older');
  reported = kilnVersion;
  expect(await check()).toBe('equal');
  expect(calls.sort()).toEqual(['GET /kiln/conversations', 'GET /kiln/conversations', 'GET /kiln/health', 'GET /kiln/health']);
});
