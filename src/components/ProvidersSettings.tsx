import * as React from 'react';
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
import { piLoadProviders, piRemoveProvider, piSetProviderKey, type PiProviderInfo } from '../piApi';
import { DEFAULT_MODEL, modelRefKey } from '../types';
import ModelPicker from './ModelPicker';
import { piLoadModels } from '../piApi';
import type { ModelList } from '../api';
import type { InstanceDefaults, ModelRef, Instance, PiEndpoint } from '../types';
import ProviderSignInDialog from '@/components/ProviderSignInDialog';

type Props = {
  endpoints: PiEndpoint[];
  instances: Instance[];
  /**
   * Called after a credential changes (saved, removed, or signed in) for this host. The model list
   * a host offers is a *consequence* of which credentials it holds, so without this the pickers
   * kept offering models from a provider whose key had just been removed — and omitting the ones
   * a new key unlocked — until the next poll happened to land.
   */
  onProviderChange?: (endpointId: string) => void;
  /**
   * Which host to show first. Set when the panel is opened *for* a host — the picker's "Add
   * providers…" from a session names its own instance — so the screen lands on the machine that
   * needs the credential rather than whichever endpoint happens to be first.
   */
  initialEndpointId?: string;
  instanceDefaults?: Record<string, InstanceDefaults>;
  onDefaultChange?: (endpointId: string, model: ModelRef | undefined) => void;
};

const credentialLabel: Record<NonNullable<PiProviderInfo['credential']>, string> = {
  api_key: 'API key',
  oauth: 'OAuth',
};

/**
 * Provider credentials, one Hearth host at a time. `GET /providers` reports only the
 * credential *type* a host holds; a key set here is written to that host's
 * `$HEARTH_HOME/auth.json` and is never sent back or rendered. OAuth providers (xAI, OpenAI)
 * sign in on the host with `hearth.sh provider login`, so this panel only manages API keys.
 */
