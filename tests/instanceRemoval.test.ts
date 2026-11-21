import { describe, expect, it } from 'bun:test';
import type { AutoAcceptPolicy, ModelList, ScheduledTask } from '../src/api';
import {
  isRemovedScheduledTaskKey,
  isRemovedSessionKey,
  pruneInstanceIdList,
  pruneInstanceSettingsPatch,
  pruneInstanceState,
  prunePendingCreates,
  pruneRecordByInstance,
  pruneRecordByScheduledTaskKey,
  pruneRecordBySessionKey,
  pruneScheduledTaskKeySet,
  pruneSessionKeyList,
  pruneSessionKeySet,
  removedInstanceIds,
  type PrunableInstanceSettings,
  type PrunableInstanceState,
} from '../src/lib/instanceRemoval';
import type { PendingCreate } from '../src/lib/pendingCreate';
import type { BallState, Instance, PermissionRequest, QuestionRequest, Session } from '../src/types';

const makeInstance = (id: string, status: Instance['status'] = 'ready'): Instance => ({
  id,
  label: id,
  url: `http://127.0.0.1:4096/${id}`,
  kind: 'pi',
  status,
  capabilities: { canSchedule: true, canShareProviders: true },
});

const makeSession = (instanceId: string, id: string): Session => ({
  instanceId,
  id,
  projectID: '/proj',
  directory: '/proj',
  title: `${instanceId} ${id}`,
  created: 100,
  updated: 200,
});

const makeTask = (instanceId: string, id: string): ScheduledTask => ({
  key: `task:${instanceId}::/proj::${id}`,
  instanceId,
  projectId: '/proj',
  id,
  name: id,
  enabled: true,
  state: {},
});

const makePendingCreate = (id: string, instanceId: string): PendingCreate => ({
  id,
  options: { instanceId, directory: '/proj' },
  title: 'hello',
  createdAt: 1000,
  phase: 'creating',
  messages: [{ id: `${id}-m1`, input: { text: 'hello', attachments: [] }, text: 'hello', attachments: [], createdAt: 1000, held: false }],
});

describe('removedInstanceIds', () => {
  it('returns only IDs absent from the next instance set and ignores additions', () => {
    const previous = [makeInstance('local'), makeInstance('pi:studio'), makeInstance('oc:work')];
    const next = [makeInstance('local'), makeInstance('pi:laptop')];
    expect(removedInstanceIds(previous, next)).toEqual(new Set(['pi:studio', 'oc:work']));
  });

  it('returns an empty set on initial bootstrap when previous is empty', () => {
    expect(removedInstanceIds([], [makeInstance('local'), makeInstance('pi:studio')])).toEqual(new Set());
  });

  it('never treats offline, checking, or unsupported hosts still in next as removed', () => {
    const previous = [makeInstance('local', 'ready'), makeInstance('pi:studio', 'ready'), makeInstance('pi:mini', 'ready')];
    const next = [
      makeInstance('local', 'ready'),
      makeInstance('pi:studio', 'unreachable'),
      makeInstance('pi:mini', 'checking'),
    ];
    expect(removedInstanceIds(previous, next)).toEqual(new Set());
  });

  it('accepts plain ID strings as well as endpoint/instance objects', () => {
    expect(removedInstanceIds(['local', 'pi:studio'], ['local'])).toEqual(new Set(['pi:studio']));
  });
});

describe('session and scheduled task key matchers', () => {
  const removed = new Set(['pi:studio']);

  it('matches composite session keys strictly by instance prefix', () => {
    expect(isRemovedSessionKey('pi:studio::sess-1', removed)).toBe(true);
    expect(isRemovedSessionKey('pi:studio::nested:id::part', removed)).toBe(true);
    expect(isRemovedSessionKey('pi:studio-2::sess-1', removed)).toBe(false);
    expect(isRemovedSessionKey('local::sess-1', removed)).toBe(false);
    expect(isRemovedSessionKey(null, removed)).toBe(false);
    expect(isRemovedSessionKey('malformed', removed)).toBe(false);
  });

  it('matches scheduled task keys strictly by instance segment', () => {
    expect(isRemovedScheduledTaskKey('task:pi:studio::/work/repo::nightly', removed)).toBe(true);
    expect(isRemovedScheduledTaskKey('task:pi:studio-2::/work/repo::nightly', removed)).toBe(false);
    expect(isRemovedScheduledTaskKey('task:local::/work/repo::nightly', removed)).toBe(false);
    expect(isRemovedScheduledTaskKey('other:pi:studio::a::b', removed)).toBe(false);
  });
});

