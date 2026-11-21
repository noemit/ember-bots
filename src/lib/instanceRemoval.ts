/**
 * Pure derivation and pruning helpers for genuinely removed instances/endpoints.
 *
 * Offline or unreachable hosts remain in `instances` (and `piEndpoints`) so their
 * history, drafts, and dismissal state stay intact; only IDs absent from the next
 * known set are pruned.
 */
import type { AutoAcceptPolicy, ModelList, ScheduledTask } from '../api';
import type {
  BallState,
  DelegatorModels,
  EmberSettings,
  EmberSettingsPatch,
  InstanceDefaults,
  MessageQueueSession,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from '../types';
import type { SessionMessageSummary } from './messageSummary';
import type { PendingCreate } from './pendingCreate';
import type { RepairHalt } from './repairBudget';
import type { ScheduledModelTarget } from './scheduledView';
import { parseSessionKey } from './workspace';

export type InstanceIdentifier = string | { id: string };

const toInstanceId = (entry: InstanceIdentifier): string => (typeof entry === 'string' ? entry : entry.id);

const filterRecord = <T>(
  record: Record<string, T>,
  shouldDrop: (key: string) => boolean,
): Record<string, T> => {
  const entries = Object.entries(record);
  let changed = false;
  const kept: Array<[string, T]> = [];
  for (const entry of entries) {
    if (shouldDrop(entry[0])) changed = true;
    else kept.push(entry);
  }
  return changed ? Object.fromEntries(kept) : record;
};

const filterList = <T>(items: readonly T[], shouldDrop: (item: T) => boolean): T[] => {
  let changed = false;
  const kept: T[] = [];
  for (const item of items) {
    if (shouldDrop(item)) changed = true;
    else kept.push(item);
  }
  return changed ? kept : (items as T[]);
};

const filterSet = (items: Set<string>, shouldDrop: (item: string) => boolean): Set<string> => {
  let changed = false;
  for (const item of items) {
    if (shouldDrop(item)) {
      changed = true;
      break;
    }
  }
  if (!changed) return items;
  const next = new Set<string>();
  for (const item of items) {
    if (!shouldDrop(item)) next.add(item);
  }
  return next;
};

/**
 * Compute instance IDs present in `previous` that are no longer in `next`.
 * Never marks unreachable/offline hosts as removed when they still exist in `next`.
 */
export const removedInstanceIds = (
  previous: Iterable<InstanceIdentifier>,
  next: Iterable<InstanceIdentifier>,
): Set<string> => {
  const retained = new Set<string>();
  for (const entry of next) retained.add(toInstanceId(entry));
  const removed = new Set<string>();
  for (const entry of previous) {
    const id = toInstanceId(entry);
    if (!retained.has(id)) removed.add(id);
  }
  return removed;
};

/** Whether a composite session key (`instanceId::sessionId`) belongs to a removed instance. */
export const isRemovedSessionKey = (key: string | null | undefined, removedIds: ReadonlySet<string>): boolean => {
  if (!key || removedIds.size === 0) return false;
  const ref = parseSessionKey(key);
  return ref ? removedIds.has(ref.instanceId) : false;
};

/** Whether a scheduled task key (`task:<instanceId>::<projectId>::<taskId>`) belongs to a removed instance. */
export const isRemovedScheduledTaskKey = (taskKey: string, removedIds: ReadonlySet<string>): boolean => {
  if (removedIds.size === 0 || !taskKey.startsWith('task:')) return false;
  const rest = taskKey.slice('task:'.length);
  const sep = rest.indexOf('::');
  if (sep <= 0) return false;
  return removedIds.has(rest.slice(0, sep));
};

/** Drop top-level entries keyed by `instanceId`, preserving reference identity if nothing changed. */
export const pruneRecordByInstance = <T>(
  record: Record<string, T>,
  removedIds: ReadonlySet<string>,
): Record<string, T> => {
  if (removedIds.size === 0) return record;
  return filterRecord(record, (instanceId) => removedIds.has(instanceId));
};

/** Drop top-level entries keyed by `sessionKey` for removed instances. */
export const pruneRecordBySessionKey = <T>(
  record: Record<string, T>,
  removedIds: ReadonlySet<string>,
): Record<string, T> => {
  if (removedIds.size === 0) return record;
  return filterRecord(record, (key) => isRemovedSessionKey(key, removedIds));
};

/** Drop top-level entries keyed by `task:<instanceId>::...` for removed instances. */
export const pruneRecordByScheduledTaskKey = <T>(
  record: Record<string, T>,
  removedIds: ReadonlySet<string>,
): Record<string, T> => {
  if (removedIds.size === 0) return record;
  return filterRecord(record, (taskKey) => isRemovedScheduledTaskKey(taskKey, removedIds));
};

/** Remove deleted instance IDs from an ordered list while preserving reference identity when unchanged. */
export const pruneInstanceIdList = (ids: readonly string[], removedIds: ReadonlySet<string>): string[] => {
  if (removedIds.size === 0) return ids as string[];
  return filterList(ids, (id) => removedIds.has(id));
};

/** Remove session keys belonging to deleted instances from a list. */
export const pruneSessionKeyList = (keys: readonly string[], removedIds: ReadonlySet<string>): string[] => {
  if (removedIds.size === 0) return keys as string[];
  return filterList(keys, (key) => isRemovedSessionKey(key, removedIds));
};

/** Remove session keys belonging to deleted instances from a `Set`. */
export const pruneSessionKeySet = (keys: Set<string>, removedIds: ReadonlySet<string>): Set<string> => {
  if (removedIds.size === 0 || keys.size === 0) return keys;
  return filterSet(keys, (key) => isRemovedSessionKey(key, removedIds));
};

/** Remove scheduled task keys belonging to deleted instances from a `Set`. */
export const pruneScheduledTaskKeySet = (keys: Set<string>, removedIds: ReadonlySet<string>): Set<string> => {
  if (removedIds.size === 0 || keys.size === 0) return keys;
  return filterSet(keys, (key) => isRemovedScheduledTaskKey(key, removedIds));
};

/** Remove in-flight pending session placeholders targeting deleted instances. */
export const prunePendingCreates = (
  pending: readonly PendingCreate[],
  removedIds: ReadonlySet<string>,
): PendingCreate[] => {
  if (removedIds.size === 0) return pending as PendingCreate[];
  return filterList(pending, (item) => removedIds.has(item.options.instanceId));
};

export type PrunableInstanceState<TTranscript = unknown> = {
  projectsByInstance: Record<string, Project[]>;
  sessionsByInstance: Record<string, Session[]>;
  statesByInstance: Record<string, Record<string, BallState>>;
  stateReadAt: Record<string, number>;
  permissionsByInstance: Record<string, PermissionRequest[]>;
  questionsByInstance: Record<string, QuestionRequest[]>;
  queuesByInstance: Record<string, MessageQueueSession[]>;
  modelsByInstance: Record<string, ModelList>;
  autoAcceptByInstance: Record<string, AutoAcceptPolicy>;
  liveInstances?: Record<string, boolean>;
  openSessions: string[];
  activeSession: string | null;
  minimizedSessions: Set<string>;
  threadModalKey: string | null;
  summaries: Record<string, SessionMessageSummary>;
  transcripts: Record<string, TTranscript>;
  historyIncomplete: Record<string, boolean>;
  repairHalts: Record<string, RepairHalt>;
  bypassOverrides: Record<string, boolean>;
  scheduledTasksByKey: Record<string, ScheduledTask>;
  scheduledTaskNames: Record<string, string>;
  runningScheduledKeys?: Set<string>;
  pendingCreates: PendingCreate[];
  newSessionInstanceId: string | null;
  newSessionDirectory: string | null;
  draftPendingId: string | null;
  providerEndpointId?: string | undefined;
  avatarPickerSession?: Session | null;
  archiveConfirmKey?: string | null;
  promoteTarget?: Session | null;
  scheduledModelTarget?: ScheduledModelTarget | null;
  sendingKeys?: Set<string>;
  reloadingKeys?: Set<string>;
  stoppingKeys?: Set<string>;
  archivingKeys?: Set<string>;
  compactingKeys?: Set<string>;
  askingSideQuestionKeys?: Set<string>;
};

/**
 * Prune all renderer-local runtime state for genuinely removed instances.
 * Unchanged fields retain their original references to avoid spurious re-renders.
 */
export const pruneInstanceState = <TTranscript>(
  state: PrunableInstanceState<TTranscript>,
  removedIds: ReadonlySet<string>,
): PrunableInstanceState<TTranscript> => {
  if (removedIds.size === 0) return state;

  const openSessions = pruneSessionKeyList(state.openSessions, removedIds);
  const activeRemoved = isRemovedSessionKey(state.activeSession, removedIds);
  const activeSession = activeRemoved ? (openSessions[0] ?? null) : state.activeSession;
  const minimizedSessions = pruneSessionKeySet(state.minimizedSessions, removedIds);
  const threadModalKey = isRemovedSessionKey(state.threadModalKey, removedIds) ? null : state.threadModalKey;
  const pendingCreates = prunePendingCreates(state.pendingCreates, removedIds);
  const newInstanceRemoved = state.newSessionInstanceId !== null && removedIds.has(state.newSessionInstanceId);
  const draftRemoved =
    state.draftPendingId !== null &&
    pendingCreates !== state.pendingCreates &&
    !pendingCreates.some((item) => item.id === state.draftPendingId);

  return {
    projectsByInstance: pruneRecordByInstance(state.projectsByInstance, removedIds),
    sessionsByInstance: pruneRecordByInstance(state.sessionsByInstance, removedIds),
    statesByInstance: pruneRecordByInstance(state.statesByInstance, removedIds),
    stateReadAt: pruneRecordByInstance(state.stateReadAt, removedIds),
    permissionsByInstance: pruneRecordByInstance(state.permissionsByInstance, removedIds),
    questionsByInstance: pruneRecordByInstance(state.questionsByInstance, removedIds),
    queuesByInstance: pruneRecordByInstance(state.queuesByInstance, removedIds),
    modelsByInstance: pruneRecordByInstance(state.modelsByInstance, removedIds),
    autoAcceptByInstance: pruneRecordByInstance(state.autoAcceptByInstance, removedIds),
    ...(state.liveInstances !== undefined
      ? { liveInstances: pruneRecordByInstance(state.liveInstances, removedIds) }
      : {}),
    openSessions,
    activeSession,
    minimizedSessions,
    threadModalKey,
    summaries: pruneRecordBySessionKey(state.summaries, removedIds),
    transcripts: pruneRecordBySessionKey(state.transcripts, removedIds),
    historyIncomplete: pruneRecordBySessionKey(state.historyIncomplete, removedIds),
    repairHalts: pruneRecordBySessionKey(state.repairHalts, removedIds),
    bypassOverrides: pruneRecordBySessionKey(state.bypassOverrides, removedIds),
    scheduledTasksByKey: pruneRecordByScheduledTaskKey(state.scheduledTasksByKey, removedIds),
    scheduledTaskNames: pruneRecordByScheduledTaskKey(state.scheduledTaskNames, removedIds),
    ...(state.runningScheduledKeys !== undefined
      ? { runningScheduledKeys: pruneScheduledTaskKeySet(state.runningScheduledKeys, removedIds) }
      : {}),
    pendingCreates,
    newSessionInstanceId: newInstanceRemoved ? null : state.newSessionInstanceId,
    newSessionDirectory: newInstanceRemoved ? null : state.newSessionDirectory,
    draftPendingId: draftRemoved ? null : state.draftPendingId,
    ...(state.providerEndpointId !== undefined
      ? { providerEndpointId: removedIds.has(state.providerEndpointId) ? undefined : state.providerEndpointId }
      : {}),
    ...(state.avatarPickerSession !== undefined
      ? {
          avatarPickerSession:
            state.avatarPickerSession && removedIds.has(state.avatarPickerSession.instanceId)
              ? null
              : state.avatarPickerSession,
        }
      : {}),
    ...(state.archiveConfirmKey !== undefined
      ? { archiveConfirmKey: isRemovedSessionKey(state.archiveConfirmKey, removedIds) ? null : state.archiveConfirmKey }
      : {}),
    ...(state.promoteTarget !== undefined
      ? {
          promoteTarget:
            state.promoteTarget && removedIds.has(state.promoteTarget.instanceId) ? null : state.promoteTarget,
        }
      : {}),
    ...(state.scheduledModelTarget !== undefined
      ? {
          scheduledModelTarget:
            state.scheduledModelTarget && removedIds.has(state.scheduledModelTarget.task.instanceId)
              ? null
              : state.scheduledModelTarget,
        }
      : {}),
    ...(state.sendingKeys !== undefined ? { sendingKeys: pruneSessionKeySet(state.sendingKeys, removedIds) } : {}),
    ...(state.reloadingKeys !== undefined
      ? { reloadingKeys: pruneSessionKeySet(state.reloadingKeys, removedIds) }
      : {}),
    ...(state.stoppingKeys !== undefined ? { stoppingKeys: pruneSessionKeySet(state.stoppingKeys, removedIds) } : {}),
    ...(state.archivingKeys !== undefined
      ? { archivingKeys: pruneSessionKeySet(state.archivingKeys, removedIds) }
      : {}),
    ...(state.compactingKeys !== undefined
      ? { compactingKeys: pruneSessionKeySet(state.compactingKeys, removedIds) }
      : {}),
    ...(state.askingSideQuestionKeys !== undefined
      ? { askingSideQuestionKeys: pruneSessionKeySet(state.askingSideQuestionKeys, removedIds) }
      : {}),
  };
};

export type PrunableInstanceSettings = Pick<
  EmberSettings,
  | 'hiddenInstances'
  | 'dismissedOutages'
  | 'instanceDefaults'
  | 'delegatorModels'
  | 'openSessions'
  | 'activeSession'
  | 'minimizedSessions'
>;

/**
 * Derive a sparse settings patch removing persisted workspace/instance entries for deleted instances.
 * Returns `null` when nothing in `settings` references any removed instance.
 */
export const pruneInstanceSettingsPatch = (
  settings: PrunableInstanceSettings,
  removedIds: ReadonlySet<string>,
): EmberSettingsPatch | null => {
  if (removedIds.size === 0) return null;

  const patch: EmberSettingsPatch = {};
  let changed = false;

  const hiddenInstances = pruneInstanceIdList(settings.hiddenInstances, removedIds);
  if (hiddenInstances !== settings.hiddenInstances) {
    patch.hiddenInstances = hiddenInstances;
    changed = true;
  }

  const dismissedOutages = pruneInstanceIdList(settings.dismissedOutages, removedIds);
  if (dismissedOutages !== settings.dismissedOutages) {
    patch.dismissedOutages = dismissedOutages;
    changed = true;
  }

  const instanceDefaults = pruneRecordByInstance<InstanceDefaults>(settings.instanceDefaults, removedIds);
  if (instanceDefaults !== settings.instanceDefaults) {
    patch.instanceDefaults = instanceDefaults;
    changed = true;
  }

  if (settings.delegatorModels !== undefined) {
    const delegatorModels = pruneRecordByInstance<DelegatorModels>(settings.delegatorModels, removedIds);
    if (delegatorModels !== settings.delegatorModels) {
      patch.delegatorModels = delegatorModels;
      changed = true;
    }
  }

  const openSessions = pruneSessionKeyList(settings.openSessions, removedIds);
  if (openSessions !== settings.openSessions) {
    patch.openSessions = openSessions;
    changed = true;
  }

  if (isRemovedSessionKey(settings.activeSession, removedIds)) {
    patch.activeSession = openSessions[0] ?? null;
    changed = true;
  }

  const minimizedSessions = pruneSessionKeyList(settings.minimizedSessions, removedIds);
  if (minimizedSessions !== settings.minimizedSessions) {
    patch.minimizedSessions = minimizedSessions;
    changed = true;
  }

  return changed ? patch : null;
};
