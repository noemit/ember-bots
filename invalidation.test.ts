import { describe, expect, test } from 'bun:test';
import {
  InvalidationQueue,
  invalidationsFor,
  parseEmberEvent,
  sessionIsLoaded,
  type Invalidation,
  type InvalidationPolicy,
} from './src/lib/invalidation';

const loadedNone = () => false;
const loaded = (_instance: string, sessionId: string) => sessionId === 'open';
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('parsing a hint off the bridge', () => {
  test('carries well-formed streamed appends', () => {
    const event = parseEmberEvent({
      instanceId: 'a',
      type: 'pi:message_update',
      sessionId: 's',
      deltas: [
        { index: 0, kind: 'text', text: 'Hel' },
        { index: 1, kind: 'thinking', text: 'pondering' },
      ],
    });
    expect(event?.deltas).toEqual([
      { index: 0, kind: 'text', text: 'Hel' },
      { index: 1, kind: 'thinking', text: 'pondering' },
    ]);
  });

  test('drops a malformed frame whole rather than applying half of it', () => {
    const base = { instanceId: 'a', type: 'pi:message_update', sessionId: 's' };
    expect(parseEmberEvent({ ...base, deltas: 'nope' })?.deltas).toBeUndefined();
    expect(parseEmberEvent({ ...base, deltas: [] })?.deltas).toBeUndefined();
    // One bad entry invalidates the array: a half-applied message would disagree with the host.
    expect(
      parseEmberEvent({ ...base, deltas: [{ index: 0, kind: 'text', text: 'ok' }, { index: 1, kind: 'tool' }] })?.deltas
    ).toBeUndefined();
    expect(parseEmberEvent({ ...base, deltas: [{ index: -1, kind: 'text', text: 'x' }] })?.deltas).toBeUndefined();
    expect(parseEmberEvent({ ...base, deltas: [{ index: 0, kind: 'text', text: 'x'.repeat(9_000) }] })?.deltas).toBeUndefined();
  });
});

