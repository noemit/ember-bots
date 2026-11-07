const API_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEFAULT_LOCAL_PORT = 57123;

/** Mirrors AVATAR_COLOR_COUNT in src/blob/contrast.ts (the two tsconfig roots can't share it). */
const AVATAR_COLOR_COUNT = 22;

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * The states the bundled harness can be in, mirrored from `localHarness.ts`.
 *
 * Duplicated rather than imported for the same reason the rest of this file is: `tsconfig.json` and
 * `tsconfig.electron.json` have separate roots, so this contract is written twice on purpose.
 */
export type LocalHarnessKind = 'attached' | 'started' | 'restarted' | 'disabled' | 'missing' | 'failed';

/**
 * The local harness's credential, as the Settings screen shows it.
 *
 * `canManage` is the honest half of the answer: only a harness this app started can be given a new
 * token. An attached one (Tinder's service, or a host older than this launch) keeps the token it has,
 * so the screen offers Copy and no Regenerate rather than a button that would break other clients.
 *
 * `token` is absent when there is nothing to show — the harness is off, or the binary never wrote a
 * file. `reason` says which, in a sentence, because "no token" with no explanation is the dead end
 * the copy rules forbid.
 */
export type LocalHarnessToken = {
  ok: boolean;
  canManage: boolean;
  token?: string;
  url?: string;
  reason?: string;
};

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
};

export const isLocalHttpUrl = (value: string): boolean => {
  const url = parseHttpUrl(value);
  return Boolean(url && LOCAL_HOSTS.has(url.hostname.toLowerCase()));
};

export const localInstanceUrl = (settings: Record<string, unknown>): string | null => {
  const configuredPort = settings.desktopLocalPort;
  if (configuredPort !== undefined) {
    if (
      typeof configuredPort !== 'number' ||
      !Number.isInteger(configuredPort) ||
      configuredPort < 1 ||
      configuredPort > 65_535
    ) {
      return null;
    }
    return `http://127.0.0.1:${configuredPort}`;
  }
  return typeof settings.desktopLocalClientToken === 'string' && settings.desktopLocalClientToken.trim()
    ? `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`
    : null;
};

export const normalizeApiMethod = (value: unknown): ApiMethod | null => {
  if (typeof value !== 'string') return null;
  const method = value.toUpperCase();
  return API_METHODS.has(method) ? (method as ApiMethod) : null;
};

export const resolveApiUrl = (baseValue: string, apiPath: unknown): string | null => {
  const base = parseHttpUrl(baseValue);
  if (
    !base ||
    typeof apiPath !== 'string' ||
    !/^\/api(?:[/?]|$)/.test(apiPath) ||
    apiPath.startsWith('//') ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    /[\\\u0000-\u001f\u007f]/.test(apiPath)
  ) {
    return null;
  }

  const basePath = base.pathname.replace(/\/+$/, '');
  const apiRoot = `${basePath}/api`;
  const resolved = new URL(`${base.origin}${basePath}${apiPath}`);
  if (
    resolved.origin !== base.origin ||
    (resolved.pathname !== apiRoot && !resolved.pathname.startsWith(`${apiRoot}/`))
  ) {
    return null;
  }
  return resolved.toString();
};

/**
 * `/health` sits outside `/api` on OpenCode 2 / OpenChamber 2. Same rules as `resolveApiUrl`
 * (http(s) base, no credentials, same origin, stays under the configured path prefix) — kept
 * separate so the `/api` allowlist for proxied requests never widens.
 */
export const resolveHealthUrl = (baseValue: string): string | null => {
  const base = parseHttpUrl(baseValue);
  if (!base) return null;
  const basePath = base.pathname.replace(/\/+$/, '');
  const resolved = new URL(`${base.origin}${basePath}/health`);
  return resolved.origin === base.origin ? resolved.toString() : null;
};

export type StoredAvatarOverride = {
  colorIndex?: number;
  /** An explicit custom colour, stored as six-digit hex. */
  color?: string;
  shapeName?: string;
};

