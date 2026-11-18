import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineDoc,
  InboxDoc,
  LiveDoc,
  type AgentChange,
  type AgentState,
  type ConversationId,
  type Harness,
  type InboxItem,
  type SubmissionId,
  type Tx,
} from "@earendil-works/pi-durable";

/**
 * Per-submission agent overrides (`model` and `thinkingLevel`) isolated from `AgentDoc` while an
 * input waits in `InboxDoc` behind an active run.
 *
 * `undefined` (key omitted) keeps the conversation's stored setting; `null` clears it back to the
 * host default; a value replaces it when that submission is placed at a turn or steer boundary.
 */
export type QueueSendConfig = {
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: NonNullable<AgentChange["thinkingLevel"]> | null;
};

export type QueueConfigState = {
  items: Record<string, QueueSendConfig>;
};

export const QueueConfigDoc = defineDoc<QueueConfigState>({
  kind: "hearth.queue-config",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (value) => Object.keys(value.items).length === 0,
});

const nonEmptyString = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;

/**
 * Parse optional per-submission `model` and `thinkingLevel` from a `POST /submit` body, matching
 * `parseAgentChange` on `POST /configure`.
 */
export const parseSubmissionSendConfig = (
  body: Record<string, unknown>
): { sendConfig?: QueueSendConfig } | { error: string } => {
  const change: QueueSendConfig = {};
  if (body.model !== undefined) {
    if (body.model === null) {
      change.model = null;
    } else if (
      body.model &&
      typeof body.model === "object" &&
      !Array.isArray(body.model) &&
      nonEmptyString((body.model as Record<string, unknown>).provider, 200) &&
      nonEmptyString((body.model as Record<string, unknown>).modelId, 200)
    ) {
      const raw = body.model as { provider: string; modelId: string };
      change.model = { provider: raw.provider, modelId: raw.modelId };
    } else {
      return { error: "invalid model" };
    }
  }
  if (body.thinkingLevel !== undefined) {
    if (body.thinkingLevel !== null && !nonEmptyString(body.thinkingLevel, 80)) {
      return { error: "invalid thinkingLevel" };
    }
    change.thinkingLevel = body.thinkingLevel as QueueSendConfig["thinkingLevel"];
  }
  return Object.keys(change).length > 0 ? { sendConfig: change } : {};
};

/**
 * Effective `{ provider, modelId }` that will answer a new input submission once earlier queued
 * items and its own `sendConfig` have applied, used to validate image capability up front.
 */
export const effectiveSubmissionModel = (
  sendConfig: QueueSendConfig | undefined,
  agent: Readonly<AgentState> | undefined,
  inbox: Readonly<{ items: readonly InboxItem[] }> | undefined,
  queueConfig: Readonly<QueueConfigState> | undefined,
  fallback: { provider: string; modelId: string }
): { provider: string; modelId: string } => {
  if (sendConfig && Object.hasOwn(sendConfig, "model")) {
    return sendConfig.model
      ? { provider: sendConfig.model.provider, modelId: sendConfig.model.modelId }
      : fallback;
  }
  let current = agent?.model
    ? { provider: agent.model.provider, modelId: agent.model.modelId }
    : undefined;
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    const queued = queueConfig?.items[String(item.id)];
    if (queued && Object.hasOwn(queued, "model")) {
      current = queued.model
        ? { provider: queued.model.provider, modelId: queued.model.modelId }
        : undefined;
    }
  }
  return current ?? fallback;
};

/**
 * Effective `{ model, thinkingLevel }` for a single inbox item in `GET /queue`, reading its own
 * `QueueConfigDoc` entry first and falling back to `AgentDoc`.
 */
export const resolveQueueItemConfig = (
  itemConfig: QueueSendConfig | undefined,
  agent: Readonly<AgentState> | undefined
): {
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
} => {
  const hasModel = itemConfig !== undefined && Object.hasOwn(itemConfig, "model");
  const hasThinking = itemConfig !== undefined && Object.hasOwn(itemConfig, "thinkingLevel");
  const model = hasModel
    ? itemConfig.model
      ? { provider: itemConfig.model.provider, modelId: itemConfig.model.modelId }
      : null
    : agent?.model
      ? { provider: agent.model.provider, modelId: agent.model.modelId }
      : undefined;
  const thinkingLevel = hasThinking ? (itemConfig.thinkingLevel ?? null) : agent?.thinkingLevel;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
};

/**
 * Apply stored send configs for any submission now placed in `LiveDoc.run.inputs` onto `AgentDoc`,
 * and prune consumed or superseded entries from `QueueConfigDoc`.
 */
