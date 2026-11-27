import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSshKeyFingerprint,
  mapRemotePlatform,
  parseChecksumManifest,
  parseKeyscanOutput,
  probeSshHost,
  setupSshKiln,
  trustSshHostKeys,
  type CommandResult,
  type SshRunner,
} from '../electron/sshBootstrap';

const FAKE_KEY_BLOB = Buffer.from('fake-ssh-ed25519-public-key-bytes').toString('base64');
const FAKE_KEYSCAN_LINE = `10.0.0.42 ssh-ed25519 ${FAKE_KEY_BLOB}`;

const makeRunner = (
  execImpl: (file: string, args: readonly string[], options?: { timeoutMs?: number; input?: Buffer | string }) => Promise<CommandResult>,
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; bytes: Buffer }>
): SshRunner => ({
  exec: execImpl,
  fetchBytes:
    fetchImpl ??
    (async () => ({ ok: false, status: 404, bytes: Buffer.alloc(0) })),
});

describe('SSH bootstrap probe, host-key trust, and verified Tinder install', () => {
  test('mapRemotePlatform maps Linux x64 and macOS arm64 and rejects unsupported targets cleanly', () => {
    expect(mapRemotePlatform('Linux', 'x86_64')).toEqual({
      os: 'linux',
      arch: 'x64',
      supported: true,
      releaseAsset: 'tinder-linux-x64',
      checksumAsset: 'SHA256SUMS-linux.txt',
    });
    expect(mapRemotePlatform('Darwin', 'arm64')).toEqual({
      os: 'macos',
      arch: 'arm64',
      supported: true,
      releaseAsset: 'tinder-macos-arm64',
      checksumAsset: 'SHA256SUMS-macos.txt',
    });
    expect(mapRemotePlatform('Linux', 'aarch64').supported).toBe(false);
    expect(mapRemotePlatform('Darwin', 'x86_64').supported).toBe(false);
  });

  test('probeSshHost rejects option-injection targets without spawning ssh', async () => {
    let calls = 0;
    const runner = makeRunner(async () => {
      calls += 1;
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await probeSshHost('-oProxyCommand=id', runner);
    expect(result.outcome).toBe('invalid-target');
    expect(calls).toBe(0);
  });

  test('probeSshHost surfaces unknown host key fingerprints via ssh-keyscan without disabling StrictHostKeyChecking', async () => {
    const seenArgs: string[][] = [];
    const runner = makeRunner(async (file, args) => {
      seenArgs.push([file, ...args]);
      if (file === 'ssh' && args.includes('-G')) {
        return { code: 0, stdout: 'hostname 10.0.0.42\nport 2222\n', stderr: '' };
      }
      if (file === 'ssh') {
        return { code: 255, stdout: '', stderr: 'Host key verification failed.\r\n' };
      }
      if (file === 'ssh-keyscan') {
        return { code: 0, stdout: `# 10.0.0.42:2222\n${FAKE_KEYSCAN_LINE}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    });

    const result = await probeSshHost('build-box', runner);
    expect(result.outcome).toBe('host-key-unknown');
    if (result.outcome !== 'host-key-unknown') throw new Error('expected host-key-unknown');
    expect(result.hostName).toBe('10.0.0.42');
    expect(result.port).toBe(2222);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]!.fingerprint).toBe(computeSshKeyFingerprint(FAKE_KEY_BLOB));
    expect(seenArgs[0]).toContain('StrictHostKeyChecking=yes');
    expect(seenArgs[0]).toContain('BatchMode=yes');
    expect(seenArgs[0]).toContain('--');
    expect(result.message).toContain('build-box');
    expect(result.message).not.toContain('!');
  });

  test('probeSshHost guides interactive auth failures cleanly', async () => {
    const runner = makeRunner(async () => ({
      code: 255,
      stdout: '',
      stderr: 'em@tower: Permission denied (publickey,keyboard-interactive).',
    }));
    const result = await probeSshHost('tower', runner);
    expect(result.outcome).toBe('auth-required');
    if (result.outcome !== 'auth-required') throw new Error('expected auth-required');
    expect(result.unlockCommand).toBe('ssh-add && ssh tower');
    expect(result.message).toContain('tower');
    expect(result.message).not.toContain('!');
  });

  test('trustSshHostKeys writes deduplicated valid entries with 0600 and rejects arbitrary lines', () => {
    const home = mkdtempSync(join(tmpdir(), 'ember-known-hosts-'));
    try {
      const bad = trustSshHostKeys(['not a key; rm -rf /'], { homeDir: home });
      expect(bad.ok).toBe(false);

      const first = trustSshHostKeys([FAKE_KEYSCAN_LINE], { homeDir: home });
      expect(first).toEqual({ ok: true, added: 1 });
      const second = trustSshHostKeys([FAKE_KEYSCAN_LINE], { homeDir: home });
      expect(second).toEqual({ ok: true, added: 0 });

      const knownPath = join(home, '.ssh', 'known_hosts');
      expect(readFileSync(knownPath, 'utf8').trim()).toBe(FAKE_KEYSCAN_LINE);
      if (process.platform !== 'win32') {
        expect(statSync(knownPath).mode & 0o777).toBe(0o600);
      }
      expect(parseKeyscanOutput(`${FAKE_KEYSCAN_LINE}\n# comment\ninvalid line`)).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('setupSshKiln falls back to verified desktop download + SSH stdin streaming when remote download fails', async () => {
    const fakeBinary = Buffer.from('#!/bin/sh\necho tinder\n');
    const expectedSha = createHash('sha256').update(fakeBinary).digest('hex');
    const manifest = `${expectedSha}  tinder-linux-x64\n`;
    expect(parseChecksumManifest(manifest, 'tinder-linux-x64')).toBe(expectedSha);

    let streamedBytes: Buffer | null = null;
    const scriptsSeen: string[] = [];
    const runner = makeRunner(
      async (file, args, options) => {
        if (file !== 'ssh') return { code: 1, stdout: '', stderr: '' };
        const input = options?.input;
        if (typeof input === 'string') {
          scriptsSeen.push(input);
          // 1. Probe
          if (input.includes('uname -s')) {
            return {
              code: 0,
              stdout: 'OS=Linux\nARCH=x86_64\nHOME=/home/alice\nSVC=systemd-user\nBIN=\nKILN_HOME=\nHAS_TOKEN=0\nHEALTH=\n',
              stderr: '',
            };
          }
          // 2. Remote download fails (no GitHub access on remote)
          if (input.includes('SHA256SUMS.txt')) {
            return { code: 7, stdout: '', stderr: 'curl: could not resolve host' };
          }
          // 4. Service setup succeeds
          if (input.includes('setup --headless --service --bind 127.0.0.1')) {
            return { code: 0, stdout: 'ok', stderr: '' };
          }
          // 5. Read token over stdout
          if (input.includes('ember.token')) {
            return { code: 0, stdout: 'tok_verified_remote_123\n', stderr: '' };
          }
        }
        // 3. Streamed install via stdin Buffer
        if (Buffer.isBuffer(input) && args.includes('sh')) {
          streamedBytes = input;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected command' };
      },
      async (url) => {
        if (url.endsWith('SHA256SUMS-linux.txt')) {
          return { ok: true, status: 200, bytes: Buffer.from(manifest, 'utf8') };
        }
        if (url.endsWith('tinder-linux-x64')) {
          return { ok: true, status: 200, bytes: fakeBinary };
        }
        return { ok: false, status: 404, bytes: Buffer.alloc(0) };
      }
    );

    const res = await setupSshKiln(
      { target: 'build-box', label: 'Build Box', lifetime: 'service', mode: 'install' },
      { runner, allocateLocalPort: async () => 43123 }
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    expect(res.deliveryMethod).toBe('ssh-stream');
    expect(streamedBytes).toEqual(fakeBinary);
    expect(res.endpoint).toEqual({
      id: 'pi:ssh-build-box',
      label: 'Build Box',
      url: 'http://127.0.0.1:43123/',
      token: 'tok_verified_remote_123',
      ssh: {
        target: 'build-box',
        remotePort: 3002,
        lifetime: 'service',
        binaryPath: '/home/alice/.local/bin/tinder',
      },
    });
    expect(scriptsSeen.some((s) => s.includes('--bind 127.0.0.1'))).toBe(true);
  });

  test('setupSshKiln aborts with checksum-failed if desktop-downloaded binary does not match SHA256SUMS', async () => {
    let streamed = false;
    const runner = makeRunner(
      async (_file, _args, options) => {
        const input = options?.input;
        if (typeof input === 'string' && input.includes('uname -s')) {
          return {
            code: 0,
            stdout: 'OS=Linux\nARCH=x86_64\nHOME=/home/alice\nSVC=systemd-user\nBIN=\nKILN_HOME=\nHAS_TOKEN=0\nHEALTH=\n',
            stderr: '',
          };
        }
        if (typeof input === 'string' && input.includes('SHA256SUMS.txt')) {
          return { code: 7, stdout: '', stderr: 'offline' };
        }
        if (Buffer.isBuffer(input)) streamed = true;
        return { code: 0, stdout: '', stderr: '' };
      },
      async (url) => {
        if (url.endsWith('SHA256SUMS-linux.txt')) {
          return { ok: true, status: 200, bytes: Buffer.from(`${'a'.repeat(64)}  tinder-linux-x64\n`, 'utf8') };
        }
        return { ok: true, status: 200, bytes: Buffer.from('tampered-bytes') };
      }
    );

    const res = await setupSshKiln(
      { target: 'build-box', lifetime: 'service', mode: 'install' },
      { runner, allocateLocalPort: async () => 43124 }
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected checksum failure');
    expect(res.code).toBe('checksum-failed');
    expect(streamed).toBe(false);
  });

  test('setupSshKiln adopts an existing running Kiln without downloading or reinstalling', async () => {
    let downloadCalled = false;
    const runner = makeRunner(async (_file, _args, options) => {
      const input = options?.input;
      if (typeof input === 'string' && input.includes('uname -s')) {
        return {
          code: 0,
          stdout:
            'OS=Linux\nARCH=aarch64\nHOME=/home/pi\nSVC=systemd-user\nBIN=/home/pi/.local/bin/tinder\nKILN_HOME=/home/pi/.ember\nHAS_TOKEN=1\nHEALTH={"service":"hearth","version":"1.14.0"}\n',
          stderr: '',
        };
      }
      if (typeof input === 'string' && input.includes('SHA256SUMS.txt')) {
        downloadCalled = true;
      }
      if (typeof input === 'string' && input.includes('ember.token')) {
        return { code: 0, stdout: 'existing_tok_456\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const res = await setupSshKiln(
      { target: 'pi-box', lifetime: 'service', mode: 'adopt' },
      { runner, allocateLocalPort: async () => 43125 }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    expect(res.deliveryMethod).toBe('adopted');
    expect(downloadCalled).toBe(false);
    expect(res.endpoint.token).toBe('existing_tok_456');
    expect(res.endpoint.ssh?.remoteHome).toBe('/home/pi/.ember');
  });
});
