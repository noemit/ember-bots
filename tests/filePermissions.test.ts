import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../electron/activity';
import { appendCompactLog } from '../electron/compactLog';
import { ensureEmberDataDir, migrateLegacyDataDir } from '../electron/dataDir';
import { writeHarnessToken } from '../electron/localHarness';
import { ModelStatsStore } from '../electron/modelStats';
import { tightenPermissions, tightenPermissionsAsync } from '../electron/permissions';
import { appendAppIconLog, initializeFirstRunSettings, writePrivateJson } from '../electron/settingsFile';

const dirs: string[] = [];
const tempRoot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-perms-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const modeOf = (targetPath: string): number => fs.statSync(targetPath).mode & 0o777;

describe('Electron tightenPermissions helpers', () => {
  test('ignore ENOSYS, EPERM, EINVAL, ENOTSUP, EOPNOTSUPP, and ENOENT on exotic filesystems', async () => {
    for (const code of ['ENOSYS', 'EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOENT']) {
      const syncFail = () => {
        const err = new Error(`chmod failed: ${code}`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      };
      const asyncFail = async () => {
        const err = new Error(`chmod failed: ${code}`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      };
      expect(() => tightenPermissions('/exotic/path', 0o700, syncFail)).not.toThrow();
      await expect(tightenPermissionsAsync('/exotic/path', 0o600, asyncFail)).resolves.toBeUndefined();
    }
  });

  test('rethrow unexpected I/O errors', async () => {
    const syncFail = () => {
      const err = new Error('disk failure') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    };
    const asyncFail = async () => {
      const err = new Error('disk failure') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    };
    expect(() => tightenPermissions('/broken', 0o700, syncFail)).toThrow('disk failure');
    await expect(tightenPermissionsAsync('/broken', 0o600, asyncFail)).rejects.toThrow('disk failure');
  });
});

describe.skipIf(process.platform === 'win32')('POSIX directory (0o700) and file (0o600) enforcement in Electron', () => {
  test('ensureEmberDataDir and migrateLegacyDataDir enforce 0o700 on Ember data directories', () => {
    const root = tempRoot();
    const from = path.join(root, 'legacy');
    const to = path.join(root, 'ember');
    fs.mkdirSync(from, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(from, 'settings.json'), '{"theme":"stone"}');

    const previousUmask = process.umask(0o000);
    try {
      expect(migrateLegacyDataDir({ from, to })).toEqual(['settings.json']);
      expect(modeOf(to)).toBe(0o700);

      fs.chmodSync(to, 0o755);
      ensureEmberDataDir(to);
      expect(modeOf(to)).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  test('initializeFirstRunSettings and writePrivateJson enforce 0o700 directories and 0o600 settings files', async () => {
    const root = tempRoot();
    const settingsDir = path.join(root, 'first-run');
    const settingsFile = path.join(settingsDir, 'settings.json');
    const dbFile = path.join(settingsDir, 'hearth.sqlite');

    const previousUmask = process.umask(0o000);
    try {
      initializeFirstRunSettings(settingsFile, dbFile);
      expect(modeOf(settingsDir)).toBe(0o700);
      expect(modeOf(settingsFile)).toBe(0o600);

      // Tighten pre-existing permissive directory on subsequent atomic JSON saves.
      fs.chmodSync(settingsDir, 0o755);
      await writePrivateJson(settingsFile, { theme: 'stone', splitView: false });
      expect(modeOf(settingsDir)).toBe(0o700);
      expect(modeOf(settingsFile)).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test('appendAppIconLog enforces 0o700 directory, 0o600 log file, and rolling 8 KB cap', () => {
    const root = tempRoot();
    const userData = path.join(root, 'userData');
    fs.mkdirSync(userData, { recursive: true, mode: 0o755 });
    fs.chmodSync(userData, 0o755);
    const logFile = path.join(userData, 'app-icon.log');
    fs.writeFileSync(logFile, 'legacy-line\n', { mode: 0o644 });
    fs.chmodSync(logFile, 0o644);

    appendAppIconLog(logFile, '2026-11-18T00:00:00.000Z ok bytes=128');
    expect(modeOf(userData)).toBe(0o700);
    expect(modeOf(logFile)).toBe(0o600);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('legacy-line\n2026-11-18T00:00:00.000Z ok bytes=128\n');

    // Exceeding 8 KB rolls cleanly while preserving 0o600.
    fs.writeFileSync(logFile, `${'x'.repeat(8_100)}\n`, { mode: 0o644 });
    fs.chmodSync(logFile, 0o644);
    appendAppIconLog(logFile, 'fresh-entry');
    expect(modeOf(logFile)).toBe(0o600);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('fresh-entry\n');
  });

  test('compactLog, activityLog, modelStats, and writeHarnessToken enforce 0o700 dirs and 0o600 files', async () => {
    const root = tempRoot();
    const compactDir = path.join(root, 'compact');
    const compactFile = path.join(compactDir, 'ember-compact.log');
    appendCompactLog(compactFile, 'compacted session 1');
    expect(modeOf(compactDir)).toBe(0o700);
    expect(modeOf(compactFile)).toBe(0o600);

    const activityDir = path.join(root, 'activity');
    const activity = new ActivityLog(activityDir, { now: () => Date.UTC(2026, 10, 18, 12, 0, 0) });
    activity.append({ id: 'evt-1', at: Date.UTC(2026, 10, 18, 12, 0, 0), instanceId: 'local', type: 'session.idle', summary: 'Idle' });
    await activity.flush();
    expect(modeOf(activityDir)).toBe(0o700);
    const activityFiles = fs.readdirSync(activityDir);
    expect(activityFiles.length).toBe(1);
    expect(modeOf(path.join(activityDir, activityFiles[0]!))).toBe(0o600);

    const statsDir = path.join(root, 'stats');
    const statsFile = path.join(statsDir, 'model-stats.json');
    const stats = new ModelStatsStore(statsFile);
    await stats.clear();
    expect(modeOf(statsDir)).toBe(0o700);
    expect(modeOf(statsFile)).toBe(0o600);

    const harnessHome = path.join(root, 'harness');
    fs.mkdirSync(harnessHome, { recursive: true, mode: 0o755 });
    fs.chmodSync(harnessHome, 0o755);
    writeHarnessToken(harnessHome, 'apple-river-cloud-stone');
    expect(modeOf(harnessHome)).toBe(0o700);
    expect(modeOf(path.join(harnessHome, 'hearth.token'))).toBe(0o600);
    expect(modeOf(path.join(harnessHome, 'ember.token'))).toBe(0o600);
  });
});
