import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCompactLog } from './electron/compactLog';

/**
 * The compaction log exists for the one case that leaves no other evidence: a request the host
 * accepted and then did nothing about. Two things have to hold — every attempt leaves a line, and
 * the file cannot grow without bound.
 */
describe('ember-compact.log', () => {
  test('appends one line per attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-compact-log-'));
    try {
      const file = join(directory, 'ember-compact.log');
      appendCompactLog(file, 'first attempt outcome=nothing');
      appendCompactLog(file, 'second attempt outcome=landed');
      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('first attempt');
      expect(lines[1]).toContain('second attempt');
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test('one line stays one line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-compact-log-'));
    try {
      const file = join(directory, 'ember-compact.log');
      appendCompactLog(file, 'a line\nwith a newline outcome=nothing');
      const text = await readFile(file, 'utf8');
      expect(text.trim().split('\n')).toHaveLength(1);
      expect(text).toContain('with a newline');
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test('is private to the user', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-compact-log-'));
    try {
      const file = join(directory, 'ember-compact.log');
      appendCompactLog(file, 'attempt');
      const mode = (await stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test('stays bounded when it is hammered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-compact-log-'));
    try {
      const file = join(directory, 'ember-compact.log');
      for (let index = 0; index < 400; index += 1) {
        appendCompactLog(file, `attempt ${index} ${'x'.repeat(200)}`);
      }
      const text = await readFile(file, 'utf8');
      expect(text.length).toBeLessThanOrEqual(32_000 + 400);
      // The newest line survives; the oldest are the ones dropped.
      expect(text).toContain('attempt 399');
      expect(text).not.toContain('attempt 0 ');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
