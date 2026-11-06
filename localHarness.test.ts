import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  availableHarnessPort,
  resolveHarnessBinary,
  binaryNameFor,
  bundledBinaryPath,
  canManageLocalToken,
  generateHarnessToken,
  isActiveHarness,
  isManagedHarness,
  localHarnessEndpoint,
  writeHarnessToken,
  defaultHarnessHome,
  HARNESS_START_TIMEOUT_MS,
  isProcessAlive,
  localHarnessNotice,
  readHarnessToken,
  startLocalHarness,
} from './electron/localHarness';

/**
 * The bundled harness, which is what makes a downloaded Ember a working app rather than a window
 * with nothing to connect to.
 *
 * The rules pinned here are the ones that cost something when they are wrong: a harness the app did
 * not start must not be stopped by it, two harnesses must never open one database, and every way it
 * can fail has to say so in a sentence a person can act on.
 */

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-harness-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake child process: enough of `ChildProcess` for the starter, and an exit the test controls. */
type FakeChild = ChildProcess & { killed: string[] };
const fakeChild = (pid = 4242): FakeChild => {
  const listeners: Array<() => void> = [];
  const child = {
    pid,
    exitCode: null as number | null,
    killed: [] as string[],
    kill(signal: string) {
      child.killed.push(signal);
      child.exitCode = 0;
      for (const listener of listeners) listener();
      return true;
    },
    on(event: string, listener: () => void) {
      if (event === 'exit') listeners.push(listener);
      return child;
    },
    // Test helper, not part of ChildProcess.
    exit(code: number) {
      child.exitCode = code;
      for (const listener of listeners) listener();
    },
  };
  return child as unknown as FakeChild;
};

const okProbe = async () => ({ ok: true, version: '1.2.0' });
const downProbe = async () => ({ ok: false });

/** A token that always reads, so cases about the *port* are not silently about the token too. */
const staticToken = (value = 'test-token') => () => value;

