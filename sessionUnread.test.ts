import { expect, test } from 'bun:test';
import { hasUnreadMessages } from './src/lib/sessionUnread';
import { staleScheduledRuns } from './src/lib/bulkArchive';
import { digestUnread } from './src/lib/unreadDigest';
import type { ChatMessage, Session } from './src/types';

const session: Session = { instanceId: 'local', id: 'run', lastEntryId: 12, updated: 1000 };
const reply: ChatMessage = { id: 'e12', role: 'assistant', completed: true, text: 'Report ready', parts: [], createdAt: 1000 };
const digest = digestUnread([reply], { version: 12, complete: true, mark: undefined });

test('a stale empty digest cannot hide a subsequent scheduled report', () => {
  const yesterday = { version: 10, complete: true, items: [] };
  expect(hasUnreadMessages(session, { through: 10 }, yesterday)).toBe(true);
  expect(hasUnreadMessages(session, { through: 10 }, digest)).toBe(true);
  expect(hasUnreadMessages(session, { through: 10, ids: [12] }, digest)).toBe(false);
});

test('an incomplete tail cannot prove that older unread messages are gone', () => {
  expect(hasUnreadMessages(session, { through: 10, ids: [12] }, { ...digest, complete: false })).toBe(true);
  expect(hasUnreadMessages(session, { through: 12 }, { ...digest, complete: false })).toBe(false);
});

test('automatic cleanup waits for read evidence, including for muted or failed runs', () => {
  const key = 'local::run';
  for (const mood of ['idle', 'error', 'unread'] as const) {
    const sweep = (read: boolean) => staleScheduledRuns(
      [session], { [key]: 'task' }, { [key]: mood }, new Set(), 3 * 86_400_000,
      new Set(read ? [key] : [])
    );
    expect(sweep(!hasUnreadMessages(session, undefined, digest))).toEqual([]);
    expect(sweep(!hasUnreadMessages(session, { through: 10, ids: [12] }, digest))).toEqual([session]);
    expect(sweep(!hasUnreadMessages({ ...session, lastEntryId: 13 }, { through: 10, ids: [12] }, digest))).toEqual([]);
  }
});
