import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSettingsFileCache,
  initializeFirstRunSettings,
  quarantineCorruptSettings,
  stripUndefinedKeys,
} from '../electron/settingsFile';
import {
  canCacheUnlockedEndpoints,
  lockEndpointSecrets,
  persistEndpointSecrets,
  unlockEndpointSecrets,
  type SecretStore,
} from '../electron/endpointSecrets';
import { parsePiEndpoints, parseStringArray, type PiEndpoint } from '../electron/transport';
import { DEFAULT_SETTINGS } from '../src/hooks/useEmberSettings';

/**
 * An unreadable `settings.json` must be kept, not overwritten.
 *
 * The old read path returned `{}` for both "missing" and "corrupt", so the app started from
 * defaults and the next settings change wrote those defaults over the user's only copy — with no
 * message and no backup. These tests cover the keep-it part; `main.ts` is what decides to start
 * from defaults and to set `settingsRecovered` for the renderer (it imports Electron, so the
 * wiring is checked by typecheck, not here).
 */

test('an unreadable settings file is renamed aside and its bytes are still there', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-settings-quarantine-'));
  try {
    const file = join(directory, 'settings.json');
    const broken = '{"theme":"clay","sessionNotes":{"a::b":['; 
    await writeFile(file, broken);

    const result = quarantineCorruptSettings(file, 1_700_000_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.movedTo).toBe(`${file}.corrupt-1700000000000`);

    // The original path is free for a fresh file, and the old bytes survived intact.
    expect(await readFile(result.movedTo, 'utf8')).toBe(broken);
    const names = await readdir(directory);
    expect(names).toEqual([`settings.json.corrupt-1700000000000`]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('a quarantine that cannot happen reports failure instead of pretending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-settings-quarantine-'));
  try {
    const file = join(directory, 'settings.json');
    await writeFile(file, 'not json');
    // A suffix that cannot form a valid path (the parent does not exist) makes the rename fail,
    // which is what a locked or read-only profile does on a real machine.
    const result = quarantineCorruptSettings(file, join('missing-dir', '1'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.length).toBeGreaterThan(0);
    // The only copy is untouched: the caller must refuse to write over it.
    expect(await readFile(file, 'utf8')).toBe('not json');
  } finally {
    await rm(directory, { recursive: true });
  }
});

/**
 * The Instances menu's untick means "remove this host from my list", so the ids live in settings.
 *
 * They used to be an in-memory Set: unticking hid a host's sessions, its outage row and its palette
 * entries, and the next launch forgot — a removed instance came back on its own. The filtering was
 * always right; only the memory was missing.
 */
describe('hidden instances', () => {
  test('ship as an empty list, not as a missing field', () => {
    expect(DEFAULT_SETTINGS.hiddenInstances).toEqual([]);
  });

  test('a stored list round-trips through the settings parser', () => {
    expect(parseStringArray(['pi:moat', 'local'])).toEqual(['pi:moat', 'local']);
  });

  test('junk and duplicates are dropped rather than poisoning the filter', () => {
    expect(parseStringArray(['pi:moat', 7, null, '', 'pi:moat', { id: 'x' }])).toEqual(['pi:moat']);
    // Not a list at all: nothing is hidden, which fails safe (everything visible).
    expect(parseStringArray(undefined)).toEqual([]);
    expect(parseStringArray('pi:moat')).toEqual([]);
  });
});

/**
 * A dismissed outage warning is remembered, but only for as long as its outage lasts.
 *
 * The memory is the point: the row used to be permanent with no way to answer it, and the fix
 * would be worthless if a relaunch put it back. When it is cleared is the pure half's job
 * (`reconcileOutageDismissals`); here the field only has to survive a store and a reload.
 */
describe('dismissed outage warnings', () => {
  test('ship as an empty list, not as a missing field', () => {
    expect(DEFAULT_SETTINGS.dismissedOutages).toEqual([]);
  });

  test('a stored list round-trips through the settings parser', () => {
    expect(parseStringArray(['pi:keep'])).toEqual(['pi:keep']);
    // The same defence as the hidden list: a hand-edited file cannot put junk in the filter.
    expect(parseStringArray(['pi:keep', 3, '', 'pi:keep'])).toEqual(['pi:keep']);
  });
});

test('a missing file is not a quarantine case', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-settings-quarantine-'));
  try {
    const result = quarantineCorruptSettings(join(directory, 'nope.json'), 1);
    expect(result.ok).toBe(false);
  } finally {
    await rm(directory, { recursive: true });
  }
});