describe('where the harness lives', () => {
  test('the binary is named per platform and sits in the app resources', () => {
    expect(binaryNameFor('darwin')).toBe('kiln');
    expect(binaryNameFor('win32')).toBe('kiln.exe');
    expect(bundledBinaryPath('/Applications/Ember.app/Contents/Resources', 'darwin')).toBe(
      '/Applications/Ember.app/Contents/Resources/kiln'
    );
  });

  test('the data home matches the CLI: EMBER_HOME, then HEARTH_HOME, then ~/.ember', () => {
    expect(defaultHarnessHome({}, '/Users/alex')).toBe('/Users/alex/.ember');
    expect(defaultHarnessHome({ HEARTH_HOME: '/tmp/h' }, '/Users/alex')).toBe('/tmp/h');
    expect(defaultHarnessHome({ EMBER_HOME: '/tmp/e', HEARTH_HOME: '/tmp/h' }, '/Users/alex')).toBe('/tmp/e');
  });

  test('the harness token is read from either name the two tools write', () => {
    const home = tempDir();
    expect(readHarnessToken(home)).toBeUndefined();
    fs.writeFileSync(path.join(home, 'hearth.token'), 'harness-token\n');
    expect(readHarnessToken(home)).toBe('harness-token');
    // The CLI keeps an `ember.token` beside it; either is the same secret.
    fs.writeFileSync(path.join(home, 'ember.token'), 'cli-token\n');
    expect(readHarnessToken(home)).toBe('harness-token');
  });

  test('a pid that is gone is not alive, and pid 0/1 are never "ours"', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(1)).toBe(false);
    // This process is alive by definition.
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe('starting (or adopting) the local harness', () => {
  test('a host that already answers is adopted, never restarted and never stopped', async () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home), { recursive: true });
    fs.writeFileSync(path.join(home, 'hearth.token'), 'adopted\n');
    const binary = path.join(tempDir(), 'kiln');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    let spawned = 0;
    const { state, stop } = await startLocalHarness({
      resourcesDir: path.dirname(binary),
      binaryName: path.basename(binary),
      home,
      probe: okProbe,
      readToken: staticToken('adopted'),
      spawn: (() => {
        spawned += 1;
        return fakeChild();
      }) as never,
    });
    expect(state.kind).toBe('attached');
    if (state.kind === 'attached') {
      expect(state.url).toBe('http://127.0.0.1:3002');
      expect(state.token).toBe('adopted');
      expect(state.version).toBe('1.2.0');
    }
    // Starting a second harness would hold the same database twice.
    expect(spawned).toBe(0);
    // And quitting must not take down a host that was running before Ember launched.
    stop();
    expect(localHarnessNotice(state)).toBeNull();
  });

  test('a missing binary is a sentence, not a crash', async () => {
    const { state } = await startLocalHarness({
      resourcesDir: tempDir(),
      home: tempDir(),
      probe: downProbe,
    });
    expect(state.kind).toBe('missing');
    const notice = localHarnessNotice(state);
    expect(notice).toContain('did not ship its local agent server');
    // It points at the recovery that is on screen.
    expect(notice).toContain('Settings → Instances');
  });

  test('turned off in settings means nothing is started', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    let spawned = 0;
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home: tempDir(),
      disabled: true,
      probe: downProbe,
      spawn: (() => {
        spawned += 1;
        return fakeChild();
      }) as never,
    });
    expect(state.kind).toBe('disabled');
    expect(spawned).toBe(0);
    expect(localHarnessNotice(state)).toBeNull();
  });

  test('it starts the binary with the home, the port and no build watcher, then reports what answered', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    let calls = 0;
    let argv: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      // The harness writes its token as it boots; the probe answers a beat before that lands.
      readToken: () => (fs.existsSync(path.join(home, 'hearth.token')) ? fs.readFileSync(path.join(home, 'hearth.token'), 'utf8').trim() : undefined),
      probe: async () => {
        calls += 1;
        // Not answering on the first look, answering once it has "booted".
        return calls === 1 ? { ok: false } : { ok: true, version: '1.2.0' };
      },
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        argv = { command, args, options };
        // The harness writes its token as it boots.
        fs.writeFileSync(path.join(home, 'hearth.token'), 'fresh-token\n');
        return fakeChild();
      }) as never,
    });
    expect(state.kind).toBe('started');
    if (state.kind === 'started') {
      expect(state.token).toBe('fresh-token');
      expect(state.url).toBe('http://127.0.0.1:3002');
    }
    expect(argv?.command).toBe(path.join(binaryDir, 'kiln'));
    expect(argv?.args).toEqual([]);
    const env = (argv?.options.env ?? {}) as Record<string, string>;
    expect(env.HEARTH_HOME).toBe(home);
    expect(env.HEARTH_PORT).toBe('3002');
    expect(env.HEARTH_BIND).toBe('127.0.0.1');
    expect(env.HEARTH_AUTORELOAD).toBe('0');
    // The lock records who owns the data home, so a second Ember cannot open it too.
    expect(fs.existsSync(path.join(home, 'ember-harness.lock'))).toBe(true);
    expect(localHarnessNotice(state)).toBeNull();
  });

  test('an immediate exit is reported with its code and the log path', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    const child = fakeChild();
    const promise = startLocalHarness({
      resourcesDir: binaryDir,
      home,
      probe: async () => {
        // Give the exit a chance to happen before the first successful answer.
        (child as unknown as { exit(code: number): void }).exit(1);
        return { ok: false };
      },
      spawn: (() => child) as never,
    });
    const { state } = await promise;
    expect(state.kind).toBe('failed');
    const notice = localHarnessNotice(state, home);
    expect(notice).toContain('did not start');
    expect(notice).toContain('exited with code 1');
    expect(notice).toContain(path.join(home, 'kiln.log'));
  });

  test('a timeout stops what it started and says where to look', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    const child = fakeChild();
    // A clock that runs out immediately: the timeout is what is under test, not the waiting.
    let t = 0;
    const now = () => {
      t += HARNESS_START_TIMEOUT_MS;
      return t;
    };
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      probe: downProbe,
      spawn: (() => child) as never,
      now,
    });
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') expect(state.reason).toContain('did not answer');
    // What this process started, this process stops — with a signal the harness can close on.
    expect(child.killed).toContain('SIGTERM');
    expect(fs.existsSync(path.join(home, 'ember-harness.lock'))).toBe(false);
  });

  test('a live lock from another Ember is respected rather than raced', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    // A lock held by a live process (this one), and nothing answering on the port.
    fs.writeFileSync(
      path.join(home, 'ember-harness.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() })
    );
    let t = 0;
    let spawned = 0;
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      probe: downProbe,
      spawn: (() => {
        spawned += 1;
        return fakeChild();
      }) as never,
      now: () => {
        t += HARNESS_START_TIMEOUT_MS;
        return t;
      },
    });
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') expect(state.reason).toContain('another Ember is starting the harness');
    // Two harnesses, one SQLite file: never.
    expect(spawned).toBe(0);
  });

  test('a stale lock from a dead process is reclaimed', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    // A pid that cannot be alive: above the platform's pid ceiling in practice, and never ours.
    fs.writeFileSync(
      path.join(home, 'ember-harness.lock'),
      JSON.stringify({ pid: 2_147_483_646, startedAt: 1 })
    );
    let calls = 0;
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      readToken: staticToken(),
      probe: async () => {
        calls += 1;
        return calls === 1 ? { ok: false } : { ok: true, version: '1.2.0' };
      },
      spawn: (() => fakeChild()) as never,
    });
    expect(state.kind).toBe('started');
  });
});

