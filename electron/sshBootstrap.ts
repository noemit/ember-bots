import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidSshTarget } from './sshConfig';
import type { PiEndpoint, SshLifetime } from './transport';

export const DEFAULT_RELEASE_DOWNLOAD_BASE =
  'https://github.com/noemit/ember-bots/releases/latest/download';

export type SshHostKeyEntry = {
  host: string;
  keyType: string;
  fingerprint: string;
  /** Exact sanitized known_hosts line (`<host> <keyType> <base64>`). */
  knownHostsLine: string;
};

export type SshExistingKiln = {
  running: boolean;
  port: number;
  version?: string;
  home?: string;
  binaryPath?: string;
  hasToken: boolean;
};

export type SshProbeResult =
  | {
      outcome: 'ok';
      target: string;
      os: 'linux' | 'macos' | 'unsupported';
      rawOs: string;
      arch: 'x64' | 'arm64' | 'unsupported';
      rawArch: string;
      supported: boolean;
      releaseAsset?: string;
      checksumAsset?: string;
      serviceManager: 'systemd-user' | 'launchd' | 'none';
      remoteHomeDir: string;
      existingKiln?: SshExistingKiln;
    }
  | {
      outcome: 'host-key-unknown';
      target: string;
      hostName: string;
      port: number;
      keys: SshHostKeyEntry[];
      message: string;
    }
  | {
      outcome: 'auth-required';
      target: string;
      message: string;
      unlockCommand: string;
    }
  | {
      outcome: 'unreachable' | 'ssh-missing' | 'invalid-target' | 'error';
      target: string;
      message: string;
    };

export type SshSetupMode = 'install' | 'adopt' | 'update';

export type SshSetupRequest = {
  target: string;
  label?: string;
  lifetime: SshLifetime;
  remotePort?: number;
  mode: SshSetupMode;
  remoteHome?: string;
  binaryPath?: string;
  existingEndpointId?: string;
};

export type SshSetupResult =
  | {
      ok: true;
      endpoint: PiEndpoint;
      deliveryMethod?: 'remote-download' | 'ssh-stream' | 'adopted';
      uninstallCommand: string;
      message: string;
    }
  | {
      ok: false;
      code:
        | 'invalid-target'
        | 'unsupported-platform'
        | 'host-key-unknown'
        | 'auth-required'
        | 'service-unavailable'
        | 'checksum-failed'
        | 'download-failed'
        | 'token-missing'
        | 'error';
      message: string;
      unlockCommand?: string;
    };

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
};

export type SshRunner = {
  exec(
    file: string,
    args: readonly string[],
    options?: { timeoutMs?: number; input?: Buffer | string }
  ): Promise<CommandResult>;
  fetchBytes(url: string): Promise<{ ok: boolean; status: number; bytes: Buffer }>;
};

const defaultRunner: SshRunner = {
  exec: (file, args, options) =>
    new Promise((resolve) => {
      if (options?.input !== undefined) {
        const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;
        const finish = (result: CommandResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };
        const timer =
          options.timeoutMs && options.timeoutMs > 0
            ? setTimeout(() => {
                child.kill('SIGTERM');
                finish({
                  code: null,
                  stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                  stderr: Buffer.concat(stderrChunks).toString('utf8') || 'SSH command timed out',
                  errorCode: 'ETIMEDOUT',
                });
              }, options.timeoutMs)
            : null;
        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        child.on('error', (error: NodeJS.ErrnoException) =>
          finish({
            code: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: error.message,
            errorCode: error.code,
          })
        );
        child.on('close', (code) =>
          finish({
            code,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          })
        );
        child.stdin.on('error', () => {
          // Ignore broken pipe if SSH exits early; close handler reports the real failure.
        });
        child.stdin.end(options.input);
        return;
      }

      execFile(
        file,
        [...args],
        {
          timeout: options?.timeoutMs ?? 20_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
          if (!err) {
            resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            return;
          }
          resolve({
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? '') || err.message,
            errorCode: err.killed ? 'ETIMEDOUT' : typeof err.code === 'string' ? err.code : undefined,
          });
        }
      );
    }),
  fetchBytes: async (url) => {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { ok: response.ok, status: response.status, bytes };
  },
};

