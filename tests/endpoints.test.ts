import { describe, expect, test } from 'bun:test';
import { endpointError, endpointIdFrom, maskToken, normalizeEndpointUrl, removeEndpoint, upsertEndpoint } from '../src/lib/endpoints';
import type { PiEndpoint } from '../src/types';

const endpoint = (overrides: Partial<PiEndpoint> = {}): PiEndpoint => ({
  id: 'pi:keep',
  label: 'Keep',
  url: 'http://100.64.0.1:3002',
  token: 'a'.repeat(64),
  ...overrides,
});

describe('endpoint urls', () => {
  test('accepts http(s), bare host:port, and a reverse-proxied path; rejects other schemes', () => {
    expect(normalizeEndpointUrl('http://host:3002/')).toBe('http://host:3002');
    expect(normalizeEndpointUrl('host:3002')).toBe('http://host:3002');
    expect(normalizeEndpointUrl('https://hearth.example.com/base/')).toBe('https://hearth.example.com/base');
    expect(normalizeEndpointUrl('ftp://host')).toBeNull();
    expect(normalizeEndpointUrl('http://user:pass@host')).toBeNull();
    expect(normalizeEndpointUrl('   ')).toBeNull();
  });
});

describe('endpoint ids', () => {
  test('are namespaced with pi: so they cannot collide with OpenChamber instance ids', () => {
    expect(endpointIdFrom('Local', 'http://x:1', [])).toBe('pi:local');
    expect(endpointIdFrom('Keep', 'http://x:1', [])).toBe('pi:keep');
    expect(endpointIdFrom('Studio', 'http://x:1', ['pi:studio'])).toBe('pi:studio-2');
    expect(endpointIdFrom('', 'http://100.64.0.1:3011', [])).toBe('pi:100-64-0-1');
    expect(endpointIdFrom('!!', 'not a url', [])).toBe('pi:hearth');
    // A Hearth endpoint named like the built-in OpenChamber instance stays separate.
    expect(endpointIdFrom('local', 'http://127.0.0.1:3005', [])).not.toBe('local');
  });
});

describe('validation and upsert', () => {
  test('reports the first problem and accepts a good draft', () => {
    expect(endpointError({ label: '', url: 'http://x:1', token: '' })).toContain('name');
    expect(endpointError({ label: 'K', url: 'ftp://host', token: '' })).toContain('http');
    expect(endpointError({ label: 'K', url: 'http://user:pass@host', token: '' })).toContain('http');
    expect(endpointError({ label: 'K', url: 'http://x:1', token: '' })).toBeNull();
    expect(endpointError({ label: 'K', url: 'http://x:1', token: '' }, [endpoint({ url: 'http://x:1' })])).toContain('already used');
    // Editing an endpoint does not collide with itself.
    expect(endpointError({ id: 'pi:keep', label: 'K', url: 'http://x:1', token: '' }, [endpoint({ url: 'http://x:1' })])).toBeNull();
  });

  test('adds, replaces by id, and removes', () => {
    const list = [endpoint()];
    const added = upsertEndpoint(list, { label: 'Studio', url: '100.64.0.1:3011', token: 't' });
    expect(added).toHaveLength(2);
    expect(added[1]).toMatchObject({ id: 'pi:studio', url: 'http://100.64.0.1:3011' });

    const edited = upsertEndpoint(added, { id: 'pi:keep', label: 'Keep (renamed)', url: 'http://100.64.0.1:3002', token: 'z' });
    expect(edited).toHaveLength(2);
    expect(edited[0]).toMatchObject({ label: 'Keep (renamed)', token: 'z' });

    expect(removeEndpoint(edited, 'pi:studio').map((entry) => entry.id)).toEqual(['pi:keep']);
  });
});

describe('token masking', () => {
  test('never shows more than the last four characters', () => {
    expect(maskToken('a'.repeat(64))).toBe(`••••••••${'a'.repeat(4)}`);
    expect(maskToken('abc')).toBe('••••');
  });
});
