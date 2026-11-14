import { describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { configure, createRegistry, Harness, MemoryStorage, InboxDoc, type Storage } from '@earendil-works/pi-durable';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { MetaDoc } from '../src/meta';
import { SessionsDoc, SessionTool, submitCrewMessage } from '../src/sessions';
import { threadTask } from '../src/threadResults';
import { resumeThreads } from '../src/threadSupervisor';
import { WORKER_CONTEXT_ADVICE, WorkerContext, WorkerContextDoc } from '../src/workerContext';
import { currentContextOf } from '../src/currentContext';
import { tick as crewTick } from '../src/crew';
import { runTask, type ScheduledTask } from '../src/scheduler';

const context = BACKGROUND_CONTEXT;
const setup = async (storage: Storage = new MemoryStorage()) => {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 1_000_000, maxTokens: 1000 }] });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(WorkerContext);
  const harness = await Harness.open(storage, { models, registry }, context);
  const leader = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const worker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  await harness.commit(async (tx) => {
    await configure(tx, worker.id, { model: { provider: 'faux', modelId: 'faux-1' } });
    Object.assign(await tx.doc(MetaDoc, worker.id), { kind: 'worker', lead: { host: 'local', conversationId: leader.id } });
    (await tx.doc(SessionsDoc, leader.id)).items.worker = { kind: 'worker', conversationId: worker.id,
      title: 'Bounded task', spawnedAt: 1, state: 'running', generation: 1, briefRequestId: 'brief', delivery: 'thread' };
  }, context);
  const state = () => harness.snapshot(SessionsDoc, leader.id, context);
  const resume = async () => resumeThreads(harness, leader.id, (await state())!, Date.now(), context);
  const notices = async () => (await leader.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === 'hearth.thread-notice');
  return { harness, storage, worker, leader, faux, state, resume, notices };
};

const answerWithUsage = (tokens: number) => {
  const answer = fauxAssistantMessage('Progress: done. Files: a.ts. Commits: none. Tests: passed. Blockers: none. Next steps: review; use a fresh Sol/Luna worker.');
  answer.usage = { ...answer.usage, input: tokens, output: 0, totalTokens: tokens };
  return answer;
};

