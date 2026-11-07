import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emberDataDir, legacyEmberDataDir, migrateLegacyDataDir } from '../electron/dataDir';

/**
 * Where Ember keeps its files, and the one-time move out of `~/.config/ember`.
 *
 * Two things cost the user something if they are wrong: a settings file left behind looks like a
 * fresh install (no endpoints, every message unread again), and a migration that overwrites is worse
 * than none at all.
 */

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-datadir-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('where Ember lives', () => {
  test('the default is ~/.ember, and EMBER_DATA_DIR still overrides it for a canary', () => {
    expect(emberDataDir({}, '/Users/alex')).toBe('/Users/alex/.ember');
    expect(emberDataDir({ EMBER_DATA_DIR: '/tmp/canary' }, '/Users/alex')).toBe('/tmp/canary');
    expect(legacyEmberDataDir('/Users/alex')).toBe('/Users/alex/.config/ember');
  });
});

describe('moving a pre-1.4 ~/.config/ember', () => {
  test('settings, stats and activity come across, and the old directory goes', () => {
    const root = tempDir();
    const from = path.join(root, '.config', 'ember');
    const to = path.join(root, '.ember');
    fs.mkdirSync(path.join(from, 'activity'), { recursive: true });
    fs.writeFileSync(path.join(from, 'settings.json'), '{"theme":"clay"}');
    fs.writeFileSync(path.join(from, 'model-stats.json'), '[]');
    fs.writeFileSync(path.join(from, 'activity', 'activity-2026-11-06.jsonl'), '{}\n');

    const moved = migrateLegacyDataDir({ from, to });
    expect(moved.sort()).toEqual(['activity', 'model-stats.json', 'settings.json']);
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toBe('{"theme":"clay"}');
    expect(fs.existsSync(path.join(to, 'activity', 'activity-2026-11-06.jsonl'))).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
  });

  test('a token is never carried across: it belongs to whichever harness is running', () => {
    const root = tempDir();
    const from = path.join(root, '.config', 'ember');
    const to = path.join(root, '.ember');
    fs.mkdirSync(from, { recursive: true });
    fs.writeFileSync(path.join(from, 'settings.json'), '{}');
    fs.writeFileSync(path.join(from, 'hearth.token'), 'stale');
    fs.writeFileSync(path.join(from, 'ember.token'), 'stale');
    migrateLegacyDataDir({ from, to });
    expect(fs.existsSync(path.join(to, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(to, 'hearth.token'))).toBe(false);
    expect(fs.existsSync(path.join(to, 'ember.token'))).toBe(false);
  });

  test('it never overwrites a destination that already has settings', () => {
    const root = tempDir();
    const from = path.join(root, '.config', 'ember');
    const to = path.join(root, '.ember');
    fs.mkdirSync(from, { recursive: true });
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(from, 'settings.json'), '{"old":true}');
    fs.writeFileSync(path.join(to, 'settings.json'), '{"new":true}');
    const moved = migrateLegacyDataDir({ from, to });
    expect(moved).toEqual([]);
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toBe('{"new":true}');
  });

  test('a destination file is not clobbered even when the directory is otherwise empty', () => {
    const root = tempDir();
    const from = path.join(root, '.config', 'ember');
    const to = path.join(root, '.ember');
    fs.mkdirSync(from, { recursive: true });
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(from, 'settings.json'), '{"old":true}');
    fs.writeFileSync(path.join(to, 'settings.json'), '{"new":true}');
    migrateLegacyDataDir({ from, to });
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toBe('{"new":true}');
  });

  test('a missing legacy directory, or a read-only home, is not an error', () => {
    const root = tempDir();
    expect(migrateLegacyDataDir({ from: path.join(root, 'nope'), to: path.join(root, 'to') })).toEqual([]);
    // Same path twice is a no-op rather than a self-delete.
    const same = path.join(root, 'same');
    fs.mkdirSync(same, { recursive: true });
    fs.writeFileSync(path.join(same, 'settings.json'), '{}');
    expect(migrateLegacyDataDir({ from: same, to: same })).toEqual([]);
    expect(fs.existsSync(path.join(same, 'settings.json'))).toBe(true);
  });
});
