import { CircleDashed, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { contextMeterLabel, contextMeterTooltip, type ContextMeterState } from '@/lib/contextMeter';

type Props = {
  /** What the meter can honestly say — see `contextMeterState`. */
  state: ContextMeterState;
  compacting: boolean;
  turnBusy?: boolean;
  onCompact: () => void;
};

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The composer's context-usage ring. Hovering explains the count; clicking asks the instance to
 * compact the session (`POST /api/session/:id/compact`), which summarizes older turns and keeps a
 * recent tail per the instance's `compaction` config.
 *
 * When the ratio isn't measurable — the last turn ran on a different model than the composer is set
 * to, or either number is missing — it draws a dashed, empty ring instead of a percentage, and the
 * tooltip says which fact is missing. The button still compacts: a manual compaction never depended
 * on the ratio. `state.kind === 'none'` (no completed turn yet) is the caller's cue to render
 * nothing at all.
 */
export default function ContextMeter({ state, compacting, turnBusy = false, onCompact }: Props) {
  const known = state.kind === 'known' ? state : null;
  const percent = known ? Math.min(999, known.percent) : 0;
  const tone = !known
    ? 'text-muted-foreground/80'
    : percent >= 90
      ? 'text-destructive'
      : percent >= 70
        ? 'text-warning'
        : 'text-muted-foreground';

  const tooltip = compacting
    ? 'Compacting context…'
    : turnBusy
      ? `${contextMeterTooltip(state)} (wait for the running turn to finish)`
      : contextMeterTooltip(state);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCompact}
          disabled={compacting || turnBusy}
          aria-label={compacting ? 'Compacting context…' : contextMeterLabel(state)}
          data-context-meter={known ? 'known' : 'unknown'}
          className={cn(
            'flex size-7 flex-none items-center justify-center rounded-full transition-colors hover:bg-muted disabled:opacity-50',
            tone
          )}
        >
          {compacting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : known ? (
            <svg viewBox="0 0 18 18" className="size-4" aria-hidden="true">
              <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
              <circle
                cx="9"
                cy="9"
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                transform="rotate(-90 9 9)"
              />
            </svg>
          ) : (
            // A ring with no arc: the shape still reads as "the context meter", and its emptiness
            // says "no ratio" rather than the 0% a full ring at zero would claim.
            <CircleDashed className="size-4" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
