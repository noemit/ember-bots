/**
 * Pure mappers from the Hearth wire (see hearth's README) onto Ember's session shapes,
 * so the transition's renderer mapping lives in one testable place. Nothing here touches
 * the bridge; pi snapshots arrive as plain JSON and leave as Ember types.
 *
 * Wire shapes worth remembering: conversation/entry/submission ids are numbers on the
 * wire; the snapshot's entries are chronological; `pi.tool-result` entries carry their
 * matching call's id, so a result merges into the assistant message that made the call;
 * `pi.live` (in the snapshot's docs) holds the in-flight generation and running tool slots.
 */
import { REASONING_OFF } from './modelSelection';
import { describeTurnFailure, readTurnFailure } from './turnFailure';
import { imageContentDigest } from './imageIdentity';
import type {
  ChatMessage,
  FileAttachment,
  MessagePart,
  ModelOption,
  NestedToolCall,
  PermissionRequest,
  QuestionRequest,
  QueuedMessage,
  Session,
  TokenUsage,
  ToolCall,
  ToolStatus,
} from '../types';

// ---- Conversations -------------------------------------------------------------------

/** One process a session's commands left running (Hearth's `processes` field). */
export type PiLeftProcess = {
  pid: number;
  command: string;
  rssBytes: number;
  /** Epoch ms when it started. */
  startedAt: number;
};

/** A program a session left running, as the session list carries it. */
export type PiConversationProcesses = {
  /** The real total; `items` is only the heaviest few. */
  count: number;
  rssBytes: number;
  items: PiLeftProcess[];
};

/** What a stop did to one process. `refused` means it took SIGTERM and is still there. */
export type PiProcessStopOutcome = 'stopped' | 'gone' | 'refused';

export type PiProcessStopResult = {
  pid: number;
  command?: string;
  outcome: PiProcessStopOutcome;
};

/** The machine's memory, with the level a client renders. */
export type PiHostMemory = {
  totalBytes: number;
  availableBytes: number;
  level: 'normal' | 'low' | 'critical';
};

export type PiConversationSummary = {
  id: number;
  parent?: { conversationId: number; at: number };
  owner?: { conversationId: number; taskId: number };
  cwd?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  title?: string;
  archived?: number;
  lastEntryId?: number;
  updatedAt?: number;
  /** USD this conversation has spent (Hearth sums its own `pi.usage` ledger). */
  cost?: number;
  /** True while the conversation has a run in flight. */
  busy?: boolean;
  /** Server-side YOLO policy for this conversation (Hearth exposes it on the summary). */
  autoAccept?: boolean;
  /** Current context snapshot; absent on older hosts, not the usage ledger. */
  currentContextTokens?: number;
  currentContextEpoch?: string;
  /** True while a compaction task (manual/threshold/overflow) is in flight. */
  compacting?: boolean;
  /** The newest compaction failure (`pi.live.compactionFailure`). */
  compactionFailure?: {
    taskId?: number;
    trigger?: string;
    error: string;
  };
  /** Coagent role: a hidden crew `worker`, or an addressable `peer`. Absent on plain sessions. */
  kind?: 'worker' | 'peer';
  /** The immediate leader, with `host` (`"local"` in Phase 1). Workers carry it; peers keep it as history. */
  lead?: { conversationId: number; host: string };
  /** Stable actual requester; level-2 siblings may be requested by another worker. */
  creatorId?: number;
  /** Set on a worker once a human promoted it; the peer conversation's id (the fork). */
  promotedTo?: number;
  /** Hearth-computed: a pending approval or question exists (so the strip needs no extra reads). */
  needsInput?: boolean;
  /** Whether the conversation offers the `session` tool + leader section. */
  delegates?: boolean;
  /** Programs this session's commands left running. Absent when there are none (or no such host). */
  processes?: PiConversationProcesses;
};

export const piConversationToSession = (
  endpointId: string,
  conversation: PiConversationSummary,
  fallbackAt = 0
): Session => ({
  id: String(conversation.id),
  instanceId: endpointId,
  title: conversation.title,
  directory: conversation.cwd,
  updated: conversation.updatedAt ?? fallbackAt,
  archived: conversation.archived,
  cost: conversation.cost,
  model: conversation.model
    // Kiln resolves an unset conversation thinking level to off (pi-durable's agent resolver).
    // This describes the current configuration only; historical messages use their own metadata.
    ? { providerID: conversation.model.provider, modelID: conversation.model.modelId, variant: conversation.thinkingLevel ?? REASONING_OFF }
    : undefined,
  // Task-owned conversations are Hearth's subagents; forks are standalone.
  parentId: conversation.owner ? String(conversation.owner.conversationId) : undefined,
  // Crew membership is its own field: `kind` hides workers, `lead` ties them to a leader. The
  // host is dropped (Phase 1 is local; the leader's session id is what Ember routes with).
  kind: conversation.kind,
  lead: conversation.lead
    ? { instanceId: endpointId, sessionId: String(conversation.lead.conversationId) }
    : undefined,
  creator: typeof conversation.creatorId === 'number' && Number.isSafeInteger(conversation.creatorId)
    ? { instanceId: endpointId, sessionId: String(conversation.creatorId) }
    : undefined,
  // Set once a human promotes the worker; the peer conversation id, stringified like `id`.
  promotedTo: conversation.promotedTo !== undefined ? String(conversation.promotedTo) : undefined,
  needsInput: conversation.needsInput === true,
  delegates: conversation.delegates === true,
  currentContextTokens:
    typeof conversation.currentContextTokens === 'number' && Number.isFinite(conversation.currentContextTokens) && conversation.currentContextTokens >= 0
      ? conversation.currentContextTokens
      : undefined,
  currentContextEpoch: typeof conversation.currentContextEpoch === 'string' ? conversation.currentContextEpoch : undefined,
  compacting: conversation.compacting === true,
  compactionFailure:
    conversation.compactionFailure && typeof conversation.compactionFailure.error === 'string'
      ? conversation.compactionFailure
      : undefined,
  // The newest entry id is what lets Home answer "could this hold anything unread?" for free.
  lastEntryId: typeof conversation.lastEntryId === 'number' ? conversation.lastEntryId : undefined,
  // Only when the host says there are some: an absent field renders nothing, which is what an
  // ordinary session should do.
  processes: conversation.processes && conversation.processes.count > 0 ? conversation.processes : undefined,
});

