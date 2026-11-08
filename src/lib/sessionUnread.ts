import type { Session, SessionReadMark } from '../types';
import { visibleUnreadItems, type UnreadDigest } from './unreadDigest';

export const unreadVersion = (session: Session): number => session.lastEntryId ?? session.updated ?? 0;

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
