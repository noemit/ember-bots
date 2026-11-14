/**
 * Coagent crew helpers: pure derivations over Hearth's summary fields (`kind`, `lead`,
 * `needsInput`). No React, no reads — the crew strip and the leader's mood are built entirely
 * from the sessions the session list already returned.
 *
 * `sessionKey` is defined once in `src/types.ts` (next to `Session`/`SessionRef`) and is the
 * only key format here: a leader and its `lead` ref both reduce to `instanceId::sessionId`.
 */
import { sessionKey } from '../types';
import type { BallState, Session } from '../types';

/** True when a session is a hidden crew worker (as opposed to a peer or a plain session). */
export const isWorker = (session: Session): boolean => session.kind === 'worker';

/**
 * A sensible default name for the promote dialog: the worker's own title, trimmed, falling back
 * to `Worker <id>` when it has none. Names are display-unique per host, so this is only a seed —
 * the dialog lets the human edit it before the endpoint is called.
 */
export const promotionNameFor = (worker: Session): string =>
  worker.title?.trim() || `Worker ${worker.id}`;

/**
 * Group worker sessions by their leader's key (`instanceId::sessionId`) — the direct children
 * only. Only `kind === "worker"` sessions with a `lead` are grouped: peers keep `lead` as
 * history but are addressable, not crew members, so they never appear here.
 */
export const crewByLeader = (sessions: readonly Session[]): Map<string, Session[]> => {
  const groups = new Map<string, Session[]>();
  sessions.forEach((session) => {
    if (!isWorker(session) || !session.lead) return;
    const key = sessionKey(session.lead);
    const existing = groups.get(key);
    if (existing) existing.push(session);
    else groups.set(key, [session]);
  });
  return groups;
};

/** Known descendants for source links; cycles and cross-instance ids stay within this graph. */
export const threadDescendants = (leader: Session, crews: ReadonlyMap<string, readonly Session[]>): Session[] => {
  const found: Session[] = [];
  const seen = new Set([sessionKey(leader)]);
  const stack = [sessionKey(leader)];
  while (stack.length) {
    for (const worker of crews.get(stack.pop()!) ?? []) {
      if (worker.instanceId !== leader.instanceId) continue;
      const key = sessionKey(worker);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(worker);
      stack.push(key);
    }
  }
  return found;
};

/**
 * Sources visible from this conversation: reporting descendants and workers it actually spawned.
 * A level-2 requester starts a sibling under its level-1 supervisor, so `lead` alone does not
 * authorize its own result link. The stable creator does; unrelated siblings and peer forks do not.
 */
export const threadSourcesFor = (
  session: Session,
  crews: ReadonlyMap<string, readonly Session[]>,
  sessions: readonly Session[]
): Session[] => {
  const targets = new Map(threadDescendants(session, crews).map((worker) => [sessionKey(worker), worker]));
  for (const worker of sessions) {
    if (worker.kind !== 'worker' || worker.instanceId !== session.instanceId) continue;
    if (worker.creator && sessionKey(worker.creator) === sessionKey(session)) {
      targets.set(sessionKey(worker), worker);
    }
  }
  return [...targets.values()];
};

/**
 * Every worker's key, at any depth.
 *
 * A worker has no unread management: it is a thread its leader reads, not a place a person reads.
 * Its summary does not always carry `kind`, so the crew roster decides too — the same source the
 * Threads shelf is drawn from.
 */
export const workerKeySet = (
  sessions: readonly Session[],
  crews: ReadonlyMap<string, readonly Session[]>
): Set<string> => {
  const keys = new Set<string>();
  for (const session of sessions) if (isWorker(session)) keys.add(sessionKey(session));
  for (const workers of crews.values()) for (const worker of workers) keys.add(sessionKey(worker));
  return keys;
};

/**
 * Rows in a root leader's Threads shelf. The graph's `lead` is the reporting parent, not the
 * requester that initiated a spawn; displaying by lead keeps siblings in their actual crew.
 * Legacy depth-3+ workers remain reachable at their true depth, without duplicating cycles.
 */
export type ThreadRow = { worker: Session; depth: number; group: Session };

export const threadRows = (
  leader: Session,
  crews: ReadonlyMap<string, readonly Session[]>
): ThreadRow[] => {
  const rows: ThreadRow[] = [];
  const seen = new Set([sessionKey(leader)]);
  const walk = (parent: Session, group: Session, depth: number) => {
    for (const worker of crews.get(sessionKey(parent)) ?? []) {
      const key = sessionKey(worker);
      if (worker.instanceId !== leader.instanceId || seen.has(key)) continue;
      seen.add(key);
      rows.push({ worker, depth, group });
      walk(worker, group, depth + 1);
    }
  };
  for (const group of crews.get(sessionKey(leader)) ?? []) {
    const key = sessionKey(group);
    if (group.instanceId !== leader.instanceId || seen.has(key)) continue;
    seen.add(key);
    rows.push({ worker: group, depth: 1, group });
    walk(group, group, 2);
  }
  return rows;
};

