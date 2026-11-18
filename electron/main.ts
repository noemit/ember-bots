import { DailyUpdateChecks } from './dailyUpdateChecks';
import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, powerMonitor, shell, safeStorage } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { UpdateController, updateEligibility, hasUpdatePublisher } from './updates';
import type { UpdateAction } from './updates';
import { createKilnSharing } from './kilnSharing';
import { fileShareOwnerStore } from './kilnSharingOwner';
import { testPiEndpoint } from './piConnection';
import { maskEndpointSecrets, restoreEndpointSecrets } from './endpointSecrets';
import {
  discoverLocalPiEndpoint,
  isLocalHttpUrl,
  localInstanceUrl,
  normalizeApiMethod,
  parseAvatarOverrides,
  parseAvatarAssignments,
  mergeAvatarAssignments,
  parseMutedSessions,
  parseSnoozedSessions,
  parseColorAssignments,
  parseComposerDrafts,
  parseInstanceDefaults,
  parseDelegatorModels,
  parsePiEndpoints,
  parseSessionGroups,
  parseReadMarks,
  parseSessionNotes,
  parseQuoteLinks,
  parseStringArray,
  parseStringRecord,
  isBlobStyle,
  isBlobSize,
  isConversationFontSize,
  isTextSize,
  migrateBlobStyle,
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
import { parseRemoteProxyOrigin } from './remoteProxy';
import { appendCompactLog } from './compactLog';
import {
  createSettingsFileController,
  initializeFirstRunSettings,
  readJson,
  resolveEffectivePiEndpoints,
  resolvePersistedPiEndpoints,
} from './settingsFile';
import { RemoteListener, type StartOutcome } from './remoteListener';
import { EventStreamManager, type EmberEvent, type StreamStatus } from './eventStream';
import { hashRemotePassword, MAX_REMOTE_PASSWORD_LENGTH, MIN_REMOTE_PASSWORD_LENGTH, verifyRemotePassword } from './remoteAuth';
import { ModelStatsStore } from './modelStats';
import { ActivityLog, parseActivityQuery } from './activity';
import { PiClient } from './piClient';
import * as dataDir from './dataDir';
import {
  availableHarnessPort,
  canManageLocalToken,
  defaultHarnessHome,
  localHarnessEndpoint,
  generateHarnessToken,
  harnessTokenOnDisk,
  LOCAL_HARNESS_PORT,
  localHarnessNotice,
  mergeLocalHarnessEndpoint,
  startLocalHarness,
  writeHarnessToken,
  type LocalHarnessOptions,
  type LocalHarnessState,
} from './localHarness';
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

const emberHome = ((): string => {
  const current = dataDir.emberDataDir();
  // Only the default location migrates: an explicit EMBER_DATA_DIR is a canary, with its own tree.
  if (process.env.EMBER_DATA_DIR && process.env.EMBER_DATA_DIR.trim()) return current;
  const moved = dataDir.migrateLegacyDataDir({ from: dataDir.legacyEmberDataDir(), to: current });
  if (moved.length > 0) console.log('[ember] moved settings from ~/.config/ember:', moved.join(', '));
  return current;
})();
const canaryBuild = Boolean(process.env.EMBER_DATA_DIR && process.env.EMBER_DATA_DIR.trim());
const displayName = canaryBuild ? 'Ember Canary' : 'Ember';
app.setName(displayName);
if (canaryBuild) {
  // Chromium storage and the single-instance lock must follow the selected profile too.
  app.setPath('userData', path.join(emberHome, 'chromium'));
  app.setPath('sessionData', app.getPath('userData'));
}

const emberSettingsPath = (): string => path.join(emberHome, 'settings.json');
const modelStats = new ModelStatsStore(path.join(emberHome, 'model-stats.json'));
// The durable activity log: one JSONL file per local day, written from the event stream.
const activityLog = new ActivityLog(path.join(emberHome, 'activity'));

/** What the remote listener is actually doing; reported through the settings the renderer reads. */
let remoteListenerState: RemoteAccessState = { status: 'off', attempts: 0, changedAt: Date.now() };
/** Stops the bundled harness on quit; a no-op when the harness was already running before launch. */
let localHarnessStop: () => Promise<void> = async () => {};
/**
 * How the bundled harness was started, kept so a token rotation can stop it and bring it back with
 * the same home, port and binary — the token is the only thing that changes. Assigned at launch;
 * the default keeps the IPC handlers total before then (and in tests).
 */
type LocalHarnessLaunch = { home: string; options: LocalHarnessOptions };
let localHarness: LocalHarnessLaunch = {
  home: defaultHarnessHome(),
  options: { resourcesDir: process.resourcesPath, home: defaultHarnessHome() },
};

/**
 * Stop the harness we own and wait for its process to actually be gone.
 *
 * Writing the token under a live harness would be a lie — it reads the credential once at start — and
 * a replacement started too early cannot bind the port. So the wait is real: the lock the start path
 * writes is removed when the child exits, and `harnessIsReady` on the same port confirms nothing
 * still answers. Bounded, because a wedged process must not hang the Settings screen forever.
 */
const stopLocalHarnessAndWait = async (handle: LocalHarnessLaunch): Promise<void> => {
  const stop = localHarnessStop;
  localHarnessStop = async () => {};
  await stop();
  const deadline = Date.now() + 10_000;
  const lock = path.join(handle.home, 'ember-harness.lock');
  while (Date.now() < deadline) {
    if (!fs.existsSync(lock) && !(await portAnswers(handle))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** Does anything answer on the harness's address? A stopped harness's port refuses in milliseconds. */
const portAnswers = async (handle: LocalHarnessLaunch): Promise<boolean> => {
  const port = handle.options.port ?? LOCAL_HARNESS_PORT;
  try {
    await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(400) });
    return true;
  } catch {
    return false;
  }
};

/**
 * Ember's and OpenChamber's settings files, parsed only when mtime moves and invalidated immediately
 * after an atomic rename so back-to-back writes in the same coarse mtime tick never read stale data.
 */
const settingsFiles = createSettingsFileController({
  emberSettingsPath,
  openchamberSettingsPath,
  onRecovered: (movedTo) => {
    console.warn(`Ember settings could not be read; kept the old file at ${movedTo}`);
  },
  onQuarantineFailed: (error) => {
    console.error('Ember could not move an unreadable settings file aside', error);
  },
});
const { readEmberSettingsFile, readOpenchamberSettings, writeJson } = settingsFiles;

const hostId = (host: StoredHost, index: number): string => String(host.id || `host-${index}`);

/**
 * What the bundled harness is doing, and the one way to build it.
 *
 * Settings asks for this so a person can see "running on this computer" rather than a listed host
 * they cannot explain. It carries no token: the renderer only needs the state and the address.
 */
let localHarnessState: LocalHarnessState = { kind: 'disabled' };
const localHarnessReport = (): { kind: LocalHarnessState['kind']; url?: string; version?: string; notice: string | null } => ({
  kind: localHarnessState.kind,
  ...('url' in localHarnessState ? { url: localHarnessState.url } : {}),
  ...('version' in localHarnessState && localHarnessState.version ? { version: localHarnessState.version } : {}),
  notice: localHarnessNotice(localHarnessState),
});
ipcMain.handle('ember:local-harness', (event) => {
  assertTrustedSender(event);
  return localHarnessReport();
});

/**
 * The token this app's own harness answers to — and, with `rotate`, a fresh one.
 *
 * `assertTrustedSender` is the whole security boundary here: it accepts only the app's own window
 * loaded from `file:`. The remotely served page is a *different* origin over plain HTTP, so it is
 * refused, which means a browser session someone paired to this machine can never read the token
 * from the page it is controlling. That matters because the token is the credential for this whole
 * host, and remote access is exactly when one person's browser is on another person's machine.
 *
 * Rotation is only offered for a harness this app started (`started`, not `attached`): an attached
 * one is the service Tinder installed or something older, whose lifecycle and restart Ember does not
 * own — writing its token would lock out every other client and change nothing until that process
 * restarts, which may be never.
 */
let harnessOperation: Promise<unknown> = Promise.resolve();
const runHarnessOperation = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = harnessOperation.catch(() => {}).then(operation);
  harnessOperation = next;
  return next;
};
ipcMain.handle('ember:local-harness-retry', (event) => {
  assertTrustedSender(event);
  return runHarnessOperation(async () => {
    if (canManageLocalToken(localHarnessState)) return localHarnessReport();
    if (canaryBuild) localHarness.options.port = await availableHarnessPort();
    const result = await startLocalHarness({
      ...localHarness.options,
      disabled: readEmberSettingsFile().localHarnessEnabled === false,
    });
    localHarnessState = result.state;
    localHarnessStop = result.stop;
    await loadInstances(true);
    broadcast({ instanceId: '*', type: 'ember:instances-updated' });
    return localHarnessReport();
  });
});
ipcMain.handle('ember:local-harness-token', (event, options: { rotate?: boolean } = {}) => {
  assertTrustedSender(event);
  return runHarnessOperation(async () => {
    const manage = canManageLocalToken(localHarnessState);
    if (options?.rotate === true) {
      if (!manage) {
        return {
          ok: false as const,
          canManage: false,
          reason: "The harness on this computer is not one Ember started, so Ember can't give it a new token. Restart it yourself and it will keep the token it already has.",
        };
      }
      try {
        // Stop what we own before touching the file: a token written under a running harness is a lie,
        // because it reads the credential once at start. See `stopLocalHarnessAndWait`.
        await stopLocalHarnessAndWait(localHarness);
        const token = generateHarnessToken();
        writeHarnessToken(localHarness.home, token);
        // Start it again with the token already on disk, and replace the state with whatever it reports.
        const restarted = await startLocalHarness({ ...localHarness.options, token });
        // A successful rotation is `restarted`, not `started`: the harness is ours and is running with
        // the token now on disk, which is what keeps it in the endpoint list.
        localHarnessState =
          restarted.state.kind === 'started'
            ? { kind: 'restarted', url: restarted.state.url, token: restarted.state.token, ...(restarted.state.version ? { version: restarted.state.version } : {}) }
            : restarted.state;
        localHarnessStop = restarted.stop;
        broadcast({ instanceId: '*', type: 'ember:instances-updated' });
        // A partial failure here is a real answer: the token is installed whether or not the host came
        // back, and the notice says so.
        if (localHarnessState.kind !== 'restarted') {
          return {
            ok: false as const,
            canManage: true,
            reason: localHarnessNotice(restarted.state) ?? 'The harness did not come back after the token changed.',
            token,
          };
        }
        return {
          ok: true as const,
          canManage: true,
          token,
          ...(localHarnessState.kind === 'restarted' ? { url: localHarnessState.url } : {}),
        };
      } catch (error) {
        return {
          ok: false as const,
          canManage: true,
          reason: `The harness could not be restarted with a new token (${error instanceof Error ? error.message : String(error)}).`,
        };
      }
    }
    const token = harnessTokenOnDisk(localHarness.home);
    return {
      ok: token !== undefined,
      canManage: manage,
      ...(token ? { token } : {}),
      ...(localHarnessState.kind === 'disabled'
        ? { reason: 'The harness on this computer is turned off in Settings, so there is no token to show.' }
        : {}),
    };
  });
});

const discoverLegacyLocalPiEndpoint = (): PiEndpoint | null =>
  discoverLocalPiEndpoint(
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

/** A stored timestamp, or undefined. Kept strict so a `0` or a string never counts as "dismissed". */
const positiveNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

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
    blobStyle: migrateBlobStyle(root.blobStyle) ?? DEFAULT_BLOB_STYLE,
    blobSize: isBlobSize(root.blobSize) ? root.blobSize : 'standard',
    conversationFontSize: isConversationFontSize(root.conversationFontSize) ? root.conversationFontSize : 14,
    composerSize: isTextSize(root.composerSize) ? root.composerSize : 'medium',
    interfaceSize: isTextSize(root.interfaceSize) ? root.interfaceSize : 'medium',
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
    delegatorModels: parseDelegatorModels(root.delegatorModels),
    sessionNotes: parseSessionNotes(root.sessionNotes),
    quoteLinks: parseQuoteLinks(root.quoteLinks),
    readMarks: Object.fromEntries(Object.entries(parseReadMarks(root.readMarks)).map(([key, { quiet: _legacyQuiet, ...mark }]) => [key, mark])),
    mutedSessions: parseMutedSessions(root.mutedSessions, root.readMarks),
    snoozedSessions: parseSnoozedSessions(root.snoozedSessions),
    readSince: typeof root.readSince === 'number' && Number.isFinite(root.readSince) && root.readSince > 0 ? root.readSince : undefined,
    // A separate policy namespace deliberately leaves all pre-update titles untouched.
    taskTitleSeeds: parseStringRecord(root.taskTitleSeeds),
    composerDrafts: parseComposerDrafts(root.composerDrafts),
    scheduledSessionBindings: parseStringRecord(root.scheduledSessionBindings),
    autoArchiveScheduledRuns: root.autoArchiveScheduledRuns !== false,
    automaticUpdateChecks: root.automaticUpdateChecks !== false,
    avatarOverrides: parseAvatarOverrides(root.avatarOverrides),
    avatarAssignments: parseAvatarAssignments(root.avatarAssignments),
    projectColorAssignments: parseColorAssignments(root.projectColorAssignments),
    openSessions: parseStringArray(root.openSessions),
    activeSession:
      typeof root.activeSession === 'string' &&
      root.activeSession.length > 0 &&
      root.activeSession.length <= 500
        ? root.activeSession
        : null,
    minimizedSessions: parseStringArray(root.minimizedSessions),
    piEndpoints: resolveEffectivePiEndpoints({
      root,
      secretStore: safeStorage,
      canaryBuild,
      localHarness: localHarnessEndpointInfo(root),
      discoverLocal: () => discoverLegacyLocalPiEndpoint(),
    }),
    remoteAccessEnabled: root.remoteAccessEnabled === true,
    // Keep invalid stored values for startRemoteServer to reject rather than exposing direct HTTP.
    remoteAccessProxyOrigin: root.remoteAccessProxyOrigin === undefined ? undefined : String(root.remoteAccessProxyOrigin),
    remotePasswordConfigured: typeof root.remotePasswordHash === 'string' && root.remotePasswordHash.length > 0,
    remoteAccessState: remoteListenerState,
    localHarnessEnabled: root.localHarnessEnabled !== false,
    localHarnessCanRotate: canManageLocalToken(localHarnessState),
    onboardingStartedAt: positiveNumberOrUndefined(root.onboardingStartedAt),
    onboardingDismissedAt: positiveNumberOrUndefined(root.onboardingDismissedAt),
    onboardedAt: positiveNumberOrUndefined(root.onboardedAt),
    localHarnessState: localHarnessReport(),
    settingsRecovered: settingsFiles.isRecovered(),
  };
};