describe('granular pruning helpers', () => {
  const removed = new Set(['pi:studio']);

  it('preserves reference identity when no entries match removedIds', () => {
    const rec = { local: [1] };
    const sessRec = { 'local::s1': true };
    const taskRec = { 'task:local::/p::t1': 'Daily' };
    const idList = ['local'];
    const sessList = ['local::s1'];
    const sessSet = new Set(['local::s1']);
    const taskSet = new Set(['task:local::/p::t1']);
    const pending = [makePendingCreate('p1', 'local')];

    expect(pruneRecordByInstance(rec, removed)).toBe(rec);
    expect(pruneRecordBySessionKey(sessRec, removed)).toBe(sessRec);
    expect(pruneRecordByScheduledTaskKey(taskRec, removed)).toBe(taskRec);
    expect(pruneInstanceIdList(idList, removed)).toBe(idList);
    expect(pruneSessionKeyList(sessList, removed)).toBe(sessList);
    expect(pruneSessionKeySet(sessSet, removed)).toBe(sessSet);
    expect(pruneScheduledTaskKeySet(taskSet, removed)).toBe(taskSet);
    expect(prunePendingCreates(pending, removed)).toBe(pending);
    expect(pruneRecordByInstance(rec, new Set())).toBe(rec);
  });

  it('removes only matching keys across records, lists, sets, and pending creates', () => {
    expect(pruneRecordByInstance({ local: 1, 'pi:studio': 2 }, removed)).toEqual({ local: 1 });
    expect(pruneRecordBySessionKey({ 'local::a': 1, 'pi:studio::b': 2 }, removed)).toEqual({ 'local::a': 1 });
    expect(pruneRecordByScheduledTaskKey({ 'task:local::/p::t1': 1, 'task:pi:studio::/p::t2': 2 }, removed)).toEqual({
      'task:local::/p::t1': 1,
    });
    expect(pruneInstanceIdList(['local', 'pi:studio'], removed)).toEqual(['local']);
    expect(pruneSessionKeyList(['local::a', 'pi:studio::b'], removed)).toEqual(['local::a']);
    expect(pruneSessionKeySet(new Set(['local::a', 'pi:studio::b']), removed)).toEqual(new Set(['local::a']));
    expect(pruneScheduledTaskKeySet(new Set(['task:local::/p::t1', 'task:pi:studio::/p::t2']), removed)).toEqual(
      new Set(['task:local::/p::t1']),
    );
    const kept = makePendingCreate('p1', 'local');
    const dropped = makePendingCreate('p2', 'pi:studio');
    expect(prunePendingCreates([kept, dropped], removed)).toEqual([kept]);
  });
});

