import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, InboxDoc, MemoryStorage, createRegistry, type Storage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { markWorkerStopped } from '../src/crew';
import { MetaDoc } from '../src/meta';
import { parkInputs } from '../src/parking';
import { QuestionsDoc } from '../src/ask';
import { StopQueueDoc, prepareStopQueueHandoff, resumeStopQueueHandoff } from '../src/stopQueueHandoff';

const setup = async (storage: Storage = new MemoryStorage()) => {
  const models = createModels();
  const faux = fauxProvider(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Answered the queued human message'), fauxAssistantMessage('Answered the second message')]);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, context);
  const queue = async (content: string, mode: 'followUp' | 'steer' = 'followUp') => harness.commit(async tx => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const record = await tx.createSubmission({ conversationId: conversation.id, type: 'input', status: 'queued' });
    inbox.items.push({ id: record.id, mode, content });
    return record.id;
  }, context);
  const prepare = async (token = 'desktop-stop', requested = true) => harness.commit(async tx => {
    await markWorkerStopped(tx, conversation.id);
    return prepareStopQueueHandoff(tx, conversation.id, token, requested);
  }, context);
  const userTexts = async () => (await conversation.entries({}, 100, undefined, context)).items.filter(entry => entry.kind === 'pi.user').sort((a, b) => Number(a.id) - Number(b.id)).flatMap(entry => entry.model ?? []).map(message => message.content);
  return { harness, conversation, models, faux, queue, prepare, userTexts };
};

describe('desktop Stop queue handoff safety', () => {
  test('concurrent callback and supervisor admit human inputs once, FIFO, with a steer converted to a new turn', async () => {
    const f = await setup();
    try {
      await f.queue('First human direction', 'steer'); await f.queue('Second human direction');
      await f.prepare();
      const results = await Promise.all([resumeStopQueueHandoff(f.harness, f.conversation.id, context), resumeStopQueueHandoff(f.harness, f.conversation.id, context)]);
      expect(results).toEqual([2, 2]);
      await f.conversation.waitForIdle(context);
      expect(await f.userTexts()).toEqual(['First human direction', 'Second human direction']);
      expect((await f.harness.snapshot(InboxDoc, f.conversation.id, context))?.items).toHaveLength(0);
      expect((await f.harness.snapshot(StopQueueDoc, f.conversation.id, context))?.pending).toBeUndefined();
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('no queue means no restart of the interrupted old prompt', async () => {
    const f = await setup();
    try {
      await f.prepare();
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
      expect(await f.userTexts()).toEqual([]);
      expect(f.faux.state.callCount).toBe(0);
      expect((await f.harness.snapshot(MetaDoc, f.conversation.id, context))?.stoppedAt).toBeGreaterThan(0);
    } finally { await f.harness.close(context); }
  });

  test('worker cancellation and API full stops never opt into the desktop handoff', async () => {
    const f = await setup();
    try {
      await f.queue('Waiting direction');
      expect(await f.prepare('full-stop', false)).toBeUndefined();
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
      await f.harness.commit(async tx => { (await tx.doc(MetaDoc, f.conversation.id)).kind = 'worker'; }, context);
      expect(await f.prepare('worker-stop')).toBeUndefined();
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
      expect(f.faux.state.callCount).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('a newer stop or explicit new direction invalidates stale handoffs without re-parking old inputs', async () => {
    const f = await setup();
    try {
      await f.queue('Do not replay this after a new direction'); await f.prepare('old-stop');
      await f.prepare('new-full-stop', false);
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
      await f.prepare('second-old-stop');
      await f.harness.commit(async tx => { delete (await tx.doc(MetaDoc, f.conversation.id)).stoppedAt; }, context);
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
      expect((await f.harness.snapshot(StopQueueDoc, f.conversation.id, context))?.pending).toBeUndefined();
      expect(f.faux.state.callCount).toBe(0);
    } finally { await f.harness.close(context); }
  });

  test('a repeated desktop stop keeps an older handoff’s unplaced messages', async () => {
    const f = await setup();
    try {
      await f.queue('Do not lose this between stops');
      await f.prepare('first-stop');
      await f.conversation.abort(context);
      await f.prepare('second-stop');
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(1);
      await f.conversation.waitForIdle(context);
      expect(await f.userTexts()).toEqual(['Do not lose this between stops']);
    } finally { await f.harness.close(context); }
  });

  test('internal question answers are held, never replayed as new human directions', async () => {
    const f = await setup();
    try {
      await f.harness.commit(async tx => {
        const inbox = await tx.doc(InboxDoc, f.conversation.id);
        const questions = await tx.doc(QuestionsDoc, f.conversation.id);
        questions.items.q = { conversationId: String(f.conversation.id), key: 'q', mode: 'async', question: 'Which region?', options: [], status: 'answered', revision: 2, answer: 'EU' };
        const record = await tx.createSubmission({ conversationId: f.conversation.id, type: 'input', status: 'queued' });
        inbox.items.push({ id: record.id, mode: 'followUp', content: 'Internal question answer', entry: { kind: 'hearth.question-answer', data: { questionId: 'q' } } });
      }, context);
      await f.prepare();
      expect(await resumeStopQueueHandoff(f.harness, f.conversation.id, context)).toBe(0);
      expect(await f.userTexts()).toEqual([]);
      expect((await f.harness.snapshot(QuestionsDoc, f.conversation.id, context))?.items.q.resumeRequired).toBe(true);
      expect(f.faux.state.callCount).toBe(0);
    } finally { await f.harness.close(context); }
  });

  for (const ready of [false, true]) {
    test(`SQLite restart recovers the ${ready ? 're-parked' : 'stopping'} handoff without a duplicate message`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'kiln-stop-handoff-'));
      const path = join(directory, 'hearth.sqlite');
      const f = await setup(await openNodeSqliteStorage(path));
      const id = f.conversation.id;
      await f.queue('Human direction survives restart', 'steer');
      const saved = (await f.prepare())!;
      await f.conversation.abort(context);
      if (ready) {
        await f.harness.commit(async tx => { (await tx.doc(StopQueueDoc, id)).pending!.ready = true; }, context);
        await parkInputs(change => f.harness.commit(change, context), id, saved);
      }
      await f.harness.close(context);
      const recovered = await Harness.open(await openNodeSqliteStorage(path), { models: f.models, registry: createRegistry() }, context);
      try {
        expect(await resumeStopQueueHandoff(recovered, id, context)).toBe(1);
        const conversation = (await recovered.conversation(id, context))!;
        await conversation.waitForIdle(context);
        const texts = (await conversation.entries({}, 100, undefined, context)).items.filter(entry => entry.kind === 'pi.user').sort((a, b) => Number(a.id) - Number(b.id)).flatMap(entry => entry.model ?? []).map(message => message.content);
        expect(texts).toEqual(['Human direction survives restart']);
        expect(await resumeStopQueueHandoff(recovered, id, context)).toBe(0);
      } finally { await recovered.close(context); await rm(directory, { recursive: true, force: true }); }
    });
  }
});