describe('event → invalidations', () => {
  test('a visible token update requests a bounded tail; a background one only its summary', () => {
    expect(
      invalidationsFor({ instanceId: 'a', type: 'session.text.delta', sessionId: 'open' }, loaded)
    ).toEqual([{ instanceId: 'a', resource: 'messages', sessionId: 'open', messageMode: 'tail' }]);
    expect(
      invalidationsFor({ instanceId: 'a', type: 'session.text.delta', sessionId: 'other' }, loaded)
    ).toEqual([{ instanceId: 'a', resource: 'messageSummary', sessionId: 'other' }]);
    expect(invalidationsFor({ instanceId: 'a', type: 'session.text.delta' }, loaded)).toEqual([]);
  });

  test('a pi compaction finishing re-reads the transcript in full, not just the list', () => {
    // Compaction *rewrites* history: the old prefix becomes one summary entry with a fresh id, so a
    // tail read sees the summary and keeps everything it replaced on screen. Only a full read can
    // retire the removed entries, which is why this event is not just `sessions`.
    expect(
      invalidationsFor({ instanceId: 'pi:keep', type: 'pi:compaction_end', sessionId: 'open' }, loaded)
    ).toEqual([
      { instanceId: 'pi:keep', resource: 'sessions' },
      { instanceId: 'pi:keep', resource: 'messages', sessionId: 'open', messageMode: 'full' },
    ]);
    // A column nobody is looking at only needs its compact summary re-read.
    expect(
      invalidationsFor({ instanceId: 'pi:keep', type: 'pi:compaction_end', sessionId: 'other' }, loadedNone)
    ).toEqual([
      { instanceId: 'pi:keep', resource: 'sessions' },
      { instanceId: 'pi:keep', resource: 'messageSummary', sessionId: 'other' },
    ]);
  });

  test('failed, interrupted and compacted turns request a full repair for visible sessions', () => {
    for (const type of ['session.execution.failed', 'session.execution.interrupted', 'session.error', 'session.compacted']) {
      expect(invalidationsFor({ instanceId: 'a', type, sessionId: 'open' }, loaded)).toContainEqual({
        instanceId: 'a',
        resource: 'messages',
        sessionId: 'open',
        messageMode: 'full',
      });
    }
    expect(invalidationsFor({ instanceId: 'a', type: 'session.idle', sessionId: 'open' }, loaded)).toEqual([
      { instanceId: 'a', resource: 'states' },
      { instanceId: 'a', resource: 'sessions' },
      { instanceId: 'a', resource: 'messages', sessionId: 'open', messageMode: 'full' },
    ]);
    expect(invalidationsFor({ instanceId: 'a', type: 'session.idle', sessionId: 'other' }, loadedNone)).toEqual([
      { instanceId: 'a', resource: 'states' },
      { instanceId: 'a', resource: 'sessions' },
      { instanceId: 'a', resource: 'messageSummary', sessionId: 'other' },
    ]);
  });

  test('a finished Hearth turn asks for a tail, never the whole conversation', () => {
    // The full read is the most expensive request Ember makes (a real session is a 45MB response,
    // over the 32MB cap, where it can never succeed). A tail carries the settled message and the
    // reconciler repairs itself with one full read only when the tail does not overlap.
    expect(invalidationsFor({ instanceId: 'a', type: 'pi:run_end', sessionId: 'open' }, loaded)).toEqual([
      { instanceId: 'a', resource: 'states' },
      { instanceId: 'a', resource: 'sessions' },
      { instanceId: 'a', resource: 'messages', sessionId: 'open', messageMode: 'tail' },
    ]);
    expect(invalidationsFor({ instanceId: 'a', type: 'pi:run_end', sessionId: 'background' }, loaded)).toEqual([
      { instanceId: 'a', resource: 'states' },
      { instanceId: 'a', resource: 'sessions' },
      { instanceId: 'a', resource: 'messageSummary', sessionId: 'background' },
    ]);
  });

  test('background token events never invalidate the session list', () => {
    const result = invalidationsFor(
      { instanceId: 'a', type: 'session.text.delta', sessionId: 'background' },
      loaded
    );
    expect(result.some((invalidation) => invalidation.resource === 'sessions')).toBe(false);
  });

  test('permission, form and schedule events map onto their resources', () => {
    expect(invalidationsFor({ instanceId: 'a', type: 'permission.asked', sessionId: 's' }, loadedNone)).toEqual([
      { instanceId: 'a', resource: 'permissions' },
      { instanceId: 'a', resource: 'states' },
    ]);
    expect(invalidationsFor({ instanceId: 'a', type: 'form.created', sessionId: 's' }, loadedNone)).toEqual([
      { instanceId: 'a', resource: 'questions' },
      { instanceId: 'a', resource: 'states' },
    ]);
    expect(invalidationsFor({ instanceId: 'a', type: 'openchamber:scheduled-task-ran' }, loadedNone)).toEqual([
      { instanceId: 'a', resource: 'scheduled' },
      { instanceId: 'a', resource: 'sessions' },
    ]);
    expect(invalidationsFor({ instanceId: 'a', type: 'session.diff', sessionId: 's' }, loadedNone)).toEqual([]);
    expect(invalidationsFor({ instanceId: 'a', type: 'openchamber:notification' }, loadedNone)).toEqual([]);
    expect(invalidationsFor({ instanceId: 'a', type: 'something.new' }, loadedNone)).toEqual([]);
  });
});