/**
 * `EmberSettings` carries fields that describe this process, not the file: where the listener is,
 * what the bundled harness is doing, and whether the settings file had to be quarantined. They must
 * never be persisted.
 */
const persistedSettings = (settings: EmberSettings): Record<string, unknown> => {
  const {
    remoteAccessState: _state,
    settingsRecovered: _recovered,
    localHarnessState: _harness,
    // Whether *this launch* can rotate the harness's token. Written by 1.5.0–1.5.3 because this
    // function did not know about it, so files in the wild carry `localHarnessCanRotate: false` and
    // read back as if the person had chosen it. Dropped here, and ignored on read (it is derived on
    // every `getSettings`), so an existing file heals on the next save.
    localHarnessCanRotate: _canRotate,
    ...persisted
  } = settings;
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
  if (generation !== probeGeneration) return instanceSnapshot;
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

  // Stamp `onboardedAt` after OpenChamber health probes settle too, serialized through
  // `settingsWrites` so it never races concurrent settings patches or clobbers quarantined files.
  const hasHealthyInstance = candidates.some(
    (candidate) => candidate.instance.status === 'ready' || candidate.instance.attachable
  );
  void settingsFiles
    .noteOnboarded(hasHealthyInstance, () => {
      broadcast({ instanceId: '*', type: 'ember:instances-updated' });
    })
    .catch((error) => {
      console.warn('[ember] could not record onboardedAt:', error instanceof Error ? error.message : error);
    });
  if (generation !== probeGeneration) return instanceSnapshot;

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
  (id) => piEndpoints().find((endpoint) => endpoint.id === id),
  (endpointId) => {
    const settings = readEmberSettings();
    const ids = new Set<number>();
    const keys = [
      ...(settings.openSessions ?? []),
      ...(settings.activeSession ? [settings.activeSession] : []),
    ];
    for (const key of keys) {
      if (!key.startsWith(`${endpointId}::`)) continue;
      const num = Number(key.slice(endpointId.length + 2));
      if (Number.isInteger(num) && num > 0) ids.add(num);
    }
    return ids;
  }
);
/** Where the bundled harness keeps its data; the token on disk is read from here. */
const harnessHome = (): string => emberHome;

