import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { usePruneRemovedInstances } from '../src/app/usePruneRemovedInstances';
import type { PendingSendInput } from '../src/app/useTranscriptStore';
import type { AutoAcceptPolicy, ModelList, ScheduledTask } from '../src/api';
import { TranscriptCache } from '../src/lib/transcriptCache';
import type { SessionMessageSummary } from '../src/lib/messageSummary';
import type { PendingCreate } from '../src/lib/pendingCreate';
import type { RepairHalt } from '../src/lib/repairBudget';
import type { ScheduledModelTarget } from '../src/lib/scheduledView';
import type { AbortReceipt } from '../src/lib/sendDelivery';
import type { SentLedger } from '../src/lib/sentLedger';
import type { TranscriptState } from '../src/lib/transcriptStatus';
import type { Workspace } from '../src/lib/workspace';
import { DEFAULT_SETTINGS } from '../src/hooks/useEmberSettings';
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
} from '../src/types';

class MinimalElement {
  nodeType = 1;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: MinimalElement[] = [];
  parentNode: MinimalElement | null = null;
  ownerDocument: MinimalDocument;
  constructor(tagName: string, ownerDocument: MinimalDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }
  appendChild(child: MinimalElement) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: MinimalElement) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
}

class MinimalDocument {
  nodeType = 9;
  defaultView: unknown = null;
  createElement(tag: string) {
    return new MinimalElement(tag, this);
  }
  addEventListener() {}
  removeEventListener() {}
}

const withDom = async (run: (container: HTMLElement) => Promise<void>) => {
  const scope = globalThis as Record<string, unknown>;
  const saved = new Map<string, { present: boolean; value: unknown }>();
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
    saved.set(key, { present: key in scope, value: scope[key] });
  }
  const doc = new MinimalDocument();
  const win = {
    document: doc,
    navigator: { userAgent: 'bun' },
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = win;
  scope.window = win;
  scope.document = doc;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  const container = doc.createElement('div') as unknown as HTMLElement;
  try {
    await run(container);
  } finally {
    for (const [key, prev] of saved) {
      if (prev.present) scope[key] = prev.value;
      else delete scope[key];
    }
  }
};

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const localInstance: Instance = {
  id: 'pi:local',
  label: 'This computer',
  kind: 'pi',
  url: 'http://127.0.0.1:3002',
  status: 'ready',
  attachable: true,
};

const studioInstance: Instance = {
  id: 'pi:studio',
  label: 'Studio Mac',
  kind: 'pi',
  url: 'http://100.64.0.10:3002',
  status: 'ready',
  attachable: true,
};

type HarnessSnapshot = {
  sessionsByInstance: Record<string, Session[]>;
  openSessions: string[];
  activeSession: string | null;
  newSessionInstanceId: string | null;
  draftAppearance: DraftAppearance | null;
  draftPendingId: string | null;
  pendingCreates: PendingCreate[];
  settingsPatches: EmberSettingsPatch[];
  messageCache: TranscriptCache;
  transcriptVersion: Map<string, number>;
  pendingOptimisticIds: Map<string, Set<string>>;
  pendingSentAt: Map<string, number>;
  unconfirmedSends: Set<string>;
  abortReceipts: Map<string, AbortReceipt & { at: number }>;
  sentLedger: SentLedger;
  pendingInputs: Map<string, PendingSendInput>;
  heldFollowUps: Map<string, string[]>;
  projectLayouts: Map<string, Workspace>;
};

