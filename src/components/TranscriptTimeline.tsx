import * as React from 'react';
import { cn } from '@/lib/utils';
import type { TimelineTick } from '@/lib/transcriptTimeline';

type Props = {
  ticks: TimelineTick[];
  /** Total visible messages, so a tick's vertical position matches its place in the transcript. */
  total: number;
  /** The message the reader is currently parked on, if any. */
  activeIndex: number | null;
  onJump: (index: number) => void;
};

const KIND_CLASS: Record<TimelineTick['kind'], string> = {
  turn: 'bg-muted-foreground/60',
  tool: 'bg-muted-foreground/85',
  failure: 'bg-destructive',
  live: 'bg-highlight animate-pulse',
};

const KIND_HEIGHT: Record<TimelineTick['kind'], string> = {
  turn: 'h-3',
  tool: 'h-2',
  failure: 'h-4',
  live: 'h-3',
};

/**
 * The whisper timeline: a thin scrub rail down the transcript's edge. Marks are positioned by their
 * message index, so the rail reads top-to-bottom as the conversation did; clicking one jumps there
 * (the same `jumpToIndex` the find bar uses). Each mark is a full-height button with a small bar
 * inside, so the hit target is comfortable without the rail looking heavy.
 */
const TranscriptTimeline = React.memo(function TranscriptTimeline({ ticks, total, activeIndex, onJump }: Props) {
  if (ticks.length === 0) return null;
  const span = Math.max(1, total - 1);
  return (
    <nav
      aria-label="Conversation activity"
      className="absolute inset-y-2 right-0 z-10 flex w-5 flex-col items-center rounded-full py-1 transition-colors hover:bg-muted/40 focus-within:bg-muted/40"
    >
      <div className="relative h-full w-full">
        {ticks.map((tick) => {
          const percent = (tick.index / span) * 100;
          const active = activeIndex === tick.index;
          return (
            <button
              key={tick.index}
              type="button"
              onClick={() => onJump(tick.index)}
              title={tick.summary}
              aria-label={`Jump to ${tick.summary}`}
              aria-current={active ? 'true' : undefined}
              className="group absolute left-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-ring"
              style={{ top: `calc(${percent}% + ${percent > 96 ? -6 : percent < 4 ? 6 : 0}px)` }}
            >
              <span
                className={cn(
                  'w-[3px] rounded-full transition-all group-hover:w-1.5 group-hover:opacity-100',
                  KIND_HEIGHT[tick.kind],
                  KIND_CLASS[tick.kind],
                  active ? 'w-1.5 opacity-100' : 'opacity-80'
                )}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
});

export default TranscriptTimeline;
