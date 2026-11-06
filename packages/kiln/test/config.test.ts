import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hearthBuild, hearthConfig, hearthVersion, kilnVersion } from '../src/config';

test('backups default next to the data home, and HEARTH_BACKUPS_DIR overrides', () => {
  const base = hearthConfig({ home: '/tmp/hearth-config-test' });
  expect(base.databasePath).toBe(join('/tmp/hearth-config-test', 'hearth.sqlite'));
  expect(base.tokenPath).toBe(join('/tmp/hearth-config-test', 'hearth.token'));
  // The old default was the container's /workspace/backups, which fails on the Mac/Windows.
  expect(base.backupsDir).toBe(join('/tmp/hearth-config-test', 'backups'));

  const previous = process.env.HEARTH_BACKUPS_DIR;
  const previousEmber = process.env.EMBER_BACKUPS_DIR;
  delete process.env.EMBER_BACKUPS_DIR;
  process.env.HEARTH_BACKUPS_DIR = '/workspace/backups';
  try {
    expect(hearthConfig({ home: '/tmp/hearth-config-test' }).backupsDir).toBe('/workspace/backups');
  } finally {
    if (previous === undefined) delete process.env.HEARTH_BACKUPS_DIR;
    else process.env.HEARTH_BACKUPS_DIR = previous;
    if (previousEmber === undefined) delete process.env.EMBER_BACKUPS_DIR;
    else process.env.EMBER_BACKUPS_DIR = previousEmber;
  }
});

test('an explicit port override wins over HEARTH_PORT', () => {
  expect(hearthConfig({ port: 3999 }).port).toBe(3999);
});

test('HEARTH_WORKSPACE overrides the default folder root', () => {
  const previous = process.env.HEARTH_WORKSPACE;
  const previousEmber = process.env.EMBER_WORKSPACE;
  delete process.env.EMBER_WORKSPACE;
  process.env.HEARTH_WORKSPACE = '/custom/workspace';
  try {
    expect(hearthConfig({ home: '/tmp/hearth-config-test' }).workspace).toBe('/custom/workspace');
  } finally {
    if (previous === undefined) delete process.env.HEARTH_WORKSPACE;
    else process.env.HEARTH_WORKSPACE = previous;
    if (previousEmber === undefined) delete process.env.EMBER_WORKSPACE;
    else process.env.EMBER_WORKSPACE = previousEmber;
  }
});

test('the default workspace trusts /workspace only on Linux', () => {
  // Both halves of the rule: the directory must exist *and* the platform must be Linux. Probing
  // existence alone made this test pass trivially on a Git Bash where /workspace resolves, while
  // the config it was checking correctly refused it — the config was right and the assertion was
  // wrong. Pin the platform for the check, as the win32 half below already does.
  //
  // The override has to be cleared for the same reason: this suite is run from agents' own shells,
  // where the host's `HEARTH_WORKSPACE` is inherited, and a set override is *supposed* to win over
  // the default. Leaving it in place tested the override path against the default's expectation.
  const previousWorkspace = process.env.HEARTH_WORKSPACE;
  const previousEmberWorkspace = process.env.EMBER_WORKSPACE;
  delete process.env.HEARTH_WORKSPACE;
  delete process.env.EMBER_WORKSPACE;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    if (existsSync('/workspace')) {
      expect(hearthConfig({ home: '/tmp/hearth-config-test' }).workspace).toBe('/workspace');
    }

    const home = homedir();
    const homeWorkspace = join(home, 'workspace');
    const expected = existsSync(homeWorkspace) ? homeWorkspace : home;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(hearthConfig({ home: '/tmp/hearth-config-test' }).workspace).toBe(expected);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (previousWorkspace !== undefined) process.env.HEARTH_WORKSPACE = previousWorkspace;
    if (previousEmberWorkspace !== undefined) process.env.EMBER_WORKSPACE = previousEmberWorkspace;
  }
});

test('hearthBuild reads .git/HEAD and refs directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-build-'));
  try {
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(hearthBuild(dir)).toBe('0123456');
    // Detached HEAD (raw SHA).
    writeFileSync(join(dir, '.git', 'HEAD'), 'abcdef0123456789abcdef0123456789abcdef01\n');
    expect(hearthBuild(dir)).toBe('abcdef0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hearthVersion reads package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-version-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(hearthVersion(dir)).toBe('1.2.3');
    expect(hearthVersion(join(dir, 'missing'))).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('desktop bind overrides the standalone network default', () => {
  const previous = process.env.HEARTH_BIND;
  const previousEmber = process.env.EMBER_BIND;
  try {
    delete process.env.HEARTH_BIND;
    delete process.env.EMBER_BIND;
    expect(hearthConfig().bind).toBe('0.0.0.0');
    process.env.HEARTH_BIND = '127.0.0.1';
    expect(hearthConfig().bind).toBe('127.0.0.1');
  } finally {
    if (previous === undefined) delete process.env.HEARTH_BIND; else process.env.HEARTH_BIND = previous;
    if (previousEmber === undefined) delete process.env.EMBER_BIND; else process.env.EMBER_BIND = previousEmber;
  }
});

test('the embedded version matches the Kiln package regardless of launch directory', async () => {
  const pkg = await import('../package.json');
  expect(kilnVersion).toBe(pkg.default.version);
  expect(kilnVersion).not.toBe('0.0.0');
});
