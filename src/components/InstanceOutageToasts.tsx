import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { outageCopy, type SilentInstance } from '@/lib/instanceHealth';

/** Window-owned, persistent notices. Below modal layers; only the notices intercept pointers. */
export function InstanceOutageToasts({ entries, retrying, protectDecisions = false, onRetry, onDismiss, onSettings }: {
  entries: readonly SilentInstance[];
  retrying: boolean;
  /** Leave decision controls a clear workspace rather than overlaying them. */
  protectDecisions?: boolean;
  onRetry: () => void;
  onDismiss: (entry: SilentInstance) => void;
  onSettings: () => void;
}) {
  const stack = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const visible = entries.length > 0;
  useLayoutEffect(() => {
    const element = stack.current;
    if (!element || !protectDecisions) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, protectDecisions]);
  return (
    <>
    {protectDecisions && visible && <div aria-hidden="true" className="shrink-0" style={{ height: height + 16 }} />}
    <section
      aria-label="Connection notices"
      className="pointer-events-none fixed z-40 flex flex-col gap-2"
      style={{
        top: 'calc(3.25rem + env(safe-area-inset-top, 0px))',
        right: 'max(0.75rem, env(safe-area-inset-right, 0px))',
        width: 'min(24rem, calc(100vw - 1.5rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))',
      }}
    >
      {/* A stable, text-only live region: polling and Retry spinners do not re-announce controls. */}
      <span className="sr-only" role="status" aria-atomic="true">
        {entries.map(entry => entry.label + ': ' + outageCopy(entry).status + '.').join(' ')}
      </span>
      {entries.length > 0 && (
        <div ref={stack} className="pointer-events-auto max-h-[min(40dvh,24rem)] space-y-2 overflow-y-auto overscroll-contain rounded-xl" tabIndex={0} aria-label="Connection warnings">
          {entries.map(entry => {
            const copy = outageCopy(entry);
            return (
              <article key={entry.instanceId} data-testid="instance-outage-toast" className="rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
                <h2 className="break-words text-sm font-medium">{entry.label} · {copy.status}</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.detail}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {copy.retryable ? <>
                    <Button className="min-h-11" size="sm" variant="outline" disabled={retrying} onClick={onRetry} aria-label={'Retry ' + entry.label}>{retrying ? 'Checking…' : 'Retry'}</Button>
                    <Button className="min-h-11" size="sm" variant="ghost" onClick={() => onDismiss(entry)} aria-label={'Stop warning about ' + entry.label}>Dismiss</Button>
                  </> : <Button className="min-h-11" size="sm" variant="outline" onClick={onSettings} aria-label={'Connection settings for ' + entry.label}>Settings</Button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
    </>
  );
}
