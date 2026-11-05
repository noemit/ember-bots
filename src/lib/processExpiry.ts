/**
 * When a session's leftover programs are due to be stopped, and how the countdown reads.
 *
 * An agent that starts a dev server or a `nohup worker &` leaves it running after the turn, and
 * nothing on the host reaps it: the process is a child of nothing once the turn ends, and it can sit
 * there for days. Ember therefore ends its own leftovers after a fixed window, counted from **when
 * the process started** rather than from when Ember noticed it — a deadline that moved every time
 * the window reopened would never arrive, and a session left running since yesterday should be the
 * first thing reaped, not the last.
 *
 * Two honest consequences, both of which the UI has to say out loud:
 *
 * - **Ember has to be running.** The stop is a request Ember makes, so a closed window means nothing
 *   is reaped; on reopen anything already past its deadline is stopped then. `reapDue` is written for
 *   that: it takes what is still running and answers what to stop, so a restart is just the first
 *   tick with a long gap behind it.
 * - **A deadline is per program, not per session.** Programs in one session start at different
 *   times, so each carries its own expiry.
 *
 * Pure on purpose: the countdown's wording, the deadline arithmetic and the "which do I reap"
 * decision are all pinned by tests rather than by watching a live session for ninety minutes.
 */

/**
 * How long a leftover program is given.
 *
 * Ninety minutes is long enough for a dev server to outlive the turn that started it and for a
 * person to come back to it, and short enough that an overnight session does not hold a port or a
 * browser until the machine is rebooted.
 */
export const PROCESS_LIFETIME_MS = 90 * 60 * 1000;

/** An extension the clock button offers. Ten minutes is one more errand, not one more hour. */
export const PROCESS_EXTENSION_MS = 10 * 60 * 1000;

/** Where a single program stands against its deadline. */
export type ProcessExpiry = {
  /** Epoch ms it will be stopped at (started + lifetime + any extension). */
  expiresAt: number;
  /** Epoch ms until then; negative once it is overdue. */
  remainingMs: number;
  /** Past its deadline and waiting for the next tick. */
  expired: boolean;
};

/**
 * One program's deadline.
 *
 * `extensionMs` is the total already granted by the clock button, not one press: the caller keeps a
 * running sum per session, so pressing twice adds twenty minutes rather than replacing ten.
 */
export const processExpiry = (
  startedAt: number,
  now: number = Date.now(),
  extensionMs = 0
): ProcessExpiry => {
  const expiresAt = startedAt + PROCESS_LIFETIME_MS + Math.max(0, extensionMs);
  const remainingMs = expiresAt - now;
  return { expiresAt, remainingMs, expired: remainingMs <= 0 };
};

/** Minutes, rounded up: "3 min" is still time to act, and "0 min" reads as already gone. */
export const minutesLeft = (remainingMs: number): number => Math.max(0, Math.ceil(remainingMs / 60_000));

/**
 * The countdown, as a person would say it: "expiring in 80 min", "expiring in 1 min", "expiring now".
 *
 * Deliberately not a clock time. An absolute "expires at 00:40" makes the reader do the subtraction,
 * and the number that matters is how long they have to decide.
 */
export const expiryLabel = (remainingMs: number): string => {
  if (remainingMs <= 0) return 'expiring now';
  const minutes = minutesLeft(remainingMs);
  // Under a minute still has to read as *nearly gone* rather than as "0 min".
  return minutes < 1 ? 'expiring in under a minute' : `expiring in ${minutes} min`;
};

/** The session-level countdown: the earliest deadline among its programs, which is the one that acts. */
export const soonestExpiry = (
  expiries: readonly ProcessExpiry[]
): ProcessExpiry | null =>
  expiries.length === 0
    ? null
    : expiries.reduce((soonest, entry) => (entry.expiresAt < soonest.expiresAt ? entry : soonest));