/**
 * Whether a local harness should be listed, and under which token.
 *
 * Kept as one function because two callers must agree: `readEmberSettings()` (what Settings →
 * Instances and any settings round-trip see) and `piEndpoints()` (what the instance list probes).
 * They disagreed before, and the visible symptom was a settings file holding one remote endpoint
 * and no local row — the local harness was attached rather than started, so neither path listed it.
 */
const localHarnessEndpointInfo = (root?: Record<string, unknown>): { url: string; token: string } | null =>
  localHarnessEndpoint({
    state: localHarnessState,
    enabled: (root ?? readEmberSettingsFile()).localHarnessEnabled !== false,
    home: harnessHome(),
    port: localHarness.options.port,
  });

const synthesizedLocalEndpointInfo = (root: Record<string, unknown>): { url: string; token: string } | null => {
  const harness = localHarnessEndpointInfo(root);
  if (harness) return harness;
  if (Array.isArray(root.piEndpoints) || canaryBuild || root.localHarnessEnabled === false) return null;
  const legacy = discoverLegacyLocalPiEndpoint();
  return legacy ? { url: legacy.url, token: legacy.token } : null;
};

/**
 * The endpoints Ember talks to: the configured ones, plus the harness this app started.
 *
 * The local harness answers on loopback with a token we can read, but it only enters `piEndpoints`
 * once the settings file is written — which happens when a setting changes, not on launch. Merging
 * it here is what makes it appear on the first launch without racing a settings write. The merge
 * rule itself lives in `localHarness.ts` so it can be tested without a settings file.
 */
