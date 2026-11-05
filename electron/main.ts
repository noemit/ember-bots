import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, powerMonitor, shell } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  discoverLocalPiEndpoint,
  isLocalHttpUrl,
  localInstanceUrl,
  normalizeApiMethod,
  parseAvatarOverrides,
  parseColorAssignments,
  parseComposerDrafts,
  parseInstanceDefaults,
  parsePiEndpoints,
  parseSessionGroups,
  parseReadMarks,
  parseSessionNotes,
  parseStringArray,
  parseStringRecord,
  isBlobStyle,
  isReasoningDisplay,
  resolveApiUrl,
  resolveHealthUrl,
  redactRemoteSettings,
  withoutDesktopOnlySettings,
  type BlobStyle,
  type EmberSettings,
  type RemoteAccessState,
} from './transport';
import { startRemoteServer } from './remoteServer';
import { appendCompactLog } from './compactLog';
import { quarantineCorruptSettings } from './settingsFile';
import { RemoteListener, type StartOutcome } from './remoteListener';
import { EventStreamManager, type EmberEvent, type StreamStatus } from './eventStream';
import { hashRemotePassword, MAX_REMOTE_PASSWORD_LENGTH, MIN_REMOTE_PASSWORD_LENGTH, verifyRemotePassword } from './remoteAuth';
import { ModelStatsStore } from './modelStats';
import { ActivityLog, parseActivityQuery } from './activity';
import { PiClient } from './piClient';
import type { PiEndpoint } from './transport';

type StoredHost = {
  id?: string;
  label?: string;
  url?: string;
  apiUrl?: string;
  token?: string;
  clientToken?: string;
  requestHeaders?: Record<string, string>;
  relay?: unknown;
};

type StoredSshInstance = {
  id?: string;
  nickname?: string;
  host?: string;
  sshParsed?: { destination?: string };
};

type InstanceStatus = 'checking' | 'ready' | 'unreachable' | 'unsupported';

type Instance = {
  id: string;
  label: string;
  kind: 'local' | 'remote' | 'ssh' | 'relay' | 'pi';
  url?: string;
  status: InstanceStatus;
  attachable: boolean;
  /** Hearth build id (git SHA) from `/health`, for pi endpoints. */
  version?: string;
};

const DEFAULT_THEME_ID = 'stone';
const DEFAULT_BLOB_STYLE: BlobStyle = 'buddy';
const DEFAULT_SESSION_WINDOW_HOURS = 48;

/** The three widths the session list can take; anything else reads as the familiar rail. */
const isRailMode = (value: unknown): value is 'mini' | 'normal' | 'wide' =>
  value === 'mini' || value === 'normal' || value === 'wide';

/** Mirrors `isToolDisplay` in `src/lib/toolDisplay.ts`; Electron cannot import from the renderer. */
const isToolDisplay = (value: unknown): value is 'list' | 'collapsed' =>
  value === 'list' || value === 'collapsed';

const isWindowHours = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Health probes cross SSH tunnels and Tailscale links; a momentarily slow remote (e.g. right
// after the laptop wakes) shouldn't be marked unreachable on a 1.5s budget. The watchdog below
// re-probes periodically, so a wrong verdict self-heals.
const PROBE_TIMEOUT_MS = 4000;
// How often every configured instance is re-probed. Without this an instance marked
// unreachable (startup while the tunnel was down, a transient flap) stayed dead until the user
// hit the instances refresh button or restarted — its sessions silently went stale forever.
const INSTANCE_WATCHDOG_MS = 60_000;
const API_TIMEOUT_MS = 20_000;
const MAX_API_BODY_BYTES = 32 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_DOCK_ICON_BYTES = 2 * 1024 * 1024;

const openchamberSettingsPath = (): string =>
  process.env.OPENCHAMBER_DATA_DIR
    ? path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json')
    : path.join(os.homedir(), '.config', 'openchamber', 'settings.json');

/**
 * A side-by-side "canary" identity: with `EMBER_DATA_DIR` set, this build keeps its own
 * settings, model stats and activity log (and calls itself Ember Canary), so it can run
 * beside the daily Ember without the two fighting over `~/.config/ember`. The OpenChamber
 * settings are shared and read-only, which is safe; only remote access (port 57821) must not
 * be enabled on both at once — the canary starts from fresh settings, so it is off there.
 */
const emberDataDir = (): string => {
  const override = process.env.EMBER_DATA_DIR && process.env.EMBER_DATA_DIR.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.config', 'ember');
};
const canaryBuild = Boolean(process.env.EMBER_DATA_DIR && process.env.EMBER_DATA_DIR.trim());
const displayName = canaryBuild ? 'Ember Canary' : 'Ember';
app.setName(displayName);

const emberSettingsPath = (): string => path.join(emberDataDir(), 'settings.json');
const modelStats = new ModelStatsStore(path.join(emberDataDir(), 'model-stats.json'));
// The durable activity log: one JSONL file per local day, written from the event stream.
const activityLog = new ActivityLog(path.join(emberDataDir(), 'activity'));

/** The file's object, or undefined when it is missing or does not parse (not the same as empty). */
const readJsonRoot = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
};

/**
 * Set when `settings.json` existed but could not be parsed. The unreadable file is renamed, never
 * overwritten: one bad byte used to reset every setting and then the next save wrote the defaults
 * over the only copy, with nothing said. Read by the renderer so it can say what happened.
 */
let settingsRecoveredFrom: string | null = null;
/** Set when the unreadable file could not be moved aside; writes are refused rather than clobbering it. */
let settingsQuarantineFailed = false;
/** What the remote listener is actually doing; reported through the settings the renderer reads. */
let remoteListenerState: RemoteAccessState = { status: 'off', attempts: 0, changedAt: Date.now() };

