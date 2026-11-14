import type { Session, SessionReadMark } from '../types';
import { sessionKey } from '../types';
import { visibleUnreadItems, type UnreadDigest } from './unreadDigest';

export const unreadVersion = (session: Session): number => session.lastEntryId ?? session.updated ?? 0;

/** Muting hides in-chat unread prompts too, without changing the evidence of reading. */
export const showUnreadNotifications = (muted: boolean, canMarkRead: boolean): boolean =>
  !muted && canMarkRead;

/** Notification policy never changes the evidence of reading used inside the conversation. */
export const notificationUnreadKeys = (
  sessions: readonly Session[],
  marks: Readonly<Record<string, SessionReadMark>>,
  digests: Readonly<Record<string, UnreadDigest>>,
  mutedSessions: readonly string[] = []
): Set<string> => {
  const muted = new Set(mutedSessions);
  return new Set(sessions.filter((session) => {
    const key = sessionKey(session);
    return !muted.has(key) && hasUnreadMessages(session, marks[key], digests[key]);
  }).map(sessionKey));
};

/** A conservative answer while the bounded message read is pending. */
export const mayHaveUnread = (session: Session, mark: SessionReadMark | undefined): boolean => {
  if (session.archived || session.kind === 'worker') return false;
  if (mark?.unreadOrdinals?.length || mark?.unreadMessageIds?.length) return true;
  if (typeof session.lastEntryId === 'number') return session.lastEntryId > (mark?.through ?? 0);
  return (session.updated ?? 0) > (mark?.readAt ?? 0);
};

export const hasUnreadMessages = (
  session: Session,
  mark: SessionReadMark | undefined,
  digest?: UnreadDigest
): boolean => {
  if (!mayHaveUnread(session, mark)) return false;
  // Undo is direct evidence of an unread reply, even before its older digest is refetched.
  if (mark?.unreadOrdinals?.length || mark?.unreadMessageIds?.length) return true;
  // Yesterday's empty digest must not hide today's scheduled report while its read is pending.
  if (!digest || digest.version !== unreadVersion(session)) return true;
  return visibleUnreadItems(digest, mark).length > 0 || !digest.complete;
};
