import { expect, test } from 'bun:test';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [script, artifact] of [['build:harness', 'build/harness/kiln'], ['dist:cli', 'release/tinder-cli']] as const) {
  test(`${script} embeds a working, timeout-isolated codemode sandbox`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'ember-codemode-'));
    const name = process.platform === 'win32' ? 'standalone.exe' : 'standalone';
    const binary = join(folder, name);
    try {
      const build = spawnSync(process.execPath, ['run', script], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
      });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      // The packaging command itself must execute the diagnostic, not merely compile it.
      expect(build.stdout).toContain('Codemode self-test passed: callback, worker timeout');
      expect(build.stdout).toContain('recovery.');
      await copyFile(resolve(artifact + (process.platform === 'win32' ? '.exe' : '')), binary);
      // Run only the copied production binary. No PATH, NODE_PATH, Bun options or credentials;
      // preserve Windows' system directory so its OS libraries remain discoverable.
      const home = join(folder, 'unused-home');
      const run = spawnSync(binary, ['--self-test-codemode'], {
        cwd: folder,
        env: { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, HEARTH_HOME: home, EMBER_HOME: home },
        encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain('Codemode self-test passed: callback, worker timeout');
      expect(run.stdout).toContain('recovery.');
      expect(await readdir(folder)).toEqual([name]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 150_000);
}
