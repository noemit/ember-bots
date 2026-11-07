import type { SessionReadMark } from '../types';

/**
 * Per-message read state.
 *
 * Read state used to be one timestamp per *session*, in memory, re-seeded as "all read" on every
 * launch. Home needs the opposite: which individual messages you have actually read, and it has to
 * survive a restart.
 *
 * The unit is the host's own entry ordinal (Hearth message ids are `e<entryId>`, and entry ids only
 * grow), so marking is a small scalar rather than a set of ids that grows forever:
 *
 *   - every message with ordinal ≤ `through` is read;
 *   - a message marked out of order sits in `ids` until `through` catches up and compacts it away;
 *   - a wire without ordinals (OpenChamber, being retired) falls back to `readAt` and timestamps.
 *
 * Nothing here marks anything implicitly: only `markRead` and `markAllRead` change a mark, and a
 * session being open on screen is not a reason to call either.
 */

/** Out-of-order marks kept per session. Past this, compaction lags but nothing is lost. */
export const MAX_OUT_OF_ORDER = 200;
/** Sessions with a mark; pruned with the workspace, so this is a backstop, not the usual bound. */
export const MAX_READ_MARKS = 2000;

export const EMPTY_READ_MARK: SessionReadMark = { through: 0, readAt: 0 };

/** The ordinal the wire minted for a message, or null when its id carries none. */
export const isOrdinalMarked = (mark: SessionReadMark, ordinal: number): boolean =>
  ordinal <= mark.through || (mark.ids?.includes(ordinal) ?? false);

/**
 * Whether one message is read. `ordinal` wins when it exists (the host's own ordering); otherwise
 * the message's time decides, which is the only thing an ordinal-free wire can answer.
 */
export const isMessageRead = (
  mark: SessionReadMark | undefined,
  ordinal: number | null,
  at: number
): boolean => {
  if (!mark) return false;
  if (ordinal !== null) return isOrdinalMarked(mark, ordinal);
  return at > 0 && at <= (mark.readAt ?? 0);
};

/**
 * Mark one message read, compacting whatever the new mark makes contiguous.
 *
 * `unreadOrdinals` is the ordinals the caller currently shows as unread *below* this one (a digest);
 * `through` only advances across a run that is read in full, so marking the third of five messages
 * never quietly marks the first two.
 */
export const markRead = (
  mark: SessionReadMark | undefined,
  ordinal: number,
  unreadOrdinals: readonly number[],
  at = 0
): SessionReadMark => {
  const base = mark ?? EMPTY_READ_MARK;
  if (ordinal <= base.through) return base;
  const ids = [...new Set([...(base.ids ?? []), ordinal])].sort((a, b) => a - b);
  let through = base.through;
  // Ascend everything that could extend the run — the messages the caller still shows as unread,
  // plus the out-of-order marks already held — and stop at the first one that is still unread.
  for (const candidate of [...new Set([...unreadOrdinals, ...ids])].sort((a, b) => a - b)) {
    if (candidate <= through) continue;
    if (!ids.includes(candidate)) break;
    through = candidate;
  }
  const kept = ids.filter((id) => id > through).slice(-MAX_OUT_OF_ORDER);
  return {
    through,
    ...(kept.length ? { ids: kept } : {}),
    readAt: Math.max(base.readAt ?? 0, at),
    ...(base.comments ? { comments: base.comments } : {}),
  };
};

/**
 * Mark a message read on an ordinal-free wire (OpenChamber), advancing `readAt` to `at`.
 */
export const markTimestampRead = (
  mark: SessionReadMark | undefined,
  at: number
): SessionReadMark => {
  const base = mark ?? EMPTY_READ_MARK;
  if (at <= (base.readAt ?? 0)) return base;
  return {
    ...base,
    readAt: at,
  };
};

/**
 * Everything up to and including `through` is read: what a right-click "Mark all as read" does.
 * Pending approvals and questions are not part of this — they are answered, not read.
 */
export const markAllRead = (
  mark: SessionReadMark | undefined,
  through: number,
  at = 0
): SessionReadMark => {
  const base = mark ?? EMPTY_READ_MARK;
  return {
    through: Math.max(base.through, through),
    readAt: Math.max(base.readAt ?? 0, at),
    ...(base.comments ? { comments: base.comments } : {}),
  };
};

/** One more comment set sent from Ember on this session; feeds the card's summary bar. */
export const addComments = (mark: SessionReadMark | undefined, count: number): SessionReadMark => {
  const base = mark ?? EMPTY_READ_MARK;
  if (count <= 0) return base;
  return { ...base, comments: (base.comments ?? 0) + count };
};

/**
 * Keep marks for the sessions still in play. Called with the workspace and the live session keys,
 * so an archived-then-restored session loses its history rather than leaking forever; the newest
 * `limit` are kept as a backstop.
 */
export const pruneReadMarks = (
  marks: Readonly<Record<string, SessionReadMark>>,
  keepKeys: readonly string[],
  limit = MAX_READ_MARKS
): Record<string, SessionReadMark> => {
  const keep = new Set(keepKeys);
  const kept = Object.entries(marks).filter(([key]) => keep.has(key));
  if (kept.length === 0) return {};
  // Deterministic, so a settings write that changes nothing is skipped by the caller.
  const bounded = kept.length > limit ? kept.slice(-limit) : kept;
  return Object.fromEntries(bounded);
};
