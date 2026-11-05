import { describe, expect, test } from 'bun:test';
import {
  mergeAll,
  mergeAllPlan,
  mergeTexts,
  mergeUpPlan,
  planQueueMerge,
  queuedItemMode,
  queuedModeLabel,
  queueOrderAfterMerge,
} from './src/lib/queueMerge';
import type { QueuedMessage } from './src/types';

const queued = (id: string, text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  createdAt: 0,
  content: text,
  text,
  attachments: [],
  context: [],
  sendConfig: { providerID: `p-${id}`, modelID: `m-${id}` },
  ...extra,
});

describe('mergeTexts', () => {
  test('joins two messages with a blank line', () => {
    expect(mergeTexts('first', 'second')).toBe('first\n\nsecond');
  });

  test('trims each side and drops an empty one', () => {
    expect(mergeTexts('  first\n', '\nsecond  ')).toBe('first\n\nsecond');
    expect(mergeTexts('', 'second')).toBe('second');
    expect(mergeTexts('first', '   ')).toBe('first');
    expect(mergeTexts('', '')).toBe('');
  });
});

describe('mergeAll', () => {
  test('combines in queue order, one paragraph each', () => {
    const items = [queued('a', 'one'), queued('b', 'two'), queued('c', 'three')];
    expect(mergeAll(items)).toBe('one\n\ntwo\n\nthree');
  });

  test('falls back to content when text is empty', () => {
    const items = [queued('a', 'one'), queued('b', '', { content: 'from content' })];
    expect(mergeAll(items)).toBe('one\n\nfrom content');
  });
});

describe('planQueueMerge', () => {
  const items = [
    queued('a', 'alpha', { sendConfig: { providerID: 'p', modelID: 'upper', agent: 'build', variant: 'high' } }),
    queued('b', 'beta', { sendConfig: { providerID: 'p', modelID: 'lower', variant: 'low' } }),
    queued('c', 'gamma', { sendConfig: { providerID: 'p', modelID: 'last' } }),
  ];

  test('takes the merged text and send config from the upper item', () => {
    const plan = planQueueMerge(items, ['a', 'b'], 'b');
    expect(plan).not.toBeNull();
    expect(plan!.text).toBe('alpha\n\nbeta');
    expect(plan!.leader.id).toBe('a');
    expect(plan!.leader.sendConfig).toEqual({
      providerID: 'p',
      modelID: 'upper',
      agent: 'build',
      variant: 'high',
    });
    expect(plan!.ids).toEqual(['a', 'b']);
    expect(plan!.survivorId).toBe('b');
  });

  test('orders ids by the queue, not by the order they were passed', () => {
    const plan = planQueueMerge(items, ['c', 'a'], 'b');
    expect(plan!.ids).toEqual(['a', 'c']);
    expect(plan!.text).toBe('alpha\n\ngamma');
    // A survivor that is not part of the merge falls back to the upper item.
    expect(plan!.survivorId).toBe('a');
  });

  test('a single id is the edit case: same text and same send config', () => {
    const plan = planQueueMerge(items, ['b'], 'b');
    expect(plan!.text).toBe('beta');
    expect(plan!.ids).toEqual(['b']);
    expect(plan!.leader.sendConfig.modelID).toBe('lower');
    expect(plan!.survivorId).toBe('b');
  });

  test('rejects unknown, duplicated or empty id sets', () => {
    expect(planQueueMerge(items, ['a', 'nope'])).toBeNull();
    expect(planQueueMerge(items, ['a', 'a'])).toBeNull();
    expect(planQueueMerge(items, [])).toBeNull();
  });

  test('carries attachments that still have a payload and every context', () => {
    const withFiles = [
      queued('a', 'alpha', {
        attachments: [{ filename: 'one.png', mimeType: 'image/png', dataUrl: 'data:one' }],
        context: [{ kind: 'synthetic', text: 'ctx-a' }],
      }),
      queued('b', 'beta', {
        attachments: [
          { filename: 'gone.png', mimeType: 'image/png' },
          { filename: 'two.png', mimeType: 'image/png', dataUrl: 'data:two' },
        ],
        context: [{ kind: 'synthetic', text: 'ctx-b' }],
      }),
    ];
    const plan = planQueueMerge(withFiles, ['a', 'b'], 'b')!;
    expect(plan.attachments).toEqual([
      { filename: 'one.png', mime: 'image/png', url: 'data:one' },
      { filename: 'two.png', mime: 'image/png', url: 'data:two' },
    ]);
    expect(plan.queuedContext.map((entry) => entry.text)).toEqual(['ctx-a', 'ctx-b']);
  });
});

