import * as React from 'react';
import {
  enqueueMessage,
  errorMessageOf,
  removeQueuedMessage,
  reorderQueuedMessages,
  takeQueuedMessage,
  type ModelList,
  type PromptInput,
  type QueueMessageInput,
} from '../api';
import { isPiInstance } from '../piApi';
import { modelRefKey } from '../types';
import { randomId } from '../lib/randomId';
import { isRemoteBrowser, isRemoteExpired, recordRemoteRefusedSend } from '../lib/remoteLifecycle';
import { shareValue } from '../lib/structuralSharing';
import { selectedModelError } from '../lib/modelSelection';
import {
  planQueueMerge,
  queueReplacementConfig,
  queueOrderAfterMerge,
  sameQueuedMessage,
  type QueueReplaceRequest,
} from '../lib/queueMerge';
import type {
  FileAttachment,
  MessageQueueMutation,
  MessageQueueSession,
  ModelOption,
  QueuedMessage,
  QueuedMessageAttachment,
  Session,
  SessionRef,
} from '../types';

/**
 * Keep local-only rows (still enqueuing, or failed) when a poll replaces the server queue snapshot
 * with fresh data, so an in-flight message doesn't vanish before its request settles.
 */
export const mergePolledQueues = (
  prev: Record<string, MessageQueueSession[]>,
  next: Record<string, MessageQueueSession[]>
): Record<string, MessageQueueSession[]> => {
  const merged: Record<string, MessageQueueSession[]> = {};
  const instanceIds = new Set([...Object.keys(prev), ...Object.keys(next)]);
  instanceIds.forEach((instanceId) => {
    const local = prev[instanceId] ?? [];
    const server = next[instanceId];
    if (!server) {
      merged[instanceId] = local;
      return;
    }
    const serverSessionIds = new Set(server.map((queue) => queue.sessionId));
    const result = server.map((queue) => {
      const locals = (local.find((entry) => entry.sessionId === queue.sessionId)?.items ?? []).filter(
        (item) => item.pending || item.error
      );
      if (locals.length === 0) return queue;
      const serverIds = new Set(queue.items.map((item) => item.id));
      const optimistic = locals.filter((item) => !serverIds.has(item.id));

      // A row the host already lists is not a second row: drop the optimistic copy that matches it, or
      // the same message is drawn twice until the enqueue settles (measured: ~200ms, on every enqueue
      // and on an edit alike). One local row per served row, so two identical messages queued back to
      // back still stay two rows.
      for (const served of queue.items) {
        const match = optimistic.findIndex((item) => item.pending && !item.staged && sameQueuedMessage(item, served));
        if (match >= 0) optimistic.splice(match, 1);
      }
      return {
        ...queue,
        items: [...optimistic, ...queue.items],
      };
    });
    local.forEach((queue) => {
      if (serverSessionIds.has(queue.sessionId)) return;
      const locals = queue.items.filter((item) => item.pending || item.error);
      if (locals.length > 0) result.push({ ...queue, items: locals });
    });
    merged[instanceId] = result;
  });
  return shareValue(prev, merged);
};

/**
 * Where a replace request lands. Ids are translated first: a row edited while it was still queueing
 * keeps the local id in the open dialog, but its enqueue has since given it a server id.
 */
export type QueueReplaceTargets = {
  /** The rows to replace, with landed local ids translated to the server ids they became. */
  ids: string[];
  survivorId: string | undefined;
  /** Set when the request names one row that is still queueing: there is nothing to replace yet. */
  pendingId: string | null;
};

/**
 * Resolve a replace request against the queue as it stands. A row whose enqueue has not settled has
 * no server id, so its edit cannot be applied yet — it has to wait for that id (see `replaceQueued`).
 */
export const resolveQueueReplaceTargets = (
  items: readonly QueuedMessage[],
  request: { itemIds: readonly string[]; survivorId?: string },
  landedIds: ReadonlyMap<string, string>
): QueueReplaceTargets => {
  const translate = (id: string) => landedIds.get(id) ?? id;
  const ids = request.itemIds.map(translate);
  const survivorId = request.survivorId ? translate(request.survivorId) : undefined;
  const pendingId =
    ids.length === 1 && items.some((item) => item.id === ids[0] && item.pending) ? ids[0] : null;
  return { ids, survivorId, pendingId };
};

/**
 * Preserve any still-pending or errored local rows on a session when a server mutation settles an
 * earlier row, keeping those local rows after the server's settled items so FIFO order holds.
 */
export const mergeMutationSession = (
  previous: MessageQueueSession | undefined,
  incoming: MessageQueueSession,
  partial = false
): MessageQueueSession => {
  if (!previous) return incoming;
  const incomingIds = new Set(incoming.items.map((item) => item.id));
  if (partial) {
    // Post-accept queue refresh failed: preserve previously known settled items and pending/errored
    // local items, appending any newly accepted items that are not already present.
    const previousSettled = previous.items.filter((item) => !item.pending && !item.error);
    const previousSettledIds = new Set(previousSettled.map((item) => item.id));
    const addedSettled = incoming.items.filter((item) => !previousSettledIds.has(item.id));
    const remainingLocals = previous.items.filter(
      (item) => (item.pending || item.error) && !incomingIds.has(item.id)
    );
    return {
      ...previous,
      ...incoming,
      directory: incoming.directory || previous.directory,
      items: [...previousSettled, ...addedSettled, ...remainingLocals],
    };
  }
  const remainingLocals = previous.items.filter(
    (item) => (item.pending || item.error) && !incomingIds.has(item.id)
  );
  if (remainingLocals.length === 0) return incoming;
  return {
    ...incoming,
    items: [...incoming.items, ...remainingLocals],
  };
};