const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const parseStringRecord = (value: unknown, limit = 2000): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          !UNSAFE_RECORD_KEYS.has(entry[0]) &&
          entry[0].length > 0 &&
          entry[0].length <= 500 &&
          typeof entry[1] === 'string' &&
          entry[1].length > 0 &&
          entry[1].length <= 500
      )
      .slice(0, limit)
  );
};

/** Bounded, de-duplicated list of short non-empty strings, e.g. workspace session keys. */
export const parseStringArray = (value: unknown, limit = 40, maxLength = 500): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxLength) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
};

export type PiEndpoint = {
  id: string;
  label: string;
  url: string;
  token: string;
};

/** Trusted Hearth endpoints: ids unique and namespaced with `pi:`, URLs http(s), tokens bounded. */
export const parsePiEndpoints = (value: unknown, limit = 20): PiEndpoint[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  /**
   * One Hearth, one endpoint. Two entries for the same address are the same host, whatever they are
   * called: a settings file migrated from before ids were namespaced, or a machine saved once under
   * its tailnet name and once under `127.0.0.1`. Keeping both doubles the mount set on the host
   * (every stream is a mount, so every open conversation is held twice), and a third entry triples
   * it — which is how one client came to hold ~4600 connections on a host it was meant to watch 64
   * conversations of. The first entry wins, since it is the one whose label and token the reader
   * has been looking at.
   */
  const seenHosts = new Set<string>();
  const out: PiEndpoint[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const rawId = parseStringArray([raw.id], 1, 200)[0];
    // Hearth ids are namespaced so they can never collide with an OpenChamber instance id
    // (`local`, `ssh-…`, relay URLs). Older settings without the prefix are migrated here.
    const id = rawId ? (rawId.startsWith('pi:') ? rawId : `pi:${rawId}`) : undefined;
    const label = parseStringArray([raw.label], 1, 200)[0] ?? id;
    const url = parseHttpUrl(typeof raw.url === 'string' ? raw.url : '')?.toString();
    const token = typeof raw.token === 'string' && raw.token.length > 0 && raw.token.length <= 4096 ? raw.token : undefined;
    if (!id || id === 'pi:' || seen.has(id) || !url || !token) continue;
    const host = url.toString();
    if (seenHosts.has(host)) continue;
    seen.add(id);
    seenHosts.add(host);
    out.push({ id, label, url, token });
    if (out.length >= limit) break;
  }
  return out;
};

const DEFAULT_LOCAL_HARNESS_URL = 'http://127.0.0.1:3002/';

/**
 * Candidate paths for a local harness token (`~/.ember/ember.token`, `~/.hearth/hearth.token`,
 * or overridden by `EMBER_HOME` / `HEARTH_HOME`), in priority order.
 */
export const localHarnessTokenPaths = (
  homedir: string,
  env: Readonly<Record<string, string | undefined>> = {}
): string[] => {
  const emberHome = env.EMBER_HOME?.trim();
  const hearthHome = env.HEARTH_HOME?.trim();
  const paths: string[] = [];
  if (emberHome) {
    paths.push(`${emberHome.replace(/[\\/]+$/, '')}/ember.token`);
    paths.push(`${emberHome.replace(/[\\/]+$/, '')}/hearth.token`);
  }
  if (hearthHome) {
    paths.push(`${hearthHome.replace(/[\\/]+$/, '')}/hearth.token`);
    paths.push(`${hearthHome.replace(/[\\/]+$/, '')}/ember.token`);
  }
  const base = homedir.replace(/[\\/]+$/, '');
  paths.push(`${base}/.ember/ember.token`);
  paths.push(`${base}/.hearth/hearth.token`);
  return [...new Set(paths)];
};

/**
 * Discover a local Ember Harness / Hearth endpoint at `http://127.0.0.1:3002` when a local
 * token file exists. Used to auto-seed `piEndpoints` on first run when none are configured.
 */
