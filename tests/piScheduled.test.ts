import { expect, test } from 'bun:test';
import { loadScheduledIdentityData, runScheduledTask, updateScheduledTaskModel } from '../src/api';
import { rememberPiInstances, type PiScheduledTask } from '../src/piApi';
import { mergeScheduledSessionBindings } from '../src/lib/scheduledBindings';
import {
  applyScheduledModelSelection,
  buildScheduledRuns,
  deriveNextRunAt,
  scheduledReadSessions,
  unreadScheduledRunsByTask,
} from '../src/lib/scheduledView';
import { staleScheduledRuns } from '../src/lib/bulkArchive';
import type { Session } from '../src/types';

const calls: Array<{ method: string; path: string }> = [];

let taskOverrides: Partial<PiScheduledTask> = {};

const tasksPayload = () => ({
  timezone: 'UTC',
  tasks: [
    {
      id: 'task_1',
      name: 'Nightly brief',
      prompt: 'Write the brief',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00' },
      cwd: '/workspace/hearth',
      model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
      thinkingLevel: 'high',
      createdAt: 1,
      lastRunAt: 2,
      lastStatus: 'ok',
      lastSessionId: 51,
      ...taskOverrides,
    },
  ],
});

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path });
      if (path === '/scheduled-tasks') return { ok: true, status: 200, data: tasksPayload() };
      if (path.endsWith('/run')) return { ok: true, status: 200, data: { status: 'ok', sessionId: 51 } };
      if (init?.method === 'PATCH') return { ok: true, status: 200, data: { ok: true } };
      return { ok: false, status: 404, data: null };
    },
  },
};
rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);

test('loadScheduledIdentityData maps Hearth tasks and binds their last run session', async () => {
  const data = await loadScheduledIdentityData('pi:test', []);
  expect(data.tasks).toHaveLength(1);
  const task = data.tasks[0];
  expect(task.name).toBe('Nightly brief');
  expect(task.projectId).toBe('/workspace/hearth');
  expect(task.model).toEqual({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant: 'high' });
  expect(task.state.lastStatus).toBe('ok');
  expect(data.bindings['pi:test::51']).toBe(task.key);
  expect(data.taskNames[task.key]).toBe('Nightly brief');
});

test('runScheduledTask posts to the Hearth run route', async () => {
  calls.length = 0;
  const [task] = (await loadScheduledIdentityData('pi:test', [])).tasks;
  const result = await runScheduledTask('pi:test', task);
  expect(result.ok).toBe(true);
  expect(result.sessionId).toBe('51');
  expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toContain('POST /scheduled-tasks/task_1/run');
});

test('updateScheduledTaskModel patches the task model', async () => {
  calls.length = 0;
  const [task] = (await loadScheduledIdentityData('pi:test', [])).tasks;
  const result = await updateScheduledTaskModel('pi:test', task, {
    providerID: 'opencode-go',
    modelID: 'glm-5.3-flash',
    variant: 'high',
  });
  expect(result.ok).toBe(true);
  expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toContain('PATCH /scheduled-tasks/task_1');
});

test('changing a scheduled plan model from ScheduledView patches the model without posting /run', async () => {
  const [task] = (await loadScheduledIdentityData('pi:test', [])).tasks;
  calls.length = 0;

  let ran = false;
  const outcome = await applyScheduledModelSelection({
    target: { task, runImmediately: false },
    key: 'anthropic/claude-sonnet-4',
    variant: 'high',
    updateModel: updateScheduledTaskModel,
    onUpdated: () => {},
    onNotice: () => {},
    onError: () => {},
    onRefreshScheduled: () => {},
    onRunTask: async (updated) => {
      ran = true;
      await runScheduledTask(updated.instanceId, updated);
    },
  });

  expect(outcome.ok).toBe(true);
  expect(ran).toBe(false);
  const endpoints = calls.map((entry) => `${entry.method} ${entry.path}`);
  expect(endpoints).toContain('PATCH /scheduled-tasks/task_1');
  expect(endpoints).not.toContain('POST /scheduled-tasks/task_1/run');
});