test('only a genuinely empty install is marked for first-run setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-first-run-'));
  const file = join(directory, 'settings.json');
  const database = join(directory, 'hearth.sqlite');
  try {
    initializeFirstRunSettings(file, database);
    const initial = await readFile(file, 'utf8');
    expect(JSON.parse(initial).onboardingStartedAt).toBeGreaterThan(0);
    initializeFirstRunSettings(file, database);
    expect(await readFile(file, 'utf8')).toBe(initial);
    await writeFile(file, '{"theme":"clay"}');
    initializeFirstRunSettings(file, database);
    expect(await readFile(file, 'utf8')).toBe('{"theme":"clay"}');
    await rm(file);
    await writeFile(database, 'existing database');
    initializeFirstRunSettings(file, database);
    expect(await readFile(file, 'utf8').catch(() => null)).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('write-through settings cache avoids re-reading disk and re-decrypting secrets across draft saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-settings-cache-'));
  const file = join(directory, 'settings.json');
  try {
    let encryptCalls = 0;
    let decryptCalls = 0;
    let diskReads = 0;
    const store: SecretStore = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value) => {
        encryptCalls += 1;
        return Buffer.from(value, 'utf8');
      },
      decryptString: (value) => {
        decryptCalls += 1;
        return value.toString('utf8');
      },
    };
    const initialEndpoints = lockEndpointSecrets(
      [{ id: 'pi:tower', label: 'Tower', url: 'https://tower.example/kiln', token: 'tok', access: { clientId: 'cid', clientSecret: 'csec' } }],
      [],
      store
    );
    expect(encryptCalls).toBe(1);
    await writeFile(file, JSON.stringify({ theme: 'stone', composerDrafts: {}, piEndpoints: initialEndpoints }, null, 2));

    const cache = createSettingsFileCache<{ theme: string; composerDrafts: Record<string, { text: string; updatedAt: number }> }, PiEndpoint>({
      filePath: () => file,
      readRoot: (target) => {
        diskReads += 1;
        return JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      },
      onCorrupt: () => {},
      isQuarantined: () => false,
    });

    const readCachedSettings = () => {
      const entry = cache.readEntry();
      const staticSettings = (entry.staticSettings ??= {
        theme: String(entry.root.theme ?? 'stone'),
        composerDrafts: (entry.root.composerDrafts as Record<string, { text: string; updatedAt: number }>) ?? {},
      });
      const piEndpoints =
        entry.configuredPiEndpoints ??
        (() => {
          const unlocked = parsePiEndpoints(unlockEndpointSecrets(entry.root.piEndpoints, store));
          if (canCacheUnlockedEndpoints(unlocked)) entry.configuredPiEndpoints = unlocked;
          return unlocked;
        })();
      return { root: entry.root, ...staticSettings, piEndpoints };
    };

    // Initial read loads from disk once and decrypts once.
    const first = readCachedSettings();
    expect(diskReads).toBe(1);
    expect(decryptCalls).toBe(1);
    expect(first.piEndpoints[0]?.access).toEqual({ clientId: 'cid', clientSecret: 'csec' });

    // Simulate three consecutive composerDraftChanges saves + post-save reads (e.g. refreshRemoteServer / dailyUpdateChecks).
    for (const draftText of ['h', 'he', 'hello']) {
      const current = readCachedSettings();
      const persistedEndpoints = persistEndpointSecrets(current.piEndpoints, current.root.piEndpoints, store, false);
      const nextDrafts = { 'pi:tower::1': { text: draftText, updatedAt: 100 } };
      const nextRoot = stripUndefinedKeys({
        theme: current.theme,
        composerDrafts: nextDrafts,
        piEndpoints: persistedEndpoints,
        optionalAbsent: undefined,
      });
      await writeFile(file, JSON.stringify(nextRoot, null, 2));
      cache.recordWrite(file, nextRoot, { theme: current.theme, composerDrafts: nextDrafts }, current.piEndpoints);
      const afterWrite = readCachedSettings();
      expect(afterWrite.composerDrafts['pi:tower::1']?.text).toBe(draftText);
      expect(afterWrite.piEndpoints[0]?.access).toEqual({ clientId: 'cid', clientSecret: 'csec' });
      expect('optionalAbsent' in afterWrite.root).toBe(false);
    }

    // Zero additional disk reads, zero additional decrypts, and zero re-encrypts across all three patches!
    expect(diskReads).toBe(1);
    expect(decryptCalls).toBe(1);
    expect(encryptCalls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
