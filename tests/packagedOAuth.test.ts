import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('compiled provider sign-in includes its OAuth modules without node_modules nearby', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ember-oauth-'));
  const binary = join(folder, process.platform === 'win32' ? 'oauth.exe' : 'oauth');
  try {
    const build = spawnSync(process.execPath, ['build', '--compile', resolve('packages/kiln/test/fixtures/compiledOAuth.ts'), '--outfile', binary], { encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync(binary, [], { cwd: folder, encoding: 'utf8', timeout: 20000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('credential persistence passed');
  } finally { await rm(folder, { recursive: true, force: true }); }
}, 60000);