export const sshBaseArgs = (connectTimeoutSec = 10): string[] => [
  '-o',
  'BatchMode=yes',
  '-o',
  `ConnectTimeout=${connectTimeoutSec}`,
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'NumberOfPasswordPrompts=0',
];

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const mapRemotePlatform = (
  rawOs: string,
  rawArch: string
): {
  os: 'linux' | 'macos' | 'unsupported';
  arch: 'x64' | 'arm64' | 'unsupported';
  supported: boolean;
  releaseAsset?: string;
  checksumAsset?: string;
} => {
  const osNorm = rawOs.trim().toLowerCase();
  const archNorm = rawArch.trim().toLowerCase();
  const osKind =
    osNorm === 'linux' ? 'linux' : osNorm === 'darwin' ? 'macos' : 'unsupported';
  const archKind =
    archNorm === 'x86_64' || archNorm === 'amd64'
      ? 'x64'
      : archNorm === 'arm64' || archNorm === 'aarch64'
        ? 'arm64'
        : 'unsupported';

  if (osKind === 'linux' && archKind === 'x64') {
    return {
      os: 'linux',
      arch: 'x64',
      supported: true,
      releaseAsset: 'tinder-linux-x64',
      checksumAsset: 'SHA256SUMS-linux.txt',
    };
  }
  if (osKind === 'macos' && archKind === 'arm64') {
    return {
      os: 'macos',
      arch: 'arm64',
      supported: true,
      releaseAsset: 'tinder-macos-arm64',
      checksumAsset: 'SHA256SUMS-macos.txt',
    };
  }
  return { os: osKind, arch: archKind, supported: false };
};

/** Compute OpenSSH-style `SHA256:<base64-no-pad>` fingerprint from a known_hosts key blob. */
export const computeSshKeyFingerprint = (base64Blob: string): string => {
  const digest = createHash('sha256').update(Buffer.from(base64Blob, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
};

const KNOWN_HOSTS_LINE_RE =
  /^(\[?[a-zA-Z0-9._:-]+\]?(?::\d{1,5})?)\s+(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)$/;

export const parseKeyscanOutput = (stdout: string): SshHostKeyEntry[] => {
  const seen = new Set<string>();
  const keys: SshHostKeyEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = KNOWN_HOSTS_LINE_RE.exec(trimmed);
    if (!match) continue;
    const [, host, keyType, blob] = match;
    if (!host || !keyType || !blob) continue;
    const knownHostsLine = `${host} ${keyType} ${blob}`;
    if (seen.has(knownHostsLine)) continue;
    seen.add(knownHostsLine);
    keys.push({
      host,
      keyType,
      fingerprint: computeSshKeyFingerprint(blob),
      knownHostsLine,
    });
  }
  return keys;
};

/** Parse a `SHA256SUMS-*.txt` manifest and return the expected 64-hex SHA-256 for `assetName`. */
export const parseChecksumManifest = (manifest: string, assetName: string): string | null => {
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(trimmed);
    if (!match) continue;
    const [, hash, file] = match;
    if (file === assetName || path.posix.basename(file!) === assetName) {
      return hash!.toLowerCase();
    }
  }
  return null;
};

export const remoteUninstallCommand = (
  osKind: 'linux' | 'macos' | 'unsupported',
  binaryPath = '$HOME/.local/bin/tinder'
): string => {
  if (osKind === 'macos') {
    return `launchctl unload -w "$HOME/Library/LaunchAgents/dev.ember.kiln.plist" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/dev.ember.kiln.plist" ${shellQuote(binaryPath)}`;
  }
  return `systemctl --user disable --now ember-kiln.service 2>/dev/null; rm -f "$HOME/.config/systemd/user/ember-kiln.service" ${shellQuote(binaryPath)}`;
};

const classifySshStderr = (stderr: string, errorCode?: string): 'ssh-missing' | 'host-key' | 'auth' | 'unreachable' => {
  if (errorCode === 'ENOENT') return 'ssh-missing';
  if (
    /host key verification failed|are you sure you want to continue connecting|no\s+\S+\s+host key is known/i.test(stderr)
  ) {
    return 'host-key';
  }
  if (/permission denied|authentication failed|too many authentication failures|no more authentication methods/i.test(stderr)) {
    return 'auth';
  }
  return 'unreachable';
};