describe('pruneInstanceState', () => {
  const buildState = (): PrunableInstanceState<string[]> => {
    const localSession = makeSession('local', 's1');
    const removedSession = makeSession('pi:studio', 's2');
    const emptyModels: ModelList = { models: [], defaultModelId: null };
    const autoAccept: AutoAcceptPolicy = { supported: true, sessions: {} };
    const perm: PermissionRequest = {
      instanceId: 'pi:studio',
      id: 'perm-1',
      sessionID: 's2',
      title: 'Run',
      type: 'bash',
    };
    const question: QuestionRequest = {
      instanceId: 'pi:studio',
      id: 'q-1',
      sessionID: 's2',
      questions: [],
    };
    const statesLocal: Record<string, BallState> = { 'local::s1': 'idle' };
    const statesRemoved: Record<string, BallState> = { 'pi:studio::s2': 'active' };

    return {
      projectsByInstance: { local: [], 'pi:studio': [] },
      sessionsByInstance: { local: [localSession], 'pi:studio': [removedSession] },
      statesByInstance: { local: statesLocal, 'pi:studio': statesRemoved },
      stateReadAt: { local: 100, 'pi:studio': 200 },
      permissionsByInstance: { local: [], 'pi:studio': [perm] },
      questionsByInstance: { local: [], 'pi:studio': [question] },
      queuesByInstance: { local: [], 'pi:studio': [] },
      modelsByInstance: { local: emptyModels, 'pi:studio': emptyModels },
      autoAcceptByInstance: { local: autoAccept, 'pi:studio': autoAccept },
      liveInstances: { local: true, 'pi:studio': false },
      openSessions: ['pi:studio::s2', 'local::s1'],
      activeSession: 'pi:studio::s2',
      minimizedSessions: new Set(['pi:studio::s2', 'local::s1']),
      threadModalKey: 'pi:studio::worker-1',
      summaries: {
        'local::s1': { text: 'ok', at: 1, role: 'assistant' },
        'pi:studio::s2': { text: 'gone', at: 2, role: 'assistant' },
      },
      transcripts: { 'local::s1': ['a'], 'pi:studio::s2': ['b'] },
      historyIncomplete: { 'local::s1': false, 'pi:studio::s2': true },
      repairHalts: { 'pi:studio::s2': { failures: 3, reason: 'error' } },
      bypassOverrides: { 'local::s1': false, 'pi:studio::s2': true },
      scheduledTasksByKey: {
        'task:local::/proj::daily': makeTask('local', 'daily'),
        'task:pi:studio::/proj::hourly': makeTask('pi:studio', 'hourly'),
      },
      scheduledTaskNames: {
        'task:local::/proj::daily': 'Daily',
        'task:pi:studio::/proj::hourly': 'Hourly',
      },
      runningScheduledKeys: new Set(['task:local::/proj::daily', 'task:pi:studio::/proj::hourly']),
      pendingCreates: [makePendingCreate('p-local', 'local'), makePendingCreate('p-studio', 'pi:studio')],
      newSessionInstanceId: 'pi:studio',
      newSessionDirectory: '/proj',
      draftPendingId: 'p-studio',
      providerEndpointId: 'pi:studio',
      avatarPickerSession: removedSession,
      archiveConfirmKey: 'pi:studio::s2',
      promoteTarget: removedSession,
      scheduledModelTarget: { task: makeTask('pi:studio', 'hourly'), runImmediately: false },
      sendingKeys: new Set(['pi:studio::s2']),
      reloadingKeys: new Set(['pi:studio::s2']),
      stoppingKeys: new Set(['pi:studio::s2']),
      archivingKeys: new Set(['pi:studio::s2']),
      compactingKeys: new Set(['pi:studio::s2']),
      askingSideQuestionKeys: new Set(['pi:studio::s2']),
    };
  };

  it('prunes every instance- and session-keyed runtime structure for removed instances and shifts activeSession', () => {
    const state = buildState();
    const pruned = pruneInstanceState(state, new Set(['pi:studio']));

    expect(Object.keys(pruned.projectsByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.sessionsByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.statesByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.stateReadAt)).toEqual(['local']);
    expect(Object.keys(pruned.permissionsByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.questionsByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.queuesByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.modelsByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.autoAcceptByInstance)).toEqual(['local']);
    expect(Object.keys(pruned.liveInstances!)).toEqual(['local']);
    expect(pruned.openSessions).toEqual(['local::s1']);
    expect(pruned.activeSession).toBe('local::s1');
    expect(pruned.minimizedSessions).toEqual(new Set(['local::s1']));
    expect(pruned.threadModalKey).toBeNull();
    expect(Object.keys(pruned.summaries)).toEqual(['local::s1']);
    expect(Object.keys(pruned.transcripts)).toEqual(['local::s1']);
    expect(Object.keys(pruned.historyIncomplete)).toEqual(['local::s1']);
    expect(pruned.repairHalts).toEqual({});
    expect(Object.keys(pruned.bypassOverrides)).toEqual(['local::s1']);
    expect(Object.keys(pruned.scheduledTasksByKey)).toEqual(['task:local::/proj::daily']);
    expect(Object.keys(pruned.scheduledTaskNames)).toEqual(['task:local::/proj::daily']);
    expect(pruned.runningScheduledKeys).toEqual(new Set(['task:local::/proj::daily']));
    expect(pruned.pendingCreates.map((item) => item.id)).toEqual(['p-local']);
    expect(pruned.newSessionInstanceId).toBeNull();
    expect(pruned.newSessionDirectory).toBeNull();
    expect(pruned.draftPendingId).toBeNull();
    expect(pruned.providerEndpointId).toBeUndefined();
    expect(pruned.avatarPickerSession).toBeNull();
    expect(pruned.archiveConfirmKey).toBeNull();
    expect(pruned.promoteTarget).toBeNull();
    expect(pruned.scheduledModelTarget).toBeNull();
    expect(pruned.sendingKeys).toEqual(new Set());
    expect(pruned.reloadingKeys).toEqual(new Set());
    expect(pruned.stoppingKeys).toEqual(new Set());
    expect(pruned.archivingKeys).toEqual(new Set());
    expect(pruned.compactingKeys).toEqual(new Set());
    expect(pruned.askingSideQuestionKeys).toEqual(new Set());
  });

  it('sets activeSession to null when the last open session belonged to a removed instance', () => {
    const state = buildState();
    state.openSessions = ['pi:studio::s2'];
    const pruned = pruneInstanceState(state, new Set(['pi:studio']));
    expect(pruned.openSessions).toEqual([]);
    expect(pruned.activeSession).toBeNull();
  });

  it('keeps activeSession, threadModalKey, draftPendingId, and picker targets for surviving hosts', () => {
    const state = buildState();
    state.activeSession = 'local::s1';
    state.threadModalKey = 'local::w1';
    state.newSessionInstanceId = 'local';
    state.newSessionDirectory = '/local-proj';
    state.draftPendingId = 'p-local';
    state.providerEndpointId = 'local';
    state.avatarPickerSession = makeSession('local', 's1');
    state.archiveConfirmKey = 'local::s1';
    state.promoteTarget = makeSession('local', 's1');
    state.scheduledModelTarget = { task: makeTask('local', 'daily'), runImmediately: true };

    const pruned = pruneInstanceState(state, new Set(['pi:studio']));
    expect(pruned.activeSession).toBe('local::s1');
    expect(pruned.threadModalKey).toBe('local::w1');
    expect(pruned.newSessionInstanceId).toBe('local');
    expect(pruned.newSessionDirectory).toBe('/local-proj');
    expect(pruned.draftPendingId).toBe('p-local');
    expect(pruned.providerEndpointId).toBe('local');
    expect(pruned.avatarPickerSession?.instanceId).toBe('local');
    expect(pruned.archiveConfirmKey).toBe('local::s1');
    expect(pruned.promoteTarget?.instanceId).toBe('local');
    expect(pruned.scheduledModelTarget?.task.instanceId).toBe('local');
  });

  it('returns original state reference untouched when removedIds is empty', () => {
    const state = buildState();
    expect(pruneInstanceState(state, new Set())).toBe(state);
  });
});

