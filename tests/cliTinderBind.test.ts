import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServeEnv, parseArgs } from '../cli/ember';
import { tinderServeEnv } from '../packages/kiln/src/tinder';
import { hearthConfig } from '../packages/kiln/src/config';

const withEnv = <T>(env: NodeJS.ProcessEnv, fn: () => T): T => {
  const keys = ['HEARTH_HOME', 'EMBER_HOME', 'HEARTH_PORT', 'HEARTH_WORKSPACE', 'HEARTH_BIND', 'EMBER_BIND', 'HEARTH_AUTORELOAD', 'NODE_USE_SYSTEM_CA'];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('S4: compiled Tinder and source CLI share serve bind configuration', () => {
  test('explicit --bind overrides pre-upgrade 0.0.0.0 default and inherited env on both entrypoints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ember-tinder-bind-'));
    try {
      // Simulate an upgraded home with an existing hearth.sqlite (whose defaultBind is 0.0.0.0).
      writeFileSync(join(dir, 'hearth.sqlite'), '');
      const { command, flags } = parseArgs(['serve', '--home', dir, '--port', '3099', '--bind', '127.0.0.1']);
      expect(command).toBe('serve');
      expect(flags.bind).toBe('127.0.0.1');

      const baseEnv: NodeJS.ProcessEnv = { HEARTH_BIND: '0.0.0.0', EMBER_BIND: '0.0.0.0' };
      const sourceEnv = buildServeEnv(flags, baseEnv);
      const compiledEnv = tinderServeEnv(flags, baseEnv);

      expect(sourceEnv.HEARTH_BIND).toBe('127.0.0.1');
      expect(compiledEnv.HEARTH_BIND).toBe('127.0.0.1');
      expect(compiledEnv.HEARTH_AUTORELOAD).toBe('0');

      const sourceCfg = withEnv(sourceEnv, () => hearthConfig());
      const compiledCfg = withEnv(compiledEnv, () => hearthConfig());
      expect(sourceCfg.bind).toBe('127.0.0.1');
      expect(compiledCfg.bind).toBe('127.0.0.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit --bind on a fresh home overrides 127.0.0.1 default on both entrypoints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ember-tinder-bind-fresh-'));
    try {
      const { flags } = parseArgs(['serve', '--home', dir, '--bind', '100.64.0.10']);
      const compiledCfg = withEnv(tinderServeEnv(flags, {}), () => hearthConfig());
      expect(compiledCfg.bind).toBe('100.64.0.10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('omitting --bind retains migration default on upgraded homes and loopback default on fresh homes', () => {
    const upgraded = mkdtempSync(join(tmpdir(), 'ember-tinder-bind-upg-'));
    const fresh = mkdtempSync(join(tmpdir(), 'ember-tinder-bind-new-'));
    try {
      writeFileSync(join(upgraded, 'hearth.sqlite'), '');
      const upgFlags = parseArgs(['serve', '--home', upgraded]).flags;
      const freshFlags = parseArgs(['serve', '--home', fresh]).flags;
      expect(withEnv(tinderServeEnv(upgFlags, {}), () => hearthConfig()).bind).toBe('0.0.0.0');
      expect(withEnv(tinderServeEnv(freshFlags, {}), () => hearthConfig()).bind).toBe('127.0.0.1');
    } finally {
      rmSync(upgraded, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
