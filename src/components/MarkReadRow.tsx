import * as React from 'react';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import type { ChatMessage } from '../types';
import { cn } from '@/lib/utils';

/**
 * The "Mark as read" row under one unread message.
 *
 * It replaced a dot in the message's left margin, and the reason is worth writing down: the margin
 * sits **outside** the transcript's scroll area. On a narrow window the row's padding is the only
 * thing between the text and the viewport edge, so the dot was clipped to a sliver — and on a wide one
 * it was a 14px target a hand has to hunt for. A control nobody can press is not a control.
 *
 * So it is a button in the flow, under the message, where reading ends — which is also where the
 * decision happens. Three things follow:
 *
 * - **It shows on hover or focus**, like the Copy control in the gutter. Twenty unread messages
 *   should not paint twenty buttons over the conversation; `opacity-0` keeps this one in the
 *   accessibility tree, so a keyboard reaches it without a mouse. On a coarse pointer (a touch
 *   screen) there is nothing to hover with, so it is simply visible.
 * - **It confirms by turning into a tick** rather than vanishing on the click. The mark is written
 *   immediately; a control that disappears in the same frame reads as a misclick.
 * - **Then it leaves and the transcript closes the gap.** The parent keeps this row inside
 *   `AnimatePresence` with an animated height, so the messages below slide up over ~180ms instead of
 *   jumping. The parent also runs no `layout` animation, so nothing *else* on the page moves.
 *
 * A message marked somewhere else (Home, another column) is not animating anything into existence
 * here: `unread` goes false and the row leaves the same way.
 */
const MarkReadRow = ({
  message,
  onMark,
}: {
  message: ChatMessage;
  onMark: (message: ChatMessage) => void;
}) => {
  const [justMarked, setJustMarked] = React.useState(false);
  const reduceMotion = usePrefersReducedMotion();

  return (
    <motion.div
      initial={false}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.25, 0.8, 0.35, 1] }}
      className="overflow-hidden"
    >
      <div className="flex pt-0.5">
        <button
          type="button"
          aria-label="Mark this message as read"
          title="Mark as read"
          disabled={justMarked}
          onClick={() => {
            // Show the tick before the mark lands: the parent re-renders and the row retires the
            // moment the message is read, and a confirmation nobody sees is not a confirmation.
            setJustMarked(true);
            onMark(message);
          }}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-[11px] transition-[opacity,background-color,border-color,color] duration-150',
            'text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground',
            justMarked
              ? 'text-success opacity-100'
              : 'opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'
          )}
        >
          {justMarked ? <Check className="size-3" aria-hidden="true" /> : null}
          {justMarked ? 'Marked as read' : 'Mark as read'}
        </button>
      </div>
    </motion.div>
  );
};

/** Read once per mount and kept live: the row exists for a message, not for a session. */
const usePrefersReducedMotion = (): boolean => {
  const [reduce, setReduce] = React.useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = () => setReduce(query.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return reduce;
};

export default React.memo(MarkReadRow);
