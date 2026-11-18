import { describe, expect, test } from 'bun:test';
import {
  addPendingNote,
  createPendingCreate,
  failPendingCreate,
  handOffPendingMessages,
  HELD_MESSAGE_NOTE,
  heldBehindFailedQueueText,
  heldFollowUpFailureText,
  holdPendingMessage,
  pendingCreateComposerText,
  pendingCreateMessages,
  restartPendingCreate,
  settleStagedFollowUps,
} from '../src/lib/pendingCreate';
import type {
  PendingCreate,
  PendingCreateMessage,
  PendingFirstSendOutcome,
} from '../src/lib/pendingCreate';
import { buildStagedQueuedMessage, mergeMutationSession } from '../src/hooks/useMessageQueue';
import type { FileAttachment, MessageQueueSession, ModelOption, NewSessionOptions, QueuedMessage } from '../src/types';

/**
 * The draft pane shows a message before any session can hold it. These tests pin the transitions
 * (begin, hold, fail, retry) and what the pane renders, because the handover to the real session is
 * only invisible if the draft's bubble and `sendTo`'s look the same.
 */

const CLAUDE: ModelOption = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet',
  label: 'Claude Sonnet',
  details: {
    name: 'Claude Sonnet',
    providerName: 'Anthropic',
    reasoning: true,
    toolcall: true,
    attachment: true,
    inputs: ['image'],
    variants: ['low', 'high'],
  },
};

const HEARTH: NewSessionOptions = {
  instanceId: 'hearth',
  directory: '/work/ember',
  model: CLAUDE,
  variant: 'high',
  bypass: false,
};

const SHOT: FileAttachment = { filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,AAA' };
const NOTES: FileAttachment = { filename: 'notes.md', mime: 'text/markdown', url: 'data:text/markdown,BBB' };

const firstMessage = (overrides: Partial<PendingCreateMessage> = {}): PendingCreateMessage => ({
  id: 'm1',
  input: { text: '  Start the migration  ', model: CLAUDE, variant: 'high' },
  text: 'Start the migration',
  attachments: [],
  createdAt: 1_000,
  held: false,
  ...overrides,
});

const draft = (
  overrides: Partial<Parameters<typeof createPendingCreate>[0]> = {},
  message: PendingCreateMessage = firstMessage()
): PendingCreate =>
  createPendingCreate({
    id: 'p1',
    options: HEARTH,
    title: 'Migration Steward',
    message,
    createdAt: 1_000,
    ...overrides,
  });

describe('starting a new agent', () => {
  test('the first message is the trigger, so it is never held', () => {
    const pending = draft({}, firstMessage({ held: true }));
    expect(pending.phase).toBe('creating');
    expect(pending.failure).toBeUndefined();
    expect(pending.createdAt).toBe(1_000);
    expect(pending.title).toBe('Migration Steward');
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0]).toMatchObject({ id: 'm1', text: 'Start the migration', held: false });
  });

  test('a message typed while creating is held after the ones already there', () => {
    const before = draft();
    const pending = holdPendingMessage(before, {
      id: 'm2',
      input: { text: '  Then wire the queue  ', attachments: [SHOT] },
      createdAt: 2_000,
    });
    expect(pending.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(pending.messages[1]).toMatchObject({
      held: true,
      text: 'Then wire the queue',
      attachments: [SHOT],
      createdAt: 2_000,
    });
    // App replaces the value; a render must never see half an append.
    expect(before.messages.map((message) => message.id)).toEqual(['m1']);
    expect(pending).not.toBe(before);
  });

  test('a whole message can be passed, but a held one cannot claim it was sent', () => {
    // Enter during a create is what makes a message held; the flag is the pane's to set, not the
    // caller's, or a spread message would arrive marked as the trigger.
    const pending = holdPendingMessage(draft(), {
      ...firstMessage({ id: 'm2' }),
      held: false,
    });
    expect(pending.messages[1]).toMatchObject({ id: 'm2', held: true });
  });
});

