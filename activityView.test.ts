import { describe, expect, test } from 'bun:test';
import {
  ACTIVITY_MEMORY_LIMIT,
  activityDayGroups,
  entryFromEmberEvent,
  entryLine,
  mergeActivity,
  nowStripCards,
  resolveActivityTarget,
  sessionIndex,
} from './src/lib/activityView';
import type { ActivityEntry, EmberEvent, Session } from './src/types';

const NOW = Date.UTC(2026, 9, 4, 15, 0, 0); // a fixed "today" at 3pm

const entry = (id: string, at: number, overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  at,
  instanceId: 'local',
  sessionId: 'ses_1',
  type: 'session.idle',
  summary: 'went idle',
  ...overrides,
});

const tool = (id: string, at: number, sessionId = 'ses_1'): ActivityEntry =>
  entry(id, at, { sessionId, type: 'session.tool.success', summary: 'ran bash', detail: { command: 'bun run check' } });

describe('live entries', () => {
  test('only hints with a summary and id become entries, with bounded fields', () => {
    expect(entryFromEmberEvent({ instanceId: 'local', type: 'session.text.delta', sessionId: 's' })).toBeNull();
    expect(entryFromEmberEvent({ instanceId: 'local', type: 'session.idle', summary: 'went idle' })).toBeNull();
    expect(entryFromEmberEvent({ instanceId: 'local', type: 'session.idle', summary: 'went idle', id: 'e1' })?.at)
      .toBeGreaterThan(0);
    const event: EmberEvent = {
      instanceId: 'local',
      type: 'session.tool.success',
      sessionId: 'ses_1',
      id: 'e2',
      at: NOW,
      summary: 'ran bash',
      detail: { command: 'bun run check', note: 'x'.repeat(500) },
    };
    const parsed = entryFromEmberEvent(event)!;
    expect(parsed).toEqual({
      id: 'e2',
      at: NOW,
      instanceId: 'local',
      directory: undefined,
      sessionId: 'ses_1',
      type: 'session.tool.success',
      summary: 'ran bash',
      detail: { command: 'bun run check' },
    });
  });

  test('merging de-dupes by id (incoming wins), sorts newest-first and bounds the list', () => {
    const merged = mergeActivity(
      [entry('a', 100), entry('b', 300), entry('c', 200)],
      [entry('b', 300, { summary: 'finished a turn' }), entry('d', 400)]
    );
    expect(merged.map((item) => item.id)).toEqual(['d', 'b', 'c', 'a']);
    expect(merged.find((item) => item.id === 'b')?.summary).toBe('finished a turn');
    const many = Array.from({ length: ACTIVITY_MEMORY_LIMIT + 50 }, (_, index) => entry(`e${index}`, index));
    expect(mergeActivity([], many)).toHaveLength(ACTIVITY_MEMORY_LIMIT);
    expect(mergeActivity([], many)[0].id).toBe(`e${ACTIVITY_MEMORY_LIMIT + 49}`);
  });
});

