/**
 * Hearth transport for the pi transition: the endpoints come
 * from Ember's own settings (`piEndpoints`), every request carries the endpoint's bearer
 * token, and WebSocket streams become invalidation hints on the existing `ember:event`
 * channel — REST stays the source of truth, so pi events carry no payloads, just
 * `pi:<event.type>` keyed by the endpoint as the instance id. Milestone types additionally
 * carry a bounded, display-ready `summary` (see `describePiEvent`) for the activity log.
 *
 * A conversation's events stream re-snapshots on reconnect (late join), so a dropped socket
 * heals by itself; the conversation watch set refreshes from `GET /conversations` whenever
 * endpoints sync (the 60s instance watchdog drives that).
 */
import type { PiEndpoint } from './transport';
import { WebSocket } from 'undici';
import { connectionFailure, connectionMessage, piConnectionHeaders, testPiEndpoint } from './piConnection';
import { describePiEvent } from './eventStream';
import {
  freshBackoff,
  noteClosed,
  noteOpened,
  reconnectDelay,
  type StreamBackoff,
} from './streamBackoff';

/**
 * Full-transcript reads are the slow ones: a long session is 900KB+ of entries and the mapping pass
 * over ~950 of them is real work. 20s was tight enough that the biggest, busiest sessions — exactly
 * the ones you click first — timed out and reported "couldn't reach this session" while the host was
 * perfectly healthy. The timeout is a backstop against a hung socket, not a performance budget, so it
 * is generous; the tail read in `piLoadMessageTail` is what keeps opening a session fast.
 */
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * How many recent idle conversations are watched alongside the open/on-screen and busy ones.
 *
 * Each open WebSocket stream pins a mount on the host; watching all 200 conversations held ~275 MB
 * of active entries on a 168-conversation host while the 12 most recent held ~20 MB. Watching
 * `on-screen ∪ busy ∪ the N most recent` keeps live streaming for everything active or recent while
 * older idle conversations refresh by poll.
 */
export const RECENT_WATCHED_CONVERSATIONS = 16;
export const MAX_WATCHED_CONVERSATIONS = 64;
/**
 * Ceiling on the sockets this client holds for one endpoint: the watch set plus the task stream.
 *
 * Subscriptions are one socket each, so this should never bind — which is the point. Every stream
 * is a mount on the host, and a client that leaks sockets takes the host's descriptor table down
 * with it: on 2026-11-05 a client against Hearth held ~4600 open connections, and the host's
 * `/health` started timing out before `systemd-oomd` killed it. A bug here must cost a retry, not
 * the host, so the cap turns it into exactly one.
 */
export const MAX_SOCKETS_PER_ENDPOINT = MAX_WATCHED_CONVERSATIONS + 2;
const CONNECT_TIMEOUT_MS = 20_000;

export type WatchableConversation = {
  id: number;
  busy?: boolean;
  compacting?: boolean;
  needsInput?: boolean;
  archived?: number;
};

/**
 * Select the conversation IDs to watch over WebSocket for one endpoint:
 *   `open/on-screen ∪ busy/compacting/needsInput ∪ the N most recent non-archived`
 * Preserves the host's newest-first ordering and caps at `maxTotal`. Pure and unit-tested.
 */
export const selectWatchedConversationIds = (
  conversations: readonly WatchableConversation[],
  options: {
    openIds?: ReadonlySet<number>;
    recentLimit?: number;
    maxTotal?: number;
  } = {}
): number[] => {
  const openIds = options.openIds ?? new Set<number>();
  const recentLimit = Math.max(1, options.recentLimit ?? RECENT_WATCHED_CONVERSATIONS);
  const maxTotal = Math.max(recentLimit, options.maxTotal ?? MAX_WATCHED_CONVERSATIONS);

  const selected = new Set<number>();
  let recentCount = 0;

  for (const conv of conversations) {
    if (!Number.isInteger(conv.id)) continue;
    const isOpen = openIds.has(conv.id);
    const isBusy = conv.busy === true || conv.compacting === true || conv.needsInput === true;
    const isActiveRecent = !conv.archived && recentCount < recentLimit;

    if (!conv.archived) {
      recentCount += 1;
    }

    if (isOpen || isBusy || isActiveRecent) {
      selected.add(conv.id);
      if (selected.size >= maxTotal) break;
    }
  }

  return [...selected];
};


