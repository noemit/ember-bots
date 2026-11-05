import { describe, expect, test } from 'bun:test';
import { digestUnread, excerptText, orderUnreadCards, promptItems, UNREAD_EXCERPT_LIMIT } from './src/lib/unreadDigest';
import type { ChatMessage, PermissionRequest, QuestionRequest } from './src/types';

const assistant = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  parts: [{ type: 'text', id: `${id}-0`, text }],
  createdAt: Number(id.replace(/\D/g, '')) * 1000 || 1000,
  completed: true,
  ...extra,
});

describe('excerptText', () => {
  test('short text is untouched and not marked truncated', () => {
    expect(excerptText('Fixed the double submit.')).toEqual({
      excerpt: 'Fixed the double submit.',
      truncated: false,
    });
  });

  test('long text is cut on a word and ends in an ellipsis', () => {
    const { excerpt, truncated } = excerptText('alpha '.repeat(200));
    expect(truncated).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(UNREAD_EXCERPT_LIMIT + 1);
    // Cut on a boundary, never mid-word.
    expect(excerpt.slice(0, -1).trimEnd().endsWith('alpha')).toBe(true);
  });

  test('markdown is stripped so the card reads as prose', () => {
    expect(excerptText('**Done** — `bun test` passes.').excerpt).toBe('Done — bun test passes.');
  });

  test('one unbroken token still yields text rather than an empty excerpt', () => {
    const { excerpt } = excerptText('x'.repeat(UNREAD_EXCERPT_LIMIT * 2));
    expect(excerpt.length).toBeGreaterThan(UNREAD_EXCERPT_LIMIT / 2);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('digestUnread', () => {
  const messages = [
    assistant('e1', 'first'),
    assistant('e2', 'second'),
    assistant('e3', 'third'),
    // A user turn is never unread: the user wrote it.
    { ...assistant('e4', 'mine'), role: 'user' as const, createdAt: 4000 },
    // A tool-only step has nothing to read.
    {
      ...assistant('e5', '', { createdAt: 5000 }),
      parts: [{ type: 'tool' as const, id: 'e5-0', call: { id: 'c1', tool: 'bash', status: 'completed' as const } }],
      text: '',
    },
    // Still running: half a sentence must not appear on Home and then rewrite itself.
    assistant('e6', 'streaming', { completed: false, createdAt: 6000 }),
    // A stop is the user's own action.
    assistant('e7', 'stopped', { aborted: true, createdAt: 7000 }),
    // A failure is news even with no prose.
    assistant('e8', '', { error: 'provider timeout', createdAt: 8000 }),
  ];

  test('without a mark, every finished assistant turn is unread, oldest first', () => {
    const digest = digestUnread(messages, { mark: undefined, complete: true, version: 8 });
    expect(digest.items.map((item) => item.id)).toEqual(['e1', 'e2', 'e3', 'e8']);
    expect(digest.items.at(-1)?.kind).toBe('failure');
    expect(digest.items.at(-1)?.excerpt).toBe('provider timeout');
  });

  test('messages at or below the mark drop out', () => {
    const digest = digestUnread(messages, { mark: { through: 2 }, complete: true, version: 8 });
    expect(digest.items.map((item) => item.id)).toEqual(['e3', 'e8']);
  });

  test('an out-of-order mark removes exactly one message', () => {
    const digest = digestUnread(messages, { mark: { through: 1, ids: [3] }, complete: true, version: 8 });
    expect(digest.items.map((item) => item.id)).toEqual(['e2', 'e8']);
  });

  test('a message with a pending ask is a question, not a status word', () => {
    const asking: ChatMessage = {
      ...assistant('e9', 'Which address copy?'),
      parts: [
        { type: 'text', id: 'e9-0', text: 'Which address copy?' },
        { type: 'tool', id: 'e9-1', call: { id: 'c9', tool: 'ask', status: 'pending' } },
      ],
    };
    const digest = digestUnread([asking], { mark: undefined, complete: true, version: 9 });
    expect(digest.items[0].kind).toBe('question');
    expect(digest.items[0].tags).toContain('Asking');
  });

  test('tool steps are counted as tag facts', () => {
    const busy: ChatMessage = {
      ...assistant('e10', 'Ran the suite.'),
      parts: [
        { type: 'text', id: 'e10-0', text: 'Ran the suite.' },
        { type: 'tool', id: 'e10-1', call: { id: 'c1', tool: 'bash', status: 'completed' } },
        { type: 'tool', id: 'e10-2', call: { id: 'c2', tool: 'write', status: 'completed' } },
      ],
    };
    expect(digestUnread([busy], { mark: undefined, complete: true, version: 10 }).items[0].tags).toEqual(['2 steps']);
  });

  test('an incomplete read says so instead of guessing', () => {
    const digest = digestUnread([assistant('e1', 'only one')], { mark: undefined, complete: false, version: 1 });
    expect(digest.complete).toBe(false);
  });
});

describe('promptItems', () => {
  const permission: PermissionRequest = {
    id: 'perm-1',
    instanceId: 'local',
    sessionId: '1',
    permission: 'bash',
    patterns: ['bun run test:e2e'],
    metadata: {},
  };
  const question: QuestionRequest = {
    id: 'q-1',
    instanceId: 'local',
    sessionId: '1',
    questions: [{ header: 'Copy', question: 'Which wording?', options: [] }],
  };

  test('a pending approval is sticky and asks for a decision, never "read"', () => {
    const [item] = promptItems([permission], [], 7);
    expect(item.sticky).toBe(true);
    expect(item.kind).toBe('permission');
    expect(item.excerpt).toContain('bun run test:e2e');
    expect(item.at).toBe(7);
  });

  test('a pending question carries the question itself', () => {
    const [item] = promptItems([], [question], 7);
    expect(item.kind).toBe('question');
    expect(item.excerpt).toBe('Which wording?');
  });
});

describe('orderUnreadCards', () => {
  test('most unread first, then most recent', () => {
    const ordered = orderUnreadCards([
      { id: 'a', count: 2, updated: 900 },
      { id: 'b', count: 5, updated: 100 },
      { id: 'c', count: 2, updated: 950 },
    ]);
    expect(ordered.map((card) => card.id)).toEqual(['b', 'c', 'a']);
  });
});
