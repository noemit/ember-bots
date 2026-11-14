import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { QuestionsDoc } from '../src/ask';
import { createAgentsTool, registerAgent } from '../src/agents';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage, type Storage, type ConversationId, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { MetaDoc } from '../src/meta';
import { SessionTool, Sessions, SessionsDoc, crewState, spawnSupervisor, SPAWN_RATE_LIMIT, SPAWN_BUDGET } from '../src/sessions';
import { archiveCrew, collectWorkerIds, tick } from '../src/crew';
import { resumeThreads } from '../src/threadSupervisor';
import { resultRetrieved, threadTask } from '../src/threadResults';

const setup = async (storage: Storage = new MemoryStorage()) => {
  const models = createModels();
  const registry = createRegistry(); registry.install(Sessions);
  const harness = await Harness.open(storage, { models, registry }, context);
  const root = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  await harness.commit(async (tx) => { (await tx.doc(MetaDoc, root.id)).title = 'Root'; }, context);
  let task = 0;
  const apiFor = (id: ConversationId) => ({
    taskId: String(++task), conversationId: id, models,
    snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness), conversation: async (id: ConversationId) => {
      const handle = await harness.conversation(id, context);
      return handle && new Proxy(handle, { get(target, prop) {
        if (prop === 'submit') return (...args: unknown[]) => {
          const input = args[0] as { requestId?: string };
          if (input.requestId?.startsWith('hearth.crew.brief:')) return Promise.resolve({ status: async () => ({ status: 'placed' }) });
          return (target.submit as (...args: unknown[]) => unknown)(...args);
        };
        const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    agent: async () => ({ extensions: [Sessions] }),
  } as unknown as ToolExecutionApi);
  const call = (id: ConversationId, args: Parameters<typeof SessionTool.execute>[0]) => SessionTool.execute(args, apiFor(id), context);
  const state = (id: ConversationId) => harness.snapshot(SessionsDoc, id, context);
  const spawn = async (id: ConversationId, name: string) => {
    const result = await call(id, { action: 'spawn', name, brief: 'Deliver ' + name });
    expect(JSON.stringify(result.output)).toContain('Started worker');
    return (await state(id))!.items[name].conversationId;
  };
  const text = (r: Awaited<ReturnType<typeof call>>) => JSON.stringify(r.output);
  const l1 = await spawn(root.id, 'l1');
  const requester = await spawn(l1, 'requester');
  const sibling = await spawn(requester, 'sibling');
  await harness.commit(async (tx) => {
    (await tx.doc(SessionsDoc, root.id)).items.l1.state = 'reported';
    (await tx.doc(SessionsDoc, l1)).items.requester.state = 'reported';
  }, context);
  const notices = async (id: ConversationId) => (await (await harness.conversation(id, context))!.entries({}, 100, undefined, context)).items.filter((e) => e.kind === 'hearth.thread-notice');
  const settle = async () => {
    await harness.commit(async (tx) => {
      await tx.appendEntry(sibling, { kind: 'pi.assistant', model: [fauxAssistantMessage([fauxText('verified outcome')])] });
    }, context);
    await tick(harness, storage, context);
  };
  return { harness, storage, root: root.id, l1, requester, sibling, call, apiFor, text, state, spawn, notices, settle };
};

describe('two worker levels with explicit requester rights', () => {
  test('spawn persists supervisory membership and actual requester; unrelated siblings have no access', async () => {
    const f = await setup();
    try {
      expect(await f.harness.snapshot(MetaDoc, f.sibling, context)).toMatchObject({ creatorId: f.requester, lead: { conversationId: f.l1 }, delegates: true });
      const alias = Object.values((await f.state(f.l1))!.items).find((e) => e.conversationId === f.sibling)!;
      expect(alias.taskOwner).toEqual({ conversationId: f.requester, key: 'sibling' });
      const stranger = await f.spawn(f.l1, 'stranger');
      for (const action of ['read', 'status', 'results', 'stop', 'message', 'wait'] as const) {
        expect(f.text(await f.call(stranger, { action, name: 'sibling', message: 'unauthorized' }))).toMatch(/No (thread|session)/);
      }
      expect(f.text(await f.call(f.requester, { action: 'read', name: 'sibling' }))).toContain('citation');
      expect(f.text(await f.call(f.l1, { action: 'status', name: alias.title }))).toContain('starting');
      expect(await collectWorkerIds(f.harness, f.requester, context)).not.toContain(f.sibling);
      expect(await collectWorkerIds(f.harness, f.l1, context)).toContain(f.sibling);
    } finally { await f.harness.close(context); }
  });
  test('first waiter wins, one outcome notice, and retrieval remains separate from notice receipts', async () => {
    const f = await setup();
    try {
      expect((await f.call(f.requester, { action: 'wait', name: 'sibling' })).control?.terminate).toBe(true);
      const title = (await f.state(f.requester))!.items.sibling.title;
      expect((await f.call(f.l1, { action: 'wait', name: title })).control).toBeUndefined();
      expect((await f.state(f.l1))!.suspended).not.toBe(true);
      await f.settle();
      expect(await f.notices(f.requester)).toHaveLength(1);
      expect(await f.notices(f.l1)).toHaveLength(0);
      const item = (await f.state(f.requester))!.items.sibling;
      expect(resultRetrieved(item)).toBe(false);
      expect(item.notifiedResult).toBe(item.report!.requestId);
      expect(f.text(await f.call(f.l1, { action: 'results', name: title }))).toContain('verified outcome');
      expect(resultRetrieved((await f.state(f.requester))!.items.sibling)).toBe(true);
      await tick(f.harness, f.storage, context);
      expect(await f.notices(f.requester)).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
  test('supervisor can stop the requested sibling and update the authoritative task, not just its reference', async () => {
    const f = await setup();
    try {
      const title = (await f.state(f.requester))!.items.sibling.title;
      expect(f.text(await f.call(f.l1, { action: 'stop', name: title }))).toContain('Stopped');
      const task = (await f.state(f.requester))!.items.sibling;
      expect(task.state).toBe('stopped'); expect(task.report?.status).toBe('aborted');
      expect(task.report?.requestId).toContain(threadTask(task));
      expect(f.text(await f.call(f.requester, { action: 'results' }))).toContain('stopped');
    } finally { await f.harness.close(context); }
  });
  test('requester archive does not cancel siblings; supervisor archive does', async () => {
    const f = await setup();
    try {
      await archiveCrew(f.harness, f.requester, Date.now(), undefined, context);
      expect((await f.harness.snapshot(MetaDoc, f.sibling, context))?.archived).toBeUndefined();
      await archiveCrew(f.harness, f.l1, Date.now(), undefined, context);
      expect((await f.harness.snapshot(MetaDoc, f.sibling, context))?.archived).toBeDefined();
      expect((await f.state(f.requester))!.items.sibling.state).toBe('stopped');
    } finally { await f.harness.close(context); }
  });
  test.each(['burst', 'budget', 'wake'] as const)('sibling spawn obeys shared supervisor %s safeguard', async (guard) => {
    const f = await setup();
    try {
      await f.harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc, f.l1);
        if (guard === 'burst') doc.spawnedAt = Array(SPAWN_RATE_LIMIT).fill(Date.now());
        if (guard === 'budget') doc.spawnedAt = Array(SPAWN_BUDGET).fill(Date.now() - 120_000);
        if (guard === 'wake') { doc.woke = true; doc.wokeAt = Date.now(); }
      }, context);
      expect(f.text(await f.call(f.requester, { action: 'spawn', name: 'denied', brief: 'work' }))).toContain('Refused');
      expect((await f.state(f.requester))!.items.denied).toBeUndefined();
    } finally { await f.harness.close(context); }
  });
  test('stale cross-supervisor references fail closed', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async (tx) => { (await tx.doc(MetaDoc, f.sibling)).lead!.conversationId = f.root; }, context);
      const resolved = await crewState((id) => f.state(id), f.l1, (id) => f.harness.snapshot(MetaDoc, id, context));
      expect(Object.values(resolved!.items).some((e) => e.conversationId === f.sibling)).toBe(false);
    } finally { await f.harness.close(context); }
  });
  test.each(['idle', 'stopped', 'archived', 'failed'] as const)('routes %s requester outcomes exactly once, never to root', async (terminal) => {
    const f = await setup();
    try {
      await f.call(f.requester, { action: 'wait', name: 'sibling' });
      await f.harness.commit(async (tx) => {
        if (terminal === 'archived') (await tx.doc(MetaDoc, f.requester)).archived = Date.now();
        if (terminal === 'stopped') (await tx.doc(SessionsDoc, f.l1)).items.requester.state = 'stopped';
        if (terminal === 'failed') (await tx.doc(SessionsDoc, f.l1)).items.requester.state = 'failed';
      }, context);
      await f.settle();
      const recipient = terminal === 'idle' ? f.requester : f.l1;
      expect(await f.notices(recipient)).toHaveLength(1);
      expect(await f.notices(terminal === 'idle' ? f.l1 : f.requester)).toHaveLength(0);
      expect(await f.notices(f.root)).toHaveLength(0);
      await tick(f.harness, f.storage, context);
      expect(await f.notices(recipient)).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
  test('sibling blockers and failures notify once without a wait and never answer human prompts', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async (tx) => {
        (await tx.doc(QuestionsDoc, f.sibling)).items.q = { key: 'q', conversationId: String(f.sibling),
          question: 'Which account?', options: [], status: 'pending' };
      }, context);
      await resumeThreads(f.harness, f.requester, (await f.state(f.requester))!, Date.now(), context);
      expect(await f.notices(f.requester)).toHaveLength(1);
      expect((await f.harness.snapshot(QuestionsDoc, f.sibling, context))!.items.q.status).toBe('pending');
      // A second scan cannot duplicate the delivered blocker.
      await resumeThreads(f.harness, f.requester, (await f.state(f.requester))!, Date.now(), context);
      expect(await f.notices(f.requester)).toHaveLength(1);
      expect(await f.notices(f.l1)).toHaveLength(0);
    } finally { await f.harness.close(context); }
    const g = await setup();
    try {
      await g.harness.commit(async (tx) => {
        const item = (await tx.doc(SessionsDoc, g.requester)).items.sibling;
        item.state = 'failed'; item.report = { requestId: 'failure-version', status: 'failed', text: 'failure details', at: 1 };
      }, context);
      await tick(g.harness, g.storage, context);
      expect(await g.notices(g.requester)).toHaveLength(1);
      expect(JSON.stringify(await g.notices(g.requester))).not.toContain('failure details');
      expect(await g.notices(g.l1)).toHaveLength(0);
    } finally { await g.harness.close(context); }
  });
  test('shared references, subscription and receipt survive SQLite restart without duplicate settlement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiln-two-level-'));
    const path = join(dir, 'state.sqlite');
    const f = await setup(await openNodeSqliteStorage(path));
    await f.call(f.requester, { action: 'wait', name: 'sibling' });
    await f.harness.close(context);
    const storage = await openNodeSqliteStorage(path);
    const registry = createRegistry(); registry.install(Sessions);
    const h = await Harness.open(storage, { models: createModels(), registry }, context);
    try {
      await h.commit(async (tx) => { await tx.appendEntry(f.sibling, { kind: 'pi.assistant',
        model: [fauxAssistantMessage([fauxText('restart outcome')])] }); }, context);
      await tick(h, storage, context);
      const item = (await h.snapshot(SessionsDoc, f.requester, context))!.items.sibling;
      expect(item.creatorId).toBe(f.requester); expect(item.notifiedResult).toBe(item.report!.requestId);
      const resolved = await crewState((id) => h.snapshot(SessionsDoc, id, context), f.l1, (id) => h.snapshot(MetaDoc, id, context));
      expect(Object.values(resolved!.items).find((e) => e.conversationId === f.sibling)?.report?.text).toBe('restart outcome');
      await tick(h, storage, context);
      const entries = (await (await h.conversation(f.requester, context))!.entries({}, 100, undefined, context)).items;
      expect(entries.filter((e) => e.kind === 'hearth.thread-result')).toHaveLength(1);
      expect(entries.filter((e) => e.kind === 'hearth.thread-notice')).toHaveLength(1);
    } finally { await h.close(context); await rm(dir, { recursive: true, force: true }); }
  });
  test('delivery-less sibling keeps legacy report delivery with no mirrored supervisor digest', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async (tx) => { delete (await tx.doc(SessionsDoc, f.requester)).items.sibling.delivery; }, context);
      await f.settle();
      const entries = (await (await f.harness.conversation(f.requester, context))!.entries({}, 100, undefined, context)).items;
      expect(entries.some((e) => e.kind === 'hearth.crew-report')).toBe(true);
      expect(await f.notices(f.l1)).toHaveLength(0);
      const supervisorEntries = (await (await f.harness.conversation(f.l1, context))!.entries({}, 100, undefined, context)).items;
      expect(supervisorEntries.some((e) => e.kind === 'hearth.crew-report')).toBe(false);
    } finally { await f.harness.close(context); }
  });
  test('directory aliases retain creator and supervisor authorization but reject arbitrary siblings', async () => {
    const f = await setup();
    const home = await mkdtemp(join(tmpdir(), 'kiln-two-level-agents-'));
    try {
      const stranger = await f.spawn(f.l1, 'stranger');
      await f.harness.commit((tx) => registerAgent(tx, 'Directory alias', {
        conversationId: f.sibling as number, host: 'local', pinned: false, createdAt: 1, updatedAt: 1,
      }), context);
      const tool = createAgentsTool(home);
      for (const sender of [f.requester, f.l1]) {
        const result = await tool.execute({ action: 'send', name: 'Directory alias', message: 'authorized follow-up', followUp: true }, f.apiFor(sender), context);
        expect(JSON.stringify(result.output)).toContain('Sent to');
      }
      const denied = await tool.execute({ action: 'send', name: 'Directory alias', message: 'unauthorized' }, f.apiFor(stranger), context);
      expect(JSON.stringify(denied.output)).toContain('Refused');
      expect(JSON.stringify(denied.output)).toContain('Directory alias');
    } finally { await f.harness.close(context); await rm(home, { recursive: true, force: true }); }
  });
  test('delivering one subscribed task does not clear suspension for another pending task', async () => {
    const f = await setup();
    try {
      await f.spawn(f.requester, 'another');
      await f.call(f.requester, { action: 'wait' });
      await f.harness.commit(async (tx) => {
        const item = (await tx.doc(SessionsDoc, f.requester)).items.sibling;
        item.state = 'reported'; item.report = { status: 'ok', requestId: 'one-result', text: 'one outcome', at: 1 };
      }, context);
      await resumeThreads(f.harness, f.requester, (await f.state(f.requester))!, Date.now(), context);
      expect((await f.state(f.requester))!.suspended).toBe(true);
      expect((await f.state(f.requester))!.items.sibling.notifiedResult).toBe('one-result');
    } finally { await f.harness.close(context); }
  });
  test('parallel replay of the same spawn handle creates one task and one supervisory membership', async () => {
    const f = await setup();
    try {
      await Promise.all([1, 2].map(() => f.call(f.requester, { action: 'spawn', name: 'concurrent', brief: 'one task' })));
      const item = (await f.state(f.requester))!.items.concurrent;
      const membership = Object.values((await f.state(f.l1))!.items).filter((entry) => entry.conversationId === item.conversationId);
      expect(membership).toHaveLength(1);
      expect((await f.storage.scanConversations({}, 100, undefined, context)).items).toHaveLength(5);
    } finally { await f.harness.close(context); }
  });
  test('missing and cyclic ancestry fail closed; promoted peers start a new root; old deep trees flatten', async () => {
    const id = (n: number) => n as ConversationId;
    const metas = new Map([[1, {}], [2, { kind: 'worker' as const, lead: { conversationId: 1, host: 'local' } }], [3, { kind: 'worker' as const, lead: { conversationId: 2, host: 'local' } }], [4, { kind: 'worker' as const, lead: { conversationId: 3, host: 'local' } }]]);
    const read = async (key: ConversationId) => metas.get(key);
    expect(await spawnSupervisor(read, id(4))).toEqual({ supervisor: id(2), depth: 2 });
    metas.set(2, { kind: 'worker', lead: { conversationId: 3, host: 'local' } });
    expect(await spawnSupervisor(read, id(4))).toBeUndefined();
    metas.delete(2); expect(await spawnSupervisor(read, id(4))).toBeUndefined();
    expect(await spawnSupervisor(async () => ({ kind: 'worker' }), id(1))).toBeUndefined();
    expect(await spawnSupervisor(async () => ({ kind: 'peer', lead: { conversationId: 1, host: 'local' } }), id(4))).toEqual({ supervisor: id(4), depth: 1 });
  });
});
