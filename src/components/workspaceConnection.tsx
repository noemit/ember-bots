import * as React from 'react';

type Metrics = { height: number; centre: number };
const subscribe = (notify: () => void) => {
  const query = window.matchMedia('(min-width: 768px)');
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const desktopSnapshot = () => window.matchMedia('(min-width: 768px)').matches;
const serverSnapshot = () => false;
const ConnectionContext = React.createContext<{
  activeKey: string | null;
  metrics: Metrics | null;
  report: (key: string, metrics: Metrics) => void;
  setDetached: (key: string, detached: boolean) => void;
}>({ activeKey: null, metrics: null, report: () => {}, setDetached: () => {} });

/** Navigation and composing share geometry, without moving a session's input out of its column. */
export function WorkspaceConnection({ activeKey, color, children }: {
  activeKey: string | null; color: string; children: React.ReactNode;
}) {
  const desktop = React.useSyncExternalStore(subscribe, desktopSnapshot, serverSnapshot);
  const [measured, setMeasured] = React.useState<{ key: string; metrics: Metrics } | null>(null);
  const [detachedKeys, setDetachedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const report = React.useCallback((key: string, metrics: Metrics) => {
    setMeasured(previous => previous?.key === key && previous.metrics.height === metrics.height && previous.metrics.centre === metrics.centre
      ? previous : { key, metrics });
  }, []);
  const setDetached = React.useCallback((targetKey: string, detached: boolean) => {
    setDetachedKeys((previous) => {
      const has = previous.has(targetKey);
      if (has === detached) return previous;
      const next = new Set(previous);
      if (detached) next.add(targetKey);
      else next.delete(targetKey);
      return next;
    });
  }, []);
  const key = desktop && activeKey && !detachedKeys.has(activeKey) ? activeKey : null;
  const value = React.useMemo(
    () => ({ activeKey: key, metrics: measured?.key === key ? measured.metrics : null, report, setDetached }),
    [key, measured, report, setDetached]
  );
  return <ConnectionContext.Provider value={value}>
    <div className="contents" style={{ '--connection-agent': color } as React.CSSProperties}>{children}</div>
  </ConnectionContext.Provider>;
}
export const useWorkspaceConnection = () => React.useContext(ConnectionContext);

/** Measure the actual composer, including attachments but excluding the separate trays above it, rather than guessing its height. */
export function useComposerConnection(key: string | null, options?: { detached?: boolean }) {
  const connection = useWorkspaceConnection();
  const detached = Boolean(key && options?.detached);
  const connected = Boolean(key && !detached && key === connection.activeKey);
  const footer = React.useRef<HTMLDivElement>(null);
  const surface = React.useRef<HTMLDivElement>(null);
  const { report, setDetached } = connection;
  React.useLayoutEffect(() => {
    if (!key || !detached) return;
    setDetached(key, true);
    return () => setDetached(key, false);
  }, [detached, key, setDetached]);
  React.useLayoutEffect(() => {
    if (!connected || !key || !footer.current || !surface.current) return;
    let cancelled = false;
    let queued = false;
    const measure = () => {
      if (queued) return;
      queued = true;
      // Let the current commit finish before notifying sibling consumers. In particular, a
      // virtualized transcript may be measuring its own scroll position in a layout effect.
      queueMicrotask(() => {
        queued = false;
        if (cancelled || !footer.current || !surface.current) return;
        const band = footer.current;
        const input = surface.current;
        // The surface animates layout with a projection transform. ResizeObserver reports
        // its layout size only, not subsequent animation frames: reading its transformed
        // rect here would leave the dock stuck at an intermediate centre after a resize.
        // The positioned footer is the surface's offset parent; measure their layout boxes.
        report(key, { height: band.offsetHeight, centre: Math.round(band.offsetHeight - band.clientTop - input.offsetTop - input.offsetHeight / 2) });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(footer.current);
    observer.observe(surface.current);
    measure();
    return () => { cancelled = true; observer.disconnect(); };
  }, [connected, key, report]);
  return { connected, footer, surface };
}
