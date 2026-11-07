import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxText, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { configure, createRegistry, Harness, MemoryStorage, type Storage, type ConversationId, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { SessionsDoc, SessionTool, type CrewEntry } from '../src/sessions';
import { QuestionsDoc } from '../src/ask';
import { recordRetrieved, threadCompletionDue, threadTask } from '../src/threadResults';
import { tick } from '../src/crew';

const context = BACKGROUND_CONTEXT;
const setup = async (storage: Storage = new MemoryStorage()) => {
  const models = createModels();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  // No resume: submitted notices are durably placed, but no real model is called.
  const leader = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const worker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  await harness.commit(async (tx) => {
    for (let index = 0; index < 30; index += 1) await tx.appendEntry(worker.id, {
      kind: 'pi.assistant', model: [fauxAssistantMessage([fauxText(`Evidence ${index}`)])],
    });
    const doc = await tx.doc(SessionsDoc, leader.id);
    doc.generation = 1;
    doc.items.login = {
      kind: 'worker', conversationId: worker.id, title: 'Investigate the login failure',
      spawnedAt: 1, state: 'running', generation: 1, briefRequestId: 'brief', delivery: 'thread',
    };
  }, context);
  const api = {
    taskId: 'thread-test-message',
    conversationId: leader.id, snapshot: harness.snapshot.bind(harness),
    commit: harness.commit.bind(harness), conversation: harness.conversation.bind(harness),
  } as unknown as ToolExecutionApi;
  const call = (args: Parameters<typeof SessionTool.execute>[0]) => SessionTool.execute(args, api, context);
  const state = () => harness.snapshot(SessionsDoc, leader.id, context);
  const entries = async () => (await (await harness.conversation(leader.id, context))!.entries({}, 100, undefined, context)).items;
  return { harness, storage, models, leader, worker, api, call, state, entries };
};

describe('background thread coordination', () => {
  test('records the result once without a transcript report or unsolicited continuation', async () => {
    const f = await setup();
    try {
      await tick(f.harness, f.storage, context);
      const entry = (await f.state())!.items.login!;
      expect(entry.state).toBe('reported');
      expect(entry.report?.text).toBe('Evidence 29');
      expect(entry.report?.entryId).toBeDefined();
      expect((await f.entries()).filter((entry) => entry.kind !== 'hearth.thread-result')).toHaveLength(0);
      const result = entry.report?.requestId;
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-result')).toHaveLength(1);
      expect(JSON.stringify(await f.entries())).not.toContain('Evidence 29');
      await tick(f.harness, f.storage, context);
      expect((await f.state())!.items.login!.report?.requestId).toBe(result);
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-result')).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
  test('wait registers a durable version subscription and releases the foreground without polling', async () => {
    const f = await setup();
    try {
      const result = await f.call({ action: 'wait' });
      expect(result.control?.terminate).toBe(true);
      expect((await f.state())!.items.login!.resumeTask).toBe(threadTask((await f.state())!.items.login!));
      await tick(f.harness, f.storage, context);
      const entries = await f.entries();
      expect(entries.filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(1);
      expect(entries.some((entry) => entry.kind === 'hearth.crew-report' || entry.kind === 'pi.user')).toBe(false);
      expect(JSON.stringify(entries)).not.toContain('Evidence 29');
      await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
  test('retrieving an available result suppresses later continuation, independently of verification', async () => {
    const f = await setup();
    try {
      await tick(f.harness, f.storage, context);
      const result = await f.call({ action: 'results', name: 'login' });
      expect(JSON.stringify(result.output)).toContain(`/threads/${f.worker.id}`);
      expect(JSON.stringify(result.output)).toContain('Evidence 29');
      await f.call({ action: 'wait' });
      await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter((entry) => entry.kind !== 'hearth.thread-result')).toHaveLength(0);
      expect((await f.state())!.items.login!.retrievedResult).toBe((await f.state())!.items.login!.report!.requestId);
    } finally { await f.harness.close(context); }
  });
  test('a read is bounded and cursor pages do not overlap or mark a result retrieved', async () => {
    const f = await setup();
    try {
      const first = await f.call({ action: 'read', name: 'login' });
      const page = JSON.parse((first.output![0] as { text: string }).text);
      expect(page.entries).toHaveLength(12);
      expect(page.next).toBeTruthy();
      const next = await f.call({ action: 'read', name: 'login', cursor: page.next });
      const page2 = JSON.parse((next.output![0] as { text: string }).text);
      expect(page2.entries.some((entry: { id: number }) => page.entries.some((old: { id: number }) => old.id === entry.id))).toBe(false);
      expect((await f.state())!.items.login!.retrievedResult).toBeUndefined();
    } finally { await f.harness.close(context); }
  });
  test('incremental reads return only new evidence and reject malformed cursors with a recovery', async () => {
    const f = await setup();
    try {
      const first = JSON.parse((await f.call({ action: 'read', name: 'login' })).output!.map((part) => 'text' in part ? part.text : '').join(''));
      await f.harness.commit(async (tx) => { await tx.appendEntry(f.worker.id, { kind: 'pi.assistant',
        model: [fauxAssistantMessage([fauxText('New evidence')])] }); }, context);
      const delta = await f.call({ action: 'read', name: 'login', since: String(first.newestEntry) });
      const page = JSON.parse((delta.output![0] as { text: string }).text);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0].evidence).toContain('New evidence');
      const invalid = await f.call({ action: 'read', name: 'login', cursor: 'invalid-cursor' });
      expect(JSON.stringify(invalid.output)).toContain('fresh page');
    } finally { await f.harness.close(context); }
  });
  test('human blockers wake without a completion subscription and do not approve anything', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc, f.leader.id);
        doc.items.login!.state = 'starting';
        doc.items.login!.spawnedAt = Date.now();
        doc.items.login!.answerFrom = 999999;
        (await tx.doc(QuestionsDoc, f.worker.id)).items.q = {
          key: 'q', conversationId: String(f.worker.id), question: 'Which account?', options: [], status: 'pending',
        };
        (await tx.doc(QuestionsDoc, f.worker.id)).items.q2 = {
          key: 'q2', conversationId: String(f.worker.id), question: 'Which region?', options: [], status: 'pending',
        };
      }, context);
      await tick(f.harness, f.storage, context);
      expect(JSON.stringify(await f.entries())).toContain('needs the human');
      expect((await f.harness.snapshot(QuestionsDoc, f.worker.id, context))!.items.q!.status).toBe('pending');
      f.harness.resume();
      await (await f.harness.conversation(f.leader.id, context))!.waitForIdle(context);
      await f.harness.commit(async (tx) => {
        const questions = await tx.doc(QuestionsDoc, f.worker.id);
        questions.items.q!.status = 'answered';
        questions.items.q!.answer = 'Personal';
      }, context);
      await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
  test('subscriptions and completion receipts survive reopening the harness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-threads-'));
    const path = join(directory, 'hearth.sqlite');
    const f = await setup(await openNodeSqliteStorage(path));
    await f.call({ action: 'wait' });
    await f.harness.close(context);
    let storage = await openNodeSqliteStorage(path);
    let recovered = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    await tick(recovered, storage, context);
    expect((await recovered.snapshot(SessionsDoc, f.leader.id, context))!.items.login!.notifiedResult).toBeDefined();
    await recovered.close(context);
    storage = await openNodeSqliteStorage(path);
    recovered = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    try {
      await tick(recovered, storage, context);
      const entries = await (await recovered.conversation(f.leader.id, context))!.entries({}, 100, undefined, context);
      expect(entries.items.filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(1);
    } finally {
      await recovered.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('foreground human input takes precedence and completion resumes after it clears', async () => {
    const f = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const faux = fauxProvider();
      f.models.setProvider(faux.provider);
      faux.setResponses([async () => { await gate; return fauxAssistantMessage([fauxText('New goal understood')]); }]);
      await f.harness.commit(async (tx) => { await configure(tx, f.leader.id, { model: { provider: 'faux', modelId: 'faux-1' } }); }, context);
      f.harness.resume();
      await f.call({ action: 'wait' });
      const leader = (await f.harness.conversation(f.leader.id, context))!;
      await leader.submit({ type: 'input', content: 'Change the goal first' }, context);
      await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(0);
      expect((await f.state())!.items.login!.notifiedResult).toBeUndefined();
      release();
      await leader.waitForIdle(context);
      await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(1);
    } finally { release(); await f.harness.close(context); }
  });
  test('failure wakes without a subscription, with metadata rather than duplicated failure prose', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async (tx) => {
        await tx.appendEntry(f.worker.id, { kind: 'pi.assistant',
          model: [fauxAssistantMessage([fauxText('Detailed failure evidence')], { stopReason: 'error' })] });
      }, context);
      await tick(f.harness, f.storage, context);
      expect((await f.state())!.items.login!.state).toBe('failed');
      expect((await f.entries()).filter((entry) => entry.kind === 'hearth.thread-notice')).toHaveLength(1);
      expect(JSON.stringify(await f.entries())).not.toContain('Detailed failure evidence');
    } finally { await f.harness.close(context); }
  });
  test('replayed task messages keep the same version and capture evidence before fast replies', async () => {
    const f = await setup();
    try {
      await tick(f.harness, f.storage, context);
      const evidenceEntry = (await f.state())!.items.login!.report!.entryId;
      await f.call({ action: 'message', name: 'login', message: 'Investigate refresh next' });
      const first = (await f.state())!.items.login!;
      expect(first.answerFrom).toBe(evidenceEntry);
      const version = threadTask(first);
      await f.call({ action: 'message', name: 'login', message: 'Investigate refresh next' });
      expect(threadTask((await f.state())!.items.login!)).toBe(version);
      const entries = await (await f.harness.conversation(f.worker.id, context))!.entries({}, 100, undefined, context);
      expect(entries.items.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });
  test('nested threads can yield while their children run without being reported as failed', async () => {
    const f = await setup();
    try {
      const child = await f.harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
      await f.harness.commit(async (tx) => {
        await tx.appendEntry(child.id, { kind: 'pi.user', model: [{ role: 'user', content: 'Investigate evidence', timestamp: Date.now() }] });
        const doc = await tx.doc(SessionsDoc, f.worker.id);
        doc.generation = 1;
        doc.items.child = { kind: 'worker', delivery: 'thread', conversationId: child.id, title: 'Gather evidence',
          spawnedAt: Date.now(), state: 'starting', generation: 1, briefRequestId: 'child-brief' };
        await tx.appendEntry(f.worker.id, { kind: 'pi.tool-result', data: { tool: 'session', action: 'wait' } });
      }, context);
      await SessionTool.execute({ action: 'wait' }, { ...f.api, conversationId: f.worker.id }, context);
      await tick(f.harness, f.storage, context);
      expect((await f.state())!.items.login!.state).toBe('running');
      expect((await f.state())!.items.login!.report).toBeUndefined();
      await f.harness.commit(async (tx) => {
        await tx.appendEntry(child.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([fauxText('Evidence gathered')])] });
      }, context);
      await tick(f.harness, f.storage, context);
      expect((await f.harness.snapshot(SessionsDoc, f.worker.id, context))!.suspended).toBe(false);
      f.harness.resume();
      await (await f.harness.conversation(f.worker.id, context))!.waitForIdle(context);
      await f.harness.commit(async (tx) => {
        await tx.appendEntry(f.worker.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([fauxText('Final checked outcome')])] });
        await tx.appendEntry(f.worker.id, { kind: 'hearth.thread-result', data: { at: Date.now(), resultId: 'late-bookkeeping' } });
      }, context);
      await tick(f.harness, f.storage, context);
      expect((await f.state())!.items.login!.state).toBe('reported');
      expect((await f.state())!.items.login!.report?.text).toBe('Final checked outcome');
    } finally { await f.harness.close(context); }
  });
  test('a stale retrieval cannot consume a new task version', () => {
    const entry: CrewEntry = { kind: 'worker', conversationId: 2 as ConversationId, title: 'Login', spawnedAt: 1,
      state: 'reported', generation: 1, briefRequestId: 'b', delivery: 'thread', taskAt: 2,
      resumeTask: '2:1', report: { status: 'ok', text: 'new', at: 3, requestId: 'new' } };
    const state = { generation: 1, items: { login: entry }, spawnedAt: [] };
    recordRetrieved(state, new Map([['login', 'old']]));
    expect(entry.retrievedResult).toBeUndefined();
    expect(threadCompletionDue(entry)).toBe(false);
    entry.resumeTask = threadTask(entry);
    expect(threadCompletionDue(entry)).toBe(true);
  });
});