/**
 * The host entry ordinal behind a message id, or null where the wire mints none.
 *
 * Hearth ids are `e<entryId>` and entry ids only grow within a conversation, so the ordinal is the
 * ordering read state needs: "read through 41" says everything a scalar can say, and it stays one
 * number however long the conversation gets.
 */
export const entryOrdinal = (messageId: string): number | null => {
  const match = /^e(\d+)$/.exec(messageId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

// ---- Transcript -----------------------------------------------------------------------

type PiBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  /** Image content (the `view` tool, MCP screenshots): base64 data + mime type. */
  data?: string;
  mimeType?: string;
};

type PiUsage = {
  input?: number;
  output?: number;
  /** Hearth reports cache counters flat, not nested. */
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { total?: number };
};

export type PiMessage = {
  role?: string;
  /** User messages carry a plain string for text-only input; assistant/tool messages are block arrays. */
  content?: PiBlock[] | string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  cost?: { total?: number };
  stopReason?: string;
  rawStopReason?: string;
  /**
   * The Pi thinking level the agent loop requested for this response (`off | minimal | low | medium
   * | high | xhigh | max`). This is what the footer shows, so a finished turn reports the level it
   * actually ran at rather than whatever the composer is set to now.
   */
  thinkingLevel?: string;
  /**
   * The provider-native effort level the response used (`"high"`, or a provider's own spelling).
   * pi-ai's own provider adapters stamp this; the Pi-level field above is only stamped by an agent
   * loop, so this is the fallback and, on a host driven by pi-durable's generation loop, often the
   * only one of the two that is populated.
   */
  providerThinkingLevel?: string;
  /** The provider's own error, e.g. `429: {"message":"…","type":"…"}`. Absent on a good turn. */
  errorMessage?: string;
  timestamp?: number;
  /**
   * Milliseconds from `timestamp` until the response ended, measured with a monotonic clock. pi-ai's
   * `AssistantMessageEventStream` stamps it on the terminal message, so it persists with the entry.
   * Absent on messages written before the field existed, and on the live slot mid-turn.
   */
  durationMs?: number;
  /** On tool-result entries: the call this result settles. */
  toolCallId?: string;
  isError?: boolean;
  /**
   * On tool-result entries: what the tool reported beyond its text. A `codemode` result carries
   * `{ calls, fullOutputPath }` here — the script's nested calls, listed once it has settled.
   */
  details?: unknown;
};

/** pi-ai user content is `string | (TextContent | ImageContent)[]`; normalize to blocks. */
const blocksOf = (content: PiBlock[] | string | undefined): PiBlock[] => {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content : [];
};

/** A display name for an image content block: tool screenshots, or an image the human attached. */
const imageFilename = (mimeType: string, base = 'screenshot'): string =>
  `${base}.${mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`;

/** Image blocks as Ember attachments, in the order they were sent. */
const imageAttachmentsOf = (blocks: readonly PiBlock[], base?: string): FileAttachment[] =>
  blocks.flatMap((block) =>
    block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
      ? [
          {
            filename: imageFilename(block.mimeType, base),
            mime: block.mimeType,
            url: `data:${block.mimeType};base64,${block.data}`,
            contentDigest: imageContentDigest(block.mimeType, block.data),
          },
        ]
      : []
  );

export type PiEntry = {
  id: number;
  kind: string;
  model?: PiMessage[];
  /** Some hosts nest the tool result's payload outside the message (`entry.data.details`). */
  data?: { details?: unknown };
};

export type PiToolSlot = {
  callId?: string;
  name?: string;
  status?: 'pending' | 'running' | 'done';
  output?: string;
  details?: unknown;
};

/**
 * One nested call as the host reports it, in either of the two shapes it uses: a `pi.live` slot
 * (`callId` `"<parent>/<key>"`, `arguments`, `summary`), or an entry of a settled
 * `details.calls` list (`id`, `name`, `args`, `status`, `durationMs`, `error`).
 */
export type PiNestedToolSlot = {
  /** Settled list: the VM's number for the call. */
  id?: number | string;
  /** Live slot: `"<parentCallId>/<key>"`. */
  callId?: string;
  parentCallId?: string;
  name?: string;
  args?: unknown;
  arguments?: unknown;
  status?: 'pending' | 'running' | 'done' | 'ok' | 'error' | 'cancelled';
  durationMs?: number;
  output?: string;
  error?: string;
  /** Live slot: how the call ended, once it has. */
  summary?: { isError?: boolean; durationMs?: number; error?: string };
};

/**
 * `nestedTools` arrives as an array of live slots (`NestedToolSlot[]` in pi-durable 1.4.0), and as
 * a keyed map in some payloads: `{ [parentCallId]: { [key]: slot } | slot[] }`. Both normalize.
 */
export type PiNestedTools =
  | PiNestedToolSlot[]
  | Record<string, PiNestedToolSlot | PiNestedToolSlot[] | Record<string, PiNestedToolSlot>>;

export type PiLive = {
  run?: { inputs?: number[] };
  generation?: { message?: PiMessage; retry?: { error?: string } };
  tools?: PiToolSlot[];
  /** Nested calls of running tool calls (a `codemode` script's `tools.read(...)` and friends). */
  nestedTools?: PiNestedTools;
};

const toUsage = (usage: PiUsage | undefined): TokenUsage | undefined => {
  if (!usage) return undefined;
  const value = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  };
  return value.input + value.output + value.cacheRead + value.cacheWrite > 0 ? value : undefined;
};

const toolTitleFromInput = (input: Record<string, unknown> | undefined): string | undefined => {
  if (!input) return undefined;
  for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return undefined;
};

