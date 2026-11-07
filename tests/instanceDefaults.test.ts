import { expect, test } from 'bun:test';
import { parseInstanceDefaults } from '../electron/transport';

/**
 * `instanceDefaults` round-trips through the same parser on the way in and on the way out.
 *
 * The bug this pins: `preferredProvider` existed in the renderer's type and in the Settings
 * dialog, but the parser listed six of seven fields, so the value was dropped on read and
 * deleted from disk on the next save. The dialog looked like it saved.
 */

const stored = {
  'pi:keep': {
    directory: '/home/alex/code/project',
    workspaceDirectory: '/home/alex/code',
    agent: 'build',
    model: { providerID: 'github-copilot', modelID: 'gpt-5', variant: 'high' },
    variant: 'low',
    bypass: true,
    markerColor: 3,
    preferredProvider: 'github-copilot',
  },
};

test('every field the renderer can set survives read → write → read', () => {
  // Read: file JSON → settings the renderer sees.
  const read = parseInstanceDefaults(JSON.parse(JSON.stringify(stored)));
  expect(read['pi:keep']).toEqual(stored['pi:keep']);

  // Write: the renderer sends the same object back in a patch, main parses it, and the file holds
  // the JSON of the result.
  const written = JSON.stringify({ instanceDefaults: parseInstanceDefaults(read) });

  // Read again, from the bytes on disk.
  const reread = parseInstanceDefaults(JSON.parse(written).instanceDefaults);
  expect(reread['pi:keep']).toEqual(stored['pi:keep']);
  expect(reread['pi:keep'].preferredProvider).toBe('github-copilot');
});

test('a preference alone is enough to keep an entry', () => {
  expect(parseInstanceDefaults({ local: { preferredProvider: 'xai' } }).local).toEqual({
    directory: undefined,
    agent: undefined,
    model: undefined,
    variant: undefined,
    bypass: undefined,
    markerColor: undefined,
    preferredProvider: 'xai',
  });
});

test('the preference is bounded and rejects non-strings, like every other field', () => {
  expect(parseInstanceDefaults({ a: { preferredProvider: '' } }).a.preferredProvider).toBeUndefined();
  expect(parseInstanceDefaults({ a: { preferredProvider: 42 } }).a.preferredProvider).toBeUndefined();
  expect(parseInstanceDefaults({ a: { preferredProvider: 'x'.repeat(201) } }).a.preferredProvider).toBeUndefined();
});

test('prototype keys cannot be smuggled through instance ids', () => {
  const parsed = parseInstanceDefaults(JSON.parse('{"__proto__":{"directory":"/etc"}}'));
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.keys(parsed)).toEqual([]);
  // No other instance may inherit the smuggled entry.
  expect(parsed.local).toBeUndefined();
});

test('workspace selection stays bounded and does not become a chat default', () => {
  const entry = parseInstanceDefaults({ local: { workspaceDirectory: ' /Users/alex/Work ' } }).local;
  expect(entry.workspaceDirectory).toBe('/Users/alex/Work');
  expect(entry.directory).toBeUndefined();
  expect(parseInstanceDefaults({ local: { workspaceDirectory: 'x'.repeat(4097) } }).local.workspaceDirectory).toBeUndefined();
  expect(parseInstanceDefaults({ local: { workspaceDirectory: 42 } }).local.workspaceDirectory).toBeUndefined();
});
