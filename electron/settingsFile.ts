import * as fs from 'node:fs';

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