test('an offline desktop discovers every fresh run and migrated legacy conversation', async () => {
  taskOverrides = { runSessionIds: [48, 49, 50, 51, 49], conversationId: 47, lastStatus: 'error', lastError: 'latest failed' };
  try {
    const data = await loadScheduledIdentityData('pi:test', []);
    const task = data.tasks[0];
    expect(task.state.runSessionIds).toEqual(['48', '49', '50', '51', '47']);
    expect(task.state.lastSessionId).toBe('51');
    expect(Object.keys(data.bindings).sort()).toEqual([47, 48, 49, 50, 51].map(id => 'pi:test::' + id));
    // Only 47 was observed before going offline. Missed runs must not depend on desktop polling.
    const bindings = mergeScheduledSessionBindings({ 'pi:test::47': task.key }, data.bindings);
    const day = 86_400_000;
    const sessions: Session[] = [47, 48, 49, 50, 51].map(id => ({
      id: String(id), instanceId: 'pi:test', title: 'Run ' + id, updated: id,
      ...(id === 48 ? { archived: 100 } : {}),
    }));
    const unreadKeys = new Set(['pi:test::49']);
    const runs = buildScheduledRuns({ tasks: data.tasks, sessions, bindings, unreadKeys });
    expect(runs).toHaveLength(5);
    // History retains real session records, including hidden runs, for the existing Open action.
    expect(runs.find(run => run.key === 'pi:test::48')?.session).toBe(sessions[1]);
    expect(runs.filter(run => run.unseen).map(run => run.key)).toEqual(['pi:test::49']);
    expect(unreadScheduledRunsByTask(runs)[task.key]?.id).toBe('49');
    // Latest status/time are not incorrectly assigned to earlier fresh conversations.
    expect(runs.find(run => run.key === 'pi:test::50')?.at).toBe(50);
    expect(runs.find(run => run.key === 'pi:test::50')?.status).toBe('succeeded');
    expect(runs.find(run => run.key === 'pi:test::50')?.error).toBeUndefined();
    expect(runs.find(run => run.key === 'pi:test::51')?.status).toBe('failed');
    expect(runs.find(run => run.key === 'pi:test::51')?.at).toBe(2);
    expect(scheduledReadSessions(sessions, bindings)[1].archived).toBe(100);
    const targets = staleScheduledRuns(sessions, bindings,
      { 'pi:test::47': 'idle', 'pi:test::49': 'unread', 'pi:test::50': 'idle', 'pi:test::51': 'busy' },
      new Set(['pi:test::47']), day * 3, new Set(['pi:test::47', 'pi:test::50', 'pi:test::51']));
    expect(targets.map(session => session.id)).toEqual(['50']);
  } finally {
    taskOverrides = {};
  }
});

test('legacy hosts retain both reused and latest conversations without a run ledger', async () => {
  taskOverrides = { conversationId: 40, lastSessionId: 51 };
  try {
    const data = await loadScheduledIdentityData('pi:test', []);
    expect(Object.keys(data.bindings).sort()).toEqual(['pi:test::40', 'pi:test::51']);
    expect(data.tasks[0].state.lastSessionId).toBe('51');
  } finally {
    taskOverrides = {};
  }
});

test('binding refresh retains more than 2000 runs and other hosts across later polls', () => {
  const ledger = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => ['pi:test::' + (i + 1), 'task']));
  const bindings = mergeScheduledSessionBindings({ 'other::1': 'other-task' }, ledger);
  const refreshed = mergeScheduledSessionBindings(bindings, { 'pi:test::2100': 'new-task' });
  expect(Object.keys(refreshed)).toHaveLength(2101);
  expect(refreshed['pi:test::1']).toBe('task');
  expect(refreshed['other::1']).toBe('other-task');
  expect(refreshed['pi:test::2100']).toBe('new-task');
});


test('a legacy reused conversation is bound without inventing a latest run', async () => {
  taskOverrides = { conversationId: 40, lastSessionId: undefined, runSessionIds: [] };
  try {
    const data = await loadScheduledIdentityData('pi:test', []);
    expect(Object.keys(data.bindings)).toEqual(['pi:test::40']);
    expect(data.tasks[0].state.lastSessionId).toBeUndefined();
  } finally {
    taskOverrides = {};
  }
});

test('maps server-computed nextRunAt, host timezone fallback, and reconciled LLM turn errors onto Plans', async () => {
  const now = Date.UTC(2026, 10, 8, 8, 30, 0);
  const serverNext = Date.UTC(2026, 10, 8, 17, 0, 0);
  taskOverrides = {
    nextRunAt: serverNext,
    lastStatus: 'error',
    lastError: '429: Rate limit exceeded',
  };
  try {
    const data = await loadScheduledIdentityData('pi:test', []);
    const task = data.tasks[0];
    expect(task.state.nextRunAt).toBe(serverNext);
    expect(task.state.lastStatus).toBe('error');
    expect(task.state.lastError).toBe('429: Rate limit exceeded');
    expect(deriveNextRunAt(task, now)).toBe(serverNext);
    // Once `serverNext` is behind `now`, falls back to the remote host's `UTC` timezone (`09:00Z` next day).
    expect(deriveNextRunAt(task, serverNext + 1_000)).toBe(Date.UTC(2026, 10, 9, 9, 0, 0));
  } finally {
    taskOverrides = {};
  }
});
