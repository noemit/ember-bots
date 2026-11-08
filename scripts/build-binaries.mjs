import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import console from 'node:console';

/**
 * Build a standalone harness binary and prove its codemode sandbox actually runs.
 *
 * Windows packaging happens on a Linux host, so this script has to be able to produce a Windows
 * executable from here: `--target` names a Bun compile target and the output name follows it. The
 * self-test can no longer be "run the binary we just built" for a foreign target, so it runs through
 * Wine, and a missing Wine is a **failure** rather than a skip — an unverified sandbox is exactly the
 * regression the check exists to catch.
 */
const args = process.argv.slice(2);
const kind = args[0];
// Accepts `--target value` and `--target=value`: npm scripts and humans write both.
const flag = (name) => {
  const prefix = name + '=';
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const target = flag('--target');
const outName = flag('--out');
if (kind !== 'kiln' && kind !== 'tinder') {
  throw new Error('Choose kiln or tinder to build. The codemode check cannot be skipped.');
}
// Nothing may be passed that this script does not act on: a flag it ignores is a flag someone
// believes changed the build (`--skip-self-test` was the original offender).
const consumed = new Set([kind, '--target', target, '--out', outName].filter((value) => value !== undefined));
const unknown = args.find((arg) => !consumed.has(arg) && !arg.startsWith('--target=') && !arg.startsWith('--out='));
if (unknown !== undefined) {
  throw new Error(`Unknown argument ${unknown}. Only --target and --out are supported, and the codemode self-test always runs.`);
}
const KNOWN_TARGETS = new Set(['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64']);
if (target !== undefined && !KNOWN_TARGETS.has(target)) throw new Error(`Unknown --target ${target}.`);

const directory = kind === 'kiln' ? 'build/harness' : 'release';
const entry = kind === 'kiln' ? 'packages/kiln/src/index.ts' : 'packages/kiln/src/tinder.ts';
const name = kind === 'kiln' ? 'kiln' : 'tinder-cli';
// The default name follows the *target*, not the host: packaging for Windows from Linux used to
// produce a Linux `kiln`, so the Windows build silently shipped with no bundled harness at all.
const windowsTarget = (target ?? '').includes('windows') || (target === undefined && process.platform === 'win32');
const binary = resolve(directory, outName ?? `${name}${windowsTarget ? '.exe' : ''}`);
mkdirSync(directory, { recursive: true });

const buildArgs = ['build', '--compile', entry, 'packages/kiln/src/codemode-worker.ts', '--outfile', binary];
if (target !== undefined) buildArgs.push(`--target=${target}`);
const result = spawnSync('bun', buildArgs, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0 || result.signal) {
  throw new Error(`${name} compilation failed. Fix the build before packaging.`);
}

/**
 * The self-test runs the real executable: QuickJS, its worker and a timeout must all work with no
 * checkout and no credentials nearby. A foreign-target binary is executed through Wine, which is how
 * this host can prove a Windows build at all.
 */
const runner = windowsTarget && process.platform !== 'win32' ? ['wine'] : [];
if (runner.length > 0 && spawnSync('wine', ['--version'], { stdio: 'ignore' }).status !== 0) {
  rmSync(binary, { force: true });
  throw new Error(
    `${name} is a Windows build but Wine is not installed, so its codemode sandbox cannot be verified. Install Wine or build on Windows; the unchecked executable was removed.`
  );
}

const folder = mkdtempSync(join(tmpdir(), 'ember-build-codemode-'));
try {
  const home = join(folder, 'unused-home');
  console.log(`Checking ${name}'s packaged codemode sandbox${runner.length ? ' under Wine' : ''}…`);
  const check = spawnSync(runner[0] ?? binary, [...runner.slice(1), ...(runner.length ? [binary] : []), '--self-test-codemode'], {
    cwd: folder,
    // Wine has to be resolvable, so PATH rides along when it is the runner, and the wrapper on this
    // host finds its real binary through HOME — so HOME stays real under Wine while the harness's own
    // state (HEARTH_HOME/EMBER_HOME/USERPROFILE) is the throwaway folder.
    env: runner.length
      ? { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, USERPROFILE: home, HEARTH_HOME: home, EMBER_HOME: home, WINEDEBUG: '-all' }
      : { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, HEARTH_HOME: home, EMBER_HOME: home },
    ...(runner.length ? {} : { WINEDEBUG: '-all' }),
    stdio: 'inherit',

    timeout: runner.length ? 120_000 : 20_000,
    killSignal: 'SIGKILL',
  });
  if (check.error || check.signal || check.status !== 0) {
    rmSync(binary, { force: true });
    throw new Error(`${name}'s packaged codemode self-test failed; the unchecked executable was removed. Fix the sandbox and rebuild before packaging.`, { cause: check.error });
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