export const discoverLocalPiEndpoint = (
  readTokenFile: (filePath: string) => string | undefined,
  homedir: string,
  env: Readonly<Record<string, string | undefined>> = {}
): PiEndpoint | null => {
  for (const candidate of localHarnessTokenPaths(homedir, env)) {
    const raw = readTokenFile(candidate);
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (token.length > 0 && token.length <= 4096) {
      return {
        id: 'pi:local',
        label: 'Local',
        url: DEFAULT_LOCAL_HARNESS_URL,
        token,
      };
    }
  }
  return null;
};

export const parseColorAssignments = (value: unknown, colorCount = AVATAR_COLOR_COUNT): Record<string, number> => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        (entry): entry is [string, number] =>
          !UNSAFE_RECORD_KEYS.has(entry[0]) &&
          entry[0].length > 0 &&
          entry[0].length <= 500 &&
          Number.isInteger(entry[1]) &&
          Number(entry[1]) >= 0 &&
          Number(entry[1]) < colorCount
      )
      .slice(0, 4000)
  );
};

export type StoredSessionNote = {
  id: string;
  text: string;
};

const MAX_SESSION_NOTES = 100;

const toStoredSessionNote = (value: unknown, fallbackId: string): StoredSessionNote | null => {
  if (typeof value === 'string') {
    return value.trim() && value.length <= 20_000 ? { id: fallbackId, text: value } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (!text.trim() || text.length > 20_000) return null;
  const id = typeof entry.id === 'string' && /^[a-z0-9_-]{1,120}$/i.test(entry.id)
    ? entry.id
    : fallbackId;
  return { id, text };
};

/** Notes saved per session; a lone string (or legacy single-note map) becomes one entry. */
/** Groups that are not `{ id, name, keys[] }` are dropped; a key may appear in one group only. */
export const parseSessionGroups = (value: unknown): SessionGroup[] => {
  if (!Array.isArray(value)) return [];
  const seenGroups = new Set<string>();
  const seenKeys = new Set<string>();
  const groups: SessionGroup[] = [];
  value.slice(0, 200).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const group = entry as Record<string, unknown>;
    if (typeof group.id !== 'string' || !group.id || seenGroups.has(group.id)) return;
    if (typeof group.name !== 'string') return;
    const keys = Array.isArray(group.keys)
      ? group.keys.filter((key): key is string => {
          if (typeof key !== 'string' || !key.includes('::') || seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        })
      : [];
    // A group needs two members to be a group, same rule as lib/sessionGroups.
    if (keys.length < 2) return;
    seenGroups.add(group.id);
    groups.push({
      id: group.id,
      name: group.name.slice(0, 120),
      keys: keys.slice(0, 16),
      ...(typeof group.primaryKey === 'string' && keys.includes(group.primaryKey)
        ? { primaryKey: group.primaryKey }
        : { primaryKey: keys[0] }),
    });
  });
  return groups;
};

/**
 * One session's read mark. The ordinal is the only thing that matters; `ids` are the out-of-order
 * marks kept until the run closes, and `readAt` is the fallback for wires without ordinals.
 */
export type StoredReadMark = {
  through: number;
  ids?: number[];
  readAt?: number;
  comments?: number;
  /** Legacy notification preference, migrated into mutedSessions. */
  quiet?: boolean;
};

const MAX_READ_MARKS = 2000;
const MAX_OUT_OF_ORDER = 200;

