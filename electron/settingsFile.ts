import * as fs from 'node:fs';
import * as path from 'node:path';

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

export const quarantineCorruptSettings = (file: string, suffix = Date.now()): QuarantineResult => {
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ onboardingStartedAt: Date.now() }) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
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

  return { readEntry, recordWrite };
};