const isAbortStop = (message: PiMessage): boolean =>
  /abort|cancel|interrupt/i.test(`${message.stopReason ?? ''} ${message.rawStopReason ?? ''}`);

/**
 * Hearth reports a step it cut short with `<harness>\n[error] Tool <name> was aborted\n</harness>`
 * (an abort) or `…was interrupted and may have partially run` (a crash-recovery rerun that is not
 * replay-safe). Both are user stops/restarts, not tool failures: surface them as `interrupted` so
 * the transcript can show `[step interrupted]` instead of a red error.
 */
const isInterruptedToolResult = (output: string, isError: boolean): boolean =>
  isError && /\[error\]\s+Tool .+ was (aborted|interrupted)\b/i.test(output);

const toolStatusFromSlot = (status: string | undefined, isError: boolean): ToolStatus => {
  if (status === 'running' || status === 'pending') return status === 'pending' ? 'pending' : 'running';
  return isError ? 'error' : 'completed';
};

// ---- Nested calls (a `codemode` script's inner tool calls) ------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Compact JSON of a nested call's arguments, whether the host sent a string or a value. */
const nestedArgsText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/**
 * A nested call's status, in Ember's wording.
 *
 * A live slot reports `pending`/`running`/`done` and puts the outcome in `summary`; a settled
 * `details.calls` entry reports `running`/`ok`/`error`/`cancelled` directly. A finished slot whose
 * summary says it failed is an error, not a success — the live shape carries no error status of
 * its own.
 */
const nestedStatusOf = (raw: Record<string, unknown>): NestedToolCall['status'] => {
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  const summary = asRecord(raw.summary);
  if (status === 'error' || status === 'cancelled' || status === 'ok' || status === 'running') return status;
  if (status === 'pending') return 'running';
  return summary?.isError === true ? 'error' : 'ok';
};

/** The key a live slot was filed under: `"<parentCallId>/c1"` → `c1`. */
const nestedKeyOf = (raw: Record<string, unknown>): string | undefined => {
  const callId = typeof raw.callId === 'string' ? raw.callId : undefined;
  if (!callId) return undefined;
  const slash = callId.lastIndexOf('/');
  return slash === -1 ? callId : callId.slice(slash + 1);
};

const nestedCallOf = (raw: Record<string, unknown>, key?: string, index = 0): NestedToolCall => {
  const summary = asRecord(raw.summary);
  const rawId = raw.id;
  const id =
    typeof rawId === 'string' || typeof rawId === 'number'
      ? String(rawId)
      : (key ?? nestedKeyOf(raw) ?? String(index));
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'tool';
  const call: NestedToolCall = {
    id,
    name,
    args: nestedArgsText(raw.args ?? raw.arguments),
    status: nestedStatusOf(raw),
  };
  const durationMs = typeof raw.durationMs === 'number' ? raw.durationMs : summary?.durationMs;
  if (typeof durationMs === 'number') call.durationMs = durationMs;
  const error = typeof raw.error === 'string' ? raw.error : summary?.error;
  if (typeof error === 'string' && error) call.error = error;
  return call;
};

/** Whether a value is one nested call, rather than a map (or list) of them. */
const isNestedCall = (value: Record<string, unknown>): boolean => {
  const status = typeof value.status === 'string' ? value.status : undefined;
  return (
    typeof value.name === 'string' ||
    (typeof value.id === 'number' && status !== undefined) ||
    (typeof value.callId === 'string' && typeof value.parentCallId === 'string')
  );
};

/**
 * Flattens either wire shape of `pi.live.nestedTools` into calls.
 *
 * A payload may be a list of slots, a `{ key: slot }` map, or a `{ parentCallId: bucket }` map —
 * and a bucket may itself be either of the last two. The recursion walks until it finds something
 * that is a call (it has a `name`, or a `status` with a numeric id) and stops there, so an
 * argument object can never be mistaken for a call list.
 */
const collectLiveNested = (value: unknown, out: NestedToolCall[], key?: string): void => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectLiveNested(entry, out, key));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (isNestedCall(record)) {
    out.push(nestedCallOf(record, key, out.length));
    return;
  }
  for (const [entryKey, entry] of Object.entries(record)) collectLiveNested(entry, out, entryKey);
};

const readDetailsCalls = (details: unknown): NestedToolCall[] | undefined => {
  const calls = asRecord(details)?.calls;
  if (!Array.isArray(calls)) return undefined;
  const mapped: NestedToolCall[] = [];
  calls.forEach((raw, index) => {
    const record = asRecord(raw);
    if (record) mapped.push(nestedCallOf(record, undefined, index));
  });
  // An empty settled list is an answer (the script called nothing), not a missing one: it must
  // replace whatever the live list held, so a settled script never keeps stale running children.
  return mapped;
};

/** Whether two nested-call lists render the same, so a re-applied settlement can reuse the old one. */
const nestedCallsEqual = (
  a: readonly NestedToolCall[] | undefined,
  b: readonly NestedToolCall[] | undefined
): boolean => {
  const before = a ?? [];
  const after = b ?? [];
  return (
    before.length === after.length &&
    after.every((call, index) => {
      const previous = before[index];
      return (
        previous.id === call.id &&
        previous.name === call.name &&
        previous.args === call.args &&
        previous.status === call.status &&
        previous.durationMs === call.durationMs &&
        previous.error === call.error
      );
    })
  );
};

/**
 * A `codemode` call's nested calls, from whichever half of the call's life the client holds.
 *
 * `details` is the settled result's `{ calls, fullOutputPath }` (pi-durable's `CodemodeToolDetails`),
 * so those win: they are complete and final. Without them, `liveNested` is what
 * `pi.live.nestedTools` says about the parent call, which is all there is while the script runs.
 * Returns `undefined` when neither reports anything, so callers can leave the field absent rather
 * than attach an empty list to every tool call.
 */
