import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { KeyRound, Loader2, LogIn, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SecretInput from '@/components/ui/secret-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useStableCallback } from '@/lib/useStableCallback';
import { effectiveInstanceDefaultModel, withInstanceDefaultModel } from '@/lib/instanceDefaultModel';
import {
  piImportOpenCodeProviders,
  piLoadProviders,
  piRefreshModels,
  piRemoveProvider,
  piSetProviderKey,
  type PiOpenCodeImportCandidate,
  type PiProviderInfo,
} from '../piApi';
import { DEFAULT_MODEL, modelRefKey } from '../types';
import ModelPicker from './ModelPicker';
import type { ModelList } from '../api';
import type { InstanceDefaults, ModelRef, Instance, PiEndpoint } from '../types';
import ProviderSignInDialog from '@/components/ProviderSignInDialog';
import ProviderSharing from './ProviderSharing';
import type { ModelRefreshOptions } from '@/lib/providerSharing';
import CustomProviders from './CustomProviders';
import OllamaSetup from './OllamaSetup';

type Props = {
  inventory?: boolean;
  /** Suppresses the duplicate default-model summary when OnboardingWizard renders `#onboarding-default-model` above. */
  onboarding?: boolean;
  endpoints: PiEndpoint[];
  instances: Instance[];
  /**
   * Called after a credential changes (saved, removed, or signed in) for this host. The model list
   * a host offers is a *consequence* of which credentials it holds, so without this the pickers
   * kept offering models from a provider whose key had just been removed — and omitting the ones
   * a new key unlocked — until the next poll happened to land.
   */
  onProviderChange?: (endpointId: string, options?: ModelRefreshOptions) => Promise<unknown> | void;
  /**
   * Which host to show first. Set when the panel is opened *for* a host — the picker's "Add
   * providers…" from a session names its own instance — so the screen lands on the machine that
   * needs the credential rather than whichever endpoint happens to be first.
   */
  initialEndpointId?: string;
  instanceDefaults?: Record<string, InstanceDefaults>;
  onDefaultChange?: (endpointId: string, model: ModelRef | undefined) => void;
  onProviderCatalog?: (endpointId: string, providers: PiProviderInfo[]) => void;
};

const credentialLabel: Record<NonNullable<PiProviderInfo['credential']>, string> = {
  api_key: 'API key',
  oauth: 'OAuth',
};

/**
 * Provider credentials, one Hearth host at a time. `GET /providers` reports the saved credential
 * type or the host environment variable name; a key set here is written to that host's
 * `$HEARTH_HOME/auth.json` and is never sent back or rendered. Subscription sign-in runs on that
 * same host; this panel shows the browser link and polls for confirmed credential storage.
 */
export default function ProvidersSettings(props: Props) {
  const { endpoints, initialEndpointId } = props;
  const [selection, setSelection] = React.useState({ initialEndpointId, id: initialEndpointId ?? endpoints[0]?.id ?? '' });
  // Resolve changed deep links during render: an old host's controls must never paint under a new scope.
  const chosen = selection.initialEndpointId === initialEndpointId ? selection.id : initialEndpointId;
  const endpointId = endpoints.find(endpoint => endpoint.id === chosen)?.id ?? endpoints[0]?.id ?? '';
  return <HostProvidersSettings {...props} key={endpointId} endpointId={endpointId}
    onEndpointChange={id => setSelection({ initialEndpointId, id })} />;
}

const sanitizeFailureDetail = (error: unknown): string | undefined => {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const trimmed = raw.trim();
  if (!trimmed || /\b(HTTP\s*\d+|undefined|null|stack)\b/i.test(trimmed)) return undefined;
  return trimmed.replace(/!+$/, '');
};

export const formatProviderActionError = (
  hostLabel: string,
  providerName: string,
  action: 'save' | 'remove',
  error?: unknown,
): string => {
  const host = hostLabel.trim() || 'This Kiln';
  const detail = sanitizeFailureDetail(error);
  if (action === 'remove') {
    return `${host} could not remove ${providerName}’s saved credential${detail ? ` (${detail})` : ''}. Check that ${host} is answering and choose Remove credential again.`;
  }
  return `${host} could not save ${providerName}’s key${detail ? ` (${detail})` : ''}. Check that ${host} is answering and try Save key again.`;
};

export const formatEnvFallbackNotice = (
  hostLabel: string,
  providerName: string,
  envVar: string,
): string => {
  const host = hostLabel.trim() || 'this computer';
  return `Saved key removed from ${host}. ${providerName} now uses ${envVar} from the host environment — unset ${envVar} on the computer running this Kiln and restart Kiln to disconnect it completely.`;
};

/** A host transition remounts every credential draft, action and dialog together. */
function HostProvidersSettings({ inventory = false, onboarding = false, endpoints, instances, onProviderChange, instanceDefaults = {}, onDefaultChange, onProviderCatalog, endpointId, onEndpointChange }: Props & { endpointId: string; onEndpointChange: (id: string) => void }) {
  const mounted = React.useRef(true);
  const reads = React.useRef(0);
  const defaultReads = React.useRef(0);
  const credentialField = React.useRef<HTMLInputElement>(null);
  const focusChosenCredential = React.useRef(false);
  React.useLayoutEffect(() => {
    mounted.current = true;
    const providerReads = reads;
    const modelReads = defaultReads;
    return () => { mounted.current = false; providerReads.current++; modelReads.current++; };
  }, []);
  const [providers, setProviders] = React.useState<PiProviderInfo[] | null>(null);
  const [defaultModel, setDefaultModel] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  /** The provider whose sign-in dialog is open, if any. */
  const [confirmation, setConfirmation] = React.useState<{ endpointId: string; providerName: string; providerId?: string; catalog: ModelList | null } | null>(null);
  const [choosingDefault, setChoosingDefault] = React.useState(false);
  const savedDefaultKey = instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : '';
  const previousDefaultKey = React.useRef(savedDefaultKey);
  React.useEffect(() => {
    if (previousDefaultKey.current === savedDefaultKey) return;
    previousDefaultKey.current = savedDefaultKey;
    if (onboarding && !choosingDefault && savedDefaultKey) {
      setConfirmation(null);
    }
  }, [onboarding, choosingDefault, savedDefaultKey]);
  const [adding, setAdding] = React.useState(false);
  const [managing, setManaging] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [removeError, setRemoveError] = React.useState<{ providerId: string; message: string } | null>(null);
  const [envFallbackNotices, setEnvFallbackNotices] = React.useState<Record<string, string>>({});
  const [openCodeCandidates, setOpenCodeCandidates] = React.useState<PiOpenCodeImportCandidate[]>([]);
  const [selectedOpenCode, setSelectedOpenCode] = React.useState<Set<string>>(() => new Set());
  const knownOpenCodeIds = React.useRef<Set<string>>(new Set());
  const [openCodeDismissed, setOpenCodeDismissed] = React.useState(false);
  const [importingOpenCode, setImportingOpenCode] = React.useState(false);
  const [openCodeError, setOpenCodeError] = React.useState<string | null>(null);
  const [openCodeNotice, setOpenCodeNotice] = React.useState<string | null>(null);
  const [signIn, setSignIn] = React.useState<PiProviderInfo | null>(null);

  // Stable identity, so the signing dialog's effects don't restart on every parent render.
  const notifyChanged = useStableCallback((id: string, options?: ModelRefreshOptions) => onProviderChange?.(id, options));

  const notifyCatalog = useStableCallback((id: string, providers: PiProviderInfo[]) => onProviderCatalog?.(id, providers));

  const load = React.useCallback(async (id: string): Promise<PiProviderInfo[] | null> => {
    if (!mounted.current) return null;
    if (!id) {
      setProviders(null);
      setOpenCodeCandidates([]);
      setSelectedOpenCode(new Set());
      knownOpenCodeIds.current = new Set();
      return null;
    }
    const version = ++reads.current;
    setLoading(true);
    setError(null);
    const catalog = await piLoadProviders(id);
    if (!mounted.current || reads.current !== version) return null;
    if (!catalog) {
      setProviders(null);
      setDefaultModel(null);
      setOpenCodeCandidates([]);
      setSelectedOpenCode(new Set());
      knownOpenCodeIds.current = new Set();
      notifyCatalog(id, []);
      setError((endpoints.find(endpoint => endpoint.id === id)?.label ?? 'This Kiln') + ' did not return its providers. Check its connection in Computers and Containers, then use Refresh providers above.');
      setLoading(false);
      return null;
    }
    const importable = catalog.openCodeImportable ?? [];
    setOpenCodeCandidates(importable);
    setSelectedOpenCode((prev) => {
      const next = new Set<string>();
      for (const candidate of importable) {
        if (knownOpenCodeIds.current.has(candidate.id)) {
          if (prev.has(candidate.id)) next.add(candidate.id);
        } else if (candidate.type === 'api_key') {
          next.add(candidate.id);
        }
      }
      knownOpenCodeIds.current = new Set(importable.map((candidate) => candidate.id));
      return next;
    });
    setProviders(catalog.providers);
    notifyCatalog(id, catalog.providers);
    setDefaultModel(catalog.default ? `${catalog.default.provider} / ${catalog.default.modelId}` : null);
    setLoading(false);
    return catalog.providers;
  }, [notifyCatalog, endpoints]);

  React.useEffect(() => {
    void load(endpointId);
  }, [endpointId, load]);

  const confirmDefault = async (id: string, providerName: string, providerId?: string) => {
    if (!mounted.current) return;
    const version = ++defaultReads.current;
    setConfirmation({ endpointId: id, providerName, ...(providerId ? { providerId } : {}), catalog: null });
    const catalog = await piRefreshModels(id).catch(() => null);
    if (!mounted.current || defaultReads.current !== version) return;
    setConfirmation((current) => current?.endpointId === id ? { ...current, catalog } : current);
  };

  const save = async (provider: PiProviderInfo) => {
    if (busy !== null) return;
    const key = (drafts[provider.id] ?? '').trim();
    if (!key) return;
    setBusy(provider.id);
    setError(null);
    const id = endpointId;
    const hostLabel = endpoints.find(endpoint => endpoint.id === id)?.label ?? 'This Kiln';
    const result = await piSetProviderKey(id, provider.id, key);
    if (!mounted.current) return;
    setBusy(null);
    if (!result.ok) {
      setError(formatProviderActionError(hostLabel, provider.name, 'save', result.error));
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[provider.id];
      return next;
    });
    setEnvFallbackNotices((prev) => {
      if (!(provider.id in prev)) return prev;
      const next = { ...prev };
      delete next[provider.id];
      return next;
    });
    setRemoving((current) => (current === provider.id ? null : current));
    setRemoveError((current) => (current?.providerId === provider.id ? null : current));
    await load(id);
    if (!mounted.current) return;
    notifyChanged(id);
    await confirmDefault(id, provider.name, provider.id);
  };

  const remove = async (provider: PiProviderInfo) => {
    if (busy !== null) return;
    setBusy(provider.id);
    setError(null);
    setRemoveError(null);
    const id = endpointId;
    const hostLabel = endpoints.find(endpoint => endpoint.id === id)?.label ?? 'This Kiln';
    const result = await piRemoveProvider(id, provider.id);
    if (!mounted.current) return;
    if (!result.ok) {
      setBusy(null);
      setRemoveError({
        providerId: provider.id,
        message: formatProviderActionError(hostLabel, provider.name, 'remove', result.error),
      });
      return;
    }
    setRemoving((current) => (current === provider.id ? null : current));
    setRemoveError((current) => (current?.providerId === provider.id ? null : current));
    setDrafts((prev) => {
      if (!(provider.id in prev)) return prev;
      const next = { ...prev };
      delete next[provider.id];
      return next;
    });
    setConfirmation((current) => {
      if (!current || current.endpointId !== id) return current;
      const matches = current.providerId === provider.id || current.providerName === provider.name;
      if (matches) setChoosingDefault(false);
      return matches ? null : current;
    });
    const reloaded = await load(id);
    if (!mounted.current) return;
    setBusy(null);
    const updated = reloaded?.find((item) => item.id === provider.id);
    if (!updated?.credential && !updated?.envVar) {
      setManaging((current) => (current === provider.id ? null : current));
      setEnvFallbackNotices((prev) => {
        if (!(provider.id in prev)) return prev;
        const next = { ...prev };
        delete next[provider.id];
        return next;
      });
    } else if (!updated.credential && updated.envVar) {
      setEnvFallbackNotices((prev) => ({
        ...prev,
        [provider.id]: formatEnvFallbackNotice(hostLabel, provider.name, updated.envVar!),
      }));
    }
    notifyChanged(id, { upstream: false });
  };

  const importOpenCode = async () => {
    const selectedIds = openCodeCandidates
      .filter((candidate) => selectedOpenCode.has(candidate.id))
      .map((candidate) => candidate.id);
    if (selectedIds.length === 0 || importingOpenCode || busy !== null) return;
    const id = endpointId;
    const hostLabel = endpoints.find((endpoint) => endpoint.id === id)?.label ?? 'This Kiln';
    setImportingOpenCode(true);
    setOpenCodeError(null);
    setOpenCodeNotice(null);
    const result = await piImportOpenCodeProviders(id, selectedIds);
    if (!mounted.current) return;
    setImportingOpenCode(false);
    if (!result.ok) {
      const detail = sanitizeFailureDetail(result.error);
      setOpenCodeError(
        `${hostLabel} could not import OpenCode credentials${detail ? ` (${detail})` : ''}. Check that ${hostLabel} is running, then select Import selected again.`
      );
      return;
    }
    const importedNames = result.imported.map(
      (importedId) => openCodeCandidates.find((candidate) => candidate.id === importedId)?.name ?? importedId
    );
    await load(id);
    if (!mounted.current) return;
    notifyChanged(id);
    if (result.imported.length > 0) {
      setOpenCodeNotice(`Imported ${importedNames.join(', ')} to ${hostLabel}. Your OpenCode setup was not changed.`);
      if (result.imported.length === 1 && !onboarding && onDefaultChange) {
        await confirmDefault(id, importedNames[0]!, result.imported[0]);
      }
    } else {
      setOpenCodeNotice(`No new OpenCode credentials were imported to ${hostLabel}. Existing credentials stay unchanged.`);
    }
  };

  const hostLabel = endpoints.find((endpoint) => endpoint.id === endpointId)?.label ?? 'this computer';

  if (endpoints.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        Connect a Kiln in Computers and Containers first. Credentials live on each computer or container, not in this
        window.
      </p>
    );
  }

  if (!window.ember.piRequest) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This Ember cannot reach Kiln’s provider API. Open a current Ember desktop app to manage provider credentials.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b pb-5">
        <span className="text-xs text-muted-foreground">Providers on</span>
        <Select value={endpointId} onValueChange={onEndpointChange}>
          <SelectTrigger size="sm" className="min-w-0 flex-1 text-xs" aria-label="Computer or container for providers">
            <SelectValue placeholder="Select a computer or container" />
          </SelectTrigger>
          <SelectContent>
            {endpoints.map((endpoint) => {
              const status = instances.find((instance) => instance.id === endpoint.id)?.status;
              return (
                <SelectItem key={endpoint.id} value={endpoint.id}>
                  {endpoint.label}
                  {status && status !== 'ready' ? ` (${status === 'unreachable' ? 'down' : status})` : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => { setOpenCodeDismissed(false); setOpenCodeError(null); void load(endpointId); }}
          disabled={loading}
          aria-label="Refresh providers"
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">Credentials stay on the selected computer or container. Keys stay hidden here.</p>
      {!onboarding && (defaultModel || instanceDefaults[endpointId]?.model) ? (
        <p className="text-[11px] text-muted-foreground">New chats default to {instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : defaultModel}.</p>
      ) : null}
      {confirmation?.endpointId === endpointId && onDefaultChange ? (
        <div className="flex flex-col gap-2 rounded-lg border border-highlight/30 bg-highlight/5 p-3" role="region" aria-label="Default model for new chats">
          <p className="text-xs">{confirmation.providerName} is connected. Which model should new chats on {endpoints.find((endpoint) => endpoint.id === endpointId)?.label ?? 'this computer'} use?</p>
          <p className="text-xs text-muted-foreground">Current default: {instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : onboarding ? 'None chosen yet' : defaultModel ?? 'Server default'}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="secondary" onClick={() => { setConfirmation(null); setChoosingDefault(false); }}>Keep current default</Button>
            <Button size="xs" variant="outline" disabled={!confirmation.catalog} onClick={() => setChoosingDefault(true)}>Choose default model</Button>
            {!confirmation.catalog ? <Button size="xs" variant="ghost" onClick={() => void confirmDefault(endpointId, confirmation.providerName)}>Refresh models</Button> : null}
          </div>
        </div>
      ) : null}
      {confirmation?.catalog && choosingDefault && onDefaultChange ? (
        <ModelPicker open recentModels={[]} models={confirmation.catalog.models} value={instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : DEFAULT_MODEL} defaultModelId={confirmation.catalog.defaultModelId}
          instanceDefaultModelId={effectiveInstanceDefaultModel(instanceDefaults[confirmation.endpointId], confirmation.catalog.defaultModelId)}
          onSetInstanceDefault={(model) => onDefaultChange(confirmation.endpointId, withInstanceDefaultModel(instanceDefaults[confirmation.endpointId], model).model)}
          onRefresh={async () => {
            const next = await piRefreshModels(confirmation.endpointId).catch(() => null);
            if (!next || !mounted.current) return;
            setConfirmation((current) => current?.endpointId === confirmation.endpointId ? { ...current, catalog: next } : current);
            notifyChanged(confirmation.endpointId);
          }}
          onOpenChange={(nextOpen) => {
            setChoosingDefault(nextOpen);
            if (!nextOpen && onboarding && instanceDefaults[endpointId]?.model) {
              setConfirmation(null);
            }
          }} onSelect={(key, variant) => {
          const model = confirmation.catalog?.models.find((entry) => modelRefKey(entry) === key);
          if (key !== DEFAULT_MODEL && !model) return;
          onDefaultChange(confirmation.endpointId, model ? { providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) } : undefined);
          setChoosingDefault(false);
          setConfirmation(null);
        }} />
      ) : null}
      {error ? <p className="text-[11.5px] text-destructive">{error}</p> : null}
      {openCodeNotice ? (
        <p role="status" className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-foreground">
          {openCodeNotice}
        </p>
      ) : null}
      {openCodeCandidates.length > 0 && !openCodeDismissed ? (
        <div
          role="region"
          aria-label="Import OpenCode credentials"
          className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs"
        >
          <p className="text-foreground">
            Saved OpenCode credentials were found on {hostLabel}. Choose any you want to copy into Ember — your OpenCode setup won’t change.
          </p>
          <div className="flex flex-col gap-1.5">
            {openCodeCandidates.map((candidate) => (
              <label key={candidate.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedOpenCode.has(candidate.id)}
                  disabled={importingOpenCode || busy !== null}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelectedOpenCode((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(candidate.id);
                      else next.delete(candidate.id);
                      return next;
                    });
                  }}
                />
                <span className="font-medium text-foreground">{candidate.name}</span>
                <span className="text-muted-foreground">
                  {candidate.type === 'oauth' ? 'OAuth sign-in' : 'API key'}
                </span>
              </label>
            ))}
          </div>
          {openCodeCandidates.some((candidate) => candidate.type === 'oauth') ? (
            <p className="text-muted-foreground">
              OAuth sign-ins are unchecked by default. Signing in separately in Ember avoids token refresh conflicts with OpenCode.
            </p>
          ) : null}
          {openCodeError ? <p role="alert" className="text-destructive">{openCodeError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="secondary"
              disabled={selectedOpenCode.size === 0 || importingOpenCode || busy !== null}
              onClick={() => void importOpenCode()}
            >
              {importingOpenCode ? 'Importing…' : 'Import selected'}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={importingOpenCode}
              onClick={() => {
                setOpenCodeDismissed(true);
                setOpenCodeError(null);
              }}
            >
              Not now
            </Button>
          </div>
        </div>
      ) : null}

      {loading && !providers ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading providers…
        </p>
      ) : null}

      {providers && providers.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{endpoints.find(endpoint => endpoint.id === endpointId)?.label ?? 'This Kiln'} reported no providers. Use Refresh providers above, or check its connection in Computers and Containers.</p>
      ) : null}

      {inventory ? <div className="flex items-center justify-between gap-3 border-t pt-5">
        <div><h3 className="text-base font-semibold">Your providers</h3><p className="mt-1 text-xs text-muted-foreground">{providers?.filter(provider => provider.credential || provider.envVar).length ?? 0} configured</p></div>
        <Button disabled={loading || !providers} onClick={() => { focusChosenCredential.current = false; setAdding(true); }}>Add provider</Button>
      </div> : null}
      {inventory && providers && !providers.some(provider => provider.credential || provider.envVar) ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">No provider credentials configured on {endpoints.find(endpoint => endpoint.id === endpointId)?.label ?? 'this computer'} yet. Choose Add provider to connect one.</p> : null}
      {providers?.filter(provider => !provider.custom && provider.id !== 'ollama' && (!inventory || provider.credential || provider.envVar || managing === provider.id)).map((provider) => {
        const draft = drafts[provider.id] ?? '';
        const isBusy = busy === provider.id;
        return (
          <div key={provider.id} className="rounded-lg border bg-background px-4 py-4">
            <div className="flex items-center gap-2">
              <KeyRound className="size-3.5 flex-none text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={provider.id}>
                {provider.name}
              </span>
              {provider.credential ? (
                <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-foreground">
                  {credentialLabel[provider.credential]} saved
                </span>
              ) : provider.envVar ? null : (
                <span className="flex-none text-[10.5px] text-muted-foreground">No saved credential</span>
              )}
              {inventory ? <Button size="sm" variant="outline" aria-expanded={managing === provider.id} disabled={busy !== null} onClick={() => { setManaging(managing === provider.id ? null : provider.id); setRemoving(null); setRemoveError(null); }} aria-label={'Manage ' + provider.name}>Manage</Button> : null}
              {provider.credential ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => { setRemoveError(null); setRemoving(provider.id); }}
                  disabled={busy !== null}
                  aria-label={`Remove credential for ${provider.name}`}
                >
                  {isBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              ) : null}
            </div>
            {!provider.credential && envFallbackNotices[provider.id] && provider.envVar ? (
              <p role="status" className="mt-1 break-words text-xs text-muted-foreground">{envFallbackNotices[provider.id]}</p>
            ) : provider.envVar ? (
              <p className="mt-1 break-words text-xs text-muted-foreground">Kiln uses <code>{provider.envVar}</code>. To disconnect, unset it on the computer running this Kiln and restart Kiln.</p>
            ) : null}
            {removing === provider.id ? <div className="mt-3 space-y-2 rounded border p-3 text-xs" role="group" aria-label={'Remove ' + provider.name}>
              <p>Remove {provider.name}’s saved credential from {hostLabel}? Chat history, other connections, and other apps such as OpenCode stay unchanged.</p>
              {(instanceDefaults[endpointId]?.model?.providerID === provider.id || defaultModel?.startsWith(provider.id + ' / ')) ? <p className="text-warning">This provider supplies the default model. New chats may need another model or a new credential. Ember won’t choose a replacement.</p> : null}
              {removeError?.providerId === provider.id ? <p role="alert" className="text-destructive">{removeError.message}</p> : null}
              <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => { void remove(provider); }}>{isBusy ? 'Removing…' : 'Remove credential'}</Button>{' '}
              <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setRemoving(null); setRemoveError(null); }}>Keep credential</Button>
            </div> : null}
            {!inventory || managing === provider.id ? <>
            {provider.signIn ? (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => setSignIn(provider)}
                  disabled={isBusy}
                  className="min-w-0"
                >
                  {isBusy ? <Loader2 className="animate-spin" /> : <LogIn />}
                  <span className="truncate">
                    {provider.credential ? 'Sign in again' : provider.signIn.label}
                  </span>
                </Button>
                {provider.signIn.pending ? (
                  <span className="flex-none text-[10.5px] text-muted-foreground">signing in…</span>
                ) : null}
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <SecretInput
                ref={credentialField}
                autoFocus={inventory}
                value={draft}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void save(provider);
                  }
                }}
                placeholder={provider.credential === 'oauth' ? 'Or paste an API key instead' : provider.credential === 'api_key' ? 'Paste a new API key to replace' : 'Paste API key'}
                autoComplete="off"
                aria-label={`API key for ${provider.name}`}
                className="h-8 flex-1 text-xs"
              />
              <Button size="xs" variant="secondary" onClick={() => void save(provider)} disabled={busy !== null || !draft.trim()}>
                Save key
              </Button>
            </div>
            </> : null}
          </div>
        );
      })}

      {inventory ? <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent onCloseAutoFocus={event => {
          if (!focusChosenCredential.current) return;
          focusChosenCredential.current = false;
          event.preventDefault();
          credentialField.current?.focus({ preventScroll: true });
          credentialField.current?.scrollIntoView({ block: 'nearest' });
        }} className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader><DialogTitle>Add provider</DialogTitle><DialogDescription>Choose a provider to connect on {endpoints.find(endpoint => endpoint.id === endpointId)?.label}. Adding access never changes the default model by itself.</DialogDescription></DialogHeader>
          <div className="flex flex-col gap-2">
            {providers?.filter(provider => !provider.custom && provider.id !== 'ollama').map(provider => <Button key={provider.id} variant="outline" className="min-h-11 justify-between" onClick={() => { focusChosenCredential.current = true; setAdding(false); setManaging(provider.id); }}>
              {provider.name}<span className="text-xs text-muted-foreground">{provider.credential ? 'Manage saved access' : provider.envVar ? 'Using environment' : 'Connect'}</span>
            </Button>)}
            <p className="mt-3 text-xs text-muted-foreground">For Ollama or a custom OpenAI-compatible server, use the sections below Your providers.</p>
          </div>
        </DialogContent>
      </Dialog> : null}
      <details className="rounded-lg border p-3"><summary className="cursor-pointer py-2 text-sm font-medium">Local models · Ollama</summary>
      <OllamaSetup key={'ollama-' + endpointId} endpointId={endpointId} hostName={endpoints.find(endpoint => endpoint.id === endpointId)?.label ?? 'this Kiln'} onChange={async connected => {
        await load(endpointId);
        if (!mounted.current) return;
        notifyChanged(endpointId);
        if (connected) await confirmDefault(endpointId, 'Ollama');
      }} />
      </details>
      <CustomProviders key={endpointId} endpointId={endpointId} hostName={endpoints.find(endpoint => endpoint.id === endpointId)?.label ?? 'this Kiln'} onChange={async (name) => {
        await load(endpointId);
        if (!mounted.current) return;
        notifyChanged(endpointId, { upstream: false });
        if (name) await confirmDefault(endpointId, name);
      }} />
      <ProviderSharing endpoints={endpoints} instances={instances} onProviderChange={(id, options) => { void notifyChanged(id, options); if (id === endpointId) void load(id); }} />

      {signIn ? (
        <ProviderSignInDialog
          open
          endpointId={endpointId}
          providerId={signIn.id}
          providerName={signIn.id === 'openai-codex' ? 'OpenAI (ChatGPT Plus/Pro)' : signIn.name}
          onOpenChange={(open) => {
            if (!open) setSignIn(null);
          }}
          onSignedIn={() => {
            setEnvFallbackNotices((prev) => {
              if (!(signIn.id in prev)) return prev;
              const next = { ...prev };
              delete next[signIn.id];
              return next;
            });
            void load(endpointId);
            notifyChanged(endpointId);
            void confirmDefault(endpointId, signIn.name, signIn.id);
          }}
        />
      ) : null}
    </div>
  );
}
