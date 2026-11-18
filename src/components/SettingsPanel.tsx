import DesktopUpdates from './DesktopUpdates';
import ContextCompactionSettings from './ContextCompactionSettings';
import type { ProjectUsage } from '../lib/projectUsage';
import { AVATAR_SIZES, avatarPixels } from '../blob/size';
import { effectiveInstanceDefaultModel, withInstanceDefaultModel } from '../lib/instanceDefaultModel';
import * as React from 'react';
import { motion } from 'motion/react';
import { Check, ChevronRight, KeyRound, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import Blob from '../blob/Blob';
import ModelPicker from './ModelPicker';
import EndpointsSettings from './EndpointsSettings';
import KilnSharing from './KilnSharing';
import { SETTINGS_SECTIONS, settingsSection, type SettingsView } from '../lib/settingsNavigation';
import LocalTokenSettings from './LocalTokenSettings';
import ProvidersSettings from './ProvidersSettings';
import { ModelExperienceSettings } from './ModelScorecard';
import { INSTANCE_MARKER_COLORS } from '../blob/contrast';
import { THEME_GROUPS, THEMES } from '../themes';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import SecretInput from '@/components/ui/secret-input';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { DEFAULT_MODEL, modelRefKey, SESSION_WINDOWS } from '../types';
import { providersForPicker } from '../lib/providerPreference';
import { suggestMarkerColor } from '../lib/instanceMarker';
import type { ModelList } from '../api';
import ProjectPicker from './ProjectPicker';
import { ACTIVE_BLOB_STYLES, effectiveBlobStyle } from '../blob/styles';
import {
  CHAT_PX,
  COMPOSER_PX,
  INTERFACE_SCALE,
  TEXT_SIZES,
  composerSizeOf,
  nearestChatSize,
  textSizeLabel,
  type TextSize,
} from '../lib/textSize';
import type { EmberSettings, EmberSettingsPatch, Instance, InstanceDefaults, Project, RemoteAccessState } from '../types';
import { RemoteHttpsSetup } from './RemoteHttpsSetup';

type Props = {
  open: boolean;
  view: SettingsView;
  settings: EmberSettings;
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  projectUsageByInstance?: Record<string, ProjectUsage[]>;
  modelsByInstance: Record<string, ModelList>;
  recentModelsByInstance: Record<string, string[]>;
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: SettingsView) => void;
  /** Reprobe instances after the endpoint list changes, so a new Hearth attaches promptly. */
  onRefreshInstances?: () => void;
  /**
   * Reload one host's model list. Threaded into Providers settings so that changing a credential
   * refreshes the pickers straight away: a provider's models only appear once it has a credential,
   * and disappear when the credential is removed.
   */
  onRefreshModels?: (endpointId: string, options?: { upstream?: boolean; providers?: readonly string[] }) => Promise<unknown> | void;
  /** The host the Providers screen should open on, when it was opened *for* one. */
  providerEndpointId?: string;
};

/**
 * The minimum the host will accept for a remote-access password.
 *
 * Mirrors `MIN_REMOTE_PASSWORD_LENGTH` in `electron/remoteAuth.ts`, which the renderer cannot
 * import. Said to the reader rather than only enforced: the button was disabled under eight
 * characters with nothing on screen explaining why.
 */
const REMOTE_PASSWORD_MIN = 8;

/**
 * A three-way size choice. Buttons rather than a select because all three options fit on one line
 * and comparing them is the whole point — a dropdown hides the choice you did not make.
 */
const SizeChoices = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TextSize;
  onChange: (size: TextSize) => void;
}) => (
  <div role="group" aria-label={label} className="flex flex-none items-center gap-0.5 rounded-md border p-0.5">
    {TEXT_SIZES.map((size) => (
      <button
        key={size}
        type="button"
        aria-pressed={value === size}
        onClick={() => onChange(size)}
        className={
          value === size
            ? 'rounded-sm bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground'
            : 'rounded-sm px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground'
        }
      >
        {textSizeLabel(size)}
      </button>
    ))}
  </div>
);

const BLOB_STYLE_COPY = {
  buddy: { name: 'Buddy', hint: 'Flat, soft shapes' },
  crystal: { name: 'Crystal', hint: 'Faceted stones that glow' },
  mosaic: { name: 'Mosaic', hint: 'Pixel creatures with curious eyes' },
  lava: { name: 'Lava', hint: 'Grainy lava-lamp goo' },
};
const BLOB_STYLES = ACTIVE_BLOB_STYLES.map(id => ({ id, ...BLOB_STYLE_COPY[id] }));