export const extractNestedCalls = (details: unknown, liveNested?: unknown): NestedToolCall[] | undefined => {
  const settled = readDetailsCalls(details);
  if (settled) return settled;
  const live: NestedToolCall[] = [];
  collectLiveNested(liveNested, live);
  return live.length > 0 ? live : undefined;
};

/** The temp file a settled script wrote its complete output to, when its output was cut. */
const readFullOutputPath = (details: unknown): string | undefined => {
  const value = asRecord(details)?.fullOutputPath;
  return typeof value === 'string' && value ? value : undefined;
};

/**
 * The live nested calls of one tool call, whichever shape `pi.live.nestedTools` arrived in: a list
 * of slots (related to the parent by `parentCallId`/`callId`), or a map keyed by parent call id.
 */
const liveNestedFor = (live: PiLive | undefined, callId: string): NestedToolCall[] | undefined => {
  const nested = live?.nestedTools;
  if (nested === undefined) return undefined;
  if (Array.isArray(nested)) {
    const mine = nested.filter((slot) => {
      if (slot.parentCallId !== undefined) return slot.parentCallId === callId;
      return typeof slot.callId === 'string' && slot.callId.startsWith(`${callId}/`);
    });
    return mine.length > 0 ? extractNestedCalls(undefined, mine) : undefined;
  }
  const bucket = asRecord(nested)?.[callId];
  return bucket === undefined ? undefined : extractNestedCalls(undefined, bucket);
};

/**
 * The reasoning level an assistant response ran at, for `ModelRef.variant`.
 *
 * `thinkingLevel` is the Pi-level the agent loop requested; `providerThinkingLevel` is the
 * provider's own spelling of the effort it actually used, and is stamped further down the stack (by
 * pi-ai's provider adapters), so on a host whose loop stamps only one of them this still finds the
 * level. Both absent — a legacy response, or an adapter that reports neither — maps to `undefined`,
 * which the footer renders as nothing at all. Guessing from the session's current selection would
 * label an old turn with a level it may never have run at.
 */
const thinkingLevelOf = (message: PiMessage): string | undefined => {
  // Blank counts as absent, so an empty `thinkingLevel` still falls through to the provider's.
  const level = (message.thinkingLevel ?? '').trim() || (message.providerThinkingLevel ?? '').trim();
  return level || undefined;
};

/** A tool result's `details`, whether the host put them on the message or on the entry. */
const detailsOf = (entry: PiEntry, message: PiMessage): unknown =>
  message.details !== undefined ? message.details : entry.data?.details;

/**
 * A tool result, seen as what it is: the settlement of a call made earlier — not a message.
 *
 * The call and its result are separate entries, and a client that reads incrementally almost never
 * sees them in the same page (the call lands with the assistant turn, the result arrives in a later
 * `since` read). Mapping the result alone produced no message at all, so it was thrown away and the
 * tool row kept whatever status it was given when the call was drawn. Carrying the settlement
 * separately lets the transcript patch the part it already holds, wherever the call came from.
 */
export type ToolResultSettlement = {
  callId: string;
  status: ToolStatus;
  /** Truncated tool output, exactly as the same-page path shows it. */
  output?: string;
  error?: string;
  images?: FileAttachment[];
  /** A `codemode` script's nested calls, from the result's `details.calls`. */
  nestedCalls?: NestedToolCall[];
  /** A `codemode` script's complete output, when the host wrote it to a file. */
  fullOutputPath?: string;
  /** The command's exit status, when the result reports one. */
  exitCode?: number;
  /** Whether the host dropped earlier output to keep its tail. */
  truncated?: boolean;
};

/** The client's own ceiling on one tool output, and what it says when it hits it. */
const OUTPUT_CHAR_LIMIT = 20_000;

/**
 * One tool output, capped for the transcript, saying how much was there when it was cut.
 *
 * The old cut said only "… (truncated)", which reads exactly like the host's own truncation (it keeps
 * the tail) and told a reader nothing about whether the rest was a line or a megabyte.
 */
const clipOutput = (output: string): string =>
  output.length > OUTPUT_CHAR_LIMIT
    ? `${output.slice(0, OUTPUT_CHAR_LIMIT)}\n… (truncated — ${output.length.toLocaleString('en-US')} characters)`
    : output;

/**
 * One line saying a call failed, for the red summary above its output.
 *
 * The host's own diagnostic wins ("Command exited with code 1"); otherwise the **last** non-empty line
 * of the output, which is where a command's reason usually lands (a compiler's error, a shell's "No
 * such file"). The first 400 characters — the old summary — was usually the least informative part of
 * a log, and it replaced the output rather than summarising it.
 */
const errorSummary = (output: string, details: unknown): string => {
  const diagnostic = asRecord(details)?.diagnostics;
  if (Array.isArray(diagnostic)) {
    const message = diagnostic
      .map((entry) => asRecord(entry)?.message)
      .find((value): value is string => typeof value === 'string' && value.trim() !== '');
    if (message) return message.trim().slice(0, 200);
  }
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last) return last.length > 200 ? `${last.slice(0, 199)}…` : last;
  return 'The tool reported an error';
};

