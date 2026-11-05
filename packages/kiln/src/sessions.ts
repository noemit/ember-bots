import type { Context } from "@earendil-works/chord";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  configure,
  defineDoc,
  defineTool,
  LiveDoc,
  section,
  type Agent,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from "@earendil-works/pi-durable";
import { AutoAcceptDoc, clearPendingApprovals, pendingApprovals } from "./approvals";
import { clearPendingQuestions, pendingQuestions } from "./ask";
import { MetaDoc, type HearthMeta } from "./meta";
import { registerAgentWithSuffix } from "./agents";

/**
 * `session` — lead a crew of **workers**, or start an explicit **peer** session.
 *
 * Two shapes, one tool (see `COAGENTS_PLAN.md` §3–§5):
 * - **worker** (the default): a hidden crew member owned by the caller. Ember hides it by
 *   `kind: "worker"` and surfaces it in the leader's crew strip. Its final message is its
 *   report; a supervisor tick writes that report into the leader's crew doc and wakes the
 *   leader once per generation (see `./crew`). It is an **ownerless** conversation, not
 *   task-owned: ownerless already survives a leader abort, and `kind` — not task ownership —
 *   is what hides it.
 * - **peer** (explicit): an ownerless, visible session the human chats with directly, the old
 *   behaviour. No `lead`, no report-back.
 *
 * Membership lives in the leader's crew doc (`hearth.sessions`, v2), so `list`/`status`/
 * `message`/`stop` reach the crew by name; the conversations themselves are independent.
 *
 * Deliberate simplification: workers are ownerless rather than owned by a background anchor
 * task. The plan's anchor was only needed to hide task-owned children, and `kind` replaces
 * that (Ember hides workers by `kind`); ownerless conversations already outlive a leader abort.
 * Report-back durability comes from the crew supervisor over the durable crew doc.
 */

/**
 * A worker's final-message-as-report instruction, rendered as the agent's `instructions`. A worker
 * that is handed no crew tool is not told it may delegate — the old text told every worker it might
 * spawn, one more nudge toward a loop.
 */
export const WORKER_INSTRUCTIONS =
  "You are a worker for another agent. Your final message is your report to your leader: " +
  "status, what you changed, blockers. You may ask the human when blocked; the question " +
  "reaches your leader too.";

/** The worker instruction naming its own delegation, for a worker that keeps the crew tool. */
export const WORKER_DELEGATION_INSTRUCTIONS =
  " When you spawn workers of your own, pass a short `role` (for example \"Researcher\" or " +
  "\"Reviewer\"): the role is what names the worker, so it reads \"Researcher #1\" instead of a " +
  "task summary. Do not spawn to hand your report back; reply directly. ";

/** True when a conversation may lead a crew at all. Pure. */
export const delegationRefused = (meta: HearthMeta | undefined): boolean => meta?.delegates === false;

/** What a refused spawn says: the tool was called by a conversation set not to delegate. */
export const DELEGATION_OFF =
  "Refused: this conversation is set not to delegate (`delegates: false`). Do the work here.";

/** Longest role label a spawn may pass; the composed title caps the role here. */
export const ROLE_CAP = 40;

/** The role a worker gets when its spawn names none. */
export const DEFAULT_WORKER_ROLE = "Worker";

/**
 * Trimmed, length-capped role label, or undefined when the value is absent or blank. Pure, so the
 * spawn path can tell "no role given" (default) from "blank role" (refused).
 */
export const normalizeRole = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, ROLE_CAP);
};

/**
 * The number the next worker of `role` takes in one leader's crew: 1 + the highest index that
 * role has already used. Crew entries are never removed, so a finished, stopped or archived
 * worker keeps its number and nothing is ever renumbered. Pure.
 */
export const nextRoleIndex = (
  items: Readonly<Record<string, CrewEntry>>,
  role: string
): number => {
  let highest = 0;
  for (const entry of Object.values(items)) {
    if (entry.role !== role) continue;
    if (entry.roleIndex !== undefined && entry.roleIndex > highest) highest = entry.roleIndex;
  }
  return highest + 1;
};

/** The composed worker title: `<Role> #<n>`. Pure. */
export const workerTitle = (role: string, index: number): string => `${role} #${index}`;

