import * as React from 'react';
import { loadMessageAppend, loadMessageTail } from '../api';
import { digestUnread, type UnreadDigest } from '../lib/unreadDigest';
import { mayHaveUnread, unreadVersion as versionOf } from '../lib/sessionUnread';
import { MAX_READ_MARKS } from '../lib/readState';
import { sessionKey } from '../types';
import type { EmberSettings, Session, SessionReadMark } from '../types';

/** Sessions digested per pass. Far past what fits on screen; a bound, not a target. */
const DIGEST_LIMIT = 40;
/** Reads in flight at once, matching preview warming so Home never starves a column. */
const DIGEST_CONCURRENCY = 4;
/** Tail size for a session with no mark yet (or a wire without append reads). */
export const DIGEST_TAIL = 32;

export type UnreadDigestState = {
  /** Digests by session key; only sessions that could hold unread messages have one. */
  digests: Record<string, UnreadDigest>;
  /** Keys whose first read is in flight, so a card can hold its place. */
  pending: Record<string, true>;
};

/** A read mark in one string, for "has this changed since the digest was built?". */
const markSignature = (mark: SessionReadMark | undefined): string =>
  mark ? `${mark.through}|${(mark.ids ?? []).join(',')}|${mark.readAt ?? 0}` : '';

/**
 * The unread messages of every session that has any, for Home's cards.
 *
 * One bounded read per session that the list says has new entries: an append read since the read
 * mark where the host supports it, otherwise a tail. Nothing here marks anything read, and nothing
 * reads a whole conversation — Home stays affordable for a session whose history is tens of
 * megabytes.
 */
export function useUnreadDigests(options: {
  sessions: Session[];
  marks: EmberSettings['readMarks'];
  /** Anything older than this counts as read (the upgrade migration). */
  readSince: number;
  enabled: boolean;
}): UnreadDigestState {
  const { sessions, marks, readSince, enabled } = options;
  const [digests, setDigests] = React.useState<Record<string, UnreadDigest>>({});
  const [pending, setPending] = React.useState<Record<string, true>>({});
  // Kept across passes so an unchanged session is never re-read, and so a digest keeps its identity
  // (and its memoized card) when nothing about it changed.
  const cache = React.useRef(new Map<string, { digest: UnreadDigest; sig: string }>());
  const inFlight = React.useRef(new Set<string>());
  // Read through refs: a pass must not restart because a poll handed back a new array identity.
  const marksRef = React.useRef(marks);
  marksRef.current = marks;

  React.useEffect(() => {
    if (!enabled) return;
    const targets = sessions
      .filter((session) => mayHaveUnread(session, marksRef.current[sessionKey(session)]))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, Math.min(DIGEST_LIMIT, MAX_READ_MARKS));
    if (targets.length === 0) return;

    let cancelled = false;
    const fresh = targets.filter((session) => {
      const key = sessionKey(session);
      if (inFlight.current.has(key)) return false;
      const cached = cache.current.get(key);
      // Same entries and the same read mark means the same answer: nothing to re-read. A mark that
      // moved (the dot on a row, or "Mark all as read") changes the signature, so the digest is
      // rebuilt and the counters behind it follow.
      return !cached || cached.digest.version !== versionOf(session) || cached.sig !== markSignature(marksRef.current[key]);
    });
    if (fresh.length === 0) return;

    setPending((prev) => {
      const next = { ...prev };
      fresh.forEach((session) => {
        next[sessionKey(session)] = true;
      });
      return next;
    });

    void (async () => {
      const results: Array<[string, UnreadDigest | null]> = [];
      let cursor = 0;
      const readNext = async (): Promise<void> => {
        while (!cancelled && cursor < fresh.length) {
          const session = fresh[cursor];
          cursor += 1;
          const key = sessionKey(session);
          inFlight.current.add(key);
          const mark = marksRef.current[key];
          let digest: UnreadDigest | null;
          try {
            digest = await digestFor(session, mark);
          } catch {
            // A failed read leaves the previous digest in place; the poll tries again next pass.
            digest = null;
          } finally {
            inFlight.current.delete(key);
          }
          if (cancelled) return;
          results.push([key, digest]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DIGEST_CONCURRENCY, fresh.length) }, () => readNext())
      );
      if (cancelled || results.length === 0) return;
      results.forEach(([key, digest]) => {
        if (digest) cache.current.set(key, { digest, sig: markSignature(marksRef.current[key]) });
      });
      setDigests((prev) => {
        let changed = false;
        const next = { ...prev };
        results.forEach(([key, digest]) => {
          if (!digest) return;
          const existing = prev[key];
          if (
            existing &&
            existing.version === digest.version &&
            existing.complete === digest.complete &&
            existing.items.length === digest.items.length &&
            existing.items.every((item, index) => item.id === digest.items[index]?.id)
          ) {
            return;
          }
          next[key] = digest;
          changed = true;
        });
        return changed ? next : prev;
      });
      setPending((prev) => {
        let changed = false;
        const next = { ...prev };
        results.forEach(([key]) => {
          if (!next[key]) return;
          delete next[key];
          changed = true;
        });
        return changed ? next : prev;
      });
    })();

    return () => {
      cancelled = true;
    };
    // `sessions` is the poll's array; identity changes every tick, so the work above is guarded by
    // version comparison rather than by this dependency.
  }, [enabled, sessions, readSince]);

  // Drop digests for sessions that no longer exist or no longer have anything unread, so the map
  // cannot outgrow the session list.
  React.useEffect(() => {
    const live = new Set(
      sessions
        .filter((session) => mayHaveUnread(session, marksRef.current[sessionKey(session)]))
        .map(sessionKey)
    );
    setDigests((prev) => {
      const keys = Object.keys(prev);
      const kept = keys.filter((key) => live.has(key));
      if (kept.length === keys.length) return prev;
      return Object.fromEntries(kept.map((key) => [key, prev[key]]));
    });
  }, [sessions, marks]);

  return { digests, pending };
}

/**
 * One session's unread messages. An append read since the mark is exact and cheap; a tail is the
 * fallback, and when it fills its limit the digest says it is not complete rather than pretending
 * to know how many messages are hidden behind it.
 */
const digestFor = async (
  session: Session,
  mark: SessionReadMark | undefined
): Promise<UnreadDigest> => {
  const version = versionOf(session);
  if (mark && (mark.through ?? 0) > 0) {
    const page = await loadMessageAppend(session.instanceId, session.id, mark.through);
    if (page.supported) {
      return digestUnread(page.messages, { mark, complete: page.complete, version });
    }
  }
  const tail = await loadMessageTail(session.instanceId, session.id, session.directory, DIGEST_TAIL);
  return digestUnread(tail, { mark, complete: tail.length < DIGEST_TAIL, version });
};
