import { describe, expect, test } from 'bun:test';
import {
  buildStagedQueuedMessage,
  mergeMutationSession,
  mergePolledQueues,
  resolveQueueReplaceTargets,
} from '../src/hooks/useMessageQueue';
import type { MessageQueueSession, QueuedMessage } from '../src/types';

const queued = (id: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  createdAt: 0,
  content: id,
  text: id,
  attachments: [],
  context: [],
  sendConfig: { providerID: 'p', modelID: 'm' },
  ...extra,
});

const session = (items: QueuedMessage[]): MessageQueueSession => ({
  sessionId: 's',
  directory: '/d',
  sendingId: null,
  items,
});

describe('message queue polling', () => {
  test('keeps local pending and failed rows across a poll', () => {
    const prev = {
      local: [session([queued('server-1'), queued('local-1', { pending: true }), queued('local-2', { error: 'nope' })])],
    };
    const next = { local: [session([queued('server-1'), queued('server-2')])] };
    const merged = mergePolledQueues(prev, next);
    expect(merged.local[0].items.map((item) => item.id)).toEqual([
      'local-1',
      'local-2',
      'server-1',
      'server-2',
    ]);
  });

  test('a poll that already lists the message does not draw it twice', () => {
    // The optimistic row has no id the poll can match, so it was kept alongside the host's copy: the
    // same message appeared twice for ~200ms on every enqueue (measured in the pi mock).
    const prev = {
      local: [session([queued('local-1', { pending: true, text: 'hello' })])],
    };
    const next = { local: [session([queued('server-1', { text: 'hello' })])] };
    const merged = mergePolledQueues(prev, next);
    expect(merged.local[0].items.map((item) => item.id)).toEqual(['server-1']);
  });

  test('two identical messages queued back to back still end up as two rows', () => {
    const prev = {
      local: [
        session([
          queued('local-1', { pending: true, text: 'same text' }),
          queued('local-2', { pending: true, text: 'same text' }),
        ]),
      ],
    };
    // The host has settled one of them so far.
    const next = { local: [session([queued('server-1', { text: 'same text' })])] };
    const merged = mergePolledQueues(prev, next);
    expect(merged.local[0].items.map((item) => item.id)).toEqual(['local-2', 'server-1']);
  });

  test('a different message is not swallowed by the match', () => {
    const prev = { local: [session([queued('local-1', { pending: true, text: 'mine' })])] };
    const next = { local: [session([queued('server-1', { text: 'theirs' })])] };
    expect(mergePolledQueues(prev, next).local[0].items.map((item) => item.id)).toEqual([
      'local-1',
      'server-1',
    ]);
  });

  test('a mode difference is not the same message', () => {
    // A steer and a follow-up with the same text are two different requests to the host.
    const prev = {
      local: [session([queued('local-1', { pending: true, text: 'go', mode: 'steer' })])],
    };
    const next = { local: [session([queued('server-1', { text: 'go', mode: 'follow-up' })])] };
    expect(mergePolledQueues(prev, next).local[0].items.map((item) => item.id)).toEqual([
      'local-1',
      'server-1',
    ]);
  });

  test('a failed row is kept: it is not a copy of anything', () => {
    const prev = {
      local: [session([queued('local-1', { error: 'refused', text: 'hello' })])],
    };
    const next = { local: [session([queued('server-1', { text: 'hello' })])] };
    expect(mergePolledQueues(prev, next).local[0].items.map((item) => item.id)).toEqual([
      'local-1',
      'server-1',
    ]);
  });
  test('keeps a queue that only holds local rows', () => {
    const prev = { local: [session([queued('local-1', { pending: true })])] };
    const next = { local: [] as MessageQueueSession[] };
    const merged = mergePolledQueues(prev, next);
    expect(merged.local).toHaveLength(1);
    expect(merged.local[0].items.map((item) => item.id)).toEqual(['local-1']);
  });

  test('drops a local row once the server reports the same id', () => {
    const prev = { local: [session([queued('server-1', { pending: true })])] };
    const next = { local: [session([queued('server-1')])] };
    const merged = mergePolledQueues(prev, next);
    expect(merged.local[0].items).toEqual([queued('server-1')]);
  });

  test('never swallows a staged unsent follow-up when an earlier server item has the same text', () => {
    const stagedFollowUp = buildStagedQueuedMessage({
      id: 'm3',
      input: { text: 'same text' },
      createdAt: 3_000,
    });
    const prev = { local: [session([stagedFollowUp])] };
    const next = { local: [session([queued('server-2', { text: 'same text', sendConfig: { providerID: '', modelID: '' } })])] };
    const merged = mergePolledQueues(prev, next);
    expect(merged.local[0].items.map((item) => item.id)).toEqual(['local-m3', 'server-2']);
  });
});

describe('merging queue mutations with staged local follow-ups', () => {
  test('keeps remaining staged and errored follow-ups after settled server rows, even with identical text', () => {
    const previous = session([
      queued('local-3', { pending: true, staged: true, text: 'bump' }),
      queued('local-4', { error: 'held', text: 'bump' }),
    ]);
    const incoming = session([queued('server-2', { text: 'bump' })]);
    const merged = mergeMutationSession(previous, incoming);
    expect(merged.items.map((item) => item.id)).toEqual(['server-2', 'local-3', 'local-4']);
  });

  test('retains staged follow-ups when an earlier follow-up was placed directly into an idle session', () => {
    const previous = session([queued('local-3', { pending: true, staged: true, text: 'next' })]);
    const incoming = session([]);
    const merged = mergeMutationSession(previous, incoming);
    expect(merged.items.map((item) => item.id)).toEqual(['local-3']);
  });
});

describe('editing a queued row', () => {
  const nothingLanded = new Map<string, string>();

  test('defers a replace that names a row still queueing', () => {
    const targets = resolveQueueReplaceTargets(
      [queued('server-1'), queued('local-1', { pending: true })],
      { itemIds: ['local-1'], survivorId: 'local-1' },
      nothingLanded
    );
    // Reported as pending: the edit is recorded now and applied once the enqueue has an id.
    expect(targets.pendingId).toBe('local-1');
    expect(targets.ids).toEqual(['local-1']);
  });

  test('a settled row and a merge go straight through', () => {
    const items = [queued('a'), queued('b')];
    expect(resolveQueueReplaceTargets(items, { itemIds: ['a'], survivorId: 'a' }, nothingLanded).pendingId)
      .toBeNull();
    const merge = resolveQueueReplaceTargets(items, { itemIds: ['a', 'b'], survivorId: 'b' }, nothingLanded);
    expect(merge.pendingId).toBeNull();
    expect(merge.ids).toEqual(['a', 'b']);
    expect(merge.survivorId).toBe('b');
  });

  test('a dialog opened on a pending row still saves once that row has landed', () => {
    const targets = resolveQueueReplaceTargets(
      [queued('server-1'), queued('server-7')],
      { itemIds: ['local-1'], survivorId: 'local-1' },
      new Map([['local-1', 'server-7']])
    );
    // The local id became a server id, and it is no longer pending: the settled replace applies.
    expect(targets.ids).toEqual(['server-7']);
    expect(targets.survivorId).toBe('server-7');
    expect(targets.pendingId).toBeNull();
  });
});