/** The exit status the host reported, if any. */
const readExitCode = (details: unknown): number | undefined => {
  const value = asRecord(details)?.exitCode;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** One `pi.tool-result` entry as a settlement, or `undefined` for any other entry (or a malformed
 * result with no call id, which cannot be attached to anything).
 */
const parseToolResult = (entry: PiEntry): ToolResultSettlement | undefined => {
  if (entry.kind !== 'pi.tool-result') return undefined;
  const [message] = entry.model ?? [];
  if (!message || message.role !== 'toolResult' || !message.toolCallId) return undefined;
  const blocks = blocksOf(message.content);
  const output = blocks
    .map((block) => (block.type === 'text' ? block.text ?? '' : block.type === 'file' ? '[file]' : ''))
    .join('');
  const images = imageAttachmentsOf(blocks);
  const interrupted = isInterruptedToolResult(output, message.isError === true);
  const status: ToolStatus = interrupted
    ? 'interrupted'
    : message.isError === true
      ? 'error'
      : 'completed';
  const settlement: ToolResultSettlement = { callId: message.toolCallId, status };
  const details = detailsOf(entry, message);
  if (interrupted) {
    // The result's content here is the harness's own "[error] Tool … was aborted", so it *is* the
    // message; there is no separate output to keep beside it.
    settlement.error = output.trim().slice(0, 400) || 'The step was interrupted.';
  } else {
    // A failed call keeps its output exactly like a successful one. It used to keep the first 400
    // characters as `error` and nothing else, so a command that failed on its last line (a `grep`
    // that found nothing, a script whose interesting line was at the end) showed the least useful
    // part of its log in red and lost the rest — while the agent had the whole retained tail.
    if (output) settlement.output = clipOutput(output);
    if (message.isError === true) settlement.error = errorSummary(output, details);
  }
  if (images.length) settlement.images = images;
  // A `codemode` result carries the script's calls and, when its output was cut, the file with the
  // whole of it. Both belong to the call, so the settlement carries them to wherever it lives.
  const nestedCalls = extractNestedCalls(details);
  if (nestedCalls) settlement.nestedCalls = nestedCalls;
  const fullOutputPath = readFullOutputPath(details);
  if (fullOutputPath) settlement.fullOutputPath = fullOutputPath;
  const exitCode = readExitCode(details);
  if (exitCode !== undefined) settlement.exitCode = exitCode;
  if (asRecord(details)?.truncated === true) settlement.truncated = true;
  return settlement;
};

/** Every settlement a page of entries carries, in page order. */
export const toolResultSettlements = (entries: readonly PiEntry[]): ToolResultSettlement[] =>
  entries.flatMap((entry) => {
    const settlement = parseToolResult(entry);
    return settlement ? [settlement] : [];
  });


/** A running call’s output, as the host’s `pi.live` slot holds it (the retained tail). */
export type LiveToolOutput = { callId: string; output: string };

/**
 * The live slots that actually carry output, from a `pi.live` document.
 *
 * A slot exists for every executing call, but only a streaming tool fills `output`; the rest say
 * nothing here and are left to the settled result.
 */
export const liveToolOutputs = (live: PiLive | undefined): LiveToolOutput[] =>
  (live?.tools ?? []).flatMap((slot) =>
    slot.callId && typeof slot.output === 'string' && slot.output.length > 0
      ? [{ callId: slot.callId, output: slot.output }]
      : []
  );

/**
 * Applies a running call’s streamed output to the transcript already held.
 *
 * The incremental (`since`) read is the one that runs on every `tool_execution_update`: its page is
 * usually *empty*, because the assistant entry carrying the call was committed earlier. Mapping an
 * empty page produces nothing, so the slot’s output — which the same response already carries in
 * `docs["pi.live"]` — was dropped on the floor and a running command’s output stayed invisible
 * until it settled. This patches it onto the call that is already on screen, the way
 * `settleToolResults` patches a result onto a call from an earlier page.
 *
 * Only a call that is still in flight is touched: a settled call has its own output from its result,
 * and a stale slot must never resurrect a row that has already finished.
 *
 * Returns the input array itself when nothing changed, so a poll that carries no new output cannot
 * churn row identity (and therefore cannot re-render the column).
 */
export const applyLiveToolOutput = (
  messages: readonly ChatMessage[],
  outputs: readonly LiveToolOutput[]
): ChatMessage[] => {
  if (outputs.length === 0) return messages as ChatMessage[];
  const byCall = new Map(outputs.map((entry) => [entry.callId, entry.output]));
  let changedAny = false;
  const next = messages.map((message) => {
    if (!message.parts.some((part) => part.type === 'tool' && byCall.has(part.call.id))) {
      return message;
    }
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool') return part;
      const output = byCall.get(part.call.id);
      if (output === undefined) return part;
      if (part.call.output === output && part.call.status === 'running') return part;
      if (part.call.status !== 'running' && part.call.status !== 'pending') return part;
      changed = true;
      return { ...part, call: { ...part.call, status: 'running' as const, output } };
    });
    if (!changed) return message;
    changedAny = true;
    return { ...message, parts };
  });
  return changedAny ? next : (messages as ChatMessage[]);
};

/**
 * Applies settlements to a transcript that may already hold the calls they belong to. Returns the
 * input array itself when nothing changed, so a read that settles nothing cannot churn row identity
 * (and therefore cannot re-render the column).
 */
export const settleToolResults = (
  messages: readonly ChatMessage[],
  settlements: readonly ToolResultSettlement[]
): ChatMessage[] => {
  if (settlements.length === 0) return messages as ChatMessage[];
  const byCall = new Map(settlements.map((settlement) => [settlement.callId, settlement]));
  let changedAny = false;
  const next = messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool') return part;
      const settlement = byCall.get(part.call.id);
      if (!settlement) return part;
      const call: ToolCall = { ...part.call, status: settlement.status };
      if (settlement.output !== undefined) call.output = settlement.output;
      if (settlement.error !== undefined) call.error = settlement.error;
      if (settlement.images !== undefined) call.images = settlement.images;
      if (settlement.nestedCalls !== undefined) {
        call.nestedCalls = nestedCallsEqual(part.call.nestedCalls, settlement.nestedCalls)
          ? part.call.nestedCalls
          : settlement.nestedCalls;
      }
      if (settlement.fullOutputPath !== undefined) call.fullOutputPath = settlement.fullOutputPath;
      if (settlement.exitCode !== undefined) call.exitCode = settlement.exitCode;
      if (settlement.truncated !== undefined) call.truncated = settlement.truncated;
      if (
        call.status === part.call.status &&
        call.output === part.call.output &&
        call.error === part.call.error &&
        call.images === part.call.images &&
        call.nestedCalls === part.call.nestedCalls &&
        call.fullOutputPath === part.call.fullOutputPath &&
        call.exitCode === part.call.exitCode &&
        call.truncated === part.call.truncated
      ) {
        return part;
      }
      changed = true;
      return { ...part, call };
    });
    if (!changed) return message;
    changedAny = true;
    return { ...message, parts };
  });
  return changedAny ? next : (messages as ChatMessage[]);
};