/**
 * The merge rule, which is where first-launch behaviour actually goes wrong.
 *
 * A settings file written before the harness was bundled usually already holds an endpoint pointing
 * at `127.0.0.1:3002`. Adding the started harness as a *second* entry would list one host twice and
 * open its watch set twice — the duplicate-endpoint failure this project already paid for once.
 */
import { mergeLocalHarnessEndpoint } from './electron/localHarness';

describe('merging the started harness into the configured endpoints', () => {
  const endpoint = (over: Partial<{ id: string; label: string; url: string; token: string }> = {}) => ({
    id: 'pi:local',
    label: 'Local',
    url: 'http://127.0.0.1:3002',
    token: 'file-token',
    ...over,
  });

  test('no started harness leaves the configured list exactly as it is', () => {
    const configured = [endpoint()];
    expect(mergeLocalHarnessEndpoint(configured, null)).toBe(configured);
  });

  test('an existing entry for the same address is relabelled, never duplicated', () => {
    const merged = mergeLocalHarnessEndpoint([endpoint({ label: 'Heliograph' })], {
      url: 'http://127.0.0.1:3002/',
      token: 'running-token',
    });
    expect(merged).toHaveLength(1);
    // The person's own name survives; the running host's token wins, because it is the one answering.
    expect(merged[0]?.label).toBe('Heliograph');
    expect(merged[0]?.token).toBe('running-token');
  });

  test('a different address is added in front, so the local host is the first row', () => {
    const merged = mergeLocalHarnessEndpoint(
      [endpoint({ id: 'pi:remote', label: 'Tower', url: 'http://100.64.0.2:3002' })],
      { url: 'http://127.0.0.1:3002', token: 'running-token' }
    );
    expect(merged.map((entry) => entry.id)).toEqual(['pi:local', 'pi:remote']);
    expect(merged[0]?.label).toBe('This computer');
  });

  test('trailing slashes do not create a second entry', () => {
    const one = mergeLocalHarnessEndpoint([endpoint({ url: 'http://127.0.0.1:3002/' })], {
      url: 'http://127.0.0.1:3002',
      token: 't',
    });
    expect(one).toHaveLength(1);
    const two = mergeLocalHarnessEndpoint([endpoint({ url: 'http://127.0.0.1:3002' })], {
      url: 'http://127.0.0.1:3002///',
      token: 't',
    });
    expect(two).toHaveLength(1);
  });
});

/**
 * The failure that shipped in 1.3.0: a harness that answered `/health` a moment before it wrote its
 * token, so the app recorded an empty credential and every later request was a 401. Reload could not
 * fix it — reload re-uses the recorded token — and nothing logged it.
 */