describe('mergeUpPlan', () => {
  const items = [queued('a', 'alpha'), queued('b', 'beta'), queued('c', 'gamma')];

  test('merges a row into the one above it and keeps the lower row position', () => {
    const plan = mergeUpPlan(items, 1)!;
    expect(plan.text).toBe('alpha\n\nbeta');
    expect(plan.leader.id).toBe('a');
    expect(plan.ids).toEqual(['a', 'b']);
    expect(plan.survivorId).toBe('b');
  });

  test('has nothing to merge for the first row or an out-of-range index', () => {
    expect(mergeUpPlan(items, 0)).toBeNull();
    expect(mergeUpPlan(items, 3)).toBeNull();
    expect(mergeUpPlan([queued('a', 'only')], 1)).toBeNull();
  });
});

describe('mergeAllPlan', () => {
  test('takes the first item as the leader and every id in queue order', () => {
    const items = [
      queued('a', 'alpha', { sendConfig: { providerID: 'p', modelID: 'first', variant: 'low' } }),
      queued('b', 'beta'),
      queued('c', 'gamma'),
    ];
    const plan = mergeAllPlan(items)!;
    expect(plan.text).toBe('alpha\n\nbeta\n\ngamma');
    expect(plan.leader.id).toBe('a');
    expect(plan.leader.sendConfig.modelID).toBe('first');
    expect(plan.leader.sendConfig.variant).toBe('low');
    expect(plan.ids).toEqual(['a', 'b', 'c']);
    expect(plan.survivorId).toBe('a');
  });

  test('needs at least two rows', () => {
    expect(mergeAllPlan([queued('a', 'only')])).toBeNull();
    expect(mergeAllPlan([])).toBeNull();
  });
});

describe('queueOrderAfterMerge', () => {
  const items = [queued('a', 'alpha'), queued('b', 'beta'), queued('c', 'gamma'), queued('d', 'delta')];

  test('puts the replacement where the survivor sat and drops the consumed rows', () => {
    const plan = mergeUpPlan(items, 2)!; // b + c, survivor c
    expect(queueOrderAfterMerge(items, plan, 'new')).toEqual(['a', 'new', 'd']);
  });

  test('a merge-all leaves a single row at the first position', () => {
    const plan = mergeAllPlan(items)!;
    expect(queueOrderAfterMerge(items, plan, 'new')).toEqual(['new']);
  });

  test('an edit keeps its own position', () => {
    const plan = planQueueMerge(items, ['c'], 'c')!;
    expect(queueOrderAfterMerge(items, plan, 'new')).toEqual(['a', 'b', 'new', 'd']);
  });
});

describe('queuedItemMode', () => {
  test('a queued row without a reported mode is a follow-up', () => {
    expect(queuedItemMode(queued('a', 'alpha'))).toBe('follow-up');
    expect(queuedModeLabel(queued('a', 'alpha'))).toBe('follow-up');
  });

  test('a reported steer says it sends immediately', () => {
    expect(queuedItemMode(queued('a', 'alpha', { mode: 'steer' }))).toBe('steer');
    expect(queuedModeLabel(queued('a', 'alpha', { mode: 'steer' }))).toBe('steer, sends immediately');
  });
});