/**
 * Snapshot entries → transcript. Assistant tool calls become tool parts; the matching
 * `pi.tool-result` entry (later, by call id) settles the part; `pi.live` (the snapshot's
 * docs) settles still-running calls. System entries and head markers are skipped.
 *
 * `authoritative` means the caller read the whole range the call could be settled in, so a call
 * that is still unsettled at the end of a finished turn really was interrupted rather than merely
 * waiting for its result. Without that promise a call stays `pending`; it must never default to
 * `completed`, which claims a result the client does not have.
 */
export const piEntriesToMessages = (
  entries: readonly PiEntry[],
  live?: PiLive,
  options: { authoritative?: boolean } = {}
): ChatMessage[] => {
  const slots = new Map<string, PiToolSlot>();
  (live?.tools ?? []).forEach((slot) => {
    if (slot.callId) slots.set(slot.callId, slot);
  });
  const messages: ChatMessage[] = [];

  entries.forEach((entry) => {
    const [message] = entry.model ?? [];
    if (!message) return;
    if (entry.kind === 'pi.system' || entry.kind === 'pi.reset' || entry.kind === 'pi.compaction') return;

    if (entry.kind === 'pi.user') {
      const blocks = blocksOf(message.content);
      const text = blocks
        .map((block) => (block.type === 'text' ? block.text ?? '' : ''))
        .join('');
      // An image the human attached is a block too, and a message carrying only an image is still
      // a message — dropping it here would hide the turn from the transcript entirely.
      const images = imageAttachmentsOf(blocks, 'image');
      if (!text && images.length === 0) return;
      const parts: MessagePart[] = text ? [{ type: 'text', id: `e${entry.id}-0`, text }] : [];
      images.forEach((file, index) => parts.push({ type: 'file', id: `e${entry.id}-image-${index}`, file }));
      messages.push({
        id: `e${entry.id}`,
        role: 'user',
        text,
        parts,
        createdAt: message.timestamp,
        completed: true,
        completedAt: message.timestamp,
      });
      return;
    }

    if (entry.kind === 'pi.tool-result' && message.role === 'toolResult') {
      // The result entry settles the tool part of the assistant message that made the call. When the
      // call is not in this page (the usual shape of an incremental read) the transport carries the
      // settlement to the held transcript instead — see `toolResultSettlements`.
      const settlement = parseToolResult(entry);
      const part = settlement ? findOpenToolPart(messages, settlement.callId) : undefined;
      if (part && settlement) {
        part.call.status = settlement.status;
        if (settlement.error !== undefined) part.call.error = settlement.error;
        if (settlement.output !== undefined) part.call.output = settlement.output;
        if (settlement.images !== undefined) part.call.images = settlement.images;
        if (settlement.nestedCalls !== undefined) part.call.nestedCalls = settlement.nestedCalls;
        if (settlement.fullOutputPath !== undefined) part.call.fullOutputPath = settlement.fullOutputPath;
        if (settlement.exitCode !== undefined) part.call.exitCode = settlement.exitCode;
        if (settlement.truncated !== undefined) part.call.truncated = settlement.truncated;
      }
      return;
    }

    if (entry.kind !== 'pi.assistant' || message.role !== 'assistant') return;

    const parts: MessagePart[] = [];
    let text = '';
    blocksOf(message.content).forEach((block, index) => {
      if (block.type === 'text' && block.text) {
        text += block.text;
        parts.push({ type: 'text', id: `e${entry.id}-${index}`, text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        parts.push({ type: 'reasoning', id: `e${entry.id}-${index}`, text: block.thinking });
      } else if (block.type === 'toolCall') {
        const callId = block.id ?? `e${entry.id}-${index}`;
        const slot = slots.get(callId);
        const call: ToolCall = {
          id: callId,
          tool: block.name ?? 'tool',
          // No result in hand and no live slot: the call is unsettled. `completed` would claim an
          // output this read does not have; the authoritative pass below turns a finished turn's
          // unsettled call into `interrupted`, and a later settlement patches the real result in.
          status: slot ? toolStatusFromSlot(slot.status, false) : 'pending',
          title: toolTitleFromInput(block.arguments) ?? slot?.name,
          input: block.arguments,
          output: slot?.output,
        };
        // A script in flight lists the calls it has made so far under `pi.live.nestedTools`; its
        // result's `details.calls` replaces them (same list, final statuses) when it settles.
        const nestedCalls = liveNestedFor(live, callId);
        if (nestedCalls) call.nestedCalls = nestedCalls;
        parts.push({ type: 'tool', id: `e${entry.id}-${index}`, call });
      }
    });

    const failed = message.stopReason === 'error' || message.rawStopReason === 'error';
    const aborted = failed && isAbortStop(message);
    // Any part is content. A step that only reasoned (a generation cut short, or the streamed
    // shape of a generation before its text lands) used to be dropped here, which is exactly the
    // reasoning the user was watching: it vanished instead of staying in its collapsed block.
    const completed = parts.length > 0 || failed;
    if (!completed) return;
    messages.push({
      id: `e${entry.id}`,
      role: 'assistant',
      text,
      parts,
      model:
        message.provider && message.model
          ? { providerID: message.provider, modelID: message.model, variant: thinkingLevelOf(message) }
          : undefined,
      tokens: toUsage(message.usage),
      // Hearth nests the per-turn cost under usage (`cost` at the top level is null).
      cost:
        typeof message.usage?.cost?.total === 'number'
          ? message.usage.cost.total
          : typeof message.cost?.total === 'number'
            ? message.cost.total
            : undefined,
      // Name the failure the way it will be acted on: a 429 from an overloaded engine, a drained
      // balance and an auth problem all need different responses, and the old banner collapsed
      // every one of them into "The model turn failed (error)".
      error:
        failed && !aborted
          ? describeTurnFailure(readTurnFailure(message.errorMessage, message.stopReason))
          : undefined,
      aborted,
      createdAt: message.timestamp,
      // `timestamp` is request *start*, and `durationMs` is the span to the response's end, so a
      // finished turn has a real interval for the footer's duration and tok/s. Without the span
      // (an entry written before pi-ai stamped it) leave `completedAt` unset rather than fake a
      // zero-length turn. `toolUse` continues the turn, so it is never a completion.
      completedAt:
        message.stopReason &&
        message.stopReason !== 'toolUse' &&
        message.timestamp !== undefined &&
        message.durationMs !== undefined
          ? message.timestamp + message.durationMs
          : undefined,
      completed: message.stopReason !== 'toolUse',
    });
  });

  const streaming = liveGenerationMessage(live, messages);
  if (streaming) messages.push(streaming);

  // A call still unsettled at the end of a *finished* turn was cut short: Hearth commits the
  // assistant entry and its result in separate writes, and an interrupted step may never get a
  // result entry at all. Only do this when the caller read the whole range, so a call that is
  // merely waiting for its result in a later page stays `pending` rather than being called
  // interrupted.
  //
  // The turn's own `completed` is not the test. Every tool-calling assistant entry stops with
  // `stopReason === 'toolUse'` — it always has an unsettled call, which is what keeps the turn
  // going — so gating on `message.completed` made this loop unreachable for exactly the entries
  // that own tool calls. The run is what decides: with no live run, or with the message behind a
  // live run's newest assistant entry, nothing can settle its call any more, so it is
  // `interrupted`. While a run is active, its newest assistant entry's calls stay `pending` — the
  // result may still be coming — and every earlier call of that same run has already settled or
  // was cut short. `live.tools` slots are skipped: a call in flight is not dead.
  if (options.authoritative === true) {
    const lastAssistant = messages.reduce(
      (newest, message) => (message.role === 'assistant' ? message.id : newest),
      ''
    );
    const runActive = live?.run !== undefined;
    messages.forEach((message, index) => {
      if (message.role !== 'assistant' || message.live === true) return;
      if (runActive && message.id === lastAssistant) return;
      let changed = false;
      const parts = message.parts.map((part) => {
        if (part.type !== 'tool' || part.call.status !== 'pending') return part;
        // Already running under a live slot, or listed there: not dead.
        if (slots.get(part.call.id) !== undefined) return part;
        changed = true;
        return {
          ...part,
          call: {
            ...part.call,
            status: 'interrupted' as ToolStatus,
            error: part.call.error ?? 'The step was interrupted.',
          },
        };
      });
      if (changed) messages[index] = { ...message, parts };
    });
  }
  return messages;
};

/** The stable id of the in-flight generation's message, so growing text replaces it in place. */
export const LIVE_MESSAGE_ID = 'pi-live';

/**
 * Whether the live slot would render exactly what a settled message already shows.
 *
 * Reasoning and text both count. A settled entry that carries the same reasoning *and* text as the
 * live slot is the same generation seen twice; one that carries strictly less is a stale snapshot
 * the live slot has moved past, so the live slot is still worth drawing.
 */
/**
 * Does this live generation render what a settled message already says? Exported because the slot
 * handover in `transcriptReconciliation` needs the same question answered for a *held* slot.
 */
export const sameRenderedContent = (
  settled: ChatMessage,
  liveParts: readonly MessagePart[],
  liveText: string
): boolean => {
  if (settled.text !== liveText) return false;
  const settledReasoning = settled.parts
    .filter((part): part is Extract<MessagePart, { type: 'reasoning' }> => part.type === 'reasoning')
    .map((part) => part.text.trim())
    .filter(Boolean);
  const liveReasoning = liveParts
    .filter((part): part is Extract<MessagePart, { type: 'reasoning' }> => part.type === 'reasoning')
    .map((part) => part.text.trim())
    .filter(Boolean);
  // No text on either side and no reasoning to compare: nothing to duplicate.
  if (!liveText && liveReasoning.length === 0) return false;
  return (
    settledReasoning.length === liveReasoning.length &&
    settledReasoning.every((text, index) => text === liveReasoning[index])
  );
};

/**
 * Hearth streams a generation's reasoning and text into `docs["pi.live"].generation.message` and
 * only appends the durable `pi.assistant` entry when that generation ends. Mapping the slot gives
 * streaming reasoning somewhere to live; the entry that replaces it carries the same parts (the
 * terminal provider message is what both the partial and the entry hold), so the block the user
 * watched stays. A committed assistant entry with the same text means the slot has already been
 * settled and only its entry is missing from this read, so the slot is not shown twice.
 */
const liveGenerationMessage = (
  live: PiLive | undefined,
  settled: readonly ChatMessage[]
): ChatMessage | undefined => {
  const message = live?.generation?.message;
  if (!message || message.role !== 'assistant') return undefined;
  const parts: MessagePart[] = [];
  let text = '';
  blocksOf(message.content).forEach((block, index) => {
    if (block.type === 'text' && block.text) {
      text += block.text;
      parts.push({ type: 'text', id: `${LIVE_MESSAGE_ID}-${index}`, text: block.text });
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push({ type: 'reasoning', id: `${LIVE_MESSAGE_ID}-${index}`, text: block.thinking });
    }
  });
  if (parts.length === 0) return undefined;
  // Already drawn? Compare what would actually render, not just the text. The old guard tested
  // `text` alone, so while the model was still reasoning — text empty, reasoning present — it
  // could never fire and the same generation was drawn twice: once as the settled entry, once as
  // the live slot.
  const last = settled[settled.length - 1];
  if (last && last.role === 'assistant' && sameRenderedContent(last, parts, text)) return undefined;
  return {
    id: LIVE_MESSAGE_ID,
    role: 'assistant',
    text,
    parts,
    model:
      message.provider && message.model
        ? { providerID: message.provider, modelID: message.model, variant: thinkingLevelOf(message) }
        : undefined,
    createdAt: message.timestamp,
    completed: false,
    live: true,
  };
};

const findOpenToolPart = (messages: ChatMessage[], callId: string | undefined): { call: ToolCall } | undefined => {
  if (!callId) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index].parts.find(
      (candidate) => candidate.type === 'tool' && (candidate as { call: ToolCall }).call.id === callId
    );
    if (part) return part as { call: ToolCall };
  }
  return undefined;
};

