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

const SESSION_EXPIRED_MESSAGE = 'Your remote session has ended. Reload this page and sign in again.';
const UNREACHABLE_MESSAGE = 'Could not reach the desktop over the tailnet. Check that Tailscale is connected and Ember is running.';

const request = async (path: string, init?: RequestInit): Promise<Response> =>
  fetch(path, { ...init, credentials: 'same-origin' });

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
  const { message, code } = await errorBody(response);
  if (code === 'session-expired' || response.status === 401) {
    return new RemoteRequestError(SESSION_EXPIRED_MESSAGE, 'session-expired', response.status);
  }
  const fallback = response.status === 403
    ? 'Ember refused that request because it came from another site.'
    : `Ember refused that request (HTTP ${response.status}).`;
  return new RemoteRequestError(message || fallback, 'rejected', response.status);
};

/** One checked path for every remote call: redirects and non-2xx never reach a caller as data. */
const requestJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await request(path, init);
  } catch {
    throw new RemoteRequestError(UNREACHABLE_MESSAGE, 'unreachable');
  }
  // A followed redirect is the login page: `fetch` cannot tell us apart from data otherwise.
  if (response.redirected) {
    window.dispatchEvent(new CustomEvent(REMOTE_SESSION_EXPIRED_EVENT));
    throw new RemoteRequestError(SESSION_EXPIRED_MESSAGE, 'session-expired', response.status);
  }
  if (!response.ok) {
    const error = await failureOf(response);
    if (error.kind === 'session-expired') {
      window.dispatchEvent(new CustomEvent(REMOTE_SESSION_EXPIRED_EVENT));
    }
    throw error;
  }
  return response.json() as Promise<T>;
};

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
  capabilities: { dockIcon: false },
  listInstances: (refresh = true) => requestJson(`/remote/instances?refresh=${refresh}`),
  getSettings: () => requestJson<EmberSettings>('/remote/settings'),
  // A rejected save is an error, exactly as it is on the desktop bridge. The caller keeps the
  // settings it already had and shows the reason instead of adopting a body that is not settings.
  setSettings: (patch: EmberSettingsPatch) => requestJson<EmberSettings>('/remote/settings', jsonInit('POST', patch)),
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
    requestJson<ApiResponse>('/remote/api', jsonInit('POST', { instanceId, method, path, body })),
  piRequest: <T = unknown>(endpointId: string, path: string, init?: { method?: string; body?: unknown }) =>
    requestJson<{ ok: boolean; status: number; data: T }>('/remote/pi', jsonInit('POST', { endpointId, path, init })),
  eventStatus: () => requestJson<Record<string, boolean>>('/remote/events/status'),
  activityList: (query) => requestJson('/remote/activity/list', jsonInit('POST', query)),
  activitySearch: (query, range) => requestJson('/remote/activity/search', jsonInit('POST', { query, range })),
  activityDays: () => requestJson<string[]>('/remote/activity/days'),
  // EventSource sends the session cookie and reconnects on its own while the session is valid.
  // Once the desktop says the session is gone there is nothing to reconnect to: the login page
  // cannot be consumed by a stream, so tell the app and stop instead of retrying silently.
  onEvent: (listener) => {
    const source = new EventSource('/remote/events');
    let stopped = false;
    source.onmessage = (message) => {
      try {
        listener(JSON.parse(message.data));
      } catch {
        // A malformed frame is the relay's bug, not a reason to drop the subscription.
      }
    };
    source.onerror = () => {
      if (stopped || source.readyState !== EventSource.CLOSED) return;
      stopped = true;
      source.close();
      window.dispatchEvent(new CustomEvent(REMOTE_SESSION_EXPIRED_EVENT));
    };
    return () => {
      stopped = true;
      source.close();
    };
  },
};

window.ember = bridge;
