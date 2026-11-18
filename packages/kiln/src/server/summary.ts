import type { Message } from "@earendil-works/pi-ai";
import {
  AgentDoc,
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
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
  type UsageState,
} from "@earendil-works/pi-durable";
import { AutoAcceptDoc, clearPendingApprovals, pendingApprovals } from "../approvals";
import { clearPendingQuestions, pendingQuestions } from "../ask";
import { CurrentContextDoc } from "../currentContext";
import { contentPreviewOf, parseUserInputContent } from "../images";
import { MetaDoc } from "../meta";
import type { LeftProcess } from "../processes";
import {
  QueueConfigDoc,
  parseSubmissionSendConfig,
  resolveQueueItemConfig,
  type QueueSendConfig,
} from "../queueConfig";
import { explicitSettled, SessionsDoc, workerAssignment, type TaskCompletion } from "../sessions";
import { brief, json, serverContext, string } from "./http";

const context = serverContext;

export type ConversationSummary = {
  id: ConversationId;
  parent?: ConversationRecord["parent"];
  owner?: ConversationRecord["owner"];
  cwd?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  title?: string;
  archived?: number;
  kind?: "worker" | "peer";
  lead?: { conversationId: number; host: string };
  creatorId?: number;
  task?: {
    id: string;
    title: string;
    status: "working" | "waiting" | "blocked" | "incomplete" | "handoff-needed" | "done" | "stopped" | "failed";
    completion?: TaskCompletion;
  };
  delegates: boolean;
  promotedTo?: number;
  needsInput: boolean;
  lastEntryId?: EntryId;
  updatedAt?: number;
  createdAt?: number;
  busy?: boolean;
  cost: number;
  currentContextTokens?: number;
  currentContextHistoryTokens?: number;
  currentContextEpoch?: string;
  contextCompaction?: { entryId: number; reason: string } | null;
  autoAccept?: boolean;
  compacting?: boolean;
  compactionFailure?: {
    taskId: number;
    trigger: string;
    error: string;
  };
  processes?: {
    count: number;
    rssBytes: number;
    items: LeftProcess[];
  };
};

const SUMMARY_PROCESS_ITEMS = 5;

const processesField = (leftovers: readonly LeftProcess[] | undefined): ConversationSummary["processes"] => {
  if (leftovers === undefined || leftovers.length === 0) return undefined;
  return {
    count: leftovers.length,
    rssBytes: leftovers.reduce((sum, entry) => sum + entry.rssBytes, 0),
    items: leftovers.slice(0, SUMMARY_PROCESS_ITEMS),
  };
};

export const inboxTextOf = (item: {
  mode: "steer" | "followUp" | "write";
  content?: unknown;
  entry?: unknown;
}): string => {
  if (item.content !== undefined) return contentPreviewOf(item.content);
  const data = item.entry && typeof item.entry === "object" ? (item.entry as { data?: unknown }).data : undefined;
  if (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string") {
    return (data as { text: string }).text.slice(0, 500);
  }
  return "";
};

const entryTimestamp = (entry: {
  readonly model?: readonly { readonly timestamp?: number }[];
  readonly data?: unknown;
}): number | undefined => {
  const stamps = (entry.model ?? [])
    .map((message) => message.timestamp)
    .filter((stamp): stamp is number => typeof stamp === "number" && Number.isFinite(stamp));
  if (stamps.length > 0) return Math.max(...stamps);
  const at = entry.data && typeof entry.data === "object" ? (entry.data as { at?: unknown }).at : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
};

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

