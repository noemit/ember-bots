import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The trays that live above the composer. One shelf, one open at a time. */
export type ShelfSectionId = 'queue' | 'notes' | 'crew' | 'processes';

export type ShelfSection = {
  id: ShelfSectionId;
  /** What the tab says: "Queue", "For later", "Crew", "Processes". */
  label: string;
  count: number;
  /** Optional compact status in place of the total. */
  summary?: string;
  /** Something in here is waiting on the human (a worker needing input, a failed row). */
  alert?: boolean;
  /** The rows, rendered only while this section is the open one. */
  content: React.ReactNode;
};

/**
 * What clicking a tab does.
 *
 * A tab is two things at once: "show me this tray" and "put this tray away". So a click on the
 * selected tab folds the shelf, exactly as the chevron beside it would — opening a tray and deciding
 * against it costs one click, not a reach for a different control. A click on any other tab opens the
 * shelf on that tray.
 */
export const nextShelfState = (input: {
  open: boolean;
  selected: boolean;
  id: ShelfSectionId;
}): { open: boolean; active: ShelfSectionId | null } => {
  if (input.selected) {
    // Fold if it is open, re-open the same tray if it is not: the tab never becomes a no-op.
    return { open: !input.open, active: input.open ? null : input.id };
  }
  return { open: true, active: input.id };
};

type Props = {
  sections: ShelfSection[];
  active: ShelfSectionId | null;
  onActiveChange: (id: ShelfSectionId) => void;
  /** False folds the shelf to its tab line; the choice belongs to the person, not to a timer. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The shelf above the composer: one line of tabs, one section open under it.
 *
 * Three separate cards used to stack here — a queue card with per-row "Queue:" prefixes, a notes
 * card saying "For Later:" on every row, and a bordered strip of bordered chips for the crew. That
 * is a border, a heading and often a second line for each thing, in the tallest part of the window.
 * Here they share one header: each tray is a tab with its count, the open one shows its rows, and
 * folding the shelf costs exactly one line no matter how much is in it.
 *
 * A section with nothing in it has no tab: an empty "Queue 0" is a heading that only says "nothing
 * here". If the open section empties, the shelf falls back to the first one that still has rows.
 */
/** Arrow keys move focus, never the reader's selected tray or fold state. */
export const shelfFocusIndex = (key: string, index: number, count: number): number | null => {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  return null;
};

const ComposerShelf = ({ sections, active, onActiveChange, open, onOpenChange }: Props) => {
  const id = React.useId();
  const tabs = React.useRef<HTMLDivElement>(null);
  const [focused, setFocused] = React.useState<ShelfSectionId | null>(null);
  const filled = sections.filter((section) => section.count > 0);
  if (filled.length === 0) return null;
  const current = filled.find((section) => section.id === active) ?? filled[0];
  const focusId = filled.some((section) => section.id === focused) ? focused : current.id;
  const toggleLabel = open ? 'Fold the composer trays' : 'Show the composer trays';

  return (
    <div role="group" aria-label="Composer trays" className="flex min-w-0 flex-col">
      <div
        className="flex min-w-0 items-stretch"
        onClick={(event) => {
          // Buttons own their gestures; only unoccupied bar space toggles the current tray.
          if (!(event.target as HTMLElement).closest('button')) onOpenChange(!open);
        }}
      >
        <div ref={tabs} className="flex min-w-0 shrink items-center overflow-x-auto" role="tablist" aria-label="Composer trays">
          {filled.map((section, index) => {
            const selected = section.id === current.id;
            return (
              <button
                key={section.id}
                id={`${id}-tab-${section.id}`}
                type="button"
                role="tab"
                tabIndex={section.id === focusId ? 0 : -1}
                aria-selected={selected}
                aria-controls={`${id}-panel-${section.id}`}
                aria-expanded={selected ? open : undefined}
                onFocus={() => setFocused(section.id)}
                onKeyDown={(event) => {
                  const next = shelfFocusIndex(event.key, index, filled.length);
                  if (next === null) return;
                  event.preventDefault();
                  tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
                onClick={() => {
                  const next = nextShelfState({ open, selected, id: section.id });
                  if (next.open !== open) onOpenChange(next.open);
                  if (next.active !== null) onActiveChange(next.active);
                }}
                className={cn(
                  'relative flex min-h-8 flex-none items-center gap-1.5 px-2 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selected
                    ? 'font-semibold text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-foreground/65'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {section.label}
                <span className="text-[10.5px] font-normal tabular-nums text-muted-foreground">{section.summary ?? section.count}</span>
                {section.alert ? <span aria-hidden="true" className="size-1.5 rounded-full bg-highlight" /> : null}
                {section.alert ? <span className="sr-only">needs your attention</span> : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          data-shelf-toggle="space"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={`${id}-panel-${current.id}`}
          aria-label={open ? 'Fold trays using the tab bar' : 'Show trays using the tab bar'}
          title={toggleLabel}
          className="min-w-3 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={`${id}-panel-${current.id}`}
          aria-label={toggleLabel}
          title={open ? 'Fold these away (nothing is lost)' : 'Show the trays above the composer'}
          className="flex w-8 flex-none items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
      </div>
      {filled.map((section) => (
        <div
          key={section.id}
          id={`${id}-panel-${section.id}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${section.id}`}
          hidden={!open || section.id !== current.id}
          tabIndex={0}
          className="min-w-0 pt-1 pb-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {open && section.id === current.id ? section.content : null}
        </div>
      ))}
    </div>
  );
};

export default React.memo(ComposerShelf);