describe('invalidation queue', () => {
  const promptPolicy = (): InvalidationPolicy => ({ leadMs: 10, minIntervalMs: 0 });
  const throttledPolicy = (): InvalidationPolicy => ({ leadMs: 10, minIntervalMs: 60 });

  test('coalesces a burst into one refetch per key', async () => {
    const calls: Invalidation[] = [];
    const queue = new InvalidationQueue(async (invalidation) => {
      calls.push(invalidation);
    }, promptPolicy);
    for (let i = 0; i < 20; i += 1) {
      queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'tail' });
    }
    queue.push({ instanceId: 'a', resource: 'states' });
    await tick(30);
    expect(calls).toEqual([
      { instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'tail' },
      { instanceId: 'a', resource: 'states' },
    ]);
  });

  test('a hint during an in-flight refetch schedules exactly one follow-up', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const queue = new InvalidationQueue(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    }, promptPolicy);
    queue.push({ instanceId: 'a', resource: 'states' });
    await tick(20);
    expect(calls).toBe(1);
    queue.push({ instanceId: 'a', resource: 'states' });
    queue.push({ instanceId: 'a', resource: 'states' });
    release();
    await tick(30);
    expect(calls).toBe(2);
  });

  test('a pending tail is upgraded to a full repair and never downgraded', async () => {
    const calls: Invalidation[] = [];
    const queue = new InvalidationQueue(async (invalidation) => {
      calls.push(invalidation);
    }, promptPolicy);
    queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'tail' });
    queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'full' });
    queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'tail' });
    await tick(30);
    expect(calls).toEqual([
      { instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'full' },
    ]);
  });

  test('upgrading a throttled tail advances its timer', async () => {
    const calls: string[] = [];
    const queue = new InvalidationQueue(async (entry) => { calls.push(entry.messageMode ?? ''); },
      (entry) => ({ leadMs: 5, minIntervalMs: entry.messageMode === 'full' ? 0 : 300 }));
    const tail: Invalidation = { instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'tail' };
    queue.push(tail);
    await tick(20);
    queue.push(tail);
    queue.push({ ...tail, messageMode: 'full' });
    await tick(30);
    queue.clear();
    expect(calls).toEqual(['tail', 'full']);
  });

  test('continuous token hints respect the minimum interval', async () => {
    const startedAt: number[] = [];
    const queue = new InvalidationQueue(
      async () => {
        startedAt.push(Date.now());
      },
      throttledPolicy
    );
    const timer = setInterval(
      () => queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's', messageMode: 'tail' }),
      15
    );
    await tick(200);
    clearInterval(timer);
    queue.clear();
    expect(startedAt.length).toBeGreaterThanOrEqual(2);
    // Timer + Date.now() granularity can shave a millisecond off a measured gap; the point is
    // that refetches are throttled to the interval, not fired every hint.
    for (let i = 1; i < startedAt.length; i += 1) {
      expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(58);
    }
  });

  test('a failing refetch does not wedge the key', async () => {
    let calls = 0;
    const queue = new InvalidationQueue(async () => {
      calls += 1;
      throw new Error('boom');
    }, promptPolicy);
    queue.push({ instanceId: 'a', resource: 'states' });
    await tick(20);
    queue.push({ instanceId: 'a', resource: 'states' });
    await tick(20);
    expect(calls).toBe(2);
  });

  test('sessions and instances remain independently keyed', async () => {
    const calls: Invalidation[] = [];
    const queue = new InvalidationQueue(async (invalidation) => {
      calls.push(invalidation);
    }, promptPolicy);
    queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's1' });
    queue.push({ instanceId: 'a', resource: 'messages', sessionId: 's2' });
    queue.push({ instanceId: 'b', resource: 'messages', sessionId: 's1' });
    await tick(30);
    expect(calls).toHaveLength(3);
  });

  test('clear() prevents delayed work', async () => {
    let calls = 0;
    const queue = new InvalidationQueue(async () => {
      calls += 1;
    }, promptPolicy);
    queue.push({ instanceId: 'a', resource: 'states' });
    queue.clear();
    await tick(30);
    expect(calls).toBe(0);
  });
});

describe('which sessions count as loaded', () => {
  const A = { instanceId: 'pi:keep', sessionId: '1' };
  const B = { instanceId: 'pi:keep', sessionId: '2' };
  const C = { instanceId: 'pi:keep', sessionId: '3' };
  const columnOf = (ref: { instanceId: string; sessionId: string }) => `${ref.instanceId}::${ref.sessionId}`;
  const keyB = columnOf(B);

  test('a visible column is loaded', () => {
    expect(sessionIsLoaded(A, [columnOf(A)], null, false)).toBe(true);
  });

  // The regression: a sticky-minimized active session renders in the tab strip, so it is absent
  // from `columns`. Gating on columns alone hid its streaming reasoning until the turn ended.
  test('the active session is loaded even when it is only a tab', () => {
    expect(sessionIsLoaded(B, [columnOf(A)], keyB, false)).toBe(true);
  });

  test('a background tab that is neither a column nor active is not loaded', () => {
    expect(sessionIsLoaded(C, [columnOf(A)], keyB, false)).toBe(false);
  });

  test('a hidden window loads nothing, active or not', () => {
    expect(sessionIsLoaded(A, [columnOf(A)], columnOf(A), true)).toBe(false);
  });

  test('the gate decides a live tail versus a summary-only refresh', () => {
    const event = { instanceId: 'pi:keep', type: 'pi:message_update', sessionId: '2' };
    const loadedFor = (instanceId: string, sessionId: string) =>
      sessionIsLoaded({ instanceId, sessionId }, [columnOf(A)], keyB, false);
    expect(invalidationsFor(event, loadedFor)).toEqual([
      { instanceId: 'pi:keep', resource: 'messages', sessionId: '2', messageMode: 'tail' },
    ]);
    expect(invalidationsFor({ ...event, sessionId: '3' }, loadedFor)).toEqual([
      { instanceId: 'pi:keep', resource: 'messageSummary', sessionId: '3' },
    ]);
  });
});
