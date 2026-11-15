import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, configure, InboxDoc, LiveDoc, type Storage, type ConversationId, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxText, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Sessions, SessionsDoc, SessionTool, TaskCallsDoc, WORKER_INSTRUCTIONS, WORKER_DELEGATION_INSTRUCTIONS, explicitDone, explicitSettled, rearmWorker } from '../src/sessions';
import { MetaDoc } from '../src/meta';
import { tick } from '../src/crew';
import { threadTask } from '../src/threadResults';
import { QuestionsDoc } from '../src/ask';
import { answerQuestion, authorizeQuestionResume, createQuestion, resumeQuestions } from '../src/questions';

const setup = async (storage: Storage = new MemoryStorage()) => {
  const models = createModels(); const registry = createRegistry(); registry.install(Sessions);
  const harness = await Harness.open(storage, { models, registry }, context);
  const root = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const worker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const sibling = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  await harness.commit(async tx => {
    Object.assign(await tx.doc(MetaDoc, worker.id), { kind: 'worker', creatorId: root.id, lead: { host: 'local', conversationId: root.id } });
    Object.assign(await tx.doc(MetaDoc, sibling.id), { kind: 'worker', creatorId: root.id, lead: { host: 'local', conversationId: root.id } });
    (await tx.doc(SessionsDoc, root.id)).items.work = { kind: 'worker', creatorId: root.id, conversationId: worker.id,
      title: 'Repair login safely', state: 'running', spawnedAt: 100, generation: 1, briefRequestId: 'brief', delivery: 'thread', taskLifecycle: 'explicit' };
    await tx.appendEntry(worker.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([fauxText('Progress, not done')])] });
  }, context);
  const api = (id = worker.id, taskId = 'complete-1') => ({ taskId, conversationId: id,
    snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness), conversation: harness.conversation.bind(harness),
  }) as unknown as ToolExecutionApi;
  const call = (args: Parameters<typeof SessionTool.execute>[0], id = worker.id, taskId = 'complete-1') => SessionTool.execute(args, api(id, taskId), context);
  const entry = async () => (await harness.snapshot(SessionsDoc, root.id, context))!.items.work;
  const entries = async (id = root.id) => (await (await harness.conversation(id, context))!.entries({}, 100, undefined, context)).items;
  return { harness, storage, models, registry, root, worker, sibling, api, call, entry, entries, complete: { ...complete, task: String(worker.id) + ":100" } };
};
const complete = { action: 'complete' as const, summary: 'Fixed the login bug', evidence: 'auth.ts; focused tests green', remaining: 'No live provider check' };