export default function ProvidersSettings({ endpoints, instances, onProviderChange, initialEndpointId, instanceDefaults = {}, onDefaultChange }: Props) {
  const [endpointId, setEndpointId] = React.useState(initialEndpointId ?? endpoints[0]?.id ?? '');
  const [providers, setProviders] = React.useState<PiProviderInfo[] | null>(null);
  const [defaultModel, setDefaultModel] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  /** The provider whose sign-in dialog is open, if any. */
  const [confirmation, setConfirmation] = React.useState<{ endpointId: string; providerName: string; catalog: ModelList | null } | null>(null);
  const [choosingDefault, setChoosingDefault] = React.useState(false);
  const [signIn, setSignIn] = React.useState<PiProviderInfo | null>(null);

  React.useEffect(() => {
    if (initialEndpointId && endpoints.some((endpoint) => endpoint.id === initialEndpointId)) {
      setEndpointId(initialEndpointId);
      return;
    }
    if (!endpoints.some((endpoint) => endpoint.id === endpointId)) {
      setEndpointId(endpoints[0]?.id ?? '');
    }
  }, [endpointId, endpoints, initialEndpointId]);

  // Stable identity, so the signing dialog's effects don't restart on every parent render.
  const notifyChanged = useStableCallback((id: string) => onProviderChange?.(id));

  const load = React.useCallback(async (id: string) => {
    if (!id) {
      setProviders(null);
      return;
    }
    setLoading(true);
    setError(null);
    const catalog = await piLoadProviders(id);
    if (!catalog) {
      setProviders(null);
      setDefaultModel(null);
      setError('Could not load providers from this ember-harness — check the endpoint and retry.');
      setLoading(false);
      return;
    }
    setProviders(catalog.providers);
    setDefaultModel(catalog.default ? `${catalog.default.provider} / ${catalog.default.modelId}` : null);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load(endpointId);
  }, [endpointId, load]);

  const confirmDefault = async (id: string, providerName: string) => {
    setConfirmation({ endpointId: id, providerName, catalog: null });
    const catalog = await piLoadModels(id).catch(() => null);
    setConfirmation((current) => current?.endpointId === id ? { ...current, catalog } : current);
  };

  const save = async (provider: PiProviderInfo) => {
    const key = (drafts[provider.id] ?? '').trim();
    if (!key) return;
    setBusy(provider.id);
    setError(null);
    const result = await piSetProviderKey(endpointId, provider.id, key);
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
    notifyChanged(endpointId);
    await confirmDefault(endpointId, provider.name);
  };

  const remove = async (provider: PiProviderInfo) => {
    setBusy(provider.id);
    setError(null);
    const result = await piRemoveProvider(endpointId, provider.id);
    setBusy(null);
    if (!result.ok) {
      setError(`${provider.name}: ${result.error ?? 'could not remove the credential'}`);
      return;
    }
    await load(endpointId);
    notifyChanged(endpointId);
  };

  if (endpoints.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        Add an ember-harness endpoint first. Credentials live on each ember-harness host, not in this
        window.
      </p>
    );
  }

  if (!window.ember.piRequest) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This Ember bridge can't reach ember-harness directly; update Ember to manage provider credentials.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select value={endpointId} onValueChange={(id) => { setEndpointId(id); setConfirmation(null); setChoosingDefault(false); }}>
          <SelectTrigger size="sm" className="min-w-0 flex-1 text-xs" aria-label="ember-harness host">
            <SelectValue placeholder="Select a host" />
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

      {defaultModel || instanceDefaults[endpointId]?.model ? (
        <p className="text-[11px] text-muted-foreground">New chats default to {instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : defaultModel}.</p>
      ) : null}
      {confirmation?.endpointId === endpointId && onDefaultChange ? (
        <div className="flex flex-col gap-2 rounded-lg border border-highlight/30 bg-highlight/5 p-3" role="region" aria-label="Confirm instance default">
          <p className="text-xs">{confirmation.providerName} is connected. Which model should new chats on {endpoints.find((endpoint) => endpoint.id === endpointId)?.label ?? 'this instance'} use?</p>
          <p className="text-xs text-muted-foreground">Current default: {instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : defaultModel ?? 'Server default'}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="secondary" onClick={() => { setConfirmation(null); setChoosingDefault(false); }}>Keep current default</Button>
            <Button size="xs" variant="outline" disabled={!confirmation.catalog} onClick={() => setChoosingDefault(true)}>Choose default model</Button>
            {!confirmation.catalog ? <Button size="xs" variant="ghost" onClick={() => void confirmDefault(endpointId, confirmation.providerName)}>Refresh models</Button> : null}
          </div>
        </div>
      ) : null}
      {confirmation?.catalog && choosingDefault && onDefaultChange ? (
        <ModelPicker open recentModels={[]} models={confirmation.catalog.models} value={instanceDefaults[endpointId]?.model ? modelRefKey(instanceDefaults[endpointId].model) : DEFAULT_MODEL} defaultModelId={confirmation.catalog.defaultModelId} onOpenChange={setChoosingDefault} onSelect={(key, variant) => {
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
        <p className="text-[12px] text-muted-foreground">This ember-harness reports no providers.</p>
      ) : null}

      {providers?.map((provider) => {
        const draft = drafts[provider.id] ?? '';
        const isBusy = busy === provider.id;
        return (
          <div key={provider.id} className="rounded-lg border bg-muted/20 px-3 py-2">
            <div className="flex items-center gap-2">
              <KeyRound className="size-3.5 flex-none text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={provider.id}>
                {provider.name}
              </span>
              {provider.credential ? (
                <span className="flex-none rounded bg-success/10 px-1.5 py-0.5 text-[10.5px] text-success">
                  {credentialLabel[provider.credential]}
                </span>
              ) : (
                <span className="flex-none text-[10.5px] text-muted-foreground">no credential</span>
              )}
              {provider.credential ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void remove(provider)}
                  disabled={isBusy}
                  aria-label={`Remove credential for ${provider.name}`}
                >
                  {isBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </Button>
              ) : null}
            </div>
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
                value={draft}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void save(provider);
                  }
                }}
                placeholder={provider.credential === 'oauth' ? 'Or paste an API key instead' : 'Paste API key'}
                autoComplete="off"
                aria-label={`API key for ${provider.name}`}
                className="h-8 flex-1 text-xs"
              />
              <Button size="xs" variant="secondary" onClick={() => void save(provider)} disabled={isBusy || !draft.trim()}>
                Save
              </Button>
            </div>
          </div>
        );
      })}

      {signIn ? (
        <ProviderSignInDialog
          open
          endpointId={endpointId}
          providerId={signIn.id}
          providerName={signIn.name}
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