const resolveSshEndpointAddress = async (
  target: string,
  runner: SshRunner
): Promise<{ hostName: string; port: number }> => {
  const fallbackHost = target.includes('@') ? target.slice(target.indexOf('@') + 1) : target;
  const resolved = await runner.exec('ssh', ['-G', '--', target], { timeoutMs: 5_000 });
  if (resolved.code !== 0) return { hostName: fallbackHost, port: 22 };
  let hostName = fallbackHost;
  let port = 22;
  for (const line of resolved.stdout.split(/\r?\n/)) {
    const [key, val] = line.trim().split(/\s+/, 2);
    if (key === 'hostname' && val) hostName = val;
    if (key === 'port' && val) {
      const parsed = Number(val);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) port = parsed;
    }
  }
  return { hostName, port };
};

const REMOTE_PROBE_SCRIPT = [
  'printf "OS=%s\\n" "$(uname -s 2>/dev/null || true)"',
  'printf "ARCH=%s\\n" "$(uname -m 2>/dev/null || true)"',
  'printf "HOME=%s\\n" "$HOME"',
  'if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then printf "SVC=systemd-user\\n"; elif [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then printf "SVC=launchd\\n"; else printf "SVC=none\\n"; fi',
  'BIN=""',
  'if [ -x "$HOME/.local/bin/tinder" ]; then BIN="$HOME/.local/bin/tinder"; elif command -v tinder >/dev/null 2>&1; then BIN="$(command -v tinder)"; fi',
  'printf "BIN=%s\\n" "$BIN"',
  'TOKEN=""',
  'HOME_FOUND=""',
  'for pair in "$HOME/.ember/ember.token:$HOME/.ember" "$HOME/.hearth/hearth.token:$HOME/.hearth"; do',
  '  f="${pair%%:*}"; d="${pair#*:}"',
  '  if [ -r "$f" ]; then TOKEN="$(tr -d "\\r\\n" < "$f")"; HOME_FOUND="$d"; break; fi',
  'done',
  'printf "KILN_HOME=%s\\n" "$HOME_FOUND"',
  'printf "HAS_TOKEN=%s\\n" "$([ -n "$TOKEN" ] && echo 1 || echo 0)"',
  'HEALTH=""',
  'if [ -n "$TOKEN" ]; then',
  '  if command -v curl >/dev/null 2>&1; then',
  '    HEALTH="$(curl -fsS --max-time 3 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3002/health 2>/dev/null || true)"',
  '  elif command -v wget >/dev/null 2>&1; then',
  '    HEALTH="$(wget -qO- --timeout=3 --header="Authorization: Bearer $TOKEN" http://127.0.0.1:3002/health 2>/dev/null || true)"',
  '  fi',
  'fi',
  'printf "HEALTH=%s\\n" "$(printf "%s" "$HEALTH" | tr -d "\\r\\n")"',
].join('\n');

const parseKeyValueLines = (stdout: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
};