// ---- Models --------------------------------------------------------------------------

export type PiModel = {
  providerName?: string;
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input?: number; output?: number };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  type?: string;
};

export const piModelsToModelList = (
  models: readonly PiModel[],
  defaultModel: { provider: string; modelId: string } | undefined
): { models: ModelOption[]; defaultModelId: string | null } => {
  const options = models
    .filter((model) => model.type === undefined || model.type === 'chat')
    .map(
      (model): ModelOption => ({
        providerID: model.provider,
        modelID: model.id,
        variant: undefined,
        label: model.name ?? model.id,
        details: {
          name: model.name ?? model.id,
          providerName: model.providerName ?? model.provider,
          contextTokens: model.contextWindow,
          outputTokens: model.maxTokens,
          costInput: model.cost?.input,
          costOutput: model.cost?.output,
          reasoning: model.reasoning === true,
          toolcall: true,
          attachment: (model.input ?? []).some((entry) => entry !== 'text'),
          inputs: (model.input ?? []).filter((entry) => entry !== 'text'),
          variants: [
            // "off" (no reasoning) is a level Hearth accepts but never lists: the map only carries
            // levels that set a provider parameter. Offer it first for any model with levels.
            ...(Object.keys(model.thinkingLevelMap ?? {}).length ? [REASONING_OFF] : []),
            ...Object.entries(model.thinkingLevelMap ?? {})
              .filter(([level, value]) => value !== null && level !== REASONING_OFF)
              .map(([level]) => level),
          ],
        },
      })
    );
  return {
    models: options,
    defaultModelId: defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : null,
  };
};

