import * as React from 'react';
import { entryFromEmberEvent, mergeActivity } from '@/lib/activityView';
import type { ActivityEntry, ActivityPage, EmberEvent } from '@/types';

/** How much history one fetch asks for; the panel pages older days on demand. */
const ACTIVITY_PAGE = 100;
/** Two refreshes never land closer than this; live events keep the list fresh between. */
const REFRESH_MIN_INTERVAL_MS = 15_000;

export type ActivityState = {
  entries: ActivityEntry[];
  loading: boolean;
  /** True when the first (re)fetch hasn't answered yet and there's nothing to show. */
  initialLoading: boolean;
  error: string | null;
  /** The bridge (an older remote server) can't serve history; only live entries appear. */
  historyUnavailable: boolean;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  /** Feed parsed live events; only hints carrying an activity summary do anything. */
  recordEvent: (event: EmberEvent) => void;
};

/**
 * The activity home's data: persisted history fetched through the bridge, merged with
 * live events as they arrive (no disk call on the hot path). History refreshes when the
 * panel is (re)shown or instances finish loading, so a launch that raced instance loading
 * still lands pre-launch history; `mergeActivity` de-dupes, so repeating is harmless.
 */
export function useActivity(visible: boolean, instancesLoaded: boolean): ActivityState {
  const [entries, setEntries] = React.useState<ActivityEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = React.useState(false);
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [loadingEarlier, setLoadingEarlier] = React.useState(false);
  const inFlight = React.useRef(false);
  const lastFetchAt = React.useRef(0);
  // A ref mirror so `loadEarlier` reads the freshest cursor without re-creating per page.
  const cursorRef = React.useRef<string | undefined>(undefined);
  cursorRef.current = cursor;

  const recordEvent = React.useCallback((event: EmberEvent) => {
    const entry = entryFromEmberEvent(event);
    if (!entry) return;
    setEntries((prev) => mergeActivity(prev, [entry]));
  }, []);

  const fetchPage = React.useCallback(
    (query: { limit: number; cursor?: string }): Promise<ActivityPage | null> => {
      const bridge = window.ember;
      if (!bridge.activityList) {
        setHistoryUnavailable(true);
        return Promise.resolve(null);
      }
      return bridge.activityList(query).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      });
    },
    []
  );

  // Refresh history when the panel is shown and once instances have loaded. Live events
  // append continuously, so a throttled refresh here is only about the pre-open history.
  React.useEffect(() => {
    if (!visible || !instancesLoaded) return;
    if (inFlight.current || Date.now() - lastFetchAt.current < REFRESH_MIN_INTERVAL_MS) return;
    inFlight.current = true;
    lastFetchAt.current = Date.now();
    setLoading(true);
    void fetchPage({ limit: ACTIVITY_PAGE })
      .then((page) => {
        if (!page) return;
        setError(null);
        setCursor(page.cursor);
        setEntries((prev) => mergeActivity(prev, page.entries));
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, [visible, instancesLoaded, fetchPage]);

  const loadEarlier = React.useCallback(() => {
    const current = cursorRef.current;
    if (!current || inFlight.current || loadingEarlier) return;
    setLoadingEarlier(true);
    void fetchPage({ limit: ACTIVITY_PAGE, cursor: current })
      .then((page) => {
        if (!page) return;
        setError(null);
        setCursor(page.cursor);
        setEntries((prev) => mergeActivity(prev, page.entries));
      })
      .finally(() => setLoadingEarlier(false));
  }, [fetchPage, loadingEarlier]);

  return {
    entries,
    loading,
    initialLoading: loading && entries.length === 0,
    error,
    historyUnavailable,
    canLoadEarlier: Boolean(cursor) && !loadingEarlier,
    loadingEarlier,
    loadEarlier,
    recordEvent,
  };
}