describe('pruneInstanceSettingsPatch', () => {
  const settings: PrunableInstanceSettings = {
    hiddenInstances: ['pi:studio', 'local'],
    dismissedOutages: ['pi:studio'],
    instanceDefaults: {
      local: { directory: '/a' },
      'pi:studio': { directory: '/b' },
    },
    delegatorModels: {
      local: { planner: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
      'pi:studio': { planner: { providerID: 'openai', modelID: 'gpt-5' } },
    },
    openSessions: ['pi:studio::s2', 'local::s1'],
    activeSession: 'pi:studio::s2',
    minimizedSessions: ['pi:studio::s2', 'local::s1'],
  };

  it('returns null when nothing in settings references removed instances', () => {
    expect(pruneInstanceSettingsPatch(settings, new Set())).toBeNull();
    expect(pruneInstanceSettingsPatch(settings, new Set(['pi:other']))).toBeNull();
  });

  it('produces a minimal sparse patch for only changed fields and falls back activeSession', () => {
    expect(pruneInstanceSettingsPatch(settings, new Set(['pi:studio']))).toEqual({
      hiddenInstances: ['local'],
      dismissedOutages: [],
      instanceDefaults: { local: { directory: '/a' } },
      delegatorModels: { local: { planner: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } } },
      openSessions: ['local::s1'],
      activeSession: 'local::s1',
      minimizedSessions: ['local::s1'],
    });
  });

  it('omits unchanged keys from the returned patch', () => {
    const minimal: PrunableInstanceSettings = {
      hiddenInstances: ['local'],
      dismissedOutages: [],
      instanceDefaults: { local: { directory: '/a' }, 'pi:studio': { directory: '/b' } },
      delegatorModels: undefined,
      openSessions: ['local::s1'],
      activeSession: 'local::s1',
      minimizedSessions: [],
    };
    expect(pruneInstanceSettingsPatch(minimal, new Set(['pi:studio']))).toEqual({
      instanceDefaults: { local: { directory: '/a' } },
    });
  });
});
