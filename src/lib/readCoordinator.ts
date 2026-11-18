type Mode = 'tail' | 'full';

type Run = { mode: Mode; task: () => Promise<void> };

type Waiting = {
  /** The run to start next, and the mode it will be admitted as. */
  run: Run;
  /** The promise every caller that queued this run awaits; settles with that run's own outcome. */
  join: Promise<void>;
  /** Links `join` to the queued flight's caller promise once that flight starts. */
  settle: (outcome: Promise<void>) => void;
  /** For joiners whose mode the running read already covers, waiting only for the queue to clear. */
  tailJoin?: Promise<void>;
};

type Flight = {
  /** The mode the run in progress was admitted as. */
  mode: Mode;
  /** The promise the caller that started the run in progress holds (it does reject). */
  caller: Promise<void>;
  /** The one run waiting behind the run in progress. */
  next?: Waiting;
};

/**
 * One in-flight read per key, plus at most one follow-up.
 *
 * Without `afterCurrent`, a request joins what is already in flight: a `tail` joins anything, a
 * `full` joins a `full`. Re-reading what is already being read is the duplicate work this exists
 * to prevent. A `full` arriving during a `tail` is not the same read, so it is queued, and it runs
 * as a `full` once that tail settles — a repair is never downgraded. A second `full` while one is
 * already queued joins it: it asked for exactly that read.
 *
 * With `afterCurrent`, the caller wants a read that starts *after* the current one: a
 * post-mutation refresh, where anything read before the mutation is stale by definition. That
 * request is never swallowed, so it always queues, and it keeps its own mode — a waiting tail stays
 * a tail, a waiting full stays a full.
 *
 * Only one run ever waits, its mode only ever strengthens (a `full` asked for while the flight was
 * up is never lost to a later tail), and its task is replaced unless a `tail` meets a waiting
 * `full`: every caller's task commits the same transcript, so among equals the newest one is the
 * one worth running.
 */
export class ReadCoordinator {
  private flights = new Map<string, Flight>();

  run(key: string, mode: Mode, task: () => Promise<void>, afterCurrent = false): Promise<void> {
    const existing = this.flights.get(key);
    if (!existing) return this.begin(key, mode, task).caller;

    if (!afterCurrent && (mode === 'tail' || existing.mode === 'full' || existing.next?.run.mode === 'full')) {
      // Joiners share the running read's own promise, so callers that asked for the same read wait
      // on the same thing; a caller that joined the tail a repair was queued behind waits for the
      // repair too — "the history is current" is what both asked for.
      if (!existing.next) return existing.caller;
      return mode === 'full' && existing.next.run.mode === 'full'
        ? existing.next.join
        : (existing.next.tailJoin ??= existing.next.join.catch(() => existing.caller));
    }

    const waiting = existing.next;
    if (waiting) {
      // The newest task wins the slot, and a mode only ever strengthens: a `full` upgrades a queued
      // tail, a newer `full` replaces an older queued `full`, and a tail never weakens a queued full.
      if (mode === 'full' || waiting.run.mode === 'tail') waiting.run = { mode, task };
      return waiting.join;
    }

    let settle!: (outcome: Promise<void>) => void;
    const join = new Promise<void>((resolve, reject) => {
      settle = (outcome) => {
        outcome.then(resolve, reject);
      };
    });
    const slot: Waiting = { run: { mode, task }, join, settle };
    existing.next = slot;
    return slot.join;
  }

  /** Start one run; its caller sees the run's own outcome. */
  private begin(key: string, mode: Mode, task: () => Promise<void>): Flight {
    const flight: Flight = {
      mode,
      caller: Promise.resolve(),
    };
    this.flights.set(key, flight);
    const outcome = Promise.resolve().then(task);
    flight.caller = outcome;
    // Registered before returning `caller` so the key is handed over (or freed) before any
    // caller resuming from `await` can inspect or re-enter `this.flights`, even on rejection.
    const advance = () => {
      this.startQueued(key, flight);
    };
    outcome.then(advance, advance);
    return flight;
  }

  /** Start the run queued behind `flight`, taking the key over; releases the key when nothing waits. */
  private startQueued(key: string, flight: Flight): void {
    if (this.flights.get(key) !== flight) return;
    const next = flight.next;
    flight.next = undefined;
    if (!next) {
      this.flights.delete(key);
      return;
    }
    const successor = this.begin(key, next.run.mode, next.run.task);
    next.settle(successor.caller);
  }
}