describe('ready means answering *and* authenticating', () => {
  test('an answering harness with no readable token yet is still booting, not ready', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    let answers = 0;
    let token: string | undefined;
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      probe: async () => {
        answers += 1;
        // The port answers from the first poll; the token appears on the third.
        if (answers === 3) token = 'late-token';
        return { ok: true, version: '1.3.0' };
      },
      readToken: () => token,
      spawn: (() => fakeChild()) as never,
    });
    expect(state.kind).toBe('started');
    // The credential the harness actually uses, not the empty one the first poll saw.
    if (state.kind === 'started') expect(state.token).toBe('late-token');
    expect(answers).toBeGreaterThanOrEqual(3);
  });

  test('a host answering with a credential we cannot read is not adopted', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    let t = 0;
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      probe: okProbe,
      // Something else owns the port and we hold no token for it.
      readToken: () => undefined,
      spawn: (() => fakeChild()) as never,
      now: () => {
        t += HARNESS_START_TIMEOUT_MS;
        return t;
      },
    });
    // Not "attached" with an empty token: that was the 401.
    expect(state.kind).not.toBe('attached');
  });
});

/**
 * The token, as the app shows and rotates it.
 *
 * A token is read by the harness **once, at startup** — so a "rotation" that only writes the file
 * produces the worst state there is: the screen shows a fresh token, the running process still only
 * accepts the old one, and nothing is on its way to fix that. These pin the two halves that prevent
 * it: the new value is on disk *before* the child starts, and both filenames carry it.
 */
describe('installing a new token', () => {
  test('a token handed to the starter is written before the child boots, under both names', async () => {
    const binaryDir = tempDir();
    fs.writeFileSync(path.join(binaryDir, 'kiln'), '#!/bin/sh\n', { mode: 0o755 });
    const home = tempDir();
    let sawBeforeSpawn: { hearth?: string; ember?: string } = {};
    const { state } = await startLocalHarness({
      resourcesDir: binaryDir,
      home,
      token: 'apple-venison-rainbow-copper',
      probe: okProbe,
      spawn: (() => {
        // The moment that matters: what the child would find if it read the file right now.
        sawBeforeSpawn = {
          hearth: fs.existsSync(path.join(home, 'hearth.token'))
            ? fs.readFileSync(path.join(home, 'hearth.token'), 'utf8').trim()
            : undefined,
          ember: fs.existsSync(path.join(home, 'ember.token'))
            ? fs.readFileSync(path.join(home, 'ember.token'), 'utf8').trim()
            : undefined,
        };
        return fakeChild();
      }) as never,
    });
    expect(state.kind).toBe('started');
    if (state.kind === 'started') expect(state.token).toBe('apple-venison-rainbow-copper');
    expect(sawBeforeSpawn.hearth).toBe('apple-venison-rainbow-copper');
    expect(sawBeforeSpawn.ember).toBe('apple-venison-rainbow-copper');
  });

  test('the written token is readable by the reader the harness uses, and mode 0600', () => {
    const home = tempDir();
    writeHarnessToken(home, 'apple-venison-rainbow-copper');
    expect(readHarnessToken(home)).toBe('apple-venison-rainbow-copper');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(home, 'hearth.token')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(home, 'ember.token')).mode & 0o777).toBe(0o600);
    }
  });

  test('only a harness we started may be re-tokened', () => {
    expect(canManageLocalToken({ kind: 'started', url: 'http://127.0.0.1:3002', token: 'x' })).toBe(true);
    // An adopted host is Tinder's service or someone else's process: its token is not ours to change.
    expect(canManageLocalToken({ kind: 'attached', url: 'http://127.0.0.1:3002', token: 'x' })).toBe(false);
    expect(canManageLocalToken({ kind: 'disabled' })).toBe(false);
    expect(canManageLocalToken({ kind: 'failed', reason: 'nope' })).toBe(false);
  });

  test('the tokens it makes are four words from the shared list', () => {
    for (let draw = 0; draw < 20; draw += 1) {
      const token = generateHarnessToken();
      expect(token).toMatch(/^[a-z]+(-[a-z]+){3}$/);
    }
    expect(generateHarnessToken()).not.toBe(generateHarnessToken());
  });
});

/**
 * A rotated harness is still the harness on this port.
 *
 * The endpoint merge deliberately adds only the harness *this launch started* — a token read from
 * settings might be stale, so anything attached is left to its own entry. A rotation produces a
 * second state (`restarted`), and when it was not in that set the host vanished from the rail the
 * moment it was given a new password: the token was fine, the row was gone.
 */
