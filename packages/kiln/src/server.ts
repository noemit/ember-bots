import { timingSafeEqual } from "node:crypto";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Credential, CredentialStore, Message, Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  UsageDoc,
  type AgentChange,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryDraft,
  type EntryId,
  type Harness,
  type InputSubmissionDraft,
  type InboxItem,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
  type TaskGraphWatch,
  type UsageState,
  type ConversationView,
  type ConversationWatch,
  type Submission,
} from "@earendil-works/pi-durable";
import { MetaDoc } from "./meta";
import {
  AgentsDoc,
  DuplicateAgentError,
  formatForeignAgentMessage,
  listAgents,
  mergeDirectory,
  pruneStaleAgents,
  registerAgent,
  staleAgentNames,
  writeAgentsMirror,
  writePeersMirror,
  type DirectorySummary,
  type PeerEndpoint,
} from "./agents";
import {
  CREW_DEADLINE_MS,
  SessionsDoc,
  WORKER_INSTRUCTIONS,
  nextRoleIndex,
  pruneSpawns,
  workerTitle,
} from "./sessions";
import { importOpenCodeCredentials, isCredential } from "./credentials";
import { createLoginSupervisor, loginSupport, type LoginProvider, type LoginState } from "./login";
import {
  ApprovalsDoc,
  AutoAcceptDoc,
  clearPendingApprovals,
  pendingApprovals,
  replyApproval,
  setAutoAccept,
  type ApprovalDecision,
} from "./approvals";
import { clearPendingQuestions, pendingQuestions, replyQuestion } from "./ask";
import { archiveCrew, unarchiveCrew } from "./crew";
import {
  createContextRule,
  deleteContextRule,
  injectContextForInput,
  listContextRules,
  parseContextRuleInput,
  parseContextRulePatch,
  updateContextRule,
} from "./context";
import { blindModelReason, contentPreviewOf, inputTextOf, parseUserInputContent } from "./images";
import { parkInputs, parkedInputs } from "./parking";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  parseScheduledTaskInput,
  parseScheduledTaskPatch,
  runScheduledTaskNow,
  updateScheduledTask,
} from "./scheduler";
import type { HearthConfig } from "./config";
import type { HearthDefault } from "./models";
import type { LocalRuntimeProbe } from "./local-models";
import { sendFrame } from "./stream";
import { attachFrames, framesOf } from "./frames";
import { createStreamLimiter, STREAM_LIMITS } from "./streamLimit";
import { hostMemory, megabytes, scanLeftovers, type LeftProcess } from "./processes";

const context: Context = BACKGROUND_CONTEXT;

export type HearthServer = {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

type Deps = {
  config: HearthConfig;
  token: string;
  storage: Storage;
  harness: Harness;
  models: Models;
  defaultAgent: HearthDefault;
  /** Provider credential store; backs `GET /providers`. */
  store?: CredentialStore;
  /** Semver release from package.json, surfaced on `/health`. */
  version?: string;
  /** Short build id (git SHA), surfaced on `/health` so a client can name the running version. */
  build?: string;
  /** Graceful self-restart for `POST /admin/restart`; the host's supervisor brings Hearth back. */
  restart?: (reason: string) => void;
  /**
   * The boot-time probe of the local runtimes (Ollama, LM Studio), reported by `GET /providers`.
   * Optional so a test can build a server without touching loopback.
   */
  localRuntimes?: readonly LocalRuntimeProbe[];
  /**
   * The host's process table and memory. Production leaves this out; a test passes a fake so the
   * routes can be exercised without depending on what is running on the machine under test.
   */
  processes?: { scan?: typeof scanLeftovers; memory?: typeof hostMemory };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * A refusal the caller can read: `status` is the wire code, `message` is the sentence a client
 * shows. Routes throw it from wherever the bad input is noticed, and the `error()` handler below
 * turns it into JSON. Nothing a client sends may reach an uncaught throw: that path answers with
 * Bun's HTML error page, which carries the install path, the dependency layout and stack frames,
 * and which a JSON client cannot parse at all. "All bodies are JSON" has to hold exactly when the
 * client is confused, because that is when it reads the body.
 */
export class HttpFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 405 | 409,
    message: string
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

const badRequest = (message: string): Response => json({ error: message }, 400);

/** A 404 has to name what is missing: "not found" cannot tell a wrong route from a wrong id. */
const notFound = (message: string): Response => json({ error: message }, 404);

/** Bound a caller-supplied string before echoing it back, so one bad request is not a long body. */
const brief = (value: string, limit = 60): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/**
 * How long `POST /abort` waits for a run to actually wind down. Any longer and the caller is
 * told "stopping" while the abort finishes in the background, so a wedged step cannot make the
 * stop button hang. `withAbortRace` keeps the common case well under this.
 */
const ABORT_FAST_RETURN_MS = 250;

/**
 * The body of a JSON object request.
 *
 * An *absent* body and an *unparseable* one are different answers: a truncated or mistyped request
 * used to fall through as `{}`, which on `POST /conversations` created an empty conversation and
 * answered 201. A caller that sent nothing gets an empty object; a caller that sent something this
 * host cannot read is told so.
 */
const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await request.text();
  if (raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpFailure(400, "the request body is not JSON: send a JSON object, or no body at all");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpFailure(400, "the request body must be a JSON object");
  }
  return value as Record<string, unknown>;
};

/**
 * Percent-decode one path segment.
 *
 * `decodeURIComponent` throws on a malformed sequence (`%ZZ`, a lone `%`), and an escaped throw is
 * answered as a server fault — a client's typo is not the host's problem to page about.
 */
const decodeSegment = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpFailure(400, `"${brief(raw)}" in the path is not valid percent-encoding`);
  }
};

/**
 * Page size bounds for `/entries`.
 *
 * `limit` bounds *rows*, and rows are wildly unequal: a text turn is a few KB while a turn carrying
 * a screenshot is megabytes, because the image is base64 inside the entry record. `pi-durable`'s
 * `scanEntries` does `parseJson` on every row it selects, and the parsed string is roughly twice
 * the base64 size while it is live. So the row limit is really a bound on memory, and 500 of them
 * on an image-heavy conversation was enough to take the process past Bun's heap ceiling.
 *
 * 100 rather than 500: the drop makes the worst case a fifth of what it was, and no client needs
 * more — the transcript view reads a screenful at a time and pages with `next`, and the heaviest
 * legit repeat read (`since=`, the streaming delta) asks for a handful. A caller that genuinely
 * wants more pages, which is the cheap direction: the cursor is a keyset, so extra rounds cost
 * only latency, never correctness.
 */
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;

/**
 * `limit` as a page size.
 *
 * It used to be `Number(raw) || 50`, which turned `abc` into 50 entries, `-3` into 1, and let `2.5`
 * reach SQLite's `LIMIT ?` — a datatype mismatch thrown out of the boundary and answered as a 500.
 */
const pageLimit = (raw: string | null): number => {
  if (raw === null) return LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_MAX) {
    throw new HttpFailure(400, `limit must be a whole number from 1 to ${LIMIT_MAX}; "${brief(raw)}" is not`);
  }
  return value;
};

/**
 * `cursor` as the opaque object a previous page returned as `next` (`{ after }`).
 *
 * A JSON *syntax* error was already refused; the shape was not, so `{"after":"x"}` reached the
 * storage cursor and threw `Invalid storage cursor` out of the boundary.
 */
const parseCursor = (raw: string | null): Cursor | undefined => {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpFailure(400, "cursor is not JSON: send back the `next` object a page returned");
  }
  const after = parsed && typeof parsed === "object" ? (parsed as { after?: unknown }).after : undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 1) {
    throw new HttpFailure(400, "cursor must be the `next` object a page returned, with a whole-number `after`");
  }
  return parsed as Cursor;
};

const string = (value: unknown, limit = 100_000): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;

/**
 * Drop a conversation's parked approvals and questions, returning which kinds were cleared. A
 * stopped run can no longer answer them, so their cards must not linger. Done before the abort
 * wait so the client sees prompts disappear immediately.
 */
const clearPendingPrompts = async (
  harness: Harness,
  conversationId: ConversationId
): Promise<Array<"approvals" | "questions">> => {
  const cleared: Array<"approvals" | "questions"> = [];
  try {
    if ((await pendingApprovals(harness, [conversationId], context)).length > 0) {
      await clearPendingApprovals(harness, conversationId, context);
      cleared.push("approvals");
    }
    if ((await pendingQuestions(harness, [conversationId], context)).length > 0) {
      await clearPendingQuestions(harness, conversationId, context);
      cleared.push("questions");
    }
  } catch (error) {
    console.error("[hearth] clearing parked prompts failed", error instanceof Error ? error.message : error);
  }
  return cleared;
};

/** True when the path exists and is a directory; false for a missing path or a file. */
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Constant-time token check: everything (including /health) is authenticated. */
const authorized = (request: Request, token: string): boolean => {
  const header = request.headers.get("authorization");
  const presented =
    (header?.startsWith("Bearer ") ? header.slice(7) : undefined) ??
    new URL(request.url).searchParams.get("token") ??
    "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
};

/** Every conversation record, scanned page by page from storage. */
const allConversations = async (storage: Storage): Promise<ConversationRecord[]> => {
  const records: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanConversations({}, 200, cursor, context);
    records.push(...page.items);
    if (!page.next) return records;
    cursor = page.next;
  }
};

/** True while any conversation has a running turn (`pi.live.run`); a self-restart waits for idle. */
export const anyConversationBusy = async (harness: Harness, storage: Storage): Promise<boolean> => {
  for (const record of await allConversations(storage)) {
    const live = await harness.snapshot(LiveDoc, record.id, context);
    if (live?.run) return true;
  }
  return false;
};

/** Conversation, entry and submission ids are numeric on the wire; null when malformed. */
const idOf = <T,>(raw: string): T | null => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? (value as unknown as T) : null;
};

type ConversationSummary = {
  id: ConversationId;
  parent?: ConversationRecord["parent"];
  owner?: ConversationRecord["owner"];
  cwd?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  title?: string;
  archived?: number;
  /** Crew membership: absent on ordinary sessions; workers are hidden, peers addressable. */
  kind?: "worker" | "peer";
  /** Immediate leader (retained on a promoted peer as history). */
  lead?: { conversationId: number; host: string };
  /** Whether this conversation offers the `session` tool + crew section. */
  delegates: boolean;
  /** Set on a worker after a human promotes it; the peer fork that now carries its name. */
  promotedTo?: number;
  /** True while an approval or question is parked for this conversation. */
  needsInput: boolean;
  lastEntryId?: EntryId;
  /** Epoch ms of the newest activity: the newest entry's own timestamp when it has one. */
  updatedAt?: number;
  /** True while the conversation has a run in flight. */
  busy?: boolean;
  /** USD this conversation has spent, summed from its own usage ledger; 0 when it has never run. */
  cost: number;
  /** Server-side YOLO policy: permission prompts auto-accept for this conversation. */
  autoAccept?: boolean;
  /** True while a compaction task is in flight (manual, threshold, or overflow). */
  compacting?: boolean;
  /** The newest compaction failure from `pi.live.compactionFailure`, cleared when a compaction produces a summary. */
  compactionFailure?: {
    taskId: number;
    trigger: string;
    error: string;
  };
  /**
   * Processes this conversation's commands left running — the ones a person can stop.
   *
   * Present only when there are some, so an ordinary summary stays the same size. `items` is the
   * heaviest few: a client draws the list from here and does not have to make a second request to
   * render the notice, while the full list (and the host's memory level) is
   * `GET /conversations/:id/processes`.
   */
  processes?: {
    count: number;
    rssBytes: number;
    items: LeftProcess[];
  };
};

/** How many leftovers travel on a summary; the rest are one request away. */
const SUMMARY_PROCESS_ITEMS = 5;

/** The `processes` field of a summary, from a scan the caller already has. */
const processesField = (leftovers: readonly LeftProcess[] | undefined): ConversationSummary["processes"] => {
  if (leftovers === undefined || leftovers.length === 0) return undefined;
  return {
    count: leftovers.length,
    rssBytes: leftovers.reduce((sum, entry) => sum + entry.rssBytes, 0),
    items: leftovers.slice(0, SUMMARY_PROCESS_ITEMS),
  };
};

