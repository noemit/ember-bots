import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScheduledTask } from '../src/api';
import ScheduledView from '../src/components/ScheduledView';
import {
  applyScheduledModelSelection,
  buildScheduledRuns,
  countUnseenScheduledRuns,
  deriveNextRunAt,
  scheduledBadgeTitle,
  scheduledModelConfirmLabel,
  scheduledReadSessions,
  unreadScheduledRunsByTask,
} from '../src/lib/scheduledView';
import { DEFAULT_MODEL, type ModelRef, type Session } from '../src/types';

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

  test('prefers server-computed nextRunAt and falls back to schedule/host timezone across zones', () => {
    // 2026-11-08T08:30:00Z (Sunday): 09:00 Europe/Berlin (08:00Z) has passed, while 09:00 America/New_York (14:00Z) is ahead.
    const now = Date.UTC(2026, 10, 8, 8, 30, 0);
    const serverComputed = Date.UTC(2026, 10, 8, 17, 0, 0);
    const withServerNext = makeTask('server-next', {
      state: { nextRunAt: serverComputed },
      raw: { schedule: { kind: 'daily', time: '09:00', timezone: 'America/Los_Angeles' } },
    });
    expect(deriveNextRunAt(withServerNext, now)).toBe(serverComputed);
    expect(deriveNextRunAt({ ...withServerNext, enabled: false }, now)).toBeNull();

    const berlinDaily = makeTask('berlin-daily', {
      raw: { schedule: { kind: 'daily', time: '09:00', timezone: 'Europe/Berlin' } },
    });
    expect(deriveNextRunAt(berlinDaily, now)).toBe(Date.UTC(2026, 10, 9, 8, 0, 0));

    const nyDaily = makeTask('ny-daily', {
      raw: { schedule: { kind: 'daily', time: '09:00', timezone: 'America/New_York' } },
    });
    expect(deriveNextRunAt(nyDaily, now)).toBe(Date.UTC(2026, 10, 8, 14, 0, 0));

    // Weekly schedule in Asia/Tokyo (UTC+9): at 08:30Z Sunday (17:30 Sunday Tokyo), Monday 09:00 Tokyo is Monday 00:00Z.
    const tokyoWeekly = makeTask('tokyo-weekly', {
      raw: { schedule: { kind: 'weekly', time: '09:00', weekdays: [1], timezone: 'Asia/Tokyo' } },
    });
    expect(deriveNextRunAt(tokyoWeekly, now)).toBe(Date.UTC(2026, 10, 9, 0, 0, 0));

    // Remote host timezone fallback when `schedule.timezone` and `state.nextRunAt` are omitted (or stale).
    const remoteHostZone = makeTask('remote-host-zone', {
      state: { nextRunAt: now - 1000 },
      raw: { timezone: 'America/New_York', schedule: { kind: 'daily', time: '09:00' } },
    });
    expect(deriveNextRunAt(remoteHostZone, now)).toBe(Date.UTC(2026, 10, 8, 14, 0, 0));

    const invalidZone = makeTask('invalid-zone', {
      raw: { schedule: { kind: 'daily', time: '09:00', timezone: 'Mars/Olympus_Mons' } },
    });
    expect(deriveNextRunAt(invalidZone, now)).toBeNull();
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

describe('scheduled model changes vs immediate runs', () => {
  test('ScheduledView Change model updates a paused or overnight plan without triggering runScheduledTask', async () => {
    const pausedPlan = makeTask('nightly', {
      name: '3am database maintenance',
      enabled: false,
      raw: { schedule: { kind: 'daily', time: '03:00' } },
      model: { providerID: 'openai', modelID: 'gpt-4o-mini' },
    });

    const html = renderToStaticMarkup(
      React.createElement(ScheduledView, {
        tasks: [pausedPlan],
        runs: [],
        instances: [{ id: 'pi:local', label: 'Local', kind: 'pi', status: 'ready', attachable: true }],
        silentInstances: [],
        runningTaskKeys: new Set(),
        onOpenSession: () => {},
        onRunTask: () => {},
        onChangeTaskModel: () => {},
        onRetryInstances: () => {},
        retryingInstances: false,
      }),
    );
    expect(html).toContain('aria-label="Run 3am database maintenance now"');
    expect(html).toContain('aria-label="Change model for 3am database maintenance"');
    expect(scheduledModelConfirmLabel(false)).toBe('Done');

    const updatedModels: Array<{ instanceId: string; model: ModelRef }> = [];
    const updatedTasks: ScheduledTask[] = [];
    const notices: string[] = [];
    const errors: string[] = [];
    const refreshed: string[] = [];
    const launchedRuns: ScheduledTask[] = [];

    const outcome = await applyScheduledModelSelection({
      target: { task: pausedPlan, runImmediately: false },
      key: 'anthropic/claude-sonnet-4',
      variant: 'high',
      updateModel: async (instanceId, task, model) => {
        updatedModels.push({ instanceId, model });
        return { ok: true, task: { ...task, model } };
      },
      onUpdated: (task) => updatedTasks.push(task),
      onNotice: (msg) => notices.push(msg),
      onError: (msg) => errors.push(msg),
      onRefreshScheduled: (id) => refreshed.push(id),
      onRunTask: (task) => {
        launchedRuns.push(task);
      },
    });

    expect(outcome.ok).toBe(true);
    expect(updatedModels).toEqual([
      {
        instanceId: 'pi:local',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4', variant: 'high' },
      },
    ]);
    expect(updatedTasks).toHaveLength(1);
    expect(updatedTasks[0].model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      variant: 'high',
    });
    expect(refreshed).toEqual(['pi:local']);
    expect(errors).toEqual([]);
    expect(notices).toEqual([
      'Updated “3am database maintenance” to anthropic/claude-sonnet-4.',
    ]);
    expect(notices[0]).not.toMatch(/starting a run/i);
    expect(launchedRuns).toEqual([]);
  });

  test('rail "Change model & run…" explicitly labels confirmation "Run with model" and launches a run', async () => {
    const failedPlan = makeTask('brief', {
      name: 'Morning brief',
      state: { lastStatus: 'error', lastError: 'model retired' },
    });
    expect(scheduledModelConfirmLabel(true)).toBe('Run with model');

    const notices: string[] = [];
    const launchedRuns: ScheduledTask[] = [];

    const outcome = await applyScheduledModelSelection({
      target: { task: failedPlan, runImmediately: true },
      key: DEFAULT_MODEL,
      variant: '',
      models: {
        defaultModelId: 'anthropic/claude-sonnet-4',
        models: [
          {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4',
            label: 'Claude Sonnet 4',
            details: {
              name: 'Claude Sonnet 4',
              providerName: 'Anthropic',
              reasoning: true,
              toolcall: true,
              attachment: true,
              inputs: ['text'],
              variants: ['low', 'high'],
            },
          },
        ],
      },
      updateModel: async (_instanceId, task, model) => ({ ok: true, task: { ...task, model } }),
      onUpdated: () => {},
      onNotice: (msg) => notices.push(msg),
      onError: () => {},
      onRefreshScheduled: () => {},
      onRunTask: (task) => {
        launchedRuns.push(task);
      },
    });

    expect(outcome.ok).toBe(true);
    expect(notices).toEqual([
      'Updated “Morning brief” to anthropic/claude-sonnet-4 — starting a run.',
    ]);
    expect(launchedRuns).toHaveLength(1);
    expect(launchedRuns[0].model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });
  });
});