export const allInstancesBypassEnabled = (
  instances: readonly Pick<Instance, 'id'>[],
  instanceDefaults: Record<string, InstanceDefaults>,
): boolean => instances.length > 0 && instances.every((instance) => instanceDefaults[instance.id]?.bypass === true);

export const applyDefaultsToAllInstances = (
  instances: readonly Pick<Instance, 'id'>[],
  instanceDefaults: Record<string, InstanceDefaults>,
  patch: Partial<InstanceDefaults>,
): Record<string, InstanceDefaults> => {
  const next: Record<string, InstanceDefaults> = { ...instanceDefaults };
  for (const instance of instances) next[instance.id] = { ...(next[instance.id] ?? {}), ...patch };
  return next;
};

export const toggleFleetYoloAction = (
  instances: readonly Pick<Instance, 'id'>[],
  instanceDefaults: Record<string, InstanceDefaults>,
): { confirming: boolean; nextDefaults?: Record<string, InstanceDefaults> } => {
  if (allInstancesBypassEnabled(instances, instanceDefaults)) {
    return {
      confirming: false,
      nextDefaults: applyDefaultsToAllInstances(instances, instanceDefaults, { bypass: false }),
    };
  }
  return { confirming: true };
};

export const confirmFleetYoloOn = (
  instances: readonly Pick<Instance, 'id'>[],
  instanceDefaults: Record<string, InstanceDefaults>,
): Record<string, InstanceDefaults> =>
  applyDefaultsToAllInstances(instances, instanceDefaults, { bypass: true });

export const fleetYoloConfirmationCopy = (instances: readonly Pick<Instance, 'id' | 'label'>[]): string =>
  instances.length === 1
    ? `Enable YOLO mode by default on ${instances[0].label}? New conversations there will approve every tool call automatically. Existing chats keep their settings.`
    : `Enable YOLO mode by default across all ${instances.length} computers and containers? New conversations on each Kiln will approve every tool call automatically. Existing chats keep their settings.`;

/**
 * Defaults for starting work, one row per instance.
 *
 * This used to be a single-instance editor behind a dropdown, which made the common intent —
 * "the same default everywhere" — the slowest thing to express: pick an instance, set a model,
 * pick the next, set it again. A table makes every instance visible at once, and the row above the
 * fold sets them all in one go.
 */