export const summaryOf = async (
  harness: Harness,
  record: ConversationRecord,
  storage: Storage,
  leftovers?: readonly LeftProcess[]
): Promise<ConversationSummary> => {
  const [meta, agent, newest, live, auto, approvals, questions, usage, currentContext, inbox, oldest] =
    await Promise.all([
      harness.snapshot(MetaDoc, record.id, context),
      harness.snapshot(AgentDoc, record.id, context),
      harness
        .conversation(record.id, context)
        .then((conversation) => (conversation ? conversation.entries({}, 1, undefined, context) : undefined)),
      harness.snapshot(LiveDoc, record.id, context),
      harness.snapshot(AutoAcceptDoc, record.id, context),
      pendingApprovals(harness, [record.id], context),
      pendingQuestions(harness, [record.id], context),
      harness.snapshot(UsageDoc, record.id, context),
      harness.snapshot(CurrentContextDoc, record.id, context),
      harness.snapshot(InboxDoc, record.id, context),
      storage.conversation(record.id, context).then((own) =>
        storage.scanEntries(
          {
            conversationId: record.id,
            order: "ascending",
            ...(own?.parent ? { minEntryId: (Number(own.parent.at) + 1) as EntryId } : {}),
          },
          1,
          undefined,
          context
        )
      ),
    ]);
  const assignment = await workerAssignment((id) => harness.snapshot(SessionsDoc, id, context), record.id, meta);
  const task =
    assignment?.entry.taskLifecycle === "explicit"
      ? {
          id: String(assignment.entry.conversationId) + ":" + (assignment.entry.taskAt ?? assignment.entry.spawnedAt),
          title: assignment.entry.title,
          status: (explicitSettled(assignment.entry)
            ? assignment.entry.completion?.outcome ?? "done"
            : assignment.entry.state === "failed"
              ? "failed"
              : assignment.entry.state === "stopped"
                ? "stopped"
                : approvals.length || questions.length
                  ? "blocked"
                  : live?.run
                    ? "working"
                    : "waiting") as
            | "working"
            | "waiting"
            | "blocked"
            | "incomplete"
            | "handoff-needed"
            | "done"
            | "stopped"
            | "failed",
          ...(explicitSettled(assignment.entry) ? { completion: assignment.entry.completion } : {}),
        }
      : undefined;
  const processes = processesField(leftovers);
  return {
    id: record.id,
    ...(task ? { task } : {}),
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
    ...(meta?.creatorId !== undefined ? { creatorId: meta.creatorId } : {}),
    delegates: meta?.delegates ?? true,
    needsInput: approvals.length > 0 || questions.length > 0,
    lastEntryId: newest?.items[0]?.id,
    updatedAt: newest?.items[0] ? entryTimestamp(newest.items[0]) : undefined,
    ...(oldest.items[0]?.kind === "pi.user" ? { createdAt: entryTimestamp(oldest.items[0]) } : {}),
    busy: Boolean(live?.run),
    cost: costOfUsage(usage),
    ...(currentContext?.sourceEntryId === (newest?.items[0]?.id ?? 0)
      ? {
          currentContextTokens: currentContext.currentContextTokens,
          currentContextHistoryTokens: currentContext.currentContextHistoryTokens,
          currentContextEpoch: currentContext.currentContextEpoch,
          contextCompaction: currentContext.contextCompaction,
        }
      : {}),
    autoAccept: Boolean(auto?.enabled),
    compacting:
      Boolean(live?.compactions?.length) ||
      Boolean(inbox?.items.some((item) => item.mode === "write" && item.entry.kind === "pi.compaction")),
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

export const byLastEntry = (a: ConversationSummary, b: ConversationSummary): number => {
  const left = typeof a.lastEntryId === "number" ? a.lastEntryId : Number(a.lastEntryId);
  const right = typeof b.lastEntryId === "number" ? b.lastEntryId : Number(b.lastEntryId);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
  return String(b.lastEntryId ?? "").localeCompare(String(a.lastEntryId ?? ""));
};

export const parseAgentChange = (body: Record<string, unknown>): AgentChange | null => {
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

export type SubmissionParse =
  | {
      draft: InputSubmissionDraft | { type: "write"; entry: EntryDraft; requestId?: string };
      sendConfig?: QueueSendConfig;
    }
  | { error: string };

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
      const text =
        (part as { type?: unknown; text?: unknown }).type === "text"
          ? (part as { text?: unknown }).text
          : undefined;
      if (typeof text !== "string" || text.length === 0 || text.length > 40_000) return "invalid";
      content.push({ type: "text", text });
    }
    if (content.length === 0) return "invalid";
    const timestamp =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    messages.push({ role: "user", content, timestamp });
  }
  return messages;
};

export const SUBMIT_ATTEMPT_LIMIT = 20;

export const neverPlaced = (record: {
  readonly type?: string;
  readonly status?: string;
  readonly entry?: unknown;
}): boolean => record.type === "input" && record.status === "unanswered" && record.entry === undefined;

export const busyRefusal = (conversationId: ConversationId): Response =>
  json(
    {
      error: `conversation ${conversationId} is busy, and this message asked to be refused rather than queued. Send it again with whenBusy "steer" (join the running turn) or "followUp" (wait for it).`,
    },
    409
  );

