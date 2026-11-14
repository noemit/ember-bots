import { execFile } from 'node:child_process';
import type { PiEndpoint } from './transport';
import { fileShareOwnerStore, parseShareOwner } from './kilnSharingOwner';
import { checkSharedKilnAuth } from './sharedKilnAuth';
import { isIP } from 'node:net';
export { isTailnetAddress } from './tailscaleLocalApi';
import { createLocalServeApi, LocalApiError, type AtomicServeApi, type ServeConfig, type ServeSnapshot } from './tailscaleLocalApi';

export type SharingReport = { ok: boolean; enabled: boolean; detail: string; url?: string; canChange: boolean; instructions?: string };
export type SharingCommand = (args: readonly string[]) => Promise<string>;
export type ShareOwner = { nodeId: string; target: string; etag: string; port?: number };
export type ShareOwnerStore = { read: () => ShareOwner | undefined | Promise<ShareOwner | undefined>; write: (owner: ShareOwner | undefined) => void | Promise<void> };
export const SHARE_PORT = 3002;
export function sharingTarget(localUrl: string): string {
  const url = new URL(localUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127'))) throw new Error('loopback');
  return (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + (url.port || '80');
}
const targetFor = (endpoint: PiEndpoint): string | null => { try { return sharingTarget(endpoint.url); } catch { return null; } };
const readOnlyCommands = new Set(['serve --help', 'serve status --json', 'status --json']);
/** No shell or CLI mutations. Writes use ownership-conditioned LocalAPI only. */
export const runTailscale: SharingCommand = async (args) => {
  if (!readOnlyCommands.has(args.join(' '))) throw new Error('Only read-only Tailscale inspection is available.');
  const invoke = (program: string): Promise<string> => new Promise((resolve, reject) => {
    execFile(program, [...args], { timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new LocalApiError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unsupported' : 'unavailable'));
      else resolve(stdout);
    });
  });
  try { return await invoke('tailscale'); }
  catch (error) {
    // Finder-launched apps often lack a CLI symlink/PATH entry. This is the official app's
    // CLI entry point, with exactly the same bounded read-only arguments, never a GUI launch.
    if (process.platform === 'darwin' && error instanceof LocalApiError && error.kind === 'unsupported') return invoke('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    throw error;
  }
};
const map = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function portOccupied(config: ServeConfig, port = SHARE_PORT): boolean {
  return Object.prototype.hasOwnProperty.call(map(config.TCP), String(port))
    || Object.keys(map(config.Web)).some(host => host.endsWith(`:${port}`))
    || Object.values(map(config.Foreground)).some(value => portOccupied(map(value), port))
    || Object.entries(map(config.AllowFunnel)).some(([host, enabled]) => enabled === true && host.endsWith(`:${port}`));
}
export function isLoopbackForward(config: ServeConfig, target: string, port = SHARE_PORT): boolean {
  const handler = map(map(config.TCP)[port]);
  const { TCP: _tcp, ...rest } = config;
  return Object.keys(handler).length === 1 && handler.TCPForward === target && !portOccupied(rest, port);
}
const withForward = (config: ServeConfig, target?: string, port = SHARE_PORT): ServeConfig => {
  const tcp = { ...map(config.TCP) };
  if (target) tcp[port] = { TCPForward: target };
  else delete tcp[port];
  return { ...config, TCP: tcp };
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value);
};
const sameConfig = (a: ServeConfig, b: ServeConfig): boolean => canonical(a) === canonical(b);
const owns = (owner: ShareOwner | undefined, snapshot: ServeSnapshot, nodeId: string, target: string, port = SHARE_PORT): boolean => Boolean(owner
  && (owner.port ?? SHARE_PORT) === port && owner.nodeId === nodeId && owner.target === target && owner.etag === snapshot.etag && isLoopbackForward(snapshot.config, target, port));

export function sharingErrorCopy(error: unknown, platform: NodeJS.Platform): string {
  if (error instanceof LocalApiError) {
    if (error.kind === 'conflict') return 'Tailscale changed while Ember was checking ownership. Ember did not overwrite that change or retry it. Select Check sharing to review the current configuration before trying again.';
    if (error.kind === 'permission') return 'Tailscale denied Ember access to its local configuration API. Ask this host’s administrator to grant the intended local Tailscale permissions, then select Check sharing. Ember will not elevate privileges or use an unsafe CLI fallback.';
    if (error.kind === 'unsupported') return platform === 'win32'
      ? 'Automatic sharing is unavailable on Windows: Ember has not verified Tailscale’s native named-pipe authentication in this runtime. Existing forwards are unchanged. Use the reviewed commands below on the host; Ember will not substitute unsafe CLI writes.'
      : platform === 'darwin'
        ? 'Ember could not verify this Tailscale installation’s local connection and safe-update support. Open or restart Tailscale on this Mac, then select Check sharing. Ambiguous or changed same-user proof files are refused; Ember will not use unsafe CLI writes.'
        : 'This Tailscale daemon did not provide the verified conditional-update contract. Update Tailscale or review its system socket setup, then select Check sharing. Ember will not write an unconditional configuration.';
    if (error.kind === 'timeout') return 'Tailscale’s local configuration API did not answer within eight seconds. Check Tailscale on this host, then select Check sharing. If a change was in flight, review its current status before retrying.';
    if (error.kind === 'invalid') return 'Tailscale returned an invalid or oversized local configuration. Check or update Tailscale, then select Check sharing. Ember will not replace a configuration it cannot verify.';
  }
  return 'Ember could not finish the Tailscale sharing operation. Check Tailscale and its standard system-daemon socket on this host, then select Check sharing. If a change was in flight, review its current status before retrying; Ember never resets other services.';
}

/** Both this queue and main’s lifecycle queue serialize app requests; If-Match guards external writers. */
export class KilnSharing {
  private operation: Promise<unknown> = Promise.resolve();
  constructor(private readonly dependencies: {
    command: SharingCommand;
    api: () => AtomicServeApi | Promise<AtomicServeApi>;
    owner: ShareOwnerStore;
    check: (endpoint: PiEndpoint) => Promise<{ ok: boolean }>;
    platform?: NodeJS.Platform;
    publicPort?: number;
  }) {}
  run(action: 'inspect' | 'enable' | 'disable', endpoint: PiEndpoint | null, owned: boolean): Promise<SharingReport> {
    const next = this.operation.catch(() => {}).then(() => this.perform(action, endpoint, owned));
    this.operation = next;
    return next;
  }
  private async perform(action: 'inspect' | 'enable' | 'disable', endpoint: PiEndpoint | null, owned: boolean): Promise<SharingReport> {
    const report = (detail: string, ok = false, enabled = false, url?: string, canChange = false, instructions?: string): SharingReport => ({ ok, enabled, detail, canChange, ...(url ? { url } : {}), ...(instructions ? { instructions } : {}) });
    if (!endpoint || !owned) return report('Ember does not own this Kiln process. Configure sharing on its host yourself; Ember will not change its listener, forward or lifetime. For standalone Tinder, keep its loopback listener and forward it with Tailscale Serve.');
    let target = targetFor(endpoint);
    if (!target) return report('This Kiln is not on the expected loopback listener. Check its host configuration before sharing; Ember has not changed it.');
    let port = this.dependencies.publicPort ?? SHARE_PORT;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return report('Ember needs a valid sharing port. Review this host’s sharing settings and check again.');
    const instructions = `tailscale serve status --json\n# Only after reviewing existing forwards:\ntailscale serve --bg --tcp=${port} ${target}\n# To remove that port’s forward after reviewing it again:\ntailscale serve --tcp=${port} off`;
    const { command, check, owner } = this.dependencies;
    let rollback: { api: AtomicServeApi; expected: ServeConfig; nodeId: string } | undefined;
    try {
      const api = await this.dependencies.api();
      const help = await command(['serve', '--help']);
      if (!help.includes('--bg') || !help.includes('--tcp') || !help.includes('status')) return report('This Tailscale CLI does not advertise the required persistent TCP Serve controls. Update Tailscale, then select Check sharing.', false, false, undefined, false, instructions);
      const status = await api.status();
      let snapshot = await api.read();
      const priorOwner = await owner.read();
      const recordedPort = priorOwner?.port ?? SHARE_PORT;
      const recordedOwned = priorOwner && owns(priorOwner, snapshot, status.nodeId, priorOwner.target, recordedPort);
      if (priorOwner && (priorOwner.target !== target || recordedPort !== port)) {
        if (!recordedOwned || action === 'enable') return report('Ember recorded a different local endpoint or sharing port. Turn off the verified existing forward first, or review Serve on this host; Ember will not create another forward and discard its old ownership record.', false, true, undefined, false, instructions);
        if (action === 'inspect') return report('The local Kiln endpoint or chosen sharing port changed. The previous forward still has a verified ownership receipt. Turn off remote Kiln access before enabling the new setup; no remote URL has been verified for it.', false, true, undefined, true, instructions);
        // Disable follows the exact recorded port/target, never the newly requested setup.
        target = priorOwner.target; port = recordedPort;
      }
      const ours = owns(priorOwner, snapshot, status.nodeId, target, port);
      const existing = portOccupied(snapshot.config, port);
      const unmanaged = existing && !ours;
      if (unmanaged && (action !== 'inspect' || !isLoopbackForward(snapshot.config, target, port))) return report('Tailscale already uses the sharing port, or its configuration changed since Ember created this forward. Ember cannot confirm ownership and left it untouched. Review Serve on this host before changing it; do not replace another service.', false, isLoopbackForward(snapshot.config, target, port), undefined, false, instructions);
      if (action === 'disable') {
        if (!ours) return report('Ember cannot confirm ownership of a forward to turn off. Existing networking is unchanged. Select Check sharing to review this host.', false, false, undefined, false, instructions);
        // Invalidate authority BEFORE submitting a removal. A lost response must not leave
        // an old receipt that could adopt a later matching/foreign configuration.
        await owner.write(undefined);
        await api.compareAndSwap(snapshot, withForward(snapshot.config, undefined, port));
        const after = await api.read();
        if (portOccupied(after.config, port)) return report('Ember removed its forward conditionally, but Tailscale now reports another setting on that port. Select Check sharing to review it; Ember will not remove the new setting.', false, true, undefined, false, instructions);
        return report('Kiln tailnet sharing is off. Ember removed only its owned forward; other Serve settings were preserved.', true, false, undefined, true, instructions);
      }
      if (action === 'inspect' && ours && !endpoint.token) return report('The included Kiln is stopped, but its owned tailnet forward remains configured. Turn off this forward below, or start the included Kiln and check sharing again. No remote URL has been verified while the backend is stopped.', false, true, undefined, true, instructions);
      if (!(await check(endpoint)).ok) return report('This computer’s Kiln did not accept an authenticated loopback check. Start or retry Kiln above, then select Check sharing.', false, existing, undefined, false, instructions);
      if (action === 'enable' && !ours) {
        const next = withForward(snapshot.config, target, port);
        // An earlier stale receipt must not accidentally match a new-but-unacknowledged write.
        await owner.write(undefined);
        await api.compareAndSwap(snapshot, next);
        rollback = { api, expected: next, nodeId: status.nodeId };
        snapshot = await api.read();
        const currentStatus = await api.status();
        if (currentStatus.nodeId !== status.nodeId || !sameConfig(snapshot.config, next)) throw new LocalApiError('conflict');
        await owner.write({ nodeId: status.nodeId, target, etag: snapshot.etag, ...(port !== SHARE_PORT ? { port } : {}) });
      }
      if (!isLoopbackForward(snapshot.config, target, port)) return report('Kiln accepted authentication on this computer. No tailnet forward is configured yet; Enable remote Kiln access will create one using a conditional update that preserves other Serve settings.', true, false, undefined, true, instructions);
      const address = isIP(status.ip) === 6 ? '[' + status.ip + ']' : status.ip;
      const url = 'http://' + address + ':' + port;
      const proxy = await check({ ...endpoint, url });
      if (!proxy.ok && rollback) throw new LocalApiError('unavailable');
      rollback = undefined;
      const ownershipNote = unmanaged ? ' Ember did not create or adopt this forward and cannot confirm ownership to turn it off.' : '';
      return report((proxy.ok
        ? 'Tailscale reports a persistent tailnet-only loopback forward, and this host accepted authentication through it. Test the copied URL from the other Ember computer to check its tailnet permissions.'
        : 'Tailscale reports the loopback forward and Kiln accepts local authentication, but this host could not verify the forwarded request. The displayed URL is a candidate, not verified reachable. Test from the other computer and check Tailscale permissions.') + ownershipNote, proxy.ok, true, url, owns(await owner.read(), snapshot, status.nodeId, target, port), instructions);
    } catch (error) {
      if (rollback) {
        try {
          const current = await rollback.api.read();
          const status = await rollback.api.status();
          if (status.nodeId === rollback.nodeId && sameConfig(current.config, rollback.expected)) {
            // Only subtract the newly created port from the current document; never restore a
            // whole earlier snapshot. A competing change makes If-Match fail, with no retry.
            await owner.write(undefined);
            await rollback.api.compareAndSwap(current, withForward(current.config, undefined, port));
            return report('Tailscale could not finish verifying sharing. Ember conditionally removed only the forward it just created. Other services were preserved. Check Tailscale on this host and try again.', false, false, undefined, false, instructions);
          }
        } catch { /* Ownership or outcome uncertain: leave configuration intact for human review. */ }
        return report('The forward may have been created, but Tailscale changed before Ember could finish verification or safely roll back. Ember did not overwrite the newer configuration. Select Check sharing and review Serve on this host before retrying.', false, true, undefined, false, instructions);
      }
      let intent = false;
      try { intent = Boolean(await owner.read()); } catch { /* Failed reads cannot create ownership. */ }
      return report(endpoint.label + ': ' + sharingErrorCopy(error, this.dependencies.platform ?? process.platform), false, intent, undefined, false, instructions);
    }
  }
}
export type KilnSharingStatus = { state: 'off' | 'ready' | 'blocked'; message: string; url?: string; enabled: boolean; canChange?: boolean; instructions?: string };
export type KilnSharingOptions = { hostLabel: string; localUrl: string; token: string; statePath: string; publicPort?: number; ownedProcess?: boolean };
export type KilnSharingDependencies = {
  run(args: string[]): Promise<string>;
  request(url: string, token?: string): Promise<number>;
  read(): Promise<string | undefined>;
  save(value: string | undefined): Promise<void>;
  api(): AtomicServeApi | Promise<AtomicServeApi>;
};
/** Existing landed factory/method contracts remain; main passes explicit lifecycle ownership.
 * Tests can inject the atomic API, never an unsafe CLI mutation fallback. */
export function createKilnSharing(options: KilnSharingOptions, injected: Partial<KilnSharingDependencies> = {}) {
  const file = fileShareOwnerStore(options.statePath);
  const owner: ShareOwnerStore = {
    read: injected.read ? async () => { const raw = await injected.read!(); return raw ? parseShareOwner(raw) : undefined; } : file.read,
    write: injected.save ? value => injected.save!(value ? JSON.stringify(value) : undefined) : file.write,
  };
  const controller = new KilnSharing({
    command: injected.run ? args => injected.run!([...args]) : runTailscale,
    api: injected.api ?? createLocalServeApi, owner, publicPort: options.publicPort,
    check: injected.request ? async endpoint => {
      const url = endpoint.url.replace(/\/+$/, '') + '/conversations?limit=1';
      const denied = await injected.request!(url);
      return { ok: (denied === 401 || denied === 403) && await injected.request!(url, endpoint.token) === 200 };
    } : checkSharedKilnAuth,
  });
  const perform = async (action: 'inspect' | 'enable' | 'disable'): Promise<KilnSharingStatus> => {
    const result = await controller.run(action, { id: 'pi:local', label: options.hostLabel, url: options.localUrl, token: options.token }, options.ownedProcess !== false);
    return { state: result.ok ? (result.enabled ? 'ready' : 'off') : 'blocked', message: result.detail,
      enabled: result.enabled, canChange: result.canChange, url: result.url, instructions: result.instructions };
  };
  return { inspect: () => perform('inspect'), enable: () => perform('enable'), disable: () => perform('disable') };
}
