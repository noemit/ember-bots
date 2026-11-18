import * as React from 'react';
import type { BallMood } from '../types';
import {
  CREW_PHASE_BUFFER_MS,
  nextCrewPhaseDelayMs,
  resolveCrewMoods,
  shouldAlternateCrew,
} from '../lib/crewMood';

const sameStringSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
};

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** One boundary-scheduled clock for all crew identities, never a 1s poll, a timer per avatar, or a frame loop.
 * Keep elapsed visible time across polling/rerenders and pause it while hidden/reduced.
 */
export const useCrewAppearance = (
  baseMoods: Record<string, BallMood>,
  crewKeys: ReadonlySet<string>
): Record<string, BallMood> => {
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const elapsedMsRef = React.useRef(0);
  const previousMoodsRef = React.useRef<Record<string, BallMood> | undefined>(undefined);
  const crewKeysRef = React.useRef<ReadonlySet<string>>(crewKeys);
  const stableCrewKeys = React.useMemo(() => {
    if (sameStringSet(crewKeysRef.current, crewKeys)) return crewKeysRef.current;
    crewKeysRef.current = crewKeys;
    return crewKeys;
  }, [crewKeys]);
  const [policy, setPolicy] = React.useState(() => ({
    visible: typeof document === 'undefined' ? true : !document.hidden,
    reduced:
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false,
  }));
  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPolicy({ visible: !document.hidden, reduced: media.matches });
    update();
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      media.removeEventListener('change', update);
    };
  }, []);
  const alternate = shouldAlternateCrew(stableCrewKeys.size > 0, policy.visible, policy.reduced);
  React.useEffect(() => {
    if (!alternate) return;
    if (elapsedMsRef.current !== elapsedMs) {
      setElapsedMs(elapsedMsRef.current);
      return;
    }
    const boundaryDelayMs = nextCrewPhaseDelayMs(stableCrewKeys, elapsedMs);
    if (boundaryDelayMs === null) return;
    const delayMs = boundaryDelayMs + CREW_PHASE_BUFFER_MS;
    const startElapsedMs = elapsedMs;
    const targetElapsedMs = startElapsedMs + delayMs;
    let startedAt: number | null = nowMs();
    const timer = window.setTimeout(() => {
      const measured = startedAt === null ? delayMs : Math.max(0, nowMs() - startedAt);
      startedAt = null;
      const next = Math.max(targetElapsedMs, Math.floor(startElapsedMs + measured));
      elapsedMsRef.current = next;
      setElapsedMs(next);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      if (startedAt !== null) {
        const measured = Math.max(0, nowMs() - startedAt);
        elapsedMsRef.current = Math.min(targetElapsedMs, Math.floor(startElapsedMs + measured));
        startedAt = null;
      }
    };
  }, [alternate, stableCrewKeys, elapsedMs]);
  return React.useMemo(() => {
    const next = resolveCrewMoods(
      baseMoods,
      stableCrewKeys,
      elapsedMs,
      policy.reduced,
      previousMoodsRef.current
    );
    previousMoodsRef.current = next;
    return next;
  }, [baseMoods, stableCrewKeys, elapsedMs, policy.reduced]);
};
