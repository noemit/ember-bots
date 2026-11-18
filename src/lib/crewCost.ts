/**
 * What a session actually cost: its own turns **plus every worker below it**.
 *
 * Hearth sums a conversation's `cost` from that conversation's own `pi.usage` ledger, and a worker is
 * a separate conversation with its own ledger. So the badge at the top of a leader read as "the price
 * of this session" while showing 22% of it — measured on this host: leader **$1.07** with 17 workers
 * totalling **$3.87**, 78% invisible; another leader $0.92 against $2.50 in workers.
 *
 * The summaries are already in hand (workers are hidden from the rail, but they arrive with their
 * own `cost`), so the total is a pure derivation — no host change, no extra read. Three things it has
 * to get right:
 *
 * - **Descendants, not direct reports.** Crews nest (a worker can lead its own workers), so this walks
 *   the `lead` chain to any depth, with a visited set so a malformed chain cannot loop.
 * - **Archived and finished workers still count.** The money was spent; where the session is now is a
 *   different question.
 * - **Honesty about the missing parts.** A leader whose own turns were not priced must not look priced
 *   *because* a worker was: the badge carries a "floor" marker and the tooltip names which part is
 *   missing, rather than silently presenting the crew total as if it were the whole bill.
 */
import { sessionKey, type Session } from '../types';
import { isWorker } from './crew';

/** The leader's own spend, and its crew's, kept apart so the badge can say which is which. */
export type CrewCost = {
  /** Priced spend from the session's own turns (`undefined` when the host priced none). */
  own?: number;
  /** Priced spend from every worker below it, at any depth. */
  crew: number;
  /** How many workers the crew total covers (all descendants, priced or not). */
  workers: number;
  /**
   * True when some conversation in the subtree ran and reported no price, so `own + crew` is a floor
   * rather than the bill.
   */
  partial: boolean;
};

const buildChildrenByParent = (sessions: readonly Session[]): Map<string, Session[]> => {
  const children = new Map<string, Session[]>();
  for (const candidate of sessions) {
    if (!candidate.lead || !isWorker(candidate)) continue;
    const parent = sessionKey(candidate.lead);
    const list = children.get(parent);
    if (list) list.push(candidate);
    else children.set(parent, [candidate]);
  }
  return children;
};

const finishCrewCost = (
  session: Session,
  hasRun: boolean,
  workers: number,
  crew: number,
  partial: boolean
): CrewCost | null => {
  const own = typeof session.cost === 'number' && Number.isFinite(session.cost) && session.cost > 0
    ? session.cost
    : undefined;
  const resolvedPartial = own === undefined && hasRun ? true : partial;
  if (own === undefined && crew === 0 && !resolvedPartial) return null;
  return { own, crew, workers, partial: resolvedPartial };
};

type SubtreeAggregate = {
  workers: number;
  crew: number;
  partial: boolean;
};

const aggregateChildren = (
  list: readonly Session[],
  memo: ReadonlyMap<string, SubtreeAggregate>
): SubtreeAggregate => {
  let workers = 0;
  let crew = 0;
  let partial = false;
  for (const worker of list) {
    workers += 1;
    const cost = worker.cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) crew += cost;
    else partial = true;
    const sub = memo.get(sessionKey(worker));
    if (sub) {
      workers += sub.workers;
      crew += sub.crew;
      if (sub.partial) partial = true;
    }
  }
  return { workers, crew, partial };
};

/**
 * @param session          the session whose badge this is
 * @param hasRun           whether its own transcript has entries (a never-run session has spent nothing)
 * @param sessions         every known session, on every instance — workers included
 * @param childrenByParent optional pre-built parent→workers index to avoid scanning `sessions` repeatedly
 */
export const crewCostOf = (
  session: Session,
  hasRun: boolean,
  sessions: readonly Session[],
  childrenByParent: ReadonlyMap<string, readonly Session[]> = buildChildrenByParent(sessions)
): CrewCost | null => {
  const rootKey = sessionKey(session);
  const direct = childrenByParent.get(rootKey);
  if (!direct || direct.length === 0) {
    return finishCrewCost(session, hasRun, 0, 0, false);
  }

  let workers = 0;
  let crew = 0;
  let partial = false;
  const seen = new Set<string>([rootKey]);
  const queue: Session[] = [...direct];
  for (let head = 0; head < queue.length; head += 1) {
    const worker = queue[head]!;
    const key = sessionKey(worker);
    // A worker is one conversation: count it once even if a malformed chain reaches it twice.
    if (seen.has(key)) continue;
    seen.add(key);
    workers += 1;
    const cost = worker.cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) crew += cost;
    // A worker with no priced turn (zero, or no cost at all) has spent something the badge cannot
    // count, so the family total is a floor rather than the bill.
    else partial = true;
    const next = childrenByParent.get(key);
    if (next) {
      for (const child of next) queue.push(child);
    }
  }

  return finishCrewCost(session, hasRun, workers, crew, partial);
};