describe('a rotated harness stays addressable', () => {
  test('`restarted` is a managed state, like `started`', () => {
    expect(isManagedHarness({ kind: 'restarted', url: 'http://127.0.0.1:3002', token: 'new-token' })).toBe(true);
    expect(isManagedHarness({ kind: 'started', url: 'http://127.0.0.1:3002', token: 'old-token' })).toBe(true);
    // Attached hosts are not ours to merge: their entry is whatever settings says.
    expect(isManagedHarness({ kind: 'attached', url: 'http://127.0.0.1:3002', token: 'x' })).toBe(false);
    expect(isManagedHarness({ kind: 'failed', reason: 'nope' })).toBe(false);
  });

  test('a restarted harness can be re-tokened again, and its new token reaches the endpoint list', () => {
    expect(canManageLocalToken({ kind: 'restarted', url: 'http://127.0.0.1:3002', token: 'again' })).toBe(true);
    const merged = mergeLocalHarnessEndpoint(
      [{ id: 'pi:local', label: 'This computer', url: 'http://127.0.0.1:3002', token: 'old-token' }],
      { url: 'http://127.0.0.1:3002', token: 'new-token' }
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.token).toBe('new-token');
  });

  test('a restarted harness has nothing to warn about', () => {
    expect(localHarnessNotice({ kind: 'restarted', url: 'http://127.0.0.1:3002', token: 't' })).toBeNull();
  });
});

/**
 * Whether a local harness is *listed* is a different question from whether its token may be rotated.
 *
 * The owner's settings file made the difference visible: one remote endpoint, a local harness that
 * was `attached` (already running before Ember launched), and no local row anywhere in the UI. The
 * endpoint list only counted `started`/`restarted`, so "This computer" simply did not exist — on a
 * machine where Kiln was running perfectly. These pin both halves.
 */
describe('a local harness is listed whenever it is answering', () => {
  test('attached hosts are active (listed) but not managed (rotatable)', () => {
    const attached = { kind: 'attached' as const, url: 'http://127.0.0.1:3002', token: 'from-disk' };
    expect(isActiveHarness(attached)).toBe(true);
    // Not ours to restart: `tinder setup --service` (or a container) owns its lifecycle.
    expect(canManageLocalToken(attached)).toBe(false);
    expect(isManagedHarness(attached)).toBe(false);
  });

  test('started and restarted hosts are both', () => {
    for (const state of [
      { kind: 'started' as const, url: 'http://127.0.0.1:3002', token: 'a' },
      { kind: 'restarted' as const, url: 'http://127.0.0.1:3002', token: 'b' },
    ]) {
      expect(isActiveHarness(state)).toBe(true);
      expect(canManageLocalToken(state)).toBe(true);
    }
  });

  test('a state with no host in it is neither', () => {
    expect(isActiveHarness({ kind: 'disabled' })).toBe(false);
    expect(isActiveHarness({ kind: 'failed', reason: 'nope' })).toBe(false);
    expect(isActiveHarness({ kind: 'missing', binaryPath: '/x/kiln' })).toBe(false);
  });

  test('the endpoint is the running host, whatever kind of running it is', () => {
    const home = tempDir();
    writeHarnessToken(home, 'on-disk');
    // An attached host answers on its own token, which wins over what happens to be on disk.
    expect(
      localHarnessEndpoint({
        state: { kind: 'attached', url: 'http://127.0.0.1:3002', token: 'answering' },
        enabled: true,
        home,
      })
    ).toEqual({ url: 'http://127.0.0.1:3002', token: 'answering' });
  });

  test('before anything answers, a token on disk is still a listable host', () => {
    const home = tempDir();
    writeHarnessToken(home, 'apple-venison-rainbow-copper');
    // This is the first `getSettings()` of a launch: `startLocalHarness` has not settled yet, and
    // returning null here is what left Settings → Instances empty on the launch someone looks at.
    expect(localHarnessEndpoint({ state: { kind: 'disabled' }, enabled: true, home })).toEqual({
      url: 'http://127.0.0.1:3002',
      token: 'apple-venison-rainbow-copper',
    });
  });

  test('nothing to list: turned off, or no token anywhere', () => {
    const home = tempDir();
    writeHarnessToken(home, 'present');
    expect(localHarnessEndpoint({ state: { kind: 'started', url: 'http://127.0.0.1:3002', token: 't' }, enabled: false, home })).toBeNull();
    const empty = tempDir();
    expect(localHarnessEndpoint({ state: { kind: 'disabled' }, enabled: true, home: empty })).toBeNull();
  });

  test('a configured remote endpoint and the local harness both survive the merge', () => {
    // The owner's file exactly: one remote, no local entry.
    const merged = mergeLocalHarnessEndpoint(
      [{ id: 'pi:heliograph', label: 'heliograph', url: 'http://100.66.91.124:3002/', token: 'remote' }],
      { url: 'http://127.0.0.1:3002', token: 'local' }
    );
    expect(merged.map((entry) => entry.id)).toEqual(['pi:local', 'pi:heliograph']);
    expect(merged[0]?.label).toBe('This computer');
  });
});


