import * as React from 'react';
import type { ModelList } from '../api';
import { resolveAvatarIdentity } from '../blob/seed';
import { effectiveBlobStyle } from '../blob/styles';
import ArchiveSessionDialog from '../components/ArchiveSessionDialog';
import PromoteWorkerDialog from '../components/PromoteWorkerDialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { useActiveDocumentPreview } from '../lib/documentExploration';
import type { ViewerImage } from '../lib/gallery';
import { effectiveInstanceDefaultModel } from '../lib/instanceDefaultModel';
import type { OnboardingState } from '../lib/onboarding';
import type { ProjectUsage } from '../lib/projectUsage';
import { scheduledModelConfirmLabel, type ScheduledModelTarget } from '../lib/scheduledView';
import type { SettingsView } from '../lib/settingsNavigation';
import { modelRefKey, sessionKey } from '../types';
import type {
  AvatarIdentity,
  AvatarOverride,
  BallMood,
  BallState,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  ModelRef,
  Project,
  Session,
  SessionRef,
} from '../types';
import { SessionColumn, type SessionColumnSharedProps } from './SessionColumn';

const SettingsPanel = React.lazy(() => import('../components/SettingsPanel'));
const OnboardingWizard = React.lazy(() => import('../components/OnboardingWizard'));
export const ModelUsagePanel = React.lazy(() => import('../components/ModelUsagePanel'));
export const ScheduledView = React.lazy(() => import('../components/ScheduledView'));
const AvatarPicker = React.lazy(() => import('../components/AvatarPicker'));
const CommandPalette = React.lazy(() => import('../components/CommandPalette'));
const ArchiveDialog = React.lazy(() => import('../components/ArchiveDialog'));
const ImageViewer = React.lazy(() => import('../components/ImageViewer'));
const ModelPicker = React.lazy(() => import('../components/ModelPicker'));

const DialogFallback = ({ label }: { label: string }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="status">
    <span className="rounded-lg border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
      {label}
    </span>
  </div>
);

type AvatarPickerScope = { key: string; label: string; kind: 'project' | 'task' | 'session' };

type AppDialogsProps = {
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  historyIncomplete: Record<string, boolean>;
  loadingHistory: boolean;
  setLoadingHistory: React.Dispatch<React.SetStateAction<boolean>>;
  readyIds: string[];
  refreshSessions: (instanceIds: string[], deep?: boolean) => Promise<void>;
  allSessions: Session[];
  states: Record<string, BallState>;
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  settings: EmberSettings;
  handleRestoreAndOpen: (session: Session) => Promise<void>;
  openSession: (ref: SessionRef, known?: Session | null) => void;
  beginNewAgent: (instanceId: string, directory?: string) => void;
  setMobileRailOpen: React.Dispatch<React.SetStateAction<boolean>>;

  archiveConfirmSession: Session | null;
  archiveConfirmKey: string | null;
  setArchiveConfirmKey: React.Dispatch<React.SetStateAction<string | null>>;
  crewWorkers: Map<string, Session[]>;
  moods: Record<string, BallMood>;
  handleArchive: (session: Session, archived: boolean) => Promise<unknown>;

  threadModalKey: string | null;
  setThreadModalKey: React.Dispatch<React.SetStateAction<string | null>>;
  navigateWithAnnotations: (action: () => void) => void;
  threadReturnFocusRef: React.RefObject<{ element: HTMLElement; workspaceKey: string | null } | null>;
  activeSessionRef: React.RefObject<string | null>;
  inspectedThread: Session | undefined;
  columnSharedProps: SessionColumnSharedProps;

  promoteTarget: Session | null;
  statesAnswered: Set<string>;
  statesByInstance: Record<string, Record<string, BallState>>;
  promoteSubmitting: boolean;
  promoteError: string | null;
  closePromoteDialog: () => void;
  handlePromoteWorker: (worker: Session, input: { name: string; description?: string; pinned: boolean }) => Promise<void>;

  archiveOpen: boolean;
  setArchiveOpen: React.Dispatch<React.SetStateAction<boolean>>;
  archivedSessions: Session[];
  previews: Record<string, string>;
  avatarIdentities: Record<string, AvatarIdentity>;
  reloadingKeys: Set<string>;
  archivingKeys: Set<string>;
  handleReloadSession: (session: Session) => Promise<void>;
  setAvatarPickerSession: React.Dispatch<React.SetStateAction<Session | null>>;

  settingsActivated: boolean;
  settingsOpen: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settingsView: SettingsView;
  setSettingsView: React.Dispatch<React.SetStateAction<SettingsView>>;
  providerEndpointId: string | undefined;
  setProviderEndpointId: React.Dispatch<React.SetStateAction<string | undefined>>;
  modelsByInstance: Record<string, ModelList>;
  recentModelsByInstance: Record<string, string[]>;
  projectUsageByInstance: Record<string, ProjectUsage[]>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  refreshInstances: (purpose?: 'versions') => Promise<void>;
  refreshModels: (instanceId: string, options?: { upstream?: boolean; providers?: readonly string[] }) => Promise<void>;

  onboardingOpen: boolean;
  onboardingState: OnboardingState;
  onboardingProblem: string | null;
  dismissOnboarding: () => void;
  refreshHarnessSettings: () => Promise<EmberSettings>;
  showActionError: (message: string | null, retry?: () => void, retryLabel?: string, onDismiss?: () => void) => void;

  avatarPickerSession: Session | null;
  avatarPickerIdentity: AvatarIdentity;
  avatarPickerScopes: AvatarPickerScope[];
  handleAvatarOverride: (scopeKey: string, override: AvatarOverride | null) => void;

  scheduledModelTarget: ScheduledModelTarget | null;
  setScheduledModelTarget: React.Dispatch<React.SetStateAction<ScheduledModelTarget | null>>;
  setInstanceDefaultModel: (instanceId: string, model: ModelRef) => void;
  handleScheduledModelSelect: (target: ScheduledModelTarget, key: string, variant: string) => Promise<void>;
};