/**
 * Move an unreadable settings file aside and start from defaults.
 *
 * Deliberately synchronous and best-effort: this runs on the read path, which is called several
 * times a second, so after the rename the file is missing and the whole branch is skipped.
 */
const quarantineSettingsFile = (file: string): void => {
  if (settingsRecoveredFrom) return;
  const result = quarantineCorruptSettings(file);
  if (result.ok) {
    settingsRecoveredFrom = result.movedTo;
    console.warn(`Ember settings could not be read; kept the old file at ${result.movedTo}`);
    return;
  }
  // A rename we cannot do (a lock, a read-only directory) must not resurrect the corrupt file as
  // "settings": remember the failure so the next write is refused instead of clobbering it.
  settingsRecoveredFrom = file;
  settingsQuarantineFailed = true;
  console.error('Ember could not move an unreadable settings file aside', result.error);
};

const readJson = (file: string): Record<string, unknown> => readJsonRoot(file) ?? {};

/**
 * Ember's own settings, parsed only when the file's mtime moves.
 *
 * `piEndpoints()` is consulted by every proxied request (the resolver in `PiClient.request` falls back
 * to it) and by every probe, and settings are written as they change rather than on a save button, so
 * the file is re-read often and grows: per-session composer drafts ride in it. Parsing 34 KB on the
 * main thread per call is waste at best, and it blocks the thread that answers probes.
 *
 * A file that exists but does not parse is a hiccup, not an empty configuration. Keeping the last good
 * parse is what stops one bad read from emptying the instance list — to the rail, an empty
 * `piEndpoints` means the instance is gone, and it stays gone until a reprobe.
 */
let emberSettingsCache: { mtimeMs: number; root: Record<string, unknown> } | null = null;
const readEmberSettingsFile = (): Record<string, unknown> => {
  const file = emberSettingsPath();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Missing: cached under -1, and a previous good value keeps the app configured until it lands.
  }
  if (emberSettingsCache && emberSettingsCache.mtimeMs === mtimeMs) return emberSettingsCache.root;
  const parsed = readJsonRoot(file);
  if (parsed === undefined && mtimeMs !== -1) {
    // The file exists and does not parse. Move it aside so the next save writes a fresh file and
    // the user's copy is still on disk to salvage; keep the last good parse in memory meanwhile.
    try {
      quarantineSettingsFile(file);
    } catch {
      // Keep serving the last good parse; `settingsQuarantineFailed` refuses the next write.
    }
  }
  const root = parsed ?? emberSettingsCache?.root ?? {};
  emberSettingsCache = { mtimeMs: parsed === undefined && settingsRecoveredFrom ? -1 : mtimeMs, root };
  return root;
};

// OpenChamber's settings are consulted on every proxied API request (several per second
// across instances). Re-parse only when the file's mtime moves; a stat is far cheaper.
let openchamberSettingsCache: { mtimeMs: number; root: Record<string, unknown> } | null = null;
const readOpenchamberSettings = (): Record<string, unknown> => {
  const file = openchamberSettingsPath();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Missing file: fall through and cache the empty result under mtime -1.
  }
  if (openchamberSettingsCache && openchamberSettingsCache.mtimeMs === mtimeMs) {
    return openchamberSettingsCache.root;
  }
  const root = readJson(file);
  openchamberSettingsCache = { mtimeMs, root };
  return root;
};

const writeJson = async (file: string, data: unknown): Promise<void> => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
};

const hostId = (host: StoredHost, index: number): string => String(host.id || `host-${index}`);

const readEmberSettings = (): EmberSettings => {
  const root = readEmberSettingsFile();
  // Older builds stored one theme per instance; fall back to the first of those.
  const legacyThemes =
    root.instanceThemes && typeof root.instanceThemes === 'object'
      ? Object.values(root.instanceThemes as Record<string, string>)
      : [];
  const theme = typeof root.theme === 'string' && root.theme ? root.theme : legacyThemes[0];
  return {
    theme: theme || DEFAULT_THEME_ID,
    blobStyle: isBlobStyle(root.blobStyle) ? root.blobStyle : DEFAULT_BLOB_STYLE,
    sessionWindowHours: isWindowHours(root.sessionWindowHours)
      ? root.sessionWindowHours
      : DEFAULT_SESSION_WINDOW_HOURS,
    hiddenInstances: parseStringArray(root.hiddenInstances),
    dismissedOutages: parseStringArray(root.dismissedOutages),
    hideToolCalls: root.hideToolCalls === true,
    reasoningDisplay: isReasoningDisplay(root.reasoningDisplay) ? root.reasoningDisplay : 'collapsed',
    showQuestions: root.showQuestions !== false,
    expandToolCalls: root.expandToolCalls === true,
    toolDisplay: isToolDisplay(root.toolDisplay) ? root.toolDisplay : 'collapsed',
    showMessageDetails: root.showMessageDetails !== false,
    showAvatars: root.showAvatars !== false,
    showActivityRail: root.showActivityRail !== false,
    compactSpacing: root.compactSpacing === true,
    compactRail: root.compactRail === true,
    railMode: isRailMode(root.railMode) ? root.railMode : 'normal',
    autoFollow: root.autoFollow !== false,
    splitView: root.splitView === true,
    sessionGroups: parseSessionGroups(root.sessionGroups),
    instanceDefaults: parseInstanceDefaults(root.instanceDefaults),
    sessionNotes: parseSessionNotes(root.sessionNotes),
    readMarks: parseReadMarks(root.readMarks),
    readSince: typeof root.readSince === 'number' && Number.isFinite(root.readSince) && root.readSince > 0 ? root.readSince : undefined,
    composerDrafts: parseComposerDrafts(root.composerDrafts),
    scheduledSessionBindings: parseStringRecord(root.scheduledSessionBindings),
    autoArchiveScheduledRuns: root.autoArchiveScheduledRuns !== false,
    avatarOverrides: parseAvatarOverrides(root.avatarOverrides),
    projectColorAssignments: parseColorAssignments(root.projectColorAssignments),
    openSessions: parseStringArray(root.openSessions),
    activeSession:
      typeof root.activeSession === 'string' &&
      root.activeSession.length > 0 &&
      root.activeSession.length <= 500
        ? root.activeSession
        : null,
    minimizedSessions: parseStringArray(root.minimizedSessions),
    piEndpoints: (() => {
      const configured = parsePiEndpoints(root.piEndpoints);
      if (configured.length > 0 || Array.isArray(root.piEndpoints)) return configured;
      const discovered = discoverLocalPiEndpoint(
        (tokenPath) => {
          try {
            return fs.readFileSync(tokenPath, 'utf8');
          } catch {
            return undefined;
          }
        },
        os.homedir(),
        process.env
      );
      return discovered ? [discovered] : [];
    })(),
    remoteAccessEnabled: root.remoteAccessEnabled === true,
    remotePasswordConfigured: typeof root.remotePasswordHash === 'string' && root.remotePasswordHash.length > 0,
    remoteAccessState: remoteListenerState,
    settingsRecovered: settingsRecoveredFrom !== null,
  };
};

