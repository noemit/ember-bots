import * as fs from 'node:fs';
import * as path from 'node:path';
import { tightenPermissions, tightenPermissionsAsync } from './permissions';
import { lockEndpointSecrets, restoreEndpointSecrets, unlockEndpointSecrets, type SecretStore } from './endpointSecrets';
import { mergeLocalHarnessEndpoint, withoutSynthesizedLocalEndpoint } from './localHarness';
import { parsePiEndpoints, type PiEndpoint } from './transport';

/**
 * Keeps an unreadable settings file instead of letting the next save overwrite it.
 *
 * `readJsonRoot` returns `undefined` for both "missing" and "corrupt", and the app treated the
 * two the same: it started from defaults and the next settings change wrote those defaults over
 * the user's file. One bad byte cost every setting, with nothing said and no copy left.
 *
 * Split out of `main.ts` so it can be exercised without Electron: the behaviour that matters is
 * "the old bytes still exist afterwards", and that is testable with a temp directory.
 */
export type QuarantineResult =
  | { ok: true; movedTo: string }
  | { ok: false; error: string };

export const quarantineCorruptSettings = (file: string, suffix: number | string = Date.now()): QuarantineResult => {
  const target = `${file}.corrupt-${suffix}`;
  try {
    fs.renameSync(file, target);
    return { ok: true, movedTo: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Record a genuinely new install before Kiln creates its database or any settings are saved. */
export const initializeFirstRunSettings = (file: string, database: string): void => {
  if (fs.existsSync(file) || fs.existsSync(database)) return;
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  tightenPermissions(directory, 0o700);
  try {
    fs.writeFileSync(file, JSON.stringify({ onboardingStartedAt: Date.now() }) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  tightenPermissions(file, 0o600);
};

/** Atomically write a JSON file inside a `0o700` directory with `0o600` file permissions. */
export const writePrivateJson = async (file: string, data: unknown): Promise<void> => {
  const directory = path.dirname(file);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await tightenPermissionsAsync(directory, 0o700);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await tightenPermissionsAsync(temporary, 0o600);
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
};

const APP_ICON_LOG_CAP = 8_000;

/** Append one diagnostic line to `app-icon.log` (mode `0o600`) with an 8 KB rolling cap. */
export const appendAppIconLog = (file: string, line: string): void => {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  tightenPermissions(directory, 0o700);
  let previous = '';
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch {
    // First write.
  }
  fs.writeFileSync(file, `${previous.length > APP_ICON_LOG_CAP ? '' : previous}${line}\n`, { mode: 0o600 });
  tightenPermissions(file, 0o600);
};

/** The file's object, or undefined when it is missing or does not parse (not the same as empty). */
export const readJsonRoot = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
};

export const readJson = (file: string): Record<string, unknown> => readJsonRoot(file) ?? {};

let tempFileCounter = 0;

export const writeJsonFile = async (
  file: string,
  data: unknown,
  onRenamed?: (writtenFile: string) => void
): Promise<void> => {
  const directory = path.dirname(file);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await tightenPermissionsAsync(directory, 0o700);
  const temporary = `${file}.${process.pid}.${Date.now()}.${++tempFileCounter}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await tightenPermissionsAsync(temporary, 0o600);
    await fs.promises.rename(temporary, file);
    onRenamed?.(file);
  } finally {
    await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
};

const isPositiveTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const defaultStatMtimeMs = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

export type SettingsFileControllerOptions = {
  emberSettingsPath: () => string;
  openchamberSettingsPath: () => string;
  statMtimeMs?: (file: string) => number;
  quarantineSuffix?: () => number | string;
  onRecovered?: (movedTo: string) => void;
  onQuarantineFailed?: (error: string) => void;
};

/**
 * Owns Ember's and OpenChamber's mtime-cached JSON settings reads, serialized settings writes,
 * cache invalidation on atomic rename, and one-shot `onboardedAt` stamping.
 */
export const createSettingsFileController = (options: SettingsFileControllerOptions) => {
  const statMtimeMs = options.statMtimeMs ?? defaultStatMtimeMs;
  let settingsRecoveredFrom: string | null = null;
  let settingsQuarantineFailed = false;
  let emberSettingsCache: { mtimeMs: number; root: Record<string, unknown> } | null = null;
  let openchamberSettingsCache: { mtimeMs: number; root: Record<string, unknown> } | null = null;
  let settingsWrites: Promise<unknown> = Promise.resolve();
  let onboardedStamped = false;

  const quarantineSettingsFile = (file: string): void => {
    if (settingsRecoveredFrom) return;
    const result = quarantineCorruptSettings(file, options.quarantineSuffix?.());
    if (result.ok) {
      settingsRecoveredFrom = result.movedTo;
      options.onRecovered?.(result.movedTo);
      return;
    }
    settingsRecoveredFrom = file;
    settingsQuarantineFailed = true;
    options.onQuarantineFailed?.(result.error);
  };

  const readEmberSettingsFile = (): Record<string, unknown> => {
    const file = options.emberSettingsPath();
    const mtimeMs = statMtimeMs(file);
    if (emberSettingsCache && emberSettingsCache.mtimeMs === mtimeMs) return emberSettingsCache.root;
    const parsed = readJsonRoot(file);
    if (parsed === undefined && mtimeMs !== -1) {
      try {
        quarantineSettingsFile(file);
      } catch {
        // Keep serving the last good parse; `settingsQuarantineFailed` refuses the next write.
      }
    }
    const root = parsed ?? emberSettingsCache?.root ?? {};
    emberSettingsCache = { mtimeMs: parsed === undefined && settingsRecoveredFrom ? -1 : mtimeMs, root };
    return root;
  };

  const readOpenchamberSettings = (): Record<string, unknown> => {
    const file = options.openchamberSettingsPath();
    const mtimeMs = statMtimeMs(file);
    if (openchamberSettingsCache && openchamberSettingsCache.mtimeMs === mtimeMs) {
      return openchamberSettingsCache.root;
    }
    const root = readJson(file);
    openchamberSettingsCache = { mtimeMs, root };
    return root;
  };

  const writeJson = async (file: string, data: unknown): Promise<void> => {
    await writeJsonFile(file, data, (written) => {
      if (written === options.emberSettingsPath()) emberSettingsCache = null;
      if (written === options.openchamberSettingsPath()) openchamberSettingsCache = null;
    });
  };

  const enqueueWrite = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = settingsWrites.catch(() => {}).then(operation);
    settingsWrites = result;
    return result;
  };

  const noteOnboarded = (
    hasHealthyInstance: boolean,
    onRecorded?: () => void,
    now: () => number = Date.now
  ): Promise<boolean> => {
    if (onboardedStamped || settingsQuarantineFailed) return Promise.resolve(false);
    if (!hasHealthyInstance) return Promise.resolve(false);
    const current = readEmberSettingsFile();
    if (settingsQuarantineFailed) return Promise.resolve(false);
    if (isPositiveTimestamp(current.onboardingStartedAt)) return Promise.resolve(false);
    if (isPositiveTimestamp(current.onboardedAt)) {
      onboardedStamped = true;
      return Promise.resolve(false);
    }
    onboardedStamped = true;
    return enqueueWrite(async () => {
      if (settingsQuarantineFailed) {
        onboardedStamped = false;
        return false;
      }
      const root = readEmberSettingsFile();
      if (settingsQuarantineFailed) {
        onboardedStamped = false;
        return false;
      }
      if (isPositiveTimestamp(root.onboardingStartedAt)) {
        onboardedStamped = false;
        return false;
      }
      if (isPositiveTimestamp(root.onboardedAt)) {
        return false;
      }
      await writeJson(options.emberSettingsPath(), { ...root, onboardedAt: now() });
      onRecorded?.();
      return true;
    }).catch((error) => {
      onboardedStamped = false;
      throw error;
    });
  };

  return {
    readEmberSettingsFile,
    readOpenchamberSettings,
    writeJson,
    enqueueWrite,
    noteOnboarded,
    isRecovered: () => settingsRecoveredFrom !== null,
    isQuarantineFailed: () => settingsQuarantineFailed,
    invalidateEmberCache: () => {
      emberSettingsCache = null;
    },
    invalidateOpenchamberCache: () => {
      openchamberSettingsCache = null;
    },
  };
};

export const resolveEffectivePiEndpoints = (options: {
  root: Record<string, unknown>;
  secretStore: SecretStore;
  canaryBuild: boolean;
  localHarness: { url: string; token: string } | null;
  discoverLocal?: () => PiEndpoint | null;
}): PiEndpoint[] => {
  const { root, secretStore, canaryBuild, localHarness, discoverLocal } = options;
  const configured = parsePiEndpoints(unlockEndpointSecrets(root.piEndpoints, secretStore));
  const localEnabled = root.localHarnessEnabled !== false;
  const discovered: PiEndpoint[] =
    configured.length > 0 || Array.isArray(root.piEndpoints) || canaryBuild || !localEnabled
      ? configured
      : (() => {
          const found = discoverLocal?.() ?? null;
          return found ? [found] : [];
        })();
  return mergeLocalHarnessEndpoint(discovered, localEnabled ? localHarness : null).map((endpoint) =>
    endpoint.id === 'pi:local' && endpoint.label === 'Local' ? { ...endpoint, label: 'This computer' } : endpoint
  );
};

export const resolvePersistedPiEndpoints = (options: {
  rawStored: unknown;
  previousEffective: readonly PiEndpoint[];
  patchValue: unknown;
  synthesizedLocal: { url: string; token: string } | null;
  secretStore: SecretStore;
}): unknown[] | undefined => {
  const { rawStored, previousEffective, patchValue, synthesizedLocal, secretStore } = options;
  if (patchValue === undefined || !Array.isArray(patchValue)) {
    if (!Array.isArray(rawStored)) return undefined;
    const configured = parsePiEndpoints(unlockEndpointSecrets(rawStored, secretStore));
    const cleaned = withoutSynthesizedLocalEndpoint(configured, synthesizedLocal);
    return lockEndpointSecrets(cleaned, rawStored, secretStore);
  }
  const restored = parsePiEndpoints(restoreEndpointSecrets(patchValue, previousEffective));
  const cleaned = withoutSynthesizedLocalEndpoint(restored, synthesizedLocal);
  return lockEndpointSecrets(cleaned, rawStored, secretStore);
};

/**
 * Reconcile a cached `Instance[]` snapshot with an updated `piEndpoints` list so removed Kiln hosts
 * vanish immediately on cached reads instead of surviving until the next full probe.
 */
export const reconcilePiInstanceSnapshot = <T extends { id: string; label: string; url?: string; kind?: string }>(
  snapshot: readonly T[],
  nextEndpoints: readonly PiEndpoint[],
  keepLocalStarting = false,
): T[] => {
  const byId = new Map(nextEndpoints.map((endpoint) => [endpoint.id, endpoint]));
  return snapshot.flatMap<T>((instance) => {
    if (instance.kind !== 'pi') return [instance];
    const updated = byId.get(instance.id);
    if (updated) {
      // A replacement host must not inherit the previous host’s ready state or version notice.
      const changedHost = updated.url !== instance.url;
      return [{
        ...instance, label: updated.label, url: updated.url,
        ...(changedHost ? { status: 'checking', attachable: false, version: undefined, bundledKiln: undefined } : {}),
      }];
    }
    if (instance.id === 'pi:local' && keepLocalStarting) return [instance];
    return [];
  });
};

export const stripUndefinedKeys = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

export type SettingsCacheEntry<TStatic, TEndpoint> = {
  mtimeMs: number;
  root: Record<string, unknown>;
  staticSettings?: TStatic;
  configuredPiEndpoints?: TEndpoint[];
};

/**
 * mtime-keyed settings file cache with write-through updates so saving a draft or preference
 * updates the in-memory snapshot directly instead of re-reading JSON and re-decrypting secrets.
 */
export const createSettingsFileCache = <TStatic, TEndpoint>(options: {
  filePath: () => string;
  readRoot: (file: string) => Record<string, unknown> | undefined;
  onCorrupt: (file: string) => void;
  isQuarantined: () => boolean;
}) => {
  let cached: SettingsCacheEntry<TStatic, TEndpoint> | null = null;

  const readEntry = (): SettingsCacheEntry<TStatic, TEndpoint> => {
    const file = options.filePath();
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // Missing: cached under -1, and a previous good value keeps the app configured until it lands.
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    const parsed = options.readRoot(file);
    if (parsed === undefined && mtimeMs !== -1) {
      try {
        options.onCorrupt(file);
      } catch {
        // Keep serving the last good parse; `settingsQuarantineFailed` refuses the next write.
      }
    }
    const previous = cached;
    const root = parsed ?? previous?.root ?? {};
    cached = {
      mtimeMs: parsed === undefined && options.isQuarantined() ? -1 : mtimeMs,
      root,
      ...(previous && root === previous.root
        ? {
            staticSettings: previous.staticSettings,
            configuredPiEndpoints: previous.configuredPiEndpoints,
          }
        : {}),
    };
    return cached;
  };

  const recordWrite = (
    file: string,
    root: Record<string, unknown>,
    staticSettings: TStatic,
    configuredPiEndpoints?: TEndpoint[]
  ): void => {
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // File removed externally right after rename; next read will refresh.
    }
    cached = {
      mtimeMs,
      root,
      staticSettings,
      ...(configuredPiEndpoints !== undefined ? { configuredPiEndpoints } : {}),
    };
  };

  return {
    readEntry,
    recordWrite,
    invalidate: () => {
      cached = null;
    },
  };
};