/** A peer's title when no explicit one is given: the brief's first line, capped. Pure. */
export const briefTitle = (brief: string, name: string): string =>
  (brief.trim().split("\n")[0] ?? name).replace(/^#+\s*/, "").slice(0, 120) || `Session: ${name}`;

/** 15 minutes: a worker that never reports still wakes its leader once at the deadline. */
export const CREW_DEADLINE_MS = 15 * 60 * 1000;
/** How long `session wait` blocks before returning what it knows. */
export const CREW_WAIT_MS = 10 * 60 * 1000;
/**
 * Depth: root 0. A depth-2 worker's spawn is refused, and a depth-3 worker loses the `session` tool
 * and gets `delegates: false`.
 *
 * The refusal lands one level *before* the cap on purpose. Without `lead` in its meta doc the
 * `depthOf` chain stops, so a worker whose meta is missing reads as a root (depth 0) and could
 * spawn for ever; keeping the tool until depth 3 means every conversation that still has it loses
 * it at depth 3 whatever the chain says.
 */
export const MAX_DEPTH = 3;
/**
 * A leader may start a new generation's crew only this long after the previous crew's wake. One
 * generation's spawns are instantaneous (a leader fans out, then waits); a *second* crew right after
 * being woken is a model reading "delegate when it helps" as "spawn again", and is how a report-back
 * loop becomes an unbounded tree of agents.
 */
export const CREW_SPAWN_MIN_GAP_MS = 10 * 60 * 1000;
/**
 * Concurrent workers in `starting | running` one leader may have: **no limit by default**.
 *
 * There used to be a hard 4 here, chosen as a load guardrail rather than a policy — each active worker
 * is a conversation with its own run on this single process. That reasoning no longer holds the way it
 * did: 0.29-0.32 took whole conversations out of the stream and out of entry pages, which is what made
 * many live conversations expensive. How many agents a person (or a leader) wants running is their
 * decision, and a refusal in the way of it is worse than the load it prevents.
 *
 * The guards that matter for a runaway *loop* are untouched: `SPAWN_RATE_LIMIT` (bursts),
 * `SPAWN_BUDGET` (per hour) and `CREW_SPAWN_MIN_GAP_MS` (a leader cannot raise a second crew right
 * after being woken). Those bound what a model can do; this only bounded what a fleet may be.
 *
 * `HEARTH_MAX_ACTIVE_WORKERS` restores a ceiling for a host that wants one (0 or unset means none).
 */
const configuredWorkerCeiling = (): number => {
  const raw = process.env.HEARTH_MAX_ACTIVE_WORKERS;
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

/**
 * Whether a leader may start another worker, given how many it already has active.
 *
 * Reads the environment per call rather than at import: a host can be started with
 * `HEARTH_MAX_ACTIVE_WORKERS=6`, and a test can exercise both branches without re-importing a module.
 */
export const workerCeilingRefusal = (active: number, ceiling = configuredWorkerCeiling()): string | undefined =>
  ceiling > 0 && active >= ceiling
    ? `Refused: ${active} workers already running (max ${ceiling}). Wait for one to report or stop one.`
    : undefined;

/** How the caps read in a tool description, so the copy cannot advertise a limit the code lacks. */
export const workerCapsText = (ceiling = configuredWorkerCeiling()): string =>
  ceiling > 0 ? `at most ${ceiling} active workers` : "any number of workers (bounded by the rate below)";

/** The ceiling in force, for callers that want to show it. 0 means none. */
export const activeWorkerCeiling = (): number => configuredWorkerCeiling();
/** Spawn loop guard: at most this many spawns per window per leader. */
export const SPAWN_RATE_LIMIT = 10;
export const SPAWN_RATE_WINDOW_MS = 60_000;
/**
 * Ceiling on the spawns one conversation may ask for in an hour, across every generation. The rate
 * cap above is a burst guard; this is what stops a model that *waits out* each crew window from
 * turning a report-back loop into an unending tree.
 */
export const SPAWN_BUDGET = 20;
export const SPAWN_BUDGET_WINDOW_MS = 60 * 60 * 1000;
/** How long a crew doc keeps its spawn timestamps, so the hourly budget survives a restart. */
export const SPAWN_HISTORY_MS = 24 * 60 * 60 * 1000;
/** A report's text is capped here; the crew doc holds the report, the wake only a digest. */
export const REPORT_CAP = 8_000;

/** One crew member this conversation started. */
export type CrewEntry = {
  kind: "worker" | "peer";
  conversationId: ConversationId;
  /** The title we set, so `status`/`list` can show it even after a rename. */
  title: string;
  /** Worker role the spawn named ("Worker" when it named none); the title's first half. */
  role?: string;
  /** Per-(leader, role) number this worker took; numbering never reuses one. */
  roleIndex?: number;
  /** Epoch ms the spawn was recorded; the brief's requestId and the rate cap use it. */
  spawnedAt: number;
  state: "starting" | "running" | "reported" | "failed" | "stopped" | "peer";
  /** The spawn cycle this entry belongs to; the unit of wake idempotency. */
  generation: number;
  /** The initial submission, so the brief is idempotent across a crash rerun. */
  briefRequestId: string;
  /**
   * Epoch ms this worker was last handed a task: its spawn, or a later `message`/`send` that put it
   * back to work. The start grace and the report's identity count from here, never from `spawnedAt`,
   * so a re-tasked worker is not judged settled by the spawn time it has outlived. Absent on
   * documents written before it existed; those fall back to `spawnedAt`.
   */
  taskAt?: number;
  /**
   * The worker's newest transcript entry when that task was handed over. An assistant entry at or
   * before this id is the *previous* task's answer, and the supervisor must not report it as the new
   * one. Absent means "no watermark": any assistant entry counts (the state a fresh worker is in).
   */
  answerFrom?: number;
  /**
   * Epoch ms a follow-up was queued behind this worker's in-flight answer. The supervisor must wait
   * for that answer *and* the turn after it before reporting, and the report it writes is for the
   * queued task — not the answer the leader already knows about. Cleared when that report lands.
   */
  followUpAt?: number;
  /**
   * When this worker's report should reach the leader.
   *
   * `always` (the default) writes a report into the leader's transcript and its wake digest for
   * every settled task. `on-failure` writes one only when the worker failed: a routine success is
   * already visible as `state: reported` on the crew doc, and the three artefacts around it - a
   * transcript entry, a digest line, and a leader turn paraphrasing "all 64 tests pass" - cost more
   * than the bit they carry. A leader that wants the detail asks: `results` and `status` still read
   * the crew.
   *
   * Absent means `always`, so documents written before this existed behave as they always did.
   */
  delivery?: "always" | "on-failure";
  /**
   * The answer the supervisor settled but did not show, because `delivery` is `on-failure` and the
   * worker succeeded. Kept so `results` can still answer a leader that asks; never read by a wake.
   */
  silentReport?: {
    /** Capped at `REPORT_CAP`. */
    text: string;
    at: number;
  };
  /** Written by the crew supervisor; the only report the leader's wake reads. */
  report?: {
    status: "ok" | "failed" | "aborted";
    /** Capped at `REPORT_CAP`. */
    text: string;
    at: number;
    requestId: string;
  };
  /** When this worker was forked for a human side question (`POST /conversations/:id/btw`). */
  sideQuestion?: string;
  /** Set when a human promoted this worker; the fork is the peer. */
  promotedTo?: number;
};

export type SessionsState = {
  /** Increments on the first spawn after a wake; the unit of wake idempotency. */
  generation: number;
  /** Keyed by the name the leader chose. */
  items: Record<string, CrewEntry>;
  /** Epoch ms after which the leader is woken with whatever has reported. */
  deadlineAt?: number;
  /** Epoch ms of recent spawns, backing the 10/min rate cap. */
  spawnedAt: number[];
  /** True once this generation's wake has been sent; a later spawn starts a new generation. */
  woke?: boolean;
  /**
   * The identity of the last wake sent for this generation: `wakeKeyOf` — the generation plus every
   * report it carried. A wake is due whenever the crew's current key differs, so a report that lands
   * after the generation's wake is still delivered, while a tick that reruns (or a restart) sends
   * nothing. `woke` alone cannot do this: one boolean per generation cannot say *what* was delivered.
   * Absent on documents written before it existed; at worst that re-sends one digest after upgrade.
   */
  wokeKey?: string;
  /** Epoch ms that wake was sent; the one-crew-at-a-time spawn gap counts from here. */
  wokeAt?: number;
};

/** Keyed by the name the spawner gave the session; v2 is the crew registry. */
export const SessionsDoc = defineDoc<SessionsState>({
  kind: "hearth.sessions",
  version: 2,
  scope: "conversation",
  history: "latest",
  // A fork starts without the parent's crew (they are separate conversations).
  fork: "initial",
  initial: () => ({ generation: 0, items: {}, spawnedAt: [] }),
  checkpointWhen: () => true,
  // v1 tracked ownerless "siblings" with `{ conversationId, title, spawnedAt, briefRequestId }`
  // and no kind/state. They were peers the old tool spawned, so normalize to peer/peer.
  migrate: (value, fromVersion) => {
    if (fromVersion >= 2) return value as unknown as SessionsState;
    const old = value as { items?: Record<string, Partial<CrewEntry> & { conversationId: ConversationId }> };
    const items: Record<string, CrewEntry> = {};
    for (const [key, entry] of Object.entries(old.items ?? {})) {
      items[key] = {
        kind: "peer",
        state: "peer",
        generation: 0,
        conversationId: entry.conversationId,
        title: entry.title ?? key,
        spawnedAt: entry.spawnedAt ?? 0,
        briefRequestId: entry.briefRequestId ?? `hearth.session.brief:${key}`,
      };
    }
    return { generation: 0, items, spawnedAt: [] };
  },
});

/** Walk the `lead` chain to this conversation's depth (root 0). Pure over a meta reader. */
export const depthOf = async (
  readMeta: (id: ConversationId) => Promise<HearthMeta | undefined>,
  start: ConversationId,
  max = 8
): Promise<number> => {
  let depth = 0;
  let current = start;
  for (let hops = 0; hops < max; hops += 1) {
    const lead = (await readMeta(current))?.lead;
    if (!lead) return depth;
    depth += 1;
    current = lead.conversationId as ConversationId;
  }
  return depth;
};

/** True when `count` spawns happened within the window ending at `now`. Pure. */
export const rateLimited = (
  spawnedAt: readonly number[],
  now: number,
  limit = SPAWN_RATE_LIMIT,
  windowMs = SPAWN_RATE_WINDOW_MS
): boolean => spawnedAt.filter((at) => now - at < windowMs).length >= limit;

/**
 * How long a leader must wait before spawning after a wake, or 0 when it may spawn now. The crew is
 * idle after a wake (`woke`), so a spawn would start a new generation; that is the loop's edge and it
 * waits for the gap. Spawns within one un-woken generation stay free. Pure.
 */
export const spawnGapMs = (state: { woke?: boolean; wokeAt?: number }, now: number): number => {
  if (state.woke !== true || state.wokeAt === undefined) return 0;
  return Math.max(0, state.wokeAt + CREW_SPAWN_MIN_GAP_MS - now);
};

/** How many spawns this conversation asked for in the hour ending at `now`. Pure. */
export const recentSpawns = (spawnedAt: readonly number[], now: number, windowMs = SPAWN_BUDGET_WINDOW_MS): number =>
  spawnedAt.filter((at) => now - at < windowMs).length;

/** What a spawn would hit right now, or undefined when it is allowed. Pure. */
export type SpawnRefusal = { readonly minutes: number } | { readonly budget: true };

export const spawnRefusal = (
  state: { woke?: boolean; wokeAt?: number; spawnedAt?: readonly number[] },
  now: number
): SpawnRefusal | undefined => {
  const gap = spawnGapMs(state, now);
  if (gap > 0) return { minutes: Math.ceil(gap / 60_000) };
  if (recentSpawns(state.spawnedAt ?? [], now) >= SPAWN_BUDGET) return { budget: true };
  return undefined;
};

/** The refusal text a model can act on. Pure. */
export const spawnRefusalText = (refusal: SpawnRefusal): string =>
  "budget" in refusal
    ? `Refused: this conversation has asked for ${SPAWN_BUDGET} workers in the last hour. Work on ` +
      `what you have, reply to the user, or use \`message\` to reach an existing worker.`
    : `Refused: a crew reported back ${refusal.minutes <= 1 ? "under a minute ago" : `${refusal.minutes} minutes ago`}. ` +
      `Read \`results\`, reply to the user, and only spawn again if the work genuinely needs a new ` +
      `crew. Delegating does not need a new spawn: \`message\` reaches the workers you already have.`;

/** Drop spawn timestamps older than the window. Pure. */
export const pruneSpawns = (spawnedAt: readonly number[], now: number, windowMs = SPAWN_RATE_WINDOW_MS): number[] =>
  spawnedAt.filter((at) => now - at < windowMs);

/**
 * The crew member a leader's message names, by the crew key it spawned or by the title Hearth
 * gave it (`Researcher #1`). Exact key first, then title, then a case-insensitive pass over both,
 * so a leader can address a worker the way it shows up in the crew strip. Pure.
 */
export const findCrewTarget = (
  items: Readonly<Record<string, CrewEntry>>,
  name: string
): { key: string; entry: CrewEntry } | undefined => {
  if (Object.hasOwn(items, name)) return { key: name, entry: items[name] };
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  const keys = Object.keys(items);
  const byTitle = keys.find((key) => items[key].title.trim().toLowerCase() === wanted);
  if (byTitle !== undefined) return { key: byTitle, entry: items[byTitle] };
  const byKey = keys.find((key) => key.trim().toLowerCase() === wanted);
  if (byKey !== undefined) return { key: byKey, entry: items[byKey] };
  return undefined;
};

/**
 * The submission id of one message to one crew member, stable across a crash rerun of the tool
 * task. Two messages from the same task to the same worker cannot collide, and two messages to
 * the same worker from different tasks stay distinct.
 */
export const crewMessageRequestId = (
  leader: ConversationId,
  key: string,
  spawnedAt: number,
  taskId: unknown
): string => `hearth.crew.msg:${leader}:${key}:${spawnedAt}:${String(taskId)}`;

/**
 * The states in which a worker still owes its leader something. A worker that is `reported`,
 * `failed` or `stopped` has finished: it must never keep a leader waiting.
 *
 * This is the single definition of "active" the crew supervisor (`./crew`) and the `wait` action
 * both read, so a state can't count as active for one and settled for the other — which is how a
 * failed worker used to leave its leader polling a deadline it had already passed.
 */
export const isActiveWorker = (entry: Pick<CrewEntry, "kind" | "state">): boolean =>
  entry.kind === "worker" && (entry.state === "starting" || entry.state === "running");

/**
 * Put a settled worker back to work after it is handed a new input (the `message` action, and the
 * `agents` tool's `send`).
 *
 * A worker that has reported is finished as far as the supervisor is concerned - the tick only
 * watches `starting | running` - so a new task handed to a `reported` worker used to leave its entry
 * `reported`: the new answer was never written down, and `wait` called the crew settled while the
 * worker was working. So the entry goes back to `starting`, and:
 *
 * - its report is cleared, because that report is the answer to the *previous* task;
 * - `answerFrom` records the worker's newest transcript entry, so an assistant turn at or before it
 *   can never be reported as the answer to the new one;
 * - `taskAt` gives the new task its own start grace;
 * - a deadline that has already passed is pushed out, so the leader is not woken with "(no report
 *   yet)" in the same breath it asked for the work.
 *
 * A message handed to an **already active** worker (a follow-up queued behind its in-flight answer)
 * is the case the supervisor gets wrong on its own: it would report the in-flight answer as the
 * reply to the new message. So the entry records `followUpAt`, keeps its state, clears the stale
 * report and pushes the deadline out; the supervisor waits for that answer *and* the turn after it
 * (see `./crew`), and reports the queued task's answer rather than the one already known.
 *
 * Returns whether the entry changed: `false` for a peer or an unknown key only.
 */
export const rearmWorker = async (
  tx: Tx,
  leader: ConversationId,
  key: string,
  worker: ConversationId,
  now: number
): Promise<boolean> => {
  const doc = await tx.doc(SessionsDoc, leader);
  const item = doc.items[key];
  if (item === undefined || item.kind !== "worker") return false;
  // The worker's newest transcript entry is the watermark for the answer being asked for. Read it
  // before anything is written, so a re-tasked worker's previous answer can never be reported as the
  // new one — including when the new task is *queued* behind that answer.
  const newest = (await tx.scanEntries({ conversationId: worker }, 1)).items[0] as { id: number } | undefined;
  if (isActiveWorker(item)) {
    // Already active: the supervisor is watching its in-flight answer, and that answer is *not* the
    // reply to this message. Mark the follow-up so the supervisor keeps watching past it, and moves
    // the watermark to the newest entry, so the report it writes is for the queued task.
    item.followUpAt = now;
    item.taskAt = now;
    delete item.report;
    if (doc.deadlineAt === undefined || doc.deadlineAt <= now) doc.deadlineAt = now + CREW_DEADLINE_MS;
    return true;
  }
  item.state = "starting";
  item.taskAt = now;
  item.generation = doc.generation;
  delete item.report;
  delete item.followUpAt;
  if (newest === undefined) delete item.answerFrom;
  else item.answerFrom = newest.id;
  if (doc.deadlineAt === undefined || doc.deadlineAt <= now) doc.deadlineAt = now + CREW_DEADLINE_MS;
  // A re-tasked worker after a wake belongs to the *next* generation, exactly as a spawn does: the
  // wake it would report into has already been delivered, and leaving it in the old generation keeps
  // it out of `wakeKeyOf` and `digestOf`. Advancing here mirrors `spawn`, so the two cannot disagree
  // about which generation a worker that owes an answer belongs to.
  if (doc.woke === true) {
    doc.generation += 1;
    doc.woke = false;
    delete doc.wokeKey;
    delete doc.wokeAt;
    item.generation = doc.generation;
  }
  return true;
};

/** True when a worker finished without a report it stands behind: `failed`, or cut off by `stop`. */
export const isUnsuccessful = (entry: Pick<CrewEntry, "kind" | "state">): boolean =>
  entry.kind === "worker" && (entry.state === "failed" || entry.state === "stopped");

/**
 * The crew's outcome in one word, read from the entries alone. `wait` and `results` both speak
 * from this, so a leader is never told a crew "settled" when every worker in it failed.
 */
export type CrewOutcome = "empty" | "active" | "ok" | "failed";

/**
 * The crew's outcome for one generation. Scoped, because crews outlive the generation that raised
 * them: a worker that failed in generation 1 must not make generation 2's `wait` announce
 * "finished with failures" when every generation-2 worker delivered. Omit `generation` to read the
 * whole crew (the `list`/`results` view, where history is the point).
 */
export const crewOutcome = (
  items: Readonly<Record<string, CrewEntry>>,
  generation?: number
): CrewOutcome => {
  const entries = Object.values(items).filter(
    (entry) => entry.kind === "worker" && (generation === undefined || entry.generation === generation)
  );
  if (entries.length === 0) return "empty";
  if (entries.some(isActiveWorker)) return "active";
  // One failure makes the crew's answer incomplete, even if other workers reported.
  return entries.some(isUnsuccessful) ? "failed" : "ok";
};

/**
 * One crew member as the leader reads it: a labelled header the model can act on, then its report.
 *
 * A failure is a **message**, not a wait state: it says plainly that this worker did not deliver,
 * names the reason, and is rendered as `FAILED` rather than as a bare `(no report yet)` that reads
 * like it is still coming. A `stopped` worker says who ended it.
 */
export const crewEntryText = (key: string, entry: CrewEntry): string => {
  const header = `${key} (${entry.kind}/${entry.state}): ${entry.title}`;
  if (entry.report) return `${header}\n${entry.report.text.slice(0, REPORT_CAP)}`;
  // A silent success — `delivery: "on-failure"` and the worker succeeded. The leader asked not to be
  // interrupted by it, but it asked; say so plainly rather than leaving it looking unanswered.
  if (entry.silentReport) return `${header}\n${entry.silentReport.text.slice(0, REPORT_CAP)}`;
  if (entry.state === "failed") return `${header}\nFAILED — this worker ended without a report. Do not wait for it.`;
  if (entry.state === "stopped") return `${header}\nSTOPPED — this worker's work was ended early; it produced no report.`;
  if (entry.state === "peer") return `${header}\n(a peer — it reports to the user, not to you)`;
  return `${header}\n(no report yet)`;
};

/**
 * The crew summary a leader reads, newest spawn first. Every member is one labelled block, so a
 * failed worker is as visible as a successful one instead of being a line inside a paragraph.
 */
export const crewReportText = (
  items: Readonly<Record<string, CrewEntry>>,
  generation?: number
): string => {
  const entries = Object.entries(items)
    .filter(([, entry]) => generation === undefined || entry.generation === generation)
    .sort((a, b) => b[1].spawnedAt - a[1].spawnedAt);
  if (entries.length === 0) return "No crew.";
  return entries.map(([key, entry]) => crewEntryText(key, entry)).join("\n\n");
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `session` tool. Actions:
 * - `spawn` (name, brief, kind?, role?, report?): start a crew **worker** (default) or an explicit
 *   **peer**. `report: "on-failure"` makes a routine success settle silently — the worker still
 *   shows as reported in `list` and `results` still has the text, but nothing interrupts the leader.
 * - `list`: every crew member this conversation started, newest first (kind/state shown).
 * - `status` (name): working or idle, via the member's `pi.live` run.
 * - `message` (name, message, followUp?): send it another message (steer while busy, or queue).
 * - `stop` (name): abort its current work (it stays usable).
 * - `results`: bounded reports from this conversation's crew.
 * - `wait`: poll for quiescence, bounded to 10 minutes.
 */
export const SessionTool = defineTool({
  name: "session",
  description:
    "Lead a crew of workers, or start an explicit peer session. `spawn` (name, brief, role?, " +
    "kind?) creates a session and gives it the brief; workers are the default and are hidden " +
    "helpers that report their final message back to you, while `kind: \"peer\"` starts an " +
    "independent session the user can see and chat with directly. Pass a short `role` " +
    "(\"Researcher\", \"Reviewer\"): Hearth titles the worker from it (`Researcher #1`, " +
    "`Researcher #2`, independent per role) and " +
    "defaults to `Worker #1` when you pass none. Pass `report: \"on-failure\"` for a brief whose " +
    "expected answer is \"done, nothing to say\" (run the tests, format these files): the worker " +
    "still appears as reported in `list` and `results`, but a success does not interrupt you. " +
    "`list` shows your crew; `status` (name) " +
    "reports working/idle; `message` (name, message, followUp?) sends another message; `stop` " +
    "(name) aborts its current work; `results` returns your crew's reports; `wait` blocks " +
    `(bounded to 10 minutes) until they settle. Caps: depth ${MAX_DEPTH}, ${workerCapsText()}, at ` +
    `most ${SPAWN_RATE_LIMIT} spawns per minute.`,
  parameters: obj({
    action: oneOf(["spawn", "list", "status", "message", "stop", "results", "wait"], {
      description: "spawn: start a session; the rest operate on names from `list`/`results`.",
    }),
    name: opt(str({ description: "A short handle you will use to refer to this session later." })),
    brief: opt(
      str({
        description:
          "spawn: the full, self-contained task prompt for the new session (it starts with none " +
          "of your context). Write it as if briefing a fresh agent: environment, files, workflow, " +
          "deliverable, coordination.",
      })
    ),
    kind: opt(
      oneOf(["worker", "peer"], {
        description:
          "spawn: \"worker\" (default) is a hidden crew member that reports back; \"peer\" is an " +
          "ownerless session the user sees and chats with directly.",
      })
    ),
    role: opt(
      str({
        description:
          "spawn: a short label for the worker's job, such as \"Researcher\", \"Graphics\" or " +
          "\"Reviewer\". The role names the worker (`<Role> #1`, `<Role> #2`, numbered per role) " +
          "and defaults to \"Worker\"; it is trimmed and capped at 40 characters.",
      })
    ),
    title: opt(str({ description: "spawn: an explicit session title; it wins over the composed one." })),
    cwd: opt(str({ description: "spawn: working directory (defaults to yours)." })),
    model: opt(str({ description: "spawn: model as provider/modelId (defaults to yours)." })),
    /**
     * When the worker's answer reaches the leader. `always` (default) writes a report entry and puts
     * it in the wake digest; `on-failure` stays quiet on success and speaks only when the worker
     * failed — for briefs whose expected answer is "done, nothing to say" ("run the tests", "format
     * these files"). The worker still shows as `reported` in `list`, and `results` still has the
     * text.
     */
    report: opt(
      oneOf(["always", "on-failure"], {
        description:
          "spawn: when the worker's answer reaches you. \"always\" (default) reports every task; " +
          "\"on-failure\" reports only a failure, so a routine success costs no transcript entry " +
          "and no wake line — use it for briefs whose expected answer is \"done, nothing to say\". " +
          "`results` still returns the text either way.",
      })
    ),
    message: opt(str({ description: "message: what to send." })),
    followUp: opt(
      bool({
        description: "message: true queues it after the session's current answer instead of steering into it.",
      })
    ),
  }),
  // Replay-safe: the crew entry and conversation are written in one commit and the brief carries
  // a requestId, so a crash rerun reuses the entry (or reacquires the same submission).
  replay: "safe",
  execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
    const { action, name, brief, kind, role, title, cwd, model, message, followUp, report } = args;
    const reply = (text: string, conversationId?: ConversationId): ToolExecutionResult => ({
      output: [{ type: "text" as const, text }],
      // A UI can attach to the spawned session through the call's details (like the examples).
      ...(conversationId === undefined || name === undefined
        ? {}
        : { details: { name, conversationId: String(conversationId) } }),
    });
    const spawner: ConversationId = api.conversationId;
    if (delegationRefused(await api.snapshot(MetaDoc, spawner, context))) {
      return reply("Refused: this conversation is set not to delegate (`delegates: false`). Do the work here.");
    }
    const state = (await api.snapshot(SessionsDoc, spawner, context)) ?? {
      generation: 0,
      items: {},
      spawnedAt: [],
    };

    /** Reports for every crew member, newest first, bounded to `REPORT_CAP` each. */
    const resultsText = (snapshot: Readonly<SessionsState>): string => crewReportText(snapshot.items);

    if (action === "list") {
      const items = Object.entries(state.items).sort((a, b) => b[1].spawnedAt - a[1].spawnedAt);
      if (items.length === 0) return reply("No crew.");
      return reply(
        items
          .map(([key, entry]) => `${key}: [${entry.kind}/${entry.state}] conversation ${entry.conversationId} — ${entry.title}`)
          .join("\n")
      );
    }

    if (action === "results") return reply(resultsText(state));

    if (action === "wait") {
      // Bounded quiescence wait: no worker still owing an answer, or ten minutes, whichever first.
      //
      // A worker that reaches `failed` or `stopped` is finished, and the supervisor writes that
      // state into this doc the moment it sees the worker has no run left. So the loop's exit is
      // the *crew*, not the clock: a failed worker stops counting as active here and its failure is
      // returned as a labelled result, never as "still waiting". The deadline is only for a worker
      // that is genuinely still running.
      const deadline = Date.now() + CREW_WAIT_MS;
      for (;;) {
        const snapshot = (await api.snapshot(SessionsDoc, spawner, context)) ?? state;
        if (context.abortSignal?.aborted) return reply("Stopped while waiting for the crew.");
        const active = Object.values(snapshot.items).filter(isActiveWorker);
        // Scoped to the generation this crew is working in: a worker that failed in an earlier
        // generation is history, and must not make this generation's `wait` report failures.
        const outcome = crewOutcome(snapshot.items, snapshot.generation);
        if (active.length === 0) {
          const body = crewReportText(snapshot.items, snapshot.generation);
          // Say what actually happened. "Crew settled" for a crew where a worker failed is the bug:
          // it reads like success and buries the failure a leader is supposed to act on.
          if (outcome === "failed") {
            return reply(
              `Crew finished with failures — do not wait for the workers marked FAILED or STOPPED.\n\n${body}`
            );
          }
          return reply(`Crew settled.\n\n${body}`);
        }
        if (Date.now() >= deadline) {
          const names = active.map((entry) => entry.title).join(", ");
          return reply(
            `Still running after ${Math.round(CREW_WAIT_MS / 60_000)} minutes: ${names}. ` +
              `What is known so far:\n\n${resultsText(snapshot)}`
          );
        }
        await sleep(1_000);
      }
    }

    if (name === undefined) return reply(`session ${action} needs a name.`);
    // Every action that names a member resolves it the way the crew strip shows it: by the crew key
    // the leader spawned, or by the title Hearth gave it (`Researcher #1`). `status`, `message` and
    // `stop` used to disagree — a title worked for `message` and resolved nothing for the others.
    const target = action === "spawn" ? undefined : findCrewTarget(state.items, name);
    const found = target?.entry;
    if (action !== "spawn" && found === undefined) {
      return reply(`No session named ${name}. Use list to see your crew.`);
    }

    if (action === "status") {
      const entry = found!;
      // Busy while it has a run (pi.live.run set), same signal Ember's summary uses.
      const busy = (await api.snapshot(LiveDoc, entry.conversationId, context))?.run !== undefined;
      return reply(
        `${entry.title}: ${busy ? "working" : "idle"} — [${entry.kind}/${entry.state}] ${entry.title}`
      );
    }

    if (action === "stop") {
      const entry = found!;
      const key = target!.key;
      const handle = await api.conversation(entry.conversationId, context);
      if (!handle) return reply(`Session ${entry.title} is gone.`, entry.conversationId);
      await handle.abort(context);
      // A stopped worker can no longer answer anything it parked: leaving the approval or question
      // pending keeps `needsInput` true for a card nobody can act on.
      if (entry.kind === "worker") {
        try {
          if ((await pendingApprovals(api, [entry.conversationId], context)).length > 0) {
            await clearPendingApprovals(api, entry.conversationId, context);
          }
          if ((await pendingQuestions(api, [entry.conversationId], context)).length > 0) {
            await clearPendingQuestions(api, entry.conversationId, context);
          }
        } catch (error) {
          console.error(
            "[hearth] clearing a stopped worker's parked prompts failed",
            error instanceof Error ? error.message : error
          );
        }
        await api.commit(async (tx) => {
          const doc = await tx.doc(SessionsDoc, spawner);
          const current = doc.items[key];
          if (current) {
            current.state = "stopped";
            delete current.followUpAt;
          }
        }, context);
      }
      return reply(`Stopped ${entry.title}. It stays available.`, entry.conversationId);
    }

    if (action === "message") {
      if (message === undefined || !message.trim()) return reply(`session message needs a message.`);
      const entry = found!;
      const key = target?.key ?? name;
      const handle = await api.conversation(entry.conversationId, context);
      if (!handle) return reply(`Session ${name} is gone.`, entry.conversationId);
      await handle.submit(
        {
          type: "input",
          content: message,
          whenBusy: followUp === true ? "followUp" : "steer",
          // Idempotent across a crash: a rerun of this call returns the same submission. The tool
          // task id is the per-call sequence, so two messages to the same worker do not collide.
          requestId: crewMessageRequestId(spawner, key, entry.spawnedAt, api.taskId),
        },
        context
      );
      // A settled worker owes a new answer now; without this its entry stays `reported` and the
      // supervisor never looks at it again (see `rearmWorker`).
      await api.commit((tx) => rearmWorker(tx, spawner, key, entry.conversationId, Date.now()), context);
      return reply(`${followUp === true ? "Queued for" : "Sent to"} ${name}.`, entry.conversationId);
    }

    // spawn
    if (brief === undefined || !brief.trim()) return reply("session spawn needs a brief.");
    if (role !== undefined && normalizeRole(role) === undefined) {
      return reply(
        "session spawn role cannot be blank: pass a short label such as \"Researcher\", or leave role out for \"Worker\"."
      );
    }
    const requestedRole = normalizeRole(role);
    const spawnKind: "worker" | "peer" = kind === "peer" ? "peer" : "worker";
    const now = Date.now();

    const existing = Object.hasOwn(state.items, name) ? state.items[name] : undefined;
    if (existing !== undefined) {
      // Replay-safe recovery: the entry and conversation were written in one commit, so reuse it
      // and re-place the brief (its requestId makes this idempotent if it already landed).
      const handle = await api.conversation(existing.conversationId, context);
      if (handle) {
        await handle.submit({ type: "input", content: brief, requestId: existing.briefRequestId }, context);
        return reply(
          `"${existing.title}" is already your ${existing.kind} (conversation ${existing.conversationId}).`,
          existing.conversationId
        );
      }
      return reply(`A session named ${name} already exists but is gone (conversation ${existing.conversationId}).`);
    }

    // Caps, enforced here (not in the prompt). Refusals are plain text the model can act on.
    if (rateLimited(state.spawnedAt, now)) {
      return reply(
        `Refused: more than ${SPAWN_RATE_LIMIT} spawns in the last minute. Wait a moment before spawning again.`
      );
    }
    // The post-wake window and the hourly budget. The same guards run again inside the commit below
    // (two spawns of one turn commit back to back, so the second must see the first's `wokeAt`).
    const early = spawnKind === "worker" ? spawnRefusal(state, now) : undefined;
    if (early !== undefined) return reply(spawnRefusalText(early));
    let childDepth = 0;
    if (spawnKind === "worker") {
      const parentDepth = await depthOf((id) => api.snapshot(MetaDoc, id, context), spawner);
      childDepth = parentDepth + 1;
      // Refuse one level before the tool disappears, so a mis-read `lead` chain cannot let a worker
      // that lost its meta spawn as though it were a root.
      if (childDepth >= MAX_DEPTH) {
        return reply(
          `Refused: crews may nest only ${MAX_DEPTH} deep, and this would be depth ${childDepth}. ` +
            `Do the work directly, or reply to your leader with what you have.`
        );
      }
      const activeWorkers = Object.values(state.items).filter(
        (entry) => entry.kind === "worker" && (entry.state === "starting" || entry.state === "running")
      ).length;
      const ceiling = workerCeilingRefusal(activeWorkers);
      if (ceiling !== undefined) return reply(ceiling);
    }

    // Inherit this conversation's resolved agent so the crew member starts in the same place with
    // the same model, thinking level and directory. A worker also copies auto-accept.
    const agent = await api.agent(context);
    const inheritedCwd = cwd ?? agent.cwd;
    const modelRef = model !== undefined ? parseModel(model) : agent.model;
    const autoAccept = spawnKind === "worker" ? await api.snapshot(AutoAcceptDoc, spawner, context) : undefined;
    const spawnedAt = now;
    const briefRequestId = `hearth.crew.brief:${spawner}:${name}:${spawnedAt}`;
    const explicitTitle = title !== undefined && title.trim().length > 0 ? title : undefined;
    // A new spawn after a wake starts a new generation; otherwise it joins the current cycle.
    const generation = state.woke ? state.generation + 1 : Math.max(state.generation, 1);
    // Kept for a day: the hourly budget (`SPAWN_BUDGET_WINDOW_MS`) has to survive a restart, which a
    // tick that only pruned the burst window would not.
    const spawnedTimestamps = [...pruneSpawns(state.spawnedAt, now, SPAWN_HISTORY_MS), now];

    // With crews off (or a registry that no longer offers them) the child has no `session` tool.
    const crewAvailable = agent.extensions.some((extension) => extension.name === Sessions.name);
    const workerKeepsCrew = childDepth < MAX_DEPTH;

    // Create the conversation and record it in the same commit, so a crash can never orphan the
    // record from the conversation (or vice versa).
    let refusedInside: NonNullable<ReturnType<typeof spawnRefusal>> | undefined;
    let refusedCeiling: string | undefined;
    const spawned = await api.commit(async (tx) => {
      // Read the crew first: a worker's role number is derived and written here, and the harness
      // serializes commits, so two simultaneous spawns cannot take the same number.
      const doc = await tx.doc(SessionsDoc, spawner);
      // The loop guards again, inside the serialized commit: two spawns of the same turn commit one
      // after the other, so the second sees the first's `wokeAt` and budget rather than a stale read.
      const fresh = { woke: doc.woke, wokeAt: doc.wokeAt, spawnedAt: doc.spawnedAt } as const;
      // Refusing inside the commit (writing nothing) is what makes the guard exact: a second spawn
      // of the same turn commits first, so this one sees the new timestamps, not a stale read.
      const refusedNow = spawnKind === "worker" ? spawnRefusal(fresh, now) : undefined;
      if (refusedNow !== undefined) {
        refusedInside = refusedNow;
        return undefined;
      }
      // The worker ceiling, again inside the commit for the same reason: a turn that spawns in
      // parallel commits its spawns one at a time, so counting only the snapshot read before the
      // commit lets every spawn of that turn see the same "one active worker" and pass.
      if (spawnKind === "worker") {
        const activeNow = Object.values(doc.items).filter(isActiveWorker).length;
        const ceilingNow = workerCeilingRefusal(activeNow);
        if (ceilingNow !== undefined) {
          refusedCeiling = ceilingNow;
          return undefined;
        }
      }
      // A worker is named by its role: "<Role> #<n>", numbered per (this leader, role). A peer
      // keeps the brief-derived title, and an explicit title always wins.
      const workerRole = spawnKind === "worker" ? requestedRole ?? DEFAULT_WORKER_ROLE : undefined;
      const roleIndex = workerRole === undefined ? undefined : nextRoleIndex(doc.items, workerRole);
      const sessionTitle =
        explicitTitle ??
        (workerRole !== undefined && roleIndex !== undefined
          ? workerTitle(workerRole, roleIndex)
          : briefTitle(brief, name));
      // Ownerless: Ember hides a worker by `kind`, and lists a peer as a column beside this one.
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, {
        ...(inheritedCwd !== undefined ? { cwd: inheritedCwd } : {}),
        ...(modelRef !== undefined ? { model: modelRef } : {}),
        ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
        ...(spawnKind === "worker"
          ? {
              instructions:
                crewAvailable && workerKeepsCrew
                  ? WORKER_INSTRUCTIONS + WORKER_DELEGATION_INSTRUCTIONS
                  : WORKER_INSTRUCTIONS,
            }
          : {}),
        // A worker that may not delegate never gains the crew tool, whatever the registry offers.
        ...(spawnKind === "worker" && (!crewAvailable || !workerKeepsCrew)
          ? { extensions: { remove: [Sessions] } }
          : {}),
      });
      // Title and crew membership land where Ember and the supervisor read them (the meta doc),
      // the same as `POST /conversations`.
      const meta = await tx.doc(MetaDoc, conversation.id);
      meta.title = sessionTitle;
      if (spawnKind === "worker") {
        meta.kind = "worker";
        meta.lead = { conversationId: spawner, host: "local" };
        meta.delegates = childDepth < MAX_DEPTH;
        // Auto-accept is copied at spawn, in the same commit, then the worker is independent.
        (await tx.doc(AutoAcceptDoc, conversation.id)).enabled = autoAccept?.enabled ?? false;
      } else {
        meta.kind = "peer";
      }
      // Registration is automatic. A name is what makes a session addressable by another agent, and
      // requiring a human to promote every worker meant a fresh host registered nothing at all — the
      // directory read empty while a whole crew was running. The title is the name; a repeated one
      // takes a suffix (`Migrate schema 2`), and a spawned peer reaches the same registry through
      // the explicit `kind: "peer"` branch. A registry row that already points at this conversation
      // is reused, so a replayed spawn does not add a second entry.
      await registerAgentWithSuffix(tx, sessionTitle, {
        conversationId: conversation.id as number,
        host: "local",
        pinned: false,
        createdAt: now,
        updatedAt: now,
      });
      doc.generation = generation;
      doc.woke = false;
      delete doc.wokeAt;
      doc.deadlineAt = now + CREW_DEADLINE_MS;
      doc.spawnedAt = spawnedTimestamps;
      doc.items[name] = {
        kind: spawnKind,
        conversationId: conversation.id,
        title: sessionTitle,
        ...(workerRole !== undefined ? { role: workerRole } : {}),
        ...(roleIndex !== undefined ? { roleIndex } : {}),
        spawnedAt,
        state: spawnKind === "worker" ? "starting" : "peer",
        generation,
        briefRequestId,
        // Recorded on the entry, not read from the call later: the supervisor judges a report many
        // ticks after this tool returned, and `rearmWorker` (a follow-up) must keep the same policy.
        ...(spawnKind === "worker" && report === "on-failure" ? { delivery: "on-failure" as const } : {}),
      };
      return { conversation, sessionTitle };
    }, context);
    if (spawned === undefined) {
      if (refusedCeiling !== undefined) return reply(refusedCeiling);
      return reply(spawnRefusalText(refusedInside ?? { budget: true }));
    }
    const created = spawned.conversation;
    const sessionTitle = spawned.sessionTitle;

    // Give it the brief. requestId makes a crash rerun return the same submission instead of a
    // second one.
    const handle = await api.conversation(created.id, context);
    if (!handle) return reply(`Created ${name} (conversation ${created.id}) but could not reach it.`, created.id);
    const submission = await handle.submit(
      { type: "input", content: brief, requestId: briefRequestId },
      context
    );
    const settled = await submission.status(context);
    if (spawnKind === "peer") {
      return reply(
        `Started peer "${sessionTitle}" (conversation ${created.id}; status ${settled.status}). ` +
          `The user sees it in Ember as a new column. Refer to it as ${name}.`,
        created.id
      );
    }
    return reply(
      `Started worker "${sessionTitle}" (conversation ${created.id}; status ${settled.status}). ` +
        `It appears in your crew strip; its final message will be reported back to you as a crew report. ` +
        `Use results to read it. Refer to it as ${name}.`,
      created.id
    );
  },
});

/** `provider/modelId` → a `ModelRef`, or undefined when malformed. */
const parseModel = (value: string): { provider: string; modelId: string } | undefined => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
};

