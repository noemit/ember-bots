import { contextBridge, ipcRenderer } from 'electron';
import type { EmberSettings, LocalHarnessToken } from './transport';

type ApiResponse = { ok: boolean; status: number; data: unknown };

const ember = {
  // Ember Canary when EMBER_DATA_DIR gives this build its own config root (see main.ts).
  appName: process.env.EMBER_DATA_DIR && process.env.EMBER_DATA_DIR.trim() ? 'Ember Canary' : 'Ember',
  getModelStats: () => ipcRenderer.invoke('ember:models:stats'),
  observeModels: (observations: unknown) => ipcRenderer.invoke('ember:models:observe', observations),
  clearModelStats: () => ipcRenderer.invoke('ember:models:clear'),
  activityList: (query: unknown) => ipcRenderer.invoke('ember:activity:list', query),
  activitySearch: (query: unknown, range: unknown) => ipcRenderer.invoke('ember:activity:search', query, range),
  activityDays: () => ipcRenderer.invoke('ember:activity:days'),
  activityClear: () => ipcRenderer.invoke('ember:activity:clear'),
  // The Dock on macOS, the window (taskbar) icon everywhere else; both go through `setAppIcon`.
  capabilities: { dockIcon: process.platform === 'darwin', appIcon: true },
  listInstances: (refresh = true): Promise<unknown> => ipcRenderer.invoke('ember:instances', refresh),
  getSettings: (): Promise<EmberSettings> => ipcRenderer.invoke('ember:settings:get'),
  /**
   * The token this app's own harness answers to. `rotate: true` installs a fresh one and restarts the
   * harness; main refuses both on a harness Ember did not start, and refuses everything when the
   * sender is the remotely served page rather than the app's own window.
   */
  testPiEndpoint: (draft: unknown) => ipcRenderer.invoke('ember:pi:test', draft),
  kilnSharing: (action: 'inspect' | 'enable' | 'disable') => ipcRenderer.invoke('ember:kiln:sharing', action),
  kilnSharingDetails: () => ipcRenderer.invoke('ember:kiln:sharing-details'),
  retryLocalHarness: (): Promise<unknown> => ipcRenderer.invoke('ember:local-harness-retry'),
  localHarnessToken: (options?: { rotate?: boolean }): Promise<LocalHarnessToken> =>
    ipcRenderer.invoke('ember:local-harness-token', options ?? {}),
  setSettings: (patch: Partial<EmberSettings>): Promise<EmberSettings> =>
    ipcRenderer.invoke('ember:settings:set', patch),
  openExternal: (target: string): Promise<boolean> => ipcRenderer.invoke('ember:open', { target }),
  appVersion: (): Promise<string> => ipcRenderer.invoke('ember:app-version'),
  checkForUpdate: (): Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion: string | null;
    releaseUrl: string;
  }> => ipcRenderer.invoke('ember:check-update'),
  setAppIcon: (dataUrl: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('ember:app-icon', { dataUrl }),
  /** Carry a pre-IPC icon failure into the same log the handler writes. */
  reportAppIconIssue: (reason: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ember:app-icon-report', { reason }),
  /** One formatted line into `ember-compact.log` (see `src/lib/compaction.ts`). */
  reportCompaction: (line: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ember:compact-log', { line }),
  request: (
    instanceId: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse> => ipcRenderer.invoke('ember:api', { instanceId, method, path, body }),
  /** Proxied request to a Hearth endpoint (`piEndpoints` in settings). */
  piRequest: <T,>(
    endpointId: string,
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<{ ok: boolean; status: number; data: T }> =>
    ipcRenderer.invoke('ember:pi:request', { endpointId, path, method: init?.method, body: init?.body }),
  /** Invalidation hints from the instances' event streams; the renderer refetches over REST. */
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('ember:event', handler);
    return () => ipcRenderer.removeListener('ember:event', handler);
  },
  eventStatus: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('ember:events:status'),
};

contextBridge.exposeInMainWorld('ember', ember);