/**
 * Houses all lazy-loaded dialogs, confirmation prompts, and the worker thread inspection modal.
 */
const LazyDocumentPreviewDialogHost = React.lazy(() =>
  import('../components/DocumentPreviewDialog').then((mod) => ({ default: mod.DocumentPreviewDialogHost }))
);

function LazyDocumentPreviewMount() {
  const active = useActiveDocumentPreview();
  if (!active) return null;
  return (
    <React.Suspense fallback={null}>
      <LazyDocumentPreviewDialogHost />
    </React.Suspense>
  );
}

export function AppDialogs({
  commandPaletteOpen,
  setCommandPaletteOpen,
  historyIncomplete,
  loadingHistory,
  setLoadingHistory,
  readyIds,
  refreshSessions,
  allSessions,
  states,
  instances,
  projectsByInstance,
  settings,
  handleRestoreAndOpen,
  openSession,
  beginNewAgent,
  setMobileRailOpen,
  archiveConfirmSession,
  archiveConfirmKey,
  setArchiveConfirmKey,
  crewWorkers,
  moods,
  handleArchive,
  threadModalKey,
  setThreadModalKey,
  navigateWithAnnotations,
  threadReturnFocusRef,
  activeSessionRef,
  inspectedThread,
  columnSharedProps,
  promoteTarget,
  statesAnswered,
  statesByInstance,
  promoteSubmitting,
  promoteError,
  closePromoteDialog,
  handlePromoteWorker,
  archiveOpen,
  setArchiveOpen,
  archivedSessions,
  previews,
  avatarIdentities,
  reloadingKeys,
  archivingKeys,
  handleReloadSession,
  setAvatarPickerSession,
  settingsActivated,
  settingsOpen,
  setSettingsOpen,
  settingsView,
  setSettingsView,
  providerEndpointId,
  setProviderEndpointId,
  modelsByInstance,
  recentModelsByInstance,
  projectUsageByInstance,
  handleSettings,
  refreshInstances,
  refreshModels,
  onboardingOpen,
  onboardingState,
  onboardingProblem,
  dismissOnboarding,
  refreshHarnessSettings,
  showActionError,
  avatarPickerSession,
  avatarPickerIdentity,
  avatarPickerScopes,
  handleAvatarOverride,
  scheduledModelTarget,
  setScheduledModelTarget,
  setInstanceDefaultModel,
  handleScheduledModelSelect,
}: AppDialogsProps) {
  return (
    <>
      <React.Suspense fallback={null}>
        <CommandPalette
          open={commandPaletteOpen}
          historyIncomplete={Object.values(historyIncomplete).some(Boolean)}
          loadingHistory={loadingHistory}
          onLoadHistory={() => {
            setLoadingHistory(true);
            void refreshSessions(readyIds, true).finally(() => setLoadingHistory(false));
          }}
          sessions={allSessions}
          states={states}
          instances={instances}
          projectsByInstance={projectsByInstance}
          sessionNotes={settings.sessionNotes}
          onOpenChange={setCommandPaletteOpen}
          onSelectSession={(session) => {
            if (session.archived) void handleRestoreAndOpen(session);
            else openSession({ instanceId: session.instanceId, sessionId: session.id }, session);
            setMobileRailOpen(false);
          }}
          onNewAgent={(instanceId) => {
            beginNewAgent(instanceId);
            setMobileRailOpen(false);
          }}
        />
      </React.Suspense>

      {archiveConfirmSession ? (
        <ArchiveSessionDialog
          session={archiveConfirmSession}
          crewCount={archiveConfirmKey ? (crewWorkers.get(archiveConfirmKey) ?? []).length : 0}
          statusUnknown={archiveConfirmKey ? moods[archiveConfirmKey] === 'unknown' : false}
          instanceLabel={instances.find((entry) => entry.id === archiveConfirmSession.instanceId)?.label}
          onCancel={() => setArchiveConfirmKey(null)}
          onConfirm={() => {
            const confirmed = archiveConfirmSession;
            setArchiveConfirmKey(null);
            void handleArchive(confirmed, true);
          }}
        />
      ) : null}

      {threadModalKey ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) navigateWithAnnotations(() => setThreadModalKey(null));
          }}
        >
          <DialogContent
            className="flex h-[calc(100dvh-1rem)] max-h-[900px] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[min(90dvh,900px)] sm:w-[min(1200px,94vw)] sm:max-w-[1200px]"
            data-testid="thread-session-modal"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = threadReturnFocusRef.current;
              // Promotion deliberately navigates away; never focus the outgoing workspace then.
              if (target?.element.isConnected && target.workspaceKey === activeSessionRef.current) {
                target.element.focus();
              }
              threadReturnFocusRef.current = null;
            }}
          >
            <div className="flex-none border-b px-4 py-3 pr-12">
              <DialogTitle className="text-sm">Thread · {inspectedThread?.title || 'Worker'}</DialogTitle>
              <DialogDescription className="sr-only">
                Inspect and reply to this thread. Closing returns to your unchanged workspace.
              </DialogDescription>
            </div>
            {inspectedThread ? (
              <SessionColumn columnKey={threadModalKey} modal {...columnSharedProps} />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                This host no longer lists the thread. Close this window and refresh its leader’s conversation to check again.
              </p>
            )}
          </DialogContent>
        </Dialog>
      ) : null}

      {promoteTarget ? (
        <PromoteWorkerDialog
          key={sessionKey(promoteTarget)}
          worker={promoteTarget}
          busy={
            // Use Kiln's run state: a descendant's question can overlay a running
            // worker's display mood with `needs-input` without ending its turn.
            statesAnswered.has(promoteTarget.instanceId) &&
            statesByInstance[promoteTarget.instanceId]?.[sessionKey(promoteTarget)] === 'active'
          }
          submitting={promoteSubmitting}
          error={promoteError}
          instanceLabel={instances.find((entry) => entry.id === promoteTarget.instanceId)?.label}
          onCancel={closePromoteDialog}
          onConfirm={(input) => {
            void handlePromoteWorker(promoteTarget, input);
          }}
        />
      ) : null}

      {archiveOpen ? (
        <React.Suspense fallback={<DialogFallback label="Loading hidden sessions…" />}>
          <ArchiveDialog
            open
            onOpenChange={setArchiveOpen}
            sessions={archivedSessions}
            projectsByInstance={projectsByInstance}
            instances={instances}
            moods={moods}
            previews={previews}
            avatarIdentities={avatarIdentities}
            blobStyle={effectiveBlobStyle(settings.blobStyle)}
            instanceDefaults={settings.instanceDefaults}
            reloadingKeys={reloadingKeys}
            archivingKeys={archivingKeys}
            onRestoreSession={(session) => void handleRestoreAndOpen(session)}
            onReload={(session) => void handleReloadSession(session)}
            onArchive={(session, archived) => void handleArchive(session, archived)}
            onCustomizeAppearance={setAvatarPickerSession}
          />
        </React.Suspense>
      ) : null}

      {settingsActivated ? (
        <React.Suspense fallback={<DialogFallback label="Loading settings…" />}>
          <SettingsPanel
            open={settingsOpen}
            view={settingsView}
            settings={settings}
            instances={instances}
            projectsByInstance={projectsByInstance}
            modelsByInstance={modelsByInstance}
            recentModelsByInstance={recentModelsByInstance}
            projectUsageByInstance={projectUsageByInstance}
            onChange={handleSettings}
            onOpenChange={setSettingsOpen}
            onViewChange={(next) => {
              // Leaving the Providers screen clears the host it was opened for, so a later open
              // from Settings → Instances does not silently configure the last session's host.
              if (next !== 'providers') setProviderEndpointId(undefined);
              setSettingsView(next);
            }}
            {...(providerEndpointId ? { providerEndpointId } : {})}
            onRefreshInstances={(purpose) => void refreshInstances(purpose)}
            onRefreshModels={(id, options) => refreshModels(id, { upstream: true, ...options })}
          />
        </React.Suspense>
      ) : null}

      {onboardingOpen ? (
        <React.Suspense fallback={null}>
          <OnboardingWizard
            instanceDefaults={settings.instanceDefaults}
            open={onboardingOpen}
            startAtWelcome={Boolean(settings.onboardingStartedAt)}
            state={onboardingState}
            projectUsageByInstance={projectUsageByInstance}
            models={modelsByInstance[onboardingState.targetInstanceId ?? '']?.models ?? []}
            onRefreshModels={(id, options) => void refreshModels(id, { upstream: true, ...options })}
            localProblem={onboardingProblem}
            instances={instances}
            endpoints={settings.piEndpoints}
            onDismiss={dismissOnboarding}
            onRetryLocal={async () => {
              try {
                await window.ember.retryLocalHarness?.();
                await refreshInstances();
                const stored = await refreshHarnessSettings();
                if (stored.localHarnessState?.notice) showActionError(stored.localHarnessState.notice);
              } catch {
                showActionError('Ember could not retry Kiln. Reopen the setup guide and select Retry again.');
              }
            }}
            onRefreshInstances={() => void refreshInstances()}
            onChange={handleSettings}
            onStartAgent={({ instanceId, directory }) => {
              void handleSettings({ onboardingDismissedAt: Date.now() }, { preserveActionError: true });
              beginNewAgent(instanceId, directory ?? undefined);
            }}
            {...(window.ember.localHarnessToken ? { loadToken: window.ember.localHarnessToken } : {})}
          />
        </React.Suspense>
      ) : null}

      {avatarPickerSession ? (
        <React.Suspense fallback={<DialogFallback label="Loading appearance…" />}>
          <AvatarPicker
            open
            title={avatarPickerSession.title ?? avatarPickerSession.id}
            style={effectiveBlobStyle(settings.blobStyle)}
            theme={settings.theme}
            resolvePreview={(scopeKey, override) =>
              resolveAvatarIdentity(
                avatarPickerSession,
                projectsByInstance[avatarPickerSession.instanceId] ?? [],
                settings.scheduledSessionBindings,
                { ...settings.avatarOverrides, [scopeKey]: override },
                settings.avatarAssignments[sessionKey(avatarPickerSession)]
              )
            }
            identity={avatarPickerIdentity}
            scopes={avatarPickerScopes}
            overrides={settings.avatarOverrides}
            onSave={handleAvatarOverride}
            onOpenChange={(open) => {
              if (!open) setAvatarPickerSession(null);
            }}
          />
        </React.Suspense>
      ) : null}

      {scheduledModelTarget ? (
        <React.Suspense fallback={null}>
          <ModelPicker
            open
            models={modelsByInstance[scheduledModelTarget.task.instanceId]?.models ?? []}
            recentModels={recentModelsByInstance[scheduledModelTarget.task.instanceId] ?? []}
            value={scheduledModelTarget.task.model ? modelRefKey(scheduledModelTarget.task.model) : ''}
            variant={scheduledModelTarget.task.model?.variant ?? ''}
            defaultModelId={modelsByInstance[scheduledModelTarget.task.instanceId]?.defaultModelId ?? null}
            instanceDefaultModelId={effectiveInstanceDefaultModel(
              settings.instanceDefaults[scheduledModelTarget.task.instanceId],
              modelsByInstance[scheduledModelTarget.task.instanceId]?.defaultModelId
            )}
            onSetInstanceDefault={(model) => setInstanceDefaultModel(scheduledModelTarget.task.instanceId, model)}
            collapseProviders
            onRefresh={() => refreshModels(scheduledModelTarget.task.instanceId, { upstream: true })}
            confirmLabel={scheduledModelConfirmLabel(scheduledModelTarget.runImmediately)}
            onSelect={(key, variant) => void handleScheduledModelSelect(scheduledModelTarget, key, variant)}
            onOpenChange={(open) => {
              if (!open) setScheduledModelTarget(null);
            }}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}

/**
 * Root-level lightbox and document preview hosts mounted outside MotionConfig/TooltipProvider.
 */
export function AppRootOverlays({
  imageViewer,
  setImageViewer,
}: {
  imageViewer: { images: ViewerImage[]; index: number } | null;
  setImageViewer: React.Dispatch<React.SetStateAction<{ images: ViewerImage[]; index: number } | null>>;
}) {
  return (
    <>
      {imageViewer ? (
        <React.Suspense fallback={null}>
          <ImageViewer
            images={imageViewer.images}
            index={imageViewer.index}
            onIndex={(index) => setImageViewer((current) => (current ? { ...current, index } : current))}
            onClose={() => setImageViewer(null)}
          />
        </React.Suspense>
      ) : null}
      <LazyDocumentPreviewMount />
    </>
  );
}
