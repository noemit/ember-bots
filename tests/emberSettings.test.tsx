import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { DEFAULT_SETTINGS, useEmberSettings } from '../src/hooks/useEmberSettings';
import { useFeedback } from '../src/hooks/useFeedback';
import { mergeDraftChanges } from '../src/lib/composerDrafts';
import type { EmberSettings, EmberSettingsPatch } from '../src/types';
import { withTestRoot } from './fixtures/reactRoot';

describe('useEmberSettings concurrency and ref consistency', () => {
  test('refreshHarnessSettings updates settingsRef.current immediately before subsequent optimistic writes', async () => {
    await withTestRoot(async ({ render, act, window: win }) => {
      let storedState: EmberSettings = {
        ...DEFAULT_SETTINGS,
        localHarnessState: { status: 'ready', url: 'http://127.0.0.1:4312' },
        localHarnessCanRotate: true,
      };
      win.ember = {
        getSettings: async () => storedState,
        setSettings: async (patch: EmberSettingsPatch) => {
          const { composerDraftChanges, ...rest } = patch;
          storedState = {
            ...storedState,
            ...rest,
            ...(composerDraftChanges
              ? { composerDrafts: mergeDraftChanges(storedState.composerDrafts, composerDraftChanges) }
              : {}),
          };
          return storedState;
        },
      };

      let hook!: ReturnType<typeof useEmberSettings>;
      function Harness() {
        hook = useEmberSettings({ onError: () => {}, onBeforeSave: () => {} });
        return null;
      }
      await render(React.createElement(Harness));
      await act(() => {
        hook.hydrateSettings(DEFAULT_SETTINGS);
      });

      let immediateRefSnapshot: EmberSettings | undefined;
      await act(async () => {
        await hook.refreshHarnessSettings();
        // Read settingsRef.current synchronously right after await before another render tick.
        immediateRefSnapshot = hook.settingsRef.current;
        void hook.updateSettings({ splitView: true });
      });

      expect(immediateRefSnapshot?.localHarnessState).toEqual({
        status: 'ready',
        url: 'http://127.0.0.1:4312',
      });
      expect(immediateRefSnapshot?.localHarnessCanRotate).toBe(true);
      expect(hook.settingsRef.current.localHarnessState).toEqual({
        status: 'ready',
        url: 'http://127.0.0.1:4312',
      });
      expect(hook.settingsRef.current.localHarnessCanRotate).toBe(true);
      expect(hook.settings.splitView).toBe(true);
    });
  });

  test('hydrateSettings does not clobber newer optimistic updates when revisionRef.current > 0', async () => {
    // Case 1: Optimistic write is still in flight when initial getSettings hydrates.
    await withTestRoot(async ({ render, act, window: win }) => {
      let resolveSave!: (stored: EmberSettings) => void;
      win.ember = {
        getSettings: async () => DEFAULT_SETTINGS,
        setSettings: () =>
          new Promise<EmberSettings>((resolve) => {
            resolveSave = resolve;
          }),
      };

      let hook!: ReturnType<typeof useEmberSettings>;
      function Harness() {
        hook = useEmberSettings({ onError: () => {}, onBeforeSave: () => {} });
        return null;
      }
      await render(React.createElement(Harness));

      await act(() => {
        void hook.updateSettings({
          theme: 'clay',
          composerDraftChanges: { s1: { text: 'optimistic draft', updatedAt: 50 } },
        });
      });
      expect(hook.settings.theme).toBe('clay');

      // Late initial hydration carries stale theme/drafts plus untouched stored fields.
      await act(() => {
        hook.hydrateSettings({
          theme: 'ink',
          compactRail: true,
          readSince: 1_700_000_000,
          composerDrafts: { s1: { text: 'stale disk draft', updatedAt: 10 } },
        });
      });

      expect(hook.settingsLoaded).toBe(true);
      expect(hook.settings.theme).toBe('clay');
      expect(hook.settingsRef.current.theme).toBe('clay');
      expect(hook.settings.composerDrafts.s1?.text).toBe('optimistic draft');
      expect(hook.settings.compactRail).toBe(true);
      expect(hook.settings.readSince).toBe(1_700_000_000);

      await act(async () => {
        resolveSave({
          ...DEFAULT_SETTINGS,
          theme: 'clay',
          compactRail: true,
          readSince: 1_700_000_000,
          composerDrafts: { s1: { text: 'optimistic draft', updatedAt: 50 } },
        });
      });
      expect(hook.settings.theme).toBe('clay');
    });

    // Case 2: Optimistic write already settled on main before late initial hydrateSettings arrives.
    await withTestRoot(async ({ render, act, window: win }) => {
      win.ember = {
        getSettings: async () => DEFAULT_SETTINGS,
        setSettings: async (patch: EmberSettingsPatch) => ({
          ...DEFAULT_SETTINGS,
          theme: patch.theme ?? DEFAULT_SETTINGS.theme,
          compactRail: true,
        }),
      };

      let hook!: ReturnType<typeof useEmberSettings>;
      function Harness() {
        hook = useEmberSettings({ onError: () => {}, onBeforeSave: () => {} });
        return null;
      }
      await render(React.createElement(Harness));

      await act(async () => {
        await hook.updateSettings({ theme: 'stone' });
      });
      expect(hook.settings.theme).toBe('stone');

      await act(() => {
        hook.hydrateSettings({ theme: 'ink', compactRail: false });
      });
      expect(hook.settingsLoaded).toBe(true);
      expect(hook.settings.theme).toBe('stone');
      expect(hook.settingsRef.current.theme).toBe('stone');
      expect(hook.settings.compactRail).toBe(true);
    });
  });

  test('failed draft writes are cleaned up when dismissed or superseded so they do not shadow future stored settings forever', async () => {
    // 1. Dismissing the error banner (via useFeedback showActionError(null)) cleans up failed pendingDraftsRef entries.
    await withTestRoot(async ({ render, act, window: win }) => {
      let failDraftWrite = true;
      let storedOnDisk: EmberSettings = {
        ...DEFAULT_SETTINGS,
        composerDrafts: { s1: { text: 'stored on disk', updatedAt: 10 } },
      };
      win.ember = {
        getSettings: async () => storedOnDisk,
        setSettings: async (patch: EmberSettingsPatch) => {
          if (patch.composerDraftChanges && failDraftWrite) {
            throw new Error('Disk temporarily full');
          }
          const { composerDraftChanges, ...rest } = patch;
          storedOnDisk = {
            ...storedOnDisk,
            ...rest,
            ...(composerDraftChanges
              ? { composerDrafts: mergeDraftChanges(storedOnDisk.composerDrafts, composerDraftChanges) }
              : {}),
          };
          return storedOnDisk;
        },
      };

      let settingsHook!: ReturnType<typeof useEmberSettings>;
      let feedbackHook!: ReturnType<typeof useFeedback>;
      function Harness() {
        feedbackHook = useFeedback();
        const showError = feedbackHook.showActionError;
        const clearError = React.useCallback(() => showError(null), [showError]);
        const onError = React.useCallback(
          (message: string, retry: () => void, onDismiss?: () => void) => {
            showError(message, retry, undefined, onDismiss);
          },
          [showError]
        );
        settingsHook = useEmberSettings({ onError, onBeforeSave: clearError });
        return null;
      }
      await render(React.createElement(Harness));

      await act(() => {
        settingsHook.hydrateSettings(storedOnDisk);
      });
      expect(settingsHook.settings.composerDrafts.s1?.text).toBe('stored on disk');

      // Draft write fails.
      await act(async () => {
        await settingsHook
          .updateSettings(
            { composerDraftChanges: { s1: { text: 'failed draft', updatedAt: 20 } } },
            { preserveActionError: true }
          )
          .catch(() => {});
      });
      expect(feedbackHook.actionError).toBe('Disk temporarily full');

      // Dismiss the error banner.
      await act(() => {
        feedbackHook.showActionError(null);
      });
      expect(feedbackHook.actionError).toBeNull();

      // Now a subsequent save (even with preserveActionError: true) returns storedOnDisk;
      // the dismissed failed draft must NOT shadow storedOnDisk.composerDrafts.s1!
      failDraftWrite = false;
      await act(async () => {
        await settingsHook.updateSettings(
          { composerDraftChanges: { s2: { text: 'other chat', updatedAt: 30 } } },
          { preserveActionError: true }
        );
      });
      expect(settingsHook.settings.composerDrafts.s1?.text).toBe('stored on disk');
      expect(settingsHook.settings.composerDrafts.s2?.text).toBe('other chat');
    });

    // 2. Superseding a failed draft by a subsequent non-preserving settings save (or retry) cleans up pendingDraftsRef.
    await withTestRoot(async ({ render, act, window: win }) => {
      let failDraftWrite = true;
      let storedOnDisk: EmberSettings = {
        ...DEFAULT_SETTINGS,
        composerDrafts: { s1: { text: 'disk baseline', updatedAt: 5 } },
      };
      win.ember = {
        getSettings: async () => storedOnDisk,
        setSettings: async (patch: EmberSettingsPatch) => {
          if (patch.composerDraftChanges && failDraftWrite) {
            throw new Error('Write rejected');
          }
          const { composerDraftChanges, ...rest } = patch;
          storedOnDisk = {
            ...storedOnDisk,
            ...rest,
            ...(composerDraftChanges
              ? { composerDrafts: mergeDraftChanges(storedOnDisk.composerDrafts, composerDraftChanges) }
              : {}),
          };
          return storedOnDisk;
        },
      };

      let lastRetry: (() => void) | null = null;
      let settingsHook!: ReturnType<typeof useEmberSettings>;
      function Harness() {
        settingsHook = useEmberSettings({
          onError: (_msg, retry) => {
            lastRetry = retry;
          },
          onBeforeSave: () => {
            lastRetry = null;
          },
        });
        return null;
      }
      await render(React.createElement(Harness));
      await act(() => {
        settingsHook.hydrateSettings(storedOnDisk);
      });

      // Fail a draft write, then Retry it once disk recovers -> retry succeeds and clears pendingDraftsRef.
      await act(async () => {
        await settingsHook
          .updateSettings(
            { composerDraftChanges: { s1: { text: 'retried draft', updatedAt: 15 } } },
            { preserveActionError: true }
          )
          .catch(() => {});
      });
      expect(lastRetry).not.toBeNull();
      failDraftWrite = false;
      await act(async () => {
        lastRetry!();
      });
      expect(settingsHook.settings.composerDrafts.s1?.text).toBe('retried draft');

      // Fail another draft write, then supersede it with an ordinary preference save instead of retrying.
      failDraftWrite = true;
      await act(async () => {
        await settingsHook
          .updateSettings(
            { composerDraftChanges: { s1: { text: 'abandoned draft', updatedAt: 25 } } },
            { preserveActionError: true }
          )
          .catch(() => {});
      });
      await act(async () => {
        await settingsHook.updateSettings({ compactSpacing: true });
      });
      expect(settingsHook.settings.compactSpacing).toBe(true);
      expect(settingsHook.settings.composerDrafts.s1?.text).toBe('retried draft');
    });
  });
});
