import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import console from 'node:console';

const kind = process.argv[2];
if ((kind !== 'kiln' && kind !== 'tinder') || process.argv.length !== 3) {
  throw new Error('Choose kiln or tinder to build. Only native builds are supported; the codemode check cannot be skipped.');
}
const directory = kind === 'kiln' ? 'build/harness' : 'release';
const entry = kind === 'kiln' ? 'packages/kiln/src/index.ts' : 'packages/kiln/src/tinder.ts';
const name = kind === 'kiln' ? 'kiln' : 'tinder-cli';
const binary = resolve(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
mkdirSync(directory, { recursive: true });
const result = spawnSync('bun', ['build', '--compile', entry, 'packages/kiln/src/codemode-worker.ts', '--outfile', binary], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0 || result.signal) {
  throw new Error(`${name} compilation failed. Fix the build before packaging.`);
}

// Native builds are not releasable until the actual executable runs QuickJS and its worker.
// Use an empty cwd and an allowlisted environment: no source-tree fallback or user credentials.
const folder = mkdtempSync(join(tmpdir(), 'ember-build-codemode-'));
try {
  const home = join(folder, 'unused-home');
  console.log(`Checking ${name}'s packaged codemode sandbox…`);
  const check = spawnSync(binary, ['--self-test-codemode'], {
    cwd: folder,
    env: { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, HEARTH_HOME: home, EMBER_HOME: home },
    stdio: 'inherit', timeout: 20_000, killSignal: 'SIGKILL',
  });
  if (check.error || check.signal || check.status !== 0) {
    rmSync(binary, { force: true });
    throw new Error(`${name}'s packaged codemode self-test failed; the unchecked executable was removed. Fix the sandbox and rebuild before packaging.`, { cause: check.error });
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
