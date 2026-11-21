import * as React from 'react';
import type { AutoAcceptPolicy, ModelList, ScheduledTask } from '../api';
import {
  isRemovedSessionKey,
  pruneInstanceSettingsPatch,
  pruneInstanceState,
  removedInstanceIds,
  type PrunableInstanceState,
} from '../lib/instanceRemoval';
import type { SessionMessageSummary } from '../lib/messageSummary';
import type { PendingCreate } from '../lib/pendingCreate';
import type { RepairHalt } from '../lib/repairBudget';
import type { ScheduledModelTarget } from '../lib/scheduledView';
import type { AbortReceipt } from '../lib/sendDelivery';
import type { SentLedger } from '../lib/sentLedger';
import type { TranscriptCache } from '../lib/transcriptCache';
import type { TranscriptState } from '../lib/transcriptStatus';
import type { Workspace } from '../lib/workspace';
import type {
  BallState,
  ChatMessage,
  DraftAppearance,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  MessageQueueSession,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from '../types';
import type { PendingSendInput } from './useTranscriptStore';

const isRemovedLayoutKey = (key: string, removedIds: ReadonlySet<string>): boolean => {
  for (const id of removedIds) {
    if (key === `standalone:${id}` || key.startsWith(`project:${id}::`)) return true;
  }
  return false;
};

type TranscriptEntry = TranscriptState & { messages: ChatMessage[] };

export type UsePruneRemovedInstancesOptions = PrunableInstanceState<TranscriptEntry> & {
  instances: readonly Instance[];
  instancesLoaded: boolean;
  settingsLoaded: boolean;
  settingsRef: React.RefObject<EmberSettings>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  setProjectsByInstance: React.Dispatch<React.SetStateAction<Record<string, Project[]>>>;
  setSessionsByInstance: React.Dispatch<React.SetStateAction<Record<string, Session[]>>>;
  setStatesByInstance: React.Dispatch<React.SetStateAction<Record<string, Record<string, BallState>>>>;
  setStateReadAt: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setPermissionsByInstance: React.Dispatch<React.SetStateAction<Record<string, PermissionRequest[]>>>;
  setQuestionsByInstance: React.Dispatch<React.SetStateAction<Record<string, QuestionRequest[]>>>;
  setQueuesByInstance: React.Dispatch<React.SetStateAction<Record<string, MessageQueueSession[]>>>;
  setModelsByInstance: React.Dispatch<React.SetStateAction<Record<string, ModelList>>>;
  setAutoAcceptByInstance: React.Dispatch<React.SetStateAction<Record<string, AutoAcceptPolicy>>>;
  setLiveInstances: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setOpenSessions: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveSession: React.Dispatch<React.SetStateAction<string | null>>;
  setMinimizedSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  setThreadModalKey: React.Dispatch<React.SetStateAction<string | null>>;
  setSummaries: React.Dispatch<React.SetStateAction<Record<string, SessionMessageSummary>>>;
  setTranscripts: React.Dispatch<React.SetStateAction<Record<string, TranscriptEntry>>>;
  setHistoryIncomplete: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setRepairHalts: React.Dispatch<React.SetStateAction<Record<string, RepairHalt>>>;
  setBypassOverrides: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setScheduledTasksByKey: React.Dispatch<React.SetStateAction<Record<string, ScheduledTask>>>;
  setScheduledTaskNames: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setRunningScheduledKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPendingCreates: React.Dispatch<React.SetStateAction<PendingCreate[]>>;
  pendingCreatesRef: React.RefObject<PendingCreate[]>;
  setNewSessionInstanceId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewSessionDirectory: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftPendingId: (id: string | null) => void;
  setDraftAppearance: React.Dispatch<React.SetStateAction<DraftAppearance | null>>;
  setProviderEndpointId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setAvatarPickerSession: React.Dispatch<React.SetStateAction<Session | null>>;
  setArchiveConfirmKey: React.Dispatch<React.SetStateAction<string | null>>;
  setPromoteTarget: React.Dispatch<React.SetStateAction<Session | null>>;
  setScheduledModelTarget: React.Dispatch<React.SetStateAction<ScheduledModelTarget | null>>;
  setSendingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setReloadingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setStoppingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setArchivingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCompactingKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setAskingSideQuestionKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  messageCacheRef: React.RefObject<TranscriptCache>;
  transcriptVersion: React.RefObject<Map<string, number>>;
  pendingOptimisticIds: React.RefObject<Map<string, Set<string>>>;
  pendingSentAt: React.RefObject<Map<string, number>>;
  unconfirmedSends: React.RefObject<Set<string>>;
  abortReceipts: React.RefObject<Map<string, AbortReceipt & { at: number }>>;
  sentLedgerRef: React.RefObject<SentLedger>;
  pendingInputs: React.RefObject<Map<string, PendingSendInput>>;
  heldFollowUpsByTriggerId: React.RefObject<Map<string, string[]>>;
  projectLayoutsRef: React.RefObject<Map<string, Workspace>>;
};

/**
 * Prunes renderer runtime state, caches, and persisted workspace/instance settings whenever an
 * instance genuinely disappears from the loaded `instances` list (never while merely unreachable).
 */
export function usePruneRemovedInstances(options: UsePruneRemovedInstancesOptions): void {
  const { instances, instancesLoaded, settingsLoaded } = options;
  const latestRef = React.useRef(options);
  latestRef.current = options;

  const previousInstancesRef = React.useRef<readonly Instance[] | null>(null);
  const pendingSettingsPruneIdsRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (!instancesLoaded) return;
    if (previousInstancesRef.current === null) {
      previousInstancesRef.current = instances;
      return;
    }

    const current = latestRef.current;
    const retainedIds = new Set(instances.map((instance) => instance.id));
    for (const id of [...pendingSettingsPruneIdsRef.current]) {
      if (retainedIds.has(id)) pendingSettingsPruneIdsRef.current.delete(id);
    }

    const removed = removedInstanceIds(previousInstancesRef.current, instances);
    previousInstancesRef.current = instances;

    if (removed.size > 0) {
      const pruned = pruneInstanceState(current, removed);

      if (pruned.projectsByInstance !== current.projectsByInstance) current.setProjectsByInstance(pruned.projectsByInstance);
      if (pruned.sessionsByInstance !== current.sessionsByInstance) current.setSessionsByInstance(pruned.sessionsByInstance);
      if (pruned.statesByInstance !== current.statesByInstance) current.setStatesByInstance(pruned.statesByInstance);
      if (pruned.stateReadAt !== current.stateReadAt) current.setStateReadAt(pruned.stateReadAt);
      if (pruned.permissionsByInstance !== current.permissionsByInstance) current.setPermissionsByInstance(pruned.permissionsByInstance);
      if (pruned.questionsByInstance !== current.questionsByInstance) current.setQuestionsByInstance(pruned.questionsByInstance);
      if (pruned.queuesByInstance !== current.queuesByInstance) current.setQueuesByInstance(pruned.queuesByInstance);
      if (pruned.modelsByInstance !== current.modelsByInstance) current.setModelsByInstance(pruned.modelsByInstance);
      if (pruned.autoAcceptByInstance !== current.autoAcceptByInstance) current.setAutoAcceptByInstance(pruned.autoAcceptByInstance);
      if (pruned.liveInstances !== undefined && pruned.liveInstances !== current.liveInstances) {
        current.setLiveInstances(pruned.liveInstances);
      }
      if (pruned.openSessions !== current.openSessions) current.setOpenSessions(pruned.openSessions);
      if (pruned.activeSession !== current.activeSession) current.setActiveSession(pruned.activeSession);
      if (pruned.minimizedSessions !== current.minimizedSessions) current.setMinimizedSessions(pruned.minimizedSessions);
      if (pruned.threadModalKey !== current.threadModalKey) current.setThreadModalKey(pruned.threadModalKey);
      if (pruned.summaries !== current.summaries) current.setSummaries(pruned.summaries);
      if (pruned.transcripts !== current.transcripts) current.setTranscripts(pruned.transcripts);
      if (pruned.historyIncomplete !== current.historyIncomplete) current.setHistoryIncomplete(pruned.historyIncomplete);
      if (pruned.repairHalts !== current.repairHalts) current.setRepairHalts(pruned.repairHalts);
      if (pruned.bypassOverrides !== current.bypassOverrides) current.setBypassOverrides(pruned.bypassOverrides);
      if (pruned.scheduledTasksByKey !== current.scheduledTasksByKey) current.setScheduledTasksByKey(pruned.scheduledTasksByKey);
      if (pruned.scheduledTaskNames !== current.scheduledTaskNames) current.setScheduledTaskNames(pruned.scheduledTaskNames);
      if (pruned.runningScheduledKeys !== undefined && pruned.runningScheduledKeys !== current.runningScheduledKeys) {
        current.setRunningScheduledKeys(pruned.runningScheduledKeys);
      }
      if (pruned.pendingCreates !== current.pendingCreates) {
        current.pendingCreatesRef.current = pruned.pendingCreates;
        current.setPendingCreates(pruned.pendingCreates);
      }
      if (pruned.newSessionInstanceId !== current.newSessionInstanceId) {
        current.setNewSessionInstanceId(pruned.newSessionInstanceId);
        if (pruned.newSessionInstanceId === null) current.setDraftAppearance(null);
      }
      if (pruned.newSessionDirectory !== current.newSessionDirectory) current.setNewSessionDirectory(pruned.newSessionDirectory);
      if (pruned.draftPendingId !== current.draftPendingId) current.setDraftPendingId(pruned.draftPendingId);
      if (pruned.providerEndpointId !== current.providerEndpointId) current.setProviderEndpointId(pruned.providerEndpointId);
      if (pruned.avatarPickerSession !== current.avatarPickerSession) {
        current.setAvatarPickerSession(pruned.avatarPickerSession ?? null);
      }
      if (pruned.archiveConfirmKey !== current.archiveConfirmKey) {
        current.setArchiveConfirmKey(pruned.archiveConfirmKey ?? null);
      }
      if (pruned.promoteTarget !== current.promoteTarget) current.setPromoteTarget(pruned.promoteTarget ?? null);
      if (pruned.scheduledModelTarget !== current.scheduledModelTarget) {
        current.setScheduledModelTarget(pruned.scheduledModelTarget ?? null);
      }
      if (pruned.sendingKeys !== undefined && pruned.sendingKeys !== current.sendingKeys) current.setSendingKeys(pruned.sendingKeys);
      if (pruned.reloadingKeys !== undefined && pruned.reloadingKeys !== current.reloadingKeys) {
        current.setReloadingKeys(pruned.reloadingKeys);
      }
      if (pruned.stoppingKeys !== undefined && pruned.stoppingKeys !== current.stoppingKeys) current.setStoppingKeys(pruned.stoppingKeys);
      if (pruned.archivingKeys !== undefined && pruned.archivingKeys !== current.archivingKeys) {
        current.setArchivingKeys(pruned.archivingKeys);
      }
      if (pruned.compactingKeys !== undefined && pruned.compactingKeys !== current.compactingKeys) {
        current.setCompactingKeys(pruned.compactingKeys);
      }
      if (pruned.askingSideQuestionKeys !== undefined && pruned.askingSideQuestionKeys !== current.askingSideQuestionKeys) {
        current.setAskingSideQuestionKeys(pruned.askingSideQuestionKeys);
      }

      const removedMessageIds = new Set<string>();
      for (const key of [...current.messageCacheRef.current.keys()]) {
        if (isRemovedSessionKey(key, removed)) current.messageCacheRef.current.delete(key);
      }
      for (const key of [...current.transcriptVersion.current.keys()]) {
        if (isRemovedSessionKey(key, removed)) current.transcriptVersion.current.delete(key);
      }
      for (const key of [...current.abortReceipts.current.keys()]) {
        if (isRemovedSessionKey(key, removed)) current.abortReceipts.current.delete(key);
      }
      for (const [key, ids] of [...current.pendingOptimisticIds.current.entries()]) {
        if (!isRemovedSessionKey(key, removed)) continue;
        for (const id of ids) removedMessageIds.add(id);
        current.pendingOptimisticIds.current.delete(key);
      }
      for (const [key, records] of [...current.sentLedgerRef.current.entries()]) {
        if (!isRemovedSessionKey(key, removed)) continue;
        for (const record of records) removedMessageIds.add(record.id);
        current.sentLedgerRef.current.delete(key);
      }
      for (const [id, entry] of [...current.pendingInputs.current.entries()]) {
        if (!removed.has(entry.target.instanceId)) continue;
        removedMessageIds.add(id);
        current.pendingInputs.current.delete(id);
      }
      for (const id of removedMessageIds) {
        current.pendingSentAt.current.delete(id);
        current.unconfirmedSends.current.delete(id);
        current.heldFollowUpsByTriggerId.current.delete(id);
      }
      for (const key of [...current.projectLayoutsRef.current.keys()]) {
        if (isRemovedLayoutKey(key, removed)) current.projectLayoutsRef.current.delete(key);
      }

      for (const id of removed) pendingSettingsPruneIdsRef.current.add(id);
    }

    if (settingsLoaded && pendingSettingsPruneIdsRef.current.size > 0) {
      const toPrune = new Set(pendingSettingsPruneIdsRef.current);
      pendingSettingsPruneIdsRef.current.clear();
      const settingsPatch = pruneInstanceSettingsPatch(current.settingsRef.current, toPrune);
      if (settingsPatch) void current.handleSettings(settingsPatch, { preserveActionError: true });
    }
  }, [instances, instancesLoaded, settingsLoaded]);
}
