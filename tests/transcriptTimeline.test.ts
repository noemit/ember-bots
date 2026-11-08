import { describe, expect, test } from 'bun:test';
import {
  MAX_TIMELINE_TICKS,
  MIN_TIMELINE_TICKS,
  shouldShowTimeline,
  timelineTicks,
  timelineTicksForItems,
} from '../src/lib/transcriptTimeline';
import { bundleConsecutiveToolMessages } from '../src/lib/toolDisplay';
import { isUnreadEligible } from '../src/lib/unreadDigest';
import type { ChatMessage } from '../src/types';

const tool = (name: string, status: 'completed' | 'error' | 'running' = 'completed') =>
  ({ type: 'tool' as const, id: `t-${name}`, call: { id: `c-${name}`, tool: name, status } });

const assistant = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `a-${Math.random()}`,
  role: 'assistant',
  text: 'ok',
  parts: [{ type: 'text', id: 'x', text: 'ok' }],
  completed: true,
  ...overrides,
});

const user = (): ChatMessage => ({
  id: `u-${Math.random()}`,
  role: 'user',
  text: 'do it',
  parts: [{ type: 'text', id: 'y', text: 'do it' }],
  completed: true,
});

describe('timelineTicks', () => {
  test('marks assistant turns only, in transcript order, with their item index', () => {
    const items = [user(), assistant(), user(), assistant({ parts: [tool('bash')] })];
    const ticks = timelineTicks(items);
    expect(ticks.map((t) => t.index)).toEqual([1, 3]);
    expect(ticks.map((t) => t.kind)).toEqual(['turn', 'tool']);
    expect(ticks[1].tools).toEqual(['bash']);
  });

  test('a failed turn or failed tool is a failure mark', () => {
    expect(timelineTicks([assistant({ error: 'boom' })])[0].kind).toBe('failure');
    expect(timelineTicks([assistant({ parts: [tool('bash', 'error')] })])[0].kind).toBe('failure');
  });

  test('an unfinished turn is marked live', () => {
    expect(timelineTicks([assistant({ completed: false })])[0].kind).toBe('live');
  });

  test('summaries name the tool or the failure, and include the time when known', () => {
    const at = new Date(2026, 9, 18, 18, 41).getTime();
    const [failed] = timelineTicks([assistant({ parts: [tool('bash', 'error')], createdAt: at })]);
    expect(failed.summary).toContain('bash failed');
    // Locale-dependent clock format, so build the expectation with the same formatter.
    const clock = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(failed.summary).toContain(clock);
    expect(timelineTicks([assistant({ parts: [tool('read'), tool('edit')] })])[0].summary).toBe('read, edit');
  });

  test('long transcripts are sampled but never lose a failure', () => {
    const items: ChatMessage[] = [];
    for (let i = 0; i < 600; i++) {
      items.push(user());
      items.push(
        i === 402
          ? assistant({ error: 'boom' })
          : assistant({ parts: [tool(`tool-${i}`)] })
      );
    }
    const ticks = timelineTicks(items);
    expect(ticks.length).toBeLessThanOrEqual(MAX_TIMELINE_TICKS + 2);
    expect(ticks.some((tick) => tick.kind === 'failure')).toBe(true);
    expect(ticks.every((tick) => tick.index % 2 === 1)).toBe(true);
  });

  test('the rail only appears once there are enough marks', () => {
    const few = Array.from({ length: MIN_TIMELINE_TICKS - 1 }, () => assistant());
    expect(shouldShowTimeline(timelineTicks(few))).toBe(false);
    const enough = Array.from({ length: MIN_TIMELINE_TICKS }, () => assistant());
    expect(shouldShowTimeline(timelineTicks(enough))).toBe(true);
    expect(timelineTicks([])).toEqual([]);
  });
});


describe('merged tool timeline', () => {
  const bundle = (messages: ChatMessage[]) => bundleConsecutiveToolMessages(
    messages.map((message, index) => ({ message, index })),
    { toolDisplay: 'collapsed', hideToolCalls: false },
  );
  const steps = (completed = false): ChatMessage[] => [
    assistant({ id: 'e1', text: '', parts: [tool('read')] }),
    assistant({ id: 'e2', text: '', completed, live: !completed,
      parts: [tool('bash', completed ? 'completed' : 'running')] }),
  ];

  test('a settled anchor retains its identity and read eligibility while its live source marks the row live', () => {
    const messages = steps();
    const items = bundle(messages);
    const before = structuredClone({ messages, items });
    expect(items).toHaveLength(1);
    expect(items[0].sourceIndices).toEqual([0, 1]);
    expect(timelineTicksForItems(items, messages)[0]).toMatchObject({ index: 0, kind: 'live', summary: 'running now' });
    expect(items[0].message.id).toBe('e1');
    expect(items[0].message.completed).toBe(true);
    expect(isUnreadEligible(items[0].message)).toBe(isUnreadEligible(messages[0]));
    expect({ messages, items }).toEqual(before);
  });

  test('the live marker settles when its source completes, and unmerged rows retain the existing API behavior', () => {
    const messages = steps();
    const items = bundle(messages);
    expect(timelineTicksForItems(items, messages)[0].kind).toBe('live');
    const settled = steps(true);
    // Even an unchanged anchor must consult the current source records.
    expect(timelineTicksForItems(items, settled)[0].kind).toBe('tool');
    expect(timelineTicksForItems(bundle(settled), settled)[0].kind).toBe('tool');
    const ordinary = [user(), assistant(), assistant({ completed: false })];
    expect(timelineTicksForItems(ordinary.map((message, index) => ({ message, index })), ordinary)).toEqual(timelineTicks(ordinary));
  });

  test('a failed tool retains failure precedence over a later live source', () => {
    const messages = steps();
    messages[0] = assistant({ text: '', parts: [tool('read', 'error')] });
    expect(timelineTicksForItems(bundle(messages), messages)[0].kind).toBe('failure');
  });

  test('sampling keeps a merged live row off the ordinary sampling stride', () => {
    const messages = Array.from({ length: 599 }, () => assistant());
    messages.push(...steps());
    const items = bundle(messages);
    const ticks = timelineTicksForItems(items, messages);
    expect(items).toHaveLength(600);
    expect(599 % Math.ceil(items.length / MAX_TIMELINE_TICKS)).not.toBe(0);
    expect(ticks.find(tick => tick.index === 599)?.kind).toBe('live');
    expect(ticks.length).toBeLessThanOrEqual(MAX_TIMELINE_TICKS + 1);
  });
});
