import { expect, test } from 'bun:test';
import { loadScheduledIdentityData, runScheduledTask, updateScheduledTaskModel } from './src/api';
import { rememberPiInstances } from './src/piApi';

const calls: Array<{ method: string; path: string }> = [];

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