/**
 * What to stop right now.
 *
 * Takes the pids still present and each one's expiry, and answers the pids past their deadline —
 * everything else is left alone. Written as one pass over "what is running" rather than as a timer
 * per process so that a window that was closed for an hour is simply a tick that finds more due.
 */
export const reapDue = (
  running: readonly { pid: number; expiry: ProcessExpiry }[]
): number[] => running.filter((entry) => entry.expiry.expired).map((entry) => entry.pid);

/** One line for the expiry's own tooltip: the deadline, not the countdown. */
export const deadlineTitle = (expiresAt: number, now: number = Date.now()): string => {
  const at = new Date(expiresAt);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((expiresAt - now) / 86_400_000);
  // A deadline inside the day can just say the clock time; one past it has to say which day.
  if (days >= 1) return `Ember stops this at ${time} on ${at.toLocaleDateString(undefined, { weekday: 'short' })}`;
  return `Ember stops this at ${time}`;
};

/** One session's leftovers, as the reaper sees them each tick. */
export type ReapCandidate = {
  instanceId: string;
  sessionId: string;
  /** Total extra time granted by the clock button for this session. */
  extensionMs: number;
  processes: readonly { pid: number; startedAt: number }[];
};

/** A session with programs past their deadline: what to stop, and where. */
export type ReapPlan = {
  instanceId: string;
  sessionId: string;
  pids: number[];
};

/**
 * Which sessions have anything due, and which pids.
 *
 * Sessions with nothing due are absent from the answer rather than present with an empty list, so a
 * caller can tell "nothing to do" from "nothing left" without a second pass.
 */
export const planReaping = (
  candidates: readonly ReapCandidate[],
  now: number = Date.now()
): ReapPlan[] =>
  candidates.flatMap((candidate) => {
    const pids = candidate.processes
      .filter((process) => processExpiry(process.startedAt, now, candidate.extensionMs).expired)
      .map((process) => process.pid);
    return pids.length === 0
      ? []
      : [{ instanceId: candidate.instanceId, sessionId: candidate.sessionId, pids }];
  });

/**
 * How long until the next deadline anywhere, or `null` when nothing is waiting.
 *
 * Used to wake the reaper on time rather than on a fixed poll: ninety minutes of a five-second timer
 * is a thousand wake-ups that each do nothing, and the one that matters can be scheduled exactly.
 * Capped so a clock that drifts (or a machine that sleeps) still checks in reasonably soon.
 */
export const msUntilNextDeadline = (
  candidates: readonly ReapCandidate[],
  now: number = Date.now(),
  capMs = 60_000
): number | null => {
  const deadlines = candidates.flatMap((candidate) =>
    candidate.processes.map(
      (process) =>
        process.startedAt + PROCESS_LIFETIME_MS + Math.max(0, candidate.extensionMs) - now
    )
  );
  if (deadlines.length === 0) return null;
  const soonest = Math.min(...deadlines);
  // Already overdue: check as soon as the caller allows, since the tick that stops it is due now.
  return Math.max(0, Math.min(soonest, capMs));
};

/**
 * How a session's extension is filed: `instanceId::id`.
 *
 * The instance is part of the key because two hosts can hand out the same conversation id, and an
 * extension granted on one must not shorten a deadline on the other.
 */
export const processKey = (session: { instanceId: string; id: string }): string =>
  `${session.instanceId}::${session.id}`;

/**
 * How long to wait before retrying a reap that did not land.
 *
 * An overdue program stays overdue until a stop succeeds, so "check again in half a second" becomes
 * two requests a second for as long as a host is asleep. The ladder starts at two seconds and
 * doubles, capped at half a minute: long enough to leave a sleeping machine alone, short enough that
 * one which comes back is dealt with promptly.
 */
export const reapRetryDelay = (attempt: number): number =>
  Math.min(30_000, 2_000 * 2 ** (Math.max(1, attempt) - 1));
