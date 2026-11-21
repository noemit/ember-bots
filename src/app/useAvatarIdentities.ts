import * as React from 'react';
import { allocateAvatar, competesForIdentity } from '../blob/allocateIdentity';
import { identityPaletteFor } from '../blob/contrast';
import { dockIconMood, moodFrom } from '../blob/mood';
import {
  avatarAppearanceOverride,
  projectForSession,
  resolveAvatarIdentity,
  seedIdentity,
  sessionAvatarKey,
} from '../blob/seed';
import { useCrewAppearance } from '../hooks/useCrewAppearance';
import { crewAppearanceMood } from '../lib/crewMood';
import { withSessionAppearance } from '../lib/draftAppearance';
import type { PendingCreate } from '../lib/pendingCreate';
import { useStableCallback } from '../lib/useStableCallback';
import { applyTheme, themeById } from '../themes';
import { sessionKey } from '../types';
import type {
  AvatarAssignment,
  AvatarIdentity,
  AvatarOverride,
  BallMood,
  BallState,
  DraftAppearance,
  EmberSettings,
  EmberSettingsPatch,
  Project,
  Session,
} from '../types';
import { sameIdentity } from './appHelpers';

type Options = {
  sessionsByInstance: Record<string, Session[]>;
  projectsByInstance: Record<string, Project[]>;
  sessions: Session[];
  openSessions: string[];
  states: Record<string, BallState>;
  promptKinds: Record<string, 'input' | 'question'>;
  thinkingKeys: Set<string>;
  unreadKeys: Set<string>;
  crewWorkers: Map<string, Session[]>;
  workerKeys: Set<string>;
  threadModalKey: string | null;
  selectedKey: string | null;
  settings: EmberSettings;
  settingsRef: React.RefObject<EmberSettings>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  pendingCreates: PendingCreate[];
  draftPendingId: string | null;
  avatarPickerSession: Session | null;
  scheduledTaskNames: Record<string, string>;
};

/**
 * Derives stable per-session avatar identities, crew mood alternation, draft/new-bot color & shape
 * allocation, appearance picker scopes, theme application, and the native dock/taskbar icon.
 */