export const InstanceDefaultsSettings = ({
  instances,
  projectsByInstance,
  projectUsageByInstance,
  modelsByInstance,
  recentModelsByInstance,
  settings,
  onChange,
  onRefreshModels,
  initialConfirmingYoloAll = false,
}: Pick<Props, 'instances' | 'projectsByInstance' | 'projectUsageByInstance' | 'modelsByInstance' | 'recentModelsByInstance' | 'settings' | 'onChange' | 'onRefreshModels'> & {
  initialConfirmingYoloAll?: boolean;
}) => {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
  const [confirmingYoloAll, setConfirmingYoloAll] = React.useState(initialConfirmingYoloAll);

  if (instances.length === 0) {
    return (
      <Alert>
        <AlertDescription>No computers or containers are connected yet.</AlertDescription>
      </Alert>
    );
  }

  const defaultsFor = (instanceId: string): InstanceDefaults => settings.instanceDefaults[instanceId] ?? {};

  const update = (instanceId: string, patch: Partial<InstanceDefaults>) =>
    onChange({
      instanceDefaults: {
        ...settings.instanceDefaults,
        [instanceId]: { ...defaultsFor(instanceId), ...patch },
      },
    });

  /** Write the same patch to every instance — the "same everywhere" affordance. */
  const updateAll = (patch: Partial<InstanceDefaults>) => {
    onChange({ instanceDefaults: applyDefaultsToAllInstances(instances, settings.instanceDefaults, patch) });
  };

  const allYoloOn = allInstancesBypassEnabled(instances, settings.instanceDefaults);
  const showYoloConfirm = confirmingYoloAll && !allYoloOn;

  // What every instance already agrees on, so a bulk control can show the shared value rather than
  // an arbitrary one instance's.
  const sharedModel = (() => {
    const keys = instances.map((instance) => {
      const model = defaultsFor(instance.id).model;
      return model ? modelRefKey(model) : DEFAULT_MODEL;
    });
    return keys.every((key) => key === keys[0]) ? keys[0] : null;
  })();

  const editingInstance = editing ? instances.find((instance) => instance.id === editing) : undefined;
  const editingDefaults = editing ? defaultsFor(editing) : {};
  const editingModels = editing ? modelsByInstance[editing]?.models ?? [] : [];
  const editingModelKey = editingDefaults.model ? modelRefKey(editingDefaults.model) : DEFAULT_MODEL;
  const editingModelLabel = editingDefaults.model
    ? editingModels.find((entry) => modelRefKey(entry) === editingModelKey)?.label ??
      `${editingDefaults.model.providerID} / ${editingDefaults.model.modelID}`
    : 'Server default';

  const modelLabel = (instanceId: string): string => {
    const model = defaultsFor(instanceId).model;
    if (!model) return 'Server default';
    const models = modelsByInstance[instanceId]?.models ?? [];
    const key = modelRefKey(model);
    return models.find((entry) => modelRefKey(entry) === key)?.label ?? `${model.providerID} / ${model.modelID}`;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Set every instance at once. Each control writes to all rows below it. */}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">Defaults across computers and containers</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs font-normal"
            onClick={() => setEditing(instances[0]?.id ?? null)}
          >
            <SlidersHorizontal className="size-3.5" />
            Edit first connection…
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs font-normal"
            onClick={() => updateAll({ model: undefined, variant: undefined })}
            disabled={sharedModel !== null && sharedModel === DEFAULT_MODEL}
          >
            Reset models
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs font-normal"
            onClick={() => {
              const outcome = toggleFleetYoloAction(instances, settings.instanceDefaults);
              setConfirmingYoloAll(outcome.confirming);
              if (outcome.nextDefaults) onChange({ instanceDefaults: outcome.nextDefaults });
            }}
          >
            <ShieldCheck className="size-3.5" />
            {allYoloOn ? 'Turn YOLO off' : 'Turn YOLO on'}
          </Button>
        </div>
        {showYoloConfirm ? (
          <div
            className="flex flex-col gap-2 border-t pt-2 text-xs"
            role="group"
            aria-label="Turn YOLO on across computers and containers"
          >
            <p className="text-muted-foreground">{fleetYoloConfirmationCopy(instances)}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                onClick={() => {
                  setConfirmingYoloAll(false);
                  onChange({ instanceDefaults: confirmFleetYoloOn(instances, settings.instanceDefaults) });
                }}
              >
                Confirm YOLO on all
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setConfirmingYoloAll(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col divide-y rounded-lg border">
        {instances.map((instance) => {
          const defaults = defaultsFor(instance.id);
          const configured = Boolean(defaults.model || defaults.directory || defaults.workspaceDirectory || defaults.bypass !== undefined);
          return (
            <div key={instance.id} className="flex items-center gap-2 px-2.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium">{instance.label}</span>
                  {defaults.bypass ? (
                    <ShieldCheck
                      className="size-3 flex-none text-warning"
                      aria-label="YOLO mode enabled by default"
                    />
                  ) : null}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {configured ? modelLabel(instance.id) : 'Using server default'}
                  {defaults.directory ? ` · ${defaults.directory}` : ''}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-none text-xs text-muted-foreground"
                onClick={() => setEditing(instance.id)}
              >
                Edit
                <ChevronRight className="size-3.5 opacity-50" />
              </Button>
            </div>
          );
        })}
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="w-[440px] sm:max-w-[440px]">
          <DialogHeader className="text-left">
            <DialogTitle>{editingInstance?.label ?? 'Connection'} defaults</DialogTitle>
            <DialogDescription>Applies to new conversations on this Kiln. Existing chats keep their settings.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Default model</span>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between font-normal"
                  aria-label="Default model"
                  onClick={() => setModelPickerOpen(true)}
                >
                  <span className="truncate">{editingModelLabel}</span>
                  <ChevronRight className="size-4 flex-none opacity-50" />
                </Button>
              </section>

              <section className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Preferred provider</span>
                <span className="text-[11px] text-muted-foreground">
                  When no default model is set, new chats prefer models from this provider.
                </span>
                <Select
                  value={editingDefaults.preferredProvider ?? '__none'}
                  onValueChange={(value) =>
                    update(editing, { preferredProvider: value === '__none' ? undefined : value })
                  }
                >
                  <SelectTrigger className="w-full" aria-label="Preferred provider">
                    <SelectValue placeholder="No preference" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No preference</SelectItem>
                    {providersForPicker(editingModels).map((provider) => (
                      <SelectItem key={provider.providerID} value={provider.providerID}>
                        {provider.providerID} ({provider.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">Connection underline</span>
                  {editing ? (
                    <button
                      type="button"
                      onClick={() => update(editing, { markerColor: suggestMarkerColor(editing) })}
                      className="rounded px-1 text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Suggest a colour
                    </button>
                  ) : null}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Adds a colored line under chat names from this connection in the sidebar. Off unless you pick one.
                </span>
                <div className="grid grid-cols-7 gap-1.5">
                  <button
                    type="button"
                    aria-label="No underline"
                    aria-pressed={editingDefaults.markerColor === undefined}
                    onClick={() => update(editing, { markerColor: undefined })}
                    className={cn(
                      'flex h-8 items-center justify-center rounded-md border text-[10px] text-muted-foreground transition-colors hover:bg-muted',
                      editingDefaults.markerColor === undefined && 'border-highlight ring-2 ring-highlight/20'
                    )}
                  >
                    None
                  </button>
                  {INSTANCE_MARKER_COLORS.map((_, index) => (
                    <button
                      key={index}
                      type="button"
                      aria-label={`Connection underline color ${index + 1}`}
                      aria-pressed={editingDefaults.markerColor === index}
                      onClick={() => update(editing, { markerColor: index })}
                      className={cn(
                        'flex h-8 items-center justify-center rounded-md border transition-colors hover:bg-muted',
                        editingDefaults.markerColor === index && 'border-highlight ring-2 ring-highlight/20'
                      )}
                    >
                      <span
                        className="h-1 w-5 rounded-full"
                        style={{ backgroundColor: `var(--instance-marker-${index})` }}
                      />
                    </button>
                  ))}
                </div>
              </section>

              {editingInstance ? <section className="flex flex-col gap-2">
                <span className="text-xs font-medium">Workspace</span>
                <span className="text-[11px] text-muted-foreground">Parent folder opened when you browse for a project. Does not select a project automatically.</span>
                <ProjectPicker instance={editingInstance} projects={projectsByInstance[editing] ?? []} projectUsage={projectUsageByInstance?.[editing]} workspaceOnly
                  workspace={editingDefaults.workspaceDirectory} value={editingDefaults.workspaceDirectory ?? ''}
                  onWorkspaceChange={(workspaceDirectory) => update(editing, { workspaceDirectory })} onSelect={() => {}} />
                <span className="text-xs font-medium">Default project</span>
                <ProjectPicker instance={editingInstance} projects={projectsByInstance[editing] ?? []} projectUsage={projectUsageByInstance?.[editing]}
                  workspace={editingDefaults.workspaceDirectory} value={editingDefaults.directory ?? ''}
                  onWorkspaceChange={(workspaceDirectory) => update(editing, { workspaceDirectory })}
                  onSelect={(directory) => update(editing, { directory })} />
                {editingDefaults.directory ? <Button size="sm" variant="ghost" onClick={() => update(editing, { directory: undefined })}>Use the most recent project instead</Button> : null}
              </section> : null}

              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">YOLO mode by default</span>
                  <span className="text-[11px] text-muted-foreground">
                    New chats here approve tool calls automatically.
                  </span>
                </div>
                <Toggle
                  pressed={editingDefaults.bypass === true}
                  onPressedChange={(bypass) => update(editing, { bypass })}
                  variant="outline"
                  aria-label="YOLO mode by default"
                  className="data-[state=on]:border-warning/60 data-[state=on]:bg-warning/10 data-[state=on]:text-warning"
                >
                  <ShieldCheck />
                  {editingDefaults.bypass ? 'On' : 'Off'}
                </Toggle>
              </div>

              <ModelPicker
                open={modelPickerOpen}
                models={editingModels}
                recentModels={recentModelsByInstance[editing] ?? []}
                value={editingModelKey}
                variant={editingDefaults.variant ?? ''}
                defaultModelId={modelsByInstance[editing]?.defaultModelId ?? null}
                instanceDefaultModelId={effectiveInstanceDefaultModel(editingDefaults, modelsByInstance[editing]?.defaultModelId)}
                onSetInstanceDefault={(model) => update(editing, withInstanceDefaultModel(editingDefaults, model))}
                collapseProviders
                onSelect={(key, variant) => {
                  const model = editingModels.find((entry) => modelRefKey(entry) === key);
                  update(editing, {
                    model:
                      key === DEFAULT_MODEL || !model
                        ? undefined
                        : { providerID: model.providerID, modelID: model.modelID },
                    variant: variant || undefined,
                  });
                }}
                onOpenChange={setModelPickerOpen}
                onRefresh={onRefreshModels ? () => onRefreshModels(editing) : undefined}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

/**
 * What the listener is actually doing.
 *
 * "Allow Ember browser access over Tailscale: On" is a stored preference, not a fact: if Tailscale was not up
 * when Ember started, the socket was never bound and the old UI had no way to say so.
 */
const RemoteListenerStatus = ({
  state,
  enabled,
  proxyOrigin,
}: {
  state?: RemoteAccessState;
  enabled: boolean;
  proxyOrigin?: string;
}) => {
  if (!enabled) return null;
  const status = state?.status ?? 'starting';
  const detail = (() => {
    if (status === 'listening') {
      const address = state?.address ? `http://${state.address}${state.port ? `:${state.port}` : ''}` : 'this machine';
      return { tone: 'ok' as const, text: proxyOrigin
        ? `Local listener ready on ${address}. HTTPS proxy configured; verify ${proxyOrigin} from your phone.`
        : `Listening on ${address}` };
    }
    if (status === 'no-tailscale') {
      return {
        tone: 'warn' as const,
        text: 'Not listening yet — Tailscale is not connected. Ember keeps trying and will start when it is.',
      };
    }
    if (status === 'error') {
      return {
        tone: 'warn' as const,
        text: `${state?.detail ?? 'The listener could not start.'}${state?.attempts ? ' Ember keeps retrying.' : ''}`,
      };
    }
    return { tone: 'muted' as const, text: 'Starting the listener…' };
  })();
  return (
    <p
      className={
        detail.tone === 'ok'
          ? 'text-[11px] text-muted-foreground'
          : detail.tone === 'warn'
            ? 'rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning'
            : 'text-[11px] text-muted-foreground'
      }
      role="status"
    >
      {detail.text}
    </p>
  );
};

export default function SettingsPanel({
  open,
  view,
  settings,
  instances,
  projectsByInstance,
  projectUsageByInstance,
  modelsByInstance,
  recentModelsByInstance,
  onChange,
  onOpenChange,
  onViewChange,
  onRefreshInstances,
  onRefreshModels,
  providerEndpointId,
}: Props) {
  // The packaged version, so an upgrade can be checked without quitting to look at a bundle.
  const [appVersion, setAppVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    void window.ember.appVersion?.().then((value) => {
      if (live) setAppVersion(value);
    });
    return () => {
      live = false;
    };
  }, []);

  const returnFocus = React.useRef<HTMLElement | null>(null);
  const [remotePassword, setRemotePassword] = React.useState('');

  const saveRemotePassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (remotePassword.length < REMOTE_PASSWORD_MIN) return;
    onChange({ remotePassword });
    setRemotePassword('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const previous = returnFocus.current;
          if (previous?.isConnected && previous !== document.body) previous.focus();
          else document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')?.focus();
        }} className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[86vh] sm:max-w-[1080px] h-[min(900px,94dvh)]">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Connections and providers belong to each computer. Appearance and conversation preferences apply across this Ember.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={settingsSection(view)}
          orientation="vertical"
          onValueChange={(value) => onViewChange(settingsSection(value))}
          className="settings-layout min-h-0 gap-0"
        >
          <aside className="settings-sidebar border-b bg-muted/20 p-3 sm:border-r sm:border-b-0 sm:p-4">
            <TabsList aria-label="Settings sections" className="settings-categories h-auto w-full items-stretch justify-start gap-1 rounded-none bg-transparent p-0">
              {SETTINGS_SECTIONS.map(section => <TabsTrigger key={section.id} value={section.id}
                className="min-h-11 flex-none justify-start whitespace-normal rounded-md px-3 py-2 text-left text-sm data-[state=active]:bg-muted data-[state=active]:shadow-none">
                {section.label}
              </TabsTrigger>)}
            </TabsList>
            <p className="mt-6 hidden text-xs text-muted-foreground sm:block">Ember {appVersion ?? 'version unavailable'}</p>
          </aside>

          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-4 py-5 sm:px-9 sm:py-7">
            <header className="mb-6">
              <h2 className="text-2xl font-semibold tracking-tight">{SETTINGS_SECTIONS.find(section => section.id === settingsSection(view))?.label}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{SETTINGS_SECTIONS.find(section => section.id === settingsSection(view))?.description}</p>
            </header>
            <TabsContent value="providers" className="mt-0 flex flex-col gap-4">
                  <ProvidersSettings
                    inventory
                    endpoints={settings.piEndpoints}
                    instances={instances}
                    onProviderChange={onRefreshModels}
                    instanceDefaults={settings.instanceDefaults}
                    onDefaultChange={(id, model) => onChange({ instanceDefaults: { ...settings.instanceDefaults, [id]: { ...settings.instanceDefaults[id], model, variant: model?.variant } } })}
                    {...(providerEndpointId ? { initialEndpointId: providerEndpointId } : {})}
                  />
              <ModelExperienceSettings />
            </TabsContent>
            <TabsContent value="computers" className="mt-0 flex flex-col gap-4">
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Connections
                  </CardTitle>
                  <CardDescription>
                    Each Kiln keeps its own conversations. Connect another computer or container. Share this Kiln from Remote access.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <EndpointsSettings
                    endpoints={settings.piEndpoints}
                    instances={instances}
                    onChange={onChange}
                    onRefreshInstances={onRefreshInstances}
                    onRefreshModels={onRefreshModels}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Defaults for new conversations
                  </CardTitle>
                  <CardDescription>
                    Choose a model, project browsing folder, optional default project and approval mode for each computer or container. Existing chats keep their choices.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <InstanceDefaultsSettings
                    instances={instances}
                    projectsByInstance={projectsByInstance}
                    projectUsageByInstance={projectUsageByInstance}
                    modelsByInstance={modelsByInstance}
                    recentModelsByInstance={recentModelsByInstance}
                    settings={settings}
                    onChange={onChange}
                    onRefreshModels={onRefreshModels}
                  />
                </CardContent>
              </Card>
              {window.ember.capabilities?.desktopUpdates === true ? <Card>
                <CardHeader className="p-3 pb-0"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ember updates</CardTitle></CardHeader>
                <CardContent className="space-y-3 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">Check for Ember updates daily and notify me</span>
                      <span className="text-[11px] text-muted-foreground">Checks GitHub while Ember is open. Downloads and installation only happen when you choose.</span>
                    </div>
                    <Toggle pressed={settings.automaticUpdateChecks !== false} onPressedChange={enabled => onChange({ automaticUpdateChecks: enabled })} variant="outline" size="sm" aria-label="Daily update checks">{settings.automaticUpdateChecks !== false ? 'On' : 'Off'}</Toggle>
                  </div>
                  {settings.automaticUpdateChecks === false ? <p className="text-xs text-muted-foreground">Automatic checks are off. You can check manually below.</p> : null}
                  <DesktopUpdates placement="settings" />
                </CardContent>
              </Card> : null}
              <section aria-label="Kiln updates" className="rounded-lg border p-5 text-sm">
                <h3 className="font-medium">Kiln updates</h3>
                <p className="mt-2 text-muted-foreground">The included Kiln updates with Ember. Ember cannot update a remote Kiln here: update the Ember app on its computer, update standalone Tinder, or redeploy the container. Connecting does not give Ember ownership of that process.</p>
              </section>
            </TabsContent>

            <TabsContent value="appearance" className="mt-0 flex flex-col gap-5">
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Theme
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-3">
                  {THEME_GROUPS.map((group) => (
                    <div key={group.id} className="flex flex-col gap-1.5">
                      <span className="text-[11px] text-muted-foreground">{group.name}</span>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {THEMES.filter((theme) => theme.group === group.id).map((theme) => {
                          const selected = theme.id === settings.theme;
                          const { palette } = theme;
                          return (
                            <motion.button
                              key={theme.id}
                              type="button"
                              whileTap={{ scale: 0.97 }}
                              aria-pressed={selected}
                              onClick={() => onChange({ theme: theme.id })}
                              className={cn(
                                'relative flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-muted',
                                selected ? 'border-highlight' : 'border-border'
                              )}
                            >
                              <span
                                className="relative flex size-8 flex-none items-end justify-end rounded-md border border-black/10 p-1"
                                style={{ background: palette.bg }}
                              >
                                <span
                                  className="absolute inset-x-1 top-1 h-2.5 rounded-sm"
                                  style={{ background: palette.elev }}
                                />
                                <span className="size-1.5 rounded-full" style={{ background: palette.highlight }} />
                              </span>
                              <span className="min-w-0 truncate font-medium">{theme.name}</span>
                              {selected && (
                                <Check className="absolute top-1.5 right-1.5 size-3 text-highlight" />
                              )}
                            </motion.button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-0"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Text size</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-3 p-3">
                  {/* Three sizes with three homes, because one setting could not serve them: the
                      chrome, the conversation and what you type are read at different distances.
                      Each row states what it changes, so nobody has to guess what "Medium" means. */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium">Interface</span>
                      <SizeChoices
                        label="Interface text size"
                        value={settings.interfaceSize ?? 'medium'}
                        onChange={(size) => onChange({ interfaceSize: size })}
                      />
                    </div>
                    <span className="text-[11px] text-muted-foreground">Sidebar, headers, menus and Settings.</span>
                    <p data-testid="text-size-preview-interface" className="text-[11px] text-muted-foreground" style={{ zoom: INTERFACE_SCALE[settings.interfaceSize ?? 'medium'] }}>
                      <span className="font-medium text-foreground">Sidebar · Header · Settings</span> — controls and menus scale to this size.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium">Chat</span>
                      <SizeChoices
                        label="Chat text size"
                        value={nearestChatSize(settings.conversationFontSize)}
                        onChange={(size) => onChange({ conversationFontSize: CHAT_PX[size] })}
                      />
                    </div>
                    <span className="text-[11px] text-muted-foreground">Messages in the conversation.</span>
                    <p data-testid="text-size-preview-chat" className="text-muted-foreground" style={{ fontSize: CHAT_PX[nearestChatSize(settings.conversationFontSize)], lineHeight: 1.8 }}>
                      Messages appear at this size.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium">Composer</span>
                      <SizeChoices
                        label="Composer text size"
                        value={composerSizeOf(settings.composerSize)}
                        onChange={(size) => onChange({ composerSize: size })}
                      />
                    </div>
                    <span className="text-[11px] text-muted-foreground">What you type before sending.</span>
                    <p data-testid="text-size-preview-composer" className="text-muted-foreground" style={{ fontSize: COMPOSER_PX[composerSizeOf(settings.composerSize)], lineHeight: 1.8 }}>
                      Message your bot…
                    </p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Chat avatars
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  <fieldset className="mb-4">
                    <legend className="text-xs font-medium">Avatar size</legend>
                    <p className="mt-1 mb-2 text-[11px] text-muted-foreground">Spot conversations in the sidebar and composer.</p>
                    <div className="grid grid-cols-3 gap-2">
                      {AVATAR_SIZES.map(option => <button key={option.id} type="button" aria-label={`${option.label} avatars`}
                        aria-pressed={settings.blobSize === option.id} onClick={() => onChange({ blobSize: option.id })}
                        className={cn('flex min-w-0 flex-col items-center justify-end gap-1 rounded-lg border p-2 hover:bg-muted', settings.blobSize === option.id && 'border-highlight bg-muted/50')}>
                        <Blob style={effectiveBlobStyle(settings.blobStyle)} seed="avatar-size-preview" size={avatarPixels(40, option.id)} />
                        <span className="text-xs">{option.label}</span>
                      </button>)}
                    </div>
                  </fieldset>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {BLOB_STYLES.map((option) => {
                      const selected = option.id === effectiveBlobStyle(settings.blobStyle);
                      return (
                        <motion.button
                          key={option.id}
                          type="button"
                          whileTap={{ scale: 0.97 }}
                          aria-pressed={selected}
                          onClick={() => onChange({ blobStyle: option.id })}
                          className={cn(
                            'relative flex flex-col items-center gap-2.5 rounded-lg border bg-muted/50 px-3 py-3 text-center transition-colors hover:bg-muted',
                            selected && 'border-highlight'
                          )}
                        >
                          <div className="flex -space-x-1.5">
                            <Blob style={option.id} seed="settings one" size={30} />
                            <Blob style={option.id} seed="settings two" size={30} />
                          </div>
                          <div className="flex min-w-0 flex-col">
                            <span className="font-medium">{option.name}</span>
                            <span className="text-[11px] text-muted-foreground">{option.hint}</span>
                          </div>
                          {selected && (
                            <Check className="absolute top-2 right-2 size-3.5 text-highlight" />
                          )}
                        </motion.button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="conversations" className="mt-0 flex flex-col gap-5">
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Sessions
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">Show recent sessions</span>
                      <span className="text-[11px] text-muted-foreground">
                        Older chats leave the sidebar until they are active again. Search all time still finds them.
                      </span>
                    </div>
                    <Select
                      value={String(settings.sessionWindowHours)}
                      onValueChange={(value) => onChange({ sessionWindowHours: Number(value) })}
                    >
                      <SelectTrigger size="sm" className="w-full text-xs sm:w-[150px]" aria-label="Session window">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SESSION_WINDOWS.map((option) => (
                          <SelectItem key={option.hours} value={String(option.hours)}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">Auto-hide scheduled runs</span>
                      <span className="text-[11px] text-muted-foreground">
                        Finished task runs are hidden after a day, once you’ve marked their messages read. They stay in Scheduled.
                      </span>
                    </div>
                    <Toggle
                      pressed={settings.autoArchiveScheduledRuns}
                      onPressedChange={(enabled) => onChange({ autoArchiveScheduledRuns: enabled })}
                      variant="outline"
                      size="sm"
                      aria-label="Auto-hide scheduled runs"
                    >
                      {settings.autoArchiveScheduledRuns ? 'On' : 'Off'}
                    </Toggle>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">Split view</span>
                      <span className="text-[11px] text-muted-foreground">
                        {settings.splitView
                          ? 'Open multiple chats side by side, as many as fit your window. Closing a column keeps the chat in the sidebar.'
                          : 'Show one chat at a time. Turn on to keep several open side by side.'}
                      </span>
                    </div>
                    <Toggle
                      pressed={settings.splitView}
                      onPressedChange={(enabled) => onChange({ splitView: enabled })}
                      variant="outline"
                      size="sm"
                      aria-label="Split view"
                    >
                      {settings.splitView ? 'On' : 'Off'}
                    </Toggle>
                  </div>
                </CardContent>
              </Card>
              <section aria-label="Unread replies" className="rounded-lg border p-5">
                <h3 className="font-medium">Unread replies</h3>
                <p className="mt-2 text-sm text-muted-foreground">You decide when a reply is read. Opening a chat, copying or replying never marks it read. Use New unread messages to jump, then Mark as read or Mark all as read when you’re ready. Undo restores the previous marks.</p>
                <p className="mt-2 text-sm text-muted-foreground">Mute a conversation from its menu to quiet its unread indicators. Questions and approvals remain visible.</p>
              </section>
              <Card><CardContent className="p-5"><ContextCompactionSettings instances={instances} /></CardContent></Card>
            </TabsContent>

            <TabsContent value="remote" className="mt-0 flex flex-col gap-5">
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Ember browser access
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <KeyRound className="mt-0.5 size-4 flex-none text-muted-foreground" />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium">Allow Ember browser access over Tailscale</span>
                        <span className="text-[11px] text-muted-foreground">
                          Serves the password-protected Ember browser UI on port 57821: directly on your tailnet, or loopback-only when a reviewed HTTPS proxy is configured. This does not share the Kiln API.
                        </span>
                      </div>
                    </div>
                    <Toggle
                      pressed={settings.remoteAccessEnabled}
                      disabled={!settings.remotePasswordConfigured}
                      onPressedChange={(enabled) => onChange({ remoteAccessEnabled: enabled })}
                      variant="outline"
                      size="sm"
                      aria-label="Allow Ember browser access over Tailscale"
                    >
                      {settings.remoteAccessEnabled ? 'On' : 'Off'}
                    </Toggle>
                  </div>
                  <RemoteListenerStatus state={settings.remoteAccessState} enabled={settings.remoteAccessEnabled} proxyOrigin={settings.remoteAccessProxyOrigin} />
                  <RemoteHttpsSetup origin={settings.remoteAccessProxyOrigin} onChange={onChange} />
                  {settings.settingsRecovered ? (
                    <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                      Ember could not read its settings file, so it started from defaults and kept the old
                      file next to it (named settings.json.corrupt-…). Your appearance and workspace choices
                      may need setting again. Drafts and notes are still in that file.
                    </p>
                  ) : null}
                  <form className="flex items-center gap-2" onSubmit={saveRemotePassword}>
                    <SecretInput
                      value={remotePassword}
                      onChange={(event) => setRemotePassword(event.target.value)}
                      placeholder={settings.remotePasswordConfigured ? 'Enter a new password' : 'Set a password'}
                      minLength={REMOTE_PASSWORD_MIN}
                      maxLength={256}
                      aria-label="Remote access password"
                    />
                    <Button type="submit" variant="secondary" size="sm" disabled={remotePassword.length < REMOTE_PASSWORD_MIN}>
                      {settings.remotePasswordConfigured ? 'Change' : 'Set password'}
                    </Button>
                  </form>
                  <p className="text-[11px] text-muted-foreground">
                    {settings.remotePasswordConfigured
                      ? `At least ${REMOTE_PASSWORD_MIN} characters.`
                      : `At least ${REMOTE_PASSWORD_MIN} characters. Required before enabling browser access. Ember stores a hash, never the password itself.`}
                  </p>
                  {settings.remotePasswordConfigured ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start text-muted-foreground"
                      onClick={() => onChange({ remoteAccessEnabled: false, remotePassword: null })}
                    >
                      Remove password and disable access
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
              <KilnSharing />
              {/* Token rotation stays available without competing with the connection flow. */}
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer text-xs font-medium">Advanced: local Kiln token</summary>
              <Card className="mt-3 border-0 shadow-none">
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    This computer
                  </CardTitle>
                  <CardDescription>
                    Manage this computer’s local Kiln bearer token. Use Share this Kiln above to make it reachable from another computer.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <LocalTokenSettings
                    canRotate={settings.localHarnessCanRotate === true}
                    {...(window.ember.localHarnessToken
                      ? { loadToken: window.ember.localHarnessToken }
                      : {})}
                    onRefreshInstances={onRefreshInstances}
                  />
                </CardContent>
              </Card>
              </details>


              <Button variant="link" className="self-start" onClick={() => onViewChange('providers')}>Share provider access instead →</Button>
            </TabsContent>

          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
