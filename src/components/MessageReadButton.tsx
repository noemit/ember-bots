import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';

/** A generous hit target around a small unread bubble; acknowledgement stays local to the message. */
export default function MessageReadButton({ unread, onRead }: { unread: boolean; onRead: () => void }) {
  const reducedMotion = useReducedMotion();
  const [confirming, setConfirming] = React.useState(false);
  // Retire the hit target even if the animation driver skips its completion callback (for
  // example after a poll rerenders the row). The visual acknowledgement is deliberately brief.
  React.useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), reducedMotion ? 350 : 750);
    return () => window.clearTimeout(timer);
  }, [confirming, reducedMotion]);
  if (!unread && !confirming) return null;

  return (
    <button
      type="button"
      aria-label={confirming ? 'Message marked as read' : 'Mark this message as read'}
      aria-disabled={confirming}
      title={confirming ? 'Marked as read' : 'Mark this message as read'}
      data-read-confirming={confirming || undefined}
      className="group/read absolute -right-3 -top-4 z-10 flex size-11 items-center justify-center rounded-full outline-none transition-colors hover:bg-highlight/10 focus-visible:bg-highlight/10 focus-visible:ring-2 focus-visible:ring-highlight"
      onClick={() => {
        if (confirming) return;
        setConfirming(true);
        onRead();
      }}
    >
      {confirming ? (
        <motion.span
          key="confirmation"
          className="flex size-5 items-center justify-center rounded-full bg-highlight text-highlight-foreground"
          initial={{ opacity: 1, scale: 1, rotate: 0, y: 0 }}
          animate={reducedMotion
            ? { opacity: [1, 1, 0] }
            : { opacity: [1, 1, 0], scale: [1, 1.15, 0.5], rotate: [0, 0, 180], y: [0, 0, -10] }}
          transition={{ duration: reducedMotion ? 0.3 : 0.7, times: [0, 0.4, 1], ease: 'easeInOut' }}
          onAnimationComplete={() => setConfirming(false)}
        >
          <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
        </motion.span>
      ) : (
        <span data-unread-dot="" className="size-2.5 rounded-full bg-highlight ring-2 ring-background transition-transform group-hover/read:scale-125 group-focus-visible/read:scale-125" />
      )}
    </button>
  );
}