/**
 * Hearth's stream frames (Hearth 0.41.0, pi-durable 1.5.0).
 *
 * The event protocol (`message_update`, `turn_end`, …) is gone: a stream now carries **state** — the
 * live view on attach, then only what moved. Four frame kinds, and each maps onto a hint the renderer
 * already understands, so the invalidation table did not have to learn a second vocabulary:
 *
 * - `view` — the live documents on attach (or after an overflow). A tail read makes the column agree
 *   with it, which is also the repair for anything an overflow skipped.
 * - `text` — appends to the in-flight answer, already reduced by the host: no `changes` to interpret.
 * - `appended` — entries that landed.
 * - `changed` — a document or the conversation moved; `kinds` says which, and each kind is a hint
 *   with the same weight the old event had.
 */
const HINT_FOR_KIND: Record<string, string> = {
  live: 'pi:tool_execution_update',
  run_start: 'pi:run_start',
  run_end: 'pi:run_end',
  run_failure: 'pi:run_end',
  compaction: 'pi:compaction_end',
  inbox: 'pi:inbox_update',
  agent: 'pi:submission',
  usage: 'pi:usage_changed',
  conversation: 'pi:submission',
  provider: 'pi:submission',
  entries: 'pi:message_end',
  unknown: 'pi:tool_execution_update',
};

/** Past this much text, one REST read is cheaper than carrying the deltas to the renderer. */
const DELTA_FRAME_BUDGET = 8 * 1024;

export type PiDelta = { index: number; kind: 'text' | 'thinking'; text: string };

/**
 * Frames → hints. Pure, so the mapping is testable without a socket: the transport's whole job is
 * this table, and a wrong entry here is a column that stops updating or one that re-reads on every
 * token.
 */
export type PiHint = {
  instanceId: string;
  type: `pi:${string}`;
  sessionId?: string;
  /** Present only when the frame reduced to pure appends; absent means "ask REST". */
  deltas?: PiDelta[];
  /** Milestone hints carry a bounded, display-ready summary so they become activity entries. */
  at?: number;
  summary?: string;
  detail?: Record<string, string>;
};

export const framesToHints = (instanceId: string, sessionId: string, message: string): PiHint[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return [];
  }
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const hints: PiHint[] = [];
  for (const entry of frames) {
    const frame = entry as { type?: unknown; deltas?: unknown; kinds?: unknown } | null;
    const type = typeof frame?.type === 'string' ? frame.type : '';
    if (type === 'view') {
      hints.push({ instanceId, type: 'pi:view', sessionId, at: Date.now() });
      continue;
    }
    if (type === 'text') {
      const deltas: PiDelta[] = [];
      let characters = 0;
      // The host sends the appends it derived from the watch's ops; anything malformed is dropped
      // rather than guessed at, which sends the renderer down its REST path instead.
      for (const value of Array.isArray(frame?.deltas) ? frame.deltas : []) {
        const delta = value as { index?: unknown; kind?: unknown; text?: unknown } | null;
        if (!delta || !Number.isInteger(delta.index) || typeof delta.text !== 'string') continue;
        if (delta.kind !== 'text' && delta.kind !== 'thinking') continue;
        if (delta.text.length === 0) continue;
        characters += delta.text.length;
        if (characters > DELTA_FRAME_BUDGET) {
          deltas.length = 0;
          break;
        }
        deltas.push({ index: delta.index as number, kind: delta.kind, text: delta.text });
      }
      hints.push({
        instanceId,
        type: 'pi:message_update',
        sessionId,
        at: Date.now(),
        ...(deltas.length > 0 ? { deltas } : {}),
      });
      continue;
    }
    if (type === 'appended') {
      hints.push({ instanceId, type: 'pi:message_end', sessionId, at: Date.now() });
      continue;
    }
    if (type === 'changed') {
      const kinds = Array.isArray(frame?.kinds) ? frame.kinds.filter((kind) => typeof kind === 'string') : [];
      const seen = new Set<string>();
      for (const kind of kinds) {
        const mapped = (HINT_FOR_KIND[kind as string] ?? HINT_FOR_KIND.unknown) as PiHint['type'];
        if (seen.has(mapped)) continue;
        seen.add(mapped);
        const summary = describePiEvent(mapped);
        hints.push({
          instanceId,
          type: mapped,
          sessionId,
          at: Date.now(),
          ...(summary ? { summary: summary.summary, ...(summary.detail ? { detail: summary.detail } : {}) } : {}),
        });
      }
    }
  }
  return hints;
};

export type PiOutbound =
  | PiHint
  | { instanceId: string; type: 'ember:stream-status'; connected: boolean };

type Broadcaster = (event: PiOutbound) => void;

