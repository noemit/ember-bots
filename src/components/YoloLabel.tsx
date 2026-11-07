import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The same shield and word wherever the person delegates tool approvals. */
export default function YoloLabel({ labelClassName, small = false }: { labelClassName?: string; small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide">
      <ShieldCheck aria-hidden="true" className={cn('flex-none', small ? 'size-2.5' : 'size-3.5')} />
      <span className={labelClassName}>Yolo</span>
    </span>
  );
}
