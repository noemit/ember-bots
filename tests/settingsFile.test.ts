import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSettingsFileCache,
  createSettingsFileController,
  initializeFirstRunSettings,
  quarantineCorruptSettings,
  resolveEffectivePiEndpoints,
  resolvePersistedPiEndpoints,
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

describe('mtimeMs cache invalidation and serialized onboarding writes', () => {
  test('back-to-back writeJson calls in the same coarse mtimeMs tick never return stale cached settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-settings-mtime-'));
    const emberFile = join(directory, 'settings.json');
    const openchamberFile = join(directory, 'openchamber-settings.json');
    let statReads = 0;
    // Simulate a coarse filesystem clock where rapid writes share the exact same mtimeMs tick.
    const controller = createSettingsFileController({
      emberSettingsPath: () => emberFile,
      openchamberSettingsPath: () => openchamberFile,
      statMtimeMs: (file) => {
        try {
          statSync(file);
          statReads += 1;
          return 1_700_000_000_000;
        } catch {
          return -1;
        }
      },
    });
    try {
      await controller.writeJson(emberFile, { theme: 'stone', sessionWindowHours: 48 });
      expect(controller.readEmberSettingsFile()).toEqual({ theme: 'stone', sessionWindowHours: 48 });
      // Cache hit with identical mtimeMs returns the same object reference without re-parsing.
      const cachedRef = controller.readEmberSettingsFile();
      expect(controller.readEmberSettingsFile()).toBe(cachedRef);
      expect(statReads).toBeGreaterThanOrEqual(2);

      // Second write in the exact same mtimeMs tick must invalidate the cache immediately on rename.
      await controller.writeJson(emberFile, { theme: 'clay', sessionWindowHours: 24, splitView: true });
      expect(controller.readEmberSettingsFile()).toEqual({
        theme: 'clay',
        sessionWindowHours: 24,
        splitView: true,
      });

      // OpenChamber's settings cache obeys the same invalidation rule.
      await controller.writeJson(openchamberFile, { desktopLocalPort: 57123 });
      expect(controller.readOpenchamberSettings()).toEqual({ desktopLocalPort: 57123 });
      await controller.writeJson(openchamberFile, { desktopLocalPort: 58999 });
      expect(controller.readOpenchamberSettings()).toEqual({ desktopLocalPort: 58999 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('noteOnboarded serializes behind queued settings writes and preserves concurrent patches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-onboarded-queue-'));
    const emberFile = join(directory, 'settings.json');
    const openchamberFile = join(directory, 'openchamber.json');
    const controller = createSettingsFileController({
      emberSettingsPath: () => emberFile,
      openchamberSettingsPath: () => openchamberFile,
      // Freeze mtimeMs so any missing cache invalidation would clobber the earlier write!
      statMtimeMs: (file) => {
        try {
          statSync(file);
          return 1_700_000_000_000;
        } catch {
          return -1;
        }
      },
    });
    try {
      await controller.writeJson(emberFile, { theme: 'stone' });

      let releasePatch!: () => void;
      const patchGate = new Promise<void>((resolve) => {
        releasePatch = resolve;
      });
      const patchWrite = controller.enqueueWrite(async () => {
        await patchGate;
        const current = controller.readEmberSettingsFile();
        await controller.writeJson(emberFile, { ...current, theme: 'clay', splitView: true });
      });

      let broadcasts = 0;
      const onboardedWrite = controller.noteOnboarded(
        true,
        () => {
          broadcasts += 1;
        },
        () => 1_700_000_123_456
      );
      // Duplicate probe while the first write is still queued does not enqueue a second write.
      const duplicate = controller.noteOnboarded(true, () => {
        broadcasts += 1;
      });

      releasePatch();
      await Promise.all([patchWrite, onboardedWrite, duplicate]);

      expect(broadcasts).toBe(1);
      const persisted = JSON.parse(await readFile(emberFile, 'utf8')) as Record<string, unknown>;
      expect(persisted).toEqual({
        theme: 'clay',
        splitView: true,
        onboardedAt: 1_700_000_123_456,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('noteOnboarded refuses to write when quarantine failed or onboardingStartedAt is set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-onboarded-guards-'));
    const emberFile = join(directory, 'settings.json');
    const openchamberFile = join(directory, 'openchamber.json');
    try {
      // 1. Fresh install (`onboardingStartedAt`) keeps the guide until explicitly dismissed.
      await writeFile(emberFile, JSON.stringify({ onboardingStartedAt: 500 }));
      const fresh = createSettingsFileController({
        emberSettingsPath: () => emberFile,
        openchamberSettingsPath: () => openchamberFile,
      });
      expect(await fresh.noteOnboarded(true)).toBe(false);
      expect(JSON.parse(await readFile(emberFile, 'utf8'))).toEqual({ onboardingStartedAt: 500 });

      // 2. Corrupt file whose quarantine fails (`settingsQuarantineFailed`) is never overwritten.
      await writeFile(emberFile, '{"valuable": [');
      const unquarantinable = createSettingsFileController({
        emberSettingsPath: () => emberFile,
        openchamberSettingsPath: () => openchamberFile,
        quarantineSuffix: () => join('missing-subdir', '1'),
      });
      expect(await unquarantinable.noteOnboarded(true)).toBe(false);
      expect(unquarantinable.isQuarantineFailed()).toBe(true);
      expect(await readFile(emberFile, 'utf8')).toBe('{"valuable": [');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('synthesized pi:local persistence', () => {
  const secretStore: SecretStore = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value) => value.toString().split('').reverse().join(''),
  };

  test('unrelated settings patches never bake synthesized pi:local into settings.json or break localHarnessEnabled: false', () => {
    const synthesized = { url: 'http://127.0.0.1:3002', token: 'local-token' };
    const effectiveBefore = resolveEffectivePiEndpoints({
      root: {},
      secretStore,
      canaryBuild: false,
      localHarness: synthesized,
    });
    expect(effectiveBefore).toEqual([
      { id: 'pi:local', label: 'This computer', url: 'http://127.0.0.1:3002', token: 'local-token' },
    ]);

    // Unrelated patch (e.g. `{ localHarnessEnabled: false }` or `{ theme: 'clay' }`) omits piEndpoints entirely.
    const persisted = resolvePersistedPiEndpoints({
      rawStored: undefined,
      previousEffective: effectiveBefore,
      patchValue: undefined,
      synthesizedLocal: synthesized,
      secretStore,
    });
    expect(persisted).toBeUndefined();

    // Once `localHarnessEnabled: false` is saved, neither localHarness nor legacy token discovery resurrects pi:local.
    const effectiveAfterDisable = resolveEffectivePiEndpoints({
      root: { localHarnessEnabled: false },
      secretStore,
      canaryBuild: false,
      localHarness: null,
      discoverLocal: () => ({
        id: 'pi:local',
        label: 'Local',
        url: 'http://127.0.0.1:3002/',
        token: 'local-token',
      }),
    });
    expect(effectiveAfterDisable).toEqual([]);
  });

  test('Canary ephemeral port: 0 is not frozen into settings.json when adding a remote endpoint', () => {
    const launch1Local = { url: 'http://127.0.0.1:51234', token: 'canary-token' };
    const effectiveLaunch1 = resolveEffectivePiEndpoints({
      root: {},
      secretStore,
      canaryBuild: true,
      localHarness: launch1Local,
    });
    const remote = {
      id: 'pi:tower',
      label: 'Tower',
      url: 'http://100.64.0.2:3002',
      token: 'tower-token',
    };

    // EndpointsSettings sends `[...existingEffective, remote]`, which includes the synthesized Canary endpoint.
    const persisted = resolvePersistedPiEndpoints({
      rawStored: undefined,
      previousEffective: effectiveLaunch1,
      patchValue: [...effectiveLaunch1, remote],
      synthesizedLocal: launch1Local,
      secretStore,
    });
    expect(persisted).toEqual([
      { id: 'pi:tower', label: 'Tower', url: 'http://100.64.0.2:3002/', token: 'tower-token' },
    ]);

    // Launch 2 picks a new ephemeral port: no dead 51234 endpoint lingers, and the new port merges cleanly.
    const launch2Local = { url: 'http://127.0.0.1:58901', token: 'canary-token' };
    const effectiveLaunch2 = resolveEffectivePiEndpoints({
      root: { piEndpoints: persisted },
      secretStore,
      canaryBuild: true,
      localHarness: launch2Local,
    });
    expect(effectiveLaunch2.map((entry) => [entry.id, entry.url])).toEqual([
      ['pi:local', 'http://127.0.0.1:58901'],
      ['pi:tower', 'http://100.64.0.2:3002/'],
    ]);
  });

  test('deliberate user edits to pi:local and encrypted Access secrets on remotes are preserved', () => {
    const synthesized = { url: 'http://127.0.0.1:3002', token: 'local-token' };
    const remoteWithAccess = {
      id: 'pi:tower',
      label: 'Tower',
      url: 'https://tower.example/kiln',
      token: 'bearer-token',
      access: { clientId: 'cid', clientSecret: 'csecret' },
    };
    const customLocal = {
      id: 'pi:local',
      label: 'Work MacBook',
      url: 'http://127.0.0.1:3002',
      token: 'local-token',
    };
    const persisted = resolvePersistedPiEndpoints({
      rawStored: undefined,
      previousEffective: [],
      patchValue: [customLocal, remoteWithAccess],
      synthesizedLocal: synthesized,
      secretStore,
    });
    expect(persisted).toHaveLength(2);
    expect((persisted?.[0] as { label?: string })?.label).toBe('Work MacBook');
    expect(JSON.stringify(persisted)).not.toContain('csecret');

    // Unrelated write with a locked keyring keeps ciphertext intact.
    const lockedStore: SecretStore = { ...secretStore, isEncryptionAvailable: () => false };
    const effectiveLocked = resolveEffectivePiEndpoints({
      root: { piEndpoints: persisted },
      secretStore: lockedStore,
      canaryBuild: false,
      localHarness: synthesized,
    });
    const rePersisted = resolvePersistedPiEndpoints({
      rawStored: persisted,
      previousEffective: effectiveLocked,
      patchValue: undefined,
      synthesizedLocal: synthesized,
      secretStore: lockedStore,
    });
    expect(rePersisted).toEqual(persisted);
  });
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