type Subscription = {
  url: string;
  socket?: InstanceType<typeof WebSocket>;
  timer?: ReturnType<typeof setTimeout>;
  /**
   * Retry history, forgiven only by a **stable** connection (see streamBackoff). It used to be a
   * bare counter reset on open, which made an accept-then-close server a reconnect storm.
   */
  backoff: StreamBackoff;
  stopped: boolean;
};

const readResponseText = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Response body is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Response body is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
};

export class PiClient {
  private readonly endpoints = new Map<string, PiEndpoint>();
  private readonly conversations = new Map<string, Subscription>();
  private readonly tasks = new Map<string, Subscription>();
  private readonly broadcast: Broadcaster;
  private readonly resolveEndpoint?: (endpointId: string) => PiEndpoint | undefined;
  private readonly resolveOpenIds?: (endpointId: string) => ReadonlySet<number>;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** Open sockets per endpoint, so liveness is "any socket up" rather than one special socket. */
  private readonly openSockets = new Map<string, number>();
  /**
   * Sockets held per endpoint, counting the ones still connecting. This is the number
   * `MAX_SOCKETS_PER_ENDPOINT` bounds, and it is deliberately separate from `openSockets`: a
   * socket that never finishes its handshake costs the host a descriptor without ever counting as
   * open, which is how a leak stays invisible to liveness.
   */
  private readonly sockets = new Map<string, number>();
  /** Last liveness told to the renderer, so a change is announced exactly once. */
  private readonly live = new Map<string, boolean>();
  private readonly maxSockets: number;

  constructor(
    broadcast: Broadcaster,
    resolveEndpoint?: (endpointId: string) => PiEndpoint | undefined,
    resolveOpenIds?: (endpointId: string) => ReadonlySet<number>,
    options: { maxSocketsPerEndpoint?: number } = {}
  ) {
    this.broadcast = broadcast;
    this.resolveEndpoint = resolveEndpoint;
    this.resolveOpenIds = resolveOpenIds;
    // Injectable so the ceiling itself can be tested; the shipped value is the watch set's size.
    this.maxSockets = Math.max(1, options.maxSocketsPerEndpoint ?? MAX_SOCKETS_PER_ENDPOINT);
  }

