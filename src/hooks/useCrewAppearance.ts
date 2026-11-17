import * as React from 'react';
import type { BallMood } from '../types';
import { crewActivityPhase, shouldAlternateCrew } from '../lib/crewMood';

/** One coarse clock for all crew identities, never a timer per avatar or a frame loop.
 * Keep elapsed visible time across polling/rerenders and pause it while hidden/reduced.
 */
export const useCrewAppearance = (
  baseMoods: Record<string, BallMood>,
  crewKeys: ReadonlySet<string>
): Record<string, BallMood> => {
  const [seconds, setSeconds] = React.useState(0);
  const [policy, setPolicy] = React.useState(() => ({
    visible: !document.hidden,
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  React.useEffect(() => {
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
  const alternate = shouldAlternateCrew(crewKeys.size > 0, policy.visible, policy.reduced);
  React.useEffect(() => {
    if (!alternate) return;
    const timer = window.setInterval(() => setSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [alternate]);
  return React.useMemo(() => {
    const moods = { ...baseMoods };
    for (const key of crewKeys) moods[key] = policy.reduced ? 'busy' : crewActivityPhase(key, seconds);
    return moods;
  }, [baseMoods, crewKeys, seconds, policy.reduced]);
};