const toOrdinal = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const parseReadMarks = (value: unknown): Record<string, StoredReadMark> => {
  if (!value || typeof value !== 'object') return {};
  const marks: Record<string, StoredReadMark> = {};
  Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !UNSAFE_RECORD_KEYS.has(key) && key.length > 0 && key.length <= 500)
    .slice(-MAX_READ_MARKS)
    .forEach(([key, raw]) => {
      if (!raw || typeof raw !== 'object') return;
      const entry = raw as Record<string, unknown>;
      const through = toOrdinal(entry.through) ?? 0;
      const ids = Array.isArray(entry.ids)
        ? [...new Set(entry.ids.map(toOrdinal))]
            .filter((id): id is number => id !== null && id > through)
            .sort((a, b) => a - b)
            .slice(-MAX_OUT_OF_ORDER)
        : [];
      const readAt = toOrdinal(entry.readAt);
      const comments = toOrdinal(entry.comments);
      // A standing policy, not a mark: it has to survive the round trip or the toggle snaps back.
      const quiet = entry.quiet === true;
      // A mark that says nothing is not worth a key — but a quiet session with no read history is
      // a real choice, and dropping it would silently turn notifications back on.
      if (through === 0 && ids.length === 0 && !readAt && !comments && !quiet) return;
      marks[key] = {
        through,
        ...(ids.length ? { ids } : {}),
        ...(readAt ? { readAt } : {}),
        ...(comments ? { comments } : {}),
        ...(quiet ? { quiet: true } : {}),
      };
    });
  return marks;
};

export const parseSessionNotes = (value: unknown): Record<string, StoredSessionNote[]> => {
  if (!value || typeof value !== 'object') return {};
  const notes: Record<string, StoredSessionNote[]> = {};
  Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !UNSAFE_RECORD_KEYS.has(key) && key.length > 0 && key.length <= 500)
    .slice(0, 2000)
    .forEach(([key, raw]) => {
      const parsed = (Array.isArray(raw) ? raw : [raw])
        .slice(0, MAX_SESSION_NOTES)
        .map((entry, index) => toStoredSessionNote(entry, index === 0 ? 'legacy' : `legacy-${index}`))
        .filter((entry): entry is StoredSessionNote => Boolean(entry));
      if (parsed.length) notes[key] = parsed;
    });
  return notes;
};

export type StoredComposerDraft = {
  text: string;
  modelId?: string;
  variant?: string;
  mode?: string;
  updatedAt: number;
};

export const parseComposerDrafts = (value: unknown): Record<string, StoredComposerDraft> => {
  if (!value || typeof value !== 'object') return {};
  const drafts: Record<string, StoredComposerDraft> = {};
  Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !UNSAFE_RECORD_KEYS.has(key) && key.length > 0 && key.length <= 500)
    .slice(-50)
    .forEach(([key, raw]) => {
      if (!raw || typeof raw !== 'object') return;
      const entry = raw as Record<string, unknown>;
      const text = typeof entry.text === 'string' ? entry.text : '';
      const modelId = typeof entry.modelId === 'string' && entry.modelId.length <= 300 ? entry.modelId : undefined;
      const variant = typeof entry.variant === 'string' && entry.variant.length <= 100 ? entry.variant : undefined;
      const mode = typeof entry.mode === 'string' && entry.mode.length <= 100 ? entry.mode : undefined;
      if ((!text.trim() && !modelId && !variant && !mode) || text.length > 200_000) return;
      const draft: StoredComposerDraft = {
        text,
        updatedAt: typeof entry.updatedAt === 'number' && entry.updatedAt > 0 ? entry.updatedAt : Date.now(),
      };
      if (modelId) draft.modelId = modelId;
      if (variant) draft.variant = variant;
      if (mode) draft.mode = mode;
      drafts[key] = draft;
    });
  return drafts;
};

/** An explicit new policy, including an empty one, wins over legacy automatic-read flags. */
export const parseMutedSessions = (value: unknown, legacyMarks: unknown): string[] =>
  Array.isArray(value)
    ? parseStringArray(value)
    : Object.entries(parseReadMarks(legacyMarks)).filter(([, mark]) => mark.quiet).map(([key]) => key);