/**
 * The shelf counts a blocked descendant once even when it is also a direct thread.
 *
 * The tab reads "running / total" — two numbers that answer "how much is happening" and "how much
 * is there" at a glance. A thread waiting on a person is not running, so it counts in the total
 * only; the tray's own attention dot is what says a person is needed.
 */
export const threadShelfStatus = (
  workers: readonly Session[], blocked: readonly BlockedWorker[], stateFor?: (worker: Session) => BallState
): { total: number; running: number; needsHuman: number; summary: string; detail?: string } => {
  const all = new Map([...workers, ...blocked.map((entry) => entry.worker)].map((worker) => [sessionKey(worker), worker]));
  const blockedKeys = new Set(blocked.map((entry) => sessionKey(entry.worker)));
  let running = 0;
  let needsHuman = 0;
  for (const worker of all.values()) {
    if (worker.needsInput || stateFor?.(worker) === 'needs-input' || blockedKeys.has(sessionKey(worker))) needsHuman += 1;
    else if (stateFor?.(worker) === 'active') running += 1;
  }
  // Named in full for a tooltip and a screen reader, where a bare ratio would be cryptic.
  const detail = needsHuman
    ? `${running} of ${all.size} threads running · ${needsHuman} needs you`
    : `${running} of ${all.size} threads running`;
  return { total: all.size, running, needsHuman, summary: `${running} / ${all.size}`, detail };
};

/**
 * Whether a leader needs input, rolled up **transitively**: its own summary `needsInput`, or any
 * direct or indirect worker's (depth 2+ — a worker that is itself a leader of a sub-crew). The
 * `lead` graph is walked with a visited set so a cycle (a spawn loop, or malformed data) can't
 * recurse forever.
 */
export const leaderNeedsInput = (
  leader: Session,
  sessions: readonly Session[],
  ownNeedsInput: boolean = leader.needsInput === true
): boolean => {
  if (ownNeedsInput) return true;
  const crews = crewByLeader(sessions);
  const visited = new Set<string>([sessionKey(leader)]);
  const stack = [sessionKey(leader)];
  while (stack.length) {
    const key = stack.pop() as string;
    const children = crews.get(key);
    if (!children) continue;
    for (const child of children) {
      if (child.needsInput === true) return true;
      const childKey = sessionKey(child);
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      stack.push(childKey);
    }
  }
  return false;
};

/**
 * How deep a session sits in its crew: 0 for a plain/lead session, 1 for a leader's worker, 2 for a
 * worker's worker, and so on. Walks the same `lead` chain `leaderNeedsInput` does, with the same
 * visited set, so a cycle (a spawn loop, or malformed data) stops instead of recursing forever —
 * a session caught in one is reported at whatever depth the walk first reached it.
 */
export const crewDepth = (session: Session, sessions: readonly Session[]): number => {
  const byKey = new Map(sessions.map((entry) => [sessionKey(entry), entry]));
  const visited = new Set<string>([sessionKey(session)]);
  let depth = 0;
  let lead = session.lead;
  while (lead) {
    const key = `${lead.instanceId}::${lead.sessionId}`;
    if (visited.has(key)) break;
    visited.add(key);
    depth += 1;
    lead = byKey.get(key)?.lead;
  }
  return depth;
};

/** A worker whose question is waiting, paired with how far below its leader it sits. */
export type BlockedWorker = {
  /** The worker itself, so the caller can open the conversation that is blocked. */
  worker: Session;
  /** How deep in the crew it sits (`crewDepth`): 1 for a direct worker, 2+ for a sub-crew. */
  depth: number;
  /** The worker's own `title`, trimmed — what a row calls it, falling back to `Worker <id>`. */
  title: string;
};

/**
 * The workers **under** `leader` that are blocked on the human right now, at any depth — the ones
 * a leader's blob glows for but which the rail otherwise hides. `leaderNeedsInput` answers "does
 * anything below want input?"; this answers "which ones?".
 *
 * Only a worker's own summary flag counts (`needsInput`), so the list shrinks the moment a question
 * is answered: it is derived fresh on every poll and never accumulated. Order is breadth-first from
 * the leader, so a direct worker precedes the sub-crew behind it, then by recency. Each branch is
 * visited once (the same cycle guard as the rollup).
 */
