import * as React from 'react';
import type { FollowUp } from '@/lib/followUps';

type Props = {
  chips: FollowUp[];
  /** A click sends the chip's prompt rather than filling the composer: a chip is an answer. */
  onSend: (text: string) => void;
  disabled?: boolean;
};

/**
 * The next move, one click away, under the last turn. Derived heuristically from what that turn did
 * (see lib/followUps.ts), so a chip can be unhelpful but never expensive: clicking one sends the
 * prompt it carries.
 */
const FollowUpChips = React.memo(function FollowUpChips({ chips, onSend, disabled = false }: Props) {
  if (chips.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Suggested follow-ups"
      className="flex flex-wrap items-center gap-1.5 px-0.5"
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Next
      </span>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          disabled={disabled}
          onClick={() => onSend(chip.text)}
          title={chip.text}
          className="rounded-full border bg-card px-2.5 py-1 text-[11.5px] text-foreground transition-colors hover:border-highlight/50 hover:bg-highlight/10 disabled:pointer-events-none disabled:opacity-50"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
});

export default FollowUpChips;
