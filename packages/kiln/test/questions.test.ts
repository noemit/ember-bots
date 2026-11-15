import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { startHearthServer } from '../src/server';
import { hearthConfig } from '../src/config';
import { FileCredentialStore } from '../src/credentials';
import { parkedInputs } from '../src/parking';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness, InboxDoc, LiveDoc, MemoryStorage, type ConversationId, type Storage, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { AskTool, QuestionsDoc, clearPendingQuestions, pendingQuestions, replyQuestion } from '../src/ask';
import { answerQuestion, appendQuestionContext, authorizeQuestionResume, createQuestion, listQuestions, reconcileQuestions, resumeQuestions, withdrawQuestion } from '../src/questions';
import { MetaDoc } from '../src/meta';
import { hearthCodemodeExtensions } from '../src/codemode';
import { threadTask } from '../src/threadResults';
import { SessionsDoc } from '../src/sessions';
import { archiveCrew, markWorkerStopped, tick } from '../src/crew';

const context = BACKGROUND_CONTEXT;
const setup = async (storage: Storage = new MemoryStorage()) => {
  const models = createModels(); const registry = createRegistry(); registry.install({ name: 'ask', tools: [AskTool] });
  const harness = await Harness.open(storage, { models, registry }, context);
  const root = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const worker = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const sibling = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const api = (id = root.id, taskId = 'question-tool-1') => ({ taskId, conversationId: id, snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness) }) as unknown as ToolExecutionApi;
  const create = (id = root.id, taskId = 'question-tool-1', extra: Parameters<typeof createQuestion>[1] = {}) => createQuestion(api(id, taskId), { question: 'Which region?', options: ['EU', 'US'], ...extra }, context);
  const get = async (id = root.id, key = 'question-tool-1') => (await harness.snapshot(QuestionsDoc, id, context))!.items[key];
  const entries = async (id = root.id) => (await (await harness.conversation(id, context))!.entries({}, 100, undefined, context)).items;
  const member = async (state: 'running' | 'reported' | 'stopped' | 'failed' = 'running', creator = root.id) => harness.commit(async tx => {
    const meta = await tx.doc(MetaDoc, worker.id); meta.kind = 'worker'; meta.creatorId = creator; meta.lead = { host: 'local', conversationId: root.id };
    (await tx.doc(MetaDoc, root.id)).title = 'Root title';
    (await tx.doc(SessionsDoc, creator)).items.task = { kind: 'worker', conversationId: worker.id, creatorId: creator, supervisorId: root.id, title: 'Worker', state, spawnedAt: 100, taskAt: 101, generation: 1, briefRequestId: 'brief', delivery: 'thread', report: { status: 'ok', text: 'Prior result', at: 103, requestId: 'old-report' } };
    if (creator !== root.id) (await tx.doc(SessionsDoc, root.id)).items.alias = { ...(await tx.doc(SessionsDoc, creator)).items.task, taskOwner: { conversationId: creator, key: 'task' } };
  }, context);
  return { harness, storage, models, registry, root, worker, sibling, api, create, get, entries, member };
};

