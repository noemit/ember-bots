import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog, dayKeyOf, parseActivityEntry, parseActivityQuery, type ActivityEntry } from '../electron/activity';
import type { EmberEvent } from '../electron/eventStream';

// Fixed clock so day files and cursors are deterministic.
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const event = (overrides: Partial<EmberEvent> & { id: string }): EmberEvent => ({
  instanceId: 'local',
  stream: 'opencode',
  type: 'session.idle',
  summary: 'went idle',
  at: NOW,
  ...overrides,
});

const eventWithSummary = (id: string, at: number, summary: string, extra: Partial<EmberEvent> = {}): EmberEvent =>
  event({ id, at, summary, ...extra });

const logWith = async (name: string, options: ConstructorParameters<typeof ActivityLog>[1] = {}) => {
  const directory = await mkdtemp(join(tmpdir(), `ember-activity-${name}-`));
  return { directory, log: new ActivityLog(directory, { now: () => NOW, ...options }) };
};

const readLines = async (directory: string): Promise<unknown[]> => {
  const names = await readdir(directory);
  const files = names.filter((name) => name.endsWith('.jsonl')).sort();
  const contents = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')));
  return contents.join('\n').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

test('entries persist as one JSONL line per event, de-duped by id, mode 0600', async () => {
  const { directory, log } = await logWith('persist');
  try {
    log.append(eventWithSummary('e1', NOW, 'started working'));
    log.append(eventWithSummary('e1', NOW, 'started working')); // replayed id — not recorded twice
    log.append(eventWithSummary('e2', NOW + 5, 'finished a turn'));
    expect(log.pendingCount()).toBe(2);
    await log.flush();
    expect(log.pendingCount()).toBe(0);

    const lines = (await readLines(directory)) as ActivityEntry[];
    expect(lines.map((entry) => entry.id)).toEqual(['e1', 'e2']);
    expect(lines[0]).toEqual({
      id: 'e1',
      at: NOW,
      instanceId: 'local',
      directory: undefined,
      sessionId: undefined,
      type: 'session.idle',
      summary: 'started working',
    });
    // Only the persisted lines exist — no transcript content, no payload bodies.
    expect(JSON.stringify(lines)).not.toContain('parts');
    // The log holds session summaries and is deliberately owner-only. NTFS cannot express POSIX
    // permission bits, so the mode assertion is meaningless there - it reports 0o666 for every file.
    // Skipping it (rather than deleting it) keeps the guarantee checked on the platforms that have
    // one, which is what makes a multi-OS CI honest.
    const fileStat = await stat(join(directory, `activity-${dayKeyOf(NOW)}.jsonl`));
    if (process.platform !== 'win32') {
      expect(fileStat.mode & 0o777).toBe(0o600);
    } else {
      expect(fileStat.isFile()).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded fields survive the boundary and malformed lines are dropped', () => {
  const entry = parseActivityEntry({
    id: 'e1', at: NOW, instanceId: 'local', type: 'session.idle', summary: 'went idle',
    directory: '/Users/me/proj', sessionId: 'ses_1',
    detail: { command: 'bun run check', note: 'x'.repeat(500) },
  });
  expect(entry?.detail).toEqual({ command: 'bun run check' }); // oversized value dropped
  expect(entry?.directory).toBe('/Users/me/proj');
  expect(parseActivityEntry({ id: 'e1', at: NOW, instanceId: 'local', type: 'session.idle' })).toBeNull(); // no summary
  expect(parseActivityEntry({ id: 'e1', instanceId: 'local', type: 'x', summary: 'y' })).toBeNull(); // no time
  expect(parseActivityEntry('not an object')).toBeNull();
});

test('events without a summary are not log entries; ids and times are bounded', async () => {
  const { directory, log } = await logWith('nonsmmary');
  try {
    log.append(event({ id: 'e1', summary: undefined })); // a plain invalidation hint
    log.append(event({ id: 'e2', summary: 'x'.repeat(500) })); // summary too long to be trusted
    log.append(eventWithSummary('e3', 0, 'went idle')); // at falls back to the clock
    await log.flush();
    const lines = (await readLines(directory)) as ActivityEntry[];
    expect(lines.map((entry) => entry.id)).toEqual(['e3']);
    expect(lines[0].at).toBe(NOW);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('entries file into local days, sweep drops past retention, days() lists newest first', async () => {
  const { directory, log } = await logWith('days', { retentionDays: 30 });
  try {
    const older = NOW - 40 * 86_400_000;
    const recent = NOW - 5 * 86_400_000;
    log.append(eventWithSummary('old', older, 'ran bash'));
    log.append(eventWithSummary('new', recent, 'ran bash'));
    await log.flush();
    expect((await readdir(directory)).sort()).toEqual([
      `activity-${dayKeyOf(older)}.jsonl`,
      `activity-${dayKeyOf(recent)}.jsonl`,
    ]);
    expect(await log.days()).toEqual([dayKeyOf(recent), dayKeyOf(older)]);

    await log.sweep();
    expect(await log.days()).toEqual([dayKeyOf(recent)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('list pages newest-first across days with a cursor; search and time ranges narrow it', async () => {
  const { directory, log } = await logWith('list');
  try {
    const dayOne = NOW - 86_400_000;
    const dayTwo = NOW;
    log.append(eventWithSummary('a', dayOne + 1, 'ran bash', { detail: { command: 'bun run check' } }));
    log.append(eventWithSummary('b', dayOne + 2, 'waiting for permission', { detail: { action: 'bash', message: 'run tests' } }));
    log.append(eventWithSummary('c', dayTwo + 1, 'finished a turn'));
    log.append(eventWithSummary('d', dayTwo + 2, 'ran bash'));
    log.append(eventWithSummary('e', dayTwo + 3, 'turn failed'));
    await log.flush();

    const first = await log.list({ limit: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(['e', 'd']);
    expect(first.cursor).toBe('2');
    const second = await log.list({ limit: 2, cursor: first.cursor });
    expect(second.entries.map((entry) => entry.id)).toEqual(['c', 'b']);
    const rest = await log.list({ limit: 10, cursor: second.cursor });
    expect(rest.entries.map((entry) => entry.id)).toEqual(['a']);
    expect(rest.cursor).toBeUndefined();

    expect((await log.list({ day: dayKeyOf(dayOne) })).entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect((await log.search('bash')).entries.map((entry) => entry.id)).toEqual(['d', 'b', 'a']);
    expect((await log.search('run tests')).entries.map((entry) => entry.id)).toEqual(['b']);
    expect((await log.list({ from: dayTwo, to: dayTwo + 2 })).entries.map((entry) => entry.id)).toEqual(['d', 'c']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a day that hits its size cap stops recording and says so once', async () => {
  const { directory, log } = await logWith('cap', { maxDayBytes: 700 });
  try {
    for (let index = 0; index < 10; index += 1) {
      log.append(eventWithSummary(`e${index}`, NOW + index, 'ran bash', { detail: { command: `bun run test ${index} `.repeat(6) } }));
    }
    await log.flush();
    const afterFirst = await readLines(directory);
    expect(afterFirst.filter((entry) => (entry as ActivityEntry).type === 'activity.truncated')).toHaveLength(1);
    const recorded = afterFirst.filter((entry) => (entry as ActivityEntry).type === 'session.idle').length;
    expect(recorded).toBeGreaterThan(0);
    expect(recorded).toBeLessThan(10);

    // Further appends for the same day change nothing.
    log.append(eventWithSummary('late', NOW + 100, 'ran bash'));
    await log.flush();
    const afterMore = await readLines(directory);
    expect(afterMore).toHaveLength(afterFirst.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed flush keeps its entries and retries after the blockage clears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ember-activity-retry-'));
  const blocked = join(directory, 'blocked');
  try {
    await writeFile(blocked, 'temporary blocker');
    const log = new ActivityLog(blocked, { now: () => NOW });
    log.append(eventWithSummary('e1', NOW, 'went idle'));
    await expect(log.flush()).rejects.toThrow();
    expect(log.pendingCount()).toBe(1);

    await unlink(blocked);
    await mkdir(blocked, { recursive: true });
    await log.flush();
    expect((await log.list()).entries.map((entry) => entry.id)).toEqual(['e1']);
    // flushSync (the quit path) writes too; a partial failure doesn't double-record on read.
    log.append(eventWithSummary('e2', NOW + 1, 'went idle'));
    log.flushSync();
    expect(log.pendingCount()).toBe(0);
    expect((await log.list()).entries.map((entry) => entry.id)).toEqual(['e2', 'e1']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a query from IPC is validated, not trusted', () => {
  expect(parseActivityQuery(null)).toEqual({});
  expect(parseActivityQuery('nonsense')).toEqual({});
  expect(parseActivityQuery({ day: '2026-10-04', from: 1, to: 2, limit: 50, cursor: '3' }))
    .toEqual({ day: '2026-10-04', from: 1, to: 2, limit: 50, cursor: '3' });
  expect(parseActivityQuery({ day: '../etc', from: -1, to: Number.NaN, limit: 1e9, cursor: 'x; drop table' }))
    .toEqual({});
  expect(parseActivityQuery({ limit: 12.7 })).toEqual({ limit: 13 });
});

test('clear removes every day file and forgets buffered entries', async () => {
  const { directory, log } = await logWith('clear');
  try {
    log.append(eventWithSummary('e1', NOW, 'went idle'));
    log.append(eventWithSummary('e2', NOW - 86_400_000, 'went idle'));
    await log.flush();
    expect(await log.days()).toHaveLength(2);
    await log.clear();
    expect(await log.days()).toEqual([]);
    expect(log.pendingCount()).toBe(0);
    log.append(eventWithSummary('e3', NOW, 'went idle'));
    await log.flush();
    expect((await log.list()).entries.map((entry) => entry.id)).toEqual(['e3']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