/**
 * `EmberSettings` carries two fields that describe this process, not the file: where the listener
 * is and whether the settings file had to be quarantined. They must never be persisted.
 */
const persistedSettings = (settings: EmberSettings): Record<string, unknown> => {
  const { remoteAccessState: _state, settingsRecovered: _recovered, ...persisted } = settings;
  return persisted;
};

const hostUrl = (host: StoredHost): string => {
  const url = typeof host.url === 'string' ? host.url : '';
  return typeof host.apiUrl === 'string' && host.apiUrl ? host.apiUrl : url;
};

const localHost = (root: Record<string, unknown>): StoredHost | null => {
  const url = localInstanceUrl(root);
  return url ? { id: 'local', label: 'Local', url } : null;
};

const hostToken = (host: StoredHost, root: Record<string, unknown>): string => {
  if (typeof host.clientToken === 'string' && host.clientToken.trim()) return host.clientToken.trim();
  if (typeof host.token === 'string' && host.token.trim()) return host.token.trim();
  if (isLocalHttpUrl(hostUrl(host)) && typeof root.desktopLocalClientToken === 'string') {
    return root.desktopLocalClientToken;
  }
  return '';
};

const hostHeaders = (host: StoredHost, root: Record<string, unknown>): Record<string, string> => {
  const headers = Object.fromEntries(
    Object.entries(host.requestHeaders ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const token = hostToken(host, root);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

/**
 * OpenCode 2 / OpenChamber 2 serve `/health`; the v1 API had `/api/health`. Probing both tells
 * a genuinely old instance apart from one that's merely down, so the UI can say "unsupported"
 * instead of endlessly retrying a server that will never answer the routes Ember calls.
 */
type ProbeResult = 'v2' | 'v1' | 'down';

const probeHealth = async (url: string, headers: Record<string, string>): Promise<ProbeResult> => {
  const attempt = async (target: string | null): Promise<boolean> => {
    if (!target) return false;
    try {
      const response = await fetch(target, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  if (await attempt(resolveHealthUrl(url))) return 'v2';
  if (await attempt(resolveApiUrl(url, '/api/health'))) return 'v1';
  return 'down';
};

let instanceSnapshot: Instance[] = [];
let probeGeneration = 0;
const loadInstances = async (refresh = true): Promise<Instance[]> => {
  if (!refresh) return instanceSnapshot;
  const generation = ++probeGeneration;
  const root = readOpenchamberSettings();
  const hosts = Array.isArray(root.desktopHosts) ? (root.desktopHosts as StoredHost[]) : [];
  const sshInstances = Array.isArray(root.desktopSshInstances)
    ? (root.desktopSshInstances as StoredSshInstance[])
    : [];

  const hostIds = new Set(hosts.map((host, index) => hostId(host, index)));
  const candidates: Array<{ instance: Instance; headers: Record<string, string> }> = [];
  const local = localHost(root);
  if (local) {
    hostIds.add('local');
    candidates.push({
      instance: {
        id: 'local',
        label: 'Local',
        kind: 'local',
        url: local.url,
        status: 'checking',
        attachable: false,
      },
      headers: hostHeaders(local, root),
    });
  }

  hosts.forEach((host, index) => {
    const url = hostUrl(host);
    const rawUrl = typeof host.url === 'string' ? host.url : '';
    const isRelay = rawUrl.startsWith('relay://') || Boolean(host.relay);
    const id = hostId(host, index);
    const sshMatch = sshInstances.find((entry) => String(entry.id || '') === id);
    const kind: Instance['kind'] = isRelay
      ? 'relay'
      : sshMatch
        ? 'ssh'
        : isLocalHttpUrl(url)
          ? 'local'
          : 'remote';
    const usable = !isRelay && Boolean(resolveApiUrl(url, '/api/session'));

    candidates.push({
      instance: {
        id,
        label: host.label || (isRelay ? rawUrl : url) || id,
        kind,
        url: usable ? url : undefined,
        status: usable ? 'checking' : 'unsupported',
        attachable: false,
      },
      headers: hostHeaders(host, root),
    });
  });

  sshInstances.forEach((entry, index) => {
    const id = String(entry.id || `ssh-${index}`);
    if (hostIds.has(id)) return;

    candidates.push({
      instance: {
        id,
        label: entry.nickname || entry.sshParsed?.destination || entry.host || id,
        kind: 'ssh',
        status: 'unsupported',
        attachable: false,
      },
      headers: {},
    });
  });

  // Hearth endpoints ride along in the same instance list; they are already probed (their
  // auth makes the OpenChamber health probe below useless), so the probe loop skips them.
  const piInstances = await piInstanceRecords(piEndpoints());
  piInstances.forEach((instance) => candidates.push({ instance, headers: {} }));

  const previous = new Map(instanceSnapshot.map((instance) => [instance.id, instance]));
  // Broadcast only when the visible snapshot actually changed; the 60s watchdog runs this
  // function on a timer and shouldn't flicker "checking" badges for identical results.
  const snapshotSignature = (list: Instance[]): string =>
    list.map((entry) => `${entry.id}:${entry.status}:${entry.attachable}:${entry.label}:${entry.url ?? ''}`).join('|');
  const previousSignature = snapshotSignature(instanceSnapshot);
  const announceIfChanged = () => {
    if (snapshotSignature(instanceSnapshot) !== previousSignature) {
      broadcast({ instanceId: '*', type: 'ember:instances-updated' });
    }
  };
  instanceSnapshot = candidates.map(({ instance }) => {
    if (instance.status === 'checking') instance.attachable = previous.get(instance.id)?.attachable ?? false;
    return instance;
  });
  announceIfChanged();
  await Promise.all(
    candidates.map(async (candidate) => {
      const url = candidate.instance.url;
      if (!url || candidate.instance.status === 'unsupported' || candidate.instance.kind === 'pi') return;
      const probe = await probeHealth(url, candidate.headers);
      if (generation !== probeGeneration) return;
      candidate.instance.status = probe === 'v2' ? 'ready' : probe === 'v1' ? 'unsupported' : 'unreachable';
      candidate.instance.attachable = probe === 'v2';
      eventStreams.sync(
        instanceSnapshot.filter((instance) => instance.attachable && instance.kind !== 'pi').map((instance) => instance.id)
      );
      announceIfChanged();
    })
  );

  const instances = instanceSnapshot;
  // Every probe re-syncs the event streams, so an instance that comes online starts streaming
  // and one that's removed from OpenChamber stops. Pi endpoints keep their own WebSocket
  // watches (conversation event streams + the task graph) in step with the settings.
  eventStreams.sync(instances.filter((instance) => instance.attachable && instance.kind !== 'pi').map((instance) => instance.id));
  void piClient.syncEndpoints(piEndpoints());
  return instances;
};

/** Best-effort display label for an instance id, without probing health (error paths only). */
const instanceLabel = (instanceId: string): string => {
  if (instanceId === 'local') return 'Local';
  const root = readOpenchamberSettings();
  const hosts = Array.isArray(root.desktopHosts) ? (root.desktopHosts as StoredHost[]) : [];
  const host = hosts.find((entry, index) => hostId(entry, index) === instanceId);
  if (host) {
    const rawUrl = typeof host.url === 'string' ? host.url : '';
    const isRelay = rawUrl.startsWith('relay://') || Boolean(host.relay);
    return host.label || (isRelay ? rawUrl : hostUrl(host)) || instanceId;
  }
  const sshInstances = Array.isArray(root.desktopSshInstances)
    ? (root.desktopSshInstances as StoredSshInstance[])
    : [];
  const ssh = sshInstances.find((entry) => String(entry.id || '') === instanceId);
  return ssh ? ssh.nickname || ssh.sshParsed?.destination || ssh.host || instanceId : instanceId;
};

const instanceTarget = (instanceId: string): { url: string; headers: Record<string, string> } | null => {
  const root = readOpenchamberSettings();
  const hosts = Array.isArray(root.desktopHosts) ? (root.desktopHosts as StoredHost[]) : [];
  const host =
    instanceId === 'local'
      ? localHost(root)
      : hosts.find((entry, index) => hostId(entry, index) === instanceId) ?? null;
  if (!host) return null;

  const rawUrl = hostUrl(host);
  const rawDirectUrl = typeof host.url === 'string' ? host.url : '';
  if (!resolveApiUrl(rawUrl, '/api/session') || rawDirectUrl.startsWith('relay://')) return null;

  return { url: rawUrl, headers: hostHeaders(host, root) };
};

/**
 * Event hints fan out to every renderer window and to remote web clients. Bodies never
 * cross this boundary; the renderer refetches over REST.
 */
type EventListener = (event: EmberEvent | { instanceId: string; type: 'ember:stream-status'; connected: boolean } | { instanceId: string; type: 'ember:instances-updated' }) => void;
const eventListeners = new Set<EventListener>();
const subscribeEvents = (listener: EventListener): (() => void) => {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
};
const broadcast: EventListener = (event) => {
  eventListeners.forEach((listener) => listener(event));
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('ember:event', event);
  });
};

// Hearth endpoints (the pi transition): pi events become invalidation hints on the same
// channel as OpenCode's, keyed by the endpoint id as the instance id. The resolver lets a
// freshly added endpoint answer before the next instance sync.
const piClient = new PiClient(
  (outbound) => {
    broadcast(outbound as unknown as Parameters<EventListener>[0]);
    // Hearth milestone hints carry a bounded summary; those (and only those) become activity
    // entries, mirroring the OpenCode stream's whitelisted events. A stream-status event is not a
    // hint and carries none.
    if ('summary' in outbound && outbound.summary) activityLog.append(outbound as unknown as EmberEvent);
  },
  (id) => piEndpoints().find((endpoint) => endpoint.id === id)
);
const piEndpoints = (): PiEndpoint[] => readEmberSettings().piEndpoints;
const piInstanceRecords = async (endpoints: readonly PiEndpoint[]): Promise<Instance[]> =>
  Promise.all(
    endpoints.map(async (endpoint) => {
      const info = await piClient.probe(endpoint);
      return {
        id: endpoint.id,
        label: endpoint.label,
        kind: 'pi' as const,
        url: endpoint.url,
        status: info.healthy ? ('ready' as const) : ('unreachable' as const),
        attachable: info.healthy,
        ...(info.version || info.commit ? { version: info.version ?? info.commit } : {}),
      };
    })
  );

const eventStreams = new EventStreamManager(instanceTarget, {
  onEvent: (event) => {
    broadcast(event);
    // Whitelisted milestone events carry the bounded summary main extracted; those (and only
    // those) become durable activity entries.
    if (event.summary) activityLog.append(event);
  },
  onStatus: ({ instanceId, connected }: StreamStatus) =>
    broadcast({ instanceId, type: 'ember:stream-status', connected }),
});

const rendererFile = (): string => path.join(__dirname, '..', 'dist', 'index.html');

const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
  try {
    if (!event.senderFrame) return false;
    const senderUrl = new URL(event.senderFrame.url);
    senderUrl.search = '';
    senderUrl.hash = '';
    return senderUrl.protocol === 'file:' && fileURLToPath(senderUrl) === rendererFile();
  } catch {
    return false;
  }
};

const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
};

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: displayName,
    backgroundColor: '#151413',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const allowedUrl = pathToFileURL(rendererFile()).toString();
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const candidate = new URL(url);
      candidate.search = '';
      candidate.hash = '';
      if (candidate.toString() !== allowedUrl) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  // A link opened in a new window (Cmd/middle-click, window.open) goes to the browser too.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openTarget(url);
    return { action: 'deny' };
  });
  // Electron ships no default context menu: links get open/copy, editable fields the
  // usual edit roles, and any other selection a plain Copy.
  win.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.linkURL) {
      // The renderer serves file://, so a path link arrives already resolved to file://.
      const target = params.linkURL.startsWith('file:') ? fileURLToPath(params.linkURL) : params.linkURL;
      template.push(
        { label: 'Open Link', click: () => void openTarget(target) },
        { label: 'Copy Link', click: () => clipboard.writeText(target) },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      template.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: 'copy' });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.once('ready-to-show', () => win.show());
  void win.loadFile(rendererFile()).catch((error) => {
    console.error('Failed to load renderer', error);
    if (!win.isDestroyed()) win.show();
  });
  return win;
};

