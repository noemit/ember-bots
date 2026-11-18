import { isRemoteBrowser } from '../lib/remoteLifecycle';
import * as React from 'react';
import { DEFAULT_THEME_ID } from '../themes';
import type { TextSize } from '../lib/textSize';
import type { EmberSettings, EmberSettingsPatch } from '../types';
import { mergeDraftChanges } from '../lib/composerDrafts';
import { AvatarAssignmentWrites } from './avatarAssignmentWrites';

export const DEFAULT_SETTINGS: EmberSettings = {
  theme: DEFAULT_THEME_ID,
  blobStyle: 'buddy',
  blobSize: 'standard',
  conversationFontSize: 14,
  composerSize: 'medium' as TextSize,
  interfaceSize: 'medium' as TextSize,
  sessionWindowHours: 48,
  hiddenInstances: [],
  dismissedOutages: [],
  hideToolCalls: false,
  reasoningDisplay: 'collapsed',
  showQuestions: true,
  expandToolCalls: false,
  // The fold is something a reader opts into: the list is what the transcript has always drawn.
  toolDisplay: 'collapsed',
  showMessageDetails: true,
  showAvatars: true,
  showActivityRail: true,
  sessionGroups: [],
  compactSpacing: false,
  compactRail: false,
  railMode: 'normal' as const,
  autoFollow: true,
  splitView: false,
  instanceDefaults: {},
  delegatorModels: {},
  sessionNotes: {},
  quoteLinks: [],
  readMarks: {},
  composerDrafts: {},
  scheduledSessionBindings: {},
  autoArchiveScheduledRuns: true,
  avatarOverrides: {},
  avatarAssignments: {},
  projectColorAssignments: {},
  openSessions: [],
  activeSession: null,
  minimizedSessions: [],
  snoozedSessions: [],
  piEndpoints: [],
  remoteAccessEnabled: false,
  remotePasswordConfigured: false,
  remoteAccessState: { status: 'off', attempts: 0, changedAt: 0 },
  settingsRecovered: false,
  onboardingDismissedAt: undefined as number | undefined,
  onboardedAt: undefined as number | undefined,
};

type PendingDraftEntry = {
  revision: number;
  value: import('../lib/composerDrafts').DraftChanges[string];
  failed?: boolean;
};

type Options = {
  /** Surfaces save failures; `retry` re-applies the same patch, `onDismiss` cleans up abandoned state. */
  onError: (message: string, retry: () => void, onDismiss?: () => void) => void;
  /** Called before a save so a stale error banner from an earlier action goes away. */
  onBeforeSave: () => void;
};

/**
 * Settings persisted by the main process. Writes are optimistic: the patch is applied
 * locally, sent to main, and then replaced by whatever main validated and stored. A revision
 * counter drops responses from saves that a newer patch has already superseded.
 */
