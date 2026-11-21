import * as React from 'react';
import type { AutoAcceptPolicy, ModelList, ScheduledTask } from '../api';
import { useUnreadDigests } from '../hooks/useUnreadDigests';
import { isAsyncQuestion } from '../lib/asyncQuestions';
import { crewByLeader, crewNeedsInputKeySet, isWorker, workerKeySet } from '../lib/crew';
import { crewCostsByKey } from '../lib/crewCost';
import { reconcileOutageDismissals, silentInstances } from '../lib/instanceHealth';
import type { SessionMessageSummary } from '../lib/messageSummary';
import { newSessionDirectoryPrefill, newSessionModelPrefill } from '../lib/newSessionDefaults';
import { needsOnboarding, type OnboardingState } from '../lib/onboarding';
import { projectUsageForHost } from '../lib/projectUsage';
import { buildScheduledRuns, countUnseenScheduledRuns, scheduledReadSessions } from '../lib/scheduledView';
import { instancesWithFreshStates, sessionStates } from '../lib/sessionState';
import { notificationUnreadKeys } from '../lib/sessionUnread';
import type { TranscriptCache } from '../lib/transcriptCache';
import { startupNotice } from '../lib/transcriptStatus';
import { parseSessionKey } from '../lib/workspace';
import { sessionKey } from '../types';
import type {
  BallState,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  MessageQueueSession,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from '../types';
import { forSession, recentModelKeys } from './appHelpers';

type Options = {
  instances: Instance[];
  instancesLoaded: boolean;
  projectsByInstance: Record<string, Project[]>;
  sessionsByInstance: Record<string, Session[]>;
  statesByInstance: Record<string, Record<string, BallState>>;
  stateReadAt: Record<string, number>;
  permissionsByInstance: Record<string, PermissionRequest[]>;
  questionsByInstance: Record<string, QuestionRequest[]>;
  queuesByInstance: Record<string, MessageQueueSession[]>;
  modelsByInstance: Record<string, ModelList>;
  autoAcceptByInstance: Record<string, AutoAcceptPolicy>;
  bypassOverrides: Record<string, boolean>;
  summaries: Record<string, SessionMessageSummary>;
  scheduledTasksByKey: Record<string, ScheduledTask>;
  settings: EmberSettings;
  settingsLoaded: boolean;
  settingsRef: React.RefObject<EmberSettings>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  activeSession: string | null;
  threadModalKey: string | null;
  archiveConfirmKey: string | null;
  newSessionInstanceId: string | null;
  newSessionDirectory: string | null;
  messageCacheRef: React.RefObject<TranscriptCache>;
};

/**
 * Derives all session lists, crew rollups, coarse states, prompt kinds, unread digests,
 * scheduled runs, selection slices, onboarding state, and model/project usage selectors.
 */
export function useSessionSelectors({
  instances,
  instancesLoaded,
  projectsByInstance,
  sessionsByInstance,
  statesByInstance,
  stateReadAt,
  permissionsByInstance,
  questionsByInstance,
  queuesByInstance,
  modelsByInstance,
  autoAcceptByInstance,
  bypassOverrides,
  summaries,
  scheduledTasksByKey,
  settings,
  settingsLoaded,
  settingsRef,
  handleSettings,
  activeSession,
  threadModalKey,
  archiveConfirmKey,
  newSessionInstanceId,
  newSessionDirectory,
  messageCacheRef,
}: Options) {
  // A coarse clock so an answer that is no longer being refreshed can age into `unknown` even when
  // every poll is failing: a failing poll changes no state, so nothing else would re-render.
  const [stateClock, setStateClock] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setStateClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * Session titles the composer can tag with `@`.
   *
   * Same instance only — a name is resolved by the host that owns the conversation, so offering a
   * title from a different Hearth would suggest something unreachable. Archived sessions and hidden
   * workers are excluded for the same reason, and the session being typed in is excluded because
   * tagging yourself means nothing.
   */
  const mentionNamesFor = React.useMemo(() => {
    const byInstance: Record<string, string[]> = {};
    for (const [instanceId, list] of Object.entries(sessionsByInstance)) {
      byInstance[instanceId] = list
        .filter((entry) => !entry.archived && entry.kind !== 'worker' && entry.title)
        .map((entry) => entry.title as string);
    }
    return byInstance;
  }, [sessionsByInstance]);

  // Hidden instances live in settings, not in memory: unticking a host in the Instances menu is
  // "remove it from my list", and it used to be forgotten on the next launch.
  const hidden = React.useMemo(() => new Set(settings.hiddenInstances), [settings.hiddenInstances]);
  // Hosts whose outage warning was dismissed. Same reasoning — a sleeping laptop should not put
  // the row back on every launch — but a dismissal only survives *this* outage: see
  // reconcileOutageDismissals for when it is cleared.
  const dismissedOutages = React.useMemo(
    () => new Set(settings.dismissedOutages),
    [settings.dismissedOutages]
  );
  // Per-message read state lives in settings (`readMarks`), so it survives a restart — see
  // lib/readState. Opening a session does not mark anything; the dot on one message does.
  const readMarks = settings.readMarks;

  // Absent on the first launch that understood marks: everything older than this instant counts as
  // read, so the upgrade doesn't open Home with every message ever written flagged unread.
  const readSince = settings.readSince ?? 0;
  React.useEffect(() => {
    if (!settingsLoaded || settings.readSince !== undefined) return;
    void handleSettings({ readSince: Date.now() });
  }, [settingsLoaded, settings.readSince, handleSettings]);

  // The transcript/rail display slice the eye menu edits; memoized so ChatView (memoized) only
  // re-renders when one of these actually changes.
  const viewSettings = React.useMemo(
    () => ({
      reasoningDisplay: settings.reasoningDisplay,
      hideToolCalls: settings.hideToolCalls,
      showQuestions: settings.showQuestions,
      expandToolCalls: settings.expandToolCalls,
      showMessageDetails: settings.showMessageDetails,
      showActivityRail: settings.showActivityRail,
      compactSpacing: settings.compactSpacing,
      compactRail: settings.compactRail,
      autoFollow: settings.autoFollow,
      splitView: settings.splitView,
      toolDisplay: settings.toolDisplay,
    }),
    [
      settings.reasoningDisplay,
      settings.hideToolCalls,
      settings.showQuestions,
      settings.expandToolCalls,
      settings.showMessageDetails,
      settings.showActivityRail,
      settings.compactSpacing,
      settings.compactRail,
      settings.autoFollow,
      settings.splitView,
      settings.toolDisplay,
    ]
  );

  /**
   * The first-run guide.
   *
   * Derived from what is actually true — a local harness that answers, or another host that does —
   * rather than from "have sessions ever existed". `onboardedAt` is the migration: an install that
   * has ever had a working host is set up, whatever this launch looks like, so upgrading to the
   * build that introduced the guide does not lecture someone who has used Ember for months.
   */
  const onboardingState: OnboardingState = React.useMemo(() => {
    const localView = settings.localHarnessState;
    const localEndpoint = instances.find((instance) => instance.id === 'pi:local');
    const localReady = localEndpoint?.status === 'ready';
    const remoteReady = instances.some((instance) => instance.id !== 'pi:local' && instance.status === 'ready');
    const target =
      localEndpoint?.status === 'ready'
        ? localEndpoint.id
        : instances.find((instance) => instance.status === 'ready')?.id ?? null;
    return {
      localReady,
      canRotate: settings.localHarnessCanRotate === true,
      remoteReady,
      targetInstanceId: target,
      // A harness that answered is also "ready" before the instance list catches up; the state
      // written by the launcher is the earlier signal and avoids a flash of the failure copy.
      ...(localView?.kind === 'started' || localView?.kind === 'restarted' || localView?.kind === 'attached'
        ? {}
        : {}),
    };
  }, [instances, settings.localHarnessCanRotate, settings.localHarnessState]);

  /**
   * The dev fixture that walks the *connected* path.
   *
   * `?fixture=onboarding` describes a working install whose guide has not been dismissed, which is a
   * state `needsOnboarding` deliberately says "no" to (a working host means set up). The fixture
   * exists so that path can be seen in a browser at all, so it overrides only the readiness part.
   */
  const onboardingFixture =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fixture') === 'onboarding';

  const instancesSettled =
    instancesLoaded && !instances.some((instance) => instance.status === 'checking');
  const onboardingOpen =
    settingsLoaded &&
    !settings.onboardedAt &&
    !settings.onboardingDismissedAt &&
    (onboardingFixture ||
      Boolean(settings.onboardingStartedAt) ||
      (instancesSettled &&
        needsOnboarding(onboardingState, settings.onboardingDismissedAt, settings.onboardingStartedAt)));

  /** What the wizard reports when the local harness did not start; null when it did. */
  const onboardingProblem =
    settings.localHarnessState && !onboardingState.localReady
      ? settings.localHarnessState.notice ?? null
      : null;

  const readyIds = React.useMemo(
    () => instances.filter((instance) => instance.attachable).map((instance) => instance.id),
    [instances]
  );
  // Stable key so effects re-run only when the set of connected instances changes.
  const readyKey = readyIds.join('\u0000');

  /**
   * The instances Ember still knows about, connected or not.
   *
   * Every list below is built from this rather than from `readyIds`: an unreachable host keeps the
   * session list from its last answer in `sessionsByInstance` (a failed poll omits the instance
   * instead of emptying it), and filtering by `readyIds` here is what turned an outage into what
   * looked like deletion — a rail showing only the one session pinned back in. The set is what keeps
   * a *removed* endpoint's leftovers out, which is a different thing from a silent one.
   */
  const knownIds = React.useMemo(() => new Set(instances.map((instance) => instance.id)), [instances]);

  // The rail lists active sessions only; archived sessions live behind the top-bar archive
  // screen. The recency window still trims the active list. Date.now() is read inside the memo,
  // so the cut-off refreshes with every session poll rather than needing a timer.
  const { sessionWindowHours } = settings;
  const sessions = React.useMemo(() => {
    const cutoff = sessionWindowHours > 0 ? Date.now() - sessionWindowHours * 3_600_000 : 0;
    return Object.entries(sessionsByInstance)
      .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
      .flatMap(([, list]) => list)
      .filter((session) => {
        // Crew workers are hidden from the rail: they surface only in their leader's strip.
        if (isWorker(session)) return false;
        // A scheduled run is an ordinary session: same list, same window, same archive rules.
        return !session.archived && (!cutoff || (session.updated ?? 0) >= cutoff);
      });
  }, [sessionsByInstance, knownIds, hidden, sessionWindowHours]);

  /**
   * What the launch is still waiting on, in one neutral line. The rail's skeleton rows were the only
   * startup signal and read as data loss, so this says plainly which of the two things is happening:
   * a Hearth that has not answered yet, or a session list still filling in.
   */
  const startupMessage = React.useMemo(
    () =>
      startupNotice({
        bootstrapping: !instancesLoaded,
        // A ready instance with no list yet is the interesting case: the request is out and the
        // answer hasn't landed. An empty list from a short read is not evidence either way (see the
        // pruning effect below), so this only counts instances that have never reported.
        waitingForSessions: readyIds.filter((id) => sessionsByInstance[id] === undefined).length,
        unreachable: instances.filter((instance) => instance.status === 'unreachable').length,
        sessionCount: sessions.length,
      }),
    [instancesLoaded, readyIds, sessionsByInstance, instances, sessions.length]
  );

  /**
   * The scheduling plans, for the rail's own section: a trigger per configured task, sorted by name.
   * The *runs* are ordinary sessions in the list above (a calendar mark says what started them).
   */
  const scheduledTaskList = React.useMemo(
    () =>
      Object.values(scheduledTasksByKey).sort(
        (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
      ),
    [scheduledTasksByKey]
  );

  /** Session key → the scheduled task its latest run belongs to, when Ember has both. */
  const scheduledTaskBySession = React.useMemo(() => {
    const map: Record<string, ScheduledTask> = {};
    for (const [key, taskKey] of Object.entries(settings.scheduledSessionBindings)) {
      const task = scheduledTasksByKey[taskKey];
      if (task) map[key] = task;
    }
    return map;
  }, [settings.scheduledSessionBindings, scheduledTasksByKey]);

  const archivedSessions = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list)
        .filter((session) => Boolean(session.archived) && !isWorker(session)),
    [knownIds, sessionsByInstance, hidden]
  );

  // Active + archived, ignoring the recency window, for the rail's broadened search.
  const everySession = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list)
        .filter((session) => !isWorker(session)),
    [knownIds, sessionsByInstance, hidden]
  );

  const allSessions = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list)
        .filter((session) => !isWorker(session)),
    [knownIds, sessionsByInstance, hidden]
  );

  /**
   * Every known session, **workers included**.
   *
   * The rail hides workers, but their summaries are what the cost badge needs: a worker is a separate
   * conversation with its own ledger, so a leader's own `cost` is only its own turns. This is the
   * list the crew walk reads — not `allSessions`, which is deliberately worker-free.
   */
  const everyKnownSession = React.useMemo(
    () =>
      Object.entries(sessionsByInstance)
        .filter(([instanceId]) => knownIds.has(instanceId) && !hidden.has(instanceId))
        .flatMap(([, list]) => list),
    [knownIds, sessionsByInstance, hidden]
  );

  /**
   * What each session has actually cost, its crew included (`lib/crewCost`). Keyed by session, so a
   * column can look its own up without walking the tree again on every render of the list.
   */
  const crewCostByKey = React.useMemo(
    () =>
      crewCostsByKey(
        everyKnownSession,
        (session) =>
          // "Has this run at all?" — the summary's newest entry id answers it without a transcript read;
          // a priced ledger or a cached transcript covers the instances that send no entry ids.
          session.lastEntryId !== undefined ||
          (typeof session.cost === 'number' && session.cost > 0) ||
          (messageCacheRef.current.get(sessionKey(session))?.length ?? 0) > 0
      ),
    [everyKnownSession, messageCacheRef]
  );

  /**
   * Configured hosts that are not answering, with the sessions Ember still lists from each one's
   * last answer. The rail renders one honest row per entry and nothing pretends the sessions were
   * deleted. Instances the user switched off in the Instances menu are left out: they are hidden on
   * purpose, not silent.
   */
  const silentInstancesList = React.useMemo(
    () => silentInstances(instances, allSessions, hidden, dismissedOutages),
    [instances, allSessions, hidden, dismissedOutages]
  );

  /**
   * A host that answers clears its own dismissal, so the warning is back the next time it goes
   * down. Deliberately keyed on `instances` rather than run on a timer: the probe result is the
   * only evidence there is, and `reconcileOutageDismissals` returns the same array when nothing
   * changed, which is what keeps this from writing settings on every render.
   */
  React.useEffect(() => {
    const current = settingsRef.current.dismissedOutages;
    if (current.length === 0) return;
    const next = reconcileOutageDismissals(current, instances);
    if (next === current) return;
    void handleSettings({ dismissedOutages: next });
  }, [instances, handleSettings, settingsRef]);

  const allInstanceSessions = React.useMemo(
    () => Object.values(sessionsByInstance).flat(),
    [sessionsByInstance]
  );

  /**
   * Crew workers grouped by their leader's key. Workers ride the session list (they are hidden
   * from the rail, not from the fetch), so the strip and the rollup need no extra reads. Built
   * from every known instance, not the recency window, so a busy worker never ages out of view.
   */
  const crewWorkers = React.useMemo(
    () => crewByLeader(allInstanceSessions),
    [allInstanceSessions]
  );

  /**
   * The keys whose blob should read `needs-input` because someone in their crew does — including
   * a worker that is itself a leader (transitive), and a worker's own summary flag. A pending
   * worker question is a decision the leader is accountable for, so it rolls all the way up.
   */
  const crewNeedsInputKeys = React.useMemo(
    () => crewNeedsInputKeySet(allInstanceSessions, crewWorkers),
    [allInstanceSessions, crewWorkers]
  );

  const permissions = React.useMemo(
    () => Object.values(permissionsByInstance).flat(),
    [permissionsByInstance]
  );
  const questions = React.useMemo(
    () => Object.values(questionsByInstance).flat(),
    [questionsByInstance]
  );

  // The instances whose status Ember actually has an answer from: reachable, and answered recently.
  const statesAnswered = React.useMemo(
    () => instancesWithFreshStates(instances, stateReadAt, stateClock),
    [instances, stateReadAt, stateClock]
  );

  // The status endpoint only knows idle/busy. A failed last turn makes an idle session `error`;
  // a pending approval or question trumps everything: the agent is blocked on us — and a prompt is
  // knowledge even when the busy flag is not, which is why those two overlays apply to `unknown`
  // too, and the failed-turn one does not.
  const states = React.useMemo(() => {
    const merged = sessionStates(sessionsByInstance, statesByInstance, statesAnswered);
    Object.entries(summaries).forEach(([key, summary]) => {
      if (summary.failed && (merged[key] ?? 'unknown') === 'idle') merged[key] = 'error';
    });
    [...permissions, ...questions.filter((request) => !isAsyncQuestion(request))].forEach((request) => {
      merged[sessionKey({ instanceId: request.instanceId, sessionId: request.sessionId })] = 'needs-input';
    });
    // A worker's pending request is the leader's decision too: roll it up the lead chain so a
    // leader looks blocked while its crew waits on the human.
    crewNeedsInputKeys.forEach((key) => {
      merged[key] = 'needs-input';
    });
    return merged;
  }, [sessionsByInstance, statesByInstance, statesAnswered, permissions, questions, summaries, crewNeedsInputKeys]);

  // Which kind of pending prompt a session has, so the blob can show a lock vs a question.
  const promptKinds = React.useMemo(() => {
    const kinds: Record<string, 'input' | 'question'> = {};
    permissions.forEach((request) => {
      kinds[sessionKey({ instanceId: request.instanceId, sessionId: request.sessionId })] = 'input';
    });
    questions.filter((request) => !isAsyncQuestion(request)).forEach((request) => {
      kinds[sessionKey({ instanceId: request.instanceId, sessionId: request.sessionId })] = 'question';
    });
    // A rolled-up crew need has no prompt of its own: show the question tilt, not a padlock.
    crewNeedsInputKeys.forEach((key) => {
      if (!kinds[key]) kinds[key] = 'question';
    });
    return kinds;
  }, [permissions, questions, crewNeedsInputKeys]);

  const selected = React.useMemo(() => parseSessionKey(activeSession), [activeSession]);
  const selectedKey = activeSession;
  // Rail previews are derived from the compact summaries, which survive transcript-cache eviction.
  const previews = React.useMemo(
    () => Object.fromEntries(Object.entries(summaries).map(([key, summary]) => [key, summary.preview])),
    [summaries]
  );
  // Thinking = an active session whose latest assistant turn is streaming with no tool running.
  // Summaries carry this even for sessions whose full transcript was never cached.
  const thinkingKeys = React.useMemo(() => {
    const keys = new Set<string>();
    Object.entries(summaries).forEach(([key, summary]) => {
      if (summary.thinking && (states[key] ?? 'unknown') === 'active') keys.add(key);
    });
    return keys;
  }, [states, summaries]);
  // Unread is per message now: a session is unread when its digest still holds a message the marks
  // do not cover. Busy/error/needs-input moods take priority over the unread dot.
  const unreadSessions = React.useMemo(
    () => scheduledReadSessions(everySession, settings.scheduledSessionBindings),
    [everySession, settings.scheduledSessionBindings]
  );
  const unreadDigests = useUnreadDigests({
    sessions: unreadSessions,
    marks: readMarks,
    readSince,
    enabled: settingsLoaded,
  });
  const unreadKeys = React.useMemo(
    () => notificationUnreadKeys(unreadSessions, readMarks, unreadDigests.digests, settings.mutedSessions),
    [unreadSessions, unreadDigests.digests, readMarks, settings.mutedSessions]
  );

  /**
   * Sessions with no unread management at all: every worker, at every depth.
   *
   * A worker is not a place a person reads; it is a thread a leader reads for them. Its unread state
   * was invisible everywhere (the rail hides workers, the digest skips them), so the switch that
   * governed it was a control with no observable effect. `kind` is not always on a worker's summary,
   * so the crew roster is what decides, exactly as the Threads shelf is drawn from it.
   */
  const workerKeys = React.useMemo(
    () => workerKeySet(Object.values(sessionsByInstance).flat(), crewWorkers),
    [sessionsByInstance, crewWorkers]
  );

  const quietKeys = React.useMemo(() => {
    const keys = new Set(settings.mutedSessions ?? []);
    // Workers are permanently quiet: no indicator, no per-message read marks, no option.
    for (const key of workerKeys) keys.add(key);
    return keys;
  }, [settings.mutedSessions, workerKeys]);

  const failedSessionKeys = React.useMemo(() => {
    const keys = new Set<string>();
    Object.entries(summaries).forEach(([key, summary]) => {
      if (summary.failed) keys.add(key);
    });
    return keys;
  }, [summaries]);

  const scheduledRuns = React.useMemo(
    () =>
      buildScheduledRuns({
        tasks: scheduledTaskList,
        sessions: everySession,
        bindings: settings.scheduledSessionBindings,
        states,
        failedKeys: failedSessionKeys,
        readMarks,
        mutedSessions: settings.mutedSessions,
        seenBaselineAt: readSince ?? 0,
        unreadKeys,
        instances,
      }),
    [
      scheduledTaskList,
      everySession,
      settings.scheduledSessionBindings,
      states,
      failedSessionKeys,
      readMarks,
      settings.mutedSessions,
      readSince,
      unreadKeys,
      instances,
    ]
  );

  const unseenScheduledRunsCount = React.useMemo(
    () => countUnseenScheduledRuns(scheduledRuns),
    [scheduledRuns]
  );

  // YOLO mode. When the instance supports server-side auto-accept, the server's per-session
  // policy is the truth (it's what OpenChamber shows as "Permission auto-accept"). Otherwise
  // fall back to a local override and Ember replies to prompts itself while the session is open.
  const selectedPolicy = selected ? autoAcceptByInstance[selected.instanceId] : undefined;
  const serverYolo = Boolean(selectedPolicy?.supported);
  const bypass = selectedKey && selected
    ? serverYolo
      ? selectedPolicy?.sessions[selected.sessionId] ?? false
      : bypassOverrides[selectedKey] ?? settings.instanceDefaults[selected.instanceId]?.bypass ?? false
    : false;
  const selectedSession = selected
    ? (sessionsByInstance[selected.instanceId] ?? []).find((s) => s.id === selected.sessionId) ?? null
    : null;
  // Reading a session is not the same as reading its messages: opening a column marks nothing.
  // The only ways a mark moves are the dot on one unread message and "Mark all as read".
  const selectedInstance = selected
    ? instances.find((instance) => instance.id === selected.instanceId) ?? null
    : null;
  const selectedQueue = selected
    ? (queuesByInstance[selected.instanceId] ?? []).find((queue) => queue.sessionId === selected.sessionId) ?? null
    : null;
  const selectedState: BallState = selectedKey ? states[selectedKey] ?? 'unknown' : 'idle';

  // The rail groups sessions into projects. Hearth folders are only for the new-agent folder
  // picker, so keep pi endpoints out of the rail's grouping map (they stay standalone sessions).
  const railProjectsByInstance = React.useMemo(
    () => Object.fromEntries(Object.entries(projectsByInstance).filter(([id]) => !id.startsWith('pi:'))),
    [projectsByInstance]
  );

  const newSessionInstanceDefaults = newSessionInstanceId ? settings.instanceDefaults[newSessionInstanceId] : undefined;
  const newSessionPrefill = React.useMemo(() => {
    if (!newSessionInstanceId) return null;
    const list = sessionsByInstance[newSessionInstanceId] ?? [];
    const defaults = newSessionInstanceDefaults ?? {};
    return {
      directory:
        newSessionDirectory ??
        newSessionDirectoryPrefill(list, projectsByInstance[newSessionInstanceId] ?? [], defaults),
      model: newSessionModelPrefill(defaults),
      bypass: defaults.bypass === true,
    };
  }, [newSessionInstanceId, newSessionDirectory, newSessionInstanceDefaults, sessionsByInstance, projectsByInstance]);

  const modelInstanceId = selected?.instanceId ?? newSessionInstanceId;
  const selectedModels = modelInstanceId ? modelsByInstance[modelInstanceId] : undefined;
  const projectUsageByInstance = React.useMemo(() => {
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(sessionsByInstance).map(([id, list]) => {
        const scheduled = new Set(
          Object.entries(settings.scheduledSessionBindings)
            .filter(([key]) => key.startsWith(id + '::'))
            .map(([key]) => key.slice(id.length + 2))
        );
        return [id, projectUsageForHost(list, id, now, scheduled)];
      })
    );
  }, [sessionsByInstance, settings.scheduledSessionBindings]);

  const modelInstanceSessions = modelInstanceId ? sessionsByInstance[modelInstanceId] : undefined;
  const recentModels = React.useMemo(
    () => recentModelKeys(modelInstanceSessions ?? []),
    [modelInstanceSessions]
  );
  const recentModelsByInstance = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(sessionsByInstance)) out[id] = recentModelKeys(list);
    return out;
  }, [sessionsByInstance]);
  const selectedPermissions = React.useMemo(() => forSession(permissions, selected), [permissions, selected]);
  const selectedQuestions = React.useMemo(
    () => forSession(questions.filter((request) => !isAsyncQuestion(request)), selected),
    [questions, selected]
  );

  const sessionByKey = React.useMemo(() => {
    const map = new Map<string, Session>();
    Object.values(sessionsByInstance)
      .flat()
      .forEach((session) => map.set(sessionKey(session), session));
    // Questions carry source identity even when the session summary page omits a descendant.
    questions.filter(isAsyncQuestion).forEach((request) => {
      const key = sessionKey(request);
      if (!map.has(key)) {
        map.set(key, {
          id: request.sessionId,
          instanceId: request.instanceId,
          title: request.sourceTitle || 'Question source · ' + request.sessionId,
          kind: request.ancestry?.length ? 'worker' : undefined,
          lead: request.ancestry?.[0] ? { instanceId: request.instanceId, sessionId: request.ancestry[0].conversationId } : undefined,
        });
      }
    });
    return map;
  }, [sessionsByInstance, questions]);

  const inspectedThread = threadModalKey ? sessionByKey.get(threadModalKey) : undefined;
  const archiveConfirmSession = archiveConfirmKey ? sessionByKey.get(archiveConfirmKey) ?? null : null;

  return {
    hidden,
    dismissedOutages,
    readMarks,
    readSince,
    viewSettings,
    mentionNamesFor,
    onboardingState,
    onboardingOpen,
    onboardingProblem,
    readyIds,
    readyKey,
    knownIds,
    sessions,
    startupMessage,
    scheduledTaskList,
    scheduledTaskBySession,
    archivedSessions,
    everySession,
    allSessions,
    everyKnownSession,
    crewCostByKey,
    silentInstancesList,
    allInstanceSessions,
    crewWorkers,
    crewNeedsInputKeys,
    permissions,
    questions,
    statesAnswered,
    states,
    promptKinds,
    selected,
    selectedKey,
    previews,
    thinkingKeys,
    unreadDigests,
    unreadKeys,
    workerKeys,
    quietKeys,
    failedSessionKeys,
    scheduledRuns,
    unseenScheduledRunsCount,
    serverYolo,
    bypass,
    selectedSession,
    selectedInstance,
    selectedQueue,
    selectedState,
    railProjectsByInstance,
    newSessionPrefill,
    modelInstanceId,
    selectedModels,
    projectUsageByInstance,
    recentModels,
    recentModelsByInstance,
    selectedPermissions,
    selectedQuestions,
    sessionByKey,
    inspectedThread,
    archiveConfirmSession,
  };
}
