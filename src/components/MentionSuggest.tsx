import * as React from 'react';
import { cn } from '@/lib/utils';

type Props = {
  /** Names to offer, best match first. Empty hides the popup entirely. */
  names: readonly string[];
  /** Which row is highlighted, owned by the composer so its keydown can drive it. */
  activeIndex: number;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
};

/**
 * The `@` suggestion list.
 *
 * Rendered above the textarea inside the composer, not anchored to the caret: caret measurement in a
 * resizing textarea is fiddly and the height moves, whereas the composer already knows where its own
 * edges are. Pointer events are enabled here (unlike the status line) because picking a name with the
 * mouse is the obvious thing to try.
 *
 * Rows are `option`s in a `listbox` with `aria-activedescendant` handled by the composer, so a screen
 * reader announces the highlighted name as the arrow keys move it.
 */
export default function MentionSuggest({ names, activeIndex, onPick, onHover }: Props) {
  if (names.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Mention an agent"
      className="mx-2 mb-1 overflow-hidden rounded-lg border bg-popover shadow-md"
    >
      <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        Tag an agent
      </div>
      <ul className="max-h-[180px] overflow-y-auto pb-1">
        {names.map((name, index) => (
          <li key={name}>
            <button
              type="button"
              id={`mention-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              // `onMouseDown` rather than `onClick`: the textarea would blur first and the caret
              // position the mention needs would already be gone.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(name);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                'flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[12.5px]',
                index === activeIndex ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              )}
            >
              <span className="truncate">{name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