export const probeSshHost = async (
  rawTarget: string,
  runner: SshRunner = defaultRunner
): Promise<SshProbeResult> => {
  const target = rawTarget.trim();
  if (!isValidSshTarget(target)) {
    return {
      outcome: 'invalid-target',
      target,
      message: 'Enter an SSH host alias or user@host without spaces, flags, or shell punctuation.',
    };
  }

  const probe = await runner.exec('ssh', [...sshBaseArgs(10), '--', target, 'sh', '-s'], {
    timeoutMs: 18_000,
    input: REMOTE_PROBE_SCRIPT,
  });

  if (probe.code !== 0) {
    const kind = classifySshStderr(probe.stderr, probe.errorCode);
    if (kind === 'ssh-missing') {
      return {
        outcome: 'ssh-missing',
        target,
        message: 'Ember could not find an `ssh` client on this computer. Install OpenSSH, then try checking this host again.',
      };
    }
    if (kind === 'host-key') {
      const { hostName, port } = await resolveSshEndpointAddress(target, runner);
      const scanArgs = ['-T', '5', ...(port !== 22 ? ['-p', String(port)] : []), '--', hostName];
      const scanned = await runner.exec('ssh-keyscan', scanArgs, { timeoutMs: 10_000 });
      const keys = parseKeyscanOutput(scanned.stdout);
      return {
        outcome: 'host-key-unknown',
        target,
        hostName,
        port,
        keys,
        message:
          keys.length > 0
            ? `${target} is not in your SSH known_hosts yet. Verify its fingerprint below before trusting it.`
            : `${target} is not in your SSH known_hosts yet, and Ember could not read its host key. Run \`ssh ${target}\` in a terminal once to verify it, then try again.`,
      };
    }
    if (kind === 'auth') {
      return {
        outcome: 'auth-required',
        target,
        unlockCommand: `ssh-add && ssh ${target}`,
        message: `${target} asked for interactive authentication (a key passphrase, password, or 2FA). Unlock your SSH key or sign in once in a terminal, then choose Check host again.`,
      };
    }
    return {
      outcome: 'unreachable',
      target,
      message: `${target} did not answer over SSH. It may be asleep, off the network, or behind a VPN — check your connection and try again.`,
    };
  }

  const fields = parseKeyValueLines(probe.stdout);
  const rawOs = fields.OS ?? '';
  const rawArch = fields.ARCH ?? '';
  const mapped = mapRemotePlatform(rawOs, rawArch);
  const serviceManager =
    fields.SVC === 'systemd-user' || fields.SVC === 'launchd' ? fields.SVC : 'none';

  let running = false;
  let version: string | undefined;
  if (fields.HEALTH) {
    try {
      const health = JSON.parse(fields.HEALTH) as { service?: unknown; version?: unknown };
      if (health.service === 'hearth') {
        running = true;
        if (typeof health.version === 'string' && health.version.trim()) {
          version = health.version.trim();
        }
      }
    } catch {
      // Ignore malformed health output; treat as not running.
    }
  }

  const hasToken = fields.HAS_TOKEN === '1';
  const binaryPath = fields.BIN || undefined;
  const kilnHome = fields.KILN_HOME || undefined;
  const existingKiln: SshExistingKiln | undefined =
    running || binaryPath || hasToken
      ? {
          running,
          port: 3002,
          ...(version ? { version } : {}),
          ...(kilnHome ? { home: kilnHome } : {}),
          ...(binaryPath ? { binaryPath } : {}),
          hasToken,
        }
      : undefined;

  return {
    outcome: 'ok',
    target,
    ...mapped,
    rawOs,
    rawArch,
    serviceManager,
    remoteHomeDir: fields.HOME || '~',
    ...(existingKiln ? { existingKiln } : {}),
  };
};

/**
 * Append user-approved `known_hosts` lines to `~/.ssh/known_hosts` (mode 0600, deduplicated).
 * Rejects any line that does not match strict OpenSSH `host keytype base64` syntax.
 */
