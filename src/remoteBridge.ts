import { installRemoteLifecycle, isRemoteExpired, reportRemoteConnection, trackRemoteRequest } from './lib/remoteLifecycle';
import { mergeDraftChanges } from './lib/composerDrafts';
import type { EmberBridge, EmberSettings, EmberSettingsPatch } from './types';

type ApiResponse = { ok: boolean; status: number; data: unknown };

/**
 * Why a remote request failed, in a form the caller can branch on.
 *
 * The old bridge did `.json()` on whatever came back. A rejected settings save is a `400` with
 * `{"error": …}`, so it *resolved* with an object that was not settings, and the settings hook
 * spread it over the defaults — the user's theme, groups, pins and notes silently reset with no
 * error shown. A 30-day-old session was worse: every GET is a `302` to the login page, so the
 * bridge parsed HTML and reported `JSON Parse error: Unrecognized token '<'`.
 */
export class RemoteRequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'session-expired' | 'rejected' | 'unreachable',
    readonly status?: number
  ) {
    super(message);
    this.name = 'RemoteRequestError';
  }
}

const SESSION_EXPIRED_MESSAGE = 'Ember ended this session. Copy any unsent text, then sign in again.';
const UNREACHABLE_MESSAGE = 'The Ember computer did not answer. Keep this app open to preserve drafts. Check your private connection and that Ember is running.';

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  if (isRemoteExpired()) throw new RemoteRequestError(SESSION_EXPIRED_MESSAGE, 'session-expired');
  return fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
};
const expire = () => {
  reportRemoteConnection('expired');
  window.dispatchEvent(new CustomEvent(REMOTE_SESSION_EXPIRED_EVENT));
};

const errorBody = async (response: Response): Promise<{ message: string; code?: string }> => {
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    return {
      message: typeof body?.error === 'string' ? body.error : '',
      code: typeof body?.code === 'string' ? body.code : undefined,
    };
  } catch {
    return { message: '' };
  }
};

const failureOf = async (response: Response): Promise<RemoteRequestError> => {
  // A relay/server error is not proof that a mutation was refused: the upstream may have
  // accepted it before the response was lost. Keep it on App's protected unconfirmed path.
  if (response.status >= 500) {
    return new RemoteRequestError(UNREACHABLE_MESSAGE, 'unreachable', response.status);
  }
  const { message, code } = await errorBody(response);
  if (code === 'session-expired' || response.status === 401) {
    return new RemoteRequestError(SESSION_EXPIRED_MESSAGE, 'session-expired', response.status);
  }
  const fallback = response.status === 403
    ? 'Ember refused a request from another site. Open Ember at its private address and try again.'
    : 'Ember could not complete that request. Try again once the computer is answering.';
  return new RemoteRequestError(message || fallback, 'rejected', response.status);
};

/** One checked path for every remote call: redirects and non-2xx never reach a caller as data. */
const readJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await request(path, init);
  } catch (error) {
    if (error instanceof RemoteRequestError) throw error;
    reportRemoteConnection(navigator.onLine === false ? 'offline' : 'unavailable');
    throw new RemoteRequestError(UNREACHABLE_MESSAGE, 'unreachable');
  }
  // Only Ember's login redirect proves expiry; a captive portal or proxy redirect does not.
  if (response.redirected) {
    if (new URL(response.url, window.location.href).pathname === '/remote/login') {
      expire();
      throw new RemoteRequestError(SESSION_EXPIRED_MESSAGE, 'session-expired', response.status);
    }
    reportRemoteConnection('unavailable');
    throw new RemoteRequestError(UNREACHABLE_MESSAGE, 'unreachable', response.status);
  }
  if (!response.ok) {
    const error = await failureOf(response);
    if (error.kind === 'session-expired') {
      expire();
    }
    if (error.kind !== 'session-expired' && response.status >= 500) reportRemoteConnection('unavailable');
    throw error;
  }
  let data: T;
  try { data = await response.json() as T; }
  catch {
    reportRemoteConnection('unavailable');
    throw new RemoteRequestError(UNREACHABLE_MESSAGE, 'unreachable', response.status);
  }
  if (isRemoteExpired()) throw new RemoteRequestError(SESSION_EXPIRED_MESSAGE, 'session-expired');
  reportRemoteConnection('online');
  return data;
};

// Requests are never replayed: a lost POST response may already have placed the message.
const requestJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const mutation = init?.method && init.method !== 'GET';
  if (mutation) trackRemoteRequest(1);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try { return await readJson<T>(path, { ...init, signal: controller.signal }); }
  finally {
    window.clearTimeout(timeout);
    if (mutation) trackRemoteRequest(-1);
  }
};
const checkedApi = async <T extends { ok: boolean; status: number },>(pending: Promise<T>): Promise<T> => {
  const result = await pending;
  if (!result.ok && (result.status === 0 || result.status >= 500)) {
    // Neither no response nor an upstream server error proves a submission was refused.
    // Throw instead of returning a failed envelope, which App would otherwise label retryable.
    // This also bypasses piApi's desktop status:0 retry: remote work is never auto-replayed.
    reportRemoteConnection('unavailable');
    throw new RemoteRequestError(UNREACHABLE_MESSAGE, 'unreachable', result.status);
  }
  return result;
};
let drafts: EmberSettings['composerDrafts'] = {};
const withMemoryDrafts = (settings: EmberSettings) => ({ ...settings, composerDrafts: drafts });

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const REMOTE_SESSION_EXPIRED_EVENT = 'ember:session-expired';

