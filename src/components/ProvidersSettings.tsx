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
import { piLoadProviders, piRemoveProvider, piSetProviderKey, type PiProviderInfo } from '../piApi';
import { DEFAULT_MODEL, modelRefKey } from '../types';
import ModelPicker from './ModelPicker';
import { piRefreshModels } from '../piApi';
import type { ModelList } from '../api';
import type { InstanceDefaults, ModelRef, Instance, PiEndpoint } from '../types';
import ProviderSignInDialog from '@/components/ProviderSignInDialog';
import ProviderSharing from './ProviderSharing';
import type { ModelRefreshOptions } from '@/lib/providerSharing';
import CustomProviders from './CustomProviders';
import OllamaSetup from './OllamaSetup';

type Props = {
  inventory?: boolean;
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
 * Provider credentials, one Hearth host at a time. `GET /providers` reports only the
 * credential *type* a host holds; a key set here is written to that host's
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

/** A host transition remounts every credential draft, action and dialog together. */
function HostProvidersSettings({ inventory = false, endpoints, instances, onProviderChange, instanceDefaults = {}, onDefaultChange, onProviderCatalog, endpointId, onEndpointChange }: Props & { endpointId: string; onEndpointChange: (id: string) => void }) {
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
  const [confirmation, setConfirmation] = React.useState<{ endpointId: string; providerName: string; catalog: ModelList | null } | null>(null);
  const [choosingDefault, setChoosingDefault] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [managing, setManaging] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [signIn, setSignIn] = React.useState<PiProviderInfo | null>(null);

  // Stable identity, so the signing dialog's effects don't restart on every parent render.
  const notifyChanged = useStableCallback((id: string, options?: ModelRefreshOptions) => onProviderChange?.(id, options));

  const notifyCatalog = useStableCallback((id: string, providers: PiProviderInfo[]) => onProviderCatalog?.(id, providers));

  const load = React.useCallback(async (id: string) => {
    if (!mounted.current) return;
    if (!id) {
      setProviders(null);
      return;
    }
    const version = ++reads.current;
    setLoading(true);
    setError(null);
    const catalog = await piLoadProviders(id);
    if (!mounted.current || reads.current !== version) return;
    if (!catalog) {
      setProviders(null);
      setDefaultModel(null);
      notifyCatalog(id, []);
      setError((endpoints.find(endpoint => endpoint.id === id)?.label ?? 'This Kiln') + ' did not return its providers. Check its connection in Computers and Containers, then use Refresh providers above.');
      setLoading(false);
      return;
    }
    setProviders(catalog.providers);
    notifyCatalog(id, catalog.providers);
    setDefaultModel(catalog.default ? `${catalog.default.provider} / ${catalog.default.modelId}` : null);
    setLoading(false);
  }, [notifyCatalog, endpoints]);

  React.useEffect(() => {
    void load(endpointId);
  }, [endpointId, load]);

  const confirmDefault = async (id: string, providerName: string) => {
    if (!mounted.current) return;
    const version = ++defaultReads.current;
    setConfirmation({ endpointId: id, providerName, catalog: null });
    const catalog = await piRefreshModels(id).catch(() => null);
    if (!mounted.current || defaultReads.current !== version) return;
    setConfirmation((current) => current?.endpointId === id ? { ...current, catalog } : current);
  };

  const save = async (provider: PiProviderInfo) => {
    const key = (drafts[provider.id] ?? '').trim();
    if (!key) return;
    setBusy(provider.id);
    setError(null);
    const id = endpointId;
    const result = await piSetProviderKey(id, provider.id, key);
    if (!mounted.current) return;
    setBusy(null);
    if (!result.ok) {
      setError(`${provider.name}: ${result.error ?? 'could not save the key'}`);
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[provider.id];
      return next;
    });
    await load(endpointId);
    if (!mounted.current) return;
    notifyChanged(endpointId);
    await confirmDefault(endpointId, provider.name);
  };

  const remove = async (provider: PiProviderInfo) => {
    setBusy(provider.id);
    setError(null);
    const id = endpointId;
    const result = await piRemoveProvider(id, provider.id);
    if (!mounted.current) return;
    setBusy(null);
    if (!result.ok) {
      setError(`${provider.name}: ${result.error ?? 'could not remove the credential'}`);
      return;
    }
    await load(endpointId);
    if (mounted.current) notifyChanged(endpointId);
  };

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
          onClick={() => void load(endpointId)}
          disabled={loading}
          aria-label="Refresh providers"
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">Credentials stay on the selected computer or container. Keys stay hidden here.</p>
      {defaultModel || instanceDefaults[endpointId]?.model ? (
        <p className="text-[11px] text-muted-foreground">New chats default to {instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : defaultModel}.</p>
      ) : null}
      {confirmation?.endpointId === endpointId && onDefaultChange ? (
        <div className="flex flex-col gap-2 rounded-lg border border-highlight/30 bg-highlight/5 p-3" role="region" aria-label="Default model for new chats">
          <p className="text-xs">{confirmation.providerName} is connected. Which model should new chats on {endpoints.find((endpoint) => endpoint.id === endpointId)?.label ?? 'this computer'} use?</p>
          <p className="text-xs text-muted-foreground">Current default: {instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : defaultModel ?? 'Server default'}</p>
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
          onOpenChange={setChoosingDefault} onSelect={(key, variant) => {
          const model = confirmation.catalog?.models.find((entry) => modelRefKey(entry) === key);
          if (key !== DEFAULT_MODEL && !model) return;
          onDefaultChange(confirmation.endpointId, model ? { providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) } : undefined);
          setChoosingDefault(false);
          setConfirmation(null);
        }} />
      ) : null}
      {error ? <p className="text-[11.5px] text-destructive">{error}</p> : null}

      {loading && !providers ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading providers…
        </p>
      ) : null}

      {providers && providers.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{endpoints.find(endpoint => endpoint.id === endpointId)?.label ?? 'This Kiln'} reported no providers. Use Refresh providers above, or check its connection in Computers and Containers.</p>
      ) : null}

      {inventory ? <div className="flex items-center justify-between gap-3 border-t pt-5">
        <div><h3 className="text-base font-semibold">Your providers</h3><p className="mt-1 text-xs text-muted-foreground">{providers?.filter(provider => provider.credential).length ?? 0} with saved credentials</p></div>
        <Button disabled={loading || !providers} onClick={() => { focusChosenCredential.current = false; setAdding(true); }}>Add provider</Button>
      </div> : null}
      {inventory && providers && !providers.some(provider => provider.credential) ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">No saved provider credentials on {endpoints.find(endpoint => endpoint.id === endpointId)?.label ?? 'this computer'} yet. Choose Add provider to connect one.</p> : null}
      {providers?.filter(provider => !provider.custom && provider.id !== 'ollama' && (!inventory || !!provider.credential || managing === provider.id)).map((provider) => {
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
              ) : (
                <span className="flex-none text-[10.5px] text-muted-foreground">No saved credential</span>
              )}
              {inventory ? <Button size="sm" variant="outline" aria-expanded={managing === provider.id} onClick={() => { setManaging(managing === provider.id ? null : provider.id); setRemoving(null); }} aria-label={'Manage ' + provider.name}>Manage</Button> : null}
              {provider.credential && (!inventory || managing === provider.id) ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => setRemoving(provider.id)}
                  disabled={isBusy}
                  aria-label={`Remove credential for ${provider.name}`}
                >
                  {isBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              ) : null}
            </div>
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
              <Button size="xs" variant="secondary" onClick={() => void save(provider)} disabled={isBusy || !draft.trim()}>
                Save key
              </Button>
            </div>
            {removing === provider.id ? <div className="mt-3 space-y-2 rounded border p-3 text-xs" role="group" aria-label={'Remove ' + provider.name}>
              <p>Remove {provider.name}’s saved credential from {endpoints.find(endpoint => endpoint.id === endpointId)?.label}? Chat history and other connections stay unchanged.</p>
              {(instanceDefaults[endpointId]?.model?.providerID === provider.id || defaultModel?.startsWith(provider.id + ' / ')) ? <p className="text-warning">This provider supplies the default model. New chats may need another model or a new credential. Ember won’t choose a replacement.</p> : null}
              <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => { void remove(provider); setRemoving(null); }}>Remove credential</Button>{' '}
              <Button size="sm" variant="outline" onClick={() => setRemoving(null)}>Keep credential</Button>
            </div> : null}
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
              {provider.name}<span className="text-xs text-muted-foreground">{provider.credential ? 'Manage saved access' : 'Connect'}</span>
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
        notifyChanged(endpointId);
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
            void load(endpointId);
            notifyChanged(endpointId);
            void confirmDefault(endpointId, signIn.name);
          }}
        />
      ) : null}
    </div>
  );
}