const readResponseText = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Response body is too large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Response body is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
};

ipcMain.handle('ember:instances', (event, refresh?: unknown) => {
  assertTrustedSender(event);
  return loadInstances(refresh !== false);
});

ipcMain.handle('ember:app-version', () => app.getVersion());
ipcMain.handle('ember:settings:get', (event) => {
  assertTrustedSender(event);
  return readEmberSettings();
});

ipcMain.handle('ember:models:stats', (event) => { assertTrustedSender(event); return modelStats.list(); });
ipcMain.handle('ember:models:observe', (event, values: unknown) => { assertTrustedSender(event); return modelStats.observe(values); });
ipcMain.handle('ember:models:clear', (event) => { assertTrustedSender(event); return modelStats.clear(); });

ipcMain.handle('ember:activity:list', (event, query: unknown) => {
  assertTrustedSender(event);
  return activityLog.list(parseActivityQuery(query));
});
ipcMain.handle('ember:activity:search', (event, query: unknown, range: unknown) => {
  assertTrustedSender(event);
  return activityLog.search(typeof query === 'string' ? query.slice(0, 200) : '', parseActivityQuery(range));
});
ipcMain.handle('ember:activity:days', (event) => { assertTrustedSender(event); return activityLog.days(); });
ipcMain.handle('ember:activity:clear', (event) => { assertTrustedSender(event); return activityLog.clear(); });

