import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { PiEndpoint, SshEndpointConfig } from './transport';

export type SshTunnelState = 'connecting' | 'connected' | 'disconnected' | 'error';

export type SshTunnelStatus = {
  endpointId: string;
  target: string;
  lifetime: SshEndpointConfig['lifetime'];
  state: SshTunnelState;
  localPort: number;
  remotePort: number;
  detail?: string;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Allocate an available ephemeral loopback port on 127.0.0.1. */
export const allocateFreeLoopbackPort = (preferredPort?: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const tryBind = (port: number, fallbackToRandom: boolean) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => {
        if (fallbackToRandom && port !== 0) {
          tryBind(0, false);
        } else {
          reject(new Error('Could not allocate a local loopback port for the SSH tunnel'));
        }
      });
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        server.close(() => {
          if (chosen > 0) resolve(chosen);
          else reject(new Error('Could not resolve allocated loopback port'));
        });
      });
    };
    const initial =
      preferredPort && Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
        ? preferredPort
        : 0;
    tryBind(initial, true);
  });

/** Probe whether a local loopback port is accepting TCP connections. */
const canConnectLoopback = (port: number, timeoutMs = 400): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

/**
 * Build the `ssh` argument vector for a loopback-only tunnel.
 * - `service`: `-N` pure port-forward (leaving the persistent remote service untouched on exit).
 * - `ephemeral`: runs `tinder serve --bind 127.0.0.1` scoped to stdin EOF so closing the tunnel
 *   cleanly terminates the ephemeral remote Kiln.
 */