export const parseAvatarOverrides = (value: unknown): Record<string, StoredAvatarOverride> => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key, raw]) =>
          !UNSAFE_RECORD_KEYS.has(key) &&
          key.length > 0 &&
          key.length <= 500 &&
          raw &&
          typeof raw === 'object'
      )
      .slice(0, 2000)
      .map(([key, raw]) => {
        const entry = raw as Record<string, unknown>;
        const colorIndex = Number.isInteger(entry.colorIndex) && Number(entry.colorIndex) >= 0 && Number(entry.colorIndex) < AVATAR_COLOR_COUNT
          ? Number(entry.colorIndex)
          : undefined;
        const shapeName = typeof entry.shapeName === 'string' && /^[a-z0-9-]{1,80}$/i.test(entry.shapeName)
          ? entry.shapeName
          : undefined;
        const color = typeof entry.color === 'string' && /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color.toLowerCase() : undefined;
        return [key, { colorIndex, color, shapeName }] as const;
      })
      .filter(([, entry]) => entry.colorIndex !== undefined || entry.color !== undefined || entry.shapeName !== undefined)
  );
};

/*
 * Settings contract shared by the main process and the preload bridge. The renderer has its
 * own copy in src/types.ts on purpose: main parses persisted JSON into these trusted shapes,
 * and the two tsconfigs have separate roots, so they can't import each other.
 */
export type BlobStyle = 'buddy' | 'crystal' | 'pip' | 'lava';

export const BLOB_STYLES: BlobStyle[] = ['buddy', 'crystal', 'pip', 'lava'];
export const isBlobStyle = (value: unknown): value is BlobStyle =>
  typeof value === 'string' && (BLOB_STYLES as string[]).includes(value);

export type ReasoningDisplay = 'expanded' | 'collapsed' | 'hidden';

const REASONING_DISPLAYS: ReasoningDisplay[] = ['expanded', 'collapsed', 'hidden'];
export const isReasoningDisplay = (value: unknown): value is ReasoningDisplay =>
  typeof value === 'string' && (REASONING_DISPLAYS as string[]).includes(value);

export type InstanceDefaults = {
  /** User-chosen parent folder for discovering projects on this instance. */
  workspaceDirectory?: string;
  directory?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  variant?: string;
  bypass?: boolean;
  markerColor?: number;
  /**
   * Preferred provider for new agents on this instance, used only when no `model` is pinned.
   * It has to be listed here or `parseInstanceDefaults` drops it: that function is the only
   * path from the settings file to the renderer, and it rebuilds each entry field by field.
   */
  preferredProvider?: string;
};

/**
 * The single parser for `instanceDefaults`, shared by the settings read and the settings write.
 *
 * This used to live in `main.ts` as a private helper that listed six of the seven fields the
 * renderer knows about, so `preferredProvider` was deleted on every read and every save — a
 * control that looked saved and was silently discarded. Anything added to `InstanceDefaults`
 * must be copied here, and `instanceDefaults.test.ts` round-trips every field.
 */
export const parseInstanceDefaults = (value: unknown): Record<string, InstanceDefaults> => {
  if (!value || typeof value !== 'object') return {};
  const defaults: Record<string, InstanceDefaults> = {};
  Object.entries(value as Record<string, unknown>).forEach(([instanceId, raw]) => {
    // `defaults['__proto__'] = …` would set the record's prototype instead of adding a key, and
    // every instance would then inherit that entry. Same guard as the other record parsers.
    if (!instanceId || UNSAFE_RECORD_KEYS.has(instanceId) || !raw || typeof raw !== 'object') return;
    const entry = raw as Record<string, unknown>;
    const model = entry.model && typeof entry.model === 'object'
      ? (entry.model as Record<string, unknown>)
      : {};
    const providerID = typeof model.providerID === 'string' ? model.providerID : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID : '';
    const modelVariant = typeof model.variant === 'string' && model.variant.length <= 80 ? model.variant : undefined;
    const agent = typeof entry.agent === 'string' && entry.agent.length > 0 && entry.agent.length <= 120
      ? entry.agent
      : undefined;
    const variant = typeof entry.variant === 'string' && entry.variant.length <= 80 ? entry.variant : undefined;
    const preferredProvider = typeof entry.preferredProvider === 'string' &&
      entry.preferredProvider.length > 0 &&
      entry.preferredProvider.length <= 200
      ? entry.preferredProvider
      : undefined;
    defaults[instanceId] = {
      ...(typeof entry.workspaceDirectory === 'string' && entry.workspaceDirectory.trim() && entry.workspaceDirectory.length <= 4096
        ? { workspaceDirectory: entry.workspaceDirectory.trim() } : {}),
      directory: typeof entry.directory === 'string' && entry.directory ? entry.directory : undefined,
      agent,
      model: providerID && modelID ? { providerID, modelID, variant: modelVariant } : undefined,
      variant,
      bypass: typeof entry.bypass === 'boolean' ? entry.bypass : undefined,
      markerColor: Number.isInteger(entry.markerColor) && Number(entry.markerColor) >= 0 && Number(entry.markerColor) < 12
        ? Number(entry.markerColor)
        : undefined,
      preferredProvider,
    };
  });
  return defaults;
};