/**
 * Build a local queue item for a follow-up held during session creation, visible immediately while
 * the trigger message is still in flight.
 */
export const buildStagedQueuedMessage = (
  entry: { id: string; input: PromptInput; createdAt: number },
  model?: ModelOption
): QueuedMessage => ({
  id: entry.id.startsWith('local-') ? entry.id : `local-${entry.id}`,
  createdAt: entry.createdAt,
  text: entry.input.text,
  content: entry.input.text,
  attachments: (entry.input.attachments ?? []).map((file) => ({
    filename: file.filename,
    mimeType: file.mime,
    dataUrl: file.url,
  })),
  context: entry.input.queuedContext ?? [],
  sendConfig: {
    providerID: model?.providerID ?? '',
    modelID: model?.modelID ?? '',
    ...(entry.input.mode ? { agent: entry.input.mode } : {}),
    ...(entry.input.variant ? { variant: entry.input.variant } : {}),
  },
  ...(entry.input.agentMention ? { agentMention: entry.input.agentMention } : {}),
  pending: true,
  staged: true,
});

export type AdoptedQueuedSubmission = {
  id: string;
  text: string;
  model?: ModelOption;
  variant?: string;
  mode?: string;
  attachments?: ReadonlyArray<FileAttachment | QueuedMessageAttachment>;
};

const toQueuedMessageAttachment = (
  file: FileAttachment | QueuedMessageAttachment
): QueuedMessageAttachment =>
  'mimeType' in file
    ? file
    : {
        filename: file.filename,
        mimeType: file.mime,
        dataUrl: file.url,
      };

/**
 * Build a settled local queue row for a follow-up the host has already parked and assigned a real
 * submission id. Keeping `pending: false` avoids a stuck loader or zombie optimistic row if the
 * submission enters the transcript before the next queue refresh, while preserving attachments so
 * immediate edits or merges before that refresh do not drop attached images.
 */
export const buildAdoptedQueuedMessage = (
  submission: AdoptedQueuedSubmission,
  createdAt = Date.now()
): QueuedMessage => ({
  id: submission.id,
  createdAt,
  text: submission.text,
  content: submission.text,
  attachments: (submission.attachments ?? []).map(toQueuedMessageAttachment),
  context: [],
  sendConfig: {
    providerID: submission.model?.providerID ?? '',
    modelID: submission.model?.modelID ?? '',
    ...(submission.mode ? { agent: submission.mode } : {}),
    ...(submission.variant ? { variant: submission.variant } : {}),
  },
  pending: false,
});

export type RemovedQueueEntry = {
  item: QueuedMessage;
  index: number;
  beforeId?: string;
  afterId?: string;
  directory: string;
};

export const captureRemovedQueueEntry = (
  queue: MessageQueueSession | null | undefined,
  itemId: string
): RemovedQueueEntry | null => {
  if (!queue) return null;
  const index = queue.items.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  return {
    item: queue.items[index],
    index,
    beforeId: queue.items[index + 1]?.id,
    afterId: index > 0 ? queue.items[index - 1]?.id : undefined,
    directory: queue.directory,
  };
};

export const restoreRemovedQueuedItem = (
  current: MessageQueueSession | null,
  sessionId: string,
  removed: RemovedQueueEntry
): MessageQueueSession => {
  if (!current) {
    return {
      sessionId,
      directory: removed.directory,
      items: [removed.item],
      sendingId: null,
    };
  }
  if (current.items.some((item) => item.id === removed.item.id)) return current;
  const items = [...current.items];
  const beforeIndex = removed.beforeId
    ? items.findIndex((item) => item.id === removed.beforeId)
    : -1;
  const afterIndex =
    beforeIndex < 0 && removed.afterId
      ? items.findIndex((item) => item.id === removed.afterId)
      : -1;
  const insertAt =
    beforeIndex >= 0
      ? beforeIndex
      : afterIndex >= 0
        ? afterIndex + 1
        : Math.min(removed.index, items.length);
  items.splice(insertAt, 0, removed.item);
  return { ...current, items };
};

export const swapQueuedItems = (
  queue: MessageQueueSession | null,
  firstId: string,
  secondId: string
): MessageQueueSession | null => {
  if (!queue) return queue;
  const firstIndex = queue.items.findIndex((item) => item.id === firstId);
  const secondIndex = queue.items.findIndex((item) => item.id === secondId);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) return queue;
  const items = [...queue.items];
  [items[firstIndex], items[secondIndex]] = [items[secondIndex], items[firstIndex]];
  return { ...queue, items };
};

/**
 * The session a queue mutation applies to. Handlers take this explicitly so one hook instance can
 * serve every open column, rather than only the active session.
 */
