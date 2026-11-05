import type { EmberEvent, LiveDelta } from '../types';
import { sessionKey } from '../types';

/** A REST resource the renderer can refetch. `messages`/`messageSummary` are per session. */
export type Resource =
  | 'sessions'
  | 'states'
  | 'permissions'
  | 'questions'
  | 'queues'
  | 'autoAccept'
  | 'scheduled'
  | 'messages'
  | 'messageSummary';

/** A visible column wants a bounded tail; terminal events upgrade it to a full repair. */
export type MessageRefreshMode = 'tail' | 'full';

export type Invalidation = {
  instanceId: string;
  resource: Resource;
  sessionId?: string;
  messageMode?: MessageRefreshMode;
};

/**
 * Whether a stream hint for this session is worth a transcript fetch, or only a summary refresh.
 *
 * Two things make a session "loaded": it is on screen as a column, or it is the active session.
 * The active session is included on purpose — an active session can be off the columns briefly
 * strip (it is *not* in `columns`), yet it is still the one being watched. Gating on columns alone
 * meant the reasoning streaming into it was invisible until `run_end` forced a full read at the end
 * of the turn, which looked exactly like "live thinking doesn't work".
 *
 * A hidden window loads nothing: there is no one to see the update, and the catch-up on
 * `visibilitychange` covers what was missed.
 */
export const sessionIsLoaded = (
  ref: { instanceId: string; sessionId: string },
  columns: readonly string[],
  active: string | null,
  hidden: boolean
): boolean => {
  if (hidden) return false;
  const key = sessionKey(ref);
  return columns.includes(key) || active === key;
};

/** Bridge payloads are untrusted until they look like an event hint. */
const boundedText = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;

const boundedDetail = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const detail: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 8)) {
    const name = boundedText(key, 40);
    const text = boundedText(entry, 400);
    if (name && text) detail[name] = text;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
};

const MAX_DELTAS = 64;
const MAX_DELTA_TEXT = 8 * 1024;
const MAX_CONTENT_INDEX = 256;

/**
 * Streamed appends, or nothing.
 *
 * This rides the same untrusted bridge as everything else, and the renderer applies it straight to
 * what is on screen — so anything malformed is dropped *whole*: a partially applied frame would be a
 * message that disagrees with the host, where dropping it just takes the REST path.
 */
const parseDeltas = (value: unknown): LiveDelta[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DELTAS) return undefined;
  const deltas: LiveDelta[] = [];
  let characters = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const { index, kind, text } = entry as Record<string, unknown>;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > MAX_CONTENT_INDEX) return undefined;
    if (kind !== 'text' && kind !== 'thinking') return undefined;
    if (typeof text !== 'string' || text.length === 0) return undefined;
    characters += text.length;
    if (characters > MAX_DELTA_TEXT) return undefined;
    deltas.push({ index: index as number, kind, text });
  }
  return deltas;
};

export const parseEmberEvent = (raw: unknown): EmberEvent | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.instanceId !== 'string' || typeof value.type !== 'string') return null;
  const deltas = parseDeltas(value.deltas);
  return {
    instanceId: value.instanceId,
    type: value.type,
    ...(deltas ? { deltas } : {}),
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    directory: typeof value.directory === 'string' ? value.directory : undefined,
    connected: typeof value.connected === 'boolean' ? value.connected : undefined,
    id: boundedText(value.id, 200),
    at:
      typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0 ? value.at : undefined,
    summary: boundedText(value.summary, 400),
    detail: boundedDetail(value.detail),
  };
};

type ResourceHint = { resource: Resource; messageMode?: MessageRefreshMode };

/**
 * Anything on the OpenCode stream that isn't listed here is deliberately ignored. Message hints
 * carry a mode so a visible column can fetch a bounded tail while a terminal event upgrades the
 * pending work to a full repair. Event names are OpenCode 2's (`session.*`, `permission.*`,
 * `form.*` — forms are what the API now calls interactive questions).
 */
