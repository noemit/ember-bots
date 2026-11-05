/**
 * Server-sent events from an OpenChamber instance, reduced to invalidation hints.
 *
 * Ember treats REST as the source of truth; events only say "something about session X
 * changed, go refetch". So the stream client parses SSE frames, pulls out the event type and
 * the session/directory it concerns, and drops the payload body. Two upstream streams exist:
 * OpenCode 2's `/api/event` (sessions, messages, permissions, forms, status — wrapped
 * as `{ id, created, type, location, data, durable }`) and OpenChamber's
 * `/api/notifications/stream` (auto-accept policy, scheduled tasks, `{ type, properties }`).
 *
 * One bounded exception to "bodies never cross the boundary": `describeEvent` lifts a short,
 * display-ready summary out of whitelisted milestone events, because for the activity log
 * the entry *is* the event's content. The summary rides on the `EmberEvent` so the renderer,
 * remote clients and `electron/activity.ts` all see the same string main persisted. Nothing
 * else about a payload ever crosses; message text, tool output and diffs are never extracted.
 */

export type EventSummary = {
  summary: string;
  detail?: Record<string, string>;
};

export type EmberEvent = {
  instanceId: string;
  stream: 'opencode' | 'openchamber';
  type: string;
  sessionId?: string;
  directory?: string;
  /** Stable upstream event id, or a synthesized one; de-dupes the log and keys React rows. */
  id?: string;
  /** When the event happened (the envelope's `created`), else when Ember received it. */
  at?: number;
  /** Display-ready activity line, present only for whitelisted milestone events. */
  summary?: string;
  /** Bounded scalars that qualify the summary (tool name, permission action, error, …). */
  detail?: Record<string, string>;
};

export type StreamStatus = { instanceId: string; connected: boolean };

export const STREAM_PATHS = {
  opencode: '/api/event',
  openchamber: '/api/notifications/stream',
} as const;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Upstream heartbeats every ~15-30s; past this with no bytes the socket is presumed dead. */
const STALL_MS = 90_000;
/**
 * A TCP connect that never answers (blackholed tunnel, dead VPN peer) must not hang the
 * subscription: without a deadline here the read loop never starts, the stall timer never arms
 * and no reconnect is ever scheduled.
 */
const CONNECT_TIMEOUT_MS = 20_000;

type StreamTimeouts = { connectMs: number; stallMs: number; reconnectBaseMs: number };
const DEFAULT_TIMEOUTS: StreamTimeouts = {
  connectMs: CONNECT_TIMEOUT_MS,
  stallMs: STALL_MS,
  reconnectBaseMs: RECONNECT_BASE_MS,
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/**
 * `created` → epoch ms. The envelope has carried a few spellings (ms, seconds, ISO); anything
 * implausibly old is treated as absent so the receive time is used instead.
 */
const eventTimeOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return value;
    if (value >= 1e9) return Math.round(value * 1000);
    return undefined;
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/** A scalar that may reach a log line: single-spaced, hard-capped, never multiline. */
const cap = (value: unknown, limit = 200): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, limit) : undefined;
};

const detailOf = (values: Record<string, string | undefined>): Record<string, string> | undefined => {
  const detail: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) if (value) detail[key] = value;
  return Object.keys(detail).length > 0 ? detail : undefined;
};

const sessionTitleOf = (data: Record<string, unknown>): string | undefined =>
  cap(data.title) ?? cap(asRecord(data.info).title) ?? cap(asRecord(data.session).title);

/** Bounded error text: `message` first, then the usual siblings, then one more `error` level. */
const errorTextOf = (value: unknown, depth = 0): string | undefined => {
  if (depth > 2) return undefined;
  if (typeof value === 'string') return cap(value);
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  return cap(record.message) ?? cap(record.reason) ?? cap(record.detail) ?? errorTextOf(record.error, depth + 1);
};

/** Best-effort one-liner for a tool call independent of any server-assigned title. */
const toolTitleFromInput = (input: Record<string, unknown>): string | undefined => {
  for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = cap(input[key], 160);
    if (value) return value;
  }
  return undefined;
};

const toolNameOf = (data: Record<string, unknown>): string | undefined =>
  cap(data.name, 80) ?? cap(data.tool, 80) ?? cap(data.toolName, 80);

const toolTitleOf = (data: Record<string, unknown>): string | undefined =>
  cap(asRecord(data.state).title, 160) ??
  cap(data.title, 160) ??
  cap(asRecord(data.metadata).title, 160) ??
  toolTitleFromInput(asRecord(data.input));

/** Permission payloads nest the request; some put its fields directly on the event data. */
const permissionRequestOf = (data: Record<string, unknown>): Record<string, unknown> => {
  const request = asRecord(data.request);
  return Object.keys(request).length > 0 ? request : data;
};

