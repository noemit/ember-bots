import * as React from 'react';
import { X } from 'lucide-react';
import {
  observeContextRecommendation,
  shouldRecommendContextCompaction,
  shouldShowContextAdvice,
  type ContextRecommendationObservation,
  type ContextRecommendationEpisode,
} from '../lib/contextRecommendation';

type Props = ContextRecommendationObservation & {
  compacting: boolean;
  busy: boolean;
  onCompact: () => void;
};

/** Quiet advice above the input, not an alert and never an automatic history rewrite. */
export default function ContextRecommendation({ compacting, busy, onCompact, ...observation }: Props) {
  const [previous, setPrevious] = React.useState<ContextRecommendationEpisode>();
  const episode = observeContextRecommendation(previous, observation);
  // Adjust only when the pure episode policy changes (not on each poll or render). Keeping this
  // in the render avoids flashing dismissed advice before an effect processes a new snapshot.
  if (episode !== previous) setPrevious(episode);
  if (!shouldShowContextAdvice(episode, observation)) return null;
  const recommend = shouldRecommendContextCompaction(episode, observation);

  return (
    <section aria-label="Context recommendation" className="mb-2 flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="min-w-0 flex-1">
        {recommend ? (
          <p>This conversation has a lot of history. Compact can summarize older turns and keep recent messages.</p>
        ) : observation.historyTokens !== undefined ? (
          <p>Kiln reports a large context, but older messages may not be why. Compact keeps instructions and tools. You can keep working or review this chat’s instructions.</p>
        ) : (
          <p>Kiln reports a large context, including instructions and tools. Ember doesn’t yet know how much is older conversation history. You can keep working or dismiss this reminder.</p>
        )}
        {recommend && busy && !compacting ? <p className="mt-1">You can compact when the running turn finishes.</p> : null}
      </div>
      {recommend ? <button
        type="button"
        disabled={busy || compacting}
        onClick={onCompact}
        className="min-h-8 rounded px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
      >
        {compacting ? 'Compacting…' : 'Compact'}
      </button> : null}
      <button
        type="button"
        aria-label="Dismiss context recommendation"
        onClick={() => setPrevious({ ...episode, dismissed: true })}
        className="flex size-8 flex-none items-center justify-center rounded hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </section>
  );
}
