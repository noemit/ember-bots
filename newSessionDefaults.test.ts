import { describe, expect, test } from 'bun:test';
import { newSessionDirectoryPrefill, newSessionModelPrefill, recentProjectDirectories } from './src/lib/newSessionDefaults';
import type { Session } from './src/types';

const session = (partial: Partial<Session>): Session => ({ id: 'x', instanceId: 'local', ...partial });

describe('new agent folder prefill', () => {
  const sessions = [
    session({ id: 'old', directory: '/work/old', updated: 100 }),
    session({ id: 'new', directory: '/work/new', updated: 200 }),
    session({ id: 'nodir', updated: 300 }),
  ];
  const projects = [
    { id: 'a', name: 'a', path: '/proj/a', lastOpenedAt: 50 },
    { id: 'b', name: 'b', path: '/proj/b', lastOpenedAt: 90 },
    { id: 'c', name: 'c' },
  ];

  test('saved default folder wins', () => {
    expect(newSessionDirectoryPrefill(sessions, projects, { directory: '/saved' })).toBe('/saved');
  });

  test('most recently updated session directory beats projects', () => {
    expect(newSessionDirectoryPrefill(sessions, projects, {})).toBe('/work/new');
  });

  test('a chosen workspace is the fallback for a new install', () => {
    expect(newSessionDirectoryPrefill([], [], { workspaceDirectory: '/Users/alex/Work' })).toBe('/Users/alex/Work');
  });

  test('falls back to the last-opened project, then nothing', () => {
    expect(newSessionDirectoryPrefill([], projects, {})).toBe('/proj/b');
    expect(newSessionDirectoryPrefill([], [{ id: 'c', name: 'c' }], {})).toBeNull();
  });
});

describe('new agent model prefill', () => {
  test('uses the per-instance default when set', () => {
    expect(newSessionModelPrefill({ model: { providerID: 'p', modelID: 'setting' } })).toEqual({
      key: 'p/setting',
      variant: '',
    });
  });

  test('carries the setting variant, then the model variant', () => {
    expect(
      newSessionModelPrefill({ model: { providerID: 'p', modelID: 'setting', variant: 'high' }, variant: 'low' })
    ).toEqual({ key: 'p/setting', variant: 'low' });
    expect(newSessionModelPrefill({ model: { providerID: 'p', modelID: 'setting', variant: 'high' } })).toEqual({
      key: 'p/setting',
      variant: 'high',
    });
  });

  test('null when unset so the composer uses the server default', () => {
    expect(newSessionModelPrefill({})).toBeNull();
  });
});

test('recent project folders are distinct, ordered, and omit archived chats and workers', () => {
  expect(recentProjectDirectories([
    session({ directory: '/a', updated: 1 }),
    session({ directory: '/b', updated: 2 }),
    session({ directory: '/a', updated: 3 }),
    session({ directory: '/archived', updated: 4, archived: true }),
    session({ directory: '/worker', updated: 5, kind: 'worker' }),
  ])).toEqual(['/a', '/b']);
});