describe('timeline grouping', () => {
  test('groups by local day with friendly labels, newest day first', () => {
    const groups = activityDayGroups(
      [entry('t1', NOW), entry('y1', NOW - 86_400_000), entry('y2', NOW - 86_400_000 - 3_600_000), entry('o1', NOW - 5 * 86_400_000)],
      NOW
    );
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', expect.stringContaining(' ')]);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[1].rows.map((row) => (row.kind === 'entry' ? row.entry.id : 'block'))).toEqual(['y1', 'y2']);
  });

  test('runs of three or more tool successes from one session collapse; shorter runs do not', () => {
    const base = NOW - 60_000;
    const rows = activityDayGroups(
      [
        tool('w1', base - 1000),
        tool('w2', base - 2000),
        tool('w3', base - 3000),
        tool('w4', base - 4000),
        entry('mid', base - 5000, { type: 'session.execution.succeeded', summary: 'finished a turn' }),
        tool('x1', base - 6000),
        tool('x2', base - 7000),
      ],
      NOW
    )[0].rows;
    expect(rows).toHaveLength(4);
    expect(rows[0].kind).toBe('block');
    if (rows[0].kind === 'block') {
      expect(rows[0].count).toBe(4);
      expect(rows[0].to).toBe(base - 1000);
      expect(rows[0].from).toBe(base - 4000);
    }
    expect(rows[1].kind === 'entry' && rows[1].entry.summary).toBe('finished a turn');
    // A two-call run stays as individual rows.
    expect(rows[2].kind === 'entry' && rows[2].entry.id).toBe('x1');
    expect(rows[3].kind === 'entry' && rows[3].entry.id).toBe('x2');
  });

  test('a different session or a failure breaks the run; failures never collapse', () => {
    const base = NOW - 60_000;
    const rows = activityDayGroups(
      [
        tool('a1', base - 1000),
        tool('a2', base - 2000),
        tool('b1', base - 3000, 'ses_2'),
        entry('fail', base - 4000, { type: 'session.tool.failed', summary: 'bash failed' }),
        entry('ask', base - 5000, { type: 'permission.asked', summary: 'waiting for permission' }),
      ],
      NOW
    )[0].rows;
    expect(rows.map((row) => row.kind === 'block' ? `block:${row.count}` : `entry:${row.entry.id}`))
      .toEqual(['entry:a1', 'entry:a2', 'entry:b1', 'entry:fail', 'entry:ask']);
  });
});

describe('session links', () => {
  const sessions = [
    { id: 'ses_1', instanceId: 'local', title: 'Active', updated: NOW },
    { id: 'ses_2', instanceId: 'local', title: 'Archived', archived: 123 },
    { id: 'ses_3', instanceId: 'studio', title: 'Elsewhere', updated: NOW },
  ];
  const index = sessionIndex(sessions);

  test('resolvable unless archived or gone; instance-scoped', () => {
    expect(resolveActivityTarget(entry('a', NOW, { sessionId: 'ses_1' }), index)?.title).toBe('Active');
    expect(resolveActivityTarget(entry('b', NOW, { sessionId: 'ses_2' }), index)).toBeNull();
    expect(resolveActivityTarget(entry('c', NOW, { sessionId: 'nope' }), index)).toBeNull();
    expect(resolveActivityTarget(entry('d', NOW, { sessionId: 'ses_3', instanceId: 'local' }), index)).toBeNull();
    expect(resolveActivityTarget(entry('e', NOW, { sessionId: undefined }), index)).toBeNull();
  });

  test('the entry line prefers the most telling detail', () => {
    expect(entryLine(entry('a', NOW, { summary: 'finished a turn' }))).toBe('finished a turn');
    expect(entryLine(entry('b', NOW, { summary: 'bash failed', detail: { command: 'vercel ls', error: 'exit 1' } })))
      .toBe('bash failed · exit 1');
    expect(entryLine(entry('c', NOW, { summary: 'ran bash', detail: { command: 'bun run check' } })))
      .toBe('ran bash · bun run check');
  });
});

describe('now strip', () => {
  const session = (id: string, overrides: Partial<Session> = {}): Session =>
    ({ id, instanceId: 'local', title: id, updated: NOW - Number(id.slice(1)), ...overrides });

  test('prompts before failures before work, newest first within a tone', () => {
    const cards = nowStripCards([session('s1'), session('s2'), session('s3'), session('s4'), session('s5')], {
      'local::s1': 'busy',
      'local::s2': 'input',
      'local::s3': 'error',
      'local::s4': 'question',
      'local::s5': 'unread',
    });
    expect(cards.map((card) => card.key)).toEqual(['local::s2', 'local::s4', 'local::s3', 'local::s1']);
    expect(cards[0].label).toBe('waiting for approval');
    expect(cards[1].label).toBe('asked a question');
    expect(cards[2].label).toBe('failed');
    expect(cards[3].label).toBe('working');
  });

  test('archived sessions never need attention', () => {
    const archived: Session = { id: 's9', instanceId: 'local', title: 'gone', archived: 5, updated: NOW };
    expect(nowStripCards([archived], { 'local::s9': 'input' })).toHaveLength(0);
  });
});