export const buildSshTunnelArgs = (localPort: number, ssh: SshEndpointConfig): string[] => {
  const base = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${ssh.remotePort}`,
  ];
  if (ssh.lifetime === 'service') {
    return ['-N', ...base, '--', ssh.target];
  }
  const binary = ssh.binaryPath || '$HOME/.local/bin/tinder';
  const binExpr = binary.startsWith('$HOME/') ? `"$HOME/${binary.slice('$HOME/'.length)}"` : shellQuote(binary);
  const homeFlag = ssh.remoteHome ? ` --home ${shellQuote(ssh.remoteHome)}` : '';
  const remoteCmd = [
    'sh -c',
    shellQuote(
      `trap 'kill "$pid" 2>/dev/null || true' HUP TERM INT EXIT; ${binExpr} serve --bind 127.0.0.1 --port ${ssh.remotePort}${homeFlag} </dev/null >/dev/null 2>&1 & pid=$!; while IFS= read -r _; do :; done; kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true`
    ),
  ].join(' ');
  return [...base, '--', ssh.target, remoteCmd];
};

type TunnelEntry = {
  endpointId: string;
  configKey: string;
  ssh: SshEndpointConfig;
  localPort: number;
  state: SshTunnelState;
  detail?: string;
  child: ChildProcess | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  stopped: boolean;
  readyWaiters: Array<(ok: boolean) => void>;
};

export type SshTunnelManagerOptions = {
  spawnProcess?: (command: string, args: readonly string[]) => ChildProcess;
  allocatePort?: (preferred?: number) => Promise<number>;
  probePort?: (port: number) => Promise<boolean>;
  onStatusChange?: (status: SshTunnelStatus) => void;
  retryBaseMs?: number;
};

const sshConfigKey = (ssh: SshEndpointConfig, url: string): string =>
  JSON.stringify([ssh.target, ssh.remotePort, ssh.lifetime, ssh.remoteHome ?? '', ssh.binaryPath ?? '', url]);

const preferredPortOf = (url: string): number | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return undefined;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
};

export class SshTunnelManager {
  private readonly entries = new Map<string, TunnelEntry>();
  private readonly spawnProcess: (command: string, args: readonly string[]) => ChildProcess;
  private readonly allocatePort: (preferred?: number) => Promise<number>;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly onStatusChange?: (status: SshTunnelStatus) => void;
  private readonly retryBaseMs: number;
  private disposed = false;

  constructor(options: SshTunnelManagerOptions = {}) {
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args) =>
        spawn(command, [...args], {
          stdio: ['pipe', 'ignore', 'pipe'],
        }));
    this.allocatePort = options.allocatePort ?? allocateFreeLoopbackPort;
    this.probePort = options.probePort ?? ((port) => canConnectLoopback(port));
    this.onStatusChange = options.onStatusChange;
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
  }

  /** Reconcile active SSH tunnels against the current configured endpoint list. */
  sync(endpoints: readonly PiEndpoint[]): void {
    if (this.disposed) return;
    const desired = new Map<string, PiEndpoint>();
    for (const endpoint of endpoints) {
      if (endpoint.ssh) desired.set(endpoint.id, endpoint);
    }

    for (const [id, entry] of this.entries) {
      const next = desired.get(id);
      if (!next || !next.ssh || sshConfigKey(next.ssh, next.url) !== entry.configKey) {
        this.teardownEntry(entry);
        this.entries.delete(id);
      }
    }

    for (const [id, endpoint] of desired) {
      if (this.entries.has(id) || !endpoint.ssh) continue;
      const preferred = preferredPortOf(endpoint.url) ?? 0;
      const entry: TunnelEntry = {
        endpointId: id,
        configKey: sshConfigKey(endpoint.ssh, endpoint.url),
        ssh: endpoint.ssh,
        localPort: preferred,
        state: 'connecting',
        child: null,
        retryTimer: null,
        retryAttempt: 0,
        stopped: false,
        readyWaiters: [],
      };
      this.entries.set(id, entry);
      void this.launchEntry(entry, preferred);
    }
  }

  /** Start (or reuse) a tunnel for one SSH endpoint and wait briefly for loopback readiness. */
  async ensureStarted(endpoint: PiEndpoint, timeoutMs = 8_000): Promise<boolean> {
    if (!endpoint.ssh || this.disposed) return false;
    this.sync([...this.currentEndpointsWith(endpoint)]);
    const entry = this.entries.get(endpoint.id);
    if (!entry) return false;
    if (entry.state === 'connected') return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(entry.state === 'connected'), timeoutMs);
      entry.readyWaiters.push(finish);
    });
  }

  /** Rewrite SSH endpoint URLs to each tunnel's live local loopback port. */
  effectiveEndpoints(endpoints: readonly PiEndpoint[]): PiEndpoint[] {
    return endpoints.map((endpoint) => {
      if (!endpoint.ssh) return endpoint;
      const entry = this.entries.get(endpoint.id);
      if (!entry || entry.localPort <= 0) return endpoint;
      const liveUrl = `http://127.0.0.1:${entry.localPort}/`;
      return endpoint.url === liveUrl ? endpoint : { ...endpoint, url: liveUrl };
    });
  }

  /** Bounce all active SSH tunnels immediately (e.g. on system wake from sleep). */
  restartAll(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (entry.stopped) continue;
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }
      entry.retryAttempt = 0;
      const oldChild = entry.child;
      entry.child = null;
      if (oldChild) {
        try {
          oldChild.stdin?.end();
          oldChild.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      void this.launchEntry(entry, entry.localPort);
    }
  }

  statusSnapshot(): Record<string, SshTunnelStatus> {
    const out: Record<string, SshTunnelStatus> = {};
    for (const [id, entry] of this.entries) {
      out[id] = this.snapshotOf(entry);
    }
    return out;
  }

  /** Stop all local SSH tunnel processes cleanly (never stops persistent remote services). */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.teardownEntry(entry);
    }
    this.entries.clear();
  }

  private currentEndpointsWith(endpoint: PiEndpoint): PiEndpoint[] {
    const list: PiEndpoint[] = [];
    for (const entry of this.entries.values()) {
      if (entry.endpointId === endpoint.id) continue;
      list.push({
        id: entry.endpointId,
        label: entry.ssh.target,
        url: `http://127.0.0.1:${entry.localPort || 3002}/`,
        token: 'x',
        ssh: entry.ssh,
      });
    }
    list.push(endpoint);
    return list;
  }

  private snapshotOf(entry: TunnelEntry): SshTunnelStatus {
    return {
      endpointId: entry.endpointId,
      target: entry.ssh.target,
      lifetime: entry.ssh.lifetime,
      state: entry.state,
      localPort: entry.localPort,
      remotePort: entry.ssh.remotePort,
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
  }

  private emit(entry: TunnelEntry): void {
    this.onStatusChange?.(this.snapshotOf(entry));
  }

  private resolveWaiters(entry: TunnelEntry, ok: boolean): void {
    const waiters = entry.readyWaiters.splice(0, entry.readyWaiters.length);
    for (const waiter of waiters) waiter(ok);
  }

  private teardownEntry(entry: TunnelEntry): void {
    entry.stopped = true;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    const child = entry.child;
    entry.child = null;
    if (child) {
      try {
        child.stdin?.end();
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    entry.state = 'disconnected';
    this.resolveWaiters(entry, false);
  }

  private async launchEntry(entry: TunnelEntry, preferredPort: number): Promise<void> {
    if (entry.stopped || this.disposed) return;
    let port: number;
    try {
      port = await this.allocatePort(preferredPort > 0 ? preferredPort : undefined);
    } catch (error) {
      entry.state = 'error';
      entry.detail = error instanceof Error ? error.message : 'Could not allocate a local port';
      this.emit(entry);
      this.resolveWaiters(entry, false);
      this.scheduleRetry(entry);
      return;
    }
    if (entry.stopped || this.disposed) return;
    entry.localPort = port;
    entry.state = 'connecting';
    entry.detail = undefined;
    this.emit(entry);

    const args = buildSshTunnelArgs(port, entry.ssh);
    let child: ChildProcess;
    try {
      child = this.spawnProcess('ssh', args);
    } catch (error) {
      entry.state = 'error';
      entry.detail = error instanceof Error ? error.message : 'Could not start ssh';
      this.emit(entry);
      this.resolveWaiters(entry, false);
      this.scheduleRetry(entry);
      return;
    }
    entry.child = child;
    let stderrText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrText.length < 2048) stderrText += chunk.toString('utf8');
    });

    // Poll local loopback port briefly until the tunnel forward begins accepting connections.
    const pollReady = async () => {
      const deadline = Date.now() + 8_000;
      while (!entry.stopped && !this.disposed && entry.child === child && Date.now() < deadline) {
        const up = await this.probePort(port);
        if (entry.stopped || this.disposed || entry.child !== child) return;
        if (up) {
          entry.state = 'connected';
          entry.retryAttempt = 0;
          entry.detail = undefined;
          this.emit(entry);
          this.resolveWaiters(entry, true);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };
    void pollReady();

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (entry.child !== child || entry.stopped || this.disposed) return;
      entry.child = null;
      entry.state = 'error';
      entry.detail =
        error.code === 'ENOENT'
          ? 'OpenSSH client not found on this computer'
          : error.message;
      this.emit(entry);
      this.resolveWaiters(entry, false);
      this.scheduleRetry(entry);
    });

    child.once('close', (code) => {
      if (entry.child !== child || entry.stopped || this.disposed) return;
      entry.child = null;
      entry.state = code === 0 ? 'disconnected' : 'error';
      const cleaned = stderrText.trim().split(/\r?\n/).at(-1)?.trim();
      entry.detail = cleaned || `SSH tunnel to ${entry.ssh.target} closed`;
      this.emit(entry);
      this.resolveWaiters(entry, false);
      this.scheduleRetry(entry);
    });
  }

  private scheduleRetry(entry: TunnelEntry): void {
    if (entry.stopped || this.disposed || entry.retryTimer) return;
    const delay = Math.min(30_000, this.retryBaseMs * Math.pow(2, entry.retryAttempt));
    entry.retryAttempt = Math.min(entry.retryAttempt + 1, 5);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void this.launchEntry(entry, entry.localPort);
    }, delay);
    entry.retryTimer.unref?.();
  }
}
