import { describe, expect, test } from 'bun:test';
import { hasDangerousCommandFlags, hasUnquotedRedirection, permissionArgv } from '../packages/kiln/src/permissionRules';
import { approvalCommand, loadPermissionRules, permissionRuleError, previewPermissionRule, revokePermissionRule, savePermissionRule, type PermissionPolicy } from '../src/lib/permissionRules';
import type { PermissionRequest } from '../src/types';

const approval: PermissionRequest = { id: '12:approval/key', sessionId: '12', instanceId: 'pi:test', permission: 'bash', metadata: { arguments: { command: 'pwd' } }, patterns: [] };
const policy: PermissionPolicy = { kind: 'exact-argv-v1', maxTimeoutSeconds: 30, argv: ['pwd', '-P'], cwd: '/real/project', executable: '/usr/bin/pwd', environment: 'clean-v1' };

describe('remembered permission rule API', () => {
  test('sends only the reviewed exact command, preserving the host policy', async () => {
    const calls: Array<{ path: string; init: unknown }> = [];
    const previous = globalThis.window;
    globalThis.window = { ember: { piRequest: async (_id: string, path: string, init: unknown) => {
      calls.push({ path, init });
      return { ok: true, status: 200, data: path.endsWith('/preview') ? { supported: true, reason: 'Exact command', policy } : path.endsWith('/permission-rules') && (init as { method: string }).method === 'GET' ? { rules: [] } : { ok: true } };
    } } } as unknown as Window & typeof globalThis;
    try {
      expect(approvalCommand(approval)).toBe('pwd');
      const preview = await previewPermissionRule(approval, 'pwd -P');
      expect(preview.policy).toEqual(policy);
      await savePermissionRule(approval, 'pwd -P');
      await loadPermissionRules('pi:test', '12');
      await revokePermissionRule('pi:test', '12', 'rule/key');
      await revokePermissionRule('pi:test', '12');
      expect(calls).toEqual([
        { path: '/approvals/12/approval%2Fkey/preview', init: { method: 'POST', body: { command: 'pwd -P' } } },
        { path: '/approvals/12/approval%2Fkey/reply', init: { method: 'POST', body: { decision: 'similar', command: 'pwd -P' } } },
        { path: '/conversations/12/permission-rules', init: { method: 'GET', body: undefined } },
        { path: '/conversations/12/permission-rules/rule%2Fkey', init: { method: 'DELETE', body: undefined } },
        { path: '/conversations/12/permission-rules', init: { method: 'DELETE', body: undefined } },
      ]);
    } finally { globalThis.window = previous; }
  });
  test('mutation acknowledgements must explicitly confirm success', async () => {
    const previous = globalThis.window;
    let data: unknown;
    globalThis.window = { ember: { piRequest: async () => ({ ok: true, status: 200, data }) } } as unknown as Window & typeof globalThis;
    try {
      for (const payload of [{ ok: false }, {}, undefined, null]) {
        data = payload;
        await expect(savePermissionRule(approval, 'pwd -P')).rejects.toThrow(/Kiln.*Try again/);
        await expect(revokePermissionRule('pi:test', '12', 'rule')).rejects.toThrow(/Kiln.*Try again/);
        await expect(revokePermissionRule('pi:test', '12')).rejects.toThrow(/Kiln.*Try again/);
      }
    } finally { globalThis.window = previous; }
  });
  test('malformed policies and interrupted connections fail closed', async () => {
    const previous = globalThis.window;
    let data: unknown = { supported: true, reason: 'unsupported policy shape', policy: { kind: 'prefix' } };
    let interrupted = false;
    globalThis.window = { ember: { piRequest: async () => {
      if (interrupted) throw new Error('fetch failed');
      return { ok: true, status: 200, data };
    } } } as unknown as Window & typeof globalThis;
    try {
      await expect(previewPermissionRule(approval)).rejects.toThrow(/Kiln.*Try again/);
      data = { rules: [{ id: 'malformed' }] };
      await expect(loadPermissionRules('pi:test', '12')).rejects.toThrow(/Kiln.*Try again/);
      interrupted = true;
      await expect(savePermissionRule(approval, 'pwd')).rejects.toThrow(/Kiln.*Try again/);
    } finally { globalThis.window = previous; }
  });
  test('old hosts fail closed with an actor and recovery, never a dead-end code', async () => {
    const previous = globalThis.window;
    globalThis.window = { ember: { piRequest: async () => ({ ok: false, status: 404, data: {} }) } } as unknown as Window & typeof globalThis;
    try { await expect(previewPermissionRule(approval)).rejects.toThrow(/Kiln.*Allow once/); }
    finally { globalThis.window = previous; }
    for (const status of [0, 400, 404, 409, 500, 501]) {
      const copy = permissionRuleError(status);
      expect(copy).toMatch(/Kiln/);
      expect(copy).toMatch(/Allow once|Try again/);
      expect(copy).not.toMatch(/HTTP|undefined|null|stack|!/);
    }
  });
});

