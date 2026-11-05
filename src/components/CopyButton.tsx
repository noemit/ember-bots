import * as React from 'react';
import { Check, CircleAlert, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyText } from '../lib/clipboard';

/**
 * The one copy control: a message as Markdown, and a code block's own source.
 *
 * Both are the same gesture, so both look and announce the same way — one icon, the label "Copy",
 * hidden until the row is hovered or the button is focused, a tick when it lands and a warning when
 * the browser refuses the clipboard (which happens over remote access, where there is no async
 * clipboard at all).
 *
 * `text` is a thunk because a message's Markdown is assembled on demand: building it for every
 * message in a transcript just to decide whether the button would render is the expensive half.
 */
type Props = {
  /** The text to copy, assembled only when the button is pressed. */
  text: () => string;
  /** Spoken name, when "Copy" alone is ambiguous — a code block among several. */
  label?: string;
  /** Spoken description of what landed, for the status line ("Copied as Markdown"). */
  done?: string;
  /** Hover-reveal is right for a quiet row; a code block is the only thing to press, so it stays. */
  alwaysVisible?: boolean;
  className?: string;
};

export const COPY_ICON = { idle: Copy, copied: Check, failed: CircleAlert } as const;

/**
 * The tick/warning/icon state machine, shared by every copy control so they cannot drift.
 *
 * Hidden until hover or focus is a *visual* state only: `opacity-0` still renders the button, so it
 * stays in the accessibility tree and a keyboard can reach it. `focus-visible:opacity-100` is what
 * makes that reach visible rather than a button appearing to work from nowhere.
 */
export function CopyButton({ text, label = 'Copy', done = 'Copied', alwaysVisible = false, className }: Props) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = (next: 'copied' | 'failed') => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };
  const Icon = COPY_ICON[state];
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => void copyText(text()).then((ok) => flash(ok ? 'copied' : 'failed'))}
        className={cn(
          'flex flex-none items-center gap-1 rounded p-1 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !alwaysVisible && 'sm:opacity-0 sm:group-hover/message:opacity-100',
          state === 'failed' && 'text-destructive',
          className
        )}
      >
        <Icon className="size-3" />
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? done : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  );
}

export default CopyButton;
