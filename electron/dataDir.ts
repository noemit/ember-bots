import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where Ember keeps everything it owns: `~/.ember`.
 *
 * It used to be `~/.config/ember`, which was wrong three ways. "ember" under a shared XDG root is a
 * plausible name for any unrelated tool; on macOS the platform convention is Application Support,
 * not `~/.config`; and the harness's own home (`~/.ember`) had to live somewhere else entirely, so
 * one product kept its settings and its database in two unrelated places with two backup stories.
 * Now the app and the harness share one directory, and deleting it deletes Ember.
 *
 * `EMBER_DATA_DIR` still overrides for a side-by-side "canary" build (its own settings, stats,
 * activity and harness home, and the window calls itself Ember Canary); the OpenChamber settings are
 * shared and read-only, which is safe, but only remote access (port 57821) must not be enabled on
 * both at once.
 */
export const emberDataDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: string = os.homedir()
): string => {
  const override = env.EMBER_DATA_DIR && env.EMBER_DATA_DIR.trim();
  return override ? path.resolve(override) : path.join(homedir, '.ember');
};

/** The pre-1.4 location, read once so an existing install keeps its settings. */
export const legacyEmberDataDir = (
  homedir: string = os.homedir()
): string => path.join(homedir, '.config', 'ember');

/**
 * Move a pre-1.4 `~/.config/ember` to `~/.ember`, once.
 *
 * A settings file left behind would look like a fresh install: no endpoints, no drafts, Home
 * starting over with every message unread. So the migration runs before anything reads settings, and
 * it never overwrites a file that is already at the destination — a half-finished move is completed,
 * and a deliberate reset (the destination exists) is respected.
 *
 * Best-effort by design: a read-only home must not stop the app from opening. It returns the
 * entries it moved, for the log and the tests.
 */
export const migrateLegacyDataDir = (input: {
  from: string;
  to: string;
  fs?: typeof import('node:fs');
}): string[] => {
  const io = input.fs ?? fs;
  if (input.from === input.to) return [];
  try {
    if (!io.existsSync(input.from) || !io.statSync(input.from).isDirectory()) return [];
  } catch {
    return [];
  }
  // Only migrate into a destination that does not already hold settings: otherwise the person has
  // used the new location, and old files would silently win.
  if (io.existsSync(path.join(input.to, 'settings.json'))) return [];
  const moved: string[] = [];
  const move = (source: string, destination: string): void => {
    if (io.existsSync(destination)) return;
    try {
      io.renameSync(source, destination);
      moved.push(path.basename(source));
      return;
    } catch {
      // A cross-device rename (or a locked file) cannot be atomic; copy then remove.
    }
    try {
      io.cpSync(source, destination, { recursive: true, errorOnExist: false, force: false });
      io.rmSync(source, { recursive: true, force: true });
      moved.push(path.basename(source));
    } catch (error) {
      console.warn('[ember] could not migrate', source, error instanceof Error ? error.message : error);
    }
  };
  try {
    io.mkdirSync(input.to, { recursive: true });
  } catch {
    return [];
  }
  for (const entry of io.readdirSync(input.from)) {
    // A token file is written by whichever harness runs; never carry a stale one across.
    if (entry === 'hearth.token' || entry === 'ember.token') continue;
    move(path.join(input.from, entry), path.join(input.to, entry));
  }
  try {
    if (io.readdirSync(input.from).length === 0) io.rmdirSync(input.from);
  } catch {
    // Leaving an empty directory behind is harmless.
  }
  return moved;
};

