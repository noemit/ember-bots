import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import {
  buildAdoptedQueuedMessage,
  buildStagedQueuedMessage,
  mergeMutationSession,
  mergePolledQueues,
  resolveQueueReplaceTargets,
  useMessageQueue,
  type QueueTarget,
} from '../src/hooks/useMessageQueue';
import type { MessageQueueSession, ModelOption, QueuedMessage, Session } from '../src/types';
import { withTestRoot } from './fixtures/reactRoot';

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
  test('keeps local pending and failed rows across a poll without console spam', () => {
    const logged: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
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
      expect(logged).toEqual([]);
    } finally {
      console.log = originalLog;
    }
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

describe('adoptQueuedSubmission and concurrency-safe rollbacks', () => {
  const model: ModelOption = {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4',
    label: 'Claude Sonnet 4',
    details: {
      name: 'Claude Sonnet 4',
      providerName: 'Anthropic',
      reasoning: true,
      toolcall: true,
      attachment: true,
      inputs: ['text', 'image'],
      variants: ['high'],
    },
  };

  test('adoptQueuedSubmission preserves caller attachments and marks the row pending: false', async () => {
    const built = buildAdoptedQueuedMessage(
      {
        id: 'sub-99',
        text: 'Check this screenshot',
        model,
        variant: 'high',
        mode: 'build',
        attachments: [{ filename: 'screen.png', mime: 'image/png', url: 'data:image/png;base64,AAA' }],
      },
      1234
    );
    expect(built).toEqual({
      id: 'sub-99',
      createdAt: 1234,
      text: 'Check this screenshot',
      content: 'Check this screenshot',
      attachments: [
        {
          filename: 'screen.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AAA',
        },
      ],
      context: [],
      sendConfig: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        agent: 'build',
        variant: 'high',
      },
      pending: false,
    });

    await withTestRoot(async ({ render, act }) => {
      let queues: Record<string, MessageQueueSession[]> = {};
      let api!: ReturnType<typeof useMessageQueue>;
      function Harness() {
        const [state, setState] = React.useState<Record<string, MessageQueueSession[]>>({});
        queues = state;
        api = useMessageQueue({
          modelsByInstance: {},
          setQueuesByInstance: setState,
          showActionError: () => {},
        });
        return null;
      }
      await render(React.createElement(Harness));
      await act(() => {
        api.adoptQueuedSubmission({ instanceId: 'local', sessionId: 's' }, '/d', {
          id: 'sub-42',
          text: 'Queued with image',
          model,
          attachments: [{ filename: 'shot.png', mime: 'image/png', url: 'data:shot' }],
        });
      });
      expect(queues.local).toHaveLength(1);
      expect(queues.local[0].items[0].pending).toBe(false);
      expect(queues.local[0].items[0].attachments).toEqual([
        { filename: 'shot.png', mimeType: 'image/png', dataUrl: 'data:shot' },
      ]);
    });
  });

  test('removeQueued rolls back functionally on 500 without wiping concurrently enqueued items, and refreshes instead of resurrecting on 409', async () => {
    await withTestRoot(async ({ render, act, window: win }) => {
      let pendingResolve: ((res: { ok: boolean; status: number; data: unknown }) => void) | null = null;
      win.ember = {
        request: () =>
          new Promise<{ ok: boolean; status: number; data: unknown }>((resolve) => {
            pendingResolve = resolve;
          }),
      };

      const refreshed: string[][] = [];
      const errors: Array<{ message: string | null; hasRetry: boolean }> = [];
      let queues: Record<string, MessageQueueSession[]> = {};
      let api!: ReturnType<typeof useMessageQueue>;

      function Harness() {
        const [state, setState] = React.useState<Record<string, MessageQueueSession[]>>({
          local: [session([queued('a'), queued('b')])],
        });
        queues = state;
        api = useMessageQueue({
          modelsByInstance: {},
          setQueuesByInstance: setState,
          showActionError: (message, retry) => {
            errors.push({ message, hasRetry: Boolean(retry) });
          },
          refreshQueues: (ids) => {
            refreshed.push(ids);
          },
        });
        return null;
      }

      await render(React.createElement(Harness));
      const initialTarget: QueueTarget = {
        ref: { instanceId: 'local', sessionId: 's' },
        session: { id: 's', instanceId: 'local', title: 'S', directory: '/d', updated: 1 } as Session,
        queue: queues.local[0],
        send: async () => true,
      };

      // 1. Non-409 failure: restore 'a' functionally without wiping concurrently added 'c'.
      let removePromise!: Promise<boolean>;
      await act(() => {
        removePromise = api.removeQueued('a', initialTarget);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b']);

      await act(() => {
        api.adoptQueuedSubmission({ instanceId: 'local', sessionId: 's' }, '/d', {
          id: 'c',
          text: 'concurrent c',
        });
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'c']);

      await act(async () => {
        pendingResolve!({ ok: false, status: 500, data: null });
        expect(await removePromise).toBe(false);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
      expect(refreshed).toEqual([]);
      expect(errors.at(-1)).toEqual({
        message: 'Could not cancel the queued message.',
        hasRetry: true,
      });

      // 2. HTTP 409 conflict: 'a' already entered the transcript — do not resurrect it, keep concurrent 'd', and refreshQueues.
      const secondTarget: QueueTarget = {
        ...initialTarget,
        queue: queues.local[0],
      };
      await act(() => {
        removePromise = api.removeQueued('a', secondTarget);
      });
      await act(() => {
        api.adoptQueuedSubmission({ instanceId: 'local', sessionId: 's' }, '/d', {
          id: 'd',
          text: 'concurrent d',
        });
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'c', 'd']);

      await act(async () => {
        pendingResolve!({ ok: false, status: 409, data: null });
        expect(await removePromise).toBe(false);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'c', 'd']);
      expect(refreshed).toEqual([['local']]);
      expect(errors.at(-1)).toEqual({
        message: 'That queued message is already being sent.',
        hasRetry: false,
      });
    });
  });

  test('moveQueued rolls back functionally on 500 without wiping concurrent items, and refreshes instead of resurrecting on 409', async () => {
    await withTestRoot(async ({ render, act, window: win }) => {
      let pendingResolve: ((res: { ok: boolean; status: number; data: unknown }) => void) | null = null;
      win.ember = {
        request: () =>
          new Promise<{ ok: boolean; status: number; data: unknown }>((resolve) => {
            pendingResolve = resolve;
          }),
      };

      const refreshed: string[][] = [];
      const errors: Array<{ message: string | null; hasRetry: boolean }> = [];
      let queues: Record<string, MessageQueueSession[]> = {};
      let setQueueState!: React.Dispatch<React.SetStateAction<Record<string, MessageQueueSession[]>>>;
      let api!: ReturnType<typeof useMessageQueue>;

      function Harness() {
        const [state, setState] = React.useState<Record<string, MessageQueueSession[]>>({
          local: [session([queued('a'), queued('b')])],
        });
        queues = state;
        setQueueState = setState;
        api = useMessageQueue({
          modelsByInstance: {},
          setQueuesByInstance: setState,
          showActionError: (message, retry) => {
            errors.push({ message, hasRetry: Boolean(retry) });
          },
          refreshQueues: (ids) => {
            refreshed.push(ids);
          },
        });
        return null;
      }

      await render(React.createElement(Harness));
      const target: QueueTarget = {
        ref: { instanceId: 'local', sessionId: 's' },
        session: { id: 's', instanceId: 'local', title: 'S', directory: '/d', updated: 1 } as Session,
        queue: queues.local[0],
        send: async () => true,
      };

      // 1. Non-409 failure: swap back functionally while keeping concurrently added 'c'.
      let movePromise!: Promise<boolean>;
      await act(() => {
        movePromise = api.moveQueued('b', -1, target);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'a']);

      await act(() => {
        api.adoptQueuedSubmission({ instanceId: 'local', sessionId: 's' }, '/d', {
          id: 'c',
          text: 'concurrent c',
        });
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'a', 'c']);

      await act(async () => {
        pendingResolve!({ ok: false, status: 500, data: null });
        expect(await movePromise).toBe(false);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
      expect(refreshed).toEqual([]);
      expect(errors.at(-1)).toEqual({
        message: 'Could not reorder the queued messages.',
        hasRetry: true,
      });

      // 2. HTTP 409 conflict: 'a' already entered the transcript during reorder — never resurrect 'a', preserve 'd', and refreshQueues.
      const nextTarget: QueueTarget = {
        ...target,
        queue: queues.local[0],
      };
      await act(() => {
        movePromise = api.moveQueued('b', -1, nextTarget);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'a', 'c']);

      // Simulate a poll where 'a' already left the queue into the transcript and 'd' arrived.
      await act(() => {
        setQueueState({ local: [session([queued('b'), queued('c'), queued('d')])] });
      });

      await act(async () => {
        pendingResolve!({ ok: false, status: 409, data: null });
        expect(await movePromise).toBe(false);
      });
      expect(queues.local[0].items.map((i) => i.id)).toEqual(['b', 'c', 'd']);
      expect(refreshed).toEqual([['local']]);
      expect(errors.at(-1)).toEqual({
        message: 'That queued message is already being sent.',
        hasRetry: false,
      });
    });
  });
});
