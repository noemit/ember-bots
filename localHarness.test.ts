import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  binaryNameFor,
  bundledBinaryPath,
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
      probe: async () => {
        calls += 1;
        return calls === 1 ? { ok: false } : { ok: true, version: '1.2.0' };
      },
      spawn: (() => fakeChild()) as never,
    });
    expect(state.kind).toBe('started');
  });
});