export type QueueTarget = {
  ref: SessionRef;
  session: Session | null;
  queue: MessageQueueSession | null;
  /** Sends a prompt on this target's session; "Send now" hands an item to it. */
  send: (input: PromptInput, previousQueueId?: string) => Promise<boolean>;
  /** Direct send fallback returning genuine server acceptance, for OpenChamber hosts without queue API/model. */
  sendDirectFollowUp?: (input: PromptInput) => Promise<boolean>;
  /** Refresh transcript when an idle host placed an enqueued follow-up straight into the conversation. */
  onPlaced?: () => void;
  onRemoved?: (ids: string[], destination?: { kind: 'message' | 'queue'; id: string }) => Promise<void>;
};

type Options = {
  modelsByInstance: Record<string, ModelList>;
  setQueuesByInstance: React.Dispatch<React.SetStateAction<Record<string, MessageQueueSession[]>>>;
  showActionError: (message: string | null, retry?: () => void) => void;
  refreshQueues?: (instanceIds: string[]) => Promise<void> | void;
};

/**
 * OpenChamber's server-owned follow-up queue: add, send now, edit, merge, cancel, reorder. The server
 * has no edit, so `replaceQueued` enqueues the new text and only then removes what it replaces. Every
 * mutation is applied optimistically and the server's returned queue snapshot replaces it; failures
 * roll the local copy back and offer a retry. Each handler takes the session it targets.
 */