const piEndpoints = (): PiEndpoint[] =>
  mergeLocalHarnessEndpoint(readEmberSettings().piEndpoints, localHarnessEndpointInfo());

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
  return maskEndpointSecrets(readEmberSettings());
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

const QUARANTINE_FAILED_ERROR =
  'Ember could not read settings.json and could not move it aside. Move or repair that file before changing settings.';

const applySettingsPatch = async (patch: unknown): Promise<EmberSettings> => {
  if (settingsFiles.isQuarantineFailed()) {
    // The old file is unreadable and could not be moved. Writing now would replace the only copy
    // of the user's settings with defaults, so refuse and say what to do about it.
    throw new Error(QUARANTINE_FAILED_ERROR);
  }
  const value = patch && typeof patch === 'object'
    ? (patch as Partial<EmberSettings> & { remotePassword?: unknown; composerDraftChanges?: unknown })
    : {};
  const root = readEmberSettingsFile();
  const settings = readEmberSettings();
  if (settingsFiles.isQuarantineFailed()) {
    throw new Error(QUARANTINE_FAILED_ERROR);
  }
  const previousEffectiveEndpoints = settings.piEndpoints;
  const synthesizedLocal = synthesizedLocalEndpointInfo(root);
  const previousRemoteAccessEnabled = settings.remoteAccessEnabled;
  const previousRemoteProxyOrigin = settings.remoteAccessProxyOrigin;
  const previousRemotePasswordHash = typeof root.remotePasswordHash === 'string' ? root.remotePasswordHash : undefined;
  let remotePasswordHash = previousRemotePasswordHash;
  if (typeof value.theme === 'string' && value.theme) settings.theme = value.theme;
  if (isBlobStyle(value.blobStyle)) settings.blobStyle = value.blobStyle;
  if (isBlobSize(value.blobSize)) settings.blobSize = value.blobSize;
  if (isConversationFontSize(value.conversationFontSize)) settings.conversationFontSize = value.conversationFontSize;
  if (isTextSize(value.composerSize)) settings.composerSize = value.composerSize;
  if (isTextSize(value.interfaceSize)) settings.interfaceSize = value.interfaceSize;
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
  if (value.delegatorModels !== undefined) settings.delegatorModels = parseDelegatorModels(value.delegatorModels);
  if (value.instanceDefaults !== undefined) settings.instanceDefaults = parseInstanceDefaults(value.instanceDefaults);
  if (value.sessionNotes !== undefined) settings.sessionNotes = parseSessionNotes(value.sessionNotes);
  if (value.quoteLinks !== undefined) settings.quoteLinks = parseQuoteLinks(value.quoteLinks);
  if (value.mutedSessions !== undefined) settings.mutedSessions = parseMutedSessions(value.mutedSessions, undefined);
  if (value.snoozedSessions !== undefined) settings.snoozedSessions = parseSnoozedSessions(value.snoozedSessions);
  if (value.readMarks !== undefined) settings.readMarks = parseReadMarks(value.readMarks);
  if (typeof value.readSince === 'number' && Number.isFinite(value.readSince) && value.readSince > 0) {
    settings.readSince = value.readSince;
  }
  if (value.taskTitleSeeds !== undefined) settings.taskTitleSeeds = parseStringRecord(value.taskTitleSeeds);
  if (value.composerDrafts !== undefined) settings.composerDrafts = parseComposerDrafts(value.composerDrafts);
  if (value.composerDraftChanges && typeof value.composerDraftChanges === 'object') {
    const changes = value.composerDraftChanges as Record<string, unknown>;
    const next = { ...settings.composerDrafts, ...parseComposerDrafts(changes) };
    for (const [key, draft] of Object.entries(changes)) if (draft === null) delete next[key];
    settings.composerDrafts = parseComposerDrafts(next);
  }
  if (value.scheduledSessionBindings !== undefined) settings.scheduledSessionBindings = parseStringRecord(value.scheduledSessionBindings);
  if (typeof value.automaticUpdateChecks === 'boolean') settings.automaticUpdateChecks = value.automaticUpdateChecks;
  if (typeof value.autoArchiveScheduledRuns === 'boolean') settings.autoArchiveScheduledRuns = value.autoArchiveScheduledRuns;
  if (value.avatarAssignments !== undefined) settings.avatarAssignments = mergeAvatarAssignments(settings.avatarAssignments, value.avatarAssignments);
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
  const persistedEndpoints = resolvePersistedPiEndpoints({
    rawStored: root.piEndpoints,
    previousEffective: previousEffectiveEndpoints,
    patchValue: value.piEndpoints,
    synthesizedLocal,
    secretStore: safeStorage,
  });
  // The guide's dismissal is the person's decision, so a patch may set it. `onboardedAt` is not:
  // that one records a fact main observed (a host answered), and a client claiming it would let a
  // stale window suppress the guide on a genuinely fresh install.
  if (value.onboardingDismissedAt !== undefined) {
    settings.onboardingDismissedAt =
      typeof value.onboardingDismissedAt === 'number' && Number.isFinite(value.onboardingDismissedAt) && value.onboardingDismissedAt > 0
        ? value.onboardingDismissedAt
        : undefined;
  }
  // Persisted (unlike the process-local state beside it): turning the bundled harness off has to
  // survive a relaunch, or the next launch would start it again and ask the same question twice.
  if (value.localHarnessEnabled !== undefined) {
    if (typeof value.localHarnessEnabled !== 'boolean') throw new Error('Invalid local harness setting');
    settings.localHarnessEnabled = value.localHarnessEnabled;
  }
  if (value.remoteAccessProxyOrigin !== undefined) {
    settings.remoteAccessProxyOrigin = parseRemoteProxyOrigin(value.remoteAccessProxyOrigin);
  }
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
  const { piEndpoints: _transientEndpoints, ...persistedWithoutEndpoints } = persistedSettings(settings);
  await writeJson(emberSettingsPath(), {
    ...persistedWithoutEndpoints,
    ...(persistedEndpoints !== undefined ? { piEndpoints: persistedEndpoints } : {}),
    ...(remotePasswordHash ? { remotePasswordHash } : {}),
  });
  if (
    settings.remoteAccessEnabled !== previousRemoteAccessEnabled ||
    remotePasswordHash !== previousRemotePasswordHash ||
    settings.remoteAccessProxyOrigin !== previousRemoteProxyOrigin
  ) {
    // A changed password or trust boundary invalidates every cookie and open event stream.
    remoteListener.dispose();
    refreshRemoteServer();
  }
  void dailyUpdateChecks?.check().catch(() => {});
  return maskEndpointSecrets(readEmberSettings());
};

