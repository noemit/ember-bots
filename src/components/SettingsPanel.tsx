import * as React from 'react';
import { motion } from 'motion/react';
import { Check, ChevronRight, KeyRound, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import Blob from '../blob/Blob';
import ModelPicker from './ModelPicker';
import EndpointsSettings from './EndpointsSettings';
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
import { Input } from '@/components/ui/input';
import SecretInput from '@/components/ui/secret-input';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { DEFAULT_MODEL, modelRefKey, SESSION_WINDOWS } from '../types';
import { providersForPicker } from '../lib/providerPreference';
import { suggestMarkerColor } from '../lib/instanceMarker';
import type { ModelList } from '../api';
import type { BlobStyle, EmberSettings, EmberSettingsPatch, Instance, InstanceDefaults, Project, RemoteAccessState } from '../types';

type Props = {
  open: boolean;
  view: 'general' | 'instances' | 'providers';
  settings: EmberSettings;
  instances: Instance[];
  projectsByInstance: Record<string, Project[]>;
  modelsByInstance: Record<string, ModelList>;
  recentModelsByInstance: Record<string, string[]>;
  onChange: (patch: EmberSettingsPatch) => void;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: 'general' | 'instances' | 'providers') => void;
  /** Reprobe instances after the endpoint list changes, so a new Hearth attaches promptly. */
  onRefreshInstances?: () => void;
  /**
   * Reload one host's model list. Threaded into Providers settings so that changing a credential
   * refreshes the pickers straight away: a provider's models only appear once it has a credential,
   * and disappear when the credential is removed.
   */
  onRefreshModels?: (endpointId: string) => void;
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

const BLOB_STYLES: Array<{ id: BlobStyle; name: string; hint: string }> = [
  { id: 'buddy', name: 'Buddy', hint: 'Flat, soft shapes' },
  { id: 'crystal', name: 'Crystal', hint: 'Faceted stones that glow' },
  { id: 'pip', name: 'Pip', hint: 'A little critter whose face is its mood' },
  { id: 'lava', name: 'Lava', hint: 'Grainy goo that drips while it works' },
];

/**
 * Defaults for starting work, one row per instance.
 *
 * This used to be a single-instance editor behind a dropdown, which made the common intent —
 * "the same default everywhere" — the slowest thing to express: pick an instance, set a model,
 * pick the next, set it again. A table makes every instance visible at once, and the row above the
 * fold sets them all in one go.
 */
const InstanceDefaultsSettings = ({
  instances,
  projectsByInstance,
  modelsByInstance,
  recentModelsByInstance,
  settings,
  onChange,
}: Pick<Props, 'instances' | 'projectsByInstance' | 'modelsByInstance' | 'recentModelsByInstance' | 'settings' | 'onChange'>) => {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);

  if (instances.length === 0) {
    return (
      <Alert>
        <AlertDescription>No instances are configured yet.</AlertDescription>
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
    const next: Record<string, InstanceDefaults> = { ...settings.instanceDefaults };
    for (const instance of instances) next[instance.id] = { ...(next[instance.id] ?? {}), ...patch };
    onChange({ instanceDefaults: next });
  };

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
    : 'Instance default';

  const modelLabel = (instanceId: string): string => {
    const model = defaultsFor(instanceId).model;
    if (!model) return 'Instance default';
    const models = modelsByInstance[instanceId]?.models ?? [];
    const key = modelRefKey(model);
    return models.find((entry) => modelRefKey(entry) === key)?.label ?? `${model.providerID} / ${model.modelID}`;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Set every instance at once. Each control writes to all rows below it. */}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">Set every instance to the same</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs font-normal"
            onClick={() => setEditing(instances[0]?.id ?? null)}
          >
            <SlidersHorizontal className="size-3.5" />
            Then copy from one…
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
            onClick={() => updateAll({ bypass: !instances.every((instance) => defaultsFor(instance.id).bypass === true) })}
          >
            <ShieldCheck className="size-3.5" />
            {instances.every((instance) => defaultsFor(instance.id).bypass === true) ? 'Turn yolo off' : 'Turn yolo on'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col divide-y rounded-lg border">
        {instances.map((instance) => {
          const defaults = defaultsFor(instance.id);
          const configured = Boolean(defaults.model || defaults.directory || defaults.bypass !== undefined);
          return (
            <div key={instance.id} className="flex items-center gap-2 px-2.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium">{instance.label}</span>
                  {defaults.bypass ? (
                    <ShieldCheck
                      className="size-3 flex-none text-warning"
                      aria-label="yolo by default on this instance"
                    />
                  ) : null}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {configured ? modelLabel(instance.id) : 'Using the instance default'}
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
            <DialogTitle>{editingInstance?.label ?? 'Instance'} defaults</DialogTitle>
            <DialogDescription>Used when starting work on this instance.</DialogDescription>
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
                  When no model is pinned, new agents prefer this provider&apos;s models on this
                  instance. Useful for a subscription that exists on some devices only.
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
                  <span className="text-xs font-medium">Instance underline</span>
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
                  A marker beneath session names from this instance, so it is obvious which host
                  a session runs on. Off unless you pick one.
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
                      aria-label={`Instance underline color ${index + 1}`}
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

              <section className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Default project</span>
                <span className="text-[11px] text-muted-foreground">
                  Where new agents on this instance start. A project keeps its own name; the box
                  below takes any path.
                </span>
                <Select
                  value={
                    (projectsByInstance[editing] ?? []).some(
                      (project) => project.path && project.path === editingDefaults.directory
                    )
                      ? (editingDefaults.directory as string)
                      : '__none'
                  }
                  onValueChange={(value) =>
                    update(editing, { directory: value === '__none' ? undefined : value })
                  }
                >
                  <SelectTrigger className="w-full" aria-label="Default project">
                    <SelectValue placeholder="No default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No default</SelectItem>
                    {(projectsByInstance[editing] ?? [])
                      .filter((project) => project.path)
                      .map((project) => (
                        <SelectItem key={project.path!} value={project.path!}>
                          {project.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Input
                  value={editingDefaults.directory ?? ''}
                  onChange={(event) => update(editing, { directory: event.target.value || undefined })}
                  placeholder="Or a custom path"
                  aria-label="Default folder"
                  className="mt-1"
                />
              </section>

              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">Yolo mode by default</span>
                  <span className="text-[11px] text-muted-foreground">
                    New agents here start with permission prompts auto-accepted.
                  </span>
                </div>
                <Toggle
                  pressed={editingDefaults.bypass === true}
                  onPressedChange={(bypass) => update(editing, { bypass })}
                  variant="outline"
                  aria-label="Yolo mode by default"
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
 * "Allow access over Tailscale: On" is a stored preference, not a fact: if Tailscale was not up
 * when Ember started, the socket was never bound and the old UI had no way to say so.
 */
const RemoteListenerStatus = ({
  state,
  enabled,
}: {
  state?: RemoteAccessState;
  enabled: boolean;
}) => {
  if (!enabled) return null;
  const status = state?.status ?? 'starting';
  const detail = (() => {
    if (status === 'listening') {
      const address = state?.address ? `http://${state.address}${state.port ? `:${state.port}` : ''}` : 'this machine';
      return { tone: 'ok' as const, text: `Listening on ${address}` };
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

  const [remotePassword, setRemotePassword] = React.useState('');

  const saveRemotePassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (remotePassword.length < REMOTE_PASSWORD_MIN) return;
    onChange({ remotePassword });
    setRemotePassword('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[520px] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[86vh] sm:max-w-[520px]">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Applies to this window across every instance.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={view}
          onValueChange={(value) => onViewChange(value as 'general' | 'instances' | 'providers')}
          className="flex min-h-0 flex-col"
        >
          <TabsList className="mx-4 mt-4 mb-0 w-auto self-start">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="instances">Instances</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-4 py-4 sm:px-5 sm:py-5">
            <TabsContent value="general" className="mt-0 flex flex-col gap-5">
              <ModelExperienceSettings />
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Sessions
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">Show sessions active in the</span>
                      <span className="text-[11px] text-muted-foreground">
                        Quieter sessions drop out of the list until they're active again.
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
                      <span className="font-medium">Auto-archive scheduled runs</span>
                      <span className="text-[11px] text-muted-foreground">
                        Task runs archive themselves a day after they finish. The scheduled view still lists them.
                      </span>
                    </div>
                    <Toggle
                      pressed={settings.autoArchiveScheduledRuns}
                      onPressedChange={(enabled) => onChange({ autoArchiveScheduledRuns: enabled })}
                      variant="outline"
                      size="sm"
                      aria-label="Auto-archive scheduled runs"
                    >
                      {settings.autoArchiveScheduledRuns ? 'On' : 'Off'}
                    </Toggle>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">Split view</span>
                      <span className="text-[11px] text-muted-foreground">
                        {settings.splitView
                          ? 'Opening a session adds a column beside this one, as many as fit. Closing a column returns it to the list.'
                          : 'Opening a session takes over the view. Turn this on to keep several open side by side instead.'}
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

              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Remote access
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <KeyRound className="mt-0.5 size-4 flex-none text-muted-foreground" />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium">Allow access over Tailscale</span>
                        <span className="text-[11px] text-muted-foreground">
                          Requires a password and is available only to your Tailnet.
                        </span>
                      </div>
                    </div>
                    <Toggle
                      pressed={settings.remoteAccessEnabled}
                      disabled={!settings.remotePasswordConfigured}
                      onPressedChange={(enabled) => onChange({ remoteAccessEnabled: enabled })}
                      variant="outline"
                      size="sm"
                      aria-label="Allow remote access over Tailscale"
                    >
                      {settings.remoteAccessEnabled ? 'On' : 'Off'}
                    </Toggle>
                  </div>
                  <RemoteListenerStatus state={settings.remoteAccessState} enabled={settings.remoteAccessEnabled} />
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
                      : `At least ${REMOTE_PASSWORD_MIN} characters, and only on this machine: Ember stores a hash, never the password itself.`}
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

              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Session avatars
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {BLOB_STYLES.map((option) => {
                      const selected = option.id === settings.blobStyle;
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
                            <Blob style={option.id} seed="settings one" size={30} interactive={false} />
                            <Blob style={option.id} seed="settings two" size={30} interactive={false} />
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
                      <div className="grid grid-cols-3 gap-2">
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
              <p className="border-t pt-3 text-[11px] text-muted-foreground">
                Ember <span className="font-medium tabular-nums">{appVersion ?? 'unknown'}</span>
                <span className="text-muted-foreground/70"> · settings save as you change them</span>
              </p>
            </TabsContent>

            <TabsContent value="instances" className="mt-0 flex flex-col gap-4">
              {/* The harness this app runs on this computer, first: its token is what the other
                  machines need, and it was previously only reachable from a terminal. */}
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    This computer
                  </CardTitle>
                  <CardDescription>
                    Ember runs ember-harness for you here. Its token is what another machine — or a
                    browser you pair over remote access — uses to connect.
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
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    ember-harness endpoints
                  </CardTitle>
                  <CardDescription>
                    Devices running ember-harness. Each keeps its own conversations; Ember lists
                    them together in the rail.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <EndpointsSettings
                    endpoints={settings.piEndpoints}
                    instances={instances}
                    onChange={onChange}
                    onRefreshInstances={onRefreshInstances}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Instance defaults
                  </CardTitle>
                  <CardDescription>
                    Choose the defaults used when starting work on each instance.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <InstanceDefaultsSettings
                    instances={instances}
                    projectsByInstance={projectsByInstance}
                    modelsByInstance={modelsByInstance}
                    recentModelsByInstance={recentModelsByInstance}
                    settings={settings}
                    onChange={onChange}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="providers" className="mt-0 flex flex-col gap-4">
              <Card>
                <CardHeader className="p-3 pb-0">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Model providers
                  </CardTitle>
                  <CardDescription>
                    Each ember-harness host keeps its own credentials, stored on that host and never sent
                    back to this window. Sign in where a provider supports it, or paste an API key.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 pt-2">
                  <ProvidersSettings
                    endpoints={settings.piEndpoints}
                    instances={instances}
                    onProviderChange={onRefreshModels}
                    {...(providerEndpointId ? { initialEndpointId: providerEndpointId } : {})}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
