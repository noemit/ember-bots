import * as React from 'react';
import { useStableCallback } from '@/lib/useStableCallback';
import { planReaping, msUntilNextDeadline, reapRetryDelay, type ReapCandidate } from '@/lib/processExpiry';
import type { Session } from '../types';

/** Extra time the clock button has granted, per session key (`instance::id`). */
export type Extensions = Readonly<Record<string, number>>;

/** The sessions' leftovers as candidates: only what the list actually carries, nothing invented. */
export const reapCandidates = (
  sessions: readonly Session[],
  extensions: Extensions
): ReapCandidate[] =>
  sessions
    .filter((session) => (session.processes?.items.length ?? 0) > 0)
    .map((session) => ({
      instanceId: session.instanceId,
      sessionId: session.id,
      extensionMs: extensions[sessionKey(session)] ?? 0,
      processes: (session.processes?.items ?? []).map((process) => ({
        pid: process.pid,
        startedAt: process.startedAt,
      })),
    }));

export const sessionKey = (session: { instanceId: string; id: string }): string =>
  `${session.instanceId}::${session.id}`;

type Options = {
  /** Every session Ember knows about right now. */
  sessions: readonly Session[];
  extensions: Extensions;
  /** Stop these pids in one session. The same call the tray's Stop button makes. */
  stop: (session: Session, pids: number[]) => Promise<unknown>;
  /** Off where the reaper would be surprising (a test harness, a read-only view). */
  enabled?: boolean;
};

/**
 * Stops a session's leftover programs once they reach their deadline.
 *
 * The host has no expiry of its own — a process outlives the turn that started it and sits there
 * until someone reaps it — so this is Ember's job, and it only works while Ember is running. The
 * deadline is fixed per program (`lib/processExpiry`), so a window opened an hour later simply finds
 * more of them due: the first tick after a restart reaps everything already past its time.
 *
 * Scheduled on the next deadline rather than polled. Ninety minutes of a five-second timer is a
 * thousand wake-ups that each do nothing; `msUntilNextDeadline` caps the wait so a sleeping machine
 * still checks in soon after it wakes.
 *
 * A session whose extension is pressed mid-wait restarts the timer with the new number, because the
 * dependency changes — which is the whole point of keeping the extension where the reaper can see it.
 */
export const useProcessReaper = ({ sessions, extensions, stop, enabled = true }: Options): void => {
  const run = useStableCallback(async () => {
    const now = Date.now();
    const plan = planReaping(reapCandidates(sessions, extensions), now);
    for (const entry of plan) {
      const session = sessions.find(
        (candidate) => candidate.instanceId === entry.instanceId && candidate.id === entry.sessionId
      );
      // A stop that fails is not retried here: the next tick finds the same deadline and tries
      // again, and a cost the tray already shows does not need a second error path.
      if (session) await stop(session, entry.pids).catch(() => undefined);
    }
  });

  const signature = React.useMemo(
    () =>
      reapCandidates(sessions, extensions)
        .map((candidate) => `${candidate.instanceId}::${candidate.sessionId}:${candidate.extensionMs}:${candidate.processes.map((p) => `${p.pid}@${p.startedAt}`).join('|')}`)
        .join(','),
    [sessions, extensions]
  );

  React.useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let cancelled = false;
    /** Consecutive ticks that found something overdue: the retry ladder's rung. */
    let attempts = 0;
    const tick = () => {
      if (cancelled) return;
      const candidates = reapCandidates(sessions, extensions);
      const wait = msUntilNextDeadline(candidates, Date.now());
      // Nothing is running: there is no deadline to wait for, and the signature effect re-arms
      // this the moment one appears.
      if (wait === null) return;
      if (wait === 0) {
        void run();
        // An overdue program stays overdue until a stop lands, so a fixed 500ms retry would hammer
        // a host that is asleep or refusing. Back off instead: a reap that has not worked in a
        // minute will not work in half a second, and the signature effect re-arms the timer the
        // instant the list changes (including when the stop finally succeeds).
        attempts += 1;
        timer = window.setTimeout(tick, reapRetryDelay(attempts));
        return;
      }
      attempts = 0;
      timer = window.setTimeout(tick, Math.max(500, wait));
    };
    // One pass on mount and on every change to what is running: this is what catches up after a
    // window was closed past a deadline.
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // `signature` stands for the candidates: it changes exactly when a pid, a start time or an
    // extension does, so the timer re-arms for the new soonest deadline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled, run]);
};
