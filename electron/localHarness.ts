/**
 * The local harness, started by Ember itself.
 *
 * Installing the desktop app used to leave you with a control room and nothing to control on the
 * machine you had just set it up on: it could only reach Kiln if one was already running, or if you
 * cloned this repository and ran the CLI. A desktop app that needs a terminal before it can show a
 * single conversation has not been installed, it has been unpacked.
 *
 * So the app ships the harness. On first launch it starts the bundled Kiln on loopback, adopts the
 * token it writes, and lists it as an ordinary endpoint — which means every existing piece of the
 * app (instances, streams, polling, crew strip) keeps working unchanged. Nothing here is a second
 * way to talk to a host; it is one way to *have* a host.
 *
 * The rules this follows:
 *
 * - **A local harness is ours only if we started it.** If something already answers on the port —
 *   a Kiln from `tinder setup --service`, or a container — we attach to it and never own its
 *   lifecycle. Quitting Ember must not take down a host that was running before it launched.
 * - **Never two of them.** Two harnesses on one data home would open one SQLite database twice,
 *   which is a corruption risk, not a bug report. The lock file (`<home>/ember-harness.lock`)
 *   decides who owns it, and a stale lock from a crashed parent is reclaimed.
 * - **A failure is a sentence, not a stack.** The renderer shows why the bundled host did not start,
 *   because "no instances" for a missing binary is the exact dead end the copy rules forbid.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Fixed so the app and the CLI agree where a local harness listens and keeps its data. */
export const LOCAL_HARNESS_PORT = 3002;
export const HARNESS_START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

export type LocalHarnessState =
  /** A harness answered before we tried to start one: it is not ours to stop. */
  | { kind: 'attached'; url: string; token: string; version?: string }
  /** We started it, and it is answering. */
  | { kind: 'started'; url: string; token: string; version?: string }
  /** The user turned it off in settings. */
  | { kind: 'disabled' }
  /** The binary is not where the installer put it (a dev checkout, a repack). */
  | { kind: 'missing'; binaryPath: string }
  /** It was started and did not answer within the timeout, or it exited. */
  | { kind: 'failed'; reason: string };

export type LocalHarnessOptions = {
  /** Directory holding the bundled binary (`Contents/Resources` on macOS). */
  resourcesDir: string;
  /** Where the binary is, relative to `resourcesDir`. Overridable so a dev run can point anywhere. */
  binaryName?: string;
  /** `<home>` for the harness; `~/.ember` unless overridden. */
  home?: string;
  port?: number;
  /** Skip starting even when the binary exists (Settings → Instances, "Run Kiln on this computer"). */
  disabled?: boolean;
  logFile?: string;
  /** Test seam: how to spawn. Defaults to `spawn` with the bundled binary. */
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** Test seam: the loopback probe. */
  probe?: (url: string) => Promise<{ ok: boolean; version?: string }>;
  now?: () => number;
};

type LockFile = { pid: number; startedAt: number };

const lockPathFor = (home: string): string => path.join(home, 'ember-harness.lock');

const readLock = (home: string): LockFile | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPathFor(home), 'utf8')) as Partial<LockFile>;
    if (!Number.isSafeInteger(raw.pid) || typeof raw.startedAt !== 'number') return null;
    return { pid: raw.pid as number, startedAt: raw.startedAt };
  } catch {
    return null;
  }
};

/** Whether a pid is a live process. `EPERM` is a process that exists and is not ours to signal. */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const writeLock = (home: string, pid: number, at: number): void => {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(lockPathFor(home), `${JSON.stringify({ pid, startedAt: at })}\n`, { mode: 0o600 });
  } catch {
    // A missing lock is a smaller problem than refusing to start: it only weakens the "never two
    // of them" guard, which is still enforced by the port probe.
  }
};

const clearLock = (home: string): void => {
  try {
    fs.unlinkSync(lockPathFor(home));
  } catch {
    // Already gone.
  }
};

/** The default home, matching the CLI and the harness (`EMBER_HOME`, then `~/.ember`). */
export const defaultHarnessHome = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: string = os.homedir()
): string => {
  const override = env.EMBER_HOME?.trim() || env.HEARTH_HOME?.trim();
  return override ? path.resolve(override) : path.join(homedir, '.ember');
};

/** The harness writes `hearth.token`; the CLI keeps `ember.token` beside it. Either will do. */
export const readHarnessToken = (home: string): string | undefined => {
  for (const name of ['hearth.token', 'ember.token']) {
    try {
      const value = fs.readFileSync(path.join(home, name), 'utf8').trim();
      if (value) return value;
    } catch {
      // Try the next name.
    }
  }
  return undefined;
};

