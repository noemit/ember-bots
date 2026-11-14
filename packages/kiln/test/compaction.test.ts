import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { CurrentContextDoc } from '../src/currentContext';
import { createRegistry, Harness, type Storage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { hearthConfig } from '../src/config';
import { startHearthServer, type HearthServer } from '../src/server';

// Real authenticated HTTP + durable scheduler + SQLite, only the model is scripted. No credentials,
// network providers, daily profile or user conversations participate.
const context = BACKGROUND_CONTEXT;
let home: string;
let harness: Harness;
let server: HearthServer;
let storage: Storage;
const models = createModels();
const faux = fauxProvider();
const token = 'isolated-compaction-regression-token';
const api = async (path: string, value?: unknown) => fetch(`${server.url}${path}`, {
  method: value === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
const json = async (path: string, value?: unknown): Promise<any> => {
  const response = await api(path, value);
  expect(response.ok).toBe(true);
  return response.json();
};
const until = async <T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('isolated compaction lifecycle did not settle');
};
const summary = async (id: number) => (await json('/conversations')).conversations.find((item: any) => item.id === id);
const create = async () => (await json('/conversations', { model: { provider: 'faux', modelId: 'faux-1' } })).id as number;
const seed = async (id: number) => {
  for (let index = 0; index < 4; index++) {
    await json(`/conversations/${id}/submit`, { type: 'write', entry: {
      kind: 'test.history', model: [{ role: 'user', content: `history ${index}: ${'prior context '.repeat(90)}`, timestamp: Date.now() }],
    } });
  }
  return until(() => summary(id), (value) => value.currentContextTokens > 500);
};
const compact = async (id: number) => {
  const response = await api(`/conversations/${id}/compact`, {});
  expect(response.status).toBe(202);
  return (await response.json() as { taskId: number }).taskId;
};
const status = (id: number, task: number) => json(`/conversations/${id}/compact/${task}`);
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kiln-compact-api-'));
  models.setProvider(faux.provider);
  storage = await openNodeSqliteStorage(join(home, 'test.sqlite'));
  harness = await Harness.open(storage, { models, registry: createRegistry(),
    settings: { compaction: { enabled: false, keepRecentTokens: 30 }, retry: { enabled: false } } }, context);
  server = startHearthServer({ config: hearthConfig({ home, port: 0, workspace: home }), token,
    storage, harness, models, defaultAgent: { model: { provider: 'faux', modelId: 'faux-1' } } });
});
afterAll(async () => {
  await server.close();
  await harness.close(context);
  await rm(home, { recursive: true, force: true });
});

test('successful API compaction stays running until a summary lands, then resets active context', async () => {
  const id = await create();
  const before = await seed(id);
  const hold = gate();
  let requestText = '';
  faux.setResponses([async (request) => {
    requestText = JSON.stringify(request.messages);
    await hold.promise;
    return fauxAssistantMessage('Preserved decisions and next steps.');
  }]);
  const task = await compact(id);
  try {
    await until(() => status(id, task), (value) => value.status === 'running');
    expect((await summary(id)).compacting).toBe(true);
    expect((await summary(id)).currentContextEpoch).toBe(before.currentContextEpoch);
  } finally { hold.release(); }
  await until(() => status(id, task), (value) => value.status === 'landed');
  const after = await until(() => summary(id), (value) => value.currentContextEpoch !== before.currentContextEpoch);
  expect(after.currentContextTokens).toBeLessThan(before.currentContextTokens);
  expect(after.compacting).toBe(false);
  expect(requestText).toContain('history 0');
  expect(requestText).toContain('ONLY output the structured summary');
  const other = await create();
  expect((await api(`/conversations/${other}/compact/${task}`)).status).toBe(404);
});

test('no-op is terminal evidence, calls no model, and keeps the epoch unchanged', async () => {
  const id = await create();
  const calls = faux.state.callCount;
  const task = await compact(id);
  await until(() => status(id, task), (value) => value.status === 'nothing');
  expect(faux.state.callCount).toBe(calls);
  expect((await summary(id)).currentContextEpoch).toBeUndefined(); // untouched history stays unknown
});

test('post-admission provider failure clears spinner, reports the task error, and never resets context', async () => {
  const id = await create();
  const before = await seed(id);
  const hold = gate();
  faux.setResponses([async () => { await hold.promise;
    return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'isolated provider refused summary' });
  }]);
  const task = await compact(id);
  try { await until(() => summary(id), (value) => value.compacting === true); }
  finally { hold.release(); }
  const failed = await until(() => status(id, task), (value) => value.status === 'failed');
  expect(failed.error).toContain('isolated provider refused summary');
  const after = await summary(id);
  expect(after.compacting).toBe(false);
  expect(after.compactionFailure.taskId).toBe(task);
  expect(after.currentContextEpoch).toBe(before.currentContextEpoch);
  expect(after.currentContextTokens).toBe(before.currentContextTokens);
});

test('running turn is not aborted: completed summary waits for a boundary before epoch/reset success', async () => {
  const id = await create();
  const before = await seed(id);
  const turn = gate();
  let started = false;
  faux.setResponses([
    async () => { started = true; await turn.promise; return fauxAssistantMessage('The running answer survived.'); },
    fauxAssistantMessage('Summary made while the original turn was running.'),
  ]);
  await json(`/conversations/${id}/submit`, { type: 'input', content: 'continue the work' });
  await until(async () => started, Boolean);
  const task = await compact(id);
  try {
    await until(() => status(id, task), (value) => value.status === 'pending');
    const during = await summary(id);
    expect(during.busy).toBe(true);
    expect(during.compacting).toBe(true);
    expect(during.currentContextEpoch).toBe(before.currentContextEpoch);
  } finally { turn.release(); }
  await until(() => status(id, task), (value) => value.status === 'landed');
  await until(() => summary(id), (value) => value.currentContextEpoch !== before.currentContextEpoch && !value.busy);
  const entries = await json(`/conversations/${id}/entries?limit=100`);
  expect(JSON.stringify(entries)).toContain('The running answer survived.');
});

test('a crash-stale snapshot stays unknown after restart; list polls never scan contexts to repair it', async () => {
  const id = await create();
  await seed(id);
  await server.close(); // stop derivation before simulating the missing snapshot publication
  await harness.commit(async (tx) => {
    const doc = await tx.doc(CurrentContextDoc, id as any);
    doc.currentContextTokens = 999999;
    doc.currentContextEpoch = 'pre-reset-stale';
    doc.sourceEntryId = 0;
  }, context);
  await harness.close(context);
  storage = await openNodeSqliteStorage(join(home, 'test.sqlite'));
  harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  let contextReads = 0;
  const original = harness.conversation.bind(harness);
  harness.conversation = async (...args) => {
    const conversation = await original(...args);
    if (!conversation) return conversation;
    return new Proxy(conversation, { get(target, property) {
      if (property === 'context') return async (...parameters: Parameters<typeof conversation.context>) => {
        contextReads++;
        return conversation.context(...parameters);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  server = startHearthServer({ config: hearthConfig({ home, port: 0, workspace: home }), token,
    storage, harness, models, defaultAgent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  for (let poll = 0; poll < 3; poll++) {
    const value = await summary(id);
    expect(value.currentContextTokens).toBeUndefined();
    expect(value.currentContextEpoch).toBeUndefined();
  }
  expect(contextReads).toBe(0);
});