export const trustSshHostKeys = (
  lines: readonly string[],
  options?: { knownHostsPath?: string; homeDir?: string }
): { ok: true; added: number } | { ok: false; message: string } => {
  const valid = lines
    .map((line) => line.trim())
    .filter((line) => KNOWN_HOSTS_LINE_RE.test(line));
  if (valid.length === 0) {
    return {
      ok: false,
      message: 'No valid SSH host keys were provided to save. Run Check host again to fetch a fresh fingerprint.',
    };
  }
  const homeDir = options?.homeDir ?? os.homedir();
  const sshDir = path.join(homeDir, '.ssh');
  const knownHostsPath = options?.knownHostsPath ?? path.join(sshDir, 'known_hosts');
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(knownHostsPath) ? fs.readFileSync(knownHostsPath, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const toAppend = valid.filter((line) => !existingLines.has(line));
  if (toAppend.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(knownHostsPath, `${prefix}${toAppend.join('\n')}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(knownHostsPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  }
  return { ok: true, added: toAppend.length };
};

const remoteDownloadScript = (
  assetUrl: string,
  checksumUrl: string,
  assetName: string,
  destPath: string
): string => {
  const destDir = path.posix.dirname(destPath);
  return [
    'set -eu',
    `mkdir -p ${shellQuote(destDir)}`,
    `TMP_DIR="$(mktemp -d)"`,
    'trap \'rm -rf "$TMP_DIR"\' EXIT',
    'fetch_file() {',
    '  if command -v curl >/dev/null 2>&1; then',
    '    curl -fsSL --max-time 60 "$1" -o "$2"',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    wget -qO "$2" --timeout=60 "$1"',
    '  else',
    '    exit 127',
    '  fi',
    '}',
    `fetch_file ${shellQuote(checksumUrl)} "$TMP_DIR/SHA256SUMS.txt"`,
    `fetch_file ${shellQuote(assetUrl)} "$TMP_DIR/tinder"`,
    `EXPECTED="$(awk -v name=${shellQuote(assetName)} '{ f=$2; sub(/^\\*/, "", f); if (f == name) { print tolower($1); exit } }' "$TMP_DIR/SHA256SUMS.txt")"`,
    'if [ -z "$EXPECTED" ]; then echo "CHECKSUM_ENTRY_MISSING" >&2; exit 42; fi',
    'if command -v sha256sum >/dev/null 2>&1; then',
    '  ACTUAL="$(sha256sum "$TMP_DIR/tinder" | awk \'{print tolower($1)}\')"',
    'elif command -v shasum >/dev/null 2>&1; then',
    '  ACTUAL="$(shasum -a 256 "$TMP_DIR/tinder" | awk \'{print tolower($1)}\')"',
    'else',
    '  exit 127',
    'fi',
    'if [ "$ACTUAL" != "$EXPECTED" ]; then echo "CHECKSUM_MISMATCH" >&2; exit 43; fi',
    'chmod 0700 "$TMP_DIR/tinder"',
    `mv -f "$TMP_DIR/tinder" ${shellQuote(destPath)}`,
  ].join('\n');
};

const remoteStreamInstallCommand = (destPath: string): string => {
  const destDir = path.posix.dirname(destPath);
  return `mkdir -p ${shellQuote(destDir)} && tmp=${shellQuote(`${destPath}.tmp.$$`)} && cat > "$tmp" && chmod 0700 "$tmp" && mv -f "$tmp" ${shellQuote(destPath)}`;
};

const readRemoteToken = async (
  target: string,
  binaryPath: string | undefined,
  remoteHome: string | undefined,
  remotePort: number,
  runner: SshRunner
): Promise<string | null> => {
  const scriptLines = [
    'set -eu',
    ...(remoteHome
      ? [
          `for f in ${shellQuote(`${remoteHome}/ember.token`)} ${shellQuote(`${remoteHome}/hearth.token`)}; do`,
          '  if [ -r "$f" ]; then tr -d "\\r\\n" < "$f"; exit 0; fi',
          'done',
        ]
      : []),
    'for f in "$HOME/.ember/ember.token" "$HOME/.hearth/hearth.token"; do',
    '  if [ -r "$f" ]; then tr -d "\\r\\n" < "$f"; exit 0; fi',
    'done',
    ...(binaryPath
      ? [
          `if [ -x ${shellQuote(binaryPath)} ]; then ${shellQuote(binaryPath)} token --json --port ${remotePort}${remoteHome ? ` --home ${shellQuote(remoteHome)}` : ''}; fi`,
        ]
      : []),
  ].join('\n');

  const res = await runner.exec('ssh', [...sshBaseArgs(10), '--', target, 'sh', '-s'], {
    timeoutMs: 15_000,
    input: scriptLines,
  });
  if (res.code !== 0) return null;
  const trimmed = res.stdout.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.trim() && !/[\r\n]/.test(parsed.token)) {
        return parsed.token.trim();
      }
    } catch {
      return null;
    }
  }
  if (/[\r\n]/.test(trimmed) || trimmed.length > 4096) return null;
  return trimmed;
};

const makeEndpointId = (target: string, existingEndpointId?: string): string => {
  if (existingEndpointId && existingEndpointId.startsWith('pi:')) return existingEndpointId;
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `pi:ssh-${slug || 'host'}`;
};

export const setupSshKiln = async (
  request: SshSetupRequest,
  options: {
    runner?: SshRunner;
    allocateLocalPort: () => Promise<number>;
    releaseBaseUrl?: string;
    onProgress?: (step: string) => void;
  }
): Promise<SshSetupResult> => {
  const runner = options.runner ?? defaultRunner;
  const releaseBase = (options.releaseBaseUrl ?? DEFAULT_RELEASE_DOWNLOAD_BASE).replace(/\/+$/, '');
  const target = request.target.trim();
  if (!isValidSshTarget(target)) {
    return {
      ok: false,
      code: 'invalid-target',
      message: 'Enter a valid SSH host alias or user@host without spaces or flags.',
    };
  }
  const remotePort =
    request.remotePort && Number.isInteger(request.remotePort) && request.remotePort >= 1 && request.remotePort <= 65535
      ? request.remotePort
      : 3002;
  const label = request.label?.trim() || target;

  options.onProgress?.(`Checking ${target} over SSH…`);
  const probed = await probeSshHost(target, runner);
  if (probed.outcome !== 'ok') {
    return {
      ok: false,
      code:
        probed.outcome === 'host-key-unknown'
          ? 'host-key-unknown'
          : probed.outcome === 'auth-required'
            ? 'auth-required'
            : probed.outcome === 'invalid-target'
              ? 'invalid-target'
              : 'error',
      message: probed.message,
      ...(probed.outcome === 'auth-required' ? { unlockCommand: probed.unlockCommand } : {}),
    };
  }

  const defaultBinaryPath = `${probed.remoteHomeDir.replace(/\/+$/, '')}/.local/bin/tinder`;
  const binaryPath = request.binaryPath?.trim() || probed.existingKiln?.binaryPath || defaultBinaryPath;
  const remoteHome = request.remoteHome?.trim() || probed.existingKiln?.home;
  const uninstall = remoteUninstallCommand(probed.os, binaryPath);

  let deliveryMethod: 'remote-download' | 'ssh-stream' | 'adopted' = 'adopted';

  if (request.mode === 'install' || request.mode === 'update') {
    if (!probed.supported || !probed.releaseAsset || !probed.checksumAsset) {
      return {
        ok: false,
        code: 'unsupported-platform',
        message: `${target} runs ${probed.rawOs || 'an unknown OS'} (${probed.rawArch || 'unknown arch'}). Published Tinder binaries currently cover Linux x64 and macOS ARM64.`,
      };
    }

    const assetUrl = `${releaseBase}/${probed.releaseAsset}`;
    const checksumUrl = `${releaseBase}/${probed.checksumAsset}`;

    // Primary delivery: download directly on remote and verify SHA-256 against SHA256SUMS.
    options.onProgress?.(`Installing Tinder on ${target}…`);
    const remoteDl = await runner.exec('ssh', [...sshBaseArgs(10), '--', target, 'sh', '-s'], {
      timeoutMs: 90_000,
      input: remoteDownloadScript(assetUrl, checksumUrl, probed.releaseAsset, binaryPath),
    });

    if (remoteDl.code === 0) {
      deliveryMethod = 'remote-download';
    } else if (remoteDl.code === 43) {
      return {
        ok: false,
        code: 'checksum-failed',
        message: `The Tinder download on ${target} did not match its SHA-256 checksum, so Ember stopped without installing it. Try again in a moment.`,
      };
    } else {
      // Fallback delivery: download and SHA-256 verify on this computer, then stream over SSH stdin.
      options.onProgress?.(`Remote download unavailable on ${target}; streaming verified Tinder over SSH…`);
      let manifestRes: { ok: boolean; status: number; bytes: Buffer };
      let binaryRes: { ok: boolean; status: number; bytes: Buffer };
      try {
        [manifestRes, binaryRes] = await Promise.all([
          runner.fetchBytes(checksumUrl),
          runner.fetchBytes(assetUrl),
        ]);
      } catch {
        return {
          ok: false,
          code: 'download-failed',
          message: `Neither ${target} nor this computer could reach GitHub Releases to download Tinder. Check internet access and try again.`,
        };
      }
      if (!manifestRes.ok || !binaryRes.ok) {
        return {
          ok: false,
          code: 'download-failed',
          message: `Ember could not download ${probed.releaseAsset} or its checksum manifest from GitHub Releases. Try again once the release is reachable.`,
        };
      }
      const expectedHash = parseChecksumManifest(manifestRes.bytes.toString('utf8'), probed.releaseAsset);
      if (!expectedHash) {
        return {
          ok: false,
          code: 'checksum-failed',
          message: `The release checksum manifest did not list ${probed.releaseAsset}, so Ember stopped without installing it.`,
        };
      }
      const actualHash = createHash('sha256').update(binaryRes.bytes).digest('hex').toLowerCase();
      if (actualHash !== expectedHash) {
        return {
          ok: false,
          code: 'checksum-failed',
          message: `The downloaded ${probed.releaseAsset} did not match its SHA-256 checksum, so Ember stopped without installing it.`,
        };
      }
      const streamed = await runner.exec(
        'ssh',
        [...sshBaseArgs(10), '--', target, 'sh', '-c', remoteStreamInstallCommand(binaryPath)],
        { timeoutMs: 90_000, input: binaryRes.bytes }
      );
      if (streamed.code !== 0) {
        return {
          ok: false,
          code: 'error',
          message: `Ember could not write Tinder to ${binaryPath} on ${target}. Check disk space and permissions in ~/.local/bin, then try again.`,
        };
      }
      deliveryMethod = 'ssh-stream';
    }

    // Configure Kiln on loopback (127.0.0.1) only.
    options.onProgress?.(`Configuring Kiln on ${target}…`);
    const homeFlag = remoteHome ? ` --home ${shellQuote(remoteHome)}` : '';
    if (request.lifetime === 'service') {
      if (probed.serviceManager === 'none') {
        return {
          ok: false,
          code: 'service-unavailable',
          message: `${target} does not have an active user service manager (systemd --user or launchd). Choose “This session only” to run Kiln over the SSH tunnel instead.`,
        };
      }
      const startCmd =
        probed.serviceManager === 'systemd-user'
          ? 'systemctl --user daemon-reload && systemctl --user enable --now ember-kiln.service && systemctl --user restart ember-kiln.service'
          : 'launchctl unload -w "$HOME/Library/LaunchAgents/dev.ember.kiln.plist" 2>/dev/null || true; launchctl load -w "$HOME/Library/LaunchAgents/dev.ember.kiln.plist"';
      const setupScript = [
        'set -eu',
        `${shellQuote(binaryPath)} setup --headless --service --bind 127.0.0.1 --port ${remotePort}${homeFlag}`,
        startCmd,
      ].join('\n');
      const configured = await runner.exec('ssh', [...sshBaseArgs(10), '--', target, 'sh', '-s'], {
        timeoutMs: 30_000,
        input: setupScript,
      });
      if (configured.code !== 0) {
        return {
          ok: false,
          code: 'error',
          message: `Tinder was installed on ${target}, but its background service could not start. Check \`systemctl --user status ember-kiln\` on ${target} or choose “This session only”.`,
        };
      }
    } else {
      // Ephemeral mode: only ensure the token/home exist; the SSH tunnel itself runs `tinder serve`.
      const setupScript = [
        'set -eu',
        `${shellQuote(binaryPath)} setup --harness-only --bind 127.0.0.1 --port ${remotePort}${homeFlag}`,
      ].join('\n');
      const configured = await runner.exec('ssh', [...sshBaseArgs(10), '--', target, 'sh', '-s'], {
        timeoutMs: 20_000,
        input: setupScript,
      });
      if (configured.code !== 0) {
        return {
          ok: false,
          code: 'error',
          message: `Tinder was installed on ${target}, but initializing its token failed. Check permissions in ~/.ember on ${target} and try again.`,
        };
      }
    }
  }

  options.onProgress?.(`Reading Kiln token from ${target}…`);
  const token = await readRemoteToken(target, binaryPath, remoteHome, remotePort, runner);
  if (!token) {
    return {
      ok: false,
      code: 'token-missing',
      message: `Ember could not read a Kiln token on ${target}. Make sure Kiln is initialized there, then try again.`,
    };
  }

  const localPort = await options.allocateLocalPort();
  const endpoint: PiEndpoint = {
    id: makeEndpointId(target, request.existingEndpointId),
    label,
    url: `http://127.0.0.1:${localPort}/`,
    token,
    ssh: {
      target,
      remotePort,
      lifetime: request.lifetime,
      ...(remoteHome ? { remoteHome } : {}),
      ...(binaryPath ? { binaryPath } : {}),
    },
  };

  return {
    ok: true,
    endpoint,
    deliveryMethod,
    uninstallCommand: uninstall,
    message:
      request.mode === 'update'
        ? `Updated Kiln on ${label} and reconnected through the SSH tunnel.`
        : request.mode === 'adopt'
          ? `Connected to existing Kiln on ${label} through a loopback SSH tunnel.`
          : request.lifetime === 'service'
            ? `Installed Kiln on ${label} as a background service and connected through a loopback SSH tunnel.`
            : `Installed Kiln on ${label} for this session and connected through a loopback SSH tunnel.`,
  };
};
