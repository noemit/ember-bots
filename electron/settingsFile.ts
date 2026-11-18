import * as fs from 'node:fs';
import * as path from 'node:path';
import { tightenPermissions, tightenPermissionsAsync } from './permissions';

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