let refreshRemoteServer: () => void = () => {};

const applySettingsPatch = async (patch: unknown): Promise<EmberSettings> => {
  if (settingsQuarantineFailed) {
    // The old file is unreadable and could not be moved. Writing now would replace the only copy
    // of the user's settings with defaults, so refuse and say what to do about it.
    throw new Error('Ember could not read settings.json and could not move it aside. Move or repair that file before changing settings.');
  }
  const value = patch && typeof patch === 'object'
    ? (patch as Partial<EmberSettings> & { remotePassword?: unknown; composerDraftChanges?: unknown })
    : {};
  const root = readJson(emberSettingsPath());
  const settings = readEmberSettings();
  const previousRemoteAccessEnabled = settings.remoteAccessEnabled;
  const previousRemotePasswordHash = typeof root.remotePasswordHash === 'string' ? root.remotePasswordHash : undefined;
  let remotePasswordHash = previousRemotePasswordHash;
  if (typeof value.theme === 'string' && value.theme) settings.theme = value.theme;
  if (isBlobStyle(value.blobStyle)) settings.blobStyle = value.blobStyle;
  if (isWindowHours(value.sessionWindowHours)) settings.sessionWindowHours = value.sessionWindowHours;
  if (value.hiddenInstances !== undefined) settings.hiddenInstances = parseStringArray(value.hiddenInstances);
  if (value.dismissedOutages !== undefined) settings.dismissedOutages = parseStringArray(value.dismissedOutages);
  if (typeof value.hideToolCalls === 'boolean') settings.hideToolCalls = value.hideToolCalls;
  if (isReasoningDisplay(value.reasoningDisplay)) settings.reasoningDisplay = value.reasoningDisplay;
  if (typeof value.showQuestions === 'boolean') settings.showQuestions = value.showQuestions;
  if (typeof value.expandToolCalls === 'boolean') settings.expandToolCalls = value.expandToolCalls;
  if (isToolDisplay(value.toolDisplay)) settings.toolDisplay = value.toolDisplay;
  if (typeof value.showMessageDetails === 'boolean') settings.showMessageDetails = value.showMessageDetails;
  if (typeof value.showAvatars === 'boolean') settings.showAvatars = value.showAvatars;
  if (typeof value.showActivityRail === 'boolean') settings.showActivityRail = value.showActivityRail;
  if (typeof value.compactSpacing === 'boolean') settings.compactSpacing = value.compactSpacing;
  if (typeof value.compactRail === 'boolean') settings.compactRail = value.compactRail;
  if (isRailMode(value.railMode)) settings.railMode = value.railMode;
  if (typeof value.autoFollow === 'boolean') settings.autoFollow = value.autoFollow;
  if (typeof value.splitView === 'boolean') settings.splitView = value.splitView;
  if (value.sessionGroups !== undefined) settings.sessionGroups = parseSessionGroups(value.sessionGroups);
  if (value.instanceDefaults !== undefined) settings.instanceDefaults = parseInstanceDefaults(value.instanceDefaults);
  if (value.sessionNotes !== undefined) settings.sessionNotes = parseSessionNotes(value.sessionNotes);
  if (value.readMarks !== undefined) settings.readMarks = parseReadMarks(value.readMarks);
  if (typeof value.readSince === 'number' && Number.isFinite(value.readSince) && value.readSince > 0) {
    settings.readSince = value.readSince;
  }
  if (value.composerDrafts !== undefined) settings.composerDrafts = parseComposerDrafts(value.composerDrafts);
  if (value.composerDraftChanges && typeof value.composerDraftChanges === 'object') {
    const changes = value.composerDraftChanges as Record<string, unknown>;
    const next = { ...settings.composerDrafts, ...parseComposerDrafts(changes) };
    for (const [key, draft] of Object.entries(changes)) if (draft === null) delete next[key];
    settings.composerDrafts = parseComposerDrafts(next);
  }
  if (value.scheduledSessionBindings !== undefined) settings.scheduledSessionBindings = parseStringRecord(value.scheduledSessionBindings);
  if (typeof value.autoArchiveScheduledRuns === 'boolean') settings.autoArchiveScheduledRuns = value.autoArchiveScheduledRuns;
  if (value.avatarOverrides !== undefined) settings.avatarOverrides = parseAvatarOverrides(value.avatarOverrides);
  if (value.projectColorAssignments !== undefined) settings.projectColorAssignments = parseColorAssignments(value.projectColorAssignments);
  if (value.openSessions !== undefined) settings.openSessions = parseStringArray(value.openSessions);
  if (value.activeSession !== undefined) {
    settings.activeSession =
      typeof value.activeSession === 'string' &&
      value.activeSession.length > 0 &&
      value.activeSession.length <= 500
        ? value.activeSession
        : null;
  }
  if (value.minimizedSessions !== undefined) settings.minimizedSessions = parseStringArray(value.minimizedSessions);
  if (value.piEndpoints !== undefined) settings.piEndpoints = parsePiEndpoints(value.piEndpoints);
  if (value.remotePassword !== undefined) {
    if (value.remotePassword === null || value.remotePassword === '') {
      remotePasswordHash = undefined;
    } else if (typeof value.remotePassword !== 'string' ||
      value.remotePassword.length < MIN_REMOTE_PASSWORD_LENGTH ||
      value.remotePassword.length > MAX_REMOTE_PASSWORD_LENGTH) {
      throw new Error(`Remote password must be between ${MIN_REMOTE_PASSWORD_LENGTH} and ${MAX_REMOTE_PASSWORD_LENGTH} characters`);
    } else {
      remotePasswordHash = await hashRemotePassword(value.remotePassword);
    }
  }
  if (value.remoteAccessEnabled !== undefined) {
    if (value.remoteAccessEnabled !== true && value.remoteAccessEnabled !== false) {
      throw new Error('Invalid remote access setting');
    }
    if (value.remoteAccessEnabled && !remotePasswordHash) {
      throw new Error('Set a remote password before enabling remote access');
    }
    settings.remoteAccessEnabled = value.remoteAccessEnabled;
  }
  settings.remotePasswordConfigured = Boolean(remotePasswordHash);
  if (!remotePasswordHash) settings.remoteAccessEnabled = false;
  await writeJson(emberSettingsPath(), {
    ...persistedSettings(settings),
    ...(remotePasswordHash ? { remotePasswordHash } : {}),
  });
  if (
    settings.remoteAccessEnabled !== previousRemoteAccessEnabled ||
    remotePasswordHash !== previousRemotePasswordHash
  ) refreshRemoteServer();
  return settings;
};