/**
 * A named set of sessions that can span instances and projects. A session lives in at most one group;
 * `src/lib/sessionGroups.ts` enforces that when editing, and the parse below de-dupes defensively so a
 * hand-edited file cannot put one key in two groups.
 */
export type SessionGroup = {
  id: string;
  name: string;
  /** `instance::session`, the same format as the workspace keys. */
  keys: string[];
  /** The member whose instance and project a new agent in this group defaults to. */
  primaryKey?: string;
};

export type EmberSettings = {
  theme: string;
  blobStyle: BlobStyle;
  /** Only list sessions active within this many hours; 0 means no limit. */
  sessionWindowHours: number;
  /** Instances switched off in the Instances menu; their sessions are filtered out everywhere. */
  hiddenInstances: string[];
  /**
   * Hosts whose outage warning was dismissed; cleared when the host answers again. Only the
   * unreachable row is ever suppressed — an unsupported host keeps its settings warning.
   */
  dismissedOutages: string[];
  hideToolCalls: boolean;
  reasoningDisplay: ReasoningDisplay;
  /** Show the question & answer (`ask`) blocks. */
  showQuestions: boolean;
  /** Open tool rows expanded instead of on click. */
  expandToolCalls: boolean;
  /** `list` draws a row per tool group; `collapsed` folds the turn into one line. */
  toolDisplay: 'list' | 'collapsed';
  showMessageDetails: boolean;
  showAvatars: boolean;
  compactSpacing: boolean;
  compactRail: boolean;
  /** The session list's width: a blob dock, the familiar rail, or about half the window. */
  railMode: 'mini' | 'normal' | 'wide';
  autoFollow: boolean;
  /** Whether opening a session splits the view instead of taking it over. */
  splitView: boolean;
  /** The transcript's scrub rail (hidden automatically on short chats). */
  showActivityRail: boolean;
  /** Agent groups: named, cross-instance sets of `instance::session` keys. Ember-side only. */
  sessionGroups: SessionGroup[];
  instanceDefaults: Record<string, InstanceDefaults>;
  sessionNotes: Record<string, StoredSessionNote[]>;
  /** Per-message read state by session key (`instance::session`); see `src/lib/readState.ts`. */
  readMarks: Record<string, StoredReadMark>;
  /** Epoch ms of the first launch that understood read marks; absent means it hasn't happened. */
  readSince?: number;
  /** Sessions whose unread messages should not raise notification indicators. */
  mutedSessions?: string[];
  composerDrafts: Record<string, StoredComposerDraft>;
  scheduledSessionBindings: Record<string, string>;
  /** Archive finished scheduled-task runs once they're a day old. */
  autoArchiveScheduledRuns: boolean;
  avatarOverrides: Record<string, StoredAvatarOverride>;
  projectColorAssignments: Record<string, number>;
  /** Workspace: ordered open session keys ("instance::session"). */
  openSessions: string[];
  activeSession: string | null;
  /** Manually minimized sessions; sticky across resizes and restarts. */
  minimizedSessions: string[];
  /** Hearth endpoints: the pi transition target. */
  piEndpoints: Array<{ id: string; label: string; url: string; token: string }>;
  /**
   * Whether this app should run the harness it ships with on first launch. Absent means yes: an
   * install that has never touched the switch gets a working local host.
   */
  localHarnessEnabled: boolean;
  remoteAccessEnabled: boolean;
  remotePasswordConfigured: boolean;
  /** Whether the listener is actually bound, and where. Never assume "enabled" means "listening". */
  remoteAccessState: RemoteAccessState;
  /**
   * What the harness this app ships with is doing. Read-only and process-local, like
   * `remoteAccessState`: it describes this run, not the file.
   */
  localHarnessState?: {
    kind: LocalHarnessKind;
    url?: string;
    version?: string;
    notice: string | null;
  };
  /** Whether the local harness's token can be rotated by this app (see `LocalHarnessToken`). */
  localHarnessCanRotate?: boolean;
  /**
   * When the first-run guide was dismissed, or `undefined` if it has not been.
   *
   * A timestamp rather than a boolean so "they dismissed it in March" is answerable, and so a
   * migration can decide which installs predate the guide entirely (see `onboardedAt`).
   */
  /** A new installation still needs provider setup, even when its bundled Kiln is healthy. */
  onboardingStartedAt?: number;
  onboardingDismissedAt?: number;
  /**
   * When this install first had a *working* host — written once, by `main.ts`, the first time an
   * instance probes healthy.
   *
   * This is the flag that keeps the guide away from existing installs. Without it, upgrading to the
   * build that introduced the guide would show it to every existing user on their next launch:
   * their local harness is attached (or was never enabled), so `needsOnboarding` is true, and the
   * guide appears over a workspace they have used for months.
   */
  onboardedAt?: number;
  /** True when the settings file could not be read and was moved aside. */
  settingsRecovered: boolean;
};