const updateSettings = (patch: unknown): Promise<EmberSettings> =>
  settingsFiles.enqueueWrite(() => applySettingsPatch(patch));

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

let updateController: UpdateController | undefined;
let dailyUpdateChecks: DailyUpdateChecks | undefined;
let updateInstaller: import('electron-updater').AppUpdater | undefined;
let updateRestartRequested = false;
ipcMain.handle('ember:updates:state', (event) => {
  assertTrustedSender(event);
  return updateController?.snapshot();
});
ipcMain.handle('ember:updates:action', (event, action: unknown) => {
  assertTrustedSender(event);
  if (!['check', 'download', 'restart'].includes(String(action))) throw new Error('Unknown update action');
  return action === 'check' && dailyUpdateChecks
    ? dailyUpdateChecks.check(true).then(state => state ?? updateController?.snapshot())
    : updateController?.action(action as UpdateAction);
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

// These credential-bearing operations exist only on trusted desktop IPC, never the remote router.
ipcMain.handle('ember:pi:test', async (event, value: unknown) => {
  assertTrustedSender(event);
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const draft = restoreEndpointSecrets([input], piEndpoints()) as unknown[];
  const parsed = parsePiEndpoints([{ ...draft[0] as object, id: 'pi:test' }]);
  if (!parsed[0]) return { outcome: 'wrong-service', host: 'This Kiln', message: 'Ember needs a valid server address and Kiln bearer token. Check both, then test again.' };
  return testPiEndpoint(parsed[0]);
});
const inspectOwnedKilnSharing = (action: 'inspect' | 'enable' | 'disable') => runHarnessOperation(async () => {
  const owner = fileShareOwnerStore(path.join(emberHome, 'kiln-sharing-owner.json'));
  const currentOwned = canManageLocalToken(localHarnessState);
  const receipt = owner.read();
  // A disabled included backend may still have an owned persistent forward to remove.
  // Attached external processes never gain mutation rights from a saved receipt.
  const stoppedOwned = action !== 'enable' && localHarnessState.kind === 'disabled' && Boolean(receipt);
  const local = currentOwned && 'url' in localHarnessState
    ? { url: localHarnessState.url, token: localHarnessState.token }
    : stoppedOwned && receipt ? { url: 'http://' + receipt.target, token: '' } : null;
  const controller = createKilnSharing({
    hostLabel: 'This computer', localUrl: local?.url ?? 'http://127.0.0.1:' + LOCAL_HARNESS_PORT,
    token: local?.token ?? '', statePath: path.join(emberHome, 'kiln-sharing-owner.json'),
    publicPort: receipt?.port, ownedProcess: currentOwned || stoppedOwned,
  });
  return controller[action]();
});
ipcMain.handle('ember:kiln:sharing', (event, action: unknown) => {
  assertTrustedSender(event);
  if (action !== 'inspect' && action !== 'enable' && action !== 'disable') throw new Error('Choose whether to check, share or stop sharing this computer’s Kiln.');
  return inspectOwnedKilnSharing(action);
});
ipcMain.handle('ember:kiln:sharing-details', async (event) => {
  assertTrustedSender(event);
  const status = await inspectOwnedKilnSharing('inspect');
  const token = canManageLocalToken(localHarnessState) && 'token' in localHarnessState ? localHarnessState.token : undefined;
  return status.state === 'ready' && status.url && token ? { url: status.url, token } : null;
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
      setSettings: async (patch) => redactRemoteSettings(await updateSettings(withoutDesktopOnlySettings(patch))),
      request: proxyApiRequest,
      piRequest: (endpointId, reqPath, init) => piClient.request(endpointId, reqPath, init),
      activityList: (opts) => activityLog.list(parseActivityQuery(opts)),
      activitySearch: (query, range) =>
        activityLog.search(typeof query === 'string' ? query.slice(0, 200) : '', parseActivityQuery(range)),
      activityDays: () => activityLog.days(),
      verifyPassword: (password) => verifyRemotePassword(password, readEmberSettingsFile().remotePasswordHash),
      subscribeEvents,
      eventStatus: () => ({ ...eventStreams.snapshot(), ...piClient.status() }),
    }, { proxyOrigin: settings.remoteAccessProxyOrigin });
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

if (primaryInstance) app.whenReady().then(async () => {
  initializeFirstRunSettings(emberSettingsPath(), path.join(emberHome, 'hearth.sqlite'));
  activityLog.start();
  // Start (or adopt) the harness this app ships before the window paints, so the first launch has a
  // host to show instead of an empty rail and instructions to go and find one.
  const launchOptions: LocalHarnessOptions = {
    resourcesDir: process.resourcesPath,
    ...(!app.isPackaged ? { developmentDir: app.getAppPath() } : {}),
    ...(process.env.EMBER_DATA_DIR?.trim() ? { port: await availableHarnessPort() } : {}),
    onExit: (reason) => {
      localHarnessState = { kind: 'failed', reason };
      broadcast({ instanceId: '*', type: 'ember:instances-updated' });
    },
    // One directory for the app and its harness: `~/.ember` (or the canary's own tree).
    home: emberHome,
    ...(process.env.EMBER_BUNDLED_HARNESS ? { binaryName: process.env.EMBER_BUNDLED_HARNESS } : {}),
    // The same switch the settings screen shows. Persisted so a person who turned it off is not
    // asked again on the next launch.
    disabled: readJson(emberSettingsPath()).localHarnessEnabled === false,
  };
  localHarness = { home: emberHome, options: launchOptions };
  const startedHarness = await runHarnessOperation(() => startLocalHarness(launchOptions));
  localHarnessState = startedHarness.state;
  if (localHarnessNotice(startedHarness.state)) {
    console.warn('[ember] local harness:', localHarnessNotice(startedHarness.state));
  }
  localHarnessStop = startedHarness.stop;
  refreshRemoteServer();
  createWindow();
  let stableDistribution = false;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { emberUpdateChannel?: unknown };
    stableDistribution = metadata.emberUpdateChannel === 'stable';
  } catch { /* Missing distribution metadata is a local build, not an update-enabled release. */ }
  const eligibility = updateEligibility({ stableDistribution, packaged: app.isPackaged, canary: canaryBuild, version: app.getVersion(), platform: process.platform, appImage: process.env.APPIMAGE, windowsInstalled: process.platform === 'win32' && fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall Ember.exe')) });
  // NSIS skips verification if its installed publisher allowlist is absent. Fail closed instead.
  if (eligibility.enabled && process.platform === 'win32') {
    try {
      const config: unknown = parseYaml(fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'));
      if (!hasUpdatePublisher(config)) throw new Error('Missing publisher');
    } catch {
      eligibility.enabled = false;
      eligibility.supported = false;
      eligibility.message = 'Ember cannot verify this installation’s update publisher. Download a signed setup from GitHub Releases, or contact the release owner.';
    }
  }
  // Never load the updater in unpackaged/Canary builds or unsupported Linux packages.
  let updater: import('electron-updater').AppUpdater | undefined;
  try {
    updater = eligibility.enabled ? (await import('electron-updater')).autoUpdater : undefined;
  } catch {
    eligibility.enabled = false;
    eligibility.message = 'Ember could not start its updater. Restart Ember to try again, or download the stable release from GitHub.';
  }
  updateInstaller = updater;
  updateController = new UpdateController(updater, app.getVersion(), eligibility, (state) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ember:updates:state', state);
  }, () => { updateRestartRequested = true; app.quit(); }, async () => {
    if (process.platform !== 'darwin') return;
    // electron-updater has downloaded/hashed the ZIP; native Squirrel still needs to verify the
    // installed app's signature. Prepare only after confirmed restart, without its quitAndInstall
    // listener, so a failed signature check leaves chats running and downloads never stage on quit.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        nativeUpdater.removeListener('update-downloaded', ready);
        nativeUpdater.removeListener('error', failed);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Native update preparation failed')); };
      const timeout = setTimeout(failed, 120_000);
      nativeUpdater.once('update-downloaded', ready);
      nativeUpdater.once('error', failed);
      try { nativeUpdater.checkForUpdates(); } catch { failed(); }
    });
  });
  updater?.on('error', () => {
    if (!harnessQuitComplete) return;
    // A failed installer can leave the window open. Restore only the Kiln we just stopped.
    harnessQuitComplete = false;
    harnessQuitPending = false;
    updateRestartRequested = false;
    if (restoreOwnedHarnessAfterUpdateFailure && localHarness) {
      restoreOwnedHarnessAfterUpdateFailure = false;
      void runHarnessOperation(async () => {
        const result = await startLocalHarness(localHarness!.options);
        localHarnessState = result.state;
        localHarnessStop = result.stop;
        broadcast({ instanceId: '*', type: 'ember:instances-updated' });
      }).catch(() => {
        localHarnessState = { kind: 'failed', reason: 'Ember could not restart its bundled Kiln after the update failed. Use Retry in Settings → Instances.' };
        broadcast({ instanceId: '*', type: 'ember:instances-updated' });
      });
    }
  });
  if (eligibility.enabled) {
    const attemptsPath = path.join(emberHome, 'update-checks.json');
    const priorCheck = readJson(attemptsPath);
    updateController.restoreCheckResult(priorCheck.lastCheckedAt, priorCheck.lastCheckResult);
    dailyUpdateChecks = new DailyUpdateChecks({
      enabled: () => readEmberSettings().automaticUpdateChecks !== false,
      lastAttempt: () => readJson(attemptsPath).lastAttemptAt,
      nextAttempt: () => readJson(attemptsPath).nextAttemptAt,
      recordAttempt: (at, next) => writeJson(attemptsPath, { ...readJson(attemptsPath), lastAttemptAt: at, nextAttemptAt: next }),
      check: async quiet => {
        const state = await updateController!.action('check', quiet);
        if (state.lastCheckedAt) await writeJson(attemptsPath, { ...readJson(attemptsPath), lastCheckedAt: state.lastCheckedAt, lastCheckResult: state.lastCheckResult });
        return state;
      },
    });
    void dailyUpdateChecks.check().catch(() => {});
    // Checks run only while Ember runs; resume below catches up after sleep.
    setInterval(() => { void dailyUpdateChecks?.check().catch(() => {}); }, 60_000).unref();
  }
  // Keep instance health fresh: a remote that was unreachable when probed (sleep, dropped
  // tunnel, VPN reconnect) reattaches on its own instead of waiting for a manual refresh.
  setInterval(() => { void loadInstances(true); }, INSTANCE_WATCHDOG_MS).unref();
  // On wake, bounce half-open sockets now (not in 90s at the stall detector) and re-probe so
  // remotes that came back while the machine slept reattach immediately.
  powerMonitor.on('resume', () => {
    void dailyUpdateChecks?.check().catch(() => {});
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
  dailyUpdateChecks?.dispose();
  updateController?.dispose();
  remoteListener.dispose();
  piClient.closeAll();
  eventStreams.stopAll();
});

let harnessQuitComplete = false;
let harnessQuitPending = false;
let restoreOwnedHarnessAfterUpdateFailure = false;
const installRequestedUpdate = () => {
  updateRestartRequested = false;
  // The updater owns the final quit after its platform installer is ready.
  try {
    updateInstaller?.quitAndInstall(false, true);
  } catch (error) {
    // Use the same observable error/recovery path as asynchronous native installer failures.
    updateInstaller?.emit('error', error instanceof Error ? error : new Error('Update installer failed'));
  }
};
app.on('before-quit', (event) => {
  if (harnessQuitComplete) {
    if (updateRestartRequested) { event.preventDefault(); installRequestedUpdate(); }
    return;
  }
  event.preventDefault();
  if (harnessQuitPending) return;
  harnessQuitPending = true;
  try {
    activityLog.flushSync();
  } catch (error) {
    console.error('Failed to flush activity log', error);
  }
  // Only stops a harness this process started; an adopted one is left running.
  restoreOwnedHarnessAfterUpdateFailure = updateRestartRequested && canManageLocalToken(localHarnessState);
  void harnessOperation.catch(() => {}).then(() => canManageLocalToken(localHarnessState) ? stopLocalHarnessAndWait(localHarness) : undefined).finally(() => {
    harnessQuitComplete = true;
    if (updateRestartRequested) {
      // The normal quit path has now stopped only our owned bundled Kiln, never a standalone host.
      installRequestedUpdate();
    } else app.quit();
  });
});