let settingsWrites: Promise<unknown> = Promise.resolve();
const updateSettings = (patch: unknown): Promise<EmberSettings> => {
  const result = settingsWrites.catch(() => {}).then(() => applySettingsPatch(patch));
  settingsWrites = result;
  return result;
};

ipcMain.handle('ember:settings:set', (event, patch: unknown) => {
  assertTrustedSender(event);
  return updateSettings(patch);
});

/**
 * Open a link from a chat or context menu: http(s) URLs go to the default browser, absolute
 * local paths that exist are revealed in Finder. Anything else (other schemes, remote-only
 * paths) is refused so agent output can't trigger arbitrary handlers.
 */
// `localhost:3000` parses as the odd scheme `localhost:` and `www.example.com` isn't a URL
// at all, so agents' bare web addresses need an explicit http:// prefix before anything else.
const NEEDS_SCHEME = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|www\.)[^\s]*$/i;

const openTarget = async (target: string): Promise<boolean> => {
  let filePath = target;
  for (const candidate of NEEDS_SCHEME.test(target) ? [`http://${target}`, target] : [target]) {
    try {
      const external = new URL(candidate);
      if (external.protocol === 'file:') {
        filePath = fileURLToPath(external);
        break;
      }
      // Another scheme (vscode:, mailto:, a token like `localhost:`) never leaves the app.
      if (!['http:', 'https:'].includes(external.protocol) || external.username || external.password) return false;
      await shell.openExternal(external.toString());
      return true;
    } catch {
      // Not a URL; try the next candidate, then fall through to the local-path check.
    }
  }

  const resolved = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
  if (!path.isAbsolute(resolved) || !fs.existsSync(resolved)) return false;
  try {
    if (fs.statSync(resolved).isDirectory()) await shell.openPath(resolved);
    else shell.showItemInFolder(resolved);
    return true;
  } catch {
    return false;
  }
};

