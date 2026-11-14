import { expect, test } from 'bun:test';
import { hasUnreadMessages, notificationUnreadKeys } from '../src/lib/sessionUnread';
import { moodFrom } from '../src/blob/mood';
import { staleScheduledRuns } from '../src/lib/bulkArchive';
import { digestUnread } from '../src/lib/unreadDigest';
import type { ChatMessage, Session } from '../src/types';

const session: Session = { instanceId: 'local', id: 'run', lastEntryId: 12, updated: 1000 };
const reply: ChatMessage = { id: 'e12', role: 'assistant', completed: true, text: 'Report ready', parts: [], createdAt: 1000 };
const digest = digestUnread([reply], { version: 12, complete: true, mark: undefined });

test('muting suppresses only notification unread keys, including fresh replies and stale digests', () => {
  const sessions = [session, { ...session, instanceId: 'other' }, { ...session, id: 'thread', kind: 'worker' as const }, { ...session, id: 'hidden', archived: 1 }];
  const marks = { 'local::run': { through: 10 } };
  const before = structuredClone(marks);
  const stale = { 'local::run': { version: 10, complete: true, items: [] } };
  expect([...notificationUnreadKeys(sessions, marks, stale)]).toEqual(['local::run', 'other::run']);
  expect([...notificationUnreadKeys(sessions, marks, stale, ['local::run'])]).toEqual(['other::run']);
  expect([...notificationUnreadKeys(sessions, marks, { 'local::run': digest }, ['local::run'])]).toEqual(['other::run']);
  // Newer output still remains unread without raising an indicator; unmuting reveals it again.
  expect([...notificationUnreadKeys([{ ...session, lastEntryId: 13 }], marks, stale, ['local::run'])]).toEqual([]);
  expect(hasUnreadMessages(session, marks['local::run'], digest)).toBe(true);
  expect(notificationUnreadKeys(sessions, marks, stale, []).has('local::run')).toBe(true);
  expect(marks).toEqual(before);
});

test('a muted unread dot does not conceal approvals, questions, failures or running work', () => {
  const unread = notificationUnreadKeys([session], {}, {}, ['local::run']).has('local::run');
  expect(moodFrom('idle', undefined, false, unread)).toBe('idle');
  expect(moodFrom('needs-input', 'input', false, unread)).toBe('input');
  expect(moodFrom('needs-input', 'question', false, unread)).toBe('question');
  expect(moodFrom('error', undefined, false, unread)).toBe('error');
  expect(moodFrom('active', undefined, false, unread)).toBe('busy');
});

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