const modelLabelOf = (value: unknown): string | undefined => {
  const model = asRecord(value);
  const modelID = cap(model.modelID, 120) ?? cap(model.id, 120);
  if (!modelID) return undefined;
  const providerID = cap(model.providerID, 80);
  const variant = cap(model.variant, 40);
  return [providerID ? `${providerID}/${modelID}` : modelID, variant].filter(Boolean).join(' ');
};

/** Form payloads nest the form; the first field's header is the question's headline. */
const formHeaderOf = (data: Record<string, unknown>): string | undefined => {
  const form = Object.keys(asRecord(data.form)).length > 0 ? asRecord(data.form) : data;
  const direct = cap(form.header, 160) ?? cap(form.title, 160);
  if (direct) return direct;
  const firstField = asRecord(Array.isArray(form.fields) ? form.fields[0] : undefined);
  return cap(firstField.header, 160) ?? cap(firstField.title, 160);
};

/**
 * Which events become log entries — the whitelist is the whole game. Streaming chatter
 * (`session.text.delta`, `tool.progress`, `usage.updated`, …) must never flood the log, so
 * anything not listed here returns null and is never persisted. Only well-known scalars are
 * extracted; every string is capped and flattened to one line.
 */
type Describer = (data: Record<string, unknown>) => EventSummary;

const EVENT_DESCRIPTIONS: Record<string, Describer> = {
  // Lifecycle
  'session.created': (d) => ({ summary: 'created a session', detail: detailOf({ title: sessionTitleOf(d) }) }),
  'session.forked': (d) => ({ summary: 'forked a session', detail: detailOf({ title: sessionTitleOf(d) }) }),
  'session.renamed': (d) => ({ summary: 'renamed the session', detail: detailOf({ title: sessionTitleOf(d) }) }),
  'session.moved': (d) => ({
    summary: 'moved the session',
    detail: detailOf({ directory: cap(asRecord(d.location).directory, 300) ?? cap(d.directory, 300) }),
  }),
  'session.deleted': () => ({ summary: 'deleted the session' }),
  // Turns
  'session.execution.started': () => ({ summary: 'started working' }),
  'session.execution.succeeded': () => ({ summary: 'finished a turn' }),
  'session.execution.failed': (d) => ({ summary: 'turn failed', detail: detailOf({ error: errorTextOf(d.error) }) }),
  'session.execution.interrupted': () => ({ summary: 'turn interrupted' }),
  'session.idle': () => ({ summary: 'went idle' }),
  'session.error': (d) => ({ summary: 'hit an error', detail: detailOf({ error: errorTextOf(d.error) }) }),
  'session.retry.scheduled': (d) => ({
    summary: 'scheduled a retry',
    detail: detailOf({ attempt: typeof d.attempt === 'number' ? String(d.attempt) : undefined }),
  }),
  // Context
  'session.compacted': () => ({ summary: 'compacted the session' }),
  'session.compaction.ended': () => ({ summary: 'compacted the session' }),
  'session.compaction.failed': (d) => ({ summary: 'compaction failed', detail: detailOf({ error: errorTextOf(d.error) }) }),
  'session.model.selected': (d) => {
    const model = modelLabelOf(d.model) ?? modelLabelOf(d);
    return { summary: model ? `switched model to ${model}` : 'switched model' };
  },
  'session.agent.selected': (d) => {
    const agent = cap(d.agent, 80);
    return { summary: agent ? `switched agent to ${agent}` : 'switched agent' };
  },
  // Work
  'session.tool.success': (d) => {
    const name = toolNameOf(d);
    return { summary: name ? `ran ${name}` : 'ran a tool', detail: detailOf({ command: toolTitleOf(d) }) };
  },
  'session.tool.failed': (d) => {
    const name = toolNameOf(d);
    return {
      summary: name ? `${name} failed` : 'a tool failed',
      detail: detailOf({ command: toolTitleOf(d), error: errorTextOf(d.error) }),
    };
  },
  'session.shell.ended': (d) => ({ summary: 'shell command finished', detail: detailOf({ command: cap(d.command, 160) }) }),
  // Needs you
  'permission.asked': (d) => {
    const request = permissionRequestOf(d);
    return {
      summary: 'waiting for permission',
      detail: detailOf({ action: cap(request.action, 80) ?? cap(request.type, 80), message: cap(request.message, 160) }),
    };
  },
  'permission.replied': (d) => ({
    summary: 'permission answered',
    detail: detailOf({ reply: cap(d.reply, 40) ?? cap(d.decision, 40) }),
  }),
  'permission.rejected': () => ({ summary: 'permission rejected' }),
  'form.created': (d) => ({ summary: 'asked a question', detail: detailOf({ question: formHeaderOf(d) }) }),
  'form.replied': () => ({ summary: 'question answered' }),
  'form.cancelled': () => ({ summary: 'question cancelled' }),
  // Scheduled tasks and archive activity (OpenChamber's notification stream)
  'openchamber:scheduled-task-ran': (d) => ({
    summary: 'scheduled task ran',
    detail: detailOf({
      name: cap(d.name, 120) ?? cap(d.taskName, 120) ?? cap(d.taskID, 120),
      status: cap(d.status, 40) ?? cap(d.lastStatus, 40),
    }),
  }),
  'openchamber:session-created': (d) => ({ summary: 'session created', detail: detailOf({ title: sessionTitleOf(d) }) }),
  'openchamber:session-archived': () => ({ summary: 'session archived' }),
  'openchamber:notification': (d) => {
    const title = cap(d.title, 160) ?? cap(d.name, 160);
    return {
      summary: title ? `notification · ${title}` : 'notification',
      detail: detailOf({ message: cap(d.message, 200) ?? cap(d.text, 200) }),
    };
  },
};

