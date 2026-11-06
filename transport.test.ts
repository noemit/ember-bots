import { describe, expect, test } from 'bun:test';
import {
  discoverLocalPiEndpoint,
  isLocalHttpUrl,
  localHarnessTokenPaths,
  localInstanceUrl,
  normalizeApiMethod,
  parseAvatarOverrides,
  parseColorAssignments,
  parseComposerDrafts,
  parsePiEndpoints,
  parseReadMarks,
  parseSessionNotes,
  parseStringArray,
  parseStringRecord,
  resolveApiUrl,
} from './electron/transport';

describe('instance transport validation', () => {
  test('only recognizes exact loopback hostnames as local', () => {
    expect(isLocalHttpUrl('http://localhost:3000')).toBe(true);
    expect(isLocalHttpUrl('https://127.0.0.1/api')).toBe(true);
    expect(isLocalHttpUrl('http://[::1]:3000')).toBe(true);
    expect(isLocalHttpUrl('http://localhost.evil.test')).toBe(false);
    expect(isLocalHttpUrl('http://127.0.0.1.evil.test')).toBe(false);
    expect(isLocalHttpUrl('http://localhost@evil.test')).toBe(false);
  });

  test('keeps API requests on the configured origin and base path', () => {
    expect(resolveApiUrl('https://example.test', '/api/session?id=1')).toBe(
      'https://example.test/api/session?id=1'
    );
    expect(resolveApiUrl('https://example.test/openchamber/', '/api/session')).toBe(
      'https://example.test/openchamber/api/session'
    );
    expect(resolveApiUrl('https://example.test', '@evil.test')).toBeNull();
    expect(resolveApiUrl('https://example.test', '//evil.test/api')).toBeNull();
    expect(resolveApiUrl('https://example.test', '/admin')).toBeNull();
    expect(resolveApiUrl('https://example.test', '/api/../admin')).toBeNull();
    expect(resolveApiUrl('file:///tmp/settings.json', '/api/session')).toBeNull();
  });

  test('discovers OpenChamber’s separately stored local runtime', () => {
    expect(localInstanceUrl({ desktopLocalPort: 58123 })).toBe('http://127.0.0.1:58123');
    expect(localInstanceUrl({ desktopLocalClientToken: 'configured' })).toBe('http://127.0.0.1:57123');
    expect(localInstanceUrl({})).toBeNull();
    expect(localInstanceUrl({ desktopLocalPort: 70_000 })).toBeNull();
  });

  test('allows only methods used by the API client', () => {
    expect(normalizeApiMethod('get')).toBe('GET');
    expect(normalizeApiMethod('POST')).toBe('POST');
    expect(normalizeApiMethod('patch')).toBe('PATCH');
    expect(normalizeApiMethod('put')).toBe('PUT');
    expect(normalizeApiMethod('DELETE')).toBe('DELETE');
    expect(normalizeApiMethod('TRACE')).toBeNull();
  });
});

