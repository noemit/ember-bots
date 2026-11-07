import * as React from 'react';
import { useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/** A generous hit target around a small unread bubble; acknowledgement stays local to the message. */
export default function MessageReadButton({ unread, onRead }: { unread: boolean; onRead: () => void }) {
  const reducedMotion = useReducedMotion();
  const [confirming, setConfirming] = React.useState(false);
  // Keep the check mounted for the full visual sequence while the read mark updates immediately.
  // CSS owns the motion; this timer also retires the hit target when animations are paused.
  React.useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), reducedMotion ? 650 : 1150);
    return () => window.clearTimeout(timer);
  }, [confirming, reducedMotion]);
  if (!unread && !confirming) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={confirming ? 'Message marked as read' : 'Mark this message as read'}
          aria-disabled={confirming}
          data-read-confirming={confirming || undefined}
          className="group/read absolute -right-3 -top-4 z-10 flex size-11 items-center justify-center rounded-full outline-none transition-colors hover:bg-highlight/10 focus-visible:bg-highlight/10 focus-visible:ring-2 focus-visible:ring-highlight"
          onClick={() => {
            if (confirming) return;
            setConfirming(true);
            onRead();
          }}
        >
          {confirming ? (
            <span
              className="message-read-confirmation flex size-5 items-center justify-center rounded-full bg-highlight text-highlight-foreground"
            >
              <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
            </span>
          ) : (
            <span data-unread-dot="" className="size-2.5 rounded-full bg-highlight ring-2 ring-background transition-transform group-hover/read:scale-125 group-focus-visible/read:scale-125" />
          )}
        </button>
      </TooltipTrigger>
      {!confirming ? <TooltipContent side="right" sideOffset={6}>Mark as read</TooltipContent> : null}
    </Tooltip>
  );
}
