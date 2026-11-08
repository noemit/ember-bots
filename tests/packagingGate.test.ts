import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the real script with only its OS boundaries replaced. No production skip switch.
const script = readFileSync(resolve('scripts/build-binaries.mjs'), 'utf8').replace(/^import .*;\n/gm, '');
type Outcome = { status: number | null; signal?: string; error?: Error };
function run(kind: string, build: Outcome, check: Outcome, platform = 'linux', extra: string[] = []) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  let error: unknown;
  try {
    runInNewContext(script, {
      process: { argv: ['node', 'build-binaries.mjs', kind, ...extra], platform, env: { SECRET: 'must-not-inherit' } },
      mkdirSync() {}, mkdtempSync: () => '/isolated', tmpdir: () => '/tmp',
      rmSync: (path: string) => removed.push(path), join, resolve, console: { log() {} },
      spawnSync(command: string, args: string[], options: Record<string, unknown>) {
        calls.push({ command, args, options });
        return calls.length === 1 ? build : check;
      },
    });
  } catch (caught) { error = caught; }
  return { calls, removed, error };
}
const ok = { status: 0 };
for (const kind of ['kiln', 'tinder']) {
  for (const platform of ['linux', 'darwin', 'win32']) {
    test(`${kind} ${platform} checks the compiled artifact, isolated and bounded`, () => {
      const result = run(kind, ok, ok, platform);
      expect(result.error).toBeUndefined();
      expect(result.calls).toHaveLength(2);
      const [build, check] = result.calls;
      expect(build.args).toContain('packages/kiln/src/codemode-worker.ts');
      expect(check.command).toBe(build.args[build.args.indexOf('--outfile') + 1]);
      expect(check.command.endsWith('.exe')).toBe(platform === 'win32');
      expect(check.args).toEqual(['--self-test-codemode']);
      expect(check.options).toMatchObject({ cwd: '/isolated', timeout: 20_000, killSignal: 'SIGKILL' });
      expect(check.options.env).not.toHaveProperty('SECRET');
      expect(check.options.env).not.toHaveProperty('PATH');
      expect(result.removed).toEqual(['/isolated']);
    });
  }
  for (const failure of [
    { status: 1 }, { status: null }, { status: null, signal: 'SIGKILL' },
    { status: null, error: new Error('spawn failed') },
    { status: null, error: new Error('timed out') },
  ]) {
    test(`${kind} rejects failed compilation or self-test: ${JSON.stringify(failure)}`, () => {
      const buildFailure = run(kind, failure, ok);
      expect(buildFailure.error).toBeDefined();
      expect(buildFailure.calls).toHaveLength(1);
      const checkFailure = run(kind, ok, failure);
      expect(checkFailure.error).toBeDefined();
      expect(checkFailure.calls).toHaveLength(2);
      expect(checkFailure.removed).toEqual([checkFailure.calls[1].command, '/isolated']);
    });
  }
  test(`${kind} rejects any flag it does not act on, including a skip switch`, () => {
    for (const flag of ['--skip-self-test', '--no-verify']) {
      const result = run(kind, ok, ok, 'linux', [flag]);
      expect(result.error).toBeDefined();
      expect(result.calls).toHaveLength(0);
    }
    // A target it cannot build is refused before anything is spawned.
    const unknownTarget = run(kind, ok, ok, 'linux', ['--target=bun-plan9-x64']);
    expect(unknownTarget.error).toBeDefined();
    expect(unknownTarget.calls).toHaveLength(0);
  });

  test(`${kind} builds a named foreign target and verifies it through Wine`, () => {
    const result = run(kind, ok, ok, 'linux', ['--target=bun-windows-x64']);
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(3);
    const [build, wineProbe, check] = result.calls;
    expect(build.args).toContain('--target=bun-windows-x64');
    const binary = build.args[build.args.indexOf('--outfile') + 1];
    // The output name follows the target, not the host: a Windows package needs `kiln.exe`.
    expect(binary.endsWith('.exe')).toBe(true);
    expect(wineProbe.command).toBe('wine');
    expect(wineProbe.args).toEqual(['--version']);
    // Wine runs the real executable, so the sandbox is proven for the artifact being shipped.
    expect(check.command).toBe('wine');
    expect(check.args).toEqual([binary, '--self-test-codemode']);
    expect(check.options).toMatchObject({ timeout: 120_000, killSignal: 'SIGKILL' });
    expect(check.options.env).toHaveProperty('PATH');
    expect(check.options.env).not.toHaveProperty('SECRET');
  });
}