describe('Questions inbox durable lifecycle', () => {
  test('explicit create immediately returns an ID, replay never returns an answer, missing action remains legacy', async () => {
    const f = await setup();
    try {
      const args = { action: 'create', question: 'Which region?', context: 'A deployment choice', recommendation: 'EU', decision: 'hosting', source: 'config.ts', freeText: true };
      const created = await AskTool.execute(args, f.api(), context);
      expect(JSON.parse((created.output![0] as { text: string }).text)).toEqual({ id: 'question-tool-1', key: 'question-tool-1', conversationId: String(f.root.id), revision: 1, created: true });
      expect(await pendingQuestions(f.harness, [f.root.id], context)).toHaveLength(0);
      await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
      expect(await AskTool.execute(args, f.api(), context)).toEqual(created);
      expect(await replyQuestion(f.harness, f.root.id, 'question-tool-1', null, context)).toBe(false);
      const pending = AskTool.execute({ question: 'Legacy question?' }, f.api(f.root.id, 'legacy'), context);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await pendingQuestions(f.harness, [f.root.id], context)).toHaveLength(1);
      await replyQuestion(f.harness, f.root.id, 'legacy', 'yes', context);
      expect(JSON.stringify(await pending)).toContain('The user answered: yes');
    } finally { await f.harness.close(context); }
  });

  test('answer CAS, exact retries and conflicting payloads cannot overwrite a winner', async () => {
    const f = await setup();
    try {
      await f.create();
      const [a, b] = await Promise.all([
        answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context),
        answerQuestion(f.harness, f.root.id, 'question-tool-1', 'US', 1, 'b', context),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const q = await f.get(); const receipt = q.receipt!;
      expect(await answerQuestion(f.harness, f.root.id, q.key, receipt.answer, 1, receipt.requestId, context)).toEqual({ ok: true, question: q });
      expect((await answerQuestion(f.harness, f.root.id, q.key, 'other', 1, receipt.requestId, context)).ok).toBe(false);
      expect((await f.get()).receipt).toEqual(receipt);
      expect((await answerQuestion(f.harness, f.root.id, q.key, 'EU', NaN, 'x', context)).ok).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('supersede versus answer has one transactional winner, replay cannot repeat supersession', async () => {
    const f = await setup();
    try {
      await f.create();
      const results = await Promise.allSettled([
        f.create(f.root.id, 'new-question', { supersedes: 'question-tool-1', revision: 1, question: 'Use EU instead?' }),
        answerQuestion(f.harness, f.root.id, 'question-tool-1', 'US', 1, 'answer', context),
      ]);
      const old = await f.get();
      if (old.status === 'superseded') {
        expect(results[0].status).toBe('fulfilled');
        expect((results[1] as PromiseFulfilledResult<{ ok: boolean }>).value.ok).toBe(false);
        await f.create(f.root.id, 'new-question', { supersedes: 'question-tool-1', revision: 1 });
        expect((await f.get()).revision).toBe(2);
      } else {
        expect(old.status).toBe('answered'); expect(results[0].status).toBe('rejected');
      }
    } finally { await f.harness.close(context); }
  });

  test('only origin assignment or human may withdraw a pending question; sent answers cannot be retracted', async () => {
    const f = await setup();
    try {
      await f.member(); await f.create(f.worker.id);
      expect((await withdrawQuestion(f.harness, f.worker.id, 'question-tool-1', 1, 'sibling', context, f.sibling.id)).error).toBe('forbidden');
      await f.harness.commit(async tx => { (await tx.doc(SessionsDoc, f.root.id)).items.task.taskAt = 200; }, context);
      expect((await withdrawQuestion(f.harness, f.worker.id, 'question-tool-1', 1, 'stale', context, f.worker.id)).error).toBe('forbidden');
      await answerQuestion(f.harness, f.worker.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect((await withdrawQuestion(f.harness, f.worker.id, 'question-tool-1', 2, 'origin', context, f.worker.id)).ok).toBe(false);
      const result = await withdrawQuestion(f.harness, f.worker.id, 'question-tool-1', 2, 'human', context);
      expect(result.ok).toBe(false); expect((await f.get(f.worker.id)).receipt?.answer).toBe('EU');
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect(await withdrawQuestion(f.harness, f.worker.id, 'question-tool-1', 2, 'human', context)).toEqual(result);
    } finally { await f.harness.close(context); }
  });

  test('answer versus withdraw has exactly one winner', async () => {
    const f = await setup();
    try {
      await f.create();
      const results = await Promise.all([answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context), withdrawQuestion(f.harness, f.root.id, 'question-tool-1', 1, 'w', context)]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
    } finally { await f.harness.close(context); }
  });

  test('idle root resumes correlated internal input once; no crew document is required', async () => {
    const f = await setup();
    try {
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect(await tick(f.harness, f.storage, context)).toBeGreaterThan(0);
      const q = await f.get();
      expect(q.delivery?.status).toBe('admitted'); expect(q.delivery?.submissionId).toBeTruthy();
      const entry = (await f.entries()).find(entry => entry.kind === 'hearth.question-answer');
      expect(entry?.data).toMatchObject({ internal: true, questionId: q.key, receipt: { requestId: 'a', answer: 'EU' } });
      // Admission is durable even if no model is configured to execute the turn.
      expect(JSON.stringify(entry?.model)).toContain('Human answer to async question');
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      expect((await f.entries()).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(1);
      expect((await withdrawQuestion(f.harness, f.root.id, q.key, q.revision!, 'w', context)).ok).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('foreground and admitted human Inbox are checked in commit; answers never steer', async () => {
    const f = await setup();
    try {
      const handle = (await f.harness.conversation(f.root.id, context))!;
      await handle.submit({ type: 'input', content: 'human foreground' }, context);
      await handle.submit({ type: 'input', content: 'human followup', whenBusy: 'followUp' }, context);
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      expect((await f.get()).delivery?.status).toBe('held');
      expect((await f.harness.snapshot(InboxDoc, f.root.id, context))!.items.every(item => item.mode !== 'steer')).toBe(true);
      // Remove foreground only: a human input already admitted to Inbox still wins admission.
      await f.harness.commit(async tx => { delete (await tx.doc(LiveDoc, f.root.id)).run; }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      expect((await f.entries()).some(entry => entry.kind === 'hearth.question-answer')).toBe(false);
      await f.harness.commit(async tx => { (await tx.doc(InboxDoc, f.root.id)).items = []; delete (await tx.doc(LiveDoc, f.root.id)).runFailure; (await tx.doc(QuestionsDoc, f.root.id)).items['question-tool-1'].resumeRequired = false; }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(1);
    } finally { await f.harness.close(context); }
  });

  test('stop metadata applies to ordinary roots; clear prompts retains async history and sticky human resume', async () => {
    const f = await setup();
    try {
      const before = await f.create(); await clearPendingQuestions(f.harness, f.root.id, context);
      expect(await f.get()).toEqual(before);
      await f.harness.commit(tx => markWorkerStopped(tx, f.root.id), context);
      await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      expect((await f.get()).delivery?.holdReason).toContain('stopped');
      await authorizeQuestionResume(f.harness, f.root.id, 'question-tool-1', 2, 'resume-too-early', context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      await f.harness.commit(async tx => { delete (await tx.doc(MetaDoc, f.root.id)).stoppedAt; }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      const q = await f.get();
      await authorizeQuestionResume(f.harness, f.root.id, q.key, q.revision!, 'resume', context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(1);
    } finally { await f.harness.close(context); }
  });

  test('archive/unhide cannot automatically resume, async pending history survives crew archive', async () => {
    const f = await setup();
    try {
      await f.member(); await f.create(); await f.create(f.worker.id);
      await archiveCrew(f.harness, f.root.id, Date.now(), undefined, context);
      expect((await f.get()).status).toBe('pending'); expect((await f.get(f.worker.id)).status).toBe('pending');
      await f.harness.commit(async tx => { delete (await tx.doc(MetaDoc, f.root.id)).archived; }, context);
      await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      const rows = await listQuestions(f.harness, [f.worker.id, f.root.id], context);
      expect(rows).toHaveLength(2); expect(rows[0].ancestry).toEqual([{ conversationId: String(f.root.id), title: 'Root title' }]);
    } finally { await f.harness.close(context); }
  });

  test('two-level sibling uses creator task ownership, not supervisor alias, and preserves settled results', async () => {
    const f = await setup();
    try {
      await f.member('reported', f.sibling.id); const q = await f.create(f.worker.id);
      expect(q.origin?.taskOwnerId).toBe(String(f.sibling.id)); expect(q.origin?.supervisorId).toBe(String(f.root.id));
      await answerQuestion(f.harness, f.worker.id, q.key, 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(1);
      const entry = (await f.harness.snapshot(SessionsDoc, f.sibling.id, context))!.items.task;
      expect(entry.state).toBe('starting'); expect(entry.taskAt).toBe(101); expect(entry.report?.requestId).toBe('old-report');
      expect(entry.questionContinuations).toHaveLength(1); expect(entry.questionContinuations![0].priorReport?.text).toBe('Prior result');
      expect((await f.entries(f.root.id)).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
      expect((await f.entries(f.sibling.id)).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
    } finally { await f.harness.close(context); }
  });

  test.each(['stopped', 'failed'] as const)('%s worker remains held and never routes its answer to supervisor', async state => {
    const f = await setup();
    try {
      await f.member(state); await f.create(f.worker.id); await answerQuestion(f.harness, f.worker.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect((await f.get(f.worker.id)).resumeRequired).toBe(true);
      expect((await f.entries(f.root.id)).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
    } finally { await f.harness.close(context); }
  });

  test('stale assignment holds even if supervisor has a runnable alias', async () => {
    const f = await setup();
    try {
      await f.member('running', f.sibling.id); await f.create(f.worker.id);
      await f.harness.commit(async tx => { (await tx.doc(SessionsDoc, f.sibling.id)).items.task.taskAt = 500; }, context);
      await answerQuestion(f.harness, f.worker.id, 'question-tool-1', 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect((await f.get(f.worker.id)).delivery?.holdReason).toContain('assignment changed');
    } finally { await f.harness.close(context); }
  });

  test('unresolved worker assignment remains a visible held origin even if live metadata later disappears', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async tx => { const meta = await tx.doc(MetaDoc, f.worker.id); meta.kind = 'worker'; meta.lead = { host: 'local', conversationId: f.root.id }; }, context);
      const q = await f.create(f.worker.id);
      expect(q.origin?.kind).toBe('worker'); expect(q.origin?.assignmentMissing).toBe(true);
      expect((await withdrawQuestion(f.harness, f.worker.id, q.key, 1, 'origin-withdraw', context, f.worker.id)).error).toBe('forbidden');
      await f.harness.commit(async tx => { const meta = await tx.doc(MetaDoc, f.worker.id); delete meta.kind; delete meta.lead; }, context);
      await answerQuestion(f.harness, f.worker.id, q.key, 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect((await f.get(f.worker.id)).delivery?.holdReason).toContain('assignment is missing');
      expect((await listQuestions(f.harness, [f.worker.id], context))).toHaveLength(1);
      expect((await withdrawQuestion(f.harness, f.worker.id, q.key, 2, 'human-withdraw', context)).ok).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('origin ownership follows authoritative taskOwner aliases independently of supervisory hierarchy', async () => {
    const f = await setup();
    try {
      await f.member('reported');
      await f.harness.commit(async tx => {
        (await tx.doc(MetaDoc, f.worker.id)).creatorId = f.sibling.id;
        (await tx.doc(SessionsDoc, f.sibling.id)).items.requested = { ...(await tx.doc(SessionsDoc, f.root.id)).items.task, taskOwner: { conversationId: f.root.id, key: 'task' } };
      }, context);
      const q = await f.create(f.worker.id);
      expect(q.origin?.taskOwnerId).toBe(String(f.root.id)); expect(q.origin?.taskKey).toBe('task');
      expect(q.origin?.supervisorId).toBe(String(f.root.id));
      await answerQuestion(f.harness, f.worker.id, q.key, 'EU', 1, 'a', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(1);
      expect((await f.harness.snapshot(SessionsDoc, f.root.id, context))!.items.task.state).toBe('starting');
    } finally { await f.harness.close(context); }
  });

  test('a vanished origin holds visibly without routing to a supervisor, even across explicit resume', async () => {
    const f = await setup();
    try {
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      const missing = { snapshot: f.harness.snapshot.bind(f.harness), commit: f.harness.commit.bind(f.harness), conversation: async () => undefined } as unknown as Harness;
      expect(await resumeQuestions(missing, f.root.id, context)).toBe(0);
      expect((await f.get()).delivery?.holdReason).toContain('missing');
      await authorizeQuestionResume(f.harness, f.root.id, 'question-tool-1', 2, 'resume', context);
      expect(await resumeQuestions(missing, f.root.id, context)).toBe(0);
      expect((await f.get()).mutation).toBeUndefined();
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('unsafe hold stays sticky when the target is also busy', async () => {
    const f = await setup();
    try {
      const handle = (await f.harness.conversation(f.root.id, context))!;
      await handle.submit({ type: 'input', content: 'foreground' }, context);
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      await f.harness.commit(async tx => { (await tx.doc(MetaDoc, f.root.id)).archived = 1; }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      expect((await f.get()).resumeRequired).toBe(true);
      await f.harness.commit(async tx => { delete (await tx.doc(MetaDoc, f.root.id)).archived; const live = await tx.doc(LiveDoc, f.root.id); delete live.run; delete live.runFailure; }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('continuation settlement gets a new outcome ID without changing assignment or losing prior result', async () => {
    const f = await setup();
    try {
      await f.member('reported'); await f.create(f.worker.id);
      await answerQuestion(f.harness, f.worker.id, 'question-tool-1', 'EU', 1, 'a', context);
      await resumeQuestions(f.harness, f.worker.id, context);
      await f.harness.commit(async tx => {
        await tx.appendEntry(f.worker.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([fauxText('Updated result with the answer')])] });
        const live = await tx.doc(LiveDoc, f.worker.id); delete live.run; delete live.runFailure;
      }, context);
      await tick(f.harness, f.storage, context);
      const entry = (await f.harness.snapshot(SessionsDoc, f.root.id, context))!.items.task;
      expect(entry.state).toBe('reported'); expect(entry.taskAt).toBe(101);
      expect(entry.report?.requestId).toContain(':question:1'); expect(entry.report?.text).toBe('Updated result with the answer');
      expect(entry.questionContinuations?.[0].priorReport?.requestId).toBe('old-report');
    } finally { await f.harness.close(context); }
  });

  test('input bounds reject invalid payloads before any question write', async () => {
    const f = await setup();
    try {
      await expect(f.create(f.root.id, 'oversize', { context: 'x'.repeat(16001) })).rejects.toThrow('16,000');
      await expect(f.create(f.root.id, 'options', { options: new Array(51).fill('x') })).rejects.toThrow('50');
      expect(await listQuestions(f.harness, [f.root.id], context)).toHaveLength(0);
    } finally { await f.harness.close(context); }
  });
});


describe('Questions persistence and wire contract', () => {
  test('SQLite reopen retains history, payload-bound receipts and exactly one correlated admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiln-questions-'));
    const path = join(directory, 'kiln.sqlite');
    const f = await setup(await openNodeSqliteStorage(path));
    await f.create(); const answer = await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
    await f.harness.close(context);
    let recovered = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
    try {
      expect(await answerQuestion(recovered, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context)).toEqual(answer);
      expect(await resumeQuestions(recovered, f.root.id, context)).toBe(1);
      await recovered.close(context);
      recovered = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
      expect(await resumeQuestions(recovered, f.root.id, context)).toBe(0);
      expect(await answerQuestion(recovered, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context)).toEqual(answer);
      expect((await answerQuestion(recovered, f.root.id, 'question-tool-1', 'US', 1, 'answer', context)).ok).toBe(false);
      const entries = (await (await recovered.conversation(f.root.id, context))!.entries({}, 100, undefined, context)).items;
      expect(entries.filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(1);
      expect((await listQuestions(recovered, [f.root.id], context))[0].receipt?.requestId).toBe('answer');
    } finally { await recovered.close(context); await rm(directory, { recursive: true, force: true }); }
  });

  test('crash after queued admission, then stop before placement, retains the answer and needs explicit fresh-identity resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiln-questions-preplacement-'));
    const path = join(directory, 'kiln.sqlite');
    const f = await setup(await openNodeSqliteStorage(path));
    await f.create();
    const originalAnswer = await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
    // A valid SDK queued admission, captured before placement. Today's idle-only helper places
    // synchronously; this persisted boundary also covers migrated/older admission and recovery.
    const admitted = await f.harness.commit(async tx => {
      const q = (await tx.doc(QuestionsDoc, f.root.id)).items['question-tool-1'];
      const inbox = await tx.doc(InboxDoc, f.root.id);
      const record = await tx.createSubmission({ conversationId: f.root.id, type: 'input', status: 'queued', requestId: q.delivery!.requestId });
      inbox.items.push({ id: record.id, mode: 'followUp', content: 'Human answer: EU', entry: { kind: 'hearth.question-answer', data: { internal: true, questionId: q.key, receipt: q.receipt! } } });
      q.delivery = { requestId: record.requestId!, submissionId: String(record.id), status: 'admitted', placement: 'unknown', admittedAt: Date.now() }; q.revision!++;
      return record;
    }, context);
    expect(parkedInputs((await f.harness.snapshot(InboxDoc, f.root.id, context))!.items)).toHaveLength(0);
    await f.harness.close(context);
    let recovered = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
    try {
      await reconcileQuestions(recovered, f.root.id, context);
      expect((await recovered.snapshot(QuestionsDoc, f.root.id, context))!.items['question-tool-1'].delivery?.placement).toBe('queued');
      const handle = (await recovered.conversation(f.root.id, context))!;
      await handle.abort(context);
      await recovered.commit(tx => markWorkerStopped(tx, f.root.id), context);
      // Crash again after SDK withdrawal, before the Questions reconciliation transaction.
      await recovered.close(context);
      recovered = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
      const held = (await listQuestions(recovered, [f.root.id], context))[0];
      expect(held.status).toBe('answered'); expect(held.receipt).toEqual(originalAnswer.question!.receipt);
      expect(held.delivery?.status).toBe('held'); expect(held.delivery?.placement).toBe('unplaced');
      expect(held.delivery?.failureReason).toBe('aborted'); expect(held.resumeRequired).toBe(true);
      expect((await (await recovered.submission(admitted.id, context))!.status(context)).status).toBe('unanswered');
      expect(await resumeQuestions(recovered, f.root.id, context)).toBe(0);
      expect((await recovered.snapshot(InboxDoc, f.root.id, context))!.items).toHaveLength(0);
      await recovered.commit(async tx => { delete (await tx.doc(MetaDoc, f.root.id)).stoppedAt; }, context);
      expect(await resumeQuestions(recovered, f.root.id, context)).toBe(0);
      const q = (await recovered.snapshot(QuestionsDoc, f.root.id, context))!.items['question-tool-1'];
      const authorization = await authorizeQuestionResume(recovered, f.root.id, q.key, q.revision!, 'explicit-resume', context);
      expect(authorization.ok).toBe(true);
      expect(authorization.question?.delivery?.requestId).not.toBe(admitted.requestId);
      expect(authorization.question?.deliveryAttempts?.[0].requestId).toBe(admitted.requestId);
      expect(await authorizeQuestionResume(recovered, f.root.id, q.key, q.revision!, 'explicit-resume', context)).toEqual(authorization);
      expect(await resumeQuestions(recovered, f.root.id, context)).toBe(1);
      expect(await resumeQuestions(recovered, f.root.id, context)).toBe(0);
      const delivered = (await listQuestions(recovered, [f.root.id], context))[0];
      expect(delivered.delivery?.status).toBe('admitted'); expect(delivered.delivery?.placement).toBe('placed'); expect(delivered.delivery?.entryId).toBeDefined();
      const entries = (await (await recovered.conversation(f.root.id, context))!.entries({}, 100, undefined, context)).items;
      expect(entries.filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(1);
      expect(await answerQuestion(recovered, f.root.id, q.key, 'EU', 1, 'answer', context)).toEqual(originalAnswer);
    } finally { await recovered.close(context); await rm(directory, { recursive: true, force: true }); }
  });

  test('SDK type-only requestId dedup cannot turn an unrelated input into an answer delivery receipt', async () => {
    const f = await setup();
    try {
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      const q = await f.get();
      await (await f.harness.conversation(f.root.id, context))!.submit({ type: 'input', content: 'An unrelated human input', requestId: q.delivery!.requestId }, context);
      await f.harness.commit(async tx => { const live = await tx.doc(LiveDoc, f.root.id); delete live.run; delete live.runFailure; }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      const held = await f.get();
      expect(held.delivery?.status).toBe('held'); expect(held.delivery?.placement).toBe('unknown');
      expect(held.delivery?.holdReason).toContain('conflicting');
      expect((await f.entries()).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
      expect((await authorizeQuestionResume(f.harness, f.root.id, held.key, held.revision!, 'resume-conflict', context)).error).toBe('unknown-admission');
    } finally { await f.harness.close(context); }
  });

  test('placed-but-aborted is not called unplaced, seen, or executed; missing submission evidence stays unknown', async () => {
    const f = await setup();
    try {
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'a', context);
      await resumeQuestions(f.harness, f.root.id, context);
      await (await f.harness.conversation(f.root.id, context))!.abort(context);
      await reconcileQuestions(f.harness, f.root.id, context);
      const placed = await f.get();
      expect(placed.delivery?.status).toBe('admitted'); expect(placed.delivery?.placement).toBe('placed'); expect(placed.delivery?.entryId).toBeDefined();
      expect((await authorizeQuestionResume(f.harness, f.root.id, placed.key, placed.revision!, 'cannot-replay-placed', context)).ok).toBe(false);
      await f.harness.commit(async tx => { const q = (await tx.doc(QuestionsDoc, f.root.id)).items[placed.key]; q.delivery!.requestId = 'missing-admission-evidence'; }, context);
      await reconcileQuestions(f.harness, f.root.id, context);
      const missing = await f.get();
      expect(missing.delivery?.status).toBe('held'); expect(missing.delivery?.placement).toBe('unknown');
      expect((await authorizeQuestionResume(f.harness, f.root.id, missing.key, missing.revision!, 'unknown-resume', context)).error).toBe('unknown-admission');
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('real tool creation finishes independently; authenticated wire actions retain async history and legacy compatibility', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiln-questions-wire-'));
    const f = await setup(); const faux = fauxProvider(); f.models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ask', { action: 'create', question: 'Which region?', recommendation: 'EU', context: 'Deploy safely' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('I finished independent work without waiting for the decision.')]),
      fauxAssistantMessage([fauxText('I applied the correlated answer.')]),
    ]);
    const server = startHearthServer({ config: hearthConfig({ home: directory, port: 0, workspace: directory }), token: 'questions-test-token', storage: f.storage, harness: f.harness, models: f.models, defaultAgent: { model: { provider: 'faux', modelId: 'faux-1' } }, store: new FileCredentialStore(join(directory, 'auth.json')), version: 'test', build: 'test' });
    const api = (path: string, body?: unknown) => fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer questions-test-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const root = await f.harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      const run = await root.submit({ type: 'input', content: 'Ask, then finish independent work' }, context);
      await run.wait(context);
      const first = await (await api('/questions')).json() as { questions: Array<{ conversationId: string; key: string; mode: string; revision: number }> };
      const q = first.questions.find(q => q.conversationId === String(root.id))!;
      expect(q.mode).toBe('async');
      const stored = (await f.harness.snapshot(QuestionsDoc, root.id, context))!.items[q.key];
      expect(stored.origin?.sourceMessageId).toMatch(/^e[1-9][0-9]*$/);
      const originEntry = (await root.entries({}, 100, undefined, context)).items.find(entry => 'e' + entry.id === stored.origin?.sourceMessageId);
      expect(originEntry?.kind).toBe('pi.assistant');
      const summaries = await (await api('/conversations')).json() as { conversations: Array<{ id: number; needsInput: boolean }> };
      expect(summaries.conversations.find(row => row.id === root.id)?.needsInput).toBe(false);
      const path = '/questions/' + root.id + '/' + encodeURIComponent(q.key);
      expect((await fetch(server.url + path + '/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'EU', revision: 1, requestId: 'a' }) })).status).toBe(401);
      expect((await api(path + '/reply', { answer: 'EU' })).status).toBe(400);
      const reply = await api(path + '/reply', { answer: 'EU', revision: q.revision, requestId: 'a' });
      expect(reply.status).toBe(200); const receipt = await reply.json();
      expect(await (await api(path + '/reply', { answer: 'EU', revision: q.revision, requestId: 'a' })).json()).toEqual(receipt);
      expect((await api(path + '/reply', { answer: 'US', revision: q.revision, requestId: 'a' })).status).toBe(409);
      await root.waitForIdle(context);
      const history = await (await api('/questions?limit=1')).json() as { questions: Array<{ status: string }> };
      expect(history.questions[0].status).toBe('answered');
      const entries = (await root.entries({}, 100, undefined, context)).items;
      expect(entries.filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(1);
      expect(JSON.stringify(entries)).toContain('I applied the correlated answer');
      expect((await api(path + '/withdraw', { revision: 3, requestId: 'withdraw' })).status).toBe(409);
      await f.create(f.root.id, 'held'); await f.harness.commit(async tx => { (await tx.doc(MetaDoc, f.root.id)).archived = Date.now(); }, context);
      expect((await api('/questions/' + f.root.id + '/held/reply', { answer: 'US', revision: 1, requestId: 'held-answer' })).status).toBe(200);
      expect((await api('/questions/' + f.root.id + '/held/withdraw', { revision: 2, requestId: 'held-withdraw' })).status).toBe(409);
      expect((await api('/questions/' + f.root.id + '/held/context', { answer: 'More review context', revision: 2, requestId: 'held-more' })).status).toBe(200);
      expect((await api('/questions/' + f.root.id + '/held/context', { answer: 'More review context', revision: 2, requestId: 'held-more' })).status).toBe(200);
      expect((await api('/questions/' + f.root.id + '/held/context', { answer: 'Changed text', revision: 2, requestId: 'held-more' })).status).toBe(409);
      expect((await f.get(f.root.id, 'held')).receipt?.answer).toBe('US');
      expect((await listQuestions(f.harness, [f.root.id], context)).filter(q => q.replyTo === 'held')).toHaveLength(1);
      const page = await (await api('/questions?limit=1')).json() as { next: string };
      expect(page.next).toBeTruthy(); expect((await api('/questions?limit=1&cursor=' + page.next)).status).toBe(200);
      expect((await api('/questions?limit=501')).status).toBe(400);
      await f.harness.commit(async tx => { (await tx.doc(QuestionsDoc, f.root.id)).items.legacy = { conversationId: String(f.root.id), key: 'legacy', question: 'Legacy?', options: [], status: 'pending' }; }, context);
      expect((await api('/questions/' + f.root.id + '/legacy/reply', { answer: 'yes' })).status).toBe(200);
    } finally { await server.close(); await f.harness.close(context); await rm(directory, { recursive: true, force: true }); }
  });
});


describe('Append-only question context', () => {
  test('every addition has immutable text, independent delivery and payload-bound replay', async () => {
    const f = await setup();
    try {
      await f.create();
      expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Too soon', 1, 'early', context)).ok).toBe(false);
      await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
      const original = (await f.get()).receipt;
      const first = await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Keep the backup', 2, 'more', context);
      expect(first.ok).toBe(true);
      expect(await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Keep the backup', 2, 'more', context)).toEqual(first);
      expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Delete it', 2, 'more', context)).ok).toBe(false);
      expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'A concurrent addition', 2, 'another', context)).ok).toBe(true);
      const rows = await listQuestions(f.harness, [f.root.id], context);
      expect(rows).toHaveLength(3);
      expect(rows.filter(q => q.replyTo).map(q => q.contextSequence)).toEqual([1, 2]);
      const child = rows.find(q => q.replyTo)!;
      expect(child.replyTo).toBe('question-tool-1');
      expect(child.receipt?.answer).toBe('Keep the backup');
      expect(child.delivery?.requestId).not.toBe((await f.get()).delivery?.requestId);
      expect((await f.get()).receipt).toEqual(original);
      expect((await withdrawQuestion(f.harness, f.root.id, child.key, 1, 'withdraw-context', context)).ok).toBe(false);
      expect((await appendQuestionContext(f.harness, f.root.id, child.key, 'Nested context', 1, 'nested', context)).ok).toBe(false);
      expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', '   ', 3, 'blank', context)).ok).toBe(false);
      expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'x'.repeat(32001), 3, 'large', context)).ok).toBe(false);
    } finally { await f.harness.close(context); }
  });

  test('stopped and changed assignments cannot be restarted by additional context', async () => {
    const f = await setup();
    try {
      await f.member('stopped'); await f.create(f.worker.id);
      await answerQuestion(f.harness, f.worker.id, 'question-tool-1', 'EU', 1, 'answer', context);
      await appendQuestionContext(f.harness, f.worker.id, 'question-tool-1', 'Also keep backups', 2, 'context', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect((await listQuestions(f.harness, [f.worker.id], context)).every(q => q.delivery?.status === 'held')).toBe(true);
      await f.harness.commit(async tx => { const task = (await tx.doc(SessionsDoc, f.root.id)).items.task; task.state = 'running'; task.taskAt = 999; }, context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect((await f.entries(f.worker.id)).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
    } finally { await f.harness.close(context); }
  });

  test('a new context message cannot overtake an older held answer after visibility is repaired', async () => {
    const f = await setup();
    try {
      await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
      await f.harness.commit(async tx => { (await tx.doc(MetaDoc, f.root.id)).archived = Date.now(); }, context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      await f.harness.commit(async tx => { delete (await tx.doc(MetaDoc, f.root.id)).archived; }, context);
      const parent = await f.get();
      await appendQuestionContext(f.harness, f.root.id, parent.key, 'Do not restart automatically', parent.revision!, 'context', context);
      expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
      expect((await f.entries()).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
    } finally { await f.harness.close(context); }
  });

  test('SQLite recovery retains independent additions and exact retry receipts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kiln-question-context-'));
    const path = join(directory, 'kiln.sqlite');
    const f = await setup(await openNodeSqliteStorage(path));
    await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
    const result = await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Keep backups', 2, 'more', context);
    await f.harness.close(context);
    const recovered = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
    try {
      expect(await appendQuestionContext(recovered, f.root.id, 'question-tool-1', 'Keep backups', 2, 'more', context)).toEqual(result);
      const rows = await listQuestions(recovered, [f.root.id], context);
      expect(rows).toHaveLength(2);
      expect(rows.find(q => q.replyTo)?.receipt?.answer).toBe('Keep backups');
      expect(rows.find(q => !q.replyTo)?.receipt?.answer).toBe('EU');
    } finally { await recovered.close(context); await rm(directory, { recursive: true, force: true }); }
  });
});


test('nested codemode questions link to the actual assistant entry, not free-text source claims', async () => {
  const f = await setup();
  const codemode = hearthCodemodeExtensions({ env: {} });
  for (const extension of codemode.extensions) f.registry.install(extension);
  const faux = fauxProvider(); f.models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('codemode', { code: 'text(await tools.ask({ action: "create", question: "Keep the nested backup?", source: "made-up e999999" }));' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('I continued independent work.')]),
  ]);
  try {
    const root = await f.harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
    await (await root.submit({ type: 'input', content: 'Ask from codemode' }, context)).wait(context);
    const questions = Object.values((await f.harness.snapshot(QuestionsDoc, root.id, context))?.items ?? {});
    expect(questions).toHaveLength(1);
    const entries = (await root.entries({}, 100, undefined, context)).items;
    const source = entries.find(entry => 'e' + entry.id === questions[0].origin?.sourceMessageId);
    expect(source?.kind).toBe('pi.assistant');
    expect(JSON.stringify(source?.model)).toContain('codemode');
    expect(questions[0].origin?.sourceMessageId).not.toBe('e999999');
  } finally { await f.harness.close(context); codemode.close(); }
}, 30000);

test('original answer and concurrent additions are delivered exactly once in their durable sequence', async () => {
  const f = await setup();
  const faux = fauxProvider(); f.models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Used the original answer'), fauxAssistantMessage('Used context one'), fauxAssistantMessage('Used context two')]);
  try {
    await f.root.configure({ model: { provider: 'faux', modelId: 'faux-1' } }, context);
    await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'original', context);
    const additions = await Promise.all([
      appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Keep backups', 2, 'context-one', context),
      appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Verify the rollout', 2, 'context-two', context),
    ]);
    expect(additions.every(result => result.ok)).toBe(true);
    for (let i = 0; i < 3; i++) { await resumeQuestions(f.harness, f.root.id, context); await f.root.waitForIdle(context); }
    const entries = (await f.entries()).filter(entry => entry.kind === 'hearth.question-answer').sort((a, b) => Number(a.id) - Number(b.id));
    const text = entries.map(entry => (entry.data as { receipt: { answer: string } }).receipt.answer);
    expect(text).toEqual(['EU', 'Keep backups', 'Verify the rollout']);
    expect((await f.get()).receipt?.answer).toBe('EU');
    expect(await resumeQuestions(f.harness, f.root.id, context)).toBe(0);
    expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Keep backups', 2, 'context-one', context)).ok).toBe(true);
    expect((await f.entries()).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(3);
  } finally { await f.harness.close(context); }
});

for (const outcome of ['done', 'blocked', 'incomplete', 'handoff-needed'] as const) {
  test(`additional context never reopens an explicit ${outcome} assignment`, async () => {
    const f = await setup();
    try {
      await f.member('reported'); await f.create(f.worker.id);
      await f.harness.commit(async tx => {
        const entry = (await tx.doc(SessionsDoc, f.root.id)).items.task;
        entry.taskLifecycle = 'explicit';
        entry.completion = { task: threadTask(entry), requestId: 'outcome-receipt', outcome, summary: 'Recorded outcome', evidence: 'Result document', remaining: 'Needs direction', at: 123 };
      }, context);
      await answerQuestion(f.harness, f.worker.id, 'question-tool-1', 'EU', 1, 'answer', context);
      await appendQuestionContext(f.harness, f.worker.id, 'question-tool-1', 'Keep this for review', 2, 'more', context);
      expect(await resumeQuestions(f.harness, f.worker.id, context)).toBe(0);
      expect((await f.entries(f.worker.id)).filter(entry => entry.kind === 'hearth.question-answer')).toHaveLength(0);
      expect((await f.harness.snapshot(SessionsDoc, f.root.id, context))?.items.task.completion?.outcome).toBe(outcome);
    } finally { await f.harness.close(context); }
  });
}

test('context limit bounds new records without rejecting an exact accepted retry', async () => {
  const f = await setup();
  try {
    await f.create(); await answerQuestion(f.harness, f.root.id, 'question-tool-1', 'EU', 1, 'answer', context);
    for (let i = 0; i < 100; i++) expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Context ' + i, 2, 'context-' + i, context)).ok).toBe(true);
    expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'One too many', 2, 'over-limit', context)).error).toBe('limit');
    expect((await appendQuestionContext(f.harness, f.root.id, 'question-tool-1', 'Context 0', 2, 'context-0', context)).ok).toBe(true);
    expect((await listQuestions(f.harness, [f.root.id], context)).filter(item => item.replyTo)).toHaveLength(100);
    expect((await f.get()).receipt?.answer).toBe('EU');
  } finally { await f.harness.close(context); }
});
