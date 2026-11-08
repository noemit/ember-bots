import type { Session } from '../types';
import { sessionKey } from '../types';
import { crewByLeader, threadDescendants } from './crew';

/**
 * Which sessions to stop processes for when a bot is hidden.
 *
 * Hiding a leader hides its workers too — they have no rail row of their own, so a leftover process
 * under one of them would become unreachable the moment the leader left the list. The rule is
 * therefore the same graph the crew strip draws: the session itself plus every descendant at any
 * depth. `threadDescendants` is the one walk: it is cycle-safe, dedupes by session key, and already
 * refuses workers whose `instanceId` differs from the leader's.
 *
 * Three things are deliberately *not* stopped:
 *
 * - **Another host's sessions.** Pids mean different programs on different machines, so a
 *   cross-host `lead` (malformed data, or a worker someone moved) is counted as `elsewhere` and
 *   skipped rather than sent to the wrong machine or silently forgotten.
 * - **Sessions already hidden.** An archived session's leftovers are its own unfinished business;
 *   re-hiding a leader should not fire requests at a worker someone hid earlier. The walk still
 *   passes *through* it, so a hidden worker's own worker is found.
 * - **Sessions with nothing listed.** The summary carries only the heaviest few, and a session with
 *   none costs no request at all.
 *
 * Pids are deduped per session: a stop naming a pid twice is a stop with a lie in it.
 */
export type ProcessesToStop = {
  /** One entry per session with anything to stop: the leader first, then descendants. */
  targets: Array<{ session: Session; pids: number[] }>;
  /** Workers in this crew that live on another instance, so a caller can say so honestly. */
  elsewhere: number;
};

export const processesToStopOnHide = (
  session: Session,
  sessions: readonly Session[]
): ProcessesToStop => {
  const crews = crewByLeader(sessions);
  const descendants = threadDescendants(session, crews);
  // Descendants are same-host by construction. Everything else in the roster that belongs to this
  // crew lives elsewhere, and is counted rather than stopped.
  const elsewhereKeys = new Set<string>();
  for (const group of crews.values()) {
    for (const worker of group) {
      if (worker.instanceId === session.instanceId) continue;
      if (belongsToCrew(worker, session, crews)) elsewhereKeys.add(sessionKey(worker));
    }
  }

  const targets: ProcessesToStop['targets'] = [];
  const add = (entry: Session) => {
    if (entry.instanceId !== session.instanceId || entry.archived) return;
    const pids = [...new Set((entry.processes?.items ?? []).map((process) => process.pid))];
    if (pids.length > 0) targets.push({ session: entry, pids });
  };
  // The leader first: it is the bot the person hid, and its own leftovers are the least surprising.
  add(session);
  descendants.forEach(add);
  return { targets, elsewhere: elsewhereKeys.size };
};

/**
 * Whether a session on another host reports (directly or through a chain) to this leader.
 *
 * `threadDescendants` stops at the host boundary, so a cross-host branch is invisible to it. This
 * walks the `lead` chain *upward* instead — the direction that survives a hop — and stops on a
 * cycle, a missing leader, or the host boundary being irrelevant because the chain is by key.
 */
const belongsToCrew = (
  worker: Session,
  leader: Session,
  crews: ReadonlyMap<string, readonly Session[]>
): boolean => {
  const byKey = new Map<string, Session>();
  for (const group of crews.values()) for (const entry of group) byKey.set(sessionKey(entry), entry);
  const goal = sessionKey(leader);
  const seen = new Set<string>();
  let current: Session | undefined = worker;
  while (current) {
    const key = sessionKey(current);
    if (seen.has(key)) return false;
    seen.add(key);
    if (current.lead && sessionKey(current.lead) === goal) return true;
    current = current.lead ? byKey.get(sessionKey(current.lead)) : undefined;
  }
  return false;
};