ipcMain.handle('ember:open', async (event, args: { target?: unknown }): Promise<boolean> => {
  assertTrustedSender(event);
  return openTarget(String(args?.target || '').trim());
});

/**
 * The renderer rasterises the selected session's blob, and the app icon shows it so a glance at the
 * Dock (or the taskbar) says which agent this window is on.
 *
 * Two homes for one image: macOS has a Dock icon (`app.dock.setIcon`), while on Windows and Linux
 * the app icon *is* each window's icon (`win.setIcon`), which is what the taskbar draws. Setting only
 * the Dock left this platform with Electron's default icon — the blob had "changed" because it was
 * never applied at all.
 */
/**
 * The app icon is cosmetic, and a cosmetic failure with no witness is unfixable: `console.warn` in the
 * renderer needs DevTools open at the right moment. So the last attempt is written to
 * `<userData>/app-icon.log`, one line per attempt — what the renderer sent, what the platform
 * offered, and what happened. Readable without a console.
 */
const record = (result: { ok: boolean; reason?: string }, bytes: number): typeof result => {
  try {
    const line = [
      new Date().toISOString(),
      result.ok ? 'ok' : `failed: ${result.reason ?? 'unknown'}`,
      `bytes=${bytes}`,
      `png=${result.ok || result.reason !== 'not a png data URL'}`,
      `platform=${process.platform}`,
      `app.dock=${app.dock ? 'present' : 'absent'}`,
      `windows=${BrowserWindow.getAllWindows().length}`,
    ].join(' ');
    // Append, with a small cap: the sequence around a launch is the useful part (attempt, then done or
    // failed), and overwriting kept only the last line. A diagnostic log should not need a rotation
    // policy, hence the 8 KB ceiling.
    const file = path.join(app.getPath('userData'), 'app-icon.log');
    let previous = '';
    try {
      previous = fs.readFileSync(file, 'utf8');
    } catch {
      // First write.
    }
    fs.writeFileSync(file, `${previous.length > 8_000 ? '' : previous}${line}
`);
  } catch {
    // A diagnostic that throws would be worse than the bug it is chasing.
  }
  return result;
};

/**
 * The renderer's side of the same story: a failure *before* the IPC (a rejected render, a cancelled
 * effect) never reaches the handler above, so it left no trace anywhere except a `console.warn` that
 * only existed if DevTools happened to be open. This carries the reason into the same log.
 */
/**
 * One line into `ember-compact.log` per manual compaction. The renderer formats it (the wording and
 * the outcome rule are tested where the data is), this only writes it down: a compaction the host
 * accepts and then does not perform leaves no other trace anywhere.
 */
ipcMain.handle('ember:compact-log', (event, args: { line?: unknown }): { ok: boolean } => {
  assertTrustedSender(event);
  appendCompactLog(path.join(app.getPath('userData'), 'ember-compact.log'), String(args?.line ?? ''));
  return { ok: true };
});

ipcMain.handle('ember:app-icon-report', (event, args: { reason?: unknown }): { ok: boolean } => {
  assertTrustedSender(event);
  record({ ok: false, reason: `renderer: ${String(args?.reason ?? 'unknown').slice(0, 300)}` }, 0);
  return { ok: true };
});

ipcMain.handle('ember:app-icon', (event, args: { dataUrl?: unknown }): { ok: boolean; reason?: string } => {
  assertTrustedSender(event);
  const dataUrl = String(args?.dataUrl || '');
  // Answer with a reason rather than returning silently: an icon that does not appear is otherwise
  // indistinguishable from one that was never rendered, and this path spent a while doing nothing on
  // a platform whose API it did not have.
  const bytes = Buffer.byteLength(dataUrl);
  if (!dataUrl.startsWith('data:image/png;base64,')) return record({ ok: false, reason: 'not a png data URL' }, bytes);
  if (bytes > MAX_DOCK_ICON_BYTES) return record({ ok: false, reason: `too large (${bytes} bytes)` }, bytes);
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return record({ ok: false, reason: 'the PNG did not decode' }, bytes);
    if (app.dock) app.dock.setIcon(image);
    else BrowserWindow.getAllWindows().forEach((win) => { if (!win.isDestroyed()) win.setIcon(image); });
    return record({ ok: true }, bytes);
  } catch (error) {
    return record({ ok: false, reason: error instanceof Error ? error.message : 'could not set the icon' }, bytes);
  }
});

