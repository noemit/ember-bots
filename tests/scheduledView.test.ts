import { describe, expect, test } from 'bun:test';
import type { ScheduledTask } from '../src/api';
import {
  buildScheduledRuns,
  countUnseenScheduledRuns,
  deriveNextRunAt,
  scheduledBadgeTitle,
  scheduledReadSessions,
  unreadScheduledRunsByTask,
} from '../src/lib/scheduledView';
import type { Session } from '../src/types';

const makeTask = (id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  key: `task:pi:local::/work::${id}`,
  instanceId: 'pi:local',
  projectId: '/work',
  projectName: 'work',
  id,
  name: `Task ${id}`,
  enabled: true,
  state: {},
  raw: { schedule: { kind: 'daily', time: '09:00' } },
  ...overrides,
});

const makeSession = (id: string, updated: number, extra: Partial<Session> = {}): Session => ({
  id,
  instanceId: 'pi:local',
  title: `Run ${id}`,
  updated,
  lastEntryId: 10,
  ...extra,
});

describe('buildScheduledRuns and notification counter', () => {
  test('orders runs newest first across tasks and bindings', () => {
    const t1 = makeTask('t1', { state: { lastSessionId: 's2', lastRunAt: 2000, lastStatus: 'ok' } });
    const t2 = makeTask('t2', { state: { lastSessionId: 's3', lastRunAt: 3000, lastStatus: 'error', lastError: 'timeout' } });
    const sessions = [makeSession('s1', 1000), makeSession('s2', 2000), makeSession('s3', 3000)];
    const bindings = {
      'pi:local::s1': t1.key,
      'pi:local::s2': t1.key,
      'pi:local::s3': t2.key,
    };

    const runs = buildScheduledRuns({ tasks: [t1, t2], sessions, bindings });
    expect(runs.map((r) => r.key)).toEqual(['pi:local::s3', 'pi:local::s2', 'pi:local::s1']);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toBe('timeout');
    expect(runs[1].status).toBe('succeeded');
  });

  test('counts only finished runs that have not been seen yet, never running ones or tasks without runs', () => {
    const tIdle = makeTask('idle');
    const tRunning = makeTask('run', { state: { lastSessionId: 's-run', lastRunAt: 4000 } });
    const tDone = makeTask('done', { state: { lastSessionId: 's-done', lastRunAt: 3000, lastStatus: 'ok' } });
    const tSeen = makeTask('seen', { state: { lastSessionId: 's-seen', lastRunAt: 2500, lastStatus: 'ok' } });

    const sessions = [
      makeSession('s-run', 4000, { lastEntryId: 5 }),
      makeSession('s-done', 3000, { lastEntryId: 8 }),
      makeSession('s-seen', 2500, { lastEntryId: 12 }),
    ];
    const bindings = {
      'pi:local::s-run': tRunning.key,
      'pi:local::s-done': tDone.key,
      'pi:local::s-seen': tSeen.key,
    };

    const runs = buildScheduledRuns({
      tasks: [tIdle, tRunning, tDone, tSeen],
      sessions,
      bindings,
      states: { 'pi:local::s-run': 'active', 'pi:local::s-done': 'idle', 'pi:local::s-seen': 'idle' },
      readMarks: { 'pi:local::s-seen': { through: 12 } },
      seenBaselineAt: 1000,
    });

    expect(runs).toHaveLength(3);
    expect(countUnseenScheduledRuns(runs)).toBe(1);
    expect(scheduledBadgeTitle(1)).toBe('1 scheduled run has unread messages');
  });

  test('derives nextRunAt for daily and once schedules and returns null when paused', () => {
    const now = Date.UTC(2026, 10, 5, 8, 0, 0);
    const onceFuture = makeTask('once', { raw: { schedule: { kind: 'once', at: now + 60_000 } } });
    expect(deriveNextRunAt(onceFuture, now)).toBe(now + 60_000);

    const paused = makeTask('paused', { enabled: false, raw: { schedule: { kind: 'once', at: now + 60_000 } } });
    expect(deriveNextRunAt(paused, now)).toBeNull();
  });
});


test('muting a scheduled run suppresses its notification without recording it read', () => {
  const task = makeTask('brief', { state: { lastSessionId: 'run', lastRunAt: 2000 } });
  const session = makeSession('run', 2000);
  const marks = { 'pi:local::run': { through: 2 } };
  const input = { tasks: [task], sessions: [session], bindings: {}, readMarks: marks };
  expect(countUnseenScheduledRuns(buildScheduledRuns(input))).toBe(1);
  expect(countUnseenScheduledRuns(buildScheduledRuns({ ...input, mutedSessions: ['pi:local::run'] }))).toBe(0);
  expect(marks['pi:local::run'].through).toBe(2);
  expect(countUnseenScheduledRuns(buildScheduledRuns(input))).toBe(1);
});


test('scheduled counters and plans use explicit message marks, regardless of startup time', () => {
  const task = makeTask('brief', { state: { lastSessionId: 'new', lastRunAt: 3000 } });
  const sessions = [makeSession('old', 1000), makeSession('new', 3000)];
  const input = {
    tasks: [task], sessions, bindings: { 'pi:local::old': task.key },
    seenBaselineAt: 5000,
    unreadKeys: new Set(['pi:local::old']),
  };
  const runs = buildScheduledRuns(input);
  expect(countUnseenScheduledRuns(runs)).toBe(1);
  expect(unreadScheduledRunsByTask(runs)[task.key].id).toBe('old');
  expect(countUnseenScheduledRuns(buildScheduledRuns({ ...input, unreadKeys: new Set() }))).toBe(0);
  expect(countUnseenScheduledRuns(buildScheduledRuns({ ...input, states: { 'pi:local::old': 'active' } }))).toBe(0);
});

test('new scheduled output after an archive is eligible, but archiving after output stays respected', () => {
  const sessions = [
    makeSession('new-output', 3000, { archived: 2000 }),
    makeSession('archived-after', 1000, { archived: 2000 }),
    makeSession('ordinary', 3000, { archived: 2000 }),
  ];
  const readable = scheduledReadSessions(sessions, {
    'pi:local::new-output': 'task', 'pi:local::archived-after': 'task',
  });
  expect(readable[0].archived).toBeUndefined();
  expect(readable[1].archived).toBe(2000);
  expect(readable[2].archived).toBe(2000);
  expect(sessions[0].archived).toBe(2000);
});
