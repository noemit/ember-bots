import { SquareTerminal } from 'lucide-react';
import type { Session } from '../types';
import { cn } from '@/lib/utils';

/** A factual hint on a chat's identity; process controls stay in that chat's composer shelf. */
export default function ProcessIndicator({ session, overlay = false }: { session: Session; overlay?: boolean }) {
  const count = session.processes?.count ?? 0;
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? 'process' : 'processes'} running — open this chat to manage`;
  return (
    <span data-testid="rail-process-indicator" role="img" aria-label={label} title={label}
      className={cn('inline-flex flex-none items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground', overlay && 'absolute -right-1 -bottom-1 border border-background shadow-sm')}>
      <SquareTerminal className="size-3" aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
    </span>
  );
}