const OPENCODE_RESOURCES: Record<string, ResourceHint[]> = {
  'session.created': [{ resource: 'sessions' }],
  'session.updated': [{ resource: 'sessions' }],
  'session.renamed': [{ resource: 'sessions' }],
  'session.metadata.updated': [{ resource: 'sessions' }],
  'session.moved': [{ resource: 'sessions' }],
  'session.forked': [{ resource: 'sessions' }],
  'session.deleted': [{ resource: 'sessions' }],
  'session.model.selected': [{ resource: 'sessions' }],
  'session.agent.selected': [{ resource: 'sessions' }],
  'session.status': [{ resource: 'states' }],
  'session.retry.scheduled': [{ resource: 'states' }],
  'session.execution.started': [{ resource: 'states' }],
  'session.idle': [
    { resource: 'states' },
    { resource: 'sessions' },
    { resource: 'messages', messageMode: 'full' },
  ],
  'session.execution.succeeded': [
    { resource: 'states' },
    { resource: 'sessions' },
    { resource: 'messages', messageMode: 'full' },
  ],
  'session.execution.failed': [
    { resource: 'states' },
    { resource: 'messages', messageMode: 'full' },
  ],
  'session.execution.interrupted': [
    { resource: 'states' },
    { resource: 'messages', messageMode: 'full' },
  ],
  'session.error': [
    { resource: 'states' },
    { resource: 'messages', messageMode: 'full' },
  ],
  'session.compacted': [{ resource: 'messages', messageMode: 'full' }],
  'session.compaction.ended': [{ resource: 'messages', messageMode: 'full' }],
  'session.compaction.failed': [{ resource: 'messages', messageMode: 'full' }],
  'session.inbox.delivered': [{ resource: 'messages', messageMode: 'tail' }],
  'session.synthetic': [{ resource: 'messages', messageMode: 'tail' }],
  'session.usage.updated': [{ resource: 'messages', messageMode: 'tail' }],
  'session.step.streamed': [{ resource: 'messages', messageMode: 'tail' }],
  'session.step.ended': [{ resource: 'messages', messageMode: 'tail' }],
  'session.text.delta': [{ resource: 'messages', messageMode: 'tail' }],
  'session.text.ended': [{ resource: 'messages', messageMode: 'tail' }],
  'session.reasoning.delta': [{ resource: 'messages', messageMode: 'tail' }],
  'session.reasoning.ended': [{ resource: 'messages', messageMode: 'tail' }],
  'session.tool.called': [{ resource: 'messages', messageMode: 'tail' }],
  'session.tool.success': [{ resource: 'messages', messageMode: 'tail' }],
  'session.tool.failed': [{ resource: 'messages', messageMode: 'tail' }],
  'session.tool.progress': [{ resource: 'messages', messageMode: 'tail' }],
  'session.shell.ended': [{ resource: 'messages', messageMode: 'tail' }],
  'session.diff': [],
  'permission.asked': [{ resource: 'permissions' }, { resource: 'states' }],
  'permission.replied': [{ resource: 'permissions' }, { resource: 'states' }],
  'permission.rejected': [{ resource: 'permissions' }, { resource: 'states' }],
  'form.created': [{ resource: 'questions' }, { resource: 'states' }],
  'form.replied': [{ resource: 'questions' }, { resource: 'states' }],
  'form.cancelled': [{ resource: 'questions' }, { resource: 'states' }],
};

const OPENCHAMBER_RESOURCES: Record<string, ResourceHint[]> = {
  'openchamber:session-status': [{ resource: 'states' }],
  'openchamber:session-activity': [],
  'openchamber:session-created': [{ resource: 'sessions' }],
  'openchamber:session-archived': [{ resource: 'sessions' }],
  'openchamber:permission-auto-accept.updated': [{ resource: 'autoAccept' }],
  'openchamber:scheduled-task-ran': [{ resource: 'scheduled' }, { resource: 'sessions' }],
  'openchamber:notification': [],
};

/**
 * Hearth hints (the pi transition): pi events arrive as bare `pi:<type>` hints from main's
 * WebSocket subscriptions. Approvals and questions have no stream events yet — they stay
 * covered by the session poll that fetches them alongside states.
 */