const bridge: EmberBridge = {
  getModelStats: () => requestJson('/remote/model-stats'),
  observeModels: (observations) => requestJson('/remote/model-stats', jsonInit('POST', observations)),
  clearModelStats: async () => { await requestJson('/remote/model-stats', jsonInit('DELETE')); },
  capabilities: { dockIcon: false, endpointManagement: false },
  listInstances: (refresh = true) => requestJson(`/remote/instances?refresh=${refresh}`),
  getSettings: async () => withMemoryDrafts(await requestJson<EmberSettings>('/remote/settings')),
  // A rejected save is an error, exactly as it is on the desktop bridge. The caller keeps the
  // settings it already had and shows the reason instead of adopting a body that is not settings.
  setSettings: async (patch: EmberSettingsPatch) => {
    const { composerDraftChanges, composerDrafts: _storedDrafts, ...preferences } = patch;
    drafts = mergeDraftChanges(drafts, composerDraftChanges ?? {});
    return withMemoryDrafts(await requestJson<EmberSettings>('/remote/settings', Object.keys(preferences).length ? jsonInit('POST', preferences) : undefined));
  },
  // The renderer is already a browser tab: open links in a new one. Bare host:port / www.
  // addresses get an http:// prefix; local paths can't be revealed on the remote machine,
  // so they report failure like the Electron bridge does.
  openExternal: async (target) => {
    const href = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|www\.)\S*$/i.test(target)
      ? `http://${target}`
      : target;
    if (!/^https?:\/\//i.test(href)) return false;
    return window.open(href, '_blank', 'noopener') !== null;
  },
  setAppIcon: async () => ({ ok: false, reason: 'a remote window has no icon to set' }),
  request: (instanceId: string, method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    checkedApi(requestJson<ApiResponse>('/remote/api', jsonInit('POST', { instanceId, method, path, body }))),
  piRequest: <T = unknown>(endpointId: string, path: string, init?: { method?: string; body?: unknown }) =>
    checkedApi(requestJson<{ ok: boolean; status: number; data: T }>('/remote/pi', jsonInit('POST', { endpointId, path, init }))),
  eventStatus: () => requestJson<Record<string, boolean>>('/remote/events/status'),
  activityList: (query) => requestJson('/remote/activity/list', jsonInit('POST', query)),
  activitySearch: (query, range) => requestJson('/remote/activity/search', jsonInit('POST', { query, range })),
  activityDays: () => requestJson<string[]>('/remote/activity/days'),
  // EventSource sends the session cookie. A stream failure is only a connectivity hint;
  // authenticated REST is the authority for expiry. Resume replaces stalled browser sockets.
  onEvent: (listener) => {
    let source: EventSource | undefined;
    let stopped = false;
    let generation = 0;
    const connect = () => {
      if (stopped || isRemoteExpired() || document.hidden) return;
      source?.close();
      const current = new EventSource('/remote/events');
      source = current;
      const version = ++generation;
      current.onopen = () => {
        if (source !== current) return;
        reportRemoteConnection('online');
        // This is the relay reconnect, not an upstream stream-status transition.
        window.dispatchEvent(new CustomEvent('ember:remote-resume'));
      };
      current.onmessage = (message) => {
        if (isRemoteExpired() || source !== current) return;
        try { listener(JSON.parse(message.data)); } catch { /* Ignore malformed relay frames. */ }
      };
      current.onerror = () => {
        if (stopped || source !== current) return;
        reportRemoteConnection(navigator.onLine === false ? 'offline' : 'unavailable');
        // CLOSED can also mean a network/proxy failure. Only an authenticated REST answer
        // proves expiry. Native EventSource handles CONNECTING retries without duplicating it.
        void requestJson('/remote/events/status').catch(() => {});
        if (current.readyState === EventSource.CLOSED) {
          window.setTimeout(() => { if (!stopped && generation === version) connect(); }, 3000);
        }
      };
    };
    const resume = () => { if (!document.hidden) connect(); };
    const offline = () => reportRemoteConnection('offline');
    const stopExpired = () => { generation++; source?.close(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    window.addEventListener(REMOTE_SESSION_EXPIRED_EVENT, stopExpired);
    connect();
    return () => {
      stopped = true;
      generation++;
      source?.close();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
      window.removeEventListener(REMOTE_SESSION_EXPIRED_EVENT, stopExpired);
    };
  },
};

installRemoteLifecycle();
window.ember = bridge;