/**
 * Compute `crewCostState(crewCostOf(session, hasRun(session), sessions))` for every session in
 * `sessions` in `O(N)` time: builds `childrenByParent` once, aggregates acyclic subtrees bottom-up,
 * and falls back to `crewCostOf` only when malformed data contains cycles or duplicate worker keys.
 */
export const crewCostsByKey = (
  sessions: readonly Session[],
  hasRun: (session: Session) => boolean
): Map<string, CrewCostState> => {
  const childrenByParent = new Map<string, Session[]>();
  const parentOfWorker = new Map<string, string>();
  let hasDuplicateWorkerKey = false;

  for (const candidate of sessions) {
    if (!candidate.lead || !isWorker(candidate)) continue;
    const workerKey = sessionKey(candidate);
    const parentKey = sessionKey(candidate.lead);
    if (parentOfWorker.has(workerKey)) hasDuplicateWorkerKey = true;
    else parentOfWorker.set(workerKey, parentKey);
    const list = childrenByParent.get(parentKey);
    if (list) list.push(candidate);
    else childrenByParent.set(parentKey, [candidate]);
  }

  const memo = new Map<string, SubtreeAggregate>();
  if (!hasDuplicateWorkerKey && childrenByParent.size > 0) {
    const pending = new Map<string, number>();
    const ready: string[] = [];
    for (const [parentKey, list] of childrenByParent) {
      let unresolved = 0;
      for (const child of list) {
        if (childrenByParent.has(sessionKey(child))) unresolved += 1;
      }
      if (unresolved === 0) {
        memo.set(parentKey, aggregateChildren(list, memo));
        ready.push(parentKey);
      } else {
        pending.set(parentKey, unresolved);
      }
    }
    for (let head = 0; head < ready.length; head += 1) {
      const resolvedKey = ready[head]!;
      const parentKey = parentOfWorker.get(resolvedKey);
      if (parentKey === undefined) continue;
      const left = (pending.get(parentKey) ?? 0) - 1;
      if (left === 0) {
        pending.delete(parentKey);
        const list = childrenByParent.get(parentKey);
        if (list) {
          memo.set(parentKey, aggregateChildren(list, memo));
          ready.push(parentKey);
        }
      } else {
        pending.set(parentKey, left);
      }
    }
  }

  const result = new Map<string, CrewCostState>();
  for (const session of sessions) {
    const key = sessionKey(session);
    const ran = hasRun(session);
    if (!childrenByParent.has(key)) {
      result.set(key, crewCostState(finishCrewCost(session, ran, 0, 0, false)));
      continue;
    }
    const sub = memo.get(key);
    if (sub) {
      result.set(key, crewCostState(finishCrewCost(session, ran, sub.workers, sub.crew, sub.partial)));
    } else {
      result.set(key, crewCostState(crewCostOf(session, ran, sessions, childrenByParent)));
    }
  }
  return result;
};

export type CrewCostState =
  /** Nothing has run anywhere below: no badge, because there is nothing to claim. */
  | { kind: 'none' }
  /** At least one part is priced; `partial` says the total is a floor. */
  | { kind: 'priced'; total: number; own?: number; crew: number; workers: number; partial: boolean }
  /** Everything ran and nothing was priced: the host's ledger reported no cost. */
  | { kind: 'unknown' };

export const crewCostState = (cost: CrewCost | null): CrewCostState => {
  if (!cost) return { kind: 'none' };
  const total = (cost.own ?? 0) + cost.crew;
  if (total > 0) {
    return {
      kind: 'priced',
      total,
      own: cost.own,
      crew: cost.crew,
      workers: cost.workers,
      partial: cost.partial,
    };
  }
  return { kind: 'unknown' };
};

const money = (value: number): string => {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
};

const workersLabel = (count: number): string => `${count} worker${count === 1 ? '' : 's'}`;

/**
 * The badge's tooltip: the split, named, and — when a part is missing — which one.
 *
 * A total on its own invites the reading "this session cost that". The badge is a *floor* when a
 * provider did not price some turns, and the sentence has to say so rather than leave the reader to
 * discover it.
 */
export const crewCostTitle = (state: CrewCostState): string => {
  if (state.kind !== 'priced') return '';
  const parts: string[] = [];
  if (state.own !== undefined) parts.push(`this session's turns ${money(state.own)}`);
  if (state.crew > 0) parts.push(`its crew ${money(state.crew)} across ${workersLabel(state.workers)}`);
  const split = parts.length > 0 ? ` — ${parts.join(' and ')}` : '';
  const floor = state.partial
    ? ' Some turns in this family were not priced by the provider, so this is a floor, not the bill.'
    : '';
  return `Spent across this session and its crew, from the host's own usage ledgers${split}.${floor}`;
};

/** The badge's word: the total, marked with `+` when it is a floor. */
export const crewCostLabel = (state: CrewCostState): string => {
  if (state.kind !== 'priced') return '';
  return `${money(state.total)}${state.partial ? '+' : ''}`;
};