describe('development and isolated profile startup', () => {
  test('development uses the freshly built binary, while an explicit override wins', () => {
    expect(resolveHarnessBinary({ resourcesDir: '/electron', developmentDir: '/checkout' }))
      .toBe(path.join('/checkout', 'build', 'harness', binaryNameFor()));
    expect(resolveHarnessBinary({ resourcesDir: '/electron', developmentDir: '/checkout', binaryName: '/custom/kiln' }))
      .toBe(path.resolve('/custom/kiln'));
  });

  test('an isolated address replaces a saved local endpoint instead of duplicating its id', () => {
    const merged = mergeLocalHarnessEndpoint([
      { id: 'pi:local', label: 'This computer', url: 'http://127.0.0.1:3002', token: 'old' },
    ], { url: 'http://127.0.0.1:43210', token: 'new' });
    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe('http://127.0.0.1:43210');
    expect(localHarnessEndpoint({ state: { kind: 'failed', reason: 'offline' }, enabled: true,
      home: tempDir(), port: 43210, readToken: () => 'new' })?.url).toBe('http://127.0.0.1:43210');
  });

  test('an isolated port is chosen by the OS', async () => {
    const port = await availableHarnessPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test('an asynchronous spawn error becomes a recoverable failure', async () => {
    const binaryDir = tempDir();
    const binary = path.join(binaryDir, binaryNameFor());
    fs.writeFileSync(binary, '#!/missing/ember-audit-interpreter\n', { mode: 0o755 });
    const result = await startLocalHarness({ resourcesDir: binaryDir, home: tempDir(), probe: downProbe });
    expect(result.state.kind).toBe('failed');
    const notice = localHarnessNotice(result.state);
    expect(notice).toContain('Kiln');
    expect(notice).toMatch(/Retry|Settings/);
  });
});


test('an occupied port with the wrong credentials is explained without spawning a rival', async () => {
  let spawned = false;
  const result = await startLocalHarness({ resourcesDir: tempDir(), home: tempDir(),
    probe: async () => ({ ok: false, occupied: true }),
    spawn: (() => { spawned = true; return fakeChild(); }) as never,
  });
  expect(spawned).toBe(false);
  expect(result.state.kind).toBe('failed');
  const notice = localHarnessNotice(result.state);
  expect(notice).toContain('Kiln');
  expect(notice).toContain('3002');
  expect(notice).toMatch(/Settings.*Instances/);
  expect(notice).toContain('Retry');
});


test('stopping retains the data-home lock until the owned child has exited', async () => {
  const resourcesDir = tempDir();
  fs.writeFileSync(path.join(resourcesDir, binaryNameFor()), '#!/bin/sh\n', { mode: 0o755 });
  const home = tempDir();
  const child = fakeChild();
  child.kill = ((signal: string) => { child.killed.push(signal); return true; }) as never;
  let probes = 0;
  const result = await startLocalHarness({ resourcesDir, home, readToken: staticToken(),
    probe: async () => ({ ok: ++probes > 1 }), spawn: (() => child) as never,
  });
  const stopped = result.stop();
  expect(child.killed).toEqual(['SIGTERM']);
  expect(fs.existsSync(path.join(home, 'ember-harness.lock'))).toBe(true);
  let finished = false;
  void stopped.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  (child as unknown as { exit(code: number): void }).exit(0);
  await stopped;
  expect(fs.existsSync(path.join(home, 'ember-harness.lock'))).toBe(false);
});
