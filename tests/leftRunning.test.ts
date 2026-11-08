import { describe, expect, test } from 'bun:test';
import {
  forceStopQuestion,
  leftRunningBytes,
  leftRunningLabel,
  leftRunningNotice,
  leftRunningSince,
  stopFailedNotice,
} from '../src/lib/leftRunning';
import type { PiHostMemory, PiLeftProcess } from '../src/lib/piMapping';

const process = (overrides: Partial<PiLeftProcess> = {}): PiLeftProcess => ({
  pid: 934880,
  command: 'vite --port 5179',
  rssBytes: 310 * 1024 * 1024,
  startedAt: Date.now() - 60 * 60 * 1000,
  ...overrides,
});

const memory = (level: PiHostMemory['level']): PiHostMemory => ({
  totalBytes: 16 * 1024 ** 3,
  availableBytes: level === 'normal' ? 8 * 1024 ** 3 : 1024 ** 3,
  level,
});

const notice = (input: Partial<Parameters<typeof leftRunningNotice>[0]> = {}) =>
  leftRunningNotice({
    processes: [process()],
    count: 1,
    rssBytes: 310 * 1024 * 1024,
    memory: memory('normal'),
    ...input,
  });

describe('the three states', () => {
  test('nothing running is not a notice at all', () => {
    expect(notice({ processes: [], count: 0, rssBytes: 0 })).toBeNull();
  });

  test('a healthy machine gets a calm status line', () => {
    const calm = notice()!;
    expect(calm.tone).toBe('calm');
    expect(calm.text).toContain('1 program');
    // It names the agent, and offers the choice rather than claiming a problem: a dev server
    // someone asked for is information.
    expect(calm.text).toContain('This bot has');
    expect(calm.text).toContain('when you no longer need');
    expect(calm.action).toBe('Stop it');
  });

  test('a low machine gets a warning that leads with the cost', () => {
    const low = notice({ memory: memory('low'), hostLabel: 'Heliograph' })!;
    expect(low.tone).toBe('warning');
    expect(low.text).toContain('Heliograph');
    expect(low.text).toContain('low on memory');
    expect(low.text).toContain('310 MB');
    // It says what acting buys, not only that something is wrong.
    expect(low.text).toMatch(/give that back|free/i);
  });

  test('a critical machine escalates differently from a merely low one', () => {
    const low = notice({ memory: memory('low'), hostLabel: 'Heliograph' })!.text;
    const critical = notice({ memory: memory('critical'), hostLabel: 'Heliograph' })!;
    expect(critical.tone).toBe('critical');
    expect(critical.text).not.toBe(low);
    expect(critical.text).toMatch(/nearly out of memory/i);
  });

  test('the count drives the action label, and several programs stop together', () => {
    expect(notice({ count: 2, processes: [process(), process({ pid: 2 })] })!.action).toBe('Stop both');
    expect(notice({ count: 4, processes: [process()] })!.action).toBe('Stop all 4');
  });

  test('rows carry the command, its cost and its age', () => {
    const rows = notice()!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('vite --port 5179');
    expect(rows[0]!.detail).toContain('310 MB');
    expect(rows[0]!.detail).toContain('since');
  });

  test('hidden programs are admitted, never silently dropped', () => {
    const many = notice({ count: 9, processes: [process()] })!;
    expect(many.hidden).toBe(8);
  });
});

describe('copy is the product', () => {
  const all = [
    notice()!.text,
    notice({ memory: memory('low'), hostLabel: 'Moat' })!.text,
    notice({ memory: memory('critical'), hostLabel: 'Moat' })!.text,
    forceStopQuestion(['vite --port 5179']),
    forceStopQuestion(['vite', 'thumbserve.py']),
    stopFailedNotice('Tower', [934880, 934881]),
  ];

  test('no shouting, no jargon, no stack words', () => {
    for (const text of all) {
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/\b(4\d\d|5\d\d|undefined|null|error:|pid \d+ is invalid)\b/i);
    }
  });

  test('a refused stop asks before force, and says what force costs', () => {
    const question = forceStopQuestion(['vite --port 5179']);
    expect(question).toContain('vite --port 5179');
    expect(question).toMatch(/didn't stop/);
    expect(question).toMatch(/unsaved|hasn't saved/);
  });

  test('a failed request says nothing was stopped and gives the command that works', () => {
    const text = stopFailedNotice('Tower', [934880, 934881]);
    // Blames the right party, and names it.
    expect(text).toContain('Tower');
    // The fact that matters: nothing happened.
    expect(text).toMatch(/nothing was stopped/);
    // Never a dead end: a command that works from a terminal.
    expect(text).toContain('kill 934880 934881');
    expect(stopFailedNotice(undefined, [])).toContain('kill <pid>');
  });

  test('each state names what the reader can conclude', () => {
    // Calm says the programs are there and that stopping them is the reader's call.
    expect(notice()!.text).toMatch(/when you no longer need/i);
    expect(notice({ memory: memory('low'), hostLabel: 'Moat' })!.text).toMatch(/low on memory/i);
    expect(forceStopQuestion(['a'])).toMatch(/force stop/i);
  });
});

describe('the small formatters', () => {
  test('sizes a person reads', () => {
    expect(leftRunningBytes(0)).toBe('0 B');
    expect(leftRunningBytes(512)).toBe('1 KB');
    expect(leftRunningBytes(23 * 1024 * 1024)).toBe('23 MB');
    expect(leftRunningBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
  });

  test('a command is one short row', () => {
    expect(leftRunningLabel('node   --flag\n  value')).toBe('node --flag value');
    expect(leftRunningLabel('')).toMatch(/no command line/);
    expect(leftRunningLabel('x'.repeat(200)).length).toBe(60);
  });

  test('an age says today when it is today, and the day when it is older', () => {
    const now = new Date('2026-11-04T20:00:00').getTime();
    const hourAgo = new Date('2026-11-04T18:12:00').getTime();
    const yesterday = new Date('2026-11-03T18:12:00').getTime();
    // Locale-appropriate (this machine renders 12-hour), so the assertion is about the shape: the
    // clock time and its marker, not a hard-coded format.
    expect(leftRunningSince(hourAgo, now)).toMatch(/^since .*12/);
    expect(leftRunningSince(hourAgo, now)).not.toMatch(/Nov/);
    expect(leftRunningSince(yesterday, now)).not.toBe(leftRunningSince(hourAgo, now));
    expect(leftRunningSince(0, now)).toBe('');
  });
});
