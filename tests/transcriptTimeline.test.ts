import { describe, expect, test } from 'bun:test';
import {
  MAX_TIMELINE_TICKS,
  MIN_TIMELINE_TICKS,
  shouldShowTimeline,
  timelineTicks,
} from '../src/lib/transcriptTimeline';
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
