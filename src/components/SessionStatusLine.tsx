import type { SessionStatus } from '../lib/sessionStatus';
import { cn } from '@/lib/utils';

type Props = {
  /** Null renders nothing at all, so an idle session never reserves a row. */
  status: SessionStatus | null;
  className?: string;
};

/**
 * The per-session activity status line: one quiet, muted row under the latest message. It is a
 * polite live region, so a state change is announced once rather than on every token; the static
 * dot carries no motion, so reduced motion needs nothing special. Pointer events are off: it is
 * information, not a control, and the composer below stays usable.
 */
export default function SessionStatusLine({ status, className }: Props) {
  if (!status) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-session-status={status.kind}
      className={cn(
        'pointer-events-none flex items-center gap-2 self-start px-1 text-[11.5px] text-muted-foreground',
        className
      )}
    >
      <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-muted-foreground/45" />
      <span>{status.text}</span>
    </div>
  );
}