export const applyRunQueueConfigsInTx = async (
  tx: Tx,
  conversationId: ConversationId
): Promise<boolean> => {
  const queueConfig = await tx.doc(QueueConfigDoc, conversationId);
  const existingKeys = Object.keys(queueConfig.items);
  if (existingKeys.length === 0) return false;
  const live = await tx.doc(LiveDoc, conversationId);
  const runInputs = live.run?.inputs ?? [];
  if (runInputs.length === 0) return false;

  let applied = false;
  for (const subId of runInputs) {
    const key = String(subId);
    if (!Object.hasOwn(queueConfig.items, key)) continue;
    const change = queueConfig.items[key];
    if (change) {
      await configure(tx, conversationId, change);
      applied = true;
    }
    delete queueConfig.items[key];
  }

  const inbox = await tx.doc(InboxDoc, conversationId);
  const inboxIds = new Set(inbox.items.map((item) => String(item.id)));
  const runIds = new Set(runInputs.map((subId) => String(subId)));
  const maxPlaced = Math.max(
    0,
    ...runInputs.map((subId) => Number(subId)).filter((value) => Number.isFinite(value))
  );
  for (const key of Object.keys(queueConfig.items)) {
    const numeric = Number(key);
    if (!inboxIds.has(key) && !runIds.has(key) && Number.isFinite(numeric) && numeric > 0 && numeric < maxPlaced) {
      delete queueConfig.items[key];
    }
  }
  return applied;
};

/** Remove a withdrawn submission's send config from `QueueConfigDoc`. */
export const removeQueueConfigInTx = async (
  tx: Tx,
  conversationId: ConversationId,
  submissionId: SubmissionId | string
): Promise<void> => {
  const queueConfig = await tx.doc(QueueConfigDoc, conversationId);
  delete queueConfig.items[String(submissionId)];
};

type TrackerHandle = {
  refs: number;
  detach: () => Promise<void>;
};

const attachedTrackers = new WeakMap<Harness, TrackerHandle>();

/**
 * Ensure queued per-submission `{ model, thinkingLevel }` configs apply to `AgentDoc` at the exact
 * turn/steer boundary when `pi-durable` places a parked item into `LiveDoc.run.inputs` — strictly
 * before `GenerationTask.phases.prepare` resolves `AgentDoc`, and without touching `AgentDoc` while
 * an earlier turn is still running.
 */
export const attachQueueConfigTracking = (harness: Harness, context: Context) => {
  const existing = attachedTrackers.get(harness);
  if (existing) {
    existing.refs += 1;
    let released = false;
    return {
      async close() {
        if (released) return;
        released = true;
        existing.refs -= 1;
        if (existing.refs <= 0) {
          attachedTrackers.delete(harness);
          await existing.detach();
        }
      },
    };
  }

  let closed = false;
  const inFlight = new Map<ConversationId, Promise<void>>();

  const applyPendingForConversation = (id: ConversationId, callContext: Context): Promise<void> => {
    if (closed) return Promise.resolve();
    const running = inFlight.get(id);
    if (running) return running;
    const job = (async () => {
      try {
        if (closed) return;
        const safeCtx = withoutAbortSignal(callContext);
        const queueConfig = await harness.snapshot(QueueConfigDoc, id, safeCtx);
        if (!queueConfig || Object.keys(queueConfig.items).length === 0) return;
        const live = await harness.snapshot(LiveDoc, id, safeCtx);
        const runInputs = live?.run?.inputs ?? [];
        if (!runInputs.some((subId) => Object.hasOwn(queueConfig.items, String(subId)))) return;
        if (closed) return;
        await harness.commit((tx) => applyRunQueueConfigsInTx(tx, id), safeCtx);
      } catch {
        // Ignore reads/commits rejected because the harness is closing during shutdown.
      }
    })().finally(() => {
      if (inFlight.get(id) === job) inFlight.delete(id);
    });
    inFlight.set(id, job);
    return job;
  };

  // Synchronous barrier before `GenerationTask.phases.prepare` (or any caller) resolves `AgentDoc`.
  const internalHarness = harness as unknown as {
    resolveAgent?: (id: ConversationId, snapshot: unknown, callContext: Context) => Promise<unknown>;
  };
  const originalResolveAgent = internalHarness.resolveAgent;
  const boundResolveAgent = originalResolveAgent?.bind(harness);
  if (boundResolveAgent) {
    internalHarness.resolveAgent = async (id: ConversationId, snapshot: unknown, callContext: Context) => {
      if (!closed) {
        await applyPendingForConversation(id, callContext);
      }
      return boundResolveAgent(id, snapshot, callContext);
    };
  }

  // Also advance `AgentDoc` as soon as a boundary commit updates `LiveDoc.run`, so summaries
  // (`GET /conversations`) immediately reflect the new turn's model even before `prepare` runs.
  const observation = harness.observeCommits({
    advance(publication) {
      if (closed) return;
      for (const change of publication.changes) {
        if (
          change.type === "document" &&
          change.kind === "change" &&
          change.record.kind === LiveDoc.definition.kind &&
          change.conversationId !== undefined
        ) {
          const run = (change.value as { run?: { inputs?: unknown[] } } | undefined)?.run;
          if (Array.isArray(run?.inputs) && run.inputs.length > 0) {
            void applyPendingForConversation(change.conversationId, context);
          }
        }
      }
    },
    end() {
      closed = true;
    },
  });

  const handle: TrackerHandle = {
    refs: 1,
    async detach() {
      closed = true;
      observation.detach();
      if (originalResolveAgent) {
        internalHarness.resolveAgent = originalResolveAgent;
      }
      await Promise.allSettled([...inFlight.values()]);
    },
  };
  attachedTrackers.set(harness, handle);

  let released = false;
  return {
    async close() {
      if (released) return;
      released = true;
      handle.refs -= 1;
      if (handle.refs <= 0) {
        attachedTrackers.delete(harness);
        await handle.detach();
      }
    },
  };
};