/**
 * A short standing instruction so every conversation knows the crew tool exists and *when* to
 * use it. Leaders delegate when it materially helps; peers are explicit and visible.
 */
const crewSection = section(
  "crew",
  () =>
    "You can lead a crew of workers with the `session` tool (action `spawn`). A worker is a " +
    "hidden helper that appears in your crew strip; its final message is its report, which is " +
    "written back to you and surfaced as a crew report. Always pass a short `role` on spawn " +
    "(\"Researcher\", \"Graphics\", \"Reviewer\"): the role is what names the worker, so it " +
    "reads \"Researcher #1\" rather than a task summary, and the same role numbers up per crew. " +
    "A crew report is the answer to work you already delegated, not a request for more workers: " +
    "read it, reply to the user, and do not spawn a fresh crew because one reported back. Only " +
    "delegate when the task genuinely splits into independent parts, announce the crew in one " +
    "line, and do not spawn merely to avoid work. Use `kind: \"peer\"` " +
    "only to start an independent session the user sees and chats with directly. Manage your " +
    "crew with `list`, `status`, `message`, `stop`, `results` and `wait`. `message` (or the " +
    "`agents` tool's `send`) reaches your own crew by crew name or title; pass `followUp: true` " +
    "to queue a message for a busy worker, so it lands at that worker's next turn boundary " +
    `instead of interrupting the turn it is in. Limits: crews nest at most ${MAX_DEPTH} deep, ` +
    `${workerCapsText()}, and at most ${SPAWN_RATE_LIMIT} spawns per minute.`,
  { tag: false }
);

/** The `session` tool as its own extension, so a conversation can deselect it. */
export const Sessions = { name: "sessions", tools: [SessionTool], sections: [crewSection] } as const;
