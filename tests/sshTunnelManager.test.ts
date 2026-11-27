import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { buildSshTunnelArgs, SshTunnelManager } from '../electron/sshTunnelManager';
import { parsePiEndpoints, redactRemoteSettings, type PiEndpoint } from '../electron/transport';

class FakeChild extends EventEmitter {
  killed = false;
  stdinEnded = false;
  stderr = new EventEmitter();
  stdin = {
    end: () => {
      this.stdinEnded = true;
    },
  };
  kill(): boolean {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

describe('SSH tunnel supervisor and endpoint schema', () => {
  test('buildSshTunnelArgs uses loopback-only -N forward for service mode and stdin-EOF serve wrapper for ephemeral mode', () => {
    const serviceArgs = buildSshTunnelArgs(43100, {
      target: 'tower',
      remotePort: 3002,
      lifetime: 'service',
    });
    expect(serviceArgs).toContain('-N');
    expect(serviceArgs).toContain('StrictHostKeyChecking=yes');
    expect(serviceArgs).toContain('BatchMode=yes');
    expect(serviceArgs).toContain('127.0.0.1:43100:127.0.0.1:3002');
    expect(serviceArgs.slice(-2)).toEqual(['--', 'tower']);

    const ephemeralArgs = buildSshTunnelArgs(43101, {
      target: 'dev-vm',
      remotePort: 3005,
      lifetime: 'ephemeral',
      binaryPath: '/home/em/.local/bin/tinder',
      remoteHome: '/home/em/.ember',
    });
    expect(ephemeralArgs).not.toContain('-N');
    expect(ephemeralArgs).toContain('127.0.0.1:43101:127.0.0.1:3005');
    const cmd = ephemeralArgs.at(-1)!;
    expect(cmd).toContain('/home/em/.local/bin/tinder');
    expect(cmd).toContain('--bind 127.0.0.1 --port 3005');
    expect(cmd).toContain('--home');
    expect(cmd).toContain('while IFS= read -r _');
  });

  test('SshTunnelManager syncs, rewrites live local URLs, bounces on restartAll, and disposes cleanly', async () => {
    const spawned: Array<{ args: readonly string[]; child: FakeChild }> = [];
    let nextPort = 44100;
    const manager = new SshTunnelManager({
      spawnProcess: (_cmd, args) => {
        const child = new FakeChild();
        spawned.push({ args, child });
        return child as unknown as ChildProcess;
      },
      allocatePort: async () => nextPort++,
      probePort: async () => true,
      retryBaseMs: 50,
    });

    const ep: PiEndpoint = {
      id: 'pi:ssh-tower',
      label: 'Tower',
      url: 'http://127.0.0.1:40000/',
      token: 'secret-token',
      ssh: { target: 'tower', remotePort: 3002, lifetime: 'service' },
    };

    const started = await manager.ensureStarted(ep, 2_000);
    expect(started).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(manager.effectiveEndpoints([ep])[0]!.url).toBe('http://127.0.0.1:44100/');
    expect(manager.statusSnapshot()['pi:ssh-tower']?.state).toBe('connected');

    manager.restartAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned[0]!.child.killed).toBe(true);
    expect(spawned.length).toBeGreaterThanOrEqual(2);

    manager.dispose();
    expect(spawned.at(-1)!.child.killed).toBe(true);
    expect(manager.statusSnapshot()).toEqual({});
  });

  test('parsePiEndpoints preserves valid ssh metadata, drops option-injected ssh targets, and redactRemoteSettings blanks token', () => {
    const parsed = parsePiEndpoints([
      {
        id: 'pi:ssh-ok',
        label: 'Tower',
        url: 'http://127.0.0.1:43100/',
        token: 'secret-token',
        ssh: { target: 'tower', remotePort: 3002, lifetime: 'service', binaryPath: '/home/em/.local/bin/tinder' },
      },
      {
        id: 'pi:ssh-bad',
        label: 'Bad',
        url: 'http://127.0.0.1:43101/',
        token: 'secret-token-2',
        ssh: { target: '-oProxyCommand=evil', remotePort: 3002, lifetime: 'service' },
      },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.ssh).toEqual({
      target: 'tower',
      remotePort: 3002,
      lifetime: 'service',
      binaryPath: '/home/em/.local/bin/tinder',
    });
    expect(parsed[1]!.ssh).toBeUndefined();

    const redacted = redactRemoteSettings({ piEndpoints: parsed });
    expect(redacted.piEndpoints[0]!.token).toBe('');
    expect(redacted.piEndpoints[0]!.hasToken).toBe(true);
    expect(redacted.piEndpoints[0]!.ssh?.target).toBe('tower');
  });
});