export function useAvatarIdentities({
  sessionsByInstance,
  projectsByInstance,
  sessions,
  openSessions,
  states,
  promptKinds,
  thinkingKeys,
  unreadKeys,
  crewWorkers,
  workerKeys,
  threadModalKey,
  selectedKey,
  settings,
  settingsRef,
  handleSettings,
  pendingCreates,
  draftPendingId,
  avatarPickerSession,
  scheduledTaskNames,
}: Options) {
  // A sent draft reserves its appearance until the host returns its real id (including retries).
  const pendingAvatars = React.useRef(new Map<string, AvatarAssignment>());
  const avatarReservations = React.useRef(
    new Map<string, { session: Session; assignment: AvatarAssignment; appearance?: AvatarOverride }>()
  );

  const crewAppearance = React.useMemo(() => {
    const map: Record<string, BallMood> = {};
    const crewKeys = new Set<string>();
    Object.entries(sessionsByInstance).forEach(([, list]) =>
      list.forEach((session) => {
        const key = sessionKey(session);
        // Crew activity changes the blob only, never the leader's send/queue/stop state.
        const ownMood = moodFrom(
          states[key] ?? 'unknown',
          promptKinds[key],
          thinkingKeys.has(key),
          unreadKeys.has(key)
        );
        map[key] = crewAppearanceMood(session, ownMood, crewWorkers, states);
        // Hidden workers and archived chats need no UI cadence of their own. A worker
        // opened for inspection can still show its legacy descendants' activity.
        if (
          map[key] !== ownMood &&
          ((!workerKeys.has(key) && !session.archived) || key === threadModalKey || key === selectedKey)
        ) {
          crewKeys.add(key);
        }
      })
    );
    return { baseMoods: map, crewKeys };
  }, [sessionsByInstance, states, promptKinds, thinkingKeys, unreadKeys, crewWorkers, workerKeys, threadModalKey, selectedKey]);

  const moods = useCrewAppearance(crewAppearance.baseMoods, crewAppearance.crewKeys);

  // Every blob renderer memoizes on its identity object, so hand back the previous reference
  // whenever a session's identity hasn't actually changed; otherwise each 10s poll would
  // re-derive traits for every visible avatar.
  const avatarIdentitiesRef = React.useRef<Record<string, AvatarIdentity>>({});
  const avatarIdentities = React.useMemo(() => {
    const previous = avatarIdentitiesRef.current;
    const next = Object.fromEntries(
      Object.entries(sessionsByInstance).flatMap(([instanceId, list]) =>
        list.map((session) => {
          const key = sessionKey(session);
          const identity = resolveAvatarIdentity(
            session,
            projectsByInstance[instanceId] ?? [],
            settings.scheduledSessionBindings,
            settings.avatarOverrides,
            settings.avatarAssignments[key]
          );
          const before = previous[key];
          return [key, before && sameIdentity(before, identity) ? before : identity];
        })
      )
    );
    avatarIdentitiesRef.current = next;
    return next;
  }, [sessionsByInstance, projectsByInstance, settings.scheduledSessionBindings, settings.avatarOverrides, settings.avatarAssignments]);

  const allocationPalette = React.useMemo(() => {
    const palette = themeById(settings.theme).palette;
    return identityPaletteFor([palette.panel, palette.elev, palette.bg]);
  }, [settings.theme]);

  const occupiedIdentities = React.useMemo(() => {
    const visibleKeys = new Set([...sessions.map(sessionKey), ...openSessions]);
    // Compare with the active rail and any open columns pinned outside its recency window,
    // not archived history or sessions on hidden/removed hosts.
    return Object.values(sessionsByInstance)
      .flat()
      .filter((session) => competesForIdentity(session) && visibleKeys.has(sessionKey(session)))
      .map((session) => avatarIdentities[sessionKey(session)]);
  }, [sessionsByInstance, sessions, openSessions, avatarIdentities]);
  const occupiedIdentitiesRef = React.useRef(occupiedIdentities);
  occupiedIdentitiesRef.current = occupiedIdentities;

  React.useEffect(() => {
    // Once a real bot is in the ordinary identity pool, its temporary reservation is redundant.
    for (const key of avatarReservations.current.keys()) {
      if (settings.avatarAssignments[key] && avatarIdentities[key]) avatarReservations.current.delete(key);
    }
  }, [settings.avatarAssignments, avatarIdentities]);

  const allocateFor = React.useCallback(
    (session: Session, arriving: readonly Session[] = []) => {
      const current = settingsRef.current;
      const pool = new Map(occupiedIdentitiesRef.current.map((identity) => [identity.sessionKey, identity]));
      for (const peer of arriving) {
        if (!competesForIdentity(peer)) continue;
        const key = sessionKey(peer);
        if (!pool.has(key)) {
          pool.set(
            key,
            resolveAvatarIdentity(
              peer,
              projectsByInstance[peer.instanceId] ?? [],
              current.scheduledSessionBindings,
              current.avatarOverrides,
              current.avatarAssignments[key]
            )
          );
        }
      }
      for (const [key, reservation] of avatarReservations.current) {
        const { session: reserved, assignment, appearance } = reservation;
        pool.set(
          key,
          resolveAvatarIdentity(
            reserved,
            projectsByInstance[reserved.instanceId] ?? [],
            current.scheduledSessionBindings,
            withSessionAppearance(reserved, current.avatarOverrides, appearance),
            assignment
          )
        );
      }
      pool.delete(sessionKey(session));
      return allocateAvatar(
        'new-bot',
        [...pool.values()],
        current.blobStyle,
        allocationPalette,
        avatarAppearanceOverride(
          session,
          projectsByInstance[session.instanceId] ?? [],
          current.scheduledSessionBindings,
          current.avatarOverrides
        )
      );
    },
    [allocationPalette, projectsByInstance, settingsRef]
  );

  const reserveIdentity = React.useCallback(
    (
      session: Session,
      assignment: AvatarAssignment,
      reservationKey = sessionKey(session),
      appearance?: AvatarOverride
    ) => {
      // Keep inputs, not resolved colours: a folder's override can change while its create waits.
      avatarReservations.current.set(reservationKey, { session, assignment, appearance });
    },
    []
  );

  const saveNewAvatarAssignment = useStableCallback(
    (session: Session, assignment?: AvatarAssignment, appearance?: AvatarOverride) => {
      const key = sessionKey(session);
      if (!competesForIdentity(session) || (settingsRef.current.avatarAssignments[key] && !appearance)) return;
      const chosen = settingsRef.current.avatarAssignments[key] ?? assignment ?? allocateFor(session);
      // Synchronous reservation closes the gap before React renders concurrent create/promote replies.
      reserveIdentity(session, chosen, key, appearance);
      void handleSettings(
        {
          avatarAssignments: { ...settingsRef.current.avatarAssignments, [key]: chosen },
          ...(appearance
            ? { avatarOverrides: withSessionAppearance(session, settingsRef.current.avatarOverrides, appearance) }
            : {}),
        },
        { preserveActionError: true }
      );
    }
  );

  // avatarIdentities keeps stable references, and the fallback is memoized on the key, so this
  // is safe to use directly as an effect dependency.
  const selectedIdentity = React.useMemo(
    () => (selectedKey ? avatarIdentities[selectedKey] ?? seedIdentity(selectedKey) : seedIdentity('')),
    [selectedKey, avatarIdentities]
  );

  // Preview the next distinct automatic identity, then layer explicit folder/project choices over it.
  // Once sent, a draft keeps its reservation instead of changing as other bots arrive.
  const resolveDraftIdentity = React.useMemo(() => {
    // Invalidate the preview when its competition changes, but do no allocation until a draft
    // actually renders. Ordinary session polls need not score colours and shapes.
    void occupiedIdentities;
    void pendingCreates;
    void settings.blobStyle;
    return (instanceId: string, directory: string, appearance?: DraftAppearance | null): AvatarIdentity => {
      const session = { id: `draft:${instanceId}`, instanceId, directory };
      return resolveAvatarIdentity(
        session,
        projectsByInstance[instanceId] ?? [],
        settings.scheduledSessionBindings,
        withSessionAppearance(session, settings.avatarOverrides, appearance?.override),
        appearance?.assignment ?? pendingAvatars.current.get(draftPendingId ?? '') ?? allocateFor(session)
      );
    };
  }, [
    projectsByInstance,
    settings.scheduledSessionBindings,
    settings.avatarOverrides,
    settings.blobStyle,
    draftPendingId,
    occupiedIdentities,
    pendingCreates,
    allocateFor,
  ]);

  const avatarPickerIdentity = avatarPickerSession
    ? avatarIdentities[sessionKey(avatarPickerSession)] ??
      resolveAvatarIdentity(
        avatarPickerSession,
        projectsByInstance[avatarPickerSession.instanceId] ?? [],
        settings.scheduledSessionBindings,
        settings.avatarOverrides,
        settings.avatarAssignments[sessionKey(avatarPickerSession)]
      )
    : seedIdentity('');
  const avatarPickerProject = avatarPickerSession
    ? projectForSession(avatarPickerSession, projectsByInstance[avatarPickerSession.instanceId] ?? [])
    : null;
  // Appearance belongs to the project/folder, so that scope comes first and is the picker's
  // default; the scheduled-task and single-session scopes stay available underneath it.
  const avatarPickerFolderName = avatarPickerSession?.directory
    ? avatarPickerSession.directory.split(/[\\/]/).filter(Boolean).pop() ?? avatarPickerSession.directory
    : null;
  const avatarPickerScopes = avatarPickerSession
    ? [
        { key: sessionAvatarKey(avatarPickerSession), kind: 'session' as const, label: 'This session' },
        ...(avatarPickerIdentity.projectKey
          ? [
              {
                key: avatarPickerIdentity.projectKey,
                kind: 'project' as const,
                label: avatarPickerProject ? `Project: ${avatarPickerProject.name}` : `Folder: ${avatarPickerFolderName}`,
              },
            ]
          : []),
        ...(avatarPickerIdentity.taskKey
          ? [
              {
                key: avatarPickerIdentity.taskKey,
                kind: 'task' as const,
                label: `Scheduled task: ${scheduledTaskNames[avatarPickerIdentity.taskKey] ?? 'this task'}`,
              },
            ]
          : []),
      ]
    : [];

  const handleAvatarOverride = React.useCallback(
    (scopeKey: string, override: AvatarOverride | null) => {
      const next = { ...settings.avatarOverrides };
      if (override) next[scopeKey] = override;
      else delete next[scopeKey];
      void handleSettings({ avatarOverrides: next });
    },
    [handleSettings, settings.avatarOverrides]
  );

  React.useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // The app icon mirrors the selected session's blob (and its mood) so a glance at the Dock -- or,
  // on Windows, the taskbar -- says which agent this window is on. Theme is a dependency because the
  // tile and the contrast-adjusted palettes come from the current CSS variables.
  const selectedMood: BallMood = selectedKey ? moods[selectedKey] ?? 'unknown' : 'idle';
  const dockMood = dockIconMood(selectedMood);
  React.useEffect(() => {
    // No `selectedKey` guard: the icon should be the blob from launch, not only once a session is
    // chosen. With nothing selected it simply mirrors the idle mood.
    // Gate on `capabilities.dockIcon` when the bridge reports capabilities so clients without dock
    // support (`?noDock` or web remote) never load the dock renderer.
    if (!window.ember.setAppIcon || window.ember.capabilities?.dockIcon === false) return;
    let cancelled = false;
    // The attempt goes in the log too: without it, "no line" cannot be told apart from "the effect
    // never ran", and that is the difference between a broken render and a stale build.
    void window.ember.reportAppIconIssue?.(
      `attempt blob=${settings.blobStyle} mood=${dockMood} key=${selectedKey ?? '-'}`
    );
    void import('../blob/dockIcon')
      .then(({ renderDockIcon }) =>
        cancelled ? undefined : renderDockIcon(settings.blobStyle, selectedIdentity, dockMood)
      )
      .then((dataUrl) => {
        if (cancelled) {
          void window.ember.reportAppIconIssue?.('cancelled before the icon was rendered');
          return undefined;
        }
        if (!dataUrl) {
          void window.ember.reportAppIconIssue?.('the rasteriser returned nothing');
          return undefined;
        }
        return window.ember.setAppIcon(dataUrl).then((result) => {
          // A refused icon is silent otherwise, and "the icon is wrong" is impossible to diagnose
          // from the outside. One line names the reason.
          if (result && !result.ok) console.warn('App icon not applied:', result.reason ?? 'unknown');
        });
      })
      .catch((err: unknown) => {
        console.warn('App icon render failed', err);
        void window.ember.reportAppIconIssue?.(`render failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, selectedIdentity, dockMood, settings.blobStyle, settings.theme]);

  return {
    pendingAvatars,
    avatarReservations,
    crewAppearance,
    moods,
    avatarIdentities,
    allocationPalette,
    occupiedIdentities,
    allocateFor,
    reserveIdentity,
    saveNewAvatarAssignment,
    selectedIdentity,
    resolveDraftIdentity,
    selectedMood,
    avatarPickerIdentity,
    avatarPickerScopes,
    handleAvatarOverride,
  };
}