const defaultProbe = async (
  url: string,
  token: string | undefined
): Promise<{ ok: boolean; version?: string }> => {
  try {
    const response = await fetch(`${url}/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json().catch(() => ({}))) as { version?: unknown };
    return { ok: true, ...(typeof body.version === 'string' ? { version: body.version } : {}) };
  } catch {
    return { ok: false };
  }
};

/**
 * What the bundled binary is called on each platform. `electron-builder` copies it to the app's
 * resources directory, so the path is stable inside an installed app and absent in a dev checkout —
 * where `bun run dev` is expected to talk to a harness the developer started themselves.
 */
export const binaryNameFor = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'kiln.exe' : 'kiln';

export const bundledBinaryPath = (
  resourcesDir: string,
  platform: NodeJS.Platform = process.platform,
  binaryName: string = binaryNameFor(platform)
): string => path.join(resourcesDir, binaryName);

/**
 * Start (or adopt) the local harness.
 *
 * Returns as soon as the harness answers, or with a state that says why it does not. It never
 * throws: a desktop app that refuses to open because its optional dependency failed is worse than
 * one that opens and explains.
 */
export const startLocalHarness = async (options: LocalHarnessOptions): Promise<{
  state: LocalHarnessState;
  stop: () => void;
}> => {
  const port = options.port ?? LOCAL_HARNESS_PORT;
  const url = `http://127.0.0.1:${port}`;
  const home = options.home ?? defaultHarnessHome();
  const probe = options.probe ?? ((target: string) => defaultProbe(target, readHarnessToken(home)));
  const now = options.now ?? Date.now;
  let child: ChildProcess | undefined;
  let stopping = false;

  const stop = (): void => {
    stopping = true;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    const owned = child;
    child = undefined;
    // The harness honours SIGTERM and closes its database; a grace period rather than SIGKILL,
    // because a killed harness can leave a hot journal behind.
    const timer = setTimeout(() => {
      try {
        owned.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 5_000);
    timer.unref?.();
    clearLock(home);
  };

  // 1. Something already answering is not ours. This is the service the CLI installed, a container,
  //    or a second Ember window; either way, quitting must not stop it.
  const existing = await probe(url);
  if (existing.ok) {
    return { state: { kind: 'attached', url, token: readHarnessToken(home) ?? '', ...(existing.version ? { version: existing.version } : {}) }, stop: () => {} };
  }

  if (options.disabled === true) return { state: { kind: 'disabled' }, stop: () => {} };

  const binaryPath = bundledBinaryPath(options.resourcesDir, process.platform, options.binaryName);
  let present = true;
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    present = false;
  }
  if (!present) return { state: { kind: 'missing', binaryPath }, stop: () => {} };

  // 2. One harness per data home. A live lock means an Ember instance already owns it (and the
  //    probe above says it is not answering yet — starting a second one would open the same SQLite
  //    database twice). A dead lock is from a crash and is reclaimed.
  const lock = readLock(home);
  if (lock && isProcessAlive(lock.pid)) {
    // It may still be booting. Wait for it rather than starting a rival.
    const deadline = now() + HARNESS_START_TIMEOUT_MS;
    while (now() < deadline) {
      const answer = await probe(url);
      if (answer.ok) {
        return { state: { kind: 'attached', url, token: readHarnessToken(home) ?? '', ...(answer.version ? { version: answer.version } : {}) }, stop: () => {} };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return {
      state: { kind: 'failed', reason: `another Ember is starting the harness (pid ${lock.pid}) and it has not answered after ${HARNESS_START_TIMEOUT_MS / 1000}s` },
      stop: () => {},
    };
  }
  if (lock) clearLock(home);

  // 3. Start it, with the log on disk so a failure to boot is readable rather than invisible.
  const logPath = options.logFile ?? path.join(home, 'kiln.log');
  try {
    fs.mkdirSync(home, { recursive: true });
    const log = fs.openSync(logPath, 'a');
    fs.writeSync(log, `\n${new Date(now()).toISOString()} Ember starting the bundled harness\n`);
    const spawnFn = options.spawn ?? spawn;
    const spawned = spawnFn(binaryPath, [], {
      env: {
        ...process.env,
        HEARTH_HOME: home,
        EMBER_HOME: home,
        HEARTH_PORT: String(port),
        HEARTH_BIND: '127.0.0.1',
        // The app is not a git checkout, so the build watcher has nothing to watch.
        HEARTH_AUTORELOAD: '0',
      },
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    spawned.on('exit', () => {
      if (stopping) return;
      clearLock(home);
    });
    child = spawned;
    if (spawned.pid) writeLock(home, spawned.pid, now());
  } catch (error) {
    return {
      state: { kind: 'failed', reason: `the bundled harness could not be started (${error instanceof Error ? error.message : String(error)})` },
      stop: () => {},
    };
  }

  const deadline = now() + HARNESS_START_TIMEOUT_MS;
  while (now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      clearLock(home);
      return {
        state: { kind: 'failed', reason: `the bundled harness exited with code ${child.exitCode} — see ${logPath}` },
        stop,
      };
    }
    const answer = await probe(url);
    if (answer.ok) {
      return { state: { kind: 'started', url, token: readHarnessToken(home) ?? '', ...(answer.version ? { version: answer.version } : {}) }, stop };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  stop();
  return {
    state: { kind: 'failed', reason: `the bundled harness did not answer on ${url} within ${HARNESS_START_TIMEOUT_MS / 1000}s — see ${logPath}` },
    stop: () => {},
  };
};

/** The sentence the renderer shows for each non-success state, phrased for the reader. */
export const localHarnessNotice = (state: LocalHarnessState, home = defaultHarnessHome()): string | null => {
  switch (state.kind) {
    case 'attached':
    case 'started':
    case 'disabled':
      return null;
    case 'missing':
      return `This copy of Ember did not ship its local agent server (${path.basename(state.binaryPath)} is missing). Add a host in Settings → Instances, or run \`tinder setup\` to install one here.`;
    case 'failed':
      return `The local agent server did not start: ${state.reason}. You can still add a host in Settings → Instances. Log: ${path.join(home, 'kiln.log')}`;
  }
};
