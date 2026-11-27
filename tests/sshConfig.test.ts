import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSshConfigHosts, isValidSshTarget } from '../electron/sshConfig';

describe('SSH config passive discovery', () => {
  test('parses concrete hosts, Includes, quotes, comments, and first-match-wins while skipping wildcards and Match blocks', () => {
    const home = mkdtempSync(join(tmpdir(), 'ember-ssh-cfg-'));
    try {
      const sshDir = join(home, '.ssh');
      const confD = join(sshDir, 'config.d');
      mkdirSync(confD, { recursive: true });

      writeFileSync(
        join(sshDir, 'config'),
        [
          '# Top-level comment',
          'Include config.d/*.conf',
          'Include config # cycle back to self must not loop',
          '',
          'Host *',
          '  ServerAliveInterval 60',
          '',
          'Host build-box !build-box-bad *.internal',
          '  HostName 10.0.0.42 # inline comment',
          '  User alice',
          '  Port=2222',
          '  ProxyJump bastion',
          '',
          'Host build-box',
          '  User should-not-override-first-match',
          '  Port 9999',
          '',
          'Match host match-only',
          '  User ignored',
        ].join('\n')
      );

      writeFileSync(
        join(confD, '01-prod.conf'),
        [
          'Host "gpu-box" studio',
          '  HostName gpu.example.internal',
          '  User em',
          '  ProxyJump none',
        ].join('\n')
      );

      const hosts = discoverSshConfigHosts({ homeDir: home });
      expect(hosts).toEqual([
        { alias: 'gpu-box', hostName: 'gpu.example.internal', user: 'em', source: 'ssh-config' },
        { alias: 'studio', hostName: 'gpu.example.internal', user: 'em', source: 'ssh-config' },
        {
          alias: 'build-box',
          hostName: '10.0.0.42',
          user: 'alice',
          port: 2222,
          proxyJump: 'bastion',
          source: 'ssh-config',
        },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns empty list cleanly when ~/.ssh/config does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'ember-ssh-empty-'));
    try {
      expect(discoverSshConfigHosts({ homeDir: home })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('isValidSshTarget rejects option injection and shell metacharacters', () => {
    expect(isValidSshTarget('heliograph')).toBe(true);
    expect(isValidSshTarget('em@100.66.91.124')).toBe(true);
    expect(isValidSshTarget('alice@build-01.example.com')).toBe(true);

    expect(isValidSshTarget('')).toBe(false);
    expect(isValidSshTarget('-oProxyCommand=evil')).toBe(false);
    expect(isValidSshTarget('host;rm -rf /')).toBe(false);
    expect(isValidSshTarget('host$(whoami)')).toBe(false);
    expect(isValidSshTarget('host with space')).toBe(false);
    expect(isValidSshTarget('host\nnewline')).toBe(false);
  });
});