const PI_RESOURCES: Record<string, ResourceHint[]> = {
  'pi:run_start': [{ resource: 'states' }],
  // A turn ending asks for a bounded tail, never a full read. The tail carries the settled message
  // and `reconcileTranscriptTail` repairs itself with one full read when it finds no overlap, so a
  // full read here bought nothing -- and it is the most expensive request Ember makes: the whole
  // conversation in one response (45MB on a real long session, over the 32MB response cap, where it
  // can never succeed and is retried on every turn).
  'pi:run_end': [
    { resource: 'states' },
    { resource: 'sessions' },
    { resource: 'messages', messageMode: 'tail' },
  ],
  'pi:turn_start': [{ resource: 'states' }],
  'pi:turn_end': [{ resource: 'messages', messageMode: 'tail' }],
  'pi:message_start': [{ resource: 'messages', messageMode: 'tail' }],
  'pi:message_update': [{ resource: 'messages', messageMode: 'tail' }],
  'pi:message_end': [{ resource: 'messages', messageMode: 'tail' }, { resource: 'sessions' }],
  'pi:tool_execution_update': [{ resource: 'messages', messageMode: 'tail' }],
  'pi:submission': [{ resource: 'sessions' }, { resource: 'states' }],
  // The inbox changed — an item was queued, placed at a boundary, or withdrawn. Refresh the queue so
  // a row leaves the list the moment it lands in the transcript, instead of waiting for a reconnect.
  'pi:inbox_update': [{ resource: 'queues' }],
  'pi:usage_changed': [{ resource: 'messageSummary' }],
  // A compaction task starting/finishing flips the summary's `compacting` flag. It also *rewrites*
  // history: the old prefix collapses into one summary entry with a fresh id, so a tail read cannot
  // see it and the column keeps showing the entries compaction removed. Only a full read can.
  'pi:compaction_start': [{ resource: 'sessions' }],
  'pi:compaction_end': [{ resource: 'sessions' }, { resource: 'messages', messageMode: 'full' }],
  'pi:tasks': [{ resource: 'states' }],
  // The stream (re)attached, or an overflow replaced what it could not deliver: the client may have
  // missed commits, so one bounded tail read makes the column agree with the host. Background
  // sessions get a summary refresh instead (see `invalidationsFor`), which is what keeps 200 watched
  // conversations from each paying a transcript read on every reconnect.
  'pi:view': [{ resource: 'states' }, { resource: 'messages', messageMode: 'tail' }],
};

/**
 * Which REST resources an event makes stale. A visible column gets a bounded message tail; the same
 * event for a background session refreshes only its compact summary, never the session list. Session
 * lifecycle events and safety polling remain the authority for list membership and ordering.
 */
export const invalidationsFor = (
  event: EmberEvent,
  isLoaded: (instanceId: string, sessionId: string) => boolean
): Invalidation[] => {
  const hints = OPENCODE_RESOURCES[event.type] ?? OPENCHAMBER_RESOURCES[event.type] ?? PI_RESOURCES[event.type];
  if (!hints) return [];
  return hints.flatMap((hint): Invalidation[] => {
    if (hint.resource !== 'messages') {
      return [{ instanceId: event.instanceId, resource: hint.resource }];
    }
    if (!event.sessionId) return [];
    if (isLoaded(event.instanceId, event.sessionId)) {
      return [
        {
          instanceId: event.instanceId,
          resource: 'messages',
          sessionId: event.sessionId,
          messageMode: hint.messageMode ?? 'tail',
        },
      ];
    }
    return [{ instanceId: event.instanceId, resource: 'messageSummary', sessionId: event.sessionId }];
  });
};

export const invalidationKey = (invalidation: Invalidation): string =>
  `${invalidation.instanceId}\u0000${invalidation.resource}\u0000${invalidation.sessionId ?? ''}`;

export type InvalidationPolicy = {
  /** Debounce before the first request for a quiet key. */
  leadMs: number;
  /** Minimum spacing between two requests for the same key. */
  minIntervalMs: number;
};