describe('the bubbles in the draft transcript', () => {
  test('one bubble per message, in the order they were typed', () => {
    const pending = holdPendingMessage(
      draft({}, firstMessage({ attachments: [SHOT], input: { text: 'Start the migration', attachments: [SHOT] } })),
      { id: 'm2', input: { text: 'Then wire the queue', attachments: [NOTES] }, createdAt: 2_000 }
    );
    const bubbles = pendingCreateMessages(pending);
    expect(bubbles.map((bubble) => bubble.id)).toEqual(['m1', 'm2']);
    expect(bubbles.map((bubble) => bubble.createdAt)).toEqual([1_000, 2_000]);
    for (const bubble of bubbles) {
      expect(bubble.role).toBe('user');
      expect(bubble.completed).toBe(true);
    }
  });

  test('parts mirror the text and the files exactly as a real optimistic bubble does', () => {
    const pending = holdPendingMessage(
      draft({}, firstMessage({ attachments: [SHOT], input: { text: 'Start the migration', attachments: [SHOT] } })),
      { id: 'm2', input: { text: 'Then wire the queue', attachments: [NOTES] }, createdAt: 2_000 }
    );
    const [first, second] = pendingCreateMessages(pending);
    expect(first?.parts).toEqual([
      { type: 'text', id: 'm1-text', text: 'Start the migration' },
      { type: 'file', id: 'm1-file-0', file: SHOT },
    ]);
    expect(second?.parts).toEqual([
      { type: 'text', id: 'm2-text', text: 'Then wire the queue' },
      { type: 'file', id: 'm2-file-0', file: NOTES },
    ]);
  });

  test('an empty text leaves no text part, and a text-only message leaves no file part', () => {
    const imageOnly = pendingCreateMessages(
      draft({}, firstMessage({ text: '', input: { text: '   ', attachments: [SHOT] }, attachments: [SHOT] }))
    );
    expect(imageOnly[0]?.parts).toEqual([{ type: 'file', id: 'm1-file-0', file: SHOT }]);
    expect(pendingCreateMessages(draft())[0]?.parts).toEqual([
      { type: 'text', id: 'm1-text', text: 'Start the migration' },
    ]);
  });

  test('each bubble carries its own message model, not the draft row’s current one', () => {
    const pending = holdPendingMessage(draft(), {
      id: 'm2',
      input: { text: 'Now in a cheaper model', model: { ...CLAUDE, modelID: 'claude-haiku' }, variant: 'low' },
      createdAt: 2_000,
    });
    const [first, second] = pendingCreateMessages(pending);
    expect(first?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high' });
    expect(second?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku', variant: 'low' });
  });

  test('the bubbles are in flight, not parked anywhere', () => {
    const bubbles = pendingCreateMessages(draft());
    expect(bubbles[0]?.delivery).toBe('sending');
    expect(bubbles[0]?.deliveryError).toBeUndefined();
  });

  test('a held message says when it will be sent — and only while the session is still starting', () => {
    const pending = holdPendingMessage(draft(), {
      id: 'm2',
      input: { text: 'Then wire the queue' },
      createdAt: 2_000,
    });
    const [first, second] = pendingCreateMessages(pending);
    expect(first?.deliveryNote).toBeUndefined();
    expect(second?.deliveryNote).toBe(HELD_MESSAGE_NOTE);
    expect(HELD_MESSAGE_NOTE).toBe('Sends once this session has started.');
  });
});

describe('a create that failed', () => {
  const failedDraft = () =>
    failPendingCreate(
      holdPendingMessage(draft(), { id: 'm2', input: { text: 'Then wire the queue' }, createdAt: 2_000 }),
      "Heliograph didn't start this session. Try again."
    );

  test('every bubble fails with the same reason, because Try again replays them together', () => {
    const failed = failedDraft();
    expect(failed.phase).toBe('failed');
    expect(failed.failure).toBe("Heliograph didn't start this session. Try again.");
    const bubbles = pendingCreateMessages(failed);
    expect(bubbles.map((bubble) => bubble.id)).toEqual(['m1', 'm2']);
    for (const bubble of bubbles) {
      expect(bubble.delivery).toBe('failed');
      expect(bubble.deliveryError).toBe(failed.failure);
      // One note per bubble: the failure is the sentence worth reading now.
      expect(bubble.deliveryNote).toBeUndefined();
    }
  });

  test('the messages survive the failure: they are what the retry is for', () => {
    const failed = failedDraft();
    expect(failed.messages.map((message) => message.text)).toEqual([
      'Start the migration',
      'Then wire the queue',
    ]);
  });
});

describe('trying again', () => {
  test('keeps every message and held flag, and swaps only the destination', () => {
    const failed = failPendingCreate(
      holdPendingMessage(draft(), { id: 'm2', input: { text: 'Then wire the queue' }, createdAt: 2_000 }),
      "Heliograph didn't start this session. Try again."
    );
    const elsewhere: NewSessionOptions = {
      instanceId: 'other-hearth',
      directory: '/work/elsewhere',
      bypass: true,
    };
    const restarted = restartPendingCreate(failed, elsewhere);
    expect(restarted).not.toBe(failed);
    expect(restarted.phase).toBe('creating');
    expect(restarted.failure).toBeUndefined();
    expect(restarted.options).toBe(elsewhere);
    expect(restarted.options.directory).toBe('/work/elsewhere');
    // The same attempt, with the same conversation in it — not a rebuilt one.
    expect(restarted.id).toBe('p1');
    expect(restarted.title).toBe('Migration Steward');
    expect(restarted.messages).toBe(failed.messages);
    expect(restarted.messages.map((message) => message.held)).toEqual([false, true]);
    // Back in flight, so the pane stops showing a failure and the held note returns.
    expect(pendingCreateMessages(restarted).map((bubble) => bubble.delivery)).toEqual(['sending', 'sending']);
    expect(pendingCreateMessages(restarted)[1]?.deliveryNote).toBe(HELD_MESSAGE_NOTE);
  });
});

describe('Edit hands the draft back to the composer', () => {
  test('a single message round-trips exactly', () => {
    expect(pendingCreateComposerText(draft())).toEqual({ text: 'Start the migration', attachments: [] });
    const withFile = draft(
      {},
      firstMessage({ attachments: [SHOT], input: { text: 'Start the migration', attachments: [SHOT] } })
    );
    expect(pendingCreateComposerText(withFile)).toEqual({ text: 'Start the migration', attachments: [SHOT] });
  });

  test('several messages join with a blank line, keeping each message intact', () => {
    const pending = holdPendingMessage(
      draft({}, firstMessage({ attachments: [SHOT], input: { text: 'Start the migration', attachments: [SHOT] } })),
      {
        id: 'm2',
        input: { text: 'Then wire the queue\n\nand the mock', attachments: [NOTES] },
        createdAt: 2_000,
      }
    );
    expect(pendingCreateComposerText(pending)).toEqual({
      text: 'Start the migration\n\nThen wire the queue\n\nand the mock',
      attachments: [SHOT, NOTES],
    });
  });

  test('a message with no text contributes its files and not a blank line', () => {
    const pending = holdPendingMessage(draft(), {
      id: 'm2',
      input: { text: '   ', attachments: [SHOT] },
      createdAt: 2_000,
    });
    expect(pendingCreateComposerText(pending)).toEqual({ text: 'Start the migration', attachments: [SHOT] });
  });
});

describe('notes parked on a draft', () => {
  test('are kept with the attempt, and survive a retry', () => {
    const pending = addPendingNote(
      addPendingNote(createPendingCreate({
        id: 'create-1',
        options: { instanceId: 'pi:test', directory: '/work', bypass: false },
        title: 'Output Inspector',
        message: { id: 'msg-1', input: { text: 'check the build output' }, text: 'check the build output', attachments: [], createdAt: 1, held: false },
        createdAt: 1,
      }), { id: 'note-1', text: 'ask about the flaky test' }),
      { id: 'note-2', text: 'and the retry budget' }
    );
    expect(pending.notes?.map((note) => note.text)).toEqual([
      'ask about the flaky test',
      'and the retry budget',
    ]);
    const retried = restartPendingCreate(pending, {
      instanceId: 'pi:test',
      directory: '/other',
      bypass: false,
    });
    // A retry is about the destination, not about what the person parked.
    expect(retried.notes).toEqual(pending.notes);
  });
});

describe('multi-message handoff to the created session', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const multiMessageDraft = () =>
    holdPendingMessage(
      holdPendingMessage(
        holdPendingMessage(draft(), {
          id: 'm2',
          input: { text: 'Second step', model: CLAUDE, variant: 'high', attachments: [SHOT] },
          createdAt: 2_000,
        }),
        {
          id: 'm3',
          input: { text: 'Third step', model: CLAUDE, variant: 'low' },
          createdAt: 3_000,
        }
      ),
      {
        id: 'm4',
        input: { text: 'Fourth step', model: CLAUDE },
        createdAt: 4_000,
      }
    );

  test('stages M2..Mn synchronously before M1 awaits the network, leaving zero vanishing window', async () => {
    const pending = multiMessageDraft();
    const firstSend = deferred<PendingFirstSendOutcome>();
    const events: string[] = [];
    let queueSnapshot: QueuedMessage[] = [];
    const flushed: string[] = [];

    const handoff = handOffPendingMessages({
      messages: pending.messages,
      instanceLabel: 'Tower',
      stageFollowUps: (followUps) => {
        events.push('stageFollowUps');
        queueSnapshot = followUps.map((entry) => buildStagedQueuedMessage(entry, entry.input.model));
        return queueSnapshot.map((item) => item.id);
      },
      sendFirst: (input) => {
        events.push(`sendFirst:${input.text.trim()}:${Boolean(input.configured)}`);
        return firstSend.promise;
      },
      flushFollowUp: async (id) => {
        flushed.push(id);
        return true;
      },
      failFollowUps: () => {
        events.push('failFollowUps');
      },
    });

    // Synchronously in the same tick that opens the session column: M2..M4 are staged in the queue
    // and M1 has started sending, while zero follow-ups have been dispatched prematurely.
    expect(events).toEqual(['stageFollowUps', 'sendFirst:Start the migration:true']);
    expect(queueSnapshot.map((item) => ({ id: item.id, text: item.text, pending: item.pending, staged: item.staged }))).toEqual([
      { id: 'local-m2', text: 'Second step', pending: true, staged: true },
      { id: 'local-m3', text: 'Third step', pending: true, staged: true },
      { id: 'local-m4', text: 'Fourth step', pending: true, staged: true },
    ]);
    expect(queueSnapshot[0]?.attachments).toEqual([
      { filename: 'shot.png', mimeType: 'image/png', dataUrl: SHOT.url },
    ]);
    expect(flushed).toEqual([]);

    firstSend.resolve({ uiHeld: true, serverAccepted: true, messageId: 'opt-m1' });
    const result = await handoff;
    expect(result.dispatchedCount).toBe(3);
    expect(result.haltedAtIndex).toBeNull();
    expect(flushed).toEqual(['local-m2', 'local-m3', 'local-m4']);
  });

  test('dispatches M2..Mn strictly sequentially in FIFO order, never in parallel', async () => {
    const pending = multiMessageDraft();
    const firstSend = deferred<PendingFirstSendOutcome>();
    const flushGates = new Map<string, ReturnType<typeof deferred<boolean>>>([
      ['local-m2', deferred<boolean>()],
      ['local-m3', deferred<boolean>()],
      ['local-m4', deferred<boolean>()],
    ]);
    const started: string[] = [];
    let queueSession: MessageQueueSession = {
      sessionId: '51',
      directory: '/work/ember',
      sendingId: null,
      items: [],
    };

    const handoff = handOffPendingMessages({
      messages: pending.messages,
      instanceLabel: 'Tower',
      stageFollowUps: (followUps) => {
        const items = followUps.map((entry) => buildStagedQueuedMessage(entry, entry.input.model));
        queueSession = { ...queueSession, items };
        return items.map((item) => item.id);
      },
      sendFirst: () => firstSend.promise,
      flushFollowUp: async (id) => {
        started.push(id);
        const ok = await flushGates.get(id)!.promise;
        if (ok) {
          // Simulate `removeLocalItem` + `applyQueueMutation` (`mergeMutationSession`) in useMessageQueue.
          const withoutLocal: MessageQueueSession = {
            ...queueSession,
            items: queueSession.items.filter((item) => item.id !== id),
          };
          const settledCount = started.length;
          const serverItems = pending.messages.slice(1, 1 + settledCount).map((entry, idx) => ({
            ...buildStagedQueuedMessage(entry, entry.input.model),
            id: `srv-${idx + 2}`,
            pending: undefined,
            staged: undefined,
          }));
          queueSession = mergeMutationSession(withoutLocal, {
            ...withoutLocal,
            items: serverItems,
          });
        }
        return ok;
      },
      failFollowUps: () => {},
    });

    firstSend.resolve({ uiHeld: true, serverAccepted: true, messageId: 'opt-m1' });
    await Promise.resolve();
    await Promise.resolve();

    // Only M2 has begun; M3 and M4 have NOT started in parallel.
    expect(started).toEqual(['local-m2']);

    flushGates.get('local-m2')!.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    // M2 settled into srv-2 while M3 and M4 remain right behind it in FIFO order, and ONLY M3 started next.
    expect(started).toEqual(['local-m2', 'local-m3']);
    expect(queueSession.items.map((item) => item.id)).toEqual(['srv-2', 'local-m3', 'local-m4']);

    flushGates.get('local-m3')!.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(['local-m2', 'local-m3', 'local-m4']);
    expect(queueSession.items.map((item) => item.id)).toEqual(['srv-2', 'srv-3', 'local-m4']);

    flushGates.get('local-m4')!.resolve(true);
    const result = await handoff;
    expect(result.dispatchedCount).toBe(3);
    expect(queueSession.items.map((item) => item.id)).toEqual(['srv-2', 'srv-3', 'srv-4']);
  });

  test('never dispatches M2..Mn when M1 fails HTTP submission, even when retainOnFailure sets uiHeld: true', async () => {
    const pending = multiMessageDraft();
    for (const failedOutcome of [
      // Exact B3 trap: retainOnFailure returns uiHeld: true while serverAccepted is false.
      { uiHeld: true, serverAccepted: false, messageId: 'opt-m1' },
      { uiHeld: false, serverAccepted: false, messageId: 'opt-m1' },
    ] as const) {
      let queueItems: QueuedMessage[] = [];
      const flushed: string[] = [];
      const retainedTriggers: Array<{ messageId: string; stagedIds: readonly string[] }> = [];

      const result = await handOffPendingMessages({
        messages: pending.messages,
        instanceLabel: 'Tower',
        stageFollowUps: (followUps) => {
          queueItems = followUps.map((entry) => buildStagedQueuedMessage(entry, entry.input.model));
          return queueItems.map((item) => item.id);
        },
        sendFirst: async () => failedOutcome,
        flushFollowUp: async (id) => {
          flushed.push(id);
          return true;
        },
        failFollowUps: (ids, reason) => {
          const failedSet = new Set(ids);
          queueItems = queueItems.map((item) =>
            failedSet.has(item.id) ? { ...item, pending: false, staged: undefined, error: reason } : item
          );
        },
        onRetainFailedTrigger: (messageId, stagedIds) => {
          retainedTriggers.push({ messageId, stagedIds });
        },
      });

      // Zero follow-up HTTP requests were dispatched after M1 failed.
      expect(flushed).toEqual([]);
      expect(result.dispatchedCount).toBe(0);
      expect(result.haltedAtIndex).toBe(0);

      // Every held message stays safe and visible in the queue with full text and attachments intact.
      expect(queueItems.map((item) => item.text)).toEqual(['Second step', 'Third step', 'Fourth step']);
      expect(queueItems[0]?.attachments).toHaveLength(1);
      for (const item of queueItems) {
        expect(item.pending).toBe(false);
        expect(item.staged).toBeUndefined();
        expect(item.error).toBe(heldFollowUpFailureText('Tower'));
      }

      if (failedOutcome.uiHeld) {
        expect(retainedTriggers).toEqual([
          { messageId: 'opt-m1', stagedIds: ['local-m2', 'local-m3', 'local-m4'] },
        ]);
        // Retrying M1 ("Send again") and succeeding resumes the held follow-ups in FIFO order.
        const resumedOrder: string[] = [];
        const resumed = await settleStagedFollowUps({
          firstOutcome: { uiHeld: true, serverAccepted: true, messageId: 'opt-m1-retry' },
          stagedIds: retainedTriggers[0]!.stagedIds,
          instanceLabel: 'Tower',
          flushFollowUp: async (id) => {
            resumedOrder.push(id);
            return true;
          },
          failFollowUps: () => {},
        });
        expect(resumed.dispatchedCount).toBe(3);
        expect(resumedOrder).toEqual(['local-m2', 'local-m3', 'local-m4']);
      } else {
        expect(retainedTriggers).toEqual([]);
      }
    }
  });

  test('never dispatches M2..Mn if sendFirst rejects unexpectedly', async () => {
    const pending = multiMessageDraft();
    const flushed: string[] = [];
    let failedIds: readonly string[] = [];
    const result = await handOffPendingMessages({
      messages: pending.messages,
      instanceLabel: 'Tower',
      stageFollowUps: (followUps) => followUps.map((entry) => `local-${entry.id}`),
      sendFirst: () => Promise.reject(new Error('socket closed')),
      flushFollowUp: async (id) => {
        flushed.push(id);
        return true;
      },
      failFollowUps: (ids) => {
        failedIds = ids;
      },
    });
    expect(flushed).toEqual([]);
    expect(failedIds).toEqual(['local-m2', 'local-m3', 'local-m4']);
    expect(result.dispatchedCount).toBe(0);
    expect(result.haltedAtIndex).toBe(0);
  });

  test('stops sequential dispatch if an intermediate follow-up fails, keeping later follow-ups safe', async () => {
    const pending = multiMessageDraft();
    const attempted: string[] = [];
    let pausedTail: { ids: readonly string[]; reason: string } | null = null;

    const result = await handOffPendingMessages({
      messages: pending.messages,
      instanceLabel: 'Tower',
      stageFollowUps: (followUps) => followUps.map((entry) => `local-${entry.id}`),
      sendFirst: async () => ({ uiHeld: true, serverAccepted: true, messageId: 'opt-m1' }),
      flushFollowUp: async (id) => {
        attempted.push(id);
        return id !== 'local-m3';
      },
      failFollowUps: (ids, reason) => {
        pausedTail = { ids, reason };
      },
    });

    // M2 succeeded, M3 failed, so M4 was NEVER sent ahead of M3 and was marked paused instead.
    expect(attempted).toEqual(['local-m2', 'local-m3']);
    expect(result.dispatchedCount).toBe(1);
    expect(result.haltedAtIndex).toBe(1);
    expect(pausedTail).toEqual({
      ids: ['local-m4'],
      reason: heldBehindFailedQueueText('Tower'),
    });
  });

  test('held follow-up failure copy names the actor, offers on-screen recovery, and avoids jargon', () => {
    for (const sentence of [
      heldFollowUpFailureText('Tower'),
      heldFollowUpFailureText(),
      heldBehindFailedQueueText('Tower'),
      heldBehindFailedQueueText(),
    ]) {
      expect(sentence).toContain('Ember');
      expect(sentence).toMatch(/Tower|the host/);
      expect(sentence).toMatch(/Retry/);
      expect(sentence).not.toMatch(/!|HTTP|\b[45]\d\d\b|undefined|null|stack|Something went wrong/i);
    }
  });
});