describe('explicit worker task lifecycle', () => {
  test('advertised guidance keeps one tool, worker task ownership and explicit completion distinct from review', () => {
    expect(Sessions.tools.map(tool => tool.name)).toEqual(['session']);
    const prompt = Sessions.sections[0].render({} as never, context) as string;
    for (const text of [SessionTool.description, prompt]) {
      expect(text).toMatch(/Tasks in Ember/);
      expect(text).toMatch(/task runs in a worker conversation/);
      expect(text).toMatch(/reopen.*correction/i);
      expect(text).toMatch(/spawn for unrelated work/);
      expect(text).toMatch(/complete\(task,summary,evidence,remaining\)/);
      expect(text).toMatch(/status without a name/);
      expect(text).toMatch(/claim.*(?:not|never).*verification/);
      expect(text).toMatch(/peer.*independent/);
      expect(text).toMatch(/sibling/);
      expect(text.length).toBeLessThan(3400);
    }
    expect(SessionTool.description).toMatch(/Legacy.*final reply/);
    expect(WORKER_INSTRUCTIONS).toMatch(/own.*task/);
    expect(WORKER_INSTRUCTIONS).toMatch(/final reply.*does not complete/);
    expect(WORKER_INSTRUCTIONS).toMatch(/blocker is not completion/i);
    expect(WORKER_INSTRUCTIONS).toMatch(/Do not complete while corrections or commands are pending/);
    expect(WORKER_DELEGATION_INSTRUCTIONS).toMatch(/sibling directly under that root/);
  });

  for (const outcome of ['blocked', 'incomplete', 'handoff-needed'] as const) {
    test(`${outcome} pauses without Done, notifies once, and requires explicit reopening`, async () => {
      const f = await setup();
      try {
        const report = { ...f.complete, action: 'report' as const, outcome, remaining: 'Review the failing test and assign the next step.' };
        expect((await f.call(report)).control?.terminate).toBe(true);
        const paused = await f.entry();
        expect(explicitDone(paused)).toBe(false);
        expect(explicitSettled(paused)).toBe(true);
        expect(paused.report?.status).toBe(outcome);
        const own = JSON.parse(((await f.call({ action: 'status' })).output![0] as { text: string }).text);
        expect(own).toMatchObject({ done: false, outcome });
        // A paused outcome is not silently promoted to success, even with a different tool id.
        expect((await f.call(f.complete, f.worker.id, 'change-outcome')).control).toBeUndefined();
        await f.call(report); await f.call(report, f.worker.id, 'report-retry');
        expect((await f.entries()).filter(e => e.kind === 'hearth.thread-result')).toHaveLength(1);
        // Unfinished outcomes notify the coordinator even without a wait subscription.
        await tick(f.harness, f.storage, context); await tick(f.harness, f.storage, context);
        expect((await f.entries()).filter(e => e.kind === 'hearth.thread-notice')).toHaveLength(1);
        expect(JSON.stringify((await f.entries()).find(e => e.kind === 'hearth.thread-notice')?.model)).toContain(outcome);
        const result = await f.call({ action: 'results', name: 'work' }, f.root.id);
        expect(JSON.stringify(result.output)).toContain(outcome);
        await tick(f.harness, f.storage, context);
        expect((await f.entries()).filter(e => e.kind === 'hearth.thread-notice')).toHaveLength(1);
        expect(explicitDone(await f.entry())).toBe(false);
        await f.call({ action: 'reopen', name: 'work', message: 'Address the failing test', task: report.task }, f.root.id, 'reopen-paused');
        expect((await f.entry()).completion).toBeUndefined();
        expect(threadTask(await f.entry())).not.toBe(report.task);
        expect((await f.call(report, f.worker.id, 'stale-report')).control).toBeUndefined();
        expect((await f.entries(f.worker.id)).some(e => e.kind === 'hearth.task-completion' && (e.data as { outcome?: string })?.outcome === outcome)).toBe(true);
      } finally { await f.harness.close(context); }
    });

    test(`${outcome} cannot discard queued corrections or wake itself from a held answer`, async () => {
      const f = await setup();
      try {
        const question = await createQuestion(f.api(f.worker.id, 'question'), { question: 'Continue with the new format?' }, context);
        await f.call({ ...f.complete, action: 'report', outcome });
        await answerQuestion(f.harness, f.worker.id, question.key, 'Yes', 1, 'answer', context);
        expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
        const held = (await f.harness.snapshot(QuestionsDoc, f.worker.id, context))!.items[question.key];
        expect(held.delivery?.holdReason).toMatch(/paused.*reopen/);
        await authorizeQuestionResume(f.harness, f.worker.id, question.key, held.revision!, 'resume', context);
        expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
        expect(explicitSettled(await f.entry())).toBe(true);
        await f.harness.commit(tx => rearmWorker(tx, f.root.id, 'work', f.worker.id, Date.now()), context);
        await f.harness.commit(tx => configure(tx, f.worker.id, { model: { provider: 'faux', modelId: 'faux-1' } }), context);
        await f.worker.submit({ type: 'input', content: 'Start' }, context);
        await f.worker.submit({ type: 'input', content: 'Preserve this correction', whenBusy: 'followUp' }, context);
        const before = await f.harness.snapshot(InboxDoc, f.worker.id, context);
        expect(before!.items.length).toBeGreaterThan(0);
        expect((await f.call({ ...f.complete, action: 'report', outcome, task: threadTask(await f.entry()) }, f.worker.id, 'pending-report')).control).toBeUndefined();
        expect(await f.harness.snapshot(InboxDoc, f.worker.id, context)).toEqual(before);
      } finally { await f.harness.close(context); }
    });
  }

  test('unfinished reports require an explicit non-success outcome', async () => {
    const f = await setup();
    try {
      expect((await f.call({ ...f.complete, action: 'report' })).control).toBeUndefined();
      expect((await f.call({ ...f.complete, outcome: 'incomplete' })).control).toBeUndefined();
      expect(explicitSettled(await f.entry())).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('documented own-status then complete example uses the actual assignment token', async () => {
    const f = await setup();
    try {
      const status = await f.call({ action: 'status' });
      const assignment = JSON.parse((status.output![0] as { text: string }).text);
      expect(assignment.task).toBe(f.complete.task);
      const result = await f.call({ action: 'complete', task: assignment.task,
        summary: 'Fixed login retry handling', evidence: 'auth.ts; focused tests passed', remaining: 'No live-provider check' });
      expect(result.control?.terminate).toBe(true);
      expect(explicitDone(await f.entry())).toBe(true);
    } finally { await f.harness.close(context); }
  });

  test('idle and final prose do not complete, explicit result persists once and retrieval never verifies', async () => {
    const f = await setup();
    try {
      await tick(f.harness, f.storage, context);
      expect((await f.entry()).report).toBeUndefined();
      expect(explicitDone(await f.entry())).toBe(false);
      await f.call({ action: 'wait', name: 'work' }, f.root.id);
      expect((await f.call(f.complete)).control?.terminate).toBe(true);
      const done = await f.entry(); expect(explicitDone(done)).toBe(true);
      expect(done.report?.text).toContain(complete.evidence);
      await Promise.all([f.call(f.complete), f.call(f.complete, f.worker.id, 'complete-2')]);
      expect((await f.entries()).filter(e => e.kind === 'hearth.thread-result')).toHaveLength(1);
      await tick(f.harness, f.storage, context); await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter(e => e.kind === 'hearth.thread-notice')).toHaveLength(1);
      await f.call({ action: 'results', name: 'work' }, f.root.id);
      expect(explicitDone(await f.entry())).toBe(true);
      await tick(f.harness, f.storage, context);
      expect((await f.entries()).filter(e => e.kind === 'hearth.thread-notice')).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });

  test('own worker only; bounded fields; stopped is not Done; stale versions refused', async () => {
    const f = await setup();
    try {
      expect((await f.call(f.complete, f.sibling.id)).control).toBeUndefined();
      expect((await f.call(f.complete, f.root.id)).control).toBeUndefined();
      expect((await f.call({ ...f.complete, name: 'work' })).control).toBeUndefined();
      expect((await f.call({ ...f.complete, evidence: 'x'.repeat(3001) })).control).toBeUndefined();
      expect((await f.call({ ...f.complete, task: 'stale' })).control).toBeUndefined();
      await f.harness.commit(async tx => { (await tx.doc(SessionsDoc, f.root.id)).items.work.state = 'stopped'; }, context);
      expect((await f.call(f.complete)).control).toBeUndefined(); expect(explicitDone(await f.entry())).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('queue and correction race cannot lose input or replay completion on a reopened assignment', async () => {
    const f = await setup();
    try {
      const worker = (await f.harness.conversation(f.worker.id, context))!;
      await f.harness.commit(tx => configure(tx, f.worker.id, { model: { provider: 'faux', modelId: 'faux-1' } }), context);
      await worker.submit({ type: 'input', content: 'Start' }, context);
      await worker.submit({ type: 'input', content: 'Correction: keep the old API', whenBusy: 'followUp' }, context);
      const before = await f.harness.snapshot(InboxDoc, f.worker.id, context);
      expect(before!.items.length).toBeGreaterThan(0);
      expect((await f.call(f.complete)).control).toBeUndefined();
      expect(await f.harness.snapshot(InboxDoc, f.worker.id, context)).toEqual(before);
      expect(explicitDone(await f.entry())).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('reopen is coordinator-only, versioned, and old completion replay cannot finish it', async () => {
    const f = await setup();
    try {
      await f.call(f.complete); const old = threadTask(await f.entry());
      expect((await f.call({ action: 'reopen', name: 'work', message: 'Test the edge case' }, f.sibling.id)).output).toBeDefined();
      expect(explicitDone(await f.entry())).toBe(true);
      await f.call({ action: 'reopen', name: 'work', message: 'Test the edge case', task: old }, f.root.id, 'reopen-1');
      const next = await f.entry(); expect(next.completion).toBeUndefined(); expect(threadTask(next)).not.toBe(old);
      expect((await f.call(f.complete)).control).toBeUndefined();
      expect(explicitDone(await f.entry())).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('async question answer admission and explicit human resume hold Done, preserving origin assignment', async () => {
    const f = await setup();
    try {
      const q = await createQuestion(f.api(f.worker.id, 'question'), { question: 'Deploy EU?' }, context);
      expect(q.origin).toMatchObject({ taskOwnerId: String(f.root.id), taskKey: 'work', assignmentVersion: threadTask(await f.entry()) });
      await f.call(f.complete);
      await answerQuestion(f.harness, f.worker.id, q.key, 'Yes', 1, 'answer', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      const held = (await f.harness.snapshot(QuestionsDoc, f.worker.id, context))!.items[q.key];
      expect(held.delivery?.holdReason).toContain('Done');
      await authorizeQuestionResume(f.harness, f.worker.id, q.key, held.revision!, 'resume', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect(explicitDone(await f.entry())).toBe(true);
    } finally { await f.harness.close(context); }
  });

  test('SQLite restart retains Done and replay receipts across explicit reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiln-task-')); const file = join(dir, 'test.sqlite');
    const f = await setup(await openNodeSqliteStorage(file));
    let recovered: Harness | undefined;
    try {
      await f.call(f.complete); const expected = await f.entry(); await f.harness.close(context);
      recovered = await Harness.open(await openNodeSqliteStorage(file), { models: f.models, registry: f.registry }, context);
      expect((await recovered.snapshot(SessionsDoc, f.root.id, context))!.items.work).toEqual(expected);
      await recovered.commit(tx => rearmWorker(tx, f.root.id, 'work', f.worker.id, Date.now()), context);
      const result = await SessionTool.execute(f.complete, { ...f.api(), commit: recovered.commit.bind(recovered), snapshot: recovered.snapshot.bind(recovered) }, context);
      expect(result.control).toBeUndefined();
      expect(explicitDone((await recovered.snapshot(SessionsDoc, f.root.id, context))!.items.work)).toBe(false);
    } finally { if (recovered) await recovered.close(context); else await f.harness.close(context); await rm(dir, { recursive: true, force: true }); }
  });

  test('supervisor stale active snapshot cannot overwrite a concurrently persisted Done', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async tx => { (await tx.doc(SessionsDoc, f.root.id)).items.work.state = 'starting'; }, context);
      let raced = false;
      const proxy = new Proxy(f.harness, { get(target, prop) {
        if (prop === 'snapshot') return async (...args: unknown[]) => {
          if (args[0] === LiveDoc && args[1] === f.worker.id && !raced) {
            raced = true; await f.call(f.complete);
            return { run: { taskId: 'still-unwinding' } };
          }
          return (target.snapshot as (...args: unknown[]) => Promise<unknown>)(...args);
        };
        const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await tick(proxy, f.storage, context);
      expect(raced).toBe(true); expect(explicitDone(await f.entry())).toBe(true);
    } finally { await f.harness.close(context); }
  });

  test('first delayed old completion after reopen and cleared inbox cannot finish the new assignment', async () => {
    const f = await setup();
    try {
      const oldTask = threadTask(await f.entry());
      await f.harness.commit(tx => rearmWorker(tx, f.root.id, 'work', f.worker.id, Date.now()), context);
      expect((await f.harness.snapshot(InboxDoc, f.worker.id, context))?.items ?? []).toHaveLength(0);
      // No previous receipt exists for this old tool task: this is its FIRST execution.
      const delayed = await f.call({ ...f.complete, task: oldTask }, f.worker.id, 'never-executed-old-tool');
      expect(delayed.control).toBeUndefined(); expect(explicitDone(await f.entry())).toBe(false);
      expect((await f.call({ ...complete }, f.worker.id, 'missing-token')).control).toBeUndefined();
      const status = await f.call({ action: 'status' });
      expect(JSON.stringify(status.output)).toContain(threadTask(await f.entry()));
      expect((await f.call({ ...f.complete, task: threadTask(await f.entry()) }, f.worker.id, 'new-tool')).control?.terminate).toBe(true);
    } finally { await f.harness.close(context); }
  });

  test('successful receipts stay bounded without losing durable outcome history or allowing stale replay', async () => {
    const f = await setup();
    try {
      for (let i = 0; i < 66; i++) {
        await f.call({ ...f.complete, task: threadTask(await f.entry()) }, f.worker.id, 'complete-' + i);
        if (i < 65) await f.harness.commit(tx => rearmWorker(tx, f.root.id, 'work', f.worker.id, Date.now()), context);
      }
      const calls = (await f.harness.snapshot(TaskCallsDoc, f.worker.id, context))!.calls;
      expect(Object.keys(calls)).toHaveLength(64); expect(Object.values(calls).every(v => typeof v === 'string')).toBe(true);
      expect((await f.entries(f.worker.id)).filter(e => e.kind === 'hearth.task-completion')).toHaveLength(66);
      const stale = await f.call(f.complete, f.worker.id, 'complete-0'); // receipt already evicted
      expect(stale.control).toBeUndefined();
      expect((await f.entries(f.worker.id)).filter(e => e.kind === 'hearth.task-completion')).toHaveLength(66);
    } finally { await f.harness.close(context); }
  });

  test('direct tool schema exposes lifecycle actions and bounded result fields', () => {
    const schema = SessionTool.parameters as { properties: Record<string, { enum?: string[]; description?: string }> };
    expect(schema.properties.action.enum).toContain('complete'); expect(schema.properties.action.enum).toContain('report');
    expect(schema.properties.outcome.enum).toEqual(['blocked', 'incomplete', 'handoff-needed']); expect(schema.properties.action.enum).toContain('reopen');
    for (const field of ['summary', 'evidence', 'remaining', 'task']) expect(schema.properties[field]).toBeDefined();
    expect(schema.properties.task.description).toContain('required');
  });

  test('real successful completion tool round persists Done without requiring a final assistant reply', async () => {
    const f = await setup();
    try {
      const faux = fauxProvider(); f.models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage([fauxToolCall('session', f.complete)], { stopReason: 'toolUse' })]);
      await f.harness.commit(tx => configure(tx, f.worker.id, { model: { provider: 'faux', modelId: 'faux-1' } }), context);
      const worker = (await f.harness.conversation(f.worker.id, context))!;
      f.harness.resume(); await worker.submit({ type: 'input', content: 'Finish the task' }, context);
      await worker.waitForIdle(context);
      expect(explicitDone(await f.entry())).toBe(true);
      const entries = await f.entries(f.worker.id);
      expect(entries.filter(e => e.kind === 'pi.assistant')).toHaveLength(2); // seed progress + tool request, no final reply
      expect(JSON.stringify(entries)).toContain('Kiln saved your task outcome');
    } finally { await f.harness.close(context); }
  });

  test('real report tool yields without another model turn and survives SQLite restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiln-report-'));
    const file = join(dir, 'test.sqlite');
    const f = await setup(await openNodeSqliteStorage(file));
    let recovered: Harness | undefined;
    try {
      const faux = fauxProvider(); f.models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage([fauxToolCall('session', { ...f.complete, action: 'report', outcome: 'handoff-needed' })], { stopReason: 'toolUse' })]);
      await f.harness.commit(tx => configure(tx, f.worker.id, { model: { provider: 'faux', modelId: 'faux-1' } }), context);
      f.harness.resume();
      await f.worker.submit({ type: 'input', content: 'Report the unfinished work honestly' }, context);
      await f.worker.waitForIdle(context);
      expect(explicitDone(await f.entry())).toBe(false);
      expect(explicitSettled(await f.entry())).toBe(true);
      expect((await f.entries(f.worker.id)).filter(e => e.kind === 'pi.assistant')).toHaveLength(2);
      const expected = await f.entry();
      await f.harness.close(context);
      const storage = await openNodeSqliteStorage(file);
      recovered = await Harness.open(storage, { models: f.models, registry: f.registry }, context);
      expect((await recovered.snapshot(SessionsDoc, f.root.id, context))!.items.work).toEqual(expected);
      await tick(recovered, storage, context);
      expect(explicitDone((await recovered.snapshot(SessionsDoc, f.root.id, context))!.items.work)).toBe(false);
    } finally { if (recovered) await recovered.close(context); else await f.harness.close(context); await rm(dir, { recursive: true, force: true }); }
  });

  test('complete refuses an earlier queued correction and SDK keeps that human direction', async () => {
    const f = await setup();
    try {
      const faux = fauxProvider(); f.models.setProvider(faux.provider);
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      faux.setResponses([async () => { await gate; return fauxAssistantMessage([fauxToolCall('session', f.complete)], { stopReason: 'toolUse' }); }, fauxAssistantMessage([fauxText('Correction retained')])]);
      await f.harness.commit(tx => configure(tx, f.worker.id, { model: { provider: 'faux', modelId: 'faux-1' } }), context);
      const worker = (await f.harness.conversation(f.worker.id, context))!;
      f.harness.resume(); await worker.submit({ type: 'input', content: 'Finish the task' }, context);
      // The queued command arrives before completion and must be processed, not cleared by complete.
      await worker.submit({ type: 'input', content: 'Correction: preserve compatibility', whenBusy: 'followUp' }, context);
      release(); await worker.waitForIdle(context);
      expect(JSON.stringify(await f.entries(f.worker.id))).toContain('Correction: preserve compatibility');
      expect(JSON.stringify(await f.entries(f.worker.id))).toContain('Correction retained');
      expect(explicitDone(await f.entry())).toBe(false);
    } finally { await f.harness.close(context); }
  });
});