/** A short, display-ready line for a loggable event, or null for everything else. */
export const describeEvent = (type: string, data: Record<string, unknown>): EventSummary | null =>
  EVENT_DESCRIPTIONS[type]?.(data) ?? null;

/**
 * Hearth milestone events → activity summaries. pi hints deliberately carry no payload (bodies
 * stay behind the wire), so these are type-only, generic lines; streaming deltas return null and
 * never reach the log. The vocabulary mirrors the OpenCode side so the Home screen reads the same.
 */
const PI_EVENT_DESCRIPTIONS: Record<string, EventSummary> = {
  'pi:run_start': { summary: 'started working' },
  'pi:run_end': { summary: 'finished a turn' },
};

export const describePiEvent = (type: string): EventSummary | null => PI_EVENT_DESCRIPTIONS[type] ?? null;

/**
 * One `data:` frame → event hint, or null for frames we don't care about (heartbeats,
 * stream-ready markers, malformed JSON). `now` is the receive time and only stands in for
 * `at` when the envelope carries no usable `created`.
 */
export const parseEventData = (
  instanceId: string,
  stream: EmberEvent['stream'],
  data: string,
  now: number = Date.now()
): EmberEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (stream === 'openchamber') {
    // OpenChamber's notification stream keeps its own `{ type, properties }` frames.
    const type = optionalString(root.type);
    if (!type || type.endsWith('-stream-ready') || type === 'openchamber:heartbeat') return null;
    const properties = asRecord(root.properties);
    const sessionId = optionalString(properties.sessionID) ?? optionalString(properties.sessionId);
    const directory = optionalString(properties.directory);
    const at = eventTimeOf(root.created) ?? now;
    const description = describeEvent(type, properties);
    return {
      instanceId,
      stream,
      type,
      sessionId,
      directory,
      id: optionalString(root.id) ?? `${instanceId}:${type}:${sessionId ?? ''}:${at}`,
      at,
      summary: description?.summary,
      detail: description?.detail,
    };
  }

  // OpenCode 2 flat envelope: { id, created, type, location, data, durable }. Session-scoped
  // events put `sessionID` on `data` (sometimes nested under request/form/item), and
  // `durable.aggregateID` echoes it for anything session-rooted.
  const type = optionalString(root.type);
  if (!type || type.startsWith('server.') || type === 'heartbeat') return null;
  const payload = asRecord(root.data);
  const location = asRecord(root.location);
  const durable = asRecord(root.durable);
  const aggregateId = optionalString(durable.aggregateID);
  const sessionId =
    optionalString(payload.sessionID) ??
    optionalString(payload.sessionId) ??
    optionalString(asRecord(payload.request).sessionID) ??
    optionalString(asRecord(payload.form).sessionID) ??
    optionalString(asRecord(payload.item).sessionID) ??
    optionalString(asRecord(payload.info).sessionID) ??
    optionalString(asRecord(payload.session).id) ??
    (aggregateId && aggregateId.startsWith('ses') ? aggregateId : undefined);
  const directory =
    optionalString(location.directory) ??
    optionalString(asRecord(payload.location).directory) ??
    optionalString(payload.directory);
  const at = eventTimeOf(root.created) ?? now;
  const description = describeEvent(type, payload);
  return {
    instanceId,
    stream,
    type,
    sessionId,
    directory,
    id: optionalString(root.id) ?? `${instanceId}:${type}:${sessionId ?? ''}:${at}`,
    at,
    summary: description?.summary,
    detail: description?.detail,
  };
};

/**
 * Incremental SSE frame splitter. Feed it decoded chunks; it yields the `data:` payload of
 * each complete event (multi-line data joined per spec) and keeps partial frames buffered.
 */
