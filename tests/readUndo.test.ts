import { describe, expect, test } from 'bun:test';
import { parseReadMarks } from '../electron/transport';
import {
  MAX_UNREAD_EXCEPTIONS, addComments, isMessageRead, markAllRead, markRead,
  markTimestampRead, messageReadReceipt, undoMessageRead, unreadReadCursor,
} from '../src/lib/readState';
import { digestUnread, visibleUnreadItems } from '../src/lib/unreadDigest';
import { mayHaveUnread, hasUnreadMessages } from '../src/lib/sessionUnread';
import type { SessionReadMark } from '../src/types';

const persisted = (mark: SessionReadMark | undefined) => parseReadMarks(JSON.parse(JSON.stringify({ chat: mark }))).chat;

describe('scoped read Undo', () => {
  test('undo survives compaction, settings reconciliation and restart, without changing concurrent marks/comments', () => {
    const before = { through: 10, ids: [14], comments: 2 };
    const receipt = messageReadReceipt(before, 11, 100, 'e11');
    const marked = persisted(markRead(before, 11, [11, 12], 200));
    const later = persisted(addComments(markRead(marked, 12, [12], 300), 3));
    expect(later.through).toBe(14);
    const undone = persisted(undoMessageRead(later, receipt));
    expect(undone.through).toBe(14);
    expect(undone.comments).toBe(5);
    expect(undone.readAt).toBe(300);
    expect(isMessageRead(undone, 10, 0)).toBe(true);
    expect(isMessageRead(undone, 11, 0)).toBe(false);
    expect(isMessageRead(undone, 12, 0)).toBe(true);
    expect(isMessageRead(undone, 14, 0)).toBe(true);
    expect(isMessageRead(undone, 15, 0)).toBe(false);
    expect(undoMessageRead(undone, receipt)).toBe(undone);
  });

  test('out-of-order undo remains unread when another reply later advances through it', () => {
    const receipt = messageReadReceipt({ through: 1 }, 4, 0, 'e4');
    const undone = undoMessageRead(markRead({ through: 1 }, 4, [2, 4]), receipt);
    const advanced = persisted(markRead(undone, 2, [2, 4]));
    expect(isMessageRead(advanced, 4, 0)).toBe(false);
    expect(isMessageRead(advanced, 2, 0)).toBe(true);
    const remarked = persisted(markRead(advanced, 4, [4]));
    expect(isMessageRead(remarked, 4, 0)).toBe(true);
    expect(remarked.unreadOrdinals).toBeUndefined();
  });

  test('Undo affects only its reply after mark-all; subsequent mark-all explicitly clears exceptions', () => {
    const receipt = messageReadReceipt(undefined, 3, 0, 'e3');
    const current = markAllRead(markRead(undefined, 3, [3]), 20, 500);
    const undone = persisted(undoMessageRead(current, receipt));
    expect(isMessageRead(undone, 3, 0)).toBe(false);
    expect(isMessageRead(undone, 19, 0)).toBe(true);
    expect(markAllRead(undone, 20, 600).unreadOrdinals).toBeUndefined();
  });

  test('timestamp wires distinguish different replies with identical timestamps', () => {
    const receipt = messageReadReceipt(undefined, null, 100, 'reply-a');
    const current = markTimestampRead(markTimestampRead(undefined, 100, 'reply-a'), 200, 'reply-c');
    const undone = persisted(undoMessageRead(current, receipt));
    expect(isMessageRead(undone, null, 100, 'reply-a')).toBe(false);
    expect(isMessageRead(undone, null, 100, 'reply-b')).toBe(true);
    expect(isMessageRead(undone, null, 200, 'reply-c')).toBe(true);
    const remarked = persisted(markTimestampRead(undone, 100, 'reply-a'));
    expect(isMessageRead(remarked, null, 100, 'reply-a')).toBe(true);
    expect(remarked.readAt).toBe(200);
  });

  test('a receipt for an already-read message cannot unread it', () => {
    const current = { through: 12 };
    expect(undoMessageRead(current, messageReadReceipt(current, 11, 0, 'e11'))).toBe(current);
  });

  test('reading another chat leaves the target receipt scoped by its caller', () => {
    const before = { a: { through: 1 }, b: { through: 1 } };
    const receipt = messageReadReceipt(before.a, 2, 0, 'e2');
    const settings = { readMarks: { a: markRead(before.a, 2, [2]), b: markRead(before.b, 2, [2]) }, mutedSessions: ['b'], theme: 'clay' };
    const next = { ...settings, readMarks: { ...settings.readMarks, a: undoMessageRead(settings.readMarks.a, receipt) } };
    expect(isMessageRead(next.readMarks.a, 2, 0)).toBe(false);
    expect(next.readMarks.b).toBe(settings.readMarks.b);
    expect(next.mutedSessions).toBe(settings.mutedSessions);
    expect(next.theme).toBe('clay');
  });

  test('parser validates and bounds exceptions, while normal writer refuses overflow without losing existing choices', () => {
    const current = { through: 4000, unreadOrdinals: Array.from({ length: MAX_UNREAD_EXCEPTIONS }, (_, i) => i + 1) };
    expect(() => undoMessageRead(current, messageReadReceipt(undefined, 3000, 0, 'e3000'))).toThrow(/Ember.*Mark.*try Undo/i);
    expect(current.unreadOrdinals).toHaveLength(MAX_UNREAD_EXCEPTIONS);
    const parsed = parseReadMarks({ a: { through: 20, unreadOrdinals: [3, 3, -1, '4', 1.5, null], unreadMessageIds: ['reply', 'reply', '', null, 3] } }).a;
    expect(parsed.unreadOrdinals).toEqual([3]);
    expect(parsed.unreadMessageIds).toEqual(['reply']);
    expect(persisted(current).unreadOrdinals).toHaveLength(MAX_UNREAD_EXCEPTIONS);
  });

  test('digest fetch floor revisits older undone replies and rail eligibility survives a fully read watermark', () => {
    const receipt = messageReadReceipt(undefined, 3, 0, 'e3');
    const mark = persisted(undoMessageRead({ through: 100 }, receipt));
    expect(unreadReadCursor(mark)).toBe(2);
    expect(hasUnreadMessages({ id: 'chat', instanceId: 'local', lastEntryId: 100 }, mark, { items: [], complete: true, version: 100 })).toBe(true);
    expect(mayHaveUnread({ id: 'chat', instanceId: 'local', lastEntryId: 100 }, mark)).toBe(true);
    const messages = [3, 50, 100].map((n) => ({ id: 'e' + n, role: 'assistant' as const, text: 'Reply', parts: [{ type: 'text' as const, id: 'part' + n, text: 'Reply' }], completed: true, createdAt: n, completedAt: n }));
    const digest = digestUnread(messages.filter((m) => Number(m.id.slice(1)) > unreadReadCursor(mark)), { mark, complete: true, version: 100 });
    expect(visibleUnreadItems(digest, mark).map((m) => m.id)).toEqual(['e3']);
    expect(unreadReadCursor({ through: 100, unreadOrdinals: [1, 25] })).toBe(0);
  });
});