export const blockedWorkersUnder = (
  leader: Session,
  sessions: readonly Session[]
): BlockedWorker[] => {
  const crews = crewByLeader(sessions);
  const visited = new Set<string>([sessionKey(leader)]);
  const blocked: BlockedWorker[] = [];
  const queue: Array<{ key: string; depth: number }> = [{ key: sessionKey(leader), depth: 0 }];
  while (queue.length) {
    const { key, depth } = queue.shift() as { key: string; depth: number };
    for (const child of crews.get(key) ?? []) {
      const childKey = sessionKey(child);
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      if (child.needsInput === true) {
        blocked.push({
          worker: child,
          depth: depth + 1,
          title: child.title?.trim() || `Worker ${child.id}`,
        });
      }
      queue.push({ key: childKey, depth: depth + 1 });
    }
  }
  return blocked.sort((a, b) => a.depth - b.depth || (b.worker.updated ?? 0) - (a.worker.updated ?? 0));
};

/**
 * The workers blocked on the human anywhere in the given set of sessions — a flat, leader-less view
 * for anything that lists blocked workers without walking one crew.
 * Order: shallowest first, then most recent, so a direct sub-agent outranks a nested one.
 */
export const blockedWorkersAmong = (sessions: readonly Session[]): BlockedWorker[] => {
  const depthByKey = new Map(sessions.map((session) => [sessionKey(session), crewDepth(session, sessions)]));
  return sessions
    .filter((session) => isWorker(session) && session.needsInput === true)
    .map((worker) => ({
      worker,
      depth: depthByKey.get(sessionKey(worker)) ?? 1,
      title: worker.title?.trim() || `Worker ${worker.id}`,
    }))
    .sort((a, b) => a.depth - b.depth || (b.worker.updated ?? 0) - (a.worker.updated ?? 0));
};

/** A worker's display state in the strip. Ordered by precedence in `workerStateLabel`. */
export type CrewWorkerStatus = 'working' | 'needs input' | 'failed' | 'idle' | 'reported' | 'unknown';

/**
 * What the strip shows for a worker. `session.needsInput` is authoritative (it is what escalates
 * to the leader), then the coarse ball state the host reported. `reported` is a passive finish
 * state the lead can pass once the worker's report has landed; absent *and* without a status answer
 * it is `unknown`, never `idle`: a worker on a host that is not answering may be mid-turn, and a
 * crew that quietly reads "resting" is how a stalled run goes unnoticed.
 */
export type CrewWorkerSignal = {
  /** Coarse ball state from the instance's status poll (`/sessions/status`). */
  state?: BallState;
  /** True once the worker's reporter has written a report for the current generation. */
  reported?: boolean;
};

export const workerStateLabel = (session: Session, signal: CrewWorkerSignal = {}): CrewWorkerStatus => {
  if (session.needsInput === true || signal.state === 'needs-input') return 'needs input';
  if (signal.state === 'error') return 'failed';
  if (signal.state === 'active') return 'working';
  if (signal.reported) return 'reported';
  if (signal.state === undefined || signal.state === 'unknown') return 'unknown';
  return 'idle';
};

/**
 * How much of the leader's colour a crew brick takes: a faint wash behind the title, and a border
 * tinted far enough to read as the same family as the leader's blob. Both are mixed against the
 * theme (the wash over the card, the edge over `--border`), so they need no per-theme palette and
 * survive light and dark without being checked twice. `crew.test.ts` holds the wash to a contrast
 * floor so a tinted brick can never mute the 11px title it carries.
 */
export const CREW_BRICK_TINT = { wash: 10, edge: 45 } as const;

/**
 * The leader's colour as a brick's background: a wash, not a fill. `blobColor` returns either a
 * `var(--blob-N)` (crystal, and buddy with a grouped identity) or a raw hex (buddy, ungrouped), so
 * the only way to soften it is to compose it — `color-mix(… , transparent)` keeps every pixel of
 * the colour's own hue and lets the card behind it show through.
 */
export const leaderBrickWash = (color: string): string =>
  `color-mix(in oklab, ${color} ${CREW_BRICK_TINT.wash}%, transparent)`;

/**
 * The brick's edge, mixed with the theme's own border rather than with `transparent`: a pale blob
 * on a pale surface would otherwise draw an edge nobody can see, and a brick with no edge stops
 * reading as a brick.
 */
export const leaderBrickEdge = (color: string): string =>
  `color-mix(in oklab, ${color} ${CREW_BRICK_TINT.edge}%, var(--border))`;

/** Both halves of a brick's leader tint, ready for an inline `style`. */
export const leaderBrickStyle = (color: string): { backgroundColor: string; borderColor: string } => ({
  backgroundColor: leaderBrickWash(color),
  borderColor: leaderBrickEdge(color),
});