/** Bounded display text for one queued inbox item (the user's own message, capped). */
const inboxTextOf = (item: {
  mode: "steer" | "followUp" | "write";
  content?: unknown;
  entry?: unknown;
}): string => {
  // A string, or content parts — where an image shows as `[image]` rather than as nothing.
  if (item.content !== undefined) return contentPreviewOf(item.content);
  const data = item.entry && typeof item.entry === "object" ? (item.entry as { data?: unknown }).data : undefined;
  if (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string") {
    return (data as { text: string }).text.slice(0, 500);
  }
  return "";
};

const entryTimestamp = (entry: { readonly model?: readonly { readonly timestamp?: number }[] }): number | undefined => {  const stamps = (entry.model ?? [])
    .map((message) => message.timestamp)
    .filter((stamp): stamp is number => typeof stamp === 'number' && Number.isFinite(stamp));
  return stamps.length > 0 ? Math.max(...stamps) : undefined;
};

/**
 * USD one conversation has spent, summed from its own `pi.usage` ledger.
 *
 * The ledger is keyed by model and by tool name, and a session's total is the sum of every bucket —
 * `cost.total` is what the provider reported for the response. A session that has never run has no
 * ledger, which is 0 rather than unknown: it has spent nothing, and saying so costs a client nothing.
 */
const costOfUsage = (usage: UsageState | undefined): number => {
  if (!usage) return 0;
  let cost = 0;
  for (const bucket of [usage.models, usage.tools]) {
    for (const entry of Object.values(bucket) as Array<{ cost?: { total?: number } } | undefined>) {
      const total = entry?.cost?.total;
      if (typeof total === "number" && Number.isFinite(total)) cost += total;
    }
  }
  return cost;
};

const summaryOf = async (
  harness: Harness,
  record: ConversationRecord,
  leftovers?: readonly LeftProcess[]
): Promise<ConversationSummary> => {
  const [meta, agent, newest, live, auto, approvals, questions, usage] = await Promise.all([
    harness.snapshot(MetaDoc, record.id, context),
    harness.snapshot(AgentDoc, record.id, context),
    harness.conversation(record.id, context).then((conversation) =>
      conversation ? conversation.entries({}, 1, undefined, context) : undefined
    ),
    harness.snapshot(LiveDoc, record.id, context),
    harness.snapshot(AutoAcceptDoc, record.id, context),
    pendingApprovals(harness, [record.id], context),
    pendingQuestions(harness, [record.id], context),
    harness.snapshot(UsageDoc, record.id, context),
  ]);
  const processes = processesField(leftovers);
  return {
    id: record.id,
    ...(record.parent ? { parent: record.parent } : {}),
    ...(record.owner ? { owner: record.owner } : {}),
    cwd: agent?.cwd,
    model: agent?.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : undefined,
    thinkingLevel: agent?.thinkingLevel,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.archived ? { archived: meta.archived } : {}),
    ...(meta?.kind ? { kind: meta.kind } : {}),
    ...(meta?.lead ? { lead: meta.lead } : {}),
    ...(meta?.promotedTo !== undefined ? { promotedTo: meta.promotedTo } : {}),
    delegates: meta?.delegates ?? true,
    needsInput: approvals.length > 0 || questions.length > 0,
    lastEntryId: newest?.items[0]?.id,
    updatedAt: newest?.items[0] ? entryTimestamp(newest.items[0]) : undefined,
    busy: Boolean(live?.run),
    cost: costOfUsage(usage),
    autoAccept: Boolean(auto?.enabled),
    compacting: Boolean(live?.compactions?.length),
    ...(live?.compactionFailure && typeof live.compactionFailure.error === "string"
      ? {
          compactionFailure: {
            taskId: live.compactionFailure.taskId,
            trigger: live.compactionFailure.trigger,
            error: live.compactionFailure.error,
          },
        }
      : {}),
    ...(processes === undefined ? {} : { processes }),
  };
};

const byLastEntry = (a: ConversationSummary, b: ConversationSummary): number => {
  const left = typeof a.lastEntryId === "number" ? a.lastEntryId : Number(a.lastEntryId);
  const right = typeof b.lastEntryId === "number" ? b.lastEntryId : Number(b.lastEntryId);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
  return String(b.lastEntryId ?? "").localeCompare(String(a.lastEntryId ?? ""));
};

const parseAgentChange = (body: Record<string, unknown>): AgentChange | null => {
  const change: {
    model?: AgentChange["model"];
    thinkingLevel?: AgentChange["thinkingLevel"];
    cwd?: AgentChange["cwd"];
    instructions?: AgentChange["instructions"];
  } = {};
  const model = body.model;
  if (model !== undefined) {
    if (model === null) {
      change.model = null;
    } else if (
      model &&
      typeof model === "object" &&
      string((model as Record<string, unknown>).provider, 200) &&
      string((model as Record<string, unknown>).modelId, 200)
    ) {
      const raw = model as { provider: string; modelId: string };
      change.model = { provider: raw.provider, modelId: raw.modelId };
    } else return null;
  }
  const thinkingLevel = body.thinkingLevel;
  if (thinkingLevel !== undefined) {
    if (thinkingLevel !== null && !string(thinkingLevel, 80)) return null;
    change.thinkingLevel = thinkingLevel as AgentChange["thinkingLevel"];
  }
  const cwd = body.cwd;
  if (cwd !== undefined) {
    if (cwd !== null && !string(cwd, 2_048)) return null;
    change.cwd = cwd as AgentChange["cwd"];
  }
  const instructions = body.instructions;
  if (instructions !== undefined) {
    if (instructions !== null && !string(instructions, 20_000)) return null;
    change.instructions = instructions as AgentChange["instructions"];
  }
  return Object.keys(change).length > 0 ? (change as AgentChange) : null;
};

type SubmissionParse =
  | { draft: InputSubmissionDraft | { type: "write"; entry: EntryDraft; requestId?: string } }
  /** Why the body was refused, so the client can say something better than "invalid submission". */
  | { error: string };

/**
 * The `model` messages a write entry may carry, or `undefined` for none.
 *
 * A write entry reaches the model through `model` alone — pi-durable derives the next request from
 * it, so a `data`-only entry is transcript decoration. Callers that mean the model to read
 * something (reply context, a queued message's instructions, Ember's side) therefore have to send
 * it here. Only user-role text is accepted: a client may hand the model something to read, never an
 * assistant turn or a tool result it did not produce.
 */