export class SseFrameParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) frames.push(data);
      boundary = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

type Target = { url: string; headers: Record<string, string> };

type Handlers = {
  onEvent: (event: EmberEvent) => void;
  onStatus: (status: StreamStatus) => void;
};

/** Reconnecting subscription to one stream of one instance. */
class StreamSubscription {
  private abort: AbortController | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly instanceId: string,
    private readonly stream: EmberEvent['stream'],
    private readonly resolveTarget: () => Target | null,
    private readonly handlers: Handlers,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeouts: StreamTimeouts = DEFAULT_TIMEOUTS
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Drop the live socket (or pending retry) and reconnect immediately — used when the system
   * resumes, where half-open connections would otherwise sit until the stall detector fired.
   */
  restart(): void {
    if (this.stopped) return;
    this.attempt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.abort) {
      // The aborted connect's `finally` schedules the next attempt (~1s away at attempt 0).
      this.abort.abort();
      return;
    }
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, this.timeouts.reconnectBaseMs * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const target = this.resolveTarget();
    if (!target) {
      this.scheduleReconnect();
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    // The same timer covers the connect phase (CONNECT deadline) and, once streaming, silence
    // between frames (STALL deadline).
    let stallTimer: NodeJS.Timeout | null = setTimeout(() => abort.abort(), this.timeouts.connectMs);
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abort.abort(), this.timeouts.stallMs);
    };

    try {
      const response = await this.fetchImpl(`${target.url.replace(/\/+$/, '')}${STREAM_PATHS[this.stream]}`, {
        headers: { ...target.headers, accept: 'text/event-stream', 'cache-control': 'no-cache' },
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);

      this.attempt = 0;
      this.handlers.onStatus({ instanceId: this.instanceId, connected: true });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();
      armStall();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armStall();
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          const event = parseEventData(this.instanceId, this.stream, data);
          if (event) this.handlers.onEvent(event);
        }
      }
    } catch {
      // Network errors and aborts both land here; the reconnect loop handles them.
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      if (this.abort === abort) this.abort = null;
      this.handlers.onStatus({ instanceId: this.instanceId, connected: false });
      this.scheduleReconnect();
    }
  }
}

/**
 * Keeps both streams open for every attachable instance. `sync` reconciles the set of
 * instances after each probe; targets are re-resolved on every (re)connect so a host that
 * changes URL or token in OpenChamber's settings picks that up without a restart.
 */
export class EventStreamManager {
  private readonly subscriptions = new Map<string, StreamSubscription[]>();
  private readonly connected = new Map<string, Set<EmberEvent['stream']>>();

  constructor(
    private readonly resolveTarget: (instanceId: string) => Target | null,
    private readonly handlers: Handlers,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeouts: StreamTimeouts = DEFAULT_TIMEOUTS
  ) {}

  sync(instanceIds: string[]): void {
    const wanted = new Set(instanceIds);
    for (const [instanceId, subs] of this.subscriptions) {
      if (wanted.has(instanceId)) continue;
      subs.forEach((sub) => sub.stop());
      this.subscriptions.delete(instanceId);
      this.connected.delete(instanceId);
    }
    for (const instanceId of wanted) {
      if (this.subscriptions.has(instanceId)) continue;
      const handlers: Handlers = {
        onEvent: this.handlers.onEvent,
        onStatus: () => {},
      };
      const subs = (['opencode', 'openchamber'] as const).map((stream) => {
        const sub = new StreamSubscription(
          instanceId,
          stream,
          () => this.resolveTarget(instanceId),
          {
            ...handlers,
            // An instance counts as live when its OpenCode stream is up; that's the one
            // carrying session/message traffic. The OpenChamber stream is best-effort.
            onStatus: ({ connected }) => {
              const set = this.connected.get(instanceId) ?? new Set();
              if (connected) set.add(stream);
              else set.delete(stream);
              this.connected.set(instanceId, set);
              this.handlers.onStatus({ instanceId, connected: set.has('opencode') });
            },
          },
          this.fetchImpl,
          this.timeouts
        );
        sub.start();
        return sub;
      });
      this.subscriptions.set(instanceId, subs);
    }
  }

  isConnected(instanceId: string): boolean {
    return this.connected.get(instanceId)?.has('opencode') ?? false;
  }

  /** Live status of every managed instance, for a renderer that just (re)loaded. */
  snapshot(): Record<string, boolean> {
    return Object.fromEntries([...this.subscriptions.keys()].map((id) => [id, this.isConnected(id)]));
  }

  /** Bounce every subscription — on system resume, dead sockets are dropped now, not in 90s. */
  restartAll(): void {
    for (const subs of this.subscriptions.values()) subs.forEach((sub) => sub.restart());
  }

  stopAll(): void {
    this.sync([]);
  }
}