/**
 * The colour family a brick is drawn in. `attention` and `failed` are the two that own their own
 * surface (highlight and destructive) — they are the reasons the strip exists, so the leader's
 * colour must not wash them out. The rest only carry a dot.
 */
export type CrewBrickTone = 'attention' | 'active' | 'done' | 'quiet' | 'failed' | 'unknown';

/** How one brick draws its status. */
export type CrewBrickSignal = {
  /** The word for the status — always present, because the brick always carries it off-screen. */
  word: string;
  /** True only for the states loud enough to print the word on the brick. */
  showWord: boolean;
  tone: CrewBrickTone;
};

/**
 * Six text badges stacked over a composer were unreadable, so a brick carries a dot instead and
 * keeps the word in its tooltip and its `aria-describedby` (never in the accessible name: a worker
 * is looked up by its title). Two states stay loud, because they are the ones the strip exists to
 * surface: `needs input` prints its word, and `failed` takes a destructive surface rather than a
 * differently-tinted dot. `unknown` is neither: the host has not said, so the brick keeps its
 * dashed edge (a missing answer is not a verdict) and says nothing it cannot support.
 */
export const brickStatusSignal = (status: CrewWorkerStatus): CrewBrickSignal => {
  switch (status) {
    case 'needs input':
      return { word: 'needs input', showWord: true, tone: 'attention' };
    case 'failed':
      return { word: 'failed', showWord: false, tone: 'failed' };
    case 'working':
      return { word: 'working', showWord: false, tone: 'active' };
    case 'reported':
      return { word: 'reported', showWord: false, tone: 'done' };
    case 'idle':
      return { word: 'idle', showWord: false, tone: 'quiet' };
    case 'unknown':
      return { word: 'status unknown', showWord: false, tone: 'unknown' };
  }
};

/** The prefix Hearth puts on the input that wakes a leader when its crew reports back. */
/**
 * Splits a crew into what is happening now and what has finished. The strip's job is the first list;
 * the second is history, so it lives behind a disclosure rather than in the growing row of workers.
 */
export const splitCrew = (
  workers: readonly Session[],
  stateFor?: (session: Session) => BallState
): { live: Session[]; previous: Session[] } => {
  const live: Session[] = [];
  const previous: Session[] = [];
  workers.forEach((worker) => {
    const status = workerStateLabel(worker, {
      state: stateFor?.(worker) ?? (worker.needsInput ? 'needs-input' : 'unknown'),
    });
    // A promoted worker stays in the live rows however quiet it is. Promotion is a deliberate human
    // act that creates a durable link to a named peer, and that link is the only thing the strip
    // offers for it — burying it under "previous worker chats" alongside finished one-off tasks
    // hides the one row that is still a standing relationship. The disclosure landed a day after the
    // promoted-worker test was written and quietly broke it for thirty versions, because nothing ran
    // the suite.
    const standing = worker.promotedTo !== undefined;
    const finished = status === 'idle' || status === 'reported';
    if (finished && !standing) previous.push(worker);
    else live.push(worker);
  });
  return { live, previous };
};

/**
 * True when a crew has nothing happening: every worker is idle or has already reported back. The
 * crew card starts collapsed in that state, so a quiet crew stops taking room above the composer.
 */
export const crewIsResting = (
  workers: readonly Session[],
  stateFor?: (session: Session) => BallState
): boolean =>
  workers.every((worker) => {
    const status = workerStateLabel(worker, {
      state: stateFor?.(worker) ?? (worker.needsInput ? 'needs-input' : 'unknown'),
    });
    return status === 'idle' || status === 'reported';
  });

export const CREW_REPORT_PREFIX = '[crew] ';
export const SIDE_QUESTION_PREFIX = 'Side question:';

export type ParsedCrewReport = {
  summary: string;
  kind: 'crew' | 'side-question';
};

/**
 * Parse a server-generated crew wake (`[crew] …`). When the wake was produced by a side question
 * (`[crew] Side question:\n…`), `kind` is `'side-question'` so the transcript renders a "Side
 * question" card distinct from a periodic crew report. Returns null for every normal user message.
 */
export const parseCrewReport = (text: string): ParsedCrewReport | null => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(CREW_REPORT_PREFIX)) return null;
  const raw = trimmed.slice(CREW_REPORT_PREFIX.length).trim();
  if (!raw) return null;
  if (raw.startsWith(SIDE_QUESTION_PREFIX)) {
    const summary = raw.slice(SIDE_QUESTION_PREFIX.length).trim();
    return summary ? { summary, kind: 'side-question' } : null;
  }
  return { summary: raw, kind: 'crew' };
};