export const useMessageQueue = ({
  modelsByInstance,
  setQueuesByInstance,
  showActionError,
  refreshQueues,
}: Options) => {
  const modelsByInstanceRef = React.useRef(modelsByInstance);
  modelsByInstanceRef.current = modelsByInstance;

  const applyQueueMutation = React.useCallback(
    (instanceId: string, mutation: { session: MessageQueueSession; refreshFailed?: boolean } | null) => {
      if (!mutation) return;
      setQueuesByInstance((prev) => {
        const existing = prev[instanceId] ?? [];
        const previous = existing.find((queue) => queue.sessionId === mutation.session.sessionId);
        const merged = mergeMutationSession(previous, mutation.session, Boolean(mutation.refreshFailed));
        const without = existing.filter((queue) => queue.sessionId !== mutation.session.sessionId);
        return {
          ...prev,
          [instanceId]: merged.items.length || merged.sendingId
            ? [merged, ...without]
            : without,
        };
      });
    },
    [setQueuesByInstance]
  );

  const queuedMessageModel = (instanceId: string, item: QueuedMessage): ModelOption => {
    const modelList = modelsByInstance[instanceId];
    const found = modelList?.models.find(
      (candidate) =>
        candidate.providerID === item.sendConfig.providerID &&
        candidate.modelID === item.sendConfig.modelID
    );
    if (found) return found;
    return {
      providerID: item.sendConfig.providerID,
      modelID: item.sendConfig.modelID,
      label: `${item.sendConfig.providerID} / ${item.sendConfig.modelID}`,
      details: {
        name: item.sendConfig.modelID,
        providerName: item.sendConfig.providerID,
        reasoning: false,
        toolcall: false,
        attachment: item.attachments.length > 0,
        inputs: [],
        variants: item.sendConfig.variant ? [item.sendConfig.variant] : [],
      },
    };
  };

  const queuedMessageInput = (
    instanceId: string,
    item: QueuedMessage,
    model: ModelOption = queuedMessageModel(instanceId, item),
    variant: string | null | undefined = item.sendConfig.variant
  ): QueueMessageInput => ({
    text: item.text || item.content,
    model,
    mode: item.sendConfig.agent,
    variant: variant ?? undefined,
    attachments: item.attachments.flatMap((file) =>
      file.dataUrl ? [{ filename: file.filename, mime: file.mimeType, url: file.dataUrl }] : []
    ),
    queuedContext: item.context,
    agentMention: item.agentMention,
    // "Send now" means "join the running turn", not "try to queue again": Hearth admits a busy
    // follow-up straight back into the inbox, which made send-now look like nothing happened.
    steer: true,
  });

  const takeErrorMessage = (status: number): string =>
    status === 409
      ? 'That queued message is already being sent.'
      : status === 404
        ? 'That queued message is no longer available.'
        : 'Could not take the queued message.';

  // Optimistic queue rows live in the same state as server rows, marked `pending`/`error`. Their
  // original input is kept here so Retry can replay it after a failure.
  const pendingInputsRef = React.useRef(new Map<string, QueueMessageInput>());

  // A row can be edited before its enqueue settles, and it has no server id until it does. The
  // edited text waits here and the enqueue's own completion path applies it — the same "enqueue the
  // replacement, then remove what it replaces" a settled edit runs. Enqueueing it straight away
  // would submit twice: the host may be about to hold the original text as well.
  const deferredEditsRef = React.useRef(new Map<string, string>());

  // local id → the server id its enqueue produced. An edit dialog opened on a row that was still
  // queueing outlives that id change and saves against the local id, which is translated here.
  const landedIdsRef = React.useRef(new Map<string, string>());

  const rememberLandedId = (localId: string, serverId: string) => {
    const landed = landedIdsRef.current;
    landed.delete(localId);
    landed.set(localId, serverId);
    // Only a Save that arrives moments after the row landed can match an entry; keep the map short.
    while (landed.size > 32) {
      const oldest = landed.keys().next();
      if (oldest.done) break;
      landed.delete(oldest.value);
    }
  };

  const updateQueue = (
    target: QueueTarget,
    updater: (queue: MessageQueueSession | null) => MessageQueueSession | null
  ) => {
    const { instanceId, sessionId } = target.ref;
    setQueuesByInstance((prev) => {
      const list = prev[instanceId] ?? [];
      const current = list.find((entry) => entry.sessionId === sessionId) ?? null;
      const next = updater(current);
      const without = list.filter((entry) => entry.sessionId !== sessionId);
      return { ...prev, [instanceId]: next ? [next, ...without] : without };
    });
  };

  const insertLocalItem = (ref: SessionRef, directory: string | undefined, item: QueuedMessage) => {
    const { instanceId, sessionId } = ref;
    setQueuesByInstance((prev) => {
      const list = prev[instanceId] ?? [];
      const base = list.find((entry) => entry.sessionId === sessionId) ?? {
        sessionId,
        directory: directory ?? '',
        items: [],
        sendingId: null,
      };
      const without = list.filter((entry) => entry.sessionId !== sessionId);
      return { ...prev, [instanceId]: [{ ...base, items: base.items.some((existing) => existing.id === item.id) ? base.items.map((existing) => existing.id === item.id ? item : existing) : [...base.items, item] }, ...without] };
    });
  };

  const patchLocalItem = (target: QueueTarget, itemId: string, patch: Partial<QueuedMessage>) => {
    updateQueue(target, (queue) =>
      queue
        ? { ...queue, items: queue.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) }
        : queue
    );
  };

  const removeLocalItem = (target: QueueTarget, itemId: string) => {
    updateQueue(target, (queue) => {
      if (!queue) return queue;
      const items = queue.items.filter((item) => item.id !== itemId);
      return items.length > 0 || queue.sendingId ? { ...queue, items } : null;
    });
  };

  /**
   * A follow-up the composer submitted directly that Hearth parked in the inbox. The send path
   * only learns the outcome after submitting, so it must not have shown a sent transcript bubble;
   * insert a settled row keyed by the real submission id (preserving attachments) so it reconciles
   * cleanly with the server row instead of flickering into and out of the transcript. The caller
   * refreshes the queue.
   */
  const adoptQueuedSubmission = (
    ref: SessionRef,
    directory: string | undefined,
    submission: AdoptedQueuedSubmission
  ) => {
    insertLocalItem(ref, directory, buildAdoptedQueuedMessage(submission));
  };

  const resolveQueueModel = (
    instanceId: string,
    input: PromptInput,
    session: Session | null
  ): ModelOption | undefined => {
    if (input.model) return input.model;
    const modelList = modelsByInstanceRef.current[instanceId];
    if (modelList?.defaultModelId) {
      const found = modelList.models.find((candidate) => modelRefKey(candidate) === modelList.defaultModelId);
      if (found) return found;
    }
    if (session?.model) {
      const found = modelList?.models.find(
        (candidate) =>
          candidate.providerID === session.model!.providerID &&
          candidate.modelID === session.model!.modelID
      );
      if (found) return found;
      return {
        providerID: session.model.providerID,
        modelID: session.model.modelID,
        label: `${session.model.providerID} / ${session.model.modelID}`,
        details: {
          name: session.model.modelID,
          providerName: session.model.providerID,
          reasoning: false,
          toolcall: false,
          attachment: (input.attachments?.length ?? 0) > 0,
          inputs: [],
          variants: session.model.variant ? [session.model.variant] : [],
        },
      };
    }
    return undefined;
  };

  const enqueueLocal = async (
    target: QueueTarget,
    localId: string,
    directory: string,
    input: QueueMessageInput,
    options?: { fallbackToDirectSendOn404?: boolean }
  ): Promise<MessageQueueMutation | null> => {
    const { instanceId, sessionId } = target.ref;
    try {
      const queued = await enqueueMessage(instanceId, sessionId, directory, input);
      if (!queued.ok || !queued.data) {
        // Nothing landed, so there is nothing to replace and nothing to submit again: an edit made
        // while the row was queueing is already the row's text and its retry input.
        deferredEditsRef.current.delete(localId);
        if (queued.status === 404) {
          pendingInputsRef.current.delete(localId);
          removeLocalItem(target, localId);
          if (options?.fallbackToDirectSendOn404 && target.sendDirectFollowUp) {
            const sentDirectly = await target.sendDirectFollowUp(input);
            return sentDirectly
              ? {
                  revision: Date.now(),
                  session: { sessionId, directory, items: [], sendingId: null },
                  destination: { kind: 'message', id: localId },
                }
              : null;
          }
          showActionError('This OpenChamber instance does not support message queueing yet.');
        } else {
          // Hearth explains itself — a blank message, an unsupported part, an image over the size
          // cap. Showing a generic line here threw that away, leaving an unexplained failed row.
          const reason = errorMessageOf(queued.data) ?? 'Could not queue this message.';
          patchLocalItem(target, localId, { pending: false, staged: undefined, error: reason });
          showActionError(reason, () => void retryQueued(localId, target));
        }
        return null;
      }
      pendingInputsRef.current.delete(localId);
      const editedText = deferredEditsRef.current.get(localId);
      deferredEditsRef.current.delete(localId);
      // The row has an id now. Prefer the one the enqueue reports; a server that omits it leaves the
      // row findable by the text it was queued with.
      const serverId =
        queued.data.itemId ||
        queued.data.session.items.find((item) => item.text === input.text || item.content === input.text)
          ?.id;
      if (serverId) rememberLandedId(localId, serverId);
      removeLocalItem(target, localId);
      applyQueueMutation(instanceId, queued.data);
      if (queued.data.refreshFailed) {
        showActionError(
          'Your follow-up was queued, but Ember couldn’t refresh the queue view.',
          refreshQueues ? () => void refreshQueues([instanceId]) : undefined
        );
      }
      if (queued.data.destination?.kind === 'message') {
        target.onPlaced?.();
      }
      if (editedText && serverId) {
        // The row was edited while it was still queueing. The host now holds the text it was queued
        // with, so run the replace a settled edit runs — against the queue the host just returned,
        // so the row keeps its place instead of jumping to the end. Deliberately not awaited: the
        // composer clears its draft when the enqueue settles, and the replacement must not hold that
        // up. `replaceQueued` reports its own failures.
        void replaceQueued(
          { itemIds: [serverId], survivorId: serverId, text: editedText },
          { ...target, queue: queued.data.session }
        );
      }
      return queued.data;
    } catch (err) {
      console.error('Queue failed', err);
      const sessionExpired =
        isRemoteExpired() ||
        Boolean(err && typeof err === 'object' && 'kind' in err && err.kind === 'session-expired');
      if (isRemoteBrowser() && sessionExpired) {
        recordRemoteRefusedSend(localId, input.text);
      }
      deferredEditsRef.current.delete(localId);
      patchLocalItem(target, localId, {
        pending: false,
        staged: undefined,
        error: err instanceof Error ? err.message : 'Could not queue this message.',
      });
      return null;
    }
  };

  /**
   * Synchronously stage follow-up messages into the session's queue before the trigger message
   * finishes sending, so opening the column shows every held message immediately in FIFO order.
   */
  const stageMessages = (
    entries: ReadonlyArray<{ id: string; input: PromptInput; createdAt: number }>,
    target: QueueTarget
  ): string[] => {
    if (entries.length === 0) return [];
    const { instanceId, sessionId } = target.ref;
    const directory = target.session?.directory ?? '';
    const stagedItems = entries.map((entry) => {
      const model = resolveQueueModel(instanceId, entry.input, target.session);
      const item = buildStagedQueuedMessage(entry, model);
      pendingInputsRef.current.set(item.id, {
        ...entry.input,
        requestId: entry.input.requestId ?? randomId(),
        ...(model ? { model } : {}),
      });
      return item;
    });
    setQueuesByInstance((prev) => {
      const list = prev[instanceId] ?? [];
      const base = list.find((entry) => entry.sessionId === sessionId) ?? {
        sessionId,
        directory,
        items: [],
        sendingId: null,
      };
      const existingIds = new Set(base.items.map((item) => item.id));
      const appended = stagedItems.filter((item) => !existingIds.has(item.id));
      const without = list.filter((entry) => entry.sessionId !== sessionId);
      return {
        ...prev,
        [instanceId]: [{ ...base, items: [...base.items, ...appended] }, ...without],
      };
    });
    return stagedItems.map((item) => item.id);
  };

  /**
   * Submit one staged follow-up once the trigger message (and any earlier follow-up) succeeded.
   */
  const flushStagedMessage = async (localId: string, target: QueueTarget): Promise<boolean> => {
    const input = pendingInputsRef.current.get(localId);
    if (!input) {
      // Discarded or settled earlier by the user; do not halt later follow-ups.
      return true;
    }
    const { instanceId } = target.ref;
    const directory = target.session?.directory ?? '';
    const modelError = selectedModelError(input.selectedModelId, input.model);
    if (modelError) {
      patchLocalItem(target, localId, { pending: false, staged: undefined, error: modelError });
      showActionError(modelError);
      return false;
    }
    const resolvedModel = input.model ?? resolveQueueModel(instanceId, input, target.session);
    const nextInput: QueueMessageInput = {
      ...input,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    };
    pendingInputsRef.current.set(localId, nextInput);
    deferredEditsRef.current.delete(localId);
    patchLocalItem(target, localId, { pending: true, staged: undefined, error: undefined });

    if (!isPiInstance(instanceId) && (!directory || !resolvedModel)) {
      if (target.sendDirectFollowUp) {
        pendingInputsRef.current.delete(localId);
        removeLocalItem(target, localId);
        return target.sendDirectFollowUp(nextInput);
      }
      const reason = !directory
        ? 'Could not queue this message because the session folder is unknown.'
        : 'Could not queue this message until the instance default model is known.';
      patchLocalItem(target, localId, { pending: false, staged: undefined, error: reason });
      showActionError(reason, () => void retryQueued(localId, target));
      return false;
    }
    return (await enqueueLocal(target, localId, directory, nextInput, { fallbackToDirectSendOn404: true })) !== null;
  };

  const failStagedMessages = (localIds: readonly string[], target: QueueTarget, reason: string) => {
    const active = new Set(localIds.filter((id) => pendingInputsRef.current.has(id)));
    if (active.size === 0) return;
    updateQueue(target, (queue) =>
      queue
        ? {
            ...queue,
            items: queue.items.map((item) =>
              active.has(item.id)
                ? { ...item, pending: false, staged: undefined, error: reason }
                : item
            ),
          }
        : queue
    );
  };

  const restageMessages = (localIds: readonly string[], target: QueueTarget): string[] => {
    const activeIds = localIds.filter((id) => pendingInputsRef.current.has(id));
    if (activeIds.length === 0) return [];
    const active = new Set(activeIds);
    updateQueue(target, (queue) =>
      queue
        ? {
            ...queue,
            items: queue.items.map((item) =>
              active.has(item.id)
                ? { ...item, pending: true, staged: true, error: undefined }
                : item
            ),
          }
        : queue
    );
    return activeIds;
  };

  const queueMessage = async (input: PromptInput, target: QueueTarget): Promise<boolean> => {
    showActionError(null);
    const { instanceId } = target.ref;
    const directory = target.session?.directory;
    // Hearth queues server-side and needs no folder; OpenChamber's queue API is directory-scoped.
    if (!directory && !isPiInstance(instanceId)) {
      showActionError('Could not queue this message because the session folder is unknown.');
      return false;
    }
    const modelError = selectedModelError(input.selectedModelId, input.model);
    if (modelError) { showActionError(modelError); return false; }
    const modelList = modelsByInstance[instanceId];
    const model = input.model ?? modelList?.models.find(
      (candidate) => modelRefKey(candidate) === modelList.defaultModelId
    );
    if (!model) {
      showActionError('Could not queue this message until the instance default model is known.');
      return false;
    }

    const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const queuedInput: QueueMessageInput = {
      ...input,
      model,
      requestId: input.requestId ?? randomId(),
    };
    pendingInputsRef.current.set(localId, queuedInput);
    insertLocalItem(target.ref, target.session?.directory, {
      id: localId,
      createdAt: Date.now(),
      text: input.text,
      content: input.text,
      attachments: (input.attachments ?? []).map((file) => ({
        filename: file.filename,
        mimeType: file.mime,
        dataUrl: file.url,
      })),
      context: input.queuedContext ?? [],
      sendConfig: {
        providerID: model.providerID,
        modelID: model.modelID,
        agent: input.mode,
        variant: input.variant,
      },
      agentMention: input.agentMention,
      pending: true,
    });
    return (await enqueueLocal(target, localId, directory ?? '', queuedInput)) !== null;
  };

  const retryQueued = async (itemId: string, target: QueueTarget): Promise<boolean> => {
    const input = pendingInputsRef.current.get(itemId);
    // Queueing does not need a directory: `enqueueLocal` passes it through to a Hearth submit that
    // ignores it, and to the OpenChamber path that reports its own refusal. Requiring it here made
    // "try again" a silent no-op for a Hearth session whose summary had not loaded one yet.
    const directory = target.session?.directory ?? '';
    if (!input) return false;
    showActionError(null);
    const { instanceId } = target.ref;
    const resolvedModel = input.model ?? resolveQueueModel(instanceId, input, target.session);
    const nextInput: QueueMessageInput = {
      ...input,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    };
    pendingInputsRef.current.set(itemId, nextInput);
    // An edit recorded while the failed enqueue was in flight is already this input's text; it must
    // not be replayed as a second replacement once the retry lands.
    deferredEditsRef.current.delete(itemId);
    patchLocalItem(target, itemId, { pending: true, staged: undefined, error: undefined });
    if (!isPiInstance(instanceId) && (!directory || !resolvedModel) && target.sendDirectFollowUp) {
      pendingInputsRef.current.delete(itemId);
      removeLocalItem(target, itemId);
      return target.sendDirectFollowUp(nextInput);
    }
    return (await enqueueLocal(target, itemId, directory, nextInput, { fallbackToDirectSendOn404: true })) !== null;
  };

  const discardQueued = (itemId: string, target: QueueTarget): boolean => {
    if (!pendingInputsRef.current.has(itemId)) return false;
    pendingInputsRef.current.delete(itemId);
    removeLocalItem(target, itemId);
    return true;
  };

  const sendQueuedMessage = async (itemId: string, target: QueueTarget): Promise<boolean> => {
    showActionError(null);
    const { instanceId, sessionId } = target.ref;
    const directory = target.session?.directory;
    if (!directory && !isPiInstance(instanceId)) {
      showActionError('Could not send this queued message because the session folder is unknown.');
      return false;
    }

    let input: QueueMessageInput | null = null;
    try {
      const taken = await takeQueuedMessage(instanceId, sessionId, itemId);
      if (!taken.ok || !taken.data) {
        showActionError(
          takeErrorMessage(taken.status),
          taken.status === 409 || taken.status === 404 ? undefined : () => void sendQueuedMessage(itemId, target)
        );
        return false;
      }
      applyQueueMutation(instanceId, taken.data);
      input = queuedMessageInput(instanceId, taken.data.item);
      if (await target.send(input, itemId)) return true;

      // Taken but not sent: put it back so nothing is lost.
      const requeued = await enqueueMessage(instanceId, sessionId, directory ?? '', input);
      if (requeued.ok && requeued.data) applyQueueMutation(instanceId, requeued.data);
      const retryId = requeued.data?.itemId;
      if (requeued.data?.destination || retryId) await target.onRemoved?.([itemId], requeued.data?.destination ?? { kind: 'queue', id: retryId! });
      const retryInput = input;
      showActionError(
        requeued.ok
          ? 'Could not send the queued message now; it was returned to the queue.'
          : 'Could not send the queued message now or return it to the queue.',
        retryId ? () => void sendQueuedMessage(retryId, target) : () => void target.send(retryInput)
      );
      return false;
    } catch (err) {
      console.error('Send queued message failed', err);
      const retryInput = input;
      showActionError(
        err instanceof Error ? err.message : 'Could not send the queued message now.',
        retryInput ? () => void target.send(retryInput) : () => void sendQueuedMessage(itemId, target)
      );
      return false;
    }
  };

  /**
   * Replace queued rows with one item carrying `text`: an edit (one id) or a merge (two or more).
   * The queue has no edit operation, so the new text is enqueued FIRST and the rows it replaces are
   * removed only once it exists. A failure at any step therefore leaves a visible duplicate rather
   * than losing what the user wrote. An edit of a row that is still queueing is recorded and applied
   * by that row's enqueue instead, because there is nothing to replace until the host answers.
   */
  const replaceQueued = async (
    request: QueueReplaceRequest,
    target: QueueTarget
  ): Promise<boolean> => {
    showActionError(null);
    const { instanceId, sessionId } = target.ref;
    const directory = target.session?.directory;
    const queue = target.queue;
    if (!queue) return false;
    const { ids, survivorId, pendingId } = resolveQueueReplaceTargets(
      queue.items,
      request,
      landedIdsRef.current
    );
    const requestText = (request.text ?? '').trim();
    if (pendingId && request.modelSelection && pendingInputsRef.current.has(pendingId)) {
      showActionError('The host is still queueing this message. Wait for it to finish, then edit its model.');
      return false;
    }

    // A row that is still queueing has no server id, so there is nothing to replace yet, and
    // enqueueing the new text now would submit the message twice once the original lands. Record it
    // where the enqueue reads its text, show it on the row, and let the enqueue's completion path
    // run the replace once the host has answered. The row stays pending throughout: it is still in
    // flight, not a settled queue item. Only an enqueue that is actually in flight can be waited for:
    // a locally pending row without one (a follow-up the composer submitted directly that the host
    // had already parked) already carries the host's id, so the settled path applies the edit now.
    if (pendingId && requestText && pendingInputsRef.current.has(pendingId)) {
      deferredEditsRef.current.set(pendingId, requestText);
      const input = pendingInputsRef.current.get(pendingId);
      // A fresh object: the request already in flight holds the old one, so only a Retry after a
      // failure picks the new text up.
      if (input) pendingInputsRef.current.set(pendingId, { ...input, text: requestText });
      patchLocalItem(target, pendingId, { text: requestText, content: requestText });
      return true;
    }

    const plan = planQueueMerge(queue.items, ids, survivorId);
    if (!plan) return false;
    const text = (request.text ?? plan.text).trim();
    if (!text) {
      showActionError('A queued message cannot be empty.');
      return false;
    }
    // Hearth queues server-side and needs no folder; OpenChamber's queue API is directory-scoped.
    if (!directory && !isPiInstance(instanceId)) {
      showActionError('Could not update the queued message because the session folder is unknown.');
      return false;
    }

    // The replacement inherits the upper item's mode, model and variant: an edit keeps its own, and
    // a merge never silently changes who answers or how hard it thinks.
    const replacement = request.modelSelection
      ? queueReplacementConfig(plan.leader.sendConfig, request.modelSelection, modelsByInstance[instanceId]?.models ?? [])
      : { config: plan.leader.sendConfig, error: null };
    if (replacement.error) { showActionError(replacement.error); return false; }
    const sendConfig = replacement.config;
    const model = queuedMessageModel(instanceId, { ...plan.leader, sendConfig });
    const input: QueueMessageInput = {
      text,
      model,
      mode: sendConfig.agent,
      variant: sendConfig.variant,
      attachments: plan.attachments,
      queuedContext: plan.queuedContext,
      agentMention: plan.leader.agentMention,
    };

    // 1. The replacement (with a loader) exists before anything is removed.
    const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pendingInputsRef.current.set(localId, input);
    insertLocalItem(target.ref, directory, {
      id: localId,
      createdAt: Date.now(),
      text,
      content: text,
      attachments: (input.attachments ?? []).map((file) => ({
        filename: file.filename,
        mimeType: file.mime,
        dataUrl: file.url,
      })),
      context: plan.queuedContext,
      sendConfig: { ...sendConfig },
      mode: plan.leader.mode,
      pending: true,
    });
    const enqueued = await enqueueLocal(target, localId, directory ?? '', input);
    // A failed enqueue leaves the originals alone and shows its own row with the error on it.
    if (!enqueued) return false;

    // 2. Only now remove the rows it replaces. A refusal here leaves both rows visible.
    let latest: MessageQueueMutation = enqueued;
    const leftovers: string[] = [];
    for (const itemId of plan.ids) {
      try {
        const removed = await removeQueuedMessage(instanceId, sessionId, itemId);
        if (removed.ok && removed.data) {
          latest = removed.data;
          applyQueueMutation(instanceId, removed.data);
          await target.onRemoved?.([itemId], enqueued.destination ?? (enqueued.itemId ? { kind: 'queue', id: enqueued.itemId } : undefined));
        } else {
          leftovers.push(itemId);
        }
      } catch (err) {
        console.error('Remove replaced queued message failed', err);
        leftovers.push(itemId);
      }
    }
    if (leftovers.length > 0) {
      showActionError(
        'The new message is queued, but a message it replaces could not be removed, so both are showing.'
      );
      return false;
    }

    // 3. Put the replacement where the row it replaces sat, so a merge doesn't reshuffle the queue.
    const newId = enqueued.itemId;
    const serverOrder = latest.session.items.map((item) => item.id);
    if (newId && serverOrder.includes(newId)) {
      const order = queueOrderAfterMerge(queue.items, plan, newId);
      if (order.length > 1 && order.join('\u0000') !== serverOrder.join('\u0000')) {
        try {
          const reordered = await reorderQueuedMessages(instanceId, sessionId, order);
          if (reordered.ok && reordered.data) {
            applyQueueMutation(instanceId, reordered.data);
            for (const [oldId, newId] of Object.entries(reordered.data.replacements ?? {})) await target.onRemoved?.([oldId], { kind: 'queue', id: newId });
          }
        } catch (err) {
          // The merge itself already succeeded; only the position is off until the next poll.
          console.error('Place replaced queued message failed', err);
        }
      }
    }
    return true;
  };

  const removeQueued = async (itemId: string, target: QueueTarget): Promise<boolean> => {
    showActionError(null);
    let removedEntry = captureRemovedQueueEntry(target.queue, itemId);
    updateQueue(target, (current) => {
      if (!current) return current;
      removedEntry = captureRemovedQueueEntry(current, itemId) ?? removedEntry;
      const items = current.items.filter((item) => item.id !== itemId);
      return items.length > 0 || current.sendingId ? { ...current, items } : null;
    });
    const rollback = () => {
      if (!removedEntry) return;
      const snapshot = removedEntry;
      updateQueue(target, (current) =>
        restoreRemovedQueuedItem(current, target.ref.sessionId, snapshot)
      );
    };

    try {
      const removed = await removeQueuedMessage(target.ref.instanceId, target.ref.sessionId, itemId);
      if (!removed.ok || !removed.data) {
        if (removed.status === 409) {
          void refreshQueues?.([target.ref.instanceId]);
          showActionError('That queued message is already being sent.');
        } else {
          rollback();
          showActionError(
            'Could not cancel the queued message.',
            () => void removeQueued(itemId, target)
          );
        }
        return false;
      }
      applyQueueMutation(target.ref.instanceId, removed.data);
      await target.onRemoved?.([itemId]);
      return true;
    } catch (err) {
      console.error('Cancel queued message failed', err);
      rollback();
      showActionError(
        err instanceof Error ? err.message : 'Could not cancel the queued message.',
        () => void removeQueued(itemId, target)
      );
      return false;
    }
  };

  const moveQueued = async (itemId: string, direction: -1 | 1, target: QueueTarget): Promise<boolean> => {
    const queue = target.queue;
    if (!queue || queue.sendingId) return false;
    showActionError(null);
    const index = queue.items.findIndex((item) => item.id === itemId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= queue.items.length) return false;

    const neighborId = queue.items[targetIndex].id;
    const items = [...queue.items];
    [items[index], items[targetIndex]] = [items[targetIndex], items[index]];
    updateQueue(target, (current) => swapQueuedItems(current, itemId, neighborId));
    const rollback = () =>
      updateQueue(target, (current) => swapQueuedItems(current, itemId, neighborId));

    try {
      const reordered = await reorderQueuedMessages(
        target.ref.instanceId,
        target.ref.sessionId,
        items.map((item) => item.id)
      );
      if (!reordered.ok || !reordered.data) {
        if (reordered.status === 409) {
          rollback();
          void refreshQueues?.([target.ref.instanceId]);
          showActionError('That queued message is already being sent.');
        } else {
          rollback();
          showActionError(
            'Could not reorder the queued messages.',
            () => void moveQueued(itemId, direction, target)
          );
        }
        return false;
      }
      applyQueueMutation(target.ref.instanceId, reordered.data);
      for (const [oldId, newId] of Object.entries(reordered.data.replacements ?? {})) await target.onRemoved?.([oldId], { kind: 'queue', id: newId });
      return true;
    } catch (err) {
      console.error('Reorder queued messages failed', err);
      rollback();
      showActionError(
        err instanceof Error ? err.message : 'Could not reorder the queued messages.',
        () => void moveQueued(itemId, direction, target)
      );
      return false;
    }
  };

  return {
    applyQueueMutation,
    queueMessage,
    stageMessages,
    flushStagedMessage,
    failStagedMessages,
    restageMessages,
    adoptQueuedSubmission,
    sendQueuedMessage,
    replaceQueued,
    removeQueued,
    moveQueued,
    retryQueued,
    discardQueued,
  };
};
