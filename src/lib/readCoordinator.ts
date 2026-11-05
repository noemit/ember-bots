type Mode = 'tail' | 'full';

type Run = { mode: Mode; task: () => Promise<void> };

type Waiting = {
  /** The run to start next, and the mode it will be admitted as. */
  run: Run;
  /** The promise every caller that queued this run awaits. */
  join: Promise<void>;
  /** The same promise, for callers that joined the running read as a tail. */
  tailJoin?: Promise<void>;
};

type Flight = {
  /** The mode the run in progress was admitted as. */
  mode: Mode;
  /** Settles when the run in progress settles; never rejects (a failed read must not wedge a key). */
  promise: Promise<void>;
  /** The run in progress plus whatever ends up queued behind it; what a joining caller awaits. */
  settled: Promise<void>;
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
 * up is never lost to a later tail), and its task is replaced only by another `full`: every caller's
 * task commits the same transcript, so among equals the newest one is the one worth running.
 */
export class ReadCoordinator {
  private flights = new Map<string, Flight>();

  run(key: string, mode: Mode, task: () => Promise<void>, afterCurrent = false): Promise<void> {
    const existing = this.flights.get(key);
    if (!existing) return this.begin(key, mode, task).caller;

    if (!afterCurrent && (mode === 'tail' || existing.mode === 'full')) {
      // Joiners share the running read's own promise, so callers that asked for the same read wait
      // on the same thing; a caller that joined the tail a repair was queued behind waits for the
      // repair too — "the history is current" is what both asked for.
      if (!existing.next) return existing.caller;
      return mode === 'tail' ? (existing.next.tailJoin ??= existing.next.join) : existing.next.join;
    }

    const waiting = existing.next;
    if (waiting) {
      // The newest task wins the slot, and a mode only ever strengthens: a `full` upgrades a queued
      // tail, and a tail can never weaken a queued full.
      if (mode === 'full' && waiting.run.mode !== 'full') waiting.run = { mode: 'full', task };
      return waiting.join;
    }

    const slot: Waiting = { run: { mode, task }, join: Promise.resolve() };
    existing.next = slot;
    slot.join = existing.settled.then(() => {
      // Whatever is queued when the running read finishes is what starts; this is the newest of it,
      // unless a later `full` replaced it. Its rejection is not this caller's to observe: a queued
      // refresh that fails must not throw into whoever happened to be waiting on the slot.
      return this.startQueued(key, existing).catch(() => {});
    });
    return slot.join;
  }

  /** Start one run; its caller sees the run's own outcome. */
  private begin(key: string, mode: Mode, task: () => Promise<void>): Flight {
    const flight = {
      mode,
      promise: Promise.resolve(),
      settled: Promise.resolve(),
      caller: Promise.resolve(),
    } as Flight;
    this.flights.set(key, flight);
    const outcome = Promise.resolve().then(task);
    flight.caller = outcome;
    flight.promise = outcome
      .catch(() => {})
      .finally(() => {
        // The run is over: whoever stayed on this flight (a joiner) sees the key free once the
        // follow-up below, if any, has started as the key's new owner.
        void this.startQueued(key, flight).catch(() => {});
      });
    // A joining caller waits for the drain too: when this settles, whatever was queued behind the
    // run has started (and the queued caller's own promise covers it finishing).
    flight.settled = flight.promise.then(() => undefined);
    return flight;
  }

  /** Start the run queued behind `flight`, taking the key over; a no-op when nothing is queued. */
  private startQueued(key: string, flight: Flight): Promise<void> {
    // A successor may already have taken over (it releases this flight's entry before installing its
    // own), in which case there is nothing left for this call to do.
    if (this.flights.get(key) !== flight) return Promise.resolve();
    const next = flight.next;
    if (!next) {
      this.release(key, flight);
      return Promise.resolve();
    }
    flight.next = undefined;
    this.release(key, flight);
    return this.begin(key, next.run.mode, next.run.task).promise;
  }

  private release(key: string, flight: Flight): void {
    if (this.flights.get(key) === flight) this.flights.delete(key);
  }
}
