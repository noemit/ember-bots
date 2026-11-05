import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureHarnessToken,
  generateServiceConfig,
  parseArgs,
  runSetup,
  runStatus,
  runToken,
} from './cli/ember';

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-cli-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Tinder / Ember CLI', () => {
  test('ensureHarnessToken creates a 64-char hex token with mode 0600 and is idempotent on second run', () => {
    const home = path.join(makeTempDir(), '.ember');
    const first = ensureHarnessToken(home);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(first.tokenPath)).toBe(true);

    if (process.platform !== 'win32') {
      const mode = fs.statSync(first.tokenPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const second = ensureHarnessToken(home);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  test('setup --headless writes token and background service, includes URL & token, and omits desktop GUI steps', () => {
    const root = makeTempDir();
    const home = path.join(root, '.ember');
    const userHome = path.join(root, 'user');
    const workspace = path.join(root, 'workspace');

    const { flags } = parseArgs([
      'setup',
      '--headless',
      '--port',
      '3012',
      '--home',
      home,
      '--workspace',
      workspace,
      '--platform',
      'linux',
    ]);
    const result = runSetup(flags, { userHome, tailscaleIp: '100.64.0.1' });

    expect(result.tokenCreated).toBe(true);
    expect(result.localUrl).toBe('http://127.0.0.1:3012');
    expect(result.tailscaleUrl).toBe('http://100.64.0.1:3012');
    expect(result.servicePath).toBe(path.join(userHome, '.config', 'systemd', 'user', 'ember-kiln.service'));
    expect(fs.existsSync(result.servicePath!)).toBe(true);

    expect(result.output).toContain('http://127.0.0.1:3012');
    expect(result.output).toContain('http://100.64.0.1:3012');
    expect(result.output).toContain(result.token);
    expect(result.output).toContain('ember-kiln.service');
    expect(result.output).not.toContain('Ember Desktop GUI:');
    expect(result.output).not.toContain('bun run dev');
  });

  test('service-config generates systemd (linux), launchd plist (darwin), and PowerShell scheduled task (win32)', () => {
    const base = {
      homeDir: '/home/alex/.ember',
      port: 3002,
      workspaceDir: '/home/alex/workspace',
      harnessDir: '/home/alex/workspace/hearth',
    };

    const linuxUnit = generateServiceConfig({ ...base, platform: 'linux' });
    expect(linuxUnit).toContain('[Unit]');
    expect(linuxUnit).toContain('[Service]');
    expect(linuxUnit).toContain('Environment="EMBER_HOME=/home/alex/.ember"');
    expect(linuxUnit).toContain('Environment="PORT=3002"');
    expect(linuxUnit).toContain('WantedBy=default.target');

    const darwinPlist = generateServiceConfig({ ...base, platform: 'darwin' });
    expect(darwinPlist).toContain('<!DOCTYPE plist');
    expect(darwinPlist).toContain('<string>dev.ember.kiln</string>');
    expect(darwinPlist).toContain('<key>EMBER_HOME</key>');
    expect(darwinPlist).toContain('<key>RunAtLoad</key>');

    const winScript = generateServiceConfig({ ...base, platform: 'win32' });
    expect(winScript).toContain('New-ScheduledTaskAction');
    expect(winScript).toContain('Register-ScheduledTask');
    expect(winScript).toContain('$TaskName = "EmberKiln"');
  });

  test('token --json outputs machine-readable URLs and bearer token', () => {
    const home = path.join(makeTempDir(), '.ember');
    const { flags } = parseArgs(['token', '--home', home, '--port', '3005', '--json']);
    const res = runToken(flags, { tailscaleIp: '100.64.0.2' });
    const parsed = JSON.parse(res.output) as {
      localUrl: string;
      tailscaleUrl: string;
      token: string;
      tokenPath: string;
    };

    expect(parsed.localUrl).toBe('http://127.0.0.1:3005');
    expect(parsed.tailscaleUrl).toBe('http://100.64.0.2:3005');
    expect(parsed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.tokenPath).toBe(path.join(home, 'ember.token'));
  });

  test('status reports version, build, and conversation count when Kiln answers, and recovery copy when down', async () => {
    const home = path.join(makeTempDir(), '.ember');
    ensureHarnessToken(home);
    const { flags } = parseArgs(['status', '--home', home, '--port', '3002']);

    const healthy = await runStatus(flags, (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, version: '0.45.0', commit: 'abc1234' }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]), { status: 200 });
    }) as typeof fetch);

    expect(healthy.ok).toBe(true);
    expect(healthy.version).toBe('0.45.0');
    expect(healthy.commit).toBe('abc1234');
    expect(healthy.conversations).toBe(3);
    expect(healthy.output).toContain('Kiln is answering at http://127.0.0.1:3002');
    expect(healthy.output).toContain('Conversations:  3');

    const down = await runStatus(flags, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(down.ok).toBe(false);
    expect(down.output).toContain('Kiln did not answer at http://127.0.0.1:3002');
    expect(down.output).toContain('ember setup --service');
  });
});