describe('appearance settings validation', () => {
  test('bounds and sanitizes persisted string mappings', () => {
    const unsafe = JSON.parse('{"valid":"task:one","__proto__":"bad","empty":""}');
    expect(parseStringRecord(unsafe)).toEqual({ valid: 'task:one' });
    expect(parseStringRecord({ one: '1', two: '2' }, 1)).toEqual({ one: '1' });
    expect(parseStringRecord(null)).toEqual({});
  });

  test('keeps a bounded, de-duplicated workspace key list', () => {
    const unsafe = JSON.parse('["local::a",42,"local::a","local::b",""]');
    expect(parseStringArray(unsafe)).toEqual(['local::a', 'local::b']);
    expect(parseStringArray(['a', 'a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(parseStringArray(['ok', 'x'.repeat(501)])).toEqual(['ok']);
    expect(parseStringArray('local::a')).toEqual([]);
    expect(parseStringArray(null)).toEqual([]);
  });

  test('keeps bounded color assignments', () => {
    expect(parseColorAssignments({ project: 21, negative: -1, overflow: 22, fractional: 1.5 })).toEqual({ project: 21 });
    expect(parseColorAssignments({ marker: 11, overflow: 12 }, 12)).toEqual({ marker: 11 });
  });

  test('parses notes per session and migrates a lone string', () => {
    const unsafe = JSON.parse('{"local::session":"next prompt","__proto__":"bad"}');
    expect(parseSessionNotes(unsafe)).toEqual({
      'local::session': [{ id: 'legacy', text: 'next prompt' }],
    });
    expect(parseSessionNotes({
      valid: [{ id: 'note-1', text: 'one' }, { text: 'two' }],
      tooLong: [{ id: 'note-2', text: 'x'.repeat(20_001) }],
      empty: [],
    })).toEqual({
      valid: [{ id: 'note-1', text: 'one' }, { id: 'legacy-1', text: 'two' }],
    });
  });

  test('keeps bounded composer drafts without attachment payloads', () => {
    expect(parseComposerDrafts({
      'local::session': {
        text: 'Resume this draft',
        modelId: 'anthropic/claude-sonnet',
        variant: 'high',
        mode: 'plan',
        updatedAt: 100,
        attachments: [{ url: 'data:text/plain;base64,secret' }],
      },
      'local::choice': {
        text: '',
        modelId: 'default',
        variant: 'high',
        updatedAt: 101,
      },
      'local::empty': { text: '   ' },
      'local::huge': { text: 'x'.repeat(200_001) },
    })).toEqual({
      'local::session': {
        text: 'Resume this draft',
        modelId: 'anthropic/claude-sonnet',
        variant: 'high',
        mode: 'plan',
        updatedAt: 100,
      },
      'local::choice': {
        text: '',
        modelId: 'default',
        variant: 'high',
        updatedAt: 101,
      },
    });
  });

  test('accepts only bounded curated appearance values', () => {
    expect(parseAvatarOverrides({
      valid: { colorIndex: 5, shapeName: 'wind-turbine' },
      badColor: { colorIndex: 22 },
      fractional: { colorIndex: 1.5 },
      badShape: { shapeName: '<svg>' },
      empty: {},
    })).toEqual({
      valid: { colorIndex: 5, shapeName: 'wind-turbine' },
    });
  });
});

test('Hearth endpoints are namespaced with pi: and migrate older ids', () => {
  const endpoints = parsePiEndpoints([
    { id: 'local', label: 'Local', url: 'http://127.0.0.1:3005', token: 'a'.repeat(64) },
    { id: 'pi:studio', label: 'Studio', url: 'http://100.64.0.1:3011', token: 'b'.repeat(64) },
    { id: '', label: 'broken', url: 'http://x:1', token: 'c' },
    { id: 'notoken', label: 'broken', url: 'http://x:2', token: '' },
    { id: 'pi:local', label: 'dup', url: 'http://x:3', token: 'd' },
  ]);
  expect(endpoints.map((endpoint) => endpoint.id)).toEqual(['pi:local', 'pi:studio']);
  expect(endpoints[0].label).toBe('Local');
  // Existing settings whose ids predate the prefix are migrated at the boundary, so a Hearth
  // endpoint can never collide with the built-in OpenChamber `local` instance.
  expect(endpoints.some((endpoint) => endpoint.id === 'local')).toBe(false);
});

test('the same Hearth saved twice is one endpoint, whatever it is called', () => {
  // A duplicated address is not a cosmetic settings problem: every stream is a mount on the host,
  // so a second entry opens a second full watch set and holds every open conversation twice. The
  // entry that was there first keeps its label and token.
  const endpoints = parsePiEndpoints([
    { id: 'pi:heliograph', label: 'Heliograph', url: 'http://100.66.124.73:3002/', token: 'a'.repeat(64) },
    { id: 'pi:heliograph-tailnet', label: 'Heliograph (tailnet)', url: 'http://100.66.124.73:3002', token: 'a'.repeat(64) },
    { id: 'pi:localhost', label: 'Same host, local address', url: 'http://127.0.0.1:3002', token: 'b'.repeat(64) },
  ]);
  expect(endpoints.map((endpoint) => endpoint.id)).toEqual(['pi:heliograph', 'pi:localhost']);
  expect(endpoints[0].label).toBe('Heliograph');
});

test('discovers local harness token from ~/.ember, ~/.hearth, or EMBER_HOME / HEARTH_HOME', () => {
  expect(localHarnessTokenPaths('/home/alex', {})).toEqual([
    '/home/alex/.ember/ember.token',
    '/home/alex/.hearth/hearth.token',
  ]);
  expect(localHarnessTokenPaths('/home/alex', { HEARTH_HOME: '/custom/hearth' })).toEqual([
    '/custom/hearth/hearth.token',
    '/custom/hearth/ember.token',
    '/home/alex/.ember/ember.token',
    '/home/alex/.hearth/hearth.token',
  ]);

  const files: Record<string, string> = {
    '/home/alex/.hearth/hearth.token': '  local-secret-token \n',
  };
  const endpoint = discoverLocalPiEndpoint((p) => files[p], '/home/alex', {});
  expect(endpoint).toEqual({
    id: 'pi:local',
    label: 'Local',
    url: 'http://127.0.0.1:3002/',
    token: 'local-secret-token',
  });
  expect(discoverLocalPiEndpoint(() => undefined, '/home/alex', {})).toBeNull();
});

/**
 * The read-mark round trip.
 *
 * `parseReadMarks` rebuilds each mark from a fixed list of fields, and a field it does not name is
 * dropped silently. That is how the "New messages: Don't notify" toggle shipped broken: it saved,
 * main validated the `quiet` flag away, and the stored copy that came back had no policy in it — so
 * the row flickered and reverted. A standing policy has to survive storage or it is not a setting.
 */
describe('read marks survive the settings round trip', () => {
  test('a quiet session keeps its policy, even with no read history at all', () => {
    const parsed = parseReadMarks({ 'pi:h::4': { through: 0, quiet: true } });
    expect(parsed['pi:h::4']).toEqual({ through: 0, quiet: true });
  });

  test('quiet rides alongside a normal mark', () => {
    const parsed = parseReadMarks({ 'pi:h::4': { through: 12, ids: [14], readAt: 500, quiet: true } });
    expect(parsed['pi:h::4']).toEqual({ through: 12, ids: [14], readAt: 500, quiet: true });
  });

  test('turning it off is a real value, and a mark with nothing in it is still not worth a key', () => {
    expect(parseReadMarks({ 'pi:h::4': { through: 0, quiet: false } })).toEqual({});
    expect(parseReadMarks({ 'pi:h::4': { quiet: 'yes' } })).toEqual({});
  });
});
