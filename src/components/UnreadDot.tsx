import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One message's unread dot: click it, it fills, then it goes.
 *
 * The mark is written on click, so the control's job afterwards is to *show what happened* rather
 * than to wait for a second confirmation. Three states in 900ms: an empty circle (there is something
 * to read), a filled check (it is marked), and nothing (the row no longer carries a mark at all —
 * which is the state the transcript draws by not rendering this).
 *
 * Hidden until the row is hovered or the button is focused, like the Copy control beside it: a
 * transcript of twenty unread messages should not read as a column of dots. `opacity-0` still keeps
 * it in the accessibility tree, so a keyboard reaches it without needing a mouse first.
 */
const UnreadDot = ({ onMark, label }: { onMark: () => void; label: string }) => {
  const [justMarked, setJustMarked] = React.useState(false);
  React.useEffect(() => {
    if (!justMarked) return;
    const timer = window.setTimeout(() => setJustMarked(false), 900);
    return () => window.clearTimeout(timer);
  }, [justMarked]);
  return (
    <button
      type="button"
      aria-label={`Mark ${label} as read`}
      title="Mark as read"
      onClick={() => {
        // Show the check before the mark lands: the parent re-renders and unmounts this control the
        // moment the message is read, and a tick nobody sees is not a confirmation.
        setJustMarked(true);
        onMark();
      }}
      className={cn(
        'flex size-3.5 items-center justify-center rounded-full border transition-[background-color,border-color,opacity,color] duration-200',
        'opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100',
        justMarked
          ? 'border-success bg-success text-background'
          : 'border-muted-foreground/50 text-transparent hover:border-highlight hover:bg-highlight/20'
      )}
    >
      <Check className="size-2.5" aria-hidden="true" />
    </button>
  );
};

export default UnreadDot;