describe('worker current-context advisory', () => {
  test('prompt is actionable and honest about advisory enforcement', () => {
    for (const word of ['bounded task', 'explicit', 'queued messages', 'progress', 'files', 'commits', 'tests', 'blockers', 'next steps', 'Sol/Luna', 'advisory', 'not a hard']) expect(WORKER_CONTEXT_ADVICE).toContain(word);
  });

  test('two 60k usage blocks are not 120k current context; cache tokens count once', () => {
    const first = answerWithUsage(60_000);
    const second = answerWithUsage(60_000);
    second.usage = { ...second.usage, input: 20_000, cacheRead: 30_000, cacheWrite: 10_000, totalTokens: 60_000 };
    expect(currentContextOf({ head: undefined, messages: [first, second] }).currentContextTokens).toBe(60_000);
  });

  test('lifecycle captures handoff and adds guidance without interrupting bounded work', async () => {
    const f = await setup();
    const prompts: string[] = [];
    try {
      f.faux.setResponses([(_request) => answerWithUsage(60_000), (_request) => answerWithUsage(60_000),
        (request) => { prompts.push(JSON.stringify(request.messages)); return answerWithUsage(100_001); },
        (request) => { prompts.push(JSON.stringify(request.messages)); return answerWithUsage(100_001); }]);
      for (let i = 0; i < 2; i++) {
        await f.worker.submit({ type: 'input', content: 'Continue bounded task' }, context);
        await f.worker.waitForIdle(context);
      }
      expect((await f.state())!.items.worker!.contextAdvisory).toBeUndefined();
      await f.worker.submit({ type: 'input', content: 'Finish ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      const doc = await f.harness.snapshot(WorkerContextDoc, f.worker.id, context);
      expect(doc?.recommendation).toBe('fresh-worker');
      expect(doc?.handoff?.text).toContain('Files: a.ts');
      expect(doc?.handoff?.answerEntryId).toBeGreaterThan(0);
      expect(await f.notices()).toHaveLength(0); // task never drives the leader directly
      for (const action of ['list', 'status', 'results'] as const) {
        const result = await SessionTool.execute({ action, ...(action === 'list' ? {} : { name: 'worker' }) }, {
          conversationId: f.leader.id, snapshot: f.harness.snapshot.bind(f.harness), commit: f.harness.commit.bind(f.harness),
        } as never, context);
        const output = JSON.stringify(result.output);
        expect(output).toContain('fresh Sol/Luna worker recommended');
        expect(output).toContain('Handoff:');
        expect(output).toContain(String(doc!.handoff!.answerEntryId));
      }
      await f.worker.submit({ type: 'input', content: 'Explicit override: small completion' }, context);
      await f.worker.waitForIdle(context);
      expect(prompts[1]).toContain('advisory guidance');
      expect(prompts[0]).toContain('advisory guidance');
      expect(await f.resume()).toBe(1);
      expect(await f.resume()).toBe(0);
      const notice = (await f.notices())[0]!;
      expect(notice.data).toMatchObject({ internal: true });
      expect(JSON.stringify(notice.data)).not.toContain('Files: a.ts');
    } finally { await f.harness.close(context); }
  });

  test('reassignment invalidates pending advisory and preserves leader directions', async () => {
    const f = await setup();
    try {
      f.faux.setResponses([answerWithUsage(100_001), answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Bounded task ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      const old = (await f.state())!.items.worker!;
      const oldTask = threadTask(old);
      // Same atomic rearm+submission path used by session message and agents send.
      await submitCrewMessage({ conversationId: f.leader.id, taskId: 'reassign', commit: f.harness.commit.bind(f.harness) } as never,
        (await f.harness.conversation(f.worker.id, context))! as never, 'worker', old, 'Explicit override: new bounded task', true, context);
      expect(threadTask((await f.state())!.items.worker!)).not.toBe(oldTask);
      expect(await f.resume()).toBe(0);
      await f.worker.waitForIdle(context);
      expect((await f.worker.entries({}, 100, undefined, context)).items.some((entry) => JSON.stringify(entry.model).includes('Explicit override: new bounded task'))).toBe(true);
    } finally { await f.harness.close(context); }
  });

  test('leader foreground and queued human input win over context notices', async () => {
    const f = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      f.faux.setResponses([answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Bounded task ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      f.faux.setResponses([async () => { await gate; return fauxAssistantMessage('Human direction understood'); }, fauxAssistantMessage('Queued human direction understood')]);
      await f.leader.configure({ model: { provider: 'faux', modelId: 'faux-1' } }, context);
      await f.leader.submit({ type: 'input', content: 'Change the plan first' }, context);
      await f.leader.submit({ type: 'input', content: 'Preserve this queued human direction', whenBusy: 'followUp' }, context);
      expect(await f.resume()).toBe(0);
      expect(await f.notices()).toHaveLength(0);
      expect((await f.state())!.items.worker!.notifiedContextEpoch).toBeUndefined();
      release();
      await f.leader.waitForIdle(context);
      expect(JSON.stringify((await f.leader.entries({}, 100, undefined, context)).items)).toContain('Preserve this queued human direction');
      expect(await f.resume()).toBe(1);
    } finally { release(); await f.harness.close(context); }
  });

  test('placed reset head invalidates pending old-epoch notice', async () => {
    const f = await setup();
    try {
      f.faux.setResponses([answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Bounded task ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      await f.harness.commit(async (tx) => {
        const summary = await tx.appendEntry(f.worker.id, { kind: 'test.summary', model: [{ role: 'user', content: 'Small handoff summary', timestamp: Date.now() + 1 }] });
        await tx.appendEntry(f.worker.id, { kind: 'test.reset', head: summary.id });
      }, context);
      expect(currentContextOf(await f.worker.context(context)).currentContextTokens).toBeLessThan(100_000);
      expect(await f.resume()).toBe(0);
      expect(await f.notices()).toHaveLength(0);
    } finally { await f.harness.close(context); }
  });

  test('settled legacy crews still admit a pending context advisory once', async () => {
    const f = await setup();
    try {
      f.faux.setResponses([answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Bounded task ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      await f.harness.commit(async (tx) => {
        const entry = (await tx.doc(SessionsDoc, f.leader.id)).items.worker!;
        entry.delivery = 'on-failure';
        entry.state = 'reported';
      }, context);
      await crewTick(f.harness, f.storage, context);
      expect(await f.notices()).toHaveLength(1);
      expect((await f.state())!.items.worker!.notifiedContextEpoch).toBe('initial');
      await crewTick(f.harness, f.storage, context);
      expect(await f.notices()).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });

  for (const mode of ['direct', 'scheduled'] as const) {
    test(`${mode} input invalidates old advisory without rearming; replay and queued input survive`, async () => {
      const f = await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      try {
        f.faux.setResponses([answerWithUsage(100_001)]);
        await f.worker.submit({ type: 'input', content: 'Old bounded task ' + 'x'.repeat(410_000) }, context);
        await f.worker.waitForIdle(context);
        const before = (await f.state())!.items.worker!.contextAdvisory!;
        f.faux.setResponses([async () => { await gate; return fauxAssistantMessage('New bounded assignment complete'); },
          fauxAssistantMessage('Queued direction complete')]);
        const task: ScheduledTask = { id: 'reused-worker', name: 'New scheduled bounded task', prompt: 'New bounded assignment',
          schedule: { kind: 'once', at: 123 }, enabled: true, createdAt: 1, conversationId: f.worker.id };
        const submit = async () => {
          if (mode === 'scheduled') expect((await runTask(f.harness, task, 123, context)).status).toBe('ok');
          else await f.worker.submit({ type: 'input', content: 'New bounded assignment', requestId: 'direct-reuse' }, context);
        };
        await submit();
        const requestId = mode === 'scheduled' ? `${task.id}:123` : 'direct-reuse';
        const admitted = await f.storage.submissionByRequest(f.worker.id, requestId, context);
        await submit(); // idempotent retry is not another assignment or another inbox item
        expect((await f.storage.submissionByRequest(f.worker.id, requestId, context))?.id).toBe(admitted?.id);
        await f.worker.submit({ type: 'input', content: 'Keep this queued direction', whenBusy: 'followUp', requestId: 'keep-queued' }, context);
        const queuedBefore = (await f.harness.snapshot(InboxDoc, f.worker.id, context))!.items.map((item) => item.id);
        expect(queuedBefore.length).toBeGreaterThan(0);
        expect(await f.resume()).toBe(0);
        expect(await f.notices()).toHaveLength(0);
        expect((await f.state())!.items.worker!.contextAdvisory).toBeUndefined();
        expect((await f.harness.snapshot(InboxDoc, f.worker.id, context))!.items.map((item) => item.id)).toEqual(queuedBefore);
        release();
        await f.worker.waitForIdle(context);
        const entries = (await f.worker.entries({}, 100, undefined, context)).items;
        expect(entries.filter((entry) => JSON.stringify(entry.model).includes('New bounded assignment') && entry.kind === 'pi.user')).toHaveLength(1);
        expect(entries.some((entry) => JSON.stringify(entry.model).includes('Keep this queued direction'))).toBe(true);
        expect((await f.state())!.items.worker!.contextAdvisory!.answerEntryId).toBeGreaterThan(before.answerEntryId);
        expect(await f.resume()).toBe(1); // only the new completed boundary can now advise
      } finally { release(); await f.harness.close(context); }
    });
  }

  test('stale scan cannot receipt an old handoff after a new answer in the same task and epoch', async () => {
    const f = await setup();
    try {
      f.faux.setResponses([answerWithUsage(100_001), answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Original bounded assignment ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      const scanned = (await f.state())!;
      const oldAdvice = scanned.items.worker!.contextAdvisory!;
      // Raw input deliberately bypasses crew rearm: task and epoch remain unchanged while
      // the latest completed answer/boundary moves. Feed precisely the old scanned state in.
      await f.worker.submit({ type: 'input', content: 'Explicit override: finish another bounded assignment' }, context);
      await f.worker.waitForIdle(context);
      const fresh = (await f.state())!;
      const newAdvice = fresh.items.worker!.contextAdvisory!;
      expect(newAdvice.task).toBe(oldAdvice.task);
      expect(newAdvice.epoch).toBe(oldAdvice.epoch);
      expect(newAdvice.answerEntryId).toBeGreaterThan(oldAdvice.answerEntryId);
      expect(newAdvice.throughEntryId!).toBeGreaterThan(oldAdvice.throughEntryId!);
      expect(await resumeThreads(f.harness, f.leader.id, scanned, Date.now(), context)).toBe(0);
      expect(await f.notices()).toHaveLength(0);
      expect((await f.state())!.items.worker!.notifiedContextEpoch).toBeUndefined();
      expect((await f.state())!.items.worker!.contextAdvisory).toEqual(newAdvice);
      expect(await f.resume()).toBe(1);
      const notice = (await f.notices())[0]!;
      expect(JSON.stringify(notice.model)).toContain(`answer entry ${newAdvice.answerEntryId}`);
      expect((await f.state())!.items.worker!.notifiedContextEpoch).toBe(newAdvice.epoch);
      expect(await f.resume()).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('refused input leaves the current advisory, transcript and replay registry unchanged', async () => {
    const f = await setup();
    try {
      f.faux.setResponses([answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Bounded task ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      const advice = (await f.state())!.items.worker!.contextAdvisory;
      const newest = (await f.worker.entries({}, 1, undefined, context)).items[0]!.id;
      await expect(f.worker.submit({ type: 'input', content: 'Must not be admitted while idle', whenIdle: 'reject', requestId: 'refused' }, context)).rejects.toThrow();
      expect(await f.storage.submissionByRequest(f.worker.id, 'refused', context)).toBeUndefined();
      expect((await f.worker.entries({}, 1, undefined, context)).items[0]!.id).toBe(newest);
      expect((await f.state())!.items.worker!.contextAdvisory).toEqual(advice);
      expect(await f.resume()).toBe(1);
    } finally { await f.harness.close(context); }
  });

  test('replay after an intervening assignment and SQLite reopen cannot invalidate fresh advice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiln-worker-context-replay-'));
    const path = join(directory, 'state.sqlite');
    let f: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      f = await setup(await openNodeSqliteStorage(path));
      f.faux.setResponses([answerWithUsage(100_001), answerWithUsage(100_001)]);
      const original = await f.worker.submit({ type: 'input', content: 'Original task ' + 'x'.repeat(410_000), requestId: 'original-task' }, context);
      await f.worker.waitForIdle(context);
      const originalAdvice = (await f.state())!.items.worker!.contextAdvisory!;
      await f.worker.submit({ type: 'input', content: 'Explicit new bounded assignment', requestId: 'intervening-task' }, context);
      await f.worker.waitForIdle(context);
      const freshAdvice = (await f.state())!.items.worker!.contextAdvisory!;
      expect(freshAdvice.answerEntryId).toBeGreaterThan(originalAdvice.answerEntryId);
      const originalId = (await original.status(context)).id;
      const replay = await f.worker.submit({ type: 'input', content: 'Original task ' + 'x'.repeat(410_000), requestId: 'original-task' }, context);
      expect((await replay.status(context)).id).toBe(originalId);
      expect((await f.state())!.items.worker!.contextAdvisory).toEqual(freshAdvice);
      const workerId = f.worker.id;
      const leaderId = f.leader.id;
      await f.harness.close(context); f = undefined;
      const storage = await openNodeSqliteStorage(path);
      const registry = createRegistry(); registry.install(WorkerContext);
      const harness = await Harness.open(storage, { models: createModels(), registry }, context);
      try {
        const worker = (await harness.conversation(workerId, context))!;
        const replayAfterRestart = await worker.submit({ type: 'input', content: 'Original task ' + 'x'.repeat(410_000), requestId: 'original-task' }, context);
        expect((await replayAfterRestart.status(context)).id).toBe(originalId);
        const state = (await harness.snapshot(SessionsDoc, leaderId, context))!;
        expect(state.items.worker!.contextAdvisory).toEqual(freshAdvice);
        expect(await resumeThreads(harness, leaderId, state, Date.now(), context)).toBe(1);
        const notice = (await (await harness.conversation(leaderId, context))!.entries({}, 10, undefined, context)).items.find((entry) => entry.kind === 'hearth.thread-notice')!;
        expect(JSON.stringify(notice.model)).toContain(`answer entry ${freshAdvice.answerEntryId}`);
        expect(await resumeThreads(harness, leaderId, (await harness.snapshot(SessionsDoc, leaderId, context))!, Date.now(), context)).toBe(0);
      } finally { await harness.close(context); }
    } finally { if (f) await f.harness.close(context); await rm(directory, { recursive: true, force: true }); }
  });

  test('deduplicates context notice after SQLite reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiln-worker-context-'));
    const path = join(directory, 'state.sqlite');
    let f: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      f = await setup(await openNodeSqliteStorage(path));
      f.faux.setResponses([answerWithUsage(100_001)]);
      await f.worker.submit({ type: 'input', content: 'Bounded task ' + 'x'.repeat(410_000) }, context);
      await f.worker.waitForIdle(context);
      expect(await f.resume()).toBe(1);
      const leaderId = f.leader.id;
      await f.harness.close(context); f = undefined;
      const harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
      try {
        expect(await resumeThreads(harness, leaderId, (await harness.snapshot(SessionsDoc, leaderId, context))!, Date.now(), context)).toBe(0);
      } finally { await harness.close(context); }
    } finally { if (f) await f.harness.close(context); await rm(directory, { recursive: true, force: true }); }
  });
});
