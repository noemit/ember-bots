import * as React from 'react';
import { Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * How hard the model should think: a brain and the level's own word, opening a segmented row above.
 *
 * It used to be a signal-strength icon, and the bars were the problem. They mapped the model's level
 * *list* positionally onto four fixed bars, so a two-level model (`off`/`high`) and a five-level one
 * drew the same four shapes — two middles collapsed onto one icon — and a single bar could mean
 * "off", "minimal" or "the model's own default" indifferently. The meaning existed in the `title`,
 * which is exactly where an icon-only control cannot put it.
 *
 * So the word is on screen. It is the model's own name for the level (capitalised), because that is
 * what the popover lists and what the person chose; there is no second vocabulary to learn. Below the
 * container breakpoint the word drops and the brain stays — the same ladder YOLO and YEET use, in the
 * same row.
 *
 * `levels` still comes from the model, so the popover is whatever that model offers (usually three or
 * four). Nothing here assumes a count any more: that assumption is what the bars encoded.
 */
type Props = {
  levels: readonly string[];
  value: string;
  onChange: (level: string) => void;
};

/** The word for the current level: the model's own, capitalised, or the honest default. */
export const reasoningLevelWord = (levels: readonly string[], value: string): string => {
  if (!value) return 'Default';
  // A stored value the model no longer lists still names itself rather than reading as "Default".
  const match = levels.find((level) => level.toLowerCase() === value.toLowerCase()) ?? value;
  return match.charAt(0).toUpperCase() + match.slice(1);
};

export default function ReasoningLevelPicker({ levels, value, onChange }: Props) {
  const [open, setOpen] = React.useState(false);
  const word = reasoningLevelWord(levels, value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Reasoning level: ${word}`}
          title={`Reasoning level: ${word}`}
          className={cn('h-7 flex-none gap-1 px-1.5 text-xs', !value && 'text-muted-foreground')}
        >
          <Brain className="size-3.5 flex-none" aria-hidden="true" />
          {/* The word needs ~40px of a narrow column; below that the brain alone still says what
              the control is, and the tooltip and label carry which level. */}
          <span className="hidden @[460px]:inline">{word}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-auto p-1">
        <div role="radiogroup" aria-label="Reasoning level" className="flex items-center gap-0.5">
          <button
            type="button"
            role="radio"
            aria-checked={value === ''}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className={cn(
              'rounded px-2 py-1 text-[11px] transition-colors',
              value === ''
                ? 'bg-highlight/15 text-highlight'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            Default
          </button>
          {levels.map((level) => {
            const selected = level === value;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  onChange(selected ? '' : level);
                  setOpen(false);
                }}
                className={cn(
                  'rounded px-2 py-1 text-[11px] capitalize transition-colors',
                  selected
                    ? 'bg-highlight/15 text-highlight'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {level}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
