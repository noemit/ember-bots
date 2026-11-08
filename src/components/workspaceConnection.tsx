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
}>({ activeKey: null, metrics: null, report: () => {} });

/** Navigation and composing share geometry, without moving a session's input out of its column. */
export function WorkspaceConnection({ activeKey, color, children }: {
  activeKey: string | null; color: string; children: React.ReactNode;
}) {
  const desktop = React.useSyncExternalStore(subscribe, desktopSnapshot, serverSnapshot);
  const [measured, setMeasured] = React.useState<{ key: string; metrics: Metrics } | null>(null);
  const report = React.useCallback((key: string, metrics: Metrics) => {
    setMeasured(previous => previous?.key === key && previous.metrics.height === metrics.height && previous.metrics.centre === metrics.centre
      ? previous : { key, metrics });
  }, []);
  const key = desktop ? activeKey : null;
  const value = React.useMemo(() => ({ activeKey: key, metrics: measured?.key === key ? measured.metrics : null, report }), [key, measured, report]);
  return <ConnectionContext.Provider value={value}>
    <div className="contents" style={{ '--connection-agent': color } as React.CSSProperties}>{children}</div>
  </ConnectionContext.Provider>;
}
export const useWorkspaceConnection = () => React.useContext(ConnectionContext);

/** Measure the actual composer, including attachments but excluding the separate trays above it, rather than guessing its height. */
export function useComposerConnection(key: string | null) {
  const connection = useWorkspaceConnection();
  const connected = Boolean(key && key === connection.activeKey);
  const footer = React.useRef<HTMLDivElement>(null);
  const surface = React.useRef<HTMLDivElement>(null);
  const { report } = connection;
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
