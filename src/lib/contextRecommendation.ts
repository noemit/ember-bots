/**
 * A conservative, advisory policy, never a compaction trigger. Recommend at 100k current
 * tokens, or 60% of a smaller selected model's window (whichever is lower). Unknown windows
 * retain the 100k ceiling. Counts must be a host's current-context snapshot, not billed usage,
 * summed turns, cache totals or crew cost. Missing/invalid snapshots never recommend.
 *
 * Dismissal lasts for the high-context episode: polling and further growth cannot re-open it.
 * Rearm only on a new session/policy/host context epoch, or an observed drop to <=80% of the
 * threshold (hysteresis avoids nagging around the boundary). Unknown counts do not rearm.
 */
export const contextRecommendationThreshold = (window: number | undefined): number =>
  window !== undefined && Number.isFinite(window) && window > 0 ? Math.min(100_000, window * 0.6) : 100_000;

export type ContextRecommendationObservation = {
  scope: string;
  tokens?: number;
  window?: number;
  epoch?: string;
};
export type ContextRecommendationEpisode = { key: string; dismissed: boolean };

export const validCurrentContext = (tokens: number | undefined): tokens is number =>
  tokens !== undefined && Number.isFinite(tokens) && tokens >= 0;

export const observeContextRecommendation = (
  previous: ContextRecommendationEpisode | undefined,
  observation: ContextRecommendationObservation
): ContextRecommendationEpisode => {
  const threshold = contextRecommendationThreshold(observation.window);
  const key = JSON.stringify([observation.scope, observation.epoch ?? '', threshold]);
  if (!previous || previous.key !== key) return { key, dismissed: false };
  if (previous.dismissed && validCurrentContext(observation.tokens) && observation.tokens <= threshold * 0.8) {
    return { key, dismissed: false };
  }
  return previous;
};

export const shouldRecommendContextCompaction = (
  episode: ContextRecommendationEpisode,
  observation: ContextRecommendationObservation
): boolean => !episode.dismissed && validCurrentContext(observation.tokens) &&
  observation.tokens >= contextRecommendationThreshold(observation.window);
