/** Snooze is only a local visibility preference; it never changes work, read state or drafts. */
export const setSessionSnoozed = (current: readonly string[], key: string, snoozed: boolean): string[] =>
  snoozed ? [...new Set([...current, key])] : current.filter((entry) => entry !== key);

export type SnoozePruningEvidence = {
  /** Exact keys proven deleted (or proven ineligible workers), not keys absent from a list response. */
  deletedSessionKeys?: ReadonlySet<string>;
  /** Hosts explicitly removed from configuration, not temporarily hidden or unavailable hosts. */
  removedInstanceIds?: ReadonlySet<string>;
};

/**
 * Prune only from positive evidence. Partial pages, filtered/hidden session lists and unavailable
 * hosts say nothing about existence. In particular archiving must preserve snooze for restoration.
 * Callers must never turn an incomplete snapshot into a set of "deleted" keys.
 */
export const pruneSnoozedSessions = (
  current: readonly string[],
  { deletedSessionKeys, removedInstanceIds }: SnoozePruningEvidence = {},
): string[] => current.filter((key) =>
  !deletedSessionKeys?.has(key) && !removedInstanceIds?.has(key.slice(0, key.indexOf('::'))),
);