  /** Reconcile the endpoint set (settings may have changed) and refresh watches. */
  async syncEndpoints(endpoints: readonly PiEndpoint[]): Promise<void> {
    const wanted = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const [id, endpoint] of wanted) {
      const prev = this.endpoints.get(id);
      if (prev && (prev.url.replace(/\/+$/, '') !== endpoint.url.replace(/\/+$/, '') || prev.token !== endpoint.token || JSON.stringify(prev.access) !== JSON.stringify(endpoint.access))) {
        this.dropEndpoint(id);
      }
      this.endpoints.set(id, endpoint);
    }
    for (const id of [...this.endpoints.keys()]) {
      if (!wanted.has(id)) {
        this.endpoints.delete(id);
        this.dropEndpoint(id);
      }
    }
    await Promise.all([...wanted.keys()].map((id) => this.refreshConversationWatches(id)));
    if (wanted.size > 1) {
      void this.pushPeerLists([...wanted.values()]);
    }
    // A conversation created after this sync would otherwise have no event stream until the
    // next instance probe (60s). Refresh the watch set on a short timer so new conversations
    // start streaming promptly.
    if (!this.watchTimer && wanted.size > 0) {
      this.watchTimer = setInterval(() => {
        void Promise.all([...this.endpoints.keys()].map((id) => this.refreshConversationWatches(id)));
      }, 15_000);
      this.watchTimer.unref?.();
    }
  }

  /**
   * Push the peer list into each configured endpoint (`PUT /directory/peers`) so `agents directory`
   * and `agents send` federate host-to-host even when Ember is closed afterwards.
   */
  private async pushPeerLists(endpoints: readonly PiEndpoint[]): Promise<void> {
    await Promise.all(
      endpoints.map(async (target) => {
        const peers = endpoints
          .filter((other) => other.id !== target.id && other.url !== target.url && !other.access)
          .map((other) => ({
            id: other.id,
            label: other.label || other.id,
            url: other.url,
            token: other.token,
          }));
        await this.request(target.id, '/directory/peers', {
          method: 'PUT',
          body: { peers, merge: true },
        }).catch(() => null);
      })
    );
  }

  private dropEndpoint(id: string): void {
    const prefix = `events:${id}:`;
    for (const key of [...this.conversations.keys()]) {
      if (key.startsWith(prefix)) this.stopSubscription(this.conversations, key);
    }
    this.stopSubscription(this.tasks, `tasks:${id}`);
  }

  private stopSubscription(store: Map<string, Subscription>, key: string): boolean {
    const subscription = store.get(key);
    if (!subscription) return false;
    subscription.stopped = true;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.socket?.close();
    store.delete(key);
    return true;
  }

  /** Verify Kiln identity and authenticated readiness, not just a successful HTTP page. */
  async probe(endpoint: PiEndpoint): Promise<{ healthy: boolean; version?: string; commit?: string }> {
    const result = await testPiEndpoint(endpoint);
    return { healthy: result.outcome === 'ready', version: result.version, commit: result.commit };
  }

  /** Authenticated REST proxy for the renderer; error shape matches `ember:api`. */
  async request(
    endpointId: string,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    // A just-added endpoint may not be in the synced map yet; read the current settings.
    const endpoint = this.endpoints.get(endpointId) ?? this.resolveEndpoint?.(endpointId);
    const label = endpoint?.label ?? endpointId;
    if (!endpoint) {
      return {
        ok: false,
        status: 0,
        data: { error: `${label} is not configured in Ember settings — check the endpoint and retry.`, source: 'ember' },
      };
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      return { ok: false, status: 400, data: { error: 'Invalid request method' } };
    }
    if (!path.startsWith('/') || path.includes('..')) {
      return { ok: false, status: 400, data: { error: 'Invalid request path' } };
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        return { ok: false, status: 413, data: { error: 'Request body is too large' } };
      }
    }
    try {
      const response = await fetch(`${endpoint.url.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          ...piConnectionHeaders(endpoint),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await readResponseText(response);
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        const seconds = Math.round(REQUEST_TIMEOUT_MS / 1000);
        return {
          ok: false,
          status: 0,
          data: {
            error: `Ember timed out after ${seconds}s waiting for ${label} (Ember → Hearth). It may still be working — retry.`,
            source: 'ember',
          },
        };
      }
      return {
        ok: false,
        status: 0,
        data: { error: connectionMessage(label, connectionFailure(error)), source: 'ember' },
      };
    }
  }

  /**
   * One socket opened or closed for an endpoint; announce the endpoint's liveness when the verdict
   * changes. Liveness is "at least one socket is up", not "the task socket is up": a host without
   * `/tasks/stream` still reports live while its conversation streams work.
   */
  private setSocketOpen(endpointId: string, delta: 1 | -1): void {
    const count = Math.max(0, (this.openSockets.get(endpointId) ?? 0) + delta);
    if (count === 0) this.openSockets.delete(endpointId);
    else this.openSockets.set(endpointId, count);
    const connected = count > 0;
    if (this.live.get(endpointId) === connected) return;
    this.live.set(endpointId, connected);
    this.broadcast({ instanceId: endpointId, type: 'ember:stream-status', connected });
  }

  /**
   * Liveness per endpoint, for `ember:events:status`. The renderer asks once when it mounts, so a
   * window opened long after the sockets came up still starts with the truth instead of polling at
   * the dead-instance cadence until the next reconnect.
   */
  status(): Record<string, boolean> {
    return Object.fromEntries(this.live);
  }

  /**
   * Sockets currently held for an endpoint, for tests and for a future status line. Kept in step
   * with the cap in `subscribe`, so "more than the watch set" is visible before it is a flood.
   */
  socketCount(endpointId: string): number {
    return this.sockets.get(endpointId) ?? 0;
  }

  /** Subscribe to one conversation's events (idempotent); reconnects with backoff. */
  private watchConversation(endpointId: string, conversationId: number): void {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return;
    const key = `events:${endpointId}:${conversationId}`;
    if (this.conversations.has(key)) return;
    this.conversations.set(key, this.subscribe(endpointId, `${endpoint.url.replace(/\/+$/, '')}/conversations/${conversationId}/events`, (message) => {
      this.forwardEvents(endpointId, String(conversationId), message);
    }));
  }

  /** Subscribe to the endpoint's live task graph (one socket per endpoint). */
  private watchTasks(endpointId: string): void {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return;
    const key = `tasks:${endpointId}`;
    if (this.tasks.has(key)) return;
    this.tasks.set(
      key,
      this.subscribe(endpointId, `${endpoint.url.replace(/\/+$/, '')}/tasks/stream`, () => {
        this.broadcast({ instanceId: endpointId, type: 'pi:tasks' });
      })
    );
  }

  /** Refresh the conversation watch set from the conversation list. */
  private async refreshConversationWatches(endpointId: string): Promise<void> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return;
    this.watchTasks(endpointId);
    const prefix = `events:${endpointId}:`;
    const page = await this.request(endpointId, '/conversations');
    if (!page.ok || !Array.isArray((page.data as { conversations?: unknown })?.conversations)) return;
    const conversations = (page.data as { conversations: WatchableConversation[] }).conversations ?? [];
    const openIds = this.resolveOpenIds?.(endpointId);
    const ids = selectWatchedConversationIds(conversations, { openIds });
    const wanted = new Set(ids.map((id) => `${prefix}${id}`));
    for (const key of [...this.conversations.keys()]) {
      if (key.startsWith(prefix) && !wanted.has(key)) {
        this.stopSubscription(this.conversations, key);
      }
    }
    ids.forEach((id) => this.watchConversation(endpointId, id));
  }

  /** stream frames → invalidation hints; bodies stay behind the wire. */
  private forwardEvents(endpointId: string, conversationId: string, message: string): void {
    for (const hint of framesToHints(endpointId, conversationId, message)) {
      this.broadcast(hint);
    }
  }

  /** A reconnecting WebSocket subscription with jittered backoff. */
  private subscribe(endpointId: string, url: string, onMessage: (message: string) => void): Subscription {
    const subscription: Subscription = { url, backoff: freshBackoff(), stopped: false };
    const connect = () => {
      if (subscription.stopped) return;
      const held = this.sockets.get(endpointId) ?? 0;
      if (held >= this.maxSockets) {
        // Retry later rather than pile on. The watch set is already smaller than the cap, so being
        // here means sockets are not being released — one more will not help and may be the one
        // that takes the host down.
        console.error(
          `[ember] ${endpointId}: holding ${held} streams, at the ${this.maxSockets} cap — waiting before opening another.`
        );
        subscription.backoff = noteClosed(subscription.backoff);
        subscription.timer = setTimeout(connect, reconnectDelay(subscription.backoff));
        return;
      }
      this.sockets.set(endpointId, held + 1);
      const endpoint = this.endpoints.get(endpointId);
      if (!endpoint) {
        this.sockets.set(endpointId, Math.max(0, held));
        return;
      }
      // Undici's WebSocket handshake uses redirect:error; neither Access nor bearer credentials
      // can follow a proxy redirect. Browser WebSocket cannot supply these separate headers.
      let headers: Record<string, string>;
      try {
        headers = piConnectionHeaders(endpoint);
      } catch {
        // Locked/missing Access credentials need a settings edit, not a bearer-only retry.
        this.sockets.set(endpointId, Math.max(0, held));
        return;
      }
      const socket = new WebSocket(url.replace(/^http/, 'ws'), { headers });
      subscription.socket = socket;
      // Per-socket, so a stop before the socket ever opened cannot unbalance the endpoint's count.
      let opened = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        if (!opened && !subscription.stopped) {
          socket.close();
        }
      }, CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
      socket.onopen = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        opened = true;
        // Not a reason to forgive the backoff: a server may accept and close immediately.
        subscription.backoff = noteOpened(subscription.backoff);
        this.setSocketOpen(endpointId, 1);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') onMessage(event.data);
      };
      socket.onclose = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        // Released here, once per socket, whether or not it ever opened.
        this.sockets.set(endpointId, Math.max(0, (this.sockets.get(endpointId) ?? 1) - 1));
        if (opened) {
          opened = false;
          this.setSocketOpen(endpointId, -1);
        }
        if (subscription.stopped) return;
        subscription.backoff = noteClosed(subscription.backoff);
        subscription.timer = setTimeout(connect, reconnectDelay(subscription.backoff));
      };
      socket.onerror = () => {
        socket.close();
      };
    };
    connect();
    return subscription;
  }

  /** Close and reconnect active WebSocket subscriptions, and re-query watched conversations. */
  restartAll(): void {
    const restartSubscription = (subscription: Subscription | undefined) => {
      if (!subscription || subscription.stopped) return;
      if (subscription.timer) {
        clearTimeout(subscription.timer);
        subscription.timer = undefined;
      }
      subscription.backoff = freshBackoff();
      subscription.socket?.close();
    };
    for (const subscription of this.conversations.values()) restartSubscription(subscription);
    for (const subscription of this.tasks.values()) restartSubscription(subscription);
    for (const id of this.endpoints.keys()) {
      void this.refreshConversationWatches(id);
    }
  }

  closeAll(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    [...this.conversations.keys()].forEach((key) => this.stopSubscription(this.conversations, key));
    [...this.tasks.keys()].forEach((key) => this.stopSubscription(this.tasks, key));
  }
}