describe('usePruneRemovedInstances', () => {
  test('ignores initial load and offline status flips, then prunes state, caches, and settings on genuine removal', async () => {
    await withDom(async (container) => {
      const settingsPatches: EmberSettingsPatch[] = [];
      const messageCache = new TranscriptCache(() => new Set());
      messageCache.set('pi:local::1', []);
      messageCache.set('pi:studio::2', []);
      const transcriptVersion = new Map([['pi:local::1', 10], ['pi:studio::2', 20]]);
      const pendingOptimisticIds = new Map([['pi:studio::2', new Set(['m-studio'])], ['pi:local::1', new Set(['m-local'])]]);
      const pendingSentAt = new Map([['m-studio', 100], ['m-local', 200]]);
      const unconfirmedSends = new Set(['m-studio', 'm-local']);
      const abortReceipts = new Map<string, AbortReceipt & { at: number }>([
        ['pi:studio::2', { parked: 1, parkedText: 'hi', at: 1 }],
        ['pi:local::1', { parked: 0, parkedText: '', at: 1 }],
      ]);
      const sentLedger: SentLedger = new Map([
        ['pi:studio::2', [{ id: 'm-studio', text: 'hi', at: 1 }]],
        ['pi:local::1', [{ id: 'm-local', text: 'ok', at: 1 }]],
      ]);
      const pendingInputs = new Map<string, PendingSendInput>([
        ['m-studio', { target: { instanceId: 'pi:studio', sessionId: '2' }, input: { text: 'hi' } }],
        ['m-local', { target: { instanceId: 'pi:local', sessionId: '1' }, input: { text: 'ok' } }],
      ]);
      const heldFollowUps = new Map([['m-studio', ['f1']], ['m-local', ['f2']]]);
      const projectLayouts = new Map<string, Workspace>([
        ['project:pi:studio::proj-a', { open: ['pi:studio::2'], active: 'pi:studio::2', minimized: [] }],
        ['standalone:pi:studio', { open: ['pi:studio::2'], active: 'pi:studio::2', minimized: [] }],
        ['project:pi:local::proj-b', { open: ['pi:local::1'], active: 'pi:local::1', minimized: [] }],
      ]);

      let latest!: HarnessSnapshot;
      let setProps!: React.Dispatch<React.SetStateAction<{ instances: Instance[]; instancesLoaded: boolean; settingsLoaded: boolean }>>;

      function Harness() {
        const [props, setP] = React.useState({
          instances: [] as Instance[],
          instancesLoaded: false,
          settingsLoaded: false,
        });
        setProps = setP;

        const [projectsByInstance, setProjectsByInstance] = React.useState<Record<string, Project[]>>({});
        const [sessionsByInstance, setSessionsByInstance] = React.useState<Record<string, Session[]>>({
          'pi:local': [{ id: '1', instanceId: 'pi:local', title: 'Local chat' }],
          'pi:studio': [{ id: '2', instanceId: 'pi:studio', title: 'Studio chat' }],
        });
        const [statesByInstance, setStatesByInstance] = React.useState<Record<string, Record<string, BallState>>>({});
        const [stateReadAt, setStateReadAt] = React.useState<Record<string, number>>({});
        const [permissionsByInstance, setPermissionsByInstance] = React.useState<Record<string, PermissionRequest[]>>({});
        const [questionsByInstance, setQuestionsByInstance] = React.useState<Record<string, QuestionRequest[]>>({});
        const [queuesByInstance, setQueuesByInstance] = React.useState<Record<string, MessageQueueSession[]>>({});
        const [modelsByInstance, setModelsByInstance] = React.useState<Record<string, ModelList>>({});
        const [autoAcceptByInstance, setAutoAcceptByInstance] = React.useState<Record<string, AutoAcceptPolicy>>({});
        const [liveInstances, setLiveInstances] = React.useState<Record<string, boolean>>({});
        const [openSessions, setOpenSessions] = React.useState<string[]>(['pi:studio::2', 'pi:local::1']);
        const [activeSession, setActiveSession] = React.useState<string | null>('pi:studio::2');
        const [minimizedSessions, setMinimizedSessions] = React.useState<Set<string>>(() => new Set(['pi:studio::2']));
        const [threadModalKey, setThreadModalKey] = React.useState<string | null>('pi:studio::9');
        const [summaries, setSummaries] = React.useState<Record<string, SessionMessageSummary>>({});
        const [transcripts, setTranscripts] = React.useState<Record<string, TranscriptState & { messages: ChatMessage[] }>>({});
        const [historyIncomplete, setHistoryIncomplete] = React.useState<Record<string, boolean>>({});
        const [repairHalts, setRepairHalts] = React.useState<Record<string, RepairHalt>>({});
        const [bypassOverrides, setBypassOverrides] = React.useState<Record<string, boolean>>({});
        const [scheduledTasksByKey, setScheduledTasksByKey] = React.useState<Record<string, ScheduledTask>>({});
        const [scheduledTaskNames, setScheduledTaskNames] = React.useState<Record<string, string>>({});
        const [runningScheduledKeys, setRunningScheduledKeys] = React.useState<Set<string>>(() => new Set());
        const [pendingCreates, setPendingCreates] = React.useState<PendingCreate[]>([
          {
            id: 'pc-studio',
            status: 'creating',
            input: { text: 'hello' },
            options: { instanceId: 'pi:studio', directory: '/tmp' },
            createdAt: 1,
          },
        ]);
        const pendingCreatesRef = React.useRef<PendingCreate[]>(pendingCreates);
        const [newSessionInstanceId, setNewSessionInstanceId] = React.useState<string | null>('pi:studio');
        const [newSessionDirectory, setNewSessionDirectory] = React.useState<string | null>('/tmp');
        const [draftPendingId, setDraftPendingId] = React.useState<string | null>('pc-studio');
        const [draftAppearance, setDraftAppearance] = React.useState<DraftAppearance | null>({ color: '#112233' });
        const [providerEndpointId, setProviderEndpointId] = React.useState<string | undefined>('pi:studio');
        const [avatarPickerSession, setAvatarPickerSession] = React.useState<Session | null>(null);
        const [archiveConfirmKey, setArchiveConfirmKey] = React.useState<string | null>(null);
        const [promoteTarget, setPromoteTarget] = React.useState<Session | null>(null);
        const [scheduledModelTarget, setScheduledModelTarget] = React.useState<ScheduledModelTarget | null>(null);
        const [sendingKeys, setSendingKeys] = React.useState<Set<string>>(() => new Set());
        const [reloadingKeys, setReloadingKeys] = React.useState<Set<string>>(() => new Set());
        const [stoppingKeys, setStoppingKeys] = React.useState<Set<string>>(() => new Set());
        const [archivingKeys, setArchivingKeys] = React.useState<Set<string>>(() => new Set());
        const [compactingKeys, setCompactingKeys] = React.useState<Set<string>>(() => new Set());
        const [askingSideQuestionKeys, setAskingSideQuestionKeys] = React.useState<Set<string>>(() => new Set());

        const settingsRef = React.useRef<EmberSettings>({
          ...DEFAULT_SETTINGS,
          hiddenInstances: ['pi:studio'],
          dismissedOutages: ['pi:studio'],
          instanceDefaults: { 'pi:local': { directory: '/a' }, 'pi:studio': { directory: '/b' } },
          openSessions: ['pi:studio::2', 'pi:local::1'],
          activeSession: 'pi:studio::2',
          minimizedSessions: ['pi:studio::2'],
        });
        const handleSettings = React.useCallback(async (patch: EmberSettingsPatch) => {
          settingsPatches.push(patch);
          return settingsRef.current;
        }, []);

        const messageCacheRef = React.useRef(messageCache);
        const transcriptVersionRef = React.useRef(transcriptVersion);
        const pendingOptimisticIdsRef = React.useRef(pendingOptimisticIds);
        const pendingSentAtRef = React.useRef(pendingSentAt);
        const unconfirmedSendsRef = React.useRef(unconfirmedSends);
        const abortReceiptsRef = React.useRef(abortReceipts);
        const sentLedgerRef = React.useRef(sentLedger);
        const pendingInputsRef = React.useRef(pendingInputs);
        const heldFollowUpsRef = React.useRef(heldFollowUps);
        const projectLayoutsRef = React.useRef(projectLayouts);

        usePruneRemovedInstances({
          instances: props.instances,
          instancesLoaded: props.instancesLoaded,
          settingsLoaded: props.settingsLoaded,
          settingsRef,
          handleSettings,
          projectsByInstance,
          setProjectsByInstance,
          sessionsByInstance,
          setSessionsByInstance,
          statesByInstance,
          setStatesByInstance,
          stateReadAt,
          setStateReadAt,
          permissionsByInstance,
          setPermissionsByInstance,
          questionsByInstance,
          setQuestionsByInstance,
          queuesByInstance,
          setQueuesByInstance,
          modelsByInstance,
          setModelsByInstance,
          autoAcceptByInstance,
          setAutoAcceptByInstance,
          liveInstances,
          setLiveInstances,
          openSessions,
          setOpenSessions,
          activeSession,
          setActiveSession,
          minimizedSessions,
          setMinimizedSessions,
          threadModalKey,
          setThreadModalKey,
          summaries,
          setSummaries,
          transcripts,
          setTranscripts,
          historyIncomplete,
          setHistoryIncomplete,
          repairHalts,
          setRepairHalts,
          bypassOverrides,
          setBypassOverrides,
          scheduledTasksByKey,
          setScheduledTasksByKey,
          scheduledTaskNames,
          setScheduledTaskNames,
          runningScheduledKeys,
          setRunningScheduledKeys,
          pendingCreates,
          setPendingCreates,
          pendingCreatesRef,
          newSessionInstanceId,
          setNewSessionInstanceId,
          newSessionDirectory,
          setNewSessionDirectory,
          draftPendingId,
          setDraftPendingId,
          setDraftAppearance,
          providerEndpointId,
          setProviderEndpointId,
          avatarPickerSession,
          setAvatarPickerSession,
          archiveConfirmKey,
          setArchiveConfirmKey,
          promoteTarget,
          setPromoteTarget,
          scheduledModelTarget,
          setScheduledModelTarget,
          sendingKeys,
          setSendingKeys,
          reloadingKeys,
          setReloadingKeys,
          stoppingKeys,
          setStoppingKeys,
          archivingKeys,
          setArchivingKeys,
          compactingKeys,
          setCompactingKeys,
          askingSideQuestionKeys,
          setAskingSideQuestionKeys,
          messageCacheRef,
          transcriptVersion: transcriptVersionRef,
          pendingOptimisticIds: pendingOptimisticIdsRef,
          pendingSentAt: pendingSentAtRef,
          unconfirmedSends: unconfirmedSendsRef,
          abortReceipts: abortReceiptsRef,
          sentLedgerRef,
          pendingInputs: pendingInputsRef,
          heldFollowUpsByTriggerId: heldFollowUpsRef,
          projectLayoutsRef,
        });

        latest = {
          sessionsByInstance,
          openSessions,
          activeSession,
          newSessionInstanceId,
          draftAppearance,
          draftPendingId,
          pendingCreates,
          settingsPatches,
          messageCache,
          transcriptVersion,
          pendingOptimisticIds,
          pendingSentAt,
          unconfirmedSends,
          abortReceipts,
          sentLedger,
          pendingInputs,
          heldFollowUps,
          projectLayouts,
        };
        return null;
      }

      const root = createRoot(container);
      await React.act(async () => {
        root.render(React.createElement(Harness));
        await flush();
      });

      // 1. Initial load: establishes baseline without pruning anything.
      await React.act(async () => {
        setProps({ instances: [localInstance, studioInstance], instancesLoaded: true, settingsLoaded: false });
        await flush();
      });
      expect(Object.keys(latest.sessionsByInstance)).toEqual(['pi:local', 'pi:studio']);
      expect(latest.settingsPatches).toEqual([]);

      // 2. Host goes unreachable (still in `instances`): must NOT prune.
      await React.act(async () => {
        setProps({
          instances: [localInstance, { ...studioInstance, status: 'unreachable', attachable: false }],
          instancesLoaded: true,
          settingsLoaded: false,
        });
        await flush();
      });
      expect(Object.keys(latest.sessionsByInstance)).toEqual(['pi:local', 'pi:studio']);
      expect(latest.openSessions).toEqual(['pi:studio::2', 'pi:local::1']);
      expect(latest.settingsPatches).toEqual([]);

      // 3. Genuine removal of `pi:studio` while settings are not yet loaded: prunes runtime state & caches, defers settings patch.
      await React.act(async () => {
        setProps({ instances: [localInstance], instancesLoaded: true, settingsLoaded: false });
        await flush();
      });
      expect(Object.keys(latest.sessionsByInstance)).toEqual(['pi:local']);
      expect(latest.openSessions).toEqual(['pi:local::1']);
      expect(latest.activeSession).toBe('pi:local::1');
      expect(latest.newSessionInstanceId).toBeNull();
      expect(latest.draftAppearance).toBeNull();
      expect(latest.draftPendingId).toBeNull();
      expect(latest.pendingCreates).toEqual([]);
      expect(latest.messageCache.has('pi:studio::2')).toBe(false);
      expect(latest.messageCache.has('pi:local::1')).toBe(true);
      expect(latest.transcriptVersion.has('pi:studio::2')).toBe(false);
      expect(latest.pendingOptimisticIds.has('pi:studio::2')).toBe(false);
      expect(latest.pendingSentAt.has('m-studio')).toBe(false);
      expect(latest.pendingSentAt.has('m-local')).toBe(true);
      expect(latest.unconfirmedSends.has('m-studio')).toBe(false);
      expect(latest.unconfirmedSends.has('m-local')).toBe(true);
      expect(latest.abortReceipts.has('pi:studio::2')).toBe(false);
      expect(latest.sentLedger.has('pi:studio::2')).toBe(false);
      expect(latest.pendingInputs.has('m-studio')).toBe(false);
      expect(latest.pendingInputs.has('m-local')).toBe(true);
      expect(latest.heldFollowUps.has('m-studio')).toBe(false);
      expect(latest.heldFollowUps.has('m-local')).toBe(true);
      expect(latest.projectLayouts.has('project:pi:studio::proj-a')).toBe(false);
      expect(latest.projectLayouts.has('standalone:pi:studio')).toBe(false);
      expect(latest.projectLayouts.has('project:pi:local::proj-b')).toBe(true);
      expect(latest.settingsPatches).toEqual([]);

      // 4. Once settings finish loading, the deferred settings prune patch flushes cleanly.
      await React.act(async () => {
        setProps({ instances: [localInstance], instancesLoaded: true, settingsLoaded: true });
        await flush();
      });
      expect(latest.settingsPatches).toEqual([
        {
          hiddenInstances: [],
          dismissedOutages: [],
          instanceDefaults: { 'pi:local': { directory: '/a' } },
          openSessions: ['pi:local::1'],
          activeSession: 'pi:local::1',
          minimizedSessions: [],
        },
      ]);

      await React.act(async () => {
        root.unmount();
        await flush();
      });
    });
  });
});