const parseEntryModel = (value: unknown): Message[] | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return "invalid";
  const messages: Message[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return "invalid";
    const message = candidate as { role?: unknown; content?: unknown; timestamp?: unknown };
    if (message.role !== "user") return "invalid";
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const content: Array<{ type: "text"; text: string }> = [];
    for (const part of parts) {
      const text = (part as { type?: unknown; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
      if (typeof text !== "string" || text.length === 0 || text.length > 40_000) return "invalid";
      content.push({ type: "text", text });
    }
    if (content.length === 0) return "invalid";
    const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    messages.push({ role: "user", content, timestamp });
  }
  return messages;
};

/**
 * How many times one `requestId` may be retried before the client has to start a new one. A host
 * that keeps stopping the same message should not mint submissions for it forever.
 */
const SUBMIT_ATTEMPT_LIMIT = 20;

/**
 * Whether a submission settled without ever reaching the transcript — the case a retry must fix.
 *
 * An input that was stopped before it was placed, or refused as stale, settles `unanswered` with no
 * entry: nothing of it is in the conversation, so treating a retry of it as "already done" reports a
 * message as sent that will never run. A submission that *did* place an entry is in the transcript
 * however it settled, and a retry of it stays the no-op idempotency is for.
 */
const neverPlaced = (record: { readonly type?: string; readonly status?: string; readonly entry?: unknown }): boolean =>
  record.type === "input" && record.status === "unanswered" && record.entry === undefined;

/** The 409 for a message that asked to be refused rather than queued behind a running turn. */
const busyRefusal = (conversationId: ConversationId): Response =>
  json(
    {
      error: `conversation ${conversationId} is busy, and this message asked to be refused rather than queued. Send it again with whenBusy "steer" (join the running turn) or "followUp" (wait for it).`,
    },
    409
  );

/**
 * Where a client's `requestId` stands, and the key the next attempt should be admitted under.
 *
 * `requestId` exists so a retried POST (a dropped socket, an answer the client never saw) cannot
 * place the same message twice. The library answers a known id with the record it already has,
 * whatever state that is — including a settled `unanswered` one, which is how a retried message the
 * user believes was sent goes nowhere. So each attempt after a spent no-op gets its own key
 * (`<id>#2`, `#3`, …): a retry finds every earlier attempt, reuses the newest one that reached the
 * transcript, and re-places after one that did not. The library's own dedupe still collapses two
 * concurrent retries onto the one key they agree on.
 */
const attemptOf = async (
  storage: Storage,
  conversationId: ConversationId,
  requestId: string
): Promise<{ newest?: SubmissionRecord; key?: string }> => {
  let newest: SubmissionRecord | undefined;
  for (let number = 1; number <= SUBMIT_ATTEMPT_LIMIT; number += 1) {
    const key = number === 1 ? requestId : `${requestId}#${number}`;
    const record = await storage.submissionByRequest(conversationId, key, context);
    if (record === undefined) return { newest, key };
    newest = record;
  }
  return { newest };
};

/** The answer to `POST /submit`: what it is, where it stands, and why when it stands nowhere. */
const answerOf = (
  record: { readonly id: SubmissionId; readonly status: string; readonly entry?: EntryId; readonly reason?: string },
  mode: string
): { submissionId: SubmissionId; status: string; mode: string; entry?: EntryId; reason?: string } => ({
  submissionId: record.id,
  status: record.status,
  mode,
  ...(record.entry !== undefined ? { entry: record.entry } : {}),
  ...(record.reason !== undefined ? { reason: record.reason } : {}),
});

const parseSubmission = (body: Record<string, unknown>): SubmissionParse => {
  const requestId = string(body.requestId, 200);
  // `whenBusy` picks which queue a busy conversation puts this message in, and `reject` asks to be
  // refused instead of queued. An unknown value used to be dropped on the floor, so `"rejet"`
  // quietly became a follow-up — and `"reject"` on a busy conversation threw out of the boundary.
  let whenBusy: "steer" | "followUp" | "reject" | undefined;
  if (body.whenBusy !== undefined) {
    if (body.whenBusy !== "steer" && body.whenBusy !== "followUp" && body.whenBusy !== "reject") {
      return { error: 'whenBusy must be "steer", "followUp" or "reject"' };
    }
    whenBusy = body.whenBusy;
  }
  if (body.type === "input") {
    // Text, or text and images (see ./images): the content part types pi-ai already carries for a
    // user turn, which pi-durable stores and replays verbatim.
    const parsed = parseUserInputContent(body.content);
    if (!parsed.ok) return { error: parsed.reason };
    return {
      draft: {
        type: "input",
        content: parsed.content,
        ...(whenBusy ? { whenBusy } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (body.type === "write") {
    const entry = body.entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: "invalid entry" };
    const kind = string((entry as Record<string, unknown>).kind, 200);
    if (!kind) return { error: "invalid entry" };
    const data = (entry as Record<string, unknown>).data;
    const model = parseEntryModel((entry as Record<string, unknown>).model);
    if (model === "invalid") {
      return { error: 'invalid entry.model: expected [{ "role": "user", "content": [{ "type": "text", "text": "…" }] }]' };
    }
    return {
      draft: {
        type: "write",
        entry: {
          kind,
          ...(data !== undefined ? { data: data as EntryDraft["data"] } : {}),
          ...(model !== undefined ? { model } : {}),
        },
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  return { error: "invalid submission" };
};

/**
 * Why a scheduled task was refused, when the schedule is what is wrong.
 *
 * "invalid scheduled task" leaves the caller guessing which of name, prompt and schedule failed —
 * and mistyping a timezone used to store a task whose every later tick threw. The refusal names the
 * zone when that is the problem, so it can be corrected rather than rediscovered.
 */
const scheduledTaskRefusal = (body: Record<string, unknown>): string => {
  const schedule = body.schedule as Record<string, unknown> | undefined;
  const timezone = schedule && typeof schedule === "object" ? schedule.timezone : undefined;
  if (typeof timezone === "string" && timezone.trim() !== "") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return `schedule.timezone "${brief(timezone, 100)}" is not a time zone this host knows; use an IANA name such as "Europe/Berlin", or leave it out for the host's own zone`;
    }
  }
  return "invalid scheduled task: name, prompt and a well-formed schedule are required";
};

/** Start the Hearth wire: authenticated HTTP for lists and actions, WebSockets for streams. */
export const startHearthServer = (deps: Deps): HearthServer => {
  const { config, token, storage, harness, models, defaultAgent, store, version, build, restart, localRuntimes } = deps;
  // The host's process table and memory, injectable for tests (see `Deps.processes`).
  const scan = deps.processes?.scan ?? scanLeftovers;
  const memory = deps.processes?.memory ?? hostMemory;

  /**
   * Refresh the model catalog in the background after a credential changes, so a provider that was
   * only added for that credential becomes offerable without a restart. A failure is logged and
   * dropped: the credential itself is already stored, and a slow provider must not fail the write.
   */
  const refreshModelCatalog = (reason: string): void => {
    void models
      .refresh()
      .then((refresh) => {
        const errors = [...refresh.errors.keys()];
        if (errors.length > 0) console.error(`[hearth] model refresh after ${reason} failed for: ${errors.join(", ")}`);
      })
      .catch((error: unknown) => {
        console.error(
          `[hearth] model refresh after ${reason} failed:`,
          error instanceof Error ? error.message : error
        );
      });
  };

  /**
   * OAuth sign-in state, one flow per provider. Adapter over pi-ai's provider list so `src/login.ts`
   * needs no knowledge of pi-ai's types: only the two OAuth methods a device-code flow uses.
   *
   * The second argument is where a finished flow's credential goes. It is handed over by the
   * supervisor on the flow's terminal event, so a sign-in that completes while the client is
   * polling — the normal case, and the one that used to be dropped — is stored exactly as reliably
   * as one that completes inside the first request. Every credential that lands is followed by a
   * background catalog refresh, so the models it unlocks appear.
   */
  const loginSupervisor = createLoginSupervisor(
    (id) => {
      const provider = models.getProviders().find((candidate) => candidate.id === id);
      if (!provider) return undefined;
      const oauth = provider.auth.oauth;
      return {
        id: provider.id,
        ...(oauth === undefined
          ? {}
          : {
              oauth: {
                loginLabel: oauth.loginLabel,
                name: oauth.name,
                login: (interaction, options) => oauth.login(interaction, options),
              },
            }),
      } satisfies LoginProvider;
    },
    async (providerId, credential) => {
      if (!store) throw new Error("this Hearth has no credential store to save it in");
      await store.modify(providerId, async () => credential as Credential);
      refreshModelCatalog(`a sign-in for ${providerId}`);
    }
  );

  /**
   * Every sign-in answer, and never the credential in it.
   *
   * The supervisor stores the credential on the flow's terminal event and reports what it stored
   * (`credentialType`); a secret on the wire would be one more copy of it to leak, and the client
   * has nothing to do with it.
   */
  const loginAnswer = (state: LoginState): Response =>
    json(
      state.status === "complete"
        ? { status: state.status, events: state.events, credentialType: state.credentialType }
        : state.status === "failed"
          ? { status: state.status, events: state.events, error: state.error }
          : { status: state.status, events: state.events }
    );

  /**
 * A stream snapshot carries the *live* state and no history.
 *
 * The snapshot exists so a late joiner learns `run`, `generation`, `tools`, `inbox`, `agent` and
 * `usage`, and all of that is small. `entries` is the whole conversation, and shipping it is ruinous
 * on a long session: one here measured 47MB in a single frame, re-sent on every reconnect. 0.29.4
 * bounded it to the last 200 entries, which was not enough -- this host has a conversation of 122
 * entries totalling 45MB, so the slice never fired (measured 43MB per attach, and 79.6MB for one
 * reconnect of all 68 conversations a client watches).
 *
 * Nothing reads it. Ember's transport reduces a frame to event types and refetches over REST
 * (`electron/piClient.ts`), so the payload bought nothing and was large enough to look like a freeze.
 * A client that renders history asks `GET /conversations/:id/entries`, which is incremental now
 * (`since`), and a client that wants the live state needs none of it. The field stays in the payload,
 * empty, so the shape a client reads does not change.
 */
const snapshotWithoutHistory = <T extends { entries: readonly unknown[] }>(snapshot: T): T =>
  snapshot.entries.length === 0 ? snapshot : ({ ...snapshot, entries: [] } as T);

/**
 * Replace inline image payloads with a reference the client can fetch.
 *
 * A `view` tool result is a screenshot: 2.3MB of base64 inside one entry record. Entry pages are
 * re-read on every open and every repair, so a session with nine of them costs ~20MB per read for
 * images that are usually scrolled past. With `images=ref` a block's payload becomes its coordinates,
 * and `GET /conversations/:id/entries/:entryId/images/:index` serves the bytes on demand.
 *
 * Opt-in: a client that cannot resolve a reference keeps receiving the image itself, so this can
 * ship before its reader does.
 */
const IMAGE_REF = "image-ref";

/**
 * How many bytes of entry records one page may carry, independent of the row `limit`.
 *
 * `limit` counts rows, and rows are not the same size: a text turn is a few KB while a turn
 * carrying a screenshot is megabytes. `limit=500` is therefore a bound of 500 *rows*, which on a
 * conversation with screenshots is a bound of gigabytes - and the read materializes every record
 * it selects (`pi-durable`'s `readEntries` does `parseJson` per row), so the row limit alone let
 * one request take the process past Bun's heap ceiling. That is the crash this cap prevents.
 *
 * 12 MB keeps a normal 40-entry page fast while still bounding a worst case. Raising `limit`
 * cannot push a single response past it; a page that would exceed it stops early and reports a
 * `next` cursor instead, which every client already handles.
 */
const PAGE_BYTE_BUDGET = 12 * 1024 * 1024;

/**
 * The full read (`GET /conversations/:id`) is a page too: the newest `SNAPSHOT_ROWS` entries, at
 * most `SNAPSHOT_BYTE_BUDGET` of JSON, with a `next` cursor for the rest.
 *
 * It used to return the *whole* active transcript, built through `viewState()`, and that was the
 * largest single allocation this host made. Measured 2026-11-04 on Heliograph against the 951-entry
 * conversation here: a 44 MB response and **238 MB of peak heap for one request** — every record
 * parsed into objects, then `JSON.stringify`d twice (once to measure, once for the body). Two
 * clients opening a few long conversations at once is therefore gigabytes of transient heap, and
 * JSC does not hand those pages back, so the process ratchets up until systemd-oomd kills the unit
 * — which is how a Chromium launched by this host's own Playwright MCP came to find no memory for
 * its GPU process and died on the "GPU process isn't usable" check (SIGTRAP in `coredumpctl`,
 * 2026-11-04 16:44).
 *
 * `SNAPSHOT_ROWS` is the row cap, not the byte budget, that bounds `pi-durable`'s parse: the rows
 * are materialized before anything can be trimmed. It is `LIMIT_MAX` for the same reason a page is.
 */
const SNAPSHOT_ROWS = LIMIT_MAX;
const SNAPSHOT_BYTE_BUDGET = PAGE_BYTE_BUDGET;

/** JSON size of an entry as it will be sent, without serializing it twice. */
const entryBytes = (entry: unknown): number => {
  try {
    return JSON.stringify(entry)?.length ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Trim a page to the byte budget, keeping at least one entry.
 *
 * The budget counts the entry **as materialized**, not as sent: `images=ref` shrinks the response
 * but not the parse, and the parse is what cost the heap. A caller that asked for references gets
 * a smaller body, never more rows than the budget would have allowed inline — otherwise a page of
 * 100 screenshot entries would be 500 MB of parsed records with a 200 KB answer.
 *
 * Returns the entries that fit and a cursor pointing at the oldest one dropped, so the caller can
 * page on. The first entry is always kept even when it alone exceeds the budget: refusing to
 * return anything would stall a client forever on one huge entry, and one entry is a bounded
 * cost we accept.
 */
const fitToBudget = <T extends { id: unknown }>(
  items: readonly T[],
  budget: number,
): { items: T[]; next: Cursor | undefined } => {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = entryBytes(item);
    if (kept.length > 0 && used + size > budget) {
      // `items` arrives newest-first, so the oldest retained entry is the last one kept. Its id is
      // the `after` a descending scan resumes below, which is exactly what the storage cursor means.
      const after = kept[kept.length - 1].id;
      return { items: kept, next: { after: after as number } };
    }
    kept.push(item);
    used += size;
  }
  return { items: kept, next: undefined };
};

/** The built-in conversation documents, keyed by kind, exactly as a view mount publishes them. */
const documentsOf = async (harness: Harness, id: ConversationId): Promise<Record<string, unknown>> => {
  const [agent, live, inbox, provider, usage] = await Promise.all([
    harness.snapshot(AgentDoc, id, context),
    harness.snapshot(LiveDoc, id, context),
    harness.snapshot(InboxDoc, id, context),
    harness.snapshot(ProviderDoc, id, context),
    harness.snapshot(UsageDoc, id, context),
  ]);
  const docs: Record<string, unknown> = {};
  if (agent !== undefined) docs["pi.agent"] = agent;
  if (live !== undefined) docs["pi.live"] = live;
  if (inbox !== undefined) docs["pi.inbox"] = inbox;
  if (provider !== undefined) docs["pi.provider"] = provider;
  if (usage !== undefined) docs["pi.usage"] = usage;
  return docs;
};

type EntryShape = { id: unknown; model?: readonly { content?: readonly unknown[] }[] };

/** Entry with every image block's payload replaced by its coordinates; other blocks untouched. */
const imageRefsOf = <T extends EntryShape>(entry: T): T => {
  if (!Array.isArray(entry.model)) return entry;
  let index = 0;
  let changed = false;
  const model = entry.model.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((block: unknown) => {
      const value = block as { type?: unknown; data?: unknown; mimeType?: unknown };
      if (value?.type !== "image" || typeof value.data !== "string") return block;
      messageChanged = true;
      changed = true;
      return { type: IMAGE_REF, entryId: entry.id, index: index++, mimeType: value.mimeType };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? { ...entry, model } : entry;
};

/** The `index`-th image of an entry, counted across its messages in order. */
const imageOfEntry = (entry: EntryShape, wanted: number): { bytes: Uint8Array; mimeType: string } | undefined => {
  let index = 0;
  for (const message of entry.model ?? []) {
    for (const block of message.content ?? []) {
      const value = block as { type?: unknown; data?: unknown; mimeType?: unknown };
      if (value?.type !== "image" || typeof value.data !== "string") continue;
      if (index++ !== wanted) continue;
      return {
        bytes: new Uint8Array(Buffer.from(value.data, "base64")),
        mimeType: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream",
      };
    }
  }
  return undefined;
};

/** How many images an entry carries, for the sentence a wrong image index gets. */
const imagesInEntry = (entry: EntryShape): string => {
  let count = 0;
  for (const message of entry.model ?? []) {
    for (const block of message.content ?? []) {
      const value = block as { type?: unknown; data?: unknown };
      if (value?.type === "image" && typeof value.data === "string") count += 1;
    }
  }
  return count === 1 ? "one image (index 0)" : count === 0 ? "no images at all" : `${count} images (indexes 0 to ${count - 1})`;
};

/**
 * The routes this host answers, used only to *word* a 404.
 *
 * `{"error":"not found"}` answered three different mistakes: no such route, a known route with a
 * method it does not answer, and a route whose id does not exist. A client could not tell a wrong
 * path from a wrong method from a wrong id, so it could not correct any of them. Nothing here
 * decides routing — a stale row can only produce a worse sentence, never a wrong answer.
 */
const ROUTE_METHODS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^\/health$/, ["GET"]],
  [/^\/admin\/restart$/, ["POST"]],
  [/^\/models$/, ["GET"]],
  [/^\/usage$/, ["GET"]],
  [/^\/providers$/, ["GET"]],
  [/^\/providers\/import$/, ["POST"]],
  [/^\/providers\/[^/]+\/login$/, ["GET", "POST", "DELETE"]],
  [/^\/providers\/[^/]+$/, ["POST", "DELETE"]],
  [/^\/directories$/, ["GET", "POST"]],
  [/^\/directory$/, ["GET"]],
  [/^\/directory\/peers$/, ["GET", "PUT"]],
  [/^\/directory\/send$/, ["POST"]],
  [/^\/queue$/, ["GET"]],
  [/^\/context-rules$/, ["GET", "POST"]],
  [/^\/context-rules\/[^/]+$/, ["PATCH", "DELETE"]],
  [/^\/scheduled-tasks$/, ["GET", "POST"]],
  [/^\/scheduled-tasks\/[^/]+\/run$/, ["POST"]],
  [/^\/scheduled-tasks\/[^/]+$/, ["PATCH", "DELETE"]],
  [/^\/conversations$/, ["GET", "POST"]],
  [/^\/conversations\/[^/]+$/, ["GET", "PATCH"]],
  [/^\/conversations\/[^/]+\/events$/, ["GET"]],
  [/^\/tasks\/stream$/, ["GET"]],
  [/^\/approvals$/, ["GET"]],
  [/^\/approvals\/[^/]+\/[^/]+\/reply$/, ["POST"]],
  [/^\/questions$/, ["GET"]],
  [/^\/questions\/[^/]+\/[^/]+\/reply$/, ["POST"]],
];

/** The actions a conversation answers, for the same 404 sentence. */
const CONVERSATION_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  entries: ["GET"],
  submit: ["POST"],
  abort: ["POST"],
  compact: ["POST"],
  "queue/order": ["PUT"],
  fork: ["POST"],
  btw: ["POST"],
  promote: ["POST"],
  reset: ["POST"],
  configure: ["POST"],
  "auto-accept": ["PUT", "POST"],
  events: ["GET"],
  processes: ["GET"],
  "processes/stop": ["POST"],
};

const methodsSpoken = (methods: readonly string[]): string =>
  methods.length === 1 ? methods[0]! : `${methods.slice(0, -1).join(", ")} and ${methods.at(-1)}`;

/**
 * The 404 for a request that matched no route: it says whether the path exists at all, and which
 * methods it answers, so the caller can fix the request rather than guess at it.
 */
const noRoute = (method: string, path: string, methods: readonly string[] | undefined): Response =>
  json(
    methods === undefined
      ? { error: `no route of this host matches ${method} ${brief(path, 120)}; the README's wire table lists every one` }
      : { error: `${brief(path, 120)} answers only ${methodsSpoken(methods)}, not ${method}` },
    404
  );

const routeMethods = (path: string): readonly string[] | undefined =>
  ROUTE_METHODS.find(([pattern]) => pattern.test(path))?.[1];

/** The 404 for an unmatched action inside an existing conversation. */
const noConversationAction = (conversationId: ConversationId, method: string, action: string): Response => {
  const methods =
    CONVERSATION_ACTIONS[action] ?? (/^submissions\/[^/]+\/abort$/.test(action) ? ["POST"] : undefined);
  return noRoute(method, `/conversations/${conversationId}/${brief(action, 80)}`, methods);
};

/**
 * Stream admission: per-peer buckets and a concurrency ceiling, created with the server so a
 * restart forgets them. Refusals are 429s the client retries, not dropped sockets.
 */
const streamLimiter = createStreamLimiter();
/** One log line per peer per 5s: a throttled storm is not a per-request event. */
const refusalLoggedAt = new Map<string, number>();
const logRefusal = (peer: string, verdict: "rate" | "concurrent", now = Date.now()): void => {
  const last = refusalLoggedAt.get(peer) ?? 0;
  if (now - last < 5_000) return;
  refusalLoggedAt.set(peer, now);
  console.warn(
    `[hearth] refusing a stream from ${peer}: ${verdict === "rate" ? "too many reconnects" : "already holds the maximum live streams"}`
  );
};

const STREAM_RATE_COPY =
  "Hearth is holding new streams from this device for a moment: it reconnected several times in the last second. It keeps retrying by itself, and the conversations already open are unaffected.";
const STREAM_CONCURRENT_COPY = (limit: number) =>
  `This device already holds ${limit} live streams, which is Hearth's ceiling. Close a window, or wait for the old streams to drop — the conversations themselves are unaffected.`;

/** A refusal is a retryable 429 the client's own backoff handles, never a dropped socket. */
const streamRefusal = (verdict: "rate" | "concurrent"): Response =>
  new Response(
    JSON.stringify({
      error: verdict === "rate" ? STREAM_RATE_COPY : STREAM_CONCURRENT_COPY(STREAM_LIMITS.maxConcurrent),
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "2",
        // Without this the refused connection is kept alive, and a client that opens a stream,
        // ignores the answer and tries again leaves one ESTABLISHED socket per attempt behind:
        // measured at 4,152 of them in a minute from one storming client.
        connection: "close",
      },
    }
  );

const server = Bun.serve<{
    conversationId?: ConversationId;
    tasks?: boolean;
    /** The conversation's state watch (pi-durable 1.5.0 `Conversation.watch`). */
    watch?: ConversationWatch;
    graph?: TaskGraphWatch;
    /** Interval that keeps an idle stream alive; cleared when the socket closes. */
    keepalive?: ReturnType<typeof setInterval>;
    /** Set once a frame was dropped: the socket is closing and must not be sent to again. */
    lost?: boolean;
    /** Backpressure: nothing is written until Bun reports `drain` (see `src/stream.ts`). */
    paused?: boolean;
    pausedSince?: number;
    /** The remote address that opened this stream, released from the limiter when it closes. */
    peer?: string;
  }>({
    port: config.port,
    hostname: config.bind,
    /**
     * The last line of defence at the boundary: every failure leaves here as `{"error": …}`.
     *
     * Without it, an escaped throw is answered by Bun's development error page — 50 KB of HTML
     * carrying the absolute install path, the `node_modules` layout and the throwing function's
     * source — and a JSON client cannot even parse it, so "bad query" reads as a crash. The real
     * error goes to the host log, where the operator can see it; the caller gets a sentence it can
     * act on and nothing about this machine.
     */
    error(error) {
      if (error instanceof HttpFailure) return json({ error: error.message }, error.status);
      console.error("[hearth] request failed:", error);
      return json(
        {
          error:
            "Hearth hit an internal error answering this request and did not finish it. The conversation is unaffected: reload it, and check the host log if it keeps happening.",
        },
        500
      );
    },
    websocket: {
      // Bun closes a socket that has been idle for 120s by default, and these streams are
      // server-push only: a quiet conversation sends *nothing*, so the socket dies on a schedule
      // and the client reconnects forever. Raising the ceiling and sending a heartbeat keeps an
      // idle stream open, which is the whole point of subscribing to it.
      idleTimeout: 960,
      // The ceiling on one socket's unsent bytes, stated rather than inherited (Bun's default is the
      // same 16 MB). A stream that pauses on backpressure never grows past this, so it is also the
      // bound on what ~200 stalled sockets could pin; a single frame larger than this would be
      // dropped, which is why it is not tuned lower — a `tool_execution_update` can carry an image.
      backpressureLimit: 16 * 1024 * 1024,
      // Dropping is handled here (`sendFrame` closes for a resync), so Bun must not close a socket
      // out from under a client that is merely behind.
      closeOnBackpressureLimit: false,
      // Streams attach after the upgrade: the conversation events stream sends its
      // `snapshot` event first, then each batch as one JSON array; the task graph sends
      // the whole value on attach and after every change.
      async open(ws) {
        // An empty batch: valid JSON, parses to zero events, and every client ignores it. Its only
        // job is to be bytes on the wire so neither end decides the connection is dead. 25s sits
        // comfortably under Ember's 90s stall deadline and Bun's idle timeout.
        ws.data.keepalive = setInterval(() => {
          // A keepalive that cannot be written is the same news as a delta that cannot: the client
          // is not reading. `sendFrame` closes the socket so it reconnects rather than waiting out
          // the idle timeout on a stream it cannot receive.
          sendFrame(ws, ws.data, "[]", "keepalive");
        }, 25_000);
        try {
          if (ws.data.conversationId) {
            const conversation = await harness.conversation(ws.data.conversationId, context);
            if (conversation === undefined) {
              ws.close();
              return;
            }
            // A window, not the whole transcript: 1.5.0's mount holds the newest `min` entries and
            // grows to `max`, so a long conversation no longer keeps tens of megabytes parsed for
            // every open socket (measured: 275 MB of active entries across this host's
            // conversations, 93 MB windowed — `scripts/diag/window-cost.ts`).
            const watch = await conversation.watch(context, { min: 50, max: 100 });
            // The socket can close while the watch attaches (a reconnect storm is exactly when the
            // session line is busy), and `close` only stops a watch it can see. Without this the
            // watch stays attached for ever: its view mount pinned, every commit applied to it.
            if (ws.data.lost || ws.readyState !== 1) {
              void watch.stop();
              return;
            }
            ws.data.watch = watch;
            // One JSON array per message. Attach sends the live state a client draws; history stays
            // on `GET /conversations/:id/entries`, which is paged and byte-bounded.
            sendFrame(ws, ws.data, JSON.stringify(attachFrames(watch.value)), "stream view");
            let previous: ConversationView | undefined = watch.value;
            watch.start(async (call) => {
              if (call.kind !== "value") return;
              let frames;
              try {
                frames = framesOf(previous, call.value, call.ops);
              } catch (error) {
                // A frame this host cannot build must not silence the rest of the turn: say "look
                // again" and let the client's tail read be the correction.
                console.error("[hearth] stream frame failed:", error);
                frames = [{ type: "changed" as const, kinds: ["unknown"] }];
              }
              previous = call.value;
              if (frames.length === 0) return;
              sendFrame(ws, ws.data, JSON.stringify(frames), "stream frame");
              // The conversation is gone (deleted, or its owner retired): nothing more will come.
              if (call.retired) ws.close();
            });
          } else if (ws.data.tasks) {
            const graph = await harness.watchTaskGraph(context);
            if (ws.data.lost || ws.readyState !== 1) {
              void graph.stop();
              return;
            }
            ws.data.graph = graph;
            sendFrame(ws, ws.data, JSON.stringify(graph.value), "task graph");
            void graph.start(async (call) => {
              if (call.kind !== "value") return;
              sendFrame(ws, ws.data, JSON.stringify(call.value), "task graph update");
            });
          }
        } catch (error) {
          console.error("[hearth] stream attach failed", error);
          ws.close();
        }
      },
      message() {
        // The wire is server-push only; clients never send.
      },
      drain(ws) {
        // The socket took what was buffered: streams can be written again. One line, because a
        // pause that ends is worth being able to correlate with the pause that started.
        if (ws.data.paused) {
          console.log("[hearth] stream drained; resuming");
          ws.data.paused = false;
          ws.data.pausedSince = undefined;
        }
      },
      close(ws) {
        // Set before anything else: an attach still in flight checks it and stops its own watch.
        ws.data.lost = true;
        if (ws.data.peer) streamLimiter.release(ws.data.peer);
        if (ws.data.keepalive) {
          clearInterval(ws.data.keepalive);
          ws.data.keepalive = undefined;
        }
        const watch = ws.data.watch;
        if (watch) void watch.stop();
        const graph = ws.data.graph;
        if (graph) void graph.stop();
      },
    },
    async fetch(request, server) {
      if (!authorized(request, token)) return json({ error: "unauthorized" }, 401);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // ---- health --------------------------------------------------------------------
      if (request.method === "GET" && path === "/health") {
        // The host's own footprint, so "Hearth was killed for memory" can be answered without a
        // profiler after the fact — the 2026-11-04 kill could not be split between Hearth and the
        // processes its agents had launched, because nothing recorded either number.
        const usage = process.memoryUsage();
        const host = memory();
        return json({
          ok: true,
          service: "hearth",
          version: version ?? "0.0.0",
          ...(build ? { commit: build } : {}),
          memory: {
            ...host,
            rssBytes: usage.rss,
            heapUsedBytes: usage.heapUsed,
            // Host-wide leftovers, from the cached scan on Linux and the ledger elsewhere.
            leftRunning: scan().all.length,
          },
        });
      }

      // ---- admin ---------------------------------------------------------------------
      // Graceful self-restart so an operator (or Ember) doesn't need shell access after a
      // `git pull`: respond first, then hand off to the host's supervisor, which brings Hearth
      // back on the new code. Durable runs resume on reopen. Non-zero exit (set by the host)
      // so restart-on-failure supervisors restart too.
      if (request.method === "POST" && path === "/admin/restart") {
        if (!restart) return badRequest("restart is not supported on this host");
        const body = (await readBody(request)) as { reason?: unknown };
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "requested";
        restart(reason);
        return json({ ok: true, restarting: true, reason, version: version ?? "0.0.0", ...(build ? { commit: build } : {}) });
      }

      // ---- models + usage --------------------------------------------------------------
      if (request.method === "GET" && path === "/models") {
        // Only offer models whose provider has a usable credential; otherwise the picker
        // offers models that can never run (a generation would fail with an auth error).
        // Fall back to the full catalogue if auth resolution fails.
        const available = await models.getAvailable().catch(() => models.getModels());
        return json({
          models: available,
          default: defaultAgent.model,
        });
      }
      if (request.method === "GET" && path === "/usage") {
        return json(await harness.usage(context));
      }

      // ---- provider sign-in (OAuth) ----------------------------------------------------
      // Some providers only issue tokens through a browser round-trip. pi-ai implements those
      // flows; this exposes them as a start/poll pair, because the flow blocks until the human
      // finishes while this server speaks JSON rather than SSE. See `src/login.ts`.
      //
      // The credential is deliberately absent from every answer here. The supervisor stores it on
      // the flow's terminal event and reports what it stored (`credentialType`); a secret on the
      // wire would be one more copy of it to leak, and the client has nothing to do with it.
      if (path.startsWith("/providers/") && path.endsWith("/login")) {
        const providerId = decodeSegment(path.slice("/providers/".length, -"/login".length));
        if (!providerId) return badRequest("missing provider id");

        if (request.method === "GET") {
          const state = await loginSupervisor.settled(providerId);
          if (!state) return notFound(`no sign-in is in progress for provider "${brief(providerId, 100)}"`);
          return loginAnswer(state);
        }

        if (request.method === "DELETE") {
          return json({ ok: true, cancelled: loginSupervisor.cancel(providerId) });
        }

        if (request.method === "POST") {
          if (!store) return badRequest("no credential store");
          try {
            // Storage happens inside the supervisor's own callback, so nothing here has to notice
            // which request the flow happened to finish on.
            return loginAnswer(await loginSupervisor.start(providerId));
          } catch (error) {
            return badRequest(error instanceof Error ? error.message : String(error));
          }
        }
      }

      // ---- providers -------------------------------------------------------------------
      // The providers Hearth serves and whether each holds a credential. Never returns the
      // secret — only the credential type — so a client can show status. Credentials live in
      // `$HEARTH_HOME/auth.json`; see PROVIDER_MIGRATION.md.
      if (request.method === "GET" && path === "/providers") {
        const stored = store ? await store.list() : [];
        const types = new Map(stored.map((entry) => [entry.providerId, entry.type]));
        const providers = models.getProviders().map((provider) => {
          const oauth = provider.auth.oauth;
          // Only a flow Hearth can actually finish is offered: `loginSupport` is the same check the
          // start route refuses on, so a button that would fail is never drawn (see `src/login.ts`).
          const support = loginSupport(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            credential: types.get(provider.id) ?? null,
            // Enough for a client to offer a sign-in button without knowing which flows exist.
            signIn:
              oauth?.login && support.supported
                ? {
                    label: oauth.loginLabel ?? oauth.name ?? "Sign in",
                    pending: loginSupervisor.pending(provider.id),
                  }
                : null,
          };
        });
        // Local runtimes are described even when absent: "Ollama is running but has no models" and
        // "LM Studio is not answering" are the two things a picker cannot say by itself, and the
        // difference between them is what tells someone whether to install a model or start an app.
        return json({ providers, default: defaultAgent.model, ...(localRuntimes ? { localRuntimes } : {}) });
      }
      // Copy credentials out of OpenCode's store (once), so Hearth no longer depends on it.
      if (request.method === "POST" && path === "/providers/import") {
        if (!store) return badRequest("no credential store");
        const imported = await importOpenCodeCredentials(store);
        // Imported credentials can unlock providers that had none, so the catalog is re-read.
        if (imported.length > 0) refreshModelCatalog("an import");
        return json({ imported });
      }
      // Set (`POST`) or clear (`DELETE`) one provider's credential.
      if (path.startsWith("/providers/") && (request.method === "POST" || request.method === "DELETE")) {
        if (!store) return badRequest("no credential store");
        const providerId = decodeSegment(path.slice("/providers/".length));
        if (!providerId) return badRequest("missing provider id");
        if (request.method === "DELETE") {
          await store.delete(providerId);
          // A provider that existed only for this credential must stop being offered; the catalog
          // is re-read in the background rather than keeping the answer waiting on the network.
          refreshModelCatalog(`clearing ${providerId}`);
          return json({ ok: true, provider: providerId, credential: null });
        }
        const body = (await request.json().catch(() => null)) as Credential | null;
        if (!isCredential(body)) return badRequest('expected a credential, e.g. { "type": "api_key", "key": "…" }');
        const credential = await store.modify(providerId, async () => body);
        refreshModelCatalog(`a credential for ${providerId}`);
        return json({ ok: true, provider: providerId, credential: credential?.type ?? null });
      }

      // ---- directories ----------------------------------------------------------------
      // The folder browser for a new conversation: immediate subdirectories of the configured
      // workspace root by default. Explicit `scope=computer` allows choosing existing work elsewhere.
      // Both modes are token-authenticated and only return folder names, never file contents.
      if (request.method === "POST" && path === "/directories") {
        const input = await request.json().catch(() => null) as { parent?: unknown; name?: unknown } | null;
        if (!input || typeof input.parent !== "string" || !input.parent.trim() || typeof input.name !== "string") return badRequest("Choose a parent folder and a name.");
        const name = input.name.trim();
        if (!name || name === "." || name === ".." || name.length > 255 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
          return badRequest("Use a folder name without slashes or special characters.");
        }
        const parent = resolve(input.parent);
        const root = resolve(config.workspace);
        if (url.searchParams.get("scope") !== "computer" && parent !== root && !parent.startsWith(root + "/") && !parent.startsWith(root + "\\")) {
          return badRequest("Choose a folder inside the workspace.");
        }
        try {
          const directory = join(parent, name);
          // No recursive creation or overwrite: a typo in the parent never creates a new tree.
          mkdirSync(directory);
          return json({ path: directory }, 201);
        } catch {
          return badRequest("Kiln could not create that folder. Choose another name or check access to the parent folder.");
        }
      }
      if (request.method === "GET" && path === "/directories") {
        const root = resolve(config.workspace);
        const requested = url.searchParams.get("path");
        const target = resolve(requested && requested.trim() ? requested : root);
        // Explicit computer browsing lets the human choose where their existing work lives.
        // This endpoint is token-authenticated, like conversation creation with an arbitrary cwd.
        if (url.searchParams.get("scope") !== "computer" && target !== root && !target.startsWith(root + "/") && !target.startsWith(root + "\\")) {
          return badRequest("path is outside the workspace");
        }
        // `hasChildren` lets a client draw the "open folder" affordance only where descending
        // leads somewhere: an empty folder would otherwise look like a dead end after a click.
        const visible = (dir: string): string[] => {
          try {
            return readdirSync(dir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
              .map((entry) => entry.name);
          } catch {
            return [];
          }
        };
        let directories: Array<{ name: string; path: string; hasChildren: boolean }>;
        try {
          directories = readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
            .map((entry) => {
              const child = join(target, entry.name);
              return { name: entry.name, path: child, hasChildren: visible(child).length > 0 };
            })
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 500);
        } catch {
          return badRequest("not a directory");
        }
        return json({ workspace: root, path: target, directories });
      }

      // ---- agent directory --------------------------------------------------------------
      // The local registry merged with live conversation status. Entries whose conversation is
      // gone or archived are omitted and lazily pruned from `AgentsDoc` + `agents.json` in one commit.
      if (request.method === "GET" && path === "/directory") {
        const entries = listAgents(await harness.snapshot(AgentsDoc, context));
        const summaries = new Map<number, DirectorySummary>();
        for (const entry of entries) {
          if (summaries.has(entry.conversationId)) continue;
          const id = entry.conversationId as ConversationId;
          if (!(await harness.conversation(id, context))) continue;
          summaries.set(entry.conversationId, await summaryOf(harness, { id }));
        }
        const stale = staleAgentNames(entries, summaries);
        if (stale.length > 0) {
          const removed = await harness.commit((tx) => pruneStaleAgents(tx, stale), context);
          if (removed > 0) {
            writeAgentsMirror(config.home, await harness.snapshot(AgentsDoc, context));
          }
        }
        return json({ agents: mergeDirectory(entries, summaries) });
      }

      if (path === "/directory/peers") {
        if (request.method === "GET") {
          const state = await harness.snapshot(AgentsDoc, context);
          return json({
            peers: (state?.peers ?? []).map((p) => ({ id: p.id, label: p.label, url: p.url })),
          });
        }
        if (request.method === "PUT") {
          const body = await readBody(request);
          const rawPeers = Array.isArray(body.peers) ? body.peers : null;
          if (!rawPeers) return badRequest("peers must be an array");
          const peers: PeerEndpoint[] = [];
          for (const item of rawPeers) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const rec = item as Record<string, unknown>;
            const id = string(rec.id, 120)?.trim();
            const label = string(rec.label, 120)?.trim();
            const peerUrl = string(rec.url, 500)?.trim();
            const peerToken = string(rec.token, 500)?.trim();
            if (!id || !label || !peerUrl || !peerToken) continue;
            peers.push({ id, label, url: peerUrl, token: peerToken });
          }
          await harness.commit(async (tx) => {
            const doc = await tx.doc(AgentsDoc);
            doc.peers = peers;
          }, context);
          writePeersMirror(config.home, peers);
          return json({ ok: true, count: peers.length });
        }
        return noRoute(request.method, path, routeMethods(path));
      }

      if (path === "/directory/send") {
        if (request.method !== "POST") return noRoute(request.method, path, routeMethods(path));
        const body = await readBody(request);
        const name = string(body.name, 200)?.trim();
        const message = string(body.message, 50_000)?.trim();
        if (!name) return badRequest("name is required");
        if (!message) return badRequest("message is required");
        const followUp = body.followUp === true;
        const senderHost = string(body.senderHost, 120)?.trim() || "remote";
        const senderName = string(body.senderName, 200)?.trim() || "agent";
        const requestId = string(body.requestId, 200)?.trim();

        const state = await harness.snapshot(AgentsDoc, context);
        const wanted = name.toLowerCase();
        const regEntry =
          state && Object.hasOwn(state.entries, name)
            ? state.entries[name]
            : state
              ? Object.entries(state.entries).find(([k]) => k.toLowerCase() === wanted)?.[1]
              : undefined;

        let targetId: ConversationId | undefined = regEntry
          ? (regEntry.conversationId as ConversationId)
          : undefined;
        let resolvedLabel = name;

        if (targetId === undefined) {
          // Fall back to non-worker conversations by title.
          const records = await allConversations(storage);
          const titleMatches: Array<{ id: ConversationId; title: string }> = [];
          for (const rec of records) {
            const meta = await harness.snapshot(MetaDoc, rec.id, context);
            if (!meta || meta.archived || meta.kind === "worker") continue;
            const title = meta.title?.trim();
            if (title && title.toLowerCase() === wanted) {
              titleMatches.push({ id: rec.id, title });
            }
          }
          if (titleMatches.length > 1) {
            return json(
              {
                error: `More than one conversation on this host is titled "${name}" (${titleMatches.map((m) => m.id).join(", ")}).`,
              },
              409
            );
          }
          if (titleMatches.length === 1) {
            targetId = titleMatches[0].id;
            resolvedLabel = titleMatches[0].title;
          }
        }

        if (targetId === undefined) {
          return notFound(`no agent named "${brief(name, 100)}" on this host`);
        }
        const handle = await harness.conversation(targetId, context);
        if (!handle) {
          return notFound(`agent "${brief(name, 100)}" conversation ${targetId} is gone`);
        }
        const content = formatForeignAgentMessage(senderHost, senderName, message);
        await handle.submit(
          {
            type: "input",
            content,
            whenBusy: followUp ? "followUp" : "steer",
            ...(requestId ? { requestId } : {}),
          },
          context
        );
        return json({ ok: true, name: resolvedLabel, conversationId: targetId }, 201);
      }

      // ---- queue ------------------------------------------------------------------------
      // One aggregated view of every conversation's inbox, so a client can render and cancel
      // queued follow-ups without fetching each conversation's snapshot. Items are bounded to
      // their display text; `revision` is a fresh stamp (the client merges by session/item id).
      const queueSessionOf = async (id: ConversationId) => {
        const [inbox, agent] = await Promise.all([
          harness.snapshot(InboxDoc, id, context),
          harness.snapshot(AgentDoc, id, context),
        ]);
        return {
          sessionId: String(id),
          directory: agent?.cwd ?? "",
          model: agent?.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : undefined,
          thinkingLevel: agent?.thinkingLevel,
          sendingId: null,
          items: (inbox?.items ?? []).map((item) => ({
            id: String(item.id),
            mode: item.mode,
            text: inboxTextOf(item as { mode: "steer" | "followUp" | "write"; content?: unknown; entry?: unknown }),
            // Input items carry their content parts back, so a client can keep showing an attached
            // image on a queued row (and re-submit it whole on "send now") rather than losing it on
            // the first poll. `text` above stays the bounded preview.
            ...(item.mode === "write" ? {} : { content: item.content }),
          })),
        };
      };
      if (request.method === "GET" && path === "/queue") {
        const sessions = [];
        for (const record of await allConversations(storage)) {
          const session = await queueSessionOf(record.id);
          if (session.items.length === 0) continue;
          sessions.push(session);
        }
        return json({ revision: Date.now(), sessions });
      }

      // ---- context rules ----------------------------------------------------------------
      // Keyword-triggered context: rules that inject a snippet when a message mentions a keyword.
      if (path === "/context-rules") {
        if (request.method === "GET") {
          return json({ rules: (await listContextRules(harness, context)).rules });
        }
        if (request.method === "POST") {
          const input = parseContextRuleInput(await readBody(request));
          if (!input) return badRequest("invalid context rule");
          return json(await createContextRule(harness, input, context), 201);
        }
        return noRoute(request.method, path, routeMethods(path));
      }
      const contextRuleMatch = /^\/context-rules\/([^/]+)$/.exec(path);
      if (contextRuleMatch) {
        const id = decodeSegment(contextRuleMatch[1]);
        if (request.method === "PATCH") {
          const updated = await updateContextRule(harness, id, parseContextRulePatch(await readBody(request)), context);
          if (!updated) return notFound(`there is no context rule "${brief(id, 100)}"`);
          return json(updated);
        }
        if (request.method === "DELETE") {
          return (await deleteContextRule(harness, id, context))
            ? json({ ok: true })
            : notFound(`there is no context rule "${brief(id, 100)}"`);
        }
        return noRoute(request.method, path, routeMethods(path));
      }

      // ---- scheduled tasks --------------------------------------------------------------
      // Due-times live in a session doc; the tick loop (see index.ts) submits them to their
      // conversations. `timezone` is the process zone, for clients that display the times.
      if (path === "/scheduled-tasks") {
        if (request.method === "GET") {
          const state = await listScheduledTasks(harness, context);
          return json({ tasks: state.tasks, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          const input = parseScheduledTaskInput(body);
          if (!input) return badRequest(scheduledTaskRefusal(body));
          return json(await createScheduledTask(harness, input, context), 201);
        }
        return noRoute(request.method, path, routeMethods(path));
      }
      const scheduledMatch = /^\/scheduled-tasks\/([^/]+)(?:\/(run))?$/.exec(path);
      if (scheduledMatch) {
        const id = decodeSegment(scheduledMatch[1]);
        const action = scheduledMatch[2];
        if (action === "run" && request.method === "POST") {
          const outcome = await runScheduledTaskNow(harness, id, context);
          if (!outcome) return notFound(`there is no scheduled task "${brief(id, 100)}"`);
          // 409, not 502: nothing went wrong with the task, it is simply still busy. A caller
          // that retries on 5xx would otherwise re-fire the prompt once the run finishes.
          if (outcome.refused) return json(outcome, 409);
          return json(outcome, outcome.status === "ok" ? 200 : 502);
        }
        if (!action && request.method === "PATCH") {
          const updated = await updateScheduledTask(harness, id, parseScheduledTaskPatch(await readBody(request)), context);
          if (!updated) return notFound(`there is no scheduled task "${brief(id, 100)}"`);
          return json(updated);
        }
        if (!action && request.method === "DELETE") {
          return (await deleteScheduledTask(harness, id, context))
            ? json({ ok: true })
            : notFound(`there is no scheduled task "${brief(id, 100)}"`);
        }
        return noRoute(request.method, path, routeMethods(path));
      }

      // ---- conversation streams (WebSocket) ---------------------------------------------
      const eventsMatch = /^\/conversations\/([^/]+)\/events$/.exec(path);
      if (eventsMatch && request.method === "GET") {
        const conversationId = idOf<ConversationId>(decodeSegment(eventsMatch[1]));
        if (!conversationId) return badRequest("invalid conversation id");
        if (!(await harness.conversation(conversationId, context))) {
          return notFound(`there is no conversation ${conversationId}`);
        }
        const peer = server.requestIP(request)?.address ?? "unknown";
        const verdict = streamLimiter.admit(peer);
        if (verdict !== "ok") {
          logRefusal(peer, verdict);
          return streamRefusal(verdict);
        }
        if (server.upgrade(request, { data: { conversationId, peer } })) return undefined;
        streamLimiter.release(peer);
        return badRequest("websocket upgrade failed");
      }
      if (request.method === "GET" && path === "/tasks/stream") {
        const peer = server.requestIP(request)?.address ?? "unknown";
        const verdict = streamLimiter.admit(peer);
        if (verdict !== "ok") {
          logRefusal(peer, verdict);
          return streamRefusal(verdict);
        }
        if (server.upgrade(request, { data: { tasks: true, peer } })) return undefined;
        streamLimiter.release(peer);
        return badRequest("websocket upgrade failed");
      }

      // ---- conversations ----------------------------------------------------------------
      if (path === "/conversations") {
        if (request.method === "GET") {
          const records = await allConversations(storage);
          // One scan for the page rather than one per conversation: the process table is read once
          // and every summary picks its own conversation out of it.
          const leftovers = scan().byConversation;
          const summaries = await Promise.all(
            records.map((record) => summaryOf(harness, record, leftovers.get(record.id as number)))
          );
          summaries.sort(byLastEntry);
          // `host` is the whole machine's memory, not a conversation's: it is what turns a session's
          // "2 programs running" notice from information into a warning worth acting on.
          return json({ conversations: summaries, host: { memory: memory() } });
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          const change = parseAgentChange(body);
          if (change?.cwd && !isDirectory(change.cwd)) {
            return badRequest(`folder does not exist: ${change.cwd}`);
          }
          const conversation = await harness.createConversation(
            { ownership: { kind: "ownerless" }, ...(change ? { agent: change } : {}) },
            context
          );
          const title = string(body.title, 500);
          // Leaders are the default; a plain chat passes `delegates: false`.
          const delegates = body.delegates === false ? false : true;
          await harness.commit(async (tx) => {
            const doc = await tx.doc(MetaDoc, conversation.id);
            if (title) doc.title = title;
            doc.delegates = delegates;
          }, context);
          return json(await summaryOf(harness, { id: conversation.id }), 201);
        }
        return noRoute(request.method, path, routeMethods(path));
      }

      const conversationMatch = /^\/conversations\/([^/]+)(\/.*)?$/.exec(path);
      if (conversationMatch) {
        const conversationId = idOf<ConversationId>(decodeSegment(conversationMatch[1]));
        if (!conversationId) return badRequest("invalid conversation id");
        const conversation = await harness.conversation(conversationId, context);
        if (!conversation) return notFound(`there is no conversation ${conversationId}`);
        const action = (conversationMatch[2] ?? "").replace(/^\//, "");

        if (!action && request.method === "GET") {
          // See `SNAPSHOT_BYTE_BUDGET`: this read is a bounded page of the transcript, never the
          // whole of it. Entries stay chronological (oldest first), which is what a snapshot has
          // always been; a `next` means older entries were left out and is the same keyset cursor
          // `/entries` takes, so a client pages backwards with the code it already has.
          const cursor = parseCursor(url.searchParams.get("cursor"));
          const [page, record, docs] = await Promise.all([
            conversation.entries({}, SNAPSHOT_ROWS, cursor, context),
            storage.conversation(conversationId, context),
            documentsOf(harness, conversationId),
          ]);
          if (!record) return notFound(`there is no conversation ${conversationId}`);
          const fitted = fitToBudget(page.items, SNAPSHOT_BYTE_BUDGET);
          const next = fitted.next ?? page.next;
          // Oldest-first, as a snapshot has always been. Successive pages walk *backwards*: a
          // `next` names older entries, so a client prepends rather than appends.
          const chronological = [...fitted.items].reverse();
          const entries = url.searchParams.get("images") === "ref"
            ? chronological.map((entry) => imageRefsOf(entry as EntryShape))
            : chronological;
          return json({ conversation: record, entries, docs, ...(next ? { next } : {}) });
        }
        if (!action && request.method === "PATCH") {
          const body = await readBody(request);
          const hasTitle = body.title !== undefined;
          const title = !hasTitle ? undefined : body.title === null ? null : string(body.title, 500) ?? null;
          if (hasTitle && body.title !== null && title === null) return badRequest("invalid title");
          const archived = body.archived === null ? null : typeof body.archived === "number" ? body.archived : undefined;
          if (body.archived !== undefined && body.archived !== null && archived === undefined) {
            return badRequest("invalid archived");
          }
          if (!hasTitle && archived === undefined) return badRequest("nothing to change");
          if (archived === undefined) {
            await harness.commit(async (tx) => {
              const doc = await tx.doc(MetaDoc, conversationId);
              if (title === null) delete doc.title;
              else if (title !== undefined) doc.title = title;
            }, context);
          } else if (archived === null) {
            // Restore only this batch: a worker archived individually is left alone.
            await unarchiveCrew(harness, conversationId, title, context);
          } else {
            // Cascade: archive the target and every worker descendant under one batch, stopping
            // running workers first. Peers are never cascaded.
            await archiveCrew(harness, conversationId, archived, title, context);
          }
          return json(await summaryOf(harness, { id: conversationId }));
        }

        if (action === "processes" && request.method === "GET") {
          // The list behind a session's "left running" notice: the same scan the summaries use, but
          // fresh and with the host's memory level, which is what decides whether the client renders
          // that notice calmly or as a warning.
          const fresh = scan({ fresh: true });
          return json({
            host: { memory: memory() },
            processes: fresh.byConversation.get(conversationId as number) ?? [],
          });
        }

        if (action === "processes/stop" && request.method === "POST") {
          // Stop what this conversation left running, and nothing else. A pid is only acted on when
          // the scan still attributes it to *this* conversation: a recycled pid, or one belonging to
          // another session, answers `gone` rather than being signalled. `force` is the second step a
          // person takes after a polite request was ignored — SIGKILL, not a different permission.
          const body = await readBody(request);
          const requested: number[] = [];
          if (body.pids !== undefined && !Array.isArray(body.pids)) {
            return badRequest("pids must be a list of process ids, as numbers");
          }
          for (const value of Array.isArray(body.pids) ? body.pids : []) {
            const pid = Number(value);
            if (!Number.isSafeInteger(pid) || pid <= 0) {
              return badRequest("pids must be a list of process ids, as numbers");
            }
            requested.push(pid);
          }
          if (requested.length === 0) {
            return badRequest("nothing to stop: send pids, the ids from this conversation's processes list");
          }
          if (requested.length > 64) return badRequest("too many processes at once: send at most 64 ids");
          const force = body.force === true;
          const mine = new Map(
            (scan({ fresh: true }).byConversation.get(conversationId as number) ?? []).map((entry) => [entry.pid, entry])
          );
          const running = (pid: number): boolean => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              // EPERM is a process that exists and is not ours to signal; anything else is gone.
              return (error as NodeJS.ErrnoException).code === "EPERM";
            }
          };
          const results: Array<{ pid: number; command?: string; outcome: "stopped" | "gone" | "refused" }> = [];
          for (const pid of requested) {
            const entry = mine.get(pid);
            if (entry === undefined || pid <= 1 || pid === process.pid) {
              results.push({ pid, outcome: running(pid) ? "refused" : "gone" });
              continue;
            }
            try {
              process.kill(pid, force ? "SIGKILL" : "SIGTERM");
            } catch {
              results.push({ pid, command: entry.command, outcome: "gone" });
              continue;
            }
            const deadline = Date.now() + (force ? 500 : 1_500);
            while (Date.now() < deadline && running(pid)) await sleep(100);
            results.push({
              pid,
              command: entry.command,
              outcome: running(pid) ? "refused" : "stopped",
            });
          }
          const after = scan({ fresh: true });
          return json({
            results,
            host: { memory: memory() },
            processes: after.byConversation.get(conversationId as number) ?? [],
          });
        }

        if (action === "entries" && request.method === "GET") {
          const limit = pageLimit(url.searchParams.get("limit"));
          const cursor = parseCursor(url.searchParams.get("cursor"));
          // `since` asks for entries *newer* than one the reader already holds, which is what a
          // streaming client re-reads every few hundred milliseconds. Without it a "cheap" tail is
          // 40 whole entry records -- measured 21.3MB for one session with screenshots, almost all of
          // it unchanged since the previous read, every 750ms.
          //
          // Exclusive: `since` itself is not returned, so a reader that holds it never sees it twice.
          // A `next` cursor on the answer means entries between `since` and the oldest returned did
          // not fit the limit, and the caller must not treat the result as a complete delta (the
          // reader's own overlap repair is the safe fallback).
          let minEntryId: EntryId | undefined;
          const rawSince = url.searchParams.get("since");
          if (rawSince !== null) {
            const since = Number(rawSince);
            const lowerBound = Number.isSafeInteger(since) && since >= 0 ? idOf<EntryId>(String(since + 1)) : null;
            if (lowerBound === null) {
              throw new HttpFailure(400, `since must be a whole entry id, 0 or greater; "${brief(rawSince)}" is not`);
            }
            minEntryId = lowerBound;
          }
          const page = await conversation.entries(minEntryId === undefined ? {} : { minEntryId }, limit, cursor, context);
          // Applied before the response is shaped: `limit` bounds rows, `PAGE_BYTE_BUDGET` bounds
          // bytes, and both cursors have to agree or a client pages in the wrong direction. The
          // byte cap can only shorten the page, so a `next` from it is always safe to follow.
          const fitted = fitToBudget(page.items, PAGE_BYTE_BUDGET);
          const pageItems = fitted.items;
          const pageNext = fitted.next ?? page.next;
          // `docs=1` returns the conversation's built-in documents alongside the page. A client
          // watching a turn needs `pi.live` (the in-flight generation: reasoning and text that only
          // become an entry when the turn ends) on every streaming event, and the full snapshot
          // carries the whole transcript - megabytes on a long conversation - which is far too much
          // to re-read per delta. The documents are read on their own (`documentsOf`), never through
          // `viewState()`: a view mount materializes the whole active transcript just to hand back
          // five small documents, and this route is re-read every few hundred milliseconds.
          const wantDocs = url.searchParams.get("docs");
          const items = url.searchParams.get("images") === "ref"
            ? pageItems.map((entry) => imageRefsOf(entry as EntryShape))
            : pageItems;
          if (wantDocs === "1" || wantDocs === "true") {
            return json({ entries: items, next: pageNext, docs: await documentsOf(harness, conversationId) });
          }
          return json({ entries: items, next: pageNext });
        }

        // The bytes behind an `image-ref`, served on demand so an entry page never carries them.
        const imageMatch = /^entries\/(\d+)\/images\/(\d+)$/.exec(action);
        if (imageMatch && request.method === "GET") {
          const entryId = idOf<EntryId>(imageMatch[1]);
          const wanted = Number(imageMatch[2]);
          if (!entryId) return badRequest("invalid entry id");
          if (!Number.isSafeInteger(wanted) || wanted < 0) return badRequest("invalid image index");
          const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context);
          const entry = page.items[0];
          if (!entry) return notFound(`conversation ${conversationId} has no entry ${entryId}`);
          const image = imageOfEntry(entry as EntryShape, wanted);
          if (!image) return notFound(`entry ${entryId} has no image ${wanted}; it carries ${imagesInEntry(entry as EntryShape)}`);
          return new Response(image.bytes, {
            headers: { "content-type": image.mimeType, "cache-control": "private, max-age=3600" },
          });
        }

        if (action === "submit" && request.method === "POST") {
          const body = await readBody(request);
          const parsed = parseSubmission(body);
          if ("error" in parsed) return badRequest(parsed.error);
          const draft = parsed.draft;
          // Where this `requestId` stands before anything is written. A retry of a message that
          // never reached the transcript has to be *placed*, not answered with the settled no-op
          // (see `attemptOf`).
          const attempt =
            draft.type === "input" && draft.requestId !== undefined
              ? await attemptOf(storage, conversationId, draft.requestId)
              : undefined;
          const mode = draft.type === "write" ? "write" : draft.whenBusy ?? "followUp";
          const admitted = attempt?.newest;
          if (admitted !== undefined && !neverPlaced(admitted)) {
            // The idempotent hit a retried POST is supposed to get: this message was already
            // placed (or is still queued or running), so nothing is written and the caller is told
            // which submission owns it.
            return json(answerOf(admitted, mode), 201);
          }
          if (attempt !== undefined && attempt.key === undefined) {
            return json(
              {
                error: `requestId \"${brief(draft.requestId ?? "", 100)}\" has been retried ${SUBMIT_ATTEMPT_LIMIT} times and never reached the transcript; send it with a new requestId`,
              },
              409
            );
          }
          // A model that cannot see images would have them replaced with a text placeholder before
          // the request is built, and answer as if nothing was attached. Refuse and say which model.
          if (draft.type === "input") {
            const agent = await harness.snapshot(AgentDoc, conversationId, context);
            const chosen = agent?.model
              ? { provider: agent.model.provider, modelId: agent.model.modelId }
              : defaultAgent.model;
            const refusal = blindModelReason(draft.content, models.getModel(chosen.provider, chosen.modelId));
            if (refusal) return badRequest(refusal);
          }
          // `whenBusy: "reject"` on a busy conversation is the caller's choice being honoured, not a
          // fault: the library throws `ConversationBusy`, and that used to escape the boundary as a
          // 500 page with this machine's paths in it. Refuse it *before* anything is written, so a
          // refused message leaves no trace — most of all no `hearth.context` entry.
          if (draft.type === "input" && draft.whenBusy === "reject") {
            if ((await harness.snapshot(LiveDoc, conversationId, context))?.run !== undefined) {
              return busyRefusal(conversationId);
            }
          }
          // Keyword-triggered context: matching rules land as write entries ahead of the input, and
          // only when the input is actually being placed. Injecting first and submitting second is
          // what left orphan context entries behind a 409: the rules had already been written when
          // the submit was refused.
          if (draft.type === "input") {
            const text = inputTextOf(draft.content);
            if (text.trim()) await injectContextForInput(harness, conversationId, text, context);
          }
          const toPlace = attempt?.key === undefined ? draft : { ...draft, requestId: attempt.key };
          // `Conversation.submit` has two overloads (a draft and a context, or a transaction and a
          // draft); `ReturnType` takes the last, which returns an id.
          let submission: Submission;
          try {
            submission = await conversation.submit(toPlace, context);
          } catch (error) {
            if (!(error instanceof ConversationBusy)) throw error;
            return busyRefusal(conversationId);
          }
          // The full status set, not just the happy two: `queued` (waiting behind a turn),
          // `placed` (in the transcript, a run owns it), `done` (a write entry appended) and
          // `unanswered` (settled without an answer — `reason` says why: aborted, stale, a provider
          // failure). A client that only saw `placed|queued` treated `unanswered` as "sent".
          return json(answerOf(await submission.status(context), mode), 201);
        }

        if (action === "abort" && request.method === "POST") {
          // Stop must feel instant. `conversation.abort()` resolves only once the conversation is
          // idle, which can be dragged out by a step that hasn't reached an abort point yet; the
          // client should not wait on that. Kick off the abort (its marking commit runs at once)
          // and only wait a moment for the common, fast case. The abort keeps running in the
          // background either way, so the run still ends.
          const note = await clearPendingPrompts(harness, conversationId);
          // The queue survives a stop. `abort()` withdraws every queued input (see ./parking), so
          // read the inbox first and put the user's messages back once the abort has finished: a
          // stop ends the run, and it neither loses the message nor starts the conversation again
          // on it.
          //
          // The inbox is re-read inside the post-abort commit as well as here, because `abort()`
          // takes time: an input submitted while it winds down is withdrawn by it too, and reading
          // only once would drop that message. Every parked item keeps its own `mode`, so a steer
          // is still a steer and a follow-up still a follow-up.
          const inboxBefore = await harness.snapshot(InboxDoc, conversationId, context);
          const first = parkedInputs(inboxBefore?.items ?? []);
          const seen = new Set(first.map((item) => item.id));
          const stop = conversation.abort(context);
          const requeue = stop.then(async () => {
            const latest = await harness.snapshot(InboxDoc, conversationId, context);
            const late = parkedInputs(latest?.items ?? []).filter((item) => !seen.has(item.id));
            const parked = [...first, ...late];
            await parkInputs((change) => conversation.commit(change, context), conversationId, parked);
            return parked;
          });
          const settled = await Promise.race([
            requeue.then((parked) => ({ done: true as const, parked })),
            new Promise<{ done: false }>((resolve) =>
              setTimeout(() => resolve({ done: false }), ABORT_FAST_RETURN_MS)
            ),
          ]);
          // Never let a failure become an unhandled rejection, and never let a slow abort hold the
          // response: it is expected to keep going after the caller has been told "stopping". The
          // parked items are reported from what was read, which is every message the stop can
          // return to the inbox.
          void requeue.catch((error: unknown) => {
            console.error(
              "[hearth] parking the queue across a stop failed",
              error instanceof Error ? error.message : error
            );
          });
          if (!settled.done) console.log(`[hearth] abort for conversation ${conversationId} is still winding down`);
          const parked = settled.done ? settled.parked : first;
          return json({
            ok: true,
            ...(note.length > 0 ? { cleared: note } : {}),
            // Tell the client what the stop kept, so it can say so rather than implying the queue
            // was empty. Absent when nothing was queued, which keeps the old response shape.
            ...(parked.length > 0
              ? { parked: parked.length, parkedText: parked.map((item) => contentPreviewOf(item.content)) }
              : {}),
          });
        }

        if (action === "compact" && request.method === "POST") {
          const body = await readBody(request);
          const instructions = string(body.instructions, 2_000);
          const taskId = await conversation.compact(instructions, context);
          return json({ taskId }, 202);
        }

        // Reorder the queued follow-ups. The inbox is placed in ID order (pi-durable sorts by
        // submission id), so a real reorder means withdrawing each queued input and putting them
        // back in the requested order in one commit — the new submissions get fresh ids in that
        // order, so the client reconciles from the returned queue rather than its old rows.
        //
        // It must *not* re-submit them: `conversation.submit()` on an idle conversation (the state
        // a Stop leaves parked items in) places the message and starts a run, so a reorder would
        // make "stop, then reorder" send the work. `parkInputs` writes them back as queued
        // submissions — inert until the next boundary — and when a run *is* active, pi-durable
        // drains `pi.inbox` at the next boundary in exactly this order.
        if (action === "queue/order" && request.method === "PUT") {
          const body = await readBody(request);
          const ids = Array.isArray(body.itemIds) ? body.itemIds.map((value) => String(value)) : null;
          if (!ids || ids.length === 0) return badRequest("itemIds is required");
          const inbox = await harness.snapshot(InboxDoc, conversationId, context);
          const queued = (inbox?.items ?? []).filter(
            (item): item is Extract<InboxItem, { mode: "steer" | "followUp" }> =>
              item.mode === "steer" || item.mode === "followUp"
          );
          const byId = new Map(queued.map((item) => [String(item.id), item]));
          if (ids.length !== queued.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
            return badRequest("itemIds must list every queued message, once");
          }
          // Withdraw first: `abortSubmission` settles each queued submission and takes it out of the
          // inbox, so the commit below writes the whole new order rather than appending to the old.
          for (const item of queued) await harness.abortSubmission(item.id, context, conversationId);
          // One token for the whole reorder: a rerun of the same request re-adds the same
          // submissions instead of a second copy of every message.
          const token = `order:${Date.now()}:${randomUUID().slice(0, 8)}`;
          await parkInputs(
            (change) => conversation.commit(change, context),
            conversationId,
            ids.map((id, index) => {
              const item = byId.get(id)!;
              return { mode: item.mode, content: item.content, id: String(item.id), token: `${token}:${index}` } as const;
            })
          );
          return json({ revision: Date.now(), session: await queueSessionOf(conversationId) });
        }

        if (action === "fork" && request.method === "POST") {
          const body = await readBody(request);
          const rawAt = body.at === undefined ? undefined : String(body.at);
          const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
          const boundary = (rawAt !== undefined ? idOf<EntryId>(rawAt) : undefined) ?? newest?.id;
          if (rawAt !== undefined && boundary === undefined) {
            throw new HttpFailure(400, `at must be a whole entry id; "${brief(rawAt)}" is not`);
          }
          if (boundary === undefined) return badRequest("nothing to fork");
          // Entry ids are global, so an id from another conversation parses fine and then throws
          // `Entry N is not visible from conversation M` out of the fork — a 500 for a bad id. Ask
          // the conversation first: a fork point has to be one of *its* entries.
          if (rawAt !== undefined) {
            const at = (await conversation.entries({ minEntryId: boundary, maxEntryId: boundary }, 1, undefined, context))
              .items[0];
            if (!at) {
              return badRequest(
                `entry ${boundary} is not part of conversation ${conversationId}; fork at one of its own entries, or omit at for the newest`
              );
            }
          }
          const fork = await conversation.fork(boundary, { ownership: { kind: "ownerless" } }, context);
          return json(await summaryOf(harness, { id: fork.id }), 201);
        }

        // Side question ("btw …"): fork the conversation (or start an empty child when the leader
        // has no entries yet) as a `kind: "worker"` tied to this leader, register it in the leader's
        // crew doc, and submit the side question so its answer arrives as a side-question report.
        if (action === "btw" && request.method === "POST") {
          const body = await readBody(request);
          const question = string(body.question, 10_000)?.trim();
          if (!question) return badRequest("question is required");
          const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
          const autoAccept = await harness.snapshot(AutoAcceptDoc, conversationId, context);
          const leaderAgent = await harness.snapshot(AgentDoc, conversationId, context);
          const now = Date.now();
          const role = "Aside";
          const spawned = await harness.commit(async (tx) => {
            const crew = await tx.doc(SessionsDoc, conversationId);
            const roleIndex = nextRoleIndex(crew.items, role);
            const title = workerTitle(role, roleIndex);
            const key = `btw-${roleIndex}-${now}`;
            const briefRequestId = `hearth.crew.brief:${conversationId}:${key}:${now}`;
            const generation = crew.woke ? crew.generation + 1 : Math.max(crew.generation, 1);
            const child = newest
              ? await tx.forkConversation(conversationId, newest.id, { ownership: { kind: "ownerless" } })
              : await tx.createConversation({
                  ownership: { kind: "ownerless" },
                  ...(leaderAgent
                    ? {
                        agent: {
                          ...(leaderAgent.cwd ? { cwd: leaderAgent.cwd } : {}),
                          ...(leaderAgent.model ? { model: leaderAgent.model } : {}),
                          ...(leaderAgent.thinkingLevel ? { thinkingLevel: leaderAgent.thinkingLevel } : {}),
                          instructions: WORKER_INSTRUCTIONS,
                        },
                      }
                    : { agent: { instructions: WORKER_INSTRUCTIONS } }),
                });
            const meta = await tx.doc(MetaDoc, child.id);
            meta.title = title;
            meta.kind = "worker";
            meta.lead = { conversationId: conversationId as number, host: "local" };
            meta.delegates = false;
            (await tx.doc(AutoAcceptDoc, child.id)).enabled = autoAccept?.enabled ?? false;
            crew.generation = generation;
            crew.woke = false;
            delete crew.wokeAt;
            crew.deadlineAt = now + CREW_DEADLINE_MS;
            crew.spawnedAt = [...pruneSpawns(crew.spawnedAt, now), now];
            crew.items[key] = {
              kind: "worker",
              conversationId: child.id,
              title,
              role,
              roleIndex,
              spawnedAt: now,
              taskAt: now,
              ...(newest ? { answerFrom: newest.id as number } : {}),
              state: "starting",
              generation,
              briefRequestId,
              sideQuestion: question.slice(0, 300),
            };
            return { id: child.id, briefRequestId };
          }, context);
          const childHandle = await harness.conversation(spawned.id, context);
          if (childHandle) {
            const prompt =
              `[Side question from the user — answer concisely using the conversation context above. ` +
              `Your final message will be reported back to the main session.]\n\n${question}`;
            await childHandle.submit(
              { type: "input", content: prompt, requestId: spawned.briefRequestId },
              context
            );
          }
          return json(await summaryOf(harness, { id: spawned.id }), 201);
        }

        // Human promotion: a worker becomes a named peer by forking it ownerless. Ownership is
        // immutable identity, so promotion never mutates the worker itself beyond `promotedTo`;
        // the fork carries `kind: "peer"`, keeps the lead as history, and gets the name.
        if (action === "promote" && request.method === "POST") {
          const body = await readBody(request);
          const meta = await harness.snapshot(MetaDoc, conversationId, context);
          if (meta?.kind !== "worker") {
            return badRequest("only a worker can be promoted; this conversation is not a worker");
          }
          if ((await harness.snapshot(LiveDoc, conversationId, context))?.run) {
            return json({ error: "conversation is busy; wait or stop it first" }, 409);
          }
          const name = string(body.name, 200)?.trim();
          if (!name) return badRequest("name is required");
          const description = string(body.description, 2_000)?.trim();
          const pinned = body.pinned === false ? false : true;
          // Reject a duplicate before forking; `registerAgent` re-checks inside the commit so a
          // race cannot produce two names for one local registry.
          if (Object.hasOwn((await harness.snapshot(AgentsDoc, context))?.entries ?? {}, name)) {
            return badRequest(`agent name already registered: ${name}`);
          }
          const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
          if (!newest) return badRequest("nothing to fork");
          let forkId: ConversationId;
          try {
            forkId = await harness.commit(async (tx) => {
              const worker = await tx.doc(MetaDoc, conversationId);
              const fork = await tx.forkConversation(conversationId, newest.id, {
                ownership: { kind: "ownerless" },
              });
              const forkMeta = await tx.doc(MetaDoc, fork.id);
              forkMeta.kind = "peer";
              if (worker.lead) forkMeta.lead = worker.lead;
              forkMeta.delegates = true;
              forkMeta.title = name;
              const now = Date.now();
              await registerAgent(tx, name, {
                conversationId: fork.id as number,
                host: "local",
                ...(description ? { description } : {}),
                pinned,
                createdAt: now,
                updatedAt: now,
              });
              // Never unarchive or erase the worker: it stays hidden history. The leader's crew
              // entry links to the fork so Ember can show a peer rather than a worker row.
              worker.promotedTo = fork.id as number;
              if (worker.lead?.host === "local") {
                const crew = await tx.doc(SessionsDoc, worker.lead.conversationId as ConversationId);
                for (const entry of Object.values(crew.items)) {
                  if (entry.kind === "worker" && entry.conversationId === conversationId) {
                    entry.promotedTo = fork.id as number;
                  }
                }
              }
              return fork.id;
            }, context);
          } catch (error) {
            if (error instanceof DuplicateAgentError) return badRequest(error.message);
            throw error;
          }
          writeAgentsMirror(config.home, await harness.snapshot(AgentsDoc, context));
          return json(await summaryOf(harness, { id: forkId }), 201);
        }

        if (action === "reset" && request.method === "POST") {
          const body = await readBody(request);
          await conversation.reset(string(body.handoff, 20_000), context);
          return json({ ok: true });
        }

        if (action === "configure" && request.method === "POST") {
          const body = await readBody(request);
          const change = parseAgentChange(body);
          if (!change) return badRequest("invalid agent change");
          await conversation.configure(change, context);
          return json({ ok: true });
        }

        const submissionMatch = /^submissions\/([^/]+)\/abort$/.exec(action);
        if (submissionMatch && request.method === "POST") {
          const submissionId = idOf<SubmissionId>(decodeSegment(submissionMatch[1]));
          if (!submissionId) return badRequest("invalid submission id");
          // Scoped to the conversation in the path. Submission ids are global, so the unscoped
          // lookup let a stale or crossed id withdraw *another* conversation's queued message —
          // silently, because the answer was `{ok:true}` either way. `abortSubmission` checks the
          // owner and reports what actually happened, so "too late" is not dressed up as a success.
          const result = await harness.abortSubmission(submissionId, context, conversationId);
          if (result === "not_found") {
            return notFound(`conversation ${conversationId} has no submission ${submissionId} to withdraw`);
          }
          return json({ ok: result === "aborted", result });
        }

        if (action === "auto-accept" && (request.method === "PUT" || request.method === "POST")) {
          const body = await readBody(request);
          if (typeof body.enabled !== "boolean") return badRequest("enabled must be boolean");
          await setAutoAccept(harness, conversationId, body.enabled, context);
          return json({ ok: true });
        }

        return noConversationAction(conversationId, request.method, action);
      }

      // ---- approvals + questions ----------------------------------------------------------
      if (path === "/approvals" && request.method === "GET") {
        const ids = (await allConversations(storage)).map((record) => record.id);
        return json({ approvals: await pendingApprovals(harness, ids, context) });
      }
      const approvalReply = /^\/approvals\/([^/]+)\/([^/]+)\/reply$/.exec(path);
      if (approvalReply && request.method === "POST") {
        const body = await readBody(request);
        const decision = body.decision;
        if (decision !== "once" && decision !== "always" && decision !== "reject") {
          return badRequest("decision must be once, always or reject");
        }
        const conversationId = idOf<ConversationId>(decodeSegment(approvalReply[1]));
        if (!conversationId) return badRequest("invalid conversation id");
        const key = decodeSegment(approvalReply[2]);
        const found = await replyApproval(harness, conversationId, key, decision as ApprovalDecision, context);
        return found
          ? json({ ok: true })
          : notFound(`conversation ${conversationId} has no approval \"${brief(key, 100)}\" waiting`);
      }

      if (path === "/questions" && request.method === "GET") {
        const ids = (await allConversations(storage)).map((record) => record.id);
        return json({ questions: await pendingQuestions(harness, ids, context) });
      }
      const questionReply = /^\/questions\/([^/]+)\/([^/]+)\/reply$/.exec(path);
      if (questionReply && request.method === "POST") {
        const body = await readBody(request);
        const answer = body.answer;
        if (answer !== null && typeof answer !== "string") return badRequest("answer must be a string or null");
        const conversationId = idOf<ConversationId>(decodeSegment(questionReply[1]));
        if (!conversationId) return badRequest("invalid conversation id");
        const key = decodeSegment(questionReply[2]);
        const found = await replyQuestion(harness, conversationId, key, answer, context);
        return found
          ? json({ ok: true })
          : notFound(`conversation ${conversationId} has no question \"${brief(key, 100)}\" waiting`);
      }

      return noRoute(request.method, path, routeMethods(path));
    },
  });

  return {
    port: server.port ?? config.port,
    url: `http://127.0.0.1:${server.port ?? config.port}`,
    close: async () => {
      server.stop(true);
    },
  };
};