// ---- Approvals + questions -----------------------------------------------------------

export type PiApproval = {
  conversationId: string;
  key: string;
  tool: string;
  arguments?: Record<string, unknown>;
};

export const piApprovalToPermissionRequest = (
  endpointId: string,
  approval: PiApproval
): PermissionRequest => ({
  id: `${approval.conversationId}:${approval.key}`,
  instanceId: endpointId,
  sessionId: String(approval.conversationId),
  permission: approval.tool,
  patterns: [],
  metadata: {
    message: `The bot wants to run ${approval.tool}`,
    arguments: approval.arguments ?? {},
  },
});

export const piQuestionToQuestionRequest = (
  endpointId: string,
  question: { conversationId: string; key: string; question: string; options?: string[] }
): QuestionRequest => ({
  id: `${question.conversationId}:${question.key}`,
  instanceId: endpointId,
  sessionId: String(question.conversationId),
  questions: [
    {
      key: 'answer',
      valueType: 'string',
      header: '',
      question: question.question,
      options: (question.options ?? []).map((label) => ({ label, description: '', value: label })),
      multiple: false,
      custom: true,
    },
  ],
});

// ---- Queue ---------------------------------------------------------------------------

/** One queued inbox item, as Hearth sends it: input content, or a write entry, plus a preview. */
export type PiInboxItem = {
  id: number | string;
  mode?: string;
  /** Hearth's bounded preview of the item (it names an image as `[image]`). */
  text?: string;
  /** Input items: the user's content — a string, or text/image parts. */
  content?: unknown;
  /** Write items: the entry draft, whose `data.text` is what a human sees. */
  entry?: unknown;
};

/**
 * A queued item's displayable text: Hearth's own bounded preview when it sent one (it names an
 * image as `[image]`), else the content's text parts, else a write entry's data.
 */
export const piInboxItemText = (item: PiInboxItem): string => {
  if (typeof item.text === 'string' && item.text) return item.text;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && (block as PiBlock).type === 'text' ? (block as PiBlock).text ?? '' : ''))
      .join('')
      .trim();
  }
  if (item.entry && typeof item.entry === 'object') {
    const data = (item.entry as { data?: unknown }).data;
    if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
      return (data as { text: string }).text;
    }
  }
  return '';
};

export const piInboxToQueuedMessages = (
  endpointId: string,
  conversationId: number | string,
  items: readonly PiInboxItem[],
  model: { providerID: string; modelID: string; variant?: string } | undefined
): QueuedMessage[] =>
  items.map((item) => {
    const content = 'content' in item ? item.content : undefined;
    return {
      id: String(item.id),
      createdAt: 0,
      content: piInboxItemText(item),
      text: piInboxItemText(item),
      // A queued image keeps its row's badge and its payload, so "send now" can still send it.
      attachments: Array.isArray(content)
        ? imageAttachmentsOf(content, 'image').map((file) => ({
            filename: file.filename,
            mimeType: file.mime,
            dataUrl: file.url,
          }))
        : [],
      context: [],
      sendConfig: {
        providerID: model?.providerID ?? '',
        modelID: model?.modelID ?? '',
        variant: model?.variant,
      },
      // Hearth tags how it will dispatch the item. Only a steer is named; everything else in the
      // queue is a follow-up.
      ...(item.mode === 'steer' ? { mode: 'steer' as const } : {}),
    };
  });

/**
 * The newest entry id a transcript holds, or undefined when it holds none.
 *
 * A message's id carries the entry it came from (`e<entryId>`), which is what makes an incremental
 * read possible: the caller asks Hearth for entries newer than this one instead of re-reading the
 * last forty. Live generations and optimistic sends are not entries, so they are skipped -- scanning
 * back to the first entry-backed message is enough because messages are appended in entry order,
 * which is monotonic.
 */
export const newestEntryId = (messages: readonly ChatMessage[]): number | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.live === true) continue;
    const match = /^e(\d+)$/.exec(message.id);
    if (match === null) continue;
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return undefined;
};