/** Per-resource defaults: a streaming tail is throttled, full repairs are prompt. */
export const defaultPolicyFor = (invalidation: Invalidation): InvalidationPolicy => {
  if (invalidation.resource === 'messages') {
    return invalidation.messageMode === 'full'
      ? { leadMs: 50, minIntervalMs: 0 }
      : { leadMs: 100, minIntervalMs: 750 };
  }
  if (invalidation.resource === 'messageSummary') return { leadMs: 150, minIntervalMs: 1000 };
  if (invalidation.resource === 'sessions') return { leadMs: 250, minIntervalMs: 2000 };
  return { leadMs: 250, minIntervalMs: 0 };
};

const mergeMode = (a?: MessageRefreshMode, b?: MessageRefreshMode): MessageRefreshMode | undefined =>
  a === 'full' || b === 'full' ? 'full' : (a ?? b);

/** Same-key invalidations only differ by message mode; a full repair must never downgrade. */
const mergeInvalidation = (current: Invalidation, incoming: Invalidation): Invalidation => {
  if (current.resource !== 'messages') return current;
  return { ...current, messageMode: mergeMode(current.messageMode, incoming.messageMode) };
};

/**
 * Coalesces bursts by instance/resource/session. A streaming turn emits a part update per token, so
 * the first hint schedules a refetch after the resource's lead time; hints that arrive during that
 * refetch fold into exactly one follow-up, which waits out the resource's minimum interval. A
 * terminal full-repair hint upgrades a pending tail rather than queuing behind it.
 */
export class InvalidationQueue {
  private readonly pending = new Map<
    string,
    { invalidation: Invalidation; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly inFlight = new Map<string, { invalidation: Invalidation; followUp: Invalidation | null }>();
  private readonly lastRunAt = new Map<string, number>();

  constructor(
    private readonly refetch: (invalidation: Invalidation) => Promise<void>,
    private readonly policyFor: (invalidation: Invalidation) => InvalidationPolicy = defaultPolicyFor
  ) {}

  push(invalidation: Invalidation): void {
    const key = invalidationKey(invalidation);
    const flight = this.inFlight.get(key);
    if (flight) {
      flight.followUp = flight.followUp
        ? mergeInvalidation(flight.followUp, invalidation)
        : invalidation;
      return;
    }
    const pending = this.pending.get(key);
    if (pending) {
      const previousMode = pending.invalidation.messageMode;
      pending.invalidation = mergeInvalidation(pending.invalidation, invalidation);
      if (previousMode !== 'full' && pending.invalidation.messageMode === 'full') {
        clearTimeout(pending.timer);
        this.schedule(key, pending.invalidation);
      }
      return;
    }
    this.schedule(key, invalidation);
  }

  private schedule(key: string, invalidation: Invalidation): void {
    const policy = this.policyFor(invalidation);
    const sinceLast = this.lastRunAt.has(key) ? Date.now() - (this.lastRunAt.get(key) ?? 0) : Infinity;
    const wait = Math.max(policy.leadMs, policy.minIntervalMs - sinceLast);
    const timer = setTimeout(() => void this.run(key), wait);
    this.pending.set(key, { invalidation, timer });
  }

  private async run(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.lastRunAt.set(key, Date.now());
    if (this.lastRunAt.size > 2000) {
      const cutoff = Date.now() - 60_000;
      this.lastRunAt.forEach((at, oldKey) => { if (at < cutoff) this.lastRunAt.delete(oldKey); });
    }
    this.inFlight.set(key, { invalidation: entry.invalidation, followUp: null });
    try {
      await this.refetch(entry.invalidation);
    } catch {
      // The refetcher reports its own errors; the queue just keeps going.
    } finally {
      const flight = this.inFlight.get(key);
      this.inFlight.delete(key);
      const followUp = flight?.followUp ?? null;
      if (followUp) this.schedule(key, followUp);
    }
  }

  clear(): void {
    this.pending.forEach((entry) => clearTimeout(entry.timer));
    this.pending.clear();
    this.lastRunAt.clear();
    // Dropping in-flight entries makes their completion skip the follow-up.
    this.inFlight.clear();
  }
}