export const attemptOf = async (
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

export const answerOf = (
  record: { readonly id: SubmissionId; readonly status: string; readonly entry?: EntryId; readonly reason?: string },
  mode: string,
  configured = false
): {
  submissionId: SubmissionId;
  status: string;
  mode: string;
  entry?: EntryId;
  reason?: string;
  configured?: boolean;
} => ({
  submissionId: record.id,
  status: record.status,
  mode,
  ...(record.entry !== undefined ? { entry: record.entry } : {}),
  ...(record.reason !== undefined ? { reason: record.reason } : {}),
  ...(configured ? { configured: true } : {}),
});

export const parseSubmission = (body: Record<string, unknown>): SubmissionParse => {
  const requestId = string(body.requestId, 200);
  let whenBusy: "steer" | "followUp" | "reject" | undefined;
  if (body.whenBusy !== undefined) {
    if (body.whenBusy !== "steer" && body.whenBusy !== "followUp" && body.whenBusy !== "reject") {
      return { error: 'whenBusy must be "steer", "followUp" or "reject"' };
    }
    whenBusy = body.whenBusy;
  }
  if (body.type === "input") {
    const configParsed = parseSubmissionSendConfig(body);
    if ("error" in configParsed) return configParsed;
    const parsed = parseUserInputContent(body.content);
    if (!parsed.ok) return { error: parsed.reason };
    return {
      draft: {
        type: "input",
        content: parsed.content,
        ...(whenBusy ? { whenBusy } : {}),
        ...(requestId ? { requestId } : {}),
      },
      ...(configParsed.sendConfig !== undefined ? { sendConfig: configParsed.sendConfig } : {}),
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
      return {
        error: 'invalid entry.model: expected [{ "role": "user", "content": [{ "type": "text", "text": "…" }] }]',
      };
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

export const scheduledTaskRefusal = (body: Record<string, unknown>): string => {
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

export const clearPendingPrompts = async (
  harness: Harness,
  conversationId: ConversationId
): Promise<Array<"approvals" | "questions">> => {
  const cleared: Array<"approvals" | "questions"> = [];
  try {
    if ((await pendingApprovals(harness, [conversationId], context)).length > 0) {
      await clearPendingApprovals(harness, conversationId, context);
      cleared.push("approvals");
    }
    if ((await pendingQuestions(harness, [conversationId], context)).length > 0) cleared.push("questions");
    await clearPendingQuestions(harness, conversationId, context);
  } catch (error) {
    console.error("[hearth] clearing parked prompts failed", error instanceof Error ? error.message : error);
  }
  return cleared;
};

export const queueSessionOf = async (harness: Harness, id: ConversationId) => {
  const [inbox, agent, queueConfig] = await Promise.all([
    harness.snapshot(InboxDoc, id, context),
    harness.snapshot(AgentDoc, id, context),
    harness.snapshot(QueueConfigDoc, id, context),
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
      ...(item.mode === "write"
        ? {}
        : {
            content: item.content,
            ...resolveQueueItemConfig(queueConfig?.items[String(item.id)], agent),
          }),
    })),
  };
};

const IMAGE_REF = "image-ref";

const entryBytes = (entry: unknown): number => {
  try {
    return JSON.stringify(entry)?.length ?? 0;
  } catch {
    return 0;
  }
};

export const fitToBudget = <T extends { id: unknown }>(
  items: readonly T[],
  budget: number
): { items: T[]; next: Cursor | undefined } => {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = entryBytes(item);
    if (kept.length > 0 && used + size > budget) {
      const after = kept[kept.length - 1].id;
      return { items: kept, next: { after: after as number } };
    }
    kept.push(item);
    used += size;
  }
  return { items: kept, next: undefined };
};

export const documentsOf = async (harness: Harness, id: ConversationId): Promise<Record<string, unknown>> => {
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

export type EntryShape = { id: unknown; model?: readonly { content?: readonly unknown[] }[] };

export const imageRefsOf = <T extends EntryShape>(entry: T): T => {
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

export const imageOfEntry = (
  entry: EntryShape,
  wanted: number
): { bytes: Uint8Array; mimeType: string } | undefined => {
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

export const imagesInEntry = (entry: EntryShape): string => {
  let count = 0;
  for (const message of entry.model ?? []) {
    for (const block of message.content ?? []) {
      const value = block as { type?: unknown; data?: unknown };
      if (value?.type === "image" && typeof value.data === "string") count += 1;
    }
  }
  return count === 1
    ? "one image (index 0)"
    : count === 0
      ? "no images at all"
      : `${count} images (indexes 0 to ${count - 1})`;
};