const proxyApiRequest = async (
  instanceId: string,
  rawMethod: unknown,
  apiPath: unknown,
  requestBody?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> => {
  const target = instanceTarget(instanceId);
  const method = normalizeApiMethod(rawMethod);
  const requestUrl = target ? resolveApiUrl(target.url, apiPath) : null;
  if (!target) return { ok: false, status: 0, data: { error: `${instanceLabel(instanceId)} is not connected in OpenChamber — check the instance and retry.`, source: 'ember' } };
  if (!method || !requestUrl || (method === 'GET' && requestBody !== undefined)) {
    return { ok: false, status: 400, data: { error: 'Invalid API request' } };
  }
  try {
    const body = requestBody === undefined ? undefined : JSON.stringify(requestBody);
    if (body && Buffer.byteLength(body) > MAX_API_BODY_BYTES) {
      return { ok: false, status: 413, data: { error: 'Request body is too large' } };
    }
    const headers = new Headers(target.headers);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(requestUrl, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    const text = await readResponseText(response);
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    // Attribute the failure: a raw "aborted due to timeout" doesn't say what timed out. Ember's
    // own proxy deadline is the layer here; OpenChamber/OpenCode/provider errors come back as HTTP
    // responses instead and keep their own message.
    const label = instanceLabel(instanceId);
    if (error instanceof Error && error.name === 'TimeoutError') {
      const seconds = Math.round(API_TIMEOUT_MS / 1000);
      return {
        ok: false,
        status: 0,
        data: {
          error: `Ember timed out after ${seconds}s waiting for ${label} (Ember → OpenChamber). OpenChamber or its provider may still be working — retry.`,
          source: 'ember',
        },
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      data: { error: `Could not reach ${label} (Ember → OpenChamber): ${detail}`, source: 'ember' },
    };
  }
};

ipcMain.handle('ember:api', async (event, args: unknown) => {
  assertTrustedSender(event);
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return proxyApiRequest(String(input.instanceId || ''), input.method, input.path, input.body);
});

ipcMain.handle('ember:events:status', (event) => {
  assertTrustedSender(event);
  // Hearth endpoints keep their own WebSocket watches, so their liveness lives in PiClient. Merging
  // it here is what lets a window opened after the sockets came up start on the slow cadence
  // instead of polling every 3s until the next reconnect.
  return { ...eventStreams.snapshot(), ...piClient.status() };
});

ipcMain.handle('ember:pi:request', (event, args: unknown) => {
  assertTrustedSender(event);
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return piClient.request(String(input.endpointId ?? ''), String(input.path ?? ''), {
    method: typeof input.method === 'string' ? input.method : undefined,
    body: input.body,
  });
});

/**
 * The remote listener, with its state kept rather than assumed.
 *
 * `start` re-reads the settings on every attempt so a retry that fires while remote access is off
 * stops instead of binding anyway, and so a password change is picked up without a restart.
 */
const remoteListener = new RemoteListener(
  (): StartOutcome => {
    const settings = readEmberSettings();
    if (!settings.remoteAccessEnabled || !settings.remotePasswordConfigured) {
      return { server: null, reason: 'disabled' };
    }
    const started = startRemoteServer(path.dirname(rendererFile()), {
      listInstances: loadInstances,
      modelStats,
      // The remote surface gets the settings with every endpoint token removed, and cannot write
      // `piEndpoints` back: it has no way to use or supply one (see transport.ts).
      getSettings: () => redactRemoteSettings(readEmberSettings()),
      setSettings: (patch) => updateSettings(withoutDesktopOnlySettings(patch)),
      request: proxyApiRequest,
      piRequest: (endpointId, reqPath, init) => piClient.request(endpointId, reqPath, init),
      activityList: (opts) => activityLog.list(parseActivityQuery(opts)),
      activitySearch: (query, range) =>
        activityLog.search(typeof query === 'string' ? query.slice(0, 200) : '', parseActivityQuery(range)),
      activityDays: () => activityLog.days(),
      verifyPassword: (password) => verifyRemotePassword(password, readJson(emberSettingsPath()).remotePasswordHash),
      subscribeEvents,
      eventStatus: () => ({ ...eventStreams.snapshot(), ...piClient.status() }),
    });
    if (!started.server) return { server: null, reason: 'no-tailscale' };
    return { server: started.server, address: started.address };
  },
  (state) => {
    remoteListenerState = state;
    // A settings change is what made the state move; the window already re-reads settings, but a
    // remote client watching the stream should hear about a listener that came up or went down.
    broadcast({ instanceId: '*', type: 'ember:instances-updated' });
  }
);

refreshRemoteServer = () => {
  const settings = readEmberSettings();
  remoteListener.configure(settings.remoteAccessEnabled && settings.remotePasswordConfigured);
};

/**
 * One Ember per profile.
 *
 * Two processes share `settings.json` and `model-stats.json` and each writes its whole in-memory
 * copy, so a second instance silently erased the first one's model observations (and could revert
 * a setting changed moments earlier), and both tried to bind the same remote-access port. The
 * second launch now asks the first to come forward and exits.
 */
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

if (primaryInstance) app.whenReady().then(() => {
  activityLog.start();
  refreshRemoteServer();
  createWindow();
  // Keep instance health fresh: a remote that was unreachable when probed (sleep, dropped
  // tunnel, VPN reconnect) reattaches on its own instead of waiting for a manual refresh.
  setInterval(() => { void loadInstances(true); }, INSTANCE_WATCHDOG_MS).unref();
  // On wake, bounce half-open sockets now (not in 90s at the stall detector) and re-probe so
  // remotes that came back while the machine slept reattach immediately.
  powerMonitor.on('resume', () => {
    eventStreams.restartAll();
    piClient.restartAll();
    void loadInstances(true);
    // Tailscale is often still reconnecting when the lid opens. A resume is a good moment to
    // re-bind even if the bounded backoff has already given up.
    remoteListener.retryNow();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quit can't await, so the last buffered entries go out synchronously.
app.on('will-quit', () => {
  remoteListener.dispose();
});

app.on('before-quit', () => {
  try {
    activityLog.flushSync();
  } catch (error) {
    console.error('Failed to flush activity log', error);
  }
});