/** Mirrors `RemoteState` in `remoteListener.ts`; the two tsconfig roots cannot import each other. */
export type RemoteAccessState = {
  status: 'off' | 'starting' | 'listening' | 'no-tailscale' | 'error';
  address?: string;
  port?: number;
  detail?: string;
  attempts: number;
  changedAt: number;
};

/**
 * What a remote browser is allowed to see of the desktop's settings.
 *
 * The remote page has no `piRequest` — it cannot call Hearth at all — but `GET /remote/settings`
 * used to hand it every endpoint's bearer token in plaintext, which outlived the remote password
 * and turned a shared 8-character secret into permanent full authority over every Hearth. The
 * remote surface gets the shape of an endpoint and whether a token exists, never the token.
 */
export const redactRemoteSettings = <T extends { piEndpoints?: Array<{ id: string; label: string; url: string; token: string }> }>(
  settings: T
): Omit<T, 'piEndpoints'> & { piEndpoints: Array<{ id: string; label: string; url: string; token: string; hasToken: boolean }> } => ({
  ...settings,
  piEndpoints: (settings.piEndpoints ?? []).map(({ id, label, url, token }) => ({
    id,
    label,
    url,
    // Empty string, not `undefined`: the renderer's `maskToken` and its length checks expect one,
    // and `hasToken` is what a client should branch on.
    token: '',
    hasToken: Boolean(token),
  })),
});

/**
 * Endpoint tokens are desktop-only. A remote client that posts `piEndpoints` would send the
 * redacted `''` back, and `parsePiEndpoints` requires a non-empty token — so accepting the
 * field from remote would silently delete every Hearth endpoint. Strip it instead.
 */
export const withoutDesktopOnlySettings = (patch: unknown): unknown => {
  if (!patch || typeof patch !== 'object') return patch;
  const { piEndpoints: _ignored, ...rest } = patch as Record<string, unknown>;
  return rest;
};
