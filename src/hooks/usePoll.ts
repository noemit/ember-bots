import * as React from 'react';
import { useStableCallback } from '@/lib/useStableCallback';

export type UsePollOptions = {
  /**
   * Run `task` immediately when `enabled` becomes true (defaults to `true`).
   * Pass `false` when an initial load already ran and polling is purely the periodic safety net.
   */
  immediate?: boolean;
};

export type PollSchedulerEnv = {
  now?: () => number;
  isHidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type PollController = {
  update: (intervalMs: number, enabled: boolean, immediate?: boolean) => void;
  dispose: () => void;
};

const effectiveDelayMs = (intervalMs: number, hidden: boolean): number =>
  hidden ? Math.max(intervalMs, 60_000) : intervalMs;

/**
 * Pure run-then-wait scheduler backing `usePoll`.
 *
 * Changing `intervalMs` while already enabled reschedules the next timer against elapsed wait time
 * (or lets an in-flight run adopt the new interval on completion) rather than firing an immediate
 * duplicate tick.
 */
export const createPollController = (
  run: () => Promise<void>,
  env: PollSchedulerEnv = {}
): PollController => {
  const now = env.now ?? (() => Date.now());
  const isHidden = env.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const setTimer = env.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = env.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));

  let disposed = false;
  let active = false;
  let intervalMs = 0;
  let inFlight = false;
  let generation = 0;
  let lastAnchorAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const scheduleAfter = (delayMs: number, gen: number) => {
    cancelTimer();
    timer = setTimer(() => {
      timer = undefined;
      void tick(gen);
    }, Math.max(0, delayMs));
  };

  const tick = async (gen: number): Promise<void> => {
    if (disposed || !active || gen !== generation) return;
    inFlight = true;
    try {
      await run();
    } finally {
      if (!disposed && active && gen === generation) {
        inFlight = false;
        lastAnchorAt = now();
        scheduleAfter(effectiveDelayMs(intervalMs, isHidden()), gen);
      } else if (gen === generation) {
        inFlight = false;
      }
    }
  };

  return {
    update(nextIntervalMs: number, nextEnabled: boolean, immediate = true) {
      if (disposed) return;
      intervalMs = nextIntervalMs;
      if (!nextEnabled) {
        if (active) {
          active = false;
          generation += 1;
          inFlight = false;
          cancelTimer();
        }
        return;
      }
      if (!active) {
        active = true;
        const gen = ++generation;
        if (immediate) {
          void tick(gen);
        } else {
          inFlight = false;
          lastAnchorAt = now();
          scheduleAfter(effectiveDelayMs(intervalMs, isHidden()), gen);
        }
        return;
      }
      // Already enabled: adjust the wait to the new interval without an immediate re-fire.
      if (inFlight) return;
      const targetDelay = effectiveDelayMs(intervalMs, isHidden());
      const elapsed = Math.max(0, now() - lastAnchorAt);
      scheduleAfter(Math.max(0, targetDelay - elapsed), generation);
    },
    dispose() {
      disposed = true;
      active = false;
      generation += 1;
      inFlight = false;
      cancelTimer();
    },
  };
};

/**
 * Runs `task` when enabled (immediately by default, or after `intervalMs` when `immediate` is
 * false) and then `intervalMs` after each completion so slow responses never pile up. Changing
 * `intervalMs` while enabled reschedules the remaining wait instead of firing a duplicate tick.
 */
export const usePoll = (
  task: () => Promise<void>,
  intervalMs: number,
  enabled: boolean,
  options?: UsePollOptions
): void => {
  const run = useStableCallback(task);
  const immediate = options?.immediate ?? true;
  const controllerRef = React.useRef<PollController | null>(null);

  React.useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    let controller = controllerRef.current;
    if (!controller) {
      controller = createPollController(run);
      controllerRef.current = controller;
    }
    controller.update(intervalMs, enabled, immediate);
  }, [run, intervalMs, enabled, immediate]);
};