describe('Kiln bash permission rule matcher hardening', () => {
  test('rejects unquoted < and > redirections and unclosed quotes so redirects never auto-match allow rules', () => {
    const redirectedCommands = [
      'echo x > ~/.bashrc',
      'echo x >> ~/.bashrc',
      'git diff > patch.diff',
      'git diff > /tmp/out',
      'ls -la > listing.txt',
      'ls -la 2> errors.txt',
      'ls -la &> all.txt',
      'wc -l < README.md',
      'pwd > out',
      'pwd < in',
      'cat <<EOF',
      'ls "unclosed > out',
      "ls 'unclosed < in",
      'ls trailing\\',
    ];
    for (const command of redirectedCommands) {
      expect(hasUnquotedRedirection(command)).toBe(true);
      expect(permissionArgv(command)).toBeUndefined();
    }

    // Quoted angle brackets are not unquoted redirections in `hasUnquotedRedirection`,
    // while `permissionArgv` still refuses quotes under exact-argv-v1.
    expect(hasUnquotedRedirection('echo "a > b"')).toBe(false);
    expect(hasUnquotedRedirection("echo 'a < b'")).toBe(false);
    expect(permissionArgv('echo "a > b"')).toBeUndefined();
    expect(permissionArgv("echo 'a < b'")).toBeUndefined();
  });

  test('refuses dangerous wrapper binaries and execution/overwrite flags across find, git, tar, sed, and awk', () => {
    const dangerousArgvs: string[][] = [
      // Command wrappers
      ['env', 'ls'],
      ['sudo', 'ls'],
      ['nohup', 'pwd'],
      ['timeout', '5', 'ls'],
      ['xargs', 'rm'],
      ['bash', '-c', 'id'],
      ['sh', '-c', 'id'],
      ['/usr/bin/env', 'pwd'],

      // find execution / deletion / file-write flags
      ['find', '.', '-exec', 'sh', '-c', 'id', ';'],
      ['find', '.', '-execdir', 'id', ';'],
      ['find', '.', '-ok', 'rm', '{}', ';'],
      ['find', '.', '-okdir', 'rm', '{}', ';'],
      ['find', '.', '-delete'],
      ['find', '.', '-fprint', '/tmp/out'],
      ['find', '.', '-fprint0', '/tmp/out'],
      ['find', '.', '-fprintf', '/tmp/out', '%p'],
      ['find', '.', '-fls', '/tmp/out'],

      // git config / exec / pack / output flags (both separate and =value / attached forms)
      ['git', '-c', 'core.fsmonitor=evil', 'status'],
      ['git', '-ccore.sshCommand=evil', 'fetch'],
      ['git', '--config-env', 'core.sshCommand=EVIL', 'status'],
      ['git', '--config-env=core.sshCommand=EVIL', 'status'],
      ['git', '--exec-path', '/tmp/evil', 'status'],
      ['git', '--exec-path=/tmp/evil', 'status'],
      ['git', 'fetch', '--upload-pack', '/tmp/evil'],
      ['git', 'fetch', '--upload-pack=/tmp/evil'],
      ['git', 'push', '--receive-pack', '/tmp/evil'],
      ['git', 'push', '--receive-pack=/tmp/evil'],
      ['git', 'diff', '--output', '/tmp/overwritten'],
      ['git', 'diff', '--output=/tmp/overwritten'],
      ['/usr/bin/git', '-c', 'alias.st=!id', 'st'],

      // tar execution / compressor flags
      ['tar', '-xf', 'archive.tar', '--checkpoint-action=exec=sh evil.sh'],
      ['tar', '-xf', 'archive.tar', '--checkpoint-action', 'exec=id'],
      ['tar', '-xf', 'archive.tar', '--to-command=sh'],
      ['tar', '-xf', 'archive.tar', '--to-command', 'sh'],
      ['tar', '-cf', 'archive.tar', '--use-compress-program=sh', 'src'],
      ['tar', '-cf', 'archive.tar', '--use-compress-program', 'sh', 'src'],
      ['tar', '-I', 'sh', '-cf', 'archive.tar', 'src'],
      ['tar', '-Ish', '-cf', 'archive.tar', 'src'],

      // sed / awk in-place write flags
      ['sed', '-i', 's/a/b/', 'file.txt'],
      ['sed', '-i.bak', 's/a/b/', 'file.txt'],
      ['sed', '-ni', 's/a/b/p', 'file.txt'],
      ['sed', '-Ei', 's/a/b/', 'file.txt'],
      ['sed', '--in-place', 's/a/b/', 'file.txt'],
      ['sed', '--in-place=.bak', 's/a/b/', 'file.txt'],
      ['awk', '-i', 'inplace', '{ print }', 'file.txt'],
      ['gawk', '-iinplace', '{ print }', 'file.txt'],
      ['gawk', '--in-place', '{ print }', 'file.txt'],
      ['gawk', '--include=evil.awk', '{ print }', 'file.txt'],
    ];

    for (const argv of dangerousArgvs) {
      expect(hasDangerousCommandFlags(argv)).toBe(true);
      expect(permissionArgv(argv.join(' '))).toBeUndefined();
    }
  });

  test('preserves safe exact-argv-v1 read-only commands without false positives', () => {
    for (const command of ['pwd', 'pwd -P', 'ls', 'ls -la src', 'wc -l README.md', 'wc -c package.json']) {
      const argv = command.split(' ');
      expect(hasUnquotedRedirection(command)).toBe(false);
      expect(hasDangerousCommandFlags(argv)).toBe(false);
      expect(permissionArgv(command)).toEqual(argv);
    }
    // Non-mutating invocations of sed/find/git/tar have no dangerous flags in the flag helper,
    // while exact-argv-v1 still keeps its narrow pwd/ls/wc allowlist.
    expect(hasDangerousCommandFlags(['sed', '-n', '1,20p', 'README.md'])).toBe(false);
    expect(hasDangerousCommandFlags(['sed', '-e', 's/input/output/', 'README.md'])).toBe(false);
    expect(hasDangerousCommandFlags(['find', 'src', '-name', '*.ts'])).toBe(false);
    expect(hasDangerousCommandFlags(['git', 'status'])).toBe(false);
    expect(hasDangerousCommandFlags(['tar', '-tf', 'archive.tar'])).toBe(false);
  });
});