export const useEmberSettings = ({ onError, onBeforeSave }: Options) => {
  const [settings, setSettings] = React.useState<EmberSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = React.useState(false);
  const revisionRef = React.useRef(0);
  const settledRevisionRef = React.useRef(0);
  const optimisticValuesRef = React.useRef<Partial<EmberSettings>>({});
  const assignmentWritesRef = React.useRef(new AvatarAssignmentWrites());
  const writesRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const pendingDraftsRef = React.useRef(new Map<string, PendingDraftEntry>());
  const hydratedRef = React.useRef(false);
  const pendingHarnessRefreshRef = React.useRef(false);
  // Live copy for callbacks that must read the latest value without re-subscribing.
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  const dismissFailedDrafts = React.useCallback(() => {
    for (const [key, entry] of pendingDraftsRef.current) {
      if (entry.failed) pendingDraftsRef.current.delete(key);
    }
  }, []);

  const refreshHarnessSettings = React.useCallback(async () => {
    if (!window.ember?.getSettings) return settingsRef.current;
    const startRevision = revisionRef.current;
    const wasHydrated = hydratedRef.current;
    const stored = await window.ember.getSettings();
    if (!hydratedRef.current) {
      pendingHarnessRefreshRef.current = true;
      return stored;
    }
    const current = settingsRef.current;
    const keepLocalEndpoints = !wasHydrated || revisionRef.current !== startRevision;
    const nextPiEndpoints = keepLocalEndpoints ? current.piEndpoints : stored.piEndpoints;
    const nextOnboardedAt = stored.onboardedAt ?? current.onboardedAt;
    if (
      JSON.stringify(current.piEndpoints) === JSON.stringify(nextPiEndpoints) &&
      JSON.stringify(current.remoteAccessState) === JSON.stringify(stored.remoteAccessState) &&
      JSON.stringify(current.localHarnessState) === JSON.stringify(stored.localHarnessState) &&
      current.localHarnessCanRotate === stored.localHarnessCanRotate &&
      current.onboardedAt === nextOnboardedAt
    ) {
      return stored;
    }
    const next: EmberSettings = {
      ...current,
      piEndpoints: nextPiEndpoints,
      remoteAccessState: stored.remoteAccessState,
      localHarnessState: stored.localHarnessState,
      localHarnessCanRotate: stored.localHarnessCanRotate,
      ...(nextOnboardedAt !== undefined ? { onboardedAt: nextOnboardedAt } : {}),
    };
    settingsRef.current = next;
    setSettings(next);
    return stored;
  }, []);

  const hydrateSettings = React.useCallback((stored: Partial<EmberSettings>) => {
    assignmentWritesRef.current.acknowledge(stored.avatarAssignments);
    if (revisionRef.current > 0) {
      if (settledRevisionRef.current > 0) {
        const next = { ...settingsRef.current, avatarAssignments: assignmentWritesRef.current.visible() };
        settingsRef.current = next;
        setSettings(next);
        setSettingsLoaded(true);
        return;
      }
      const pendingDrafts = Object.fromEntries(
        [...pendingDraftsRef.current].map(([key, entry]) => [key, entry.value])
      );
      const baseDrafts =
        optimisticValuesRef.current.composerDrafts ??
        stored.composerDrafts ??
        DEFAULT_SETTINGS.composerDrafts;
      const next = {
        ...DEFAULT_SETTINGS,
        ...stored,
        ...optimisticValuesRef.current,
        avatarAssignments: assignmentWritesRef.current.visible(),
        composerDrafts: mergeDraftChanges(baseDrafts, pendingDrafts),
      };
      settingsRef.current = next;
      setSettings(next);
      setSettingsLoaded(true);
      return;
    }
    const next = { ...DEFAULT_SETTINGS, ...stored, avatarAssignments: assignmentWritesRef.current.visible() };
    hydratedRef.current = true;
    settingsRef.current = next;
    setSettings(next);
    setSettingsLoaded(true);
    if (pendingHarnessRefreshRef.current) {
      pendingHarnessRefreshRef.current = false;
      void refreshHarnessSettings().catch(() => {});
    }
  }, [refreshHarnessSettings]);

  const markSettingsLoaded = React.useCallback(() => setSettingsLoaded(true), []);

  const updateSettings = React.useCallback(
    function updateSettings(patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) {
      if (!options?.preserveActionError) {
        dismissFailedDrafts();
        onBeforeSave();
      }
      const revision = ++revisionRef.current;
      const { composerDraftChanges, avatarAssignments, ...values } = patch;
      if (values.composerDrafts !== undefined) {
        dismissFailedDrafts();
      }
      optimisticValuesRef.current = { ...optimisticValuesRef.current, ...values };
      const assignments = assignmentWritesRef.current;
      assignments.stage(avatarAssignments);
      for (const [key, value] of Object.entries(composerDraftChanges ?? {})) pendingDraftsRef.current.set(key, { revision, value });
      const pendingDrafts = () => Object.fromEntries([...pendingDraftsRef.current].map(([key, entry]) => [key, entry.value]));
      const adoptStored = (stored: EmberSettings, settledRevision: number) => {
        settledRevisionRef.current = Math.max(settledRevisionRef.current, settledRevision);
        assignments.acknowledge(stored.avatarAssignments);
        for (const [key, entry] of pendingDraftsRef.current) {
          if (!entry.failed) continue;
          const storedDraft = stored.composerDrafts[key];
          if (
            (entry.value === null && storedDraft === undefined) ||
            (entry.value !== null && storedDraft !== undefined && storedDraft.updatedAt >= entry.value.updatedAt)
          ) {
            pendingDraftsRef.current.delete(key);
          }
        }
        const next = { ...DEFAULT_SETTINGS, ...stored, avatarAssignments: assignments.visible(), composerDrafts: mergeDraftChanges(stored.composerDrafts, pendingDrafts()) };
        settingsRef.current = next;
        setSettings(next);
      };
      const next = {
        ...settingsRef.current,
        ...values,
        avatarAssignments: assignments.visible(),
        ...(composerDraftChanges ? { composerDrafts: mergeDraftChanges(settingsRef.current.composerDrafts, composerDraftChanges) } : {}),
      };
      settingsRef.current = next;
      setSettings(next);
      // Browser drafts are intentionally memory-only. Do not turn typing offline into settings
      // requests (or replay those requests when a connection returns). Preference writes remain
      // explicit operations, and responses must not replace these local drafts.
      const memoryOnly = isRemoteBrowser();
      if (memoryOnly && Object.keys(values).length === 0 && !avatarAssignments) return Promise.resolve(next);
      const save = writesRef.current.catch(() => {}).then(() => {
        // Include unacknowledged additions in every write, not just the original allocation.
        // A failed save followed by an unrelated preference change must not lose an identity.
        const additions = assignments.additions();
        return window.ember.setSettings({
          ...values,
          ...(!memoryOnly && composerDraftChanges ? { composerDraftChanges } : {}),
          ...(Object.keys(additions).length ? { avatarAssignments: additions } : {}),
        });
      });
      writesRef.current = save;
      void save
        .then((stored) => {
          assignments.acknowledge(stored.avatarAssignments);
          for (const key of Object.keys(composerDraftChanges ?? {})) {
            if (!memoryOnly && pendingDraftsRef.current.get(key)?.revision === revision) pendingDraftsRef.current.delete(key);
          }
          if (revisionRef.current === revision) adoptStored(stored, revision);
        })
        .catch(async (err) => {
          if (composerDraftChanges) {
            const keys = Object.keys(composerDraftChanges).filter((key) => pendingDraftsRef.current.get(key)?.revision === revision);
            for (const key of keys) {
              const entry = pendingDraftsRef.current.get(key);
              if (entry) pendingDraftsRef.current.set(key, { ...entry, failed: true });
            }
            if (keys.length) onError(
              err instanceof Error ? err.message : 'Could not save drafts.',
              () => {
                const retryChanges = Object.fromEntries(
                  [...pendingDraftsRef.current]
                    .filter(([, entry]) => entry.failed)
                    .map(([key, entry]) => [key, entry.value])
                );
                if (Object.keys(retryChanges).length === 0) {
                  onBeforeSave();
                  return;
                }
                void updateSettings({ composerDraftChanges: retryChanges });
              },
              dismissFailedDrafts
            );
            return;
          }
          if (revisionRef.current !== revision) return;
          dismissFailedDrafts();
          onError(
            err instanceof Error ? err.message : 'Could not save settings.',
            () => updateSettings(patch, options)
          );
          try {
            const stored = await window.ember.getSettings();
            if (revisionRef.current === revision) adoptStored(stored, revision);
          } catch {
            // The save already failed and was reported; keep the optimistic value if we can't re-read.
          }
        });
      return save;
    },
    [onError, onBeforeSave, dismissFailedDrafts]
  );

  return { settings, settingsLoaded, settingsRef, hydrateSettings, refreshHarnessSettings, markSettingsLoaded, updateSettings, dismissFailedDrafts };
};
