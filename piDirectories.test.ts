import { expect, test } from 'bun:test';
import { createSession, loadProjects } from './src/api';
import { rememberPiInstances } from './src/piApi';

const calls: Array<{ method: string; path: string }> = [];

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path });
      if (path.startsWith('/directories')) {
        return {
          ok: true,
          status: 200,
          data: {
            workspace: '/workspace',
            path: '/workspace',
            directories: [
              { name: 'vedic', path: '/workspace/vedic' },
              { name: 'ember', path: '/workspace/ember' },
            ],
          },
        };
      }
      if (path === '/conversations' && init?.method === 'POST') {
        return { ok: false, status: 400, data: { error: 'folder does not exist: /workspace/nope' } };
      }
      return { ok: false, status: 404, data: null };
    },
  },
};
rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);

test('loadProjects maps Hearth directories into project options', async () => {
  const projects = await loadProjects('pi:test');
  expect(projects).toEqual([
    { id: '/workspace/vedic', name: 'vedic', path: '/workspace/vedic' },
    { id: '/workspace/ember', name: 'ember', path: '/workspace/ember' },
  ]);
  expect(calls[0]).toEqual({ method: 'GET', path: '/directories' });
});

test('createSession surfaces the Hearth folder error', async () => {
  await expect(createSession('pi:test', '/workspace/nope')).rejects.toThrow('folder does not exist');
});
