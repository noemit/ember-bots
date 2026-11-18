import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  parseSharingProviders,
  selectedTargets,
  selectionKey,
  sharingBlock,
  sharingCandidates,
  sharingHostMessage,
  sharingSetupGuidance,
  experimentalSignIn,
  destinationProviders,
  runProviderShare,
  sameDefinition,
  type ModelRefreshOptions,
  type SharingHost,
  type ConfigIdentity,
  type ShareWizardState,
} from '../lib/providerSharing';
import type { Instance, PiEndpoint } from '../types';

export type ProviderSharingProps = {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onProviderChange?: (id: string, options?: ModelRefreshOptions) => Promise<unknown> | void;
  defaultOpen?: boolean;
  initialWizard?: Partial<ShareWizardState>;
};

const selectControlClass =
  'min-w-0 max-w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const checkboxControlClass =
  'mt-0.5 size-3.5 shrink-0 rounded border border-input bg-background accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

function ConfigReview({ config, label }: { config: ConfigIdentity; label: string }) {
  return <div className="mt-2 break-words text-muted-foreground"><p className="font-medium">{label}</p><dl aria-label={label}>
    <div><dt className="inline font-medium">Name: </dt><dd className="inline">{config.name}</dd></div>
    <div><dt className="inline font-medium">Provider ID: </dt><dd className="inline">{config.id}</dd></div>
    <div><dt className="inline font-medium">API address: </dt><dd className="inline">{config.baseUrl}</dd></div>
    <div><dt className="inline font-medium">Models: </dt><dd className="inline">{config.modelIds.join(', ') || 'None configured'}</dd></div>
  </dl></div>;
}

/** Shared review surface. Provider credentials travel host-to-host, never through this component. */
export default function ProviderSharing({ endpoints, instances, onProviderChange, defaultOpen = false, initialWizard }: ProviderSharingProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [busy, setBusy] = React.useState(false);
  const [hosts, setHosts] = React.useState<SharingHost[] | null>(initialWizard?.hosts ?? null);
  const [step, setStep] = React.useState(initialWizard?.step ?? 0);
  const [destination, setDestination] = React.useState(initialWizard?.destination ?? '');
  const stepHeading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => { stepHeading.current?.focus(); }, [step]);
  const [source, setSource] = React.useState(initialWizard?.source ?? '');
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(initialWizard?.selected));
  const [experimental, setExperimental] = React.useState(initialWizard?.experimental ?? false);
  const [notice, setNotice] = React.useState(initialWizard?.notice ?? '');
  const reviewed = React.useRef(initialWizard?.hosts ? JSON.stringify(endpoints) : '');
  const latest = React.useRef(endpoints);
  latest.current = endpoints;
  const desktop = endpoints.every(endpoint => endpoint.hasToken === undefined);
  const candidates = sharingCandidates(endpoints, instances);
  const canCompare = candidates.length >= 2;
  const guidance = sharingSetupGuidance(candidates);
  const hasBridge = typeof window !== 'undefined' && Boolean(window.ember?.piRequest);
  const inspect = async () => {
    if (!desktop || !canCompare || typeof window === 'undefined' || !window.ember?.piRequest) return;
    const piRequest = window.ember.piRequest;
    setBusy(true); setNotice(''); setHosts(null); setSelected(new Set()); setSource(''); setExperimental(false); setDestination(''); setStep(0);
    const config = JSON.stringify(endpoints);
    reviewed.current = config;
    try {
      const rows = await Promise.all(candidates.map(async (endpoint: PiEndpoint): Promise<SharingHost> => {
        try {
          const response = await piRequest<unknown>(endpoint.id, '/alignment');
          if (!response.ok) return { endpoint, state: [404, 405, 501].includes(response.status) ? 'unsupported' : 'unavailable', providers: [] };
          const providers = parseSharingProviders(response.data);
          return { endpoint, state: providers ? 'ready' : 'unsupported', providers: providers ?? [] };
        } catch { return { endpoint, state: 'unavailable', providers: [] }; }
      }));
      if (config !== JSON.stringify(latest.current)) { setNotice('Your Kiln connections changed. Compare again before choosing providers.'); return; }
      setHosts(rows);
    } finally { setBusy(false); }
  };
  const share = async () => {
    if (!desktop || !hosts || typeof window === 'undefined' || !window.ember?.piRequest) return;
    const piRequest = window.ember.piRequest;
    if (reviewed.current !== JSON.stringify(latest.current)) {
      setHosts(null); setSelected(new Set()); setExperimental(false); setSource(''); setDestination(''); setStep(0);
      setNotice('Your Kiln connections changed. Compare again before sharing providers.'); return;
    }
    const targets = selectedTargets(hosts, source, selected, experimental).filter(target => target.id === destination);
    if (step !== 3) return;
    if (!targets.length) return;
    setBusy(true); setNotice('');
    try {
      const outcome = await runProviderShare({
        state: { hosts, step, source, destination, selected, experimental, notice: '' },
        targets,
        send: (sourceId, shareTargets) => piRequest<{ results: Array<{ id: string; ok: boolean; keys?: number }> }>(sourceId, '/alignment/share', { method: 'POST', body: { targets: shareTargets } }),
        onProviderChange,
      });
      if (outcome.succeeded) {
        setHosts(null);
        setSelected(new Set());
        setExperimental(false);
        setSource('');
        setDestination('');
        setStep(0);
      }
      setNotice(outcome.state.notice);
    } finally { setBusy(false); }
  };
  const sourceHost = hosts?.find(host => host.endpoint.id === source);
  const sourceProviders = sourceHost?.providers.filter(provider => provider.hasCredential) ?? [];
  const targets = hosts ? selectedTargets(hosts, source, selected, experimental).filter(target => target.id === destination) : [];
  const destinationHost = hosts?.find(host => host.endpoint.id === destination);
  const count = targets.reduce((total, target) => total + target.providers.length, 0);
  const comparisonProviders = (hosts?.flatMap(host => host.providers) ?? []).filter((provider, index, all) => all.findIndex(other => provider.configIdentity && other.configIdentity ? sameDefinition(provider.configIdentity, other.configIdentity) : provider.providerId === other.providerId) === index);
  return <section className="rounded-lg border px-3 py-3" aria-label="Share providers across Kilns">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-xs font-medium">Share providers across Kilns</h3>
        <p className="mt-1 text-xs text-muted-foreground">Add missing provider credentials to another Kiln.</p></div>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Close review' : 'Review and share'}</Button>
    </div>
    {open ? <div className="mt-3 flex flex-col gap-3 text-xs">
      {!desktop ? <p>Provider sharing is available in the Ember desktop app. Open Settings → Providers there to review your Kilns.</p> : <>
        <p className="text-muted-foreground">Existing credentials and model defaults stay unchanged. Credentials travel directly between Kilns; Ember reads metadata only.</p>
        <Button size="xs" variant="outline" disabled={busy || !canCompare || !hasBridge} onClick={() => void inspect()}>{busy ? <Loader2 className="animate-spin" /> : null}Compare providers</Button>
        {guidance ? <p>{guidance}</p> : null}
        {canCompare && hosts ? <>
          <nav aria-label="Sharing steps" className="flex flex-wrap gap-2">{['Source', 'Destination', 'Providers', 'Review'].map((label, index) => <Button key={label} size="xs" variant={step === index ? 'secondary' : 'ghost'} disabled={busy || index > step} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}>{index + 1}. {label}</Button>)}</nav>
          <h4 ref={stepHeading} tabIndex={-1} className="font-medium">{['Choose the source Kiln', 'Choose the destination Kiln', 'Choose providers to share', 'Review before sharing'][step]}</h4>
          <details><summary className="cursor-pointer">Compare all provider metadata</summary>
          <ul className="mt-2 space-y-1" aria-label="Kiln comparison status">{hosts.map(host => <li key={host.endpoint.id}>{sharingHostMessage(host)}</li>)}</ul>
          <div className="max-h-64 overflow-auto rounded border p-2" aria-label="Provider availability">
            {comparisonProviders.map(exemplar => <div key={JSON.stringify(exemplar.configIdentity ? ['custom', exemplar.configIdentity.name, exemplar.configIdentity.baseUrl, exemplar.configIdentity.modelIds] : ['provider', exemplar.providerId])} className="py-1">
              <strong>{exemplar.configIdentity?.name ?? exemplar.providerId}</strong>
              <ul className="ml-3 text-muted-foreground">{hosts.map(host => {
                const matches = destinationProviders(exemplar, host);
                const provider = matches[0];
                return <li key={host.endpoint.id}>{host.endpoint.label} · {host.state !== 'ready' ? 'Not compared' : matches.length > 1 ? 'Multiple matching provider definitions — review before sharing' : !provider?.hasCredential ? 'Missing credential' : provider.source === 'environment' ? 'Environment key — available here, not exported' : provider.type === 'oauth' ? 'Signed in' : 'Stored API key'}
                  {matches.filter(row => row.configIdentity).map(row => <ConfigReview key={row.providerId} config={row.configIdentity!} label={`${row.providerId} configuration on ${host.endpoint.label}`} />)}
                </li>;
              })}</ul>
            </div>)}
            {!hosts.some(host => host.providers.length) ? <p>No provider credentials were reported. Add a key or sign in on a Kiln, then compare again.</p> : null}
          </div>
          </details>
          {step === 0 ? <><label className="flex flex-wrap items-center gap-2">Source Kiln<select aria-label="Provider sharing source" className={selectControlClass} disabled={busy} value={source} onChange={event => { setSource(event.target.value); setSelected(new Set()); setExperimental(false); setDestination(''); }}>
            <option value="">Choose a source</option>{hosts.filter(host => host.state === 'ready').map(host => <option value={host.endpoint.id} key={host.endpoint.id}>{host.endpoint.label}</option>)}
          </select></label>
          {sourceHost ? <p className="break-all text-muted-foreground">{sourceHost.endpoint.label} · {sourceHost.endpoint.url}</p> : null}
          <Button size="xs" disabled={busy || !sourceHost} onClick={() => setStep(1)}>Continue to destination</Button></> : null}
          {step === 1 ? <><label className="flex flex-wrap items-center gap-2">Destination Kiln<select aria-label="Provider sharing destination" className={selectControlClass} disabled={busy} value={destination} onChange={event => { setDestination(event.target.value); setSelected(new Set()); setExperimental(false); }}>
            <option value="">Choose a destination</option>{hosts.filter(host => host.endpoint.id !== source).map(host => <option value={host.endpoint.id} key={host.endpoint.id}>{host.endpoint.label}</option>)}
          </select></label>
          {destinationHost ? <><p className="break-all text-muted-foreground">Kiln address: {destinationHost.endpoint.url}</p><p>{sharingHostMessage(destinationHost)}</p></> : null}
          <Button size="xs" disabled={busy || !destinationHost || destinationHost.state !== 'ready'} onClick={() => setStep(2)}>Continue to providers</Button></> : null}
          {sourceHost && (step === 2 || step === 3) ? <>
            <p className="break-words text-muted-foreground">Credentials go directly from {sourceHost.endpoint.label} ({sourceHost.endpoint.url}) to {destinationHost?.endpoint.label} ({destinationHost?.endpoint.url}).{step === 2 ? ` Anyone with access to ${destinationHost?.endpoint.label} can use the provider accounts you share.` : ''}</p>
            {sourceProviders.some(provider => provider.configIdentity) ? <details className="rounded border p-2"><summary className="cursor-pointer">Review custom provider configurations on {sourceHost.endpoint.label}</summary>
              {sourceProviders.filter(provider => provider.configIdentity).map(provider => <ConfigReview key={provider.providerId} config={provider.configIdentity!} label={`Source configuration for ${provider.providerId}`} />)}
            </details> : null}
            {step === 2 && sourceProviders.some(experimentalSignIn) ? <div className="rounded border p-2">
              <label className="flex items-start gap-2"><input type="checkbox" className={checkboxControlClass} checked={experimental} disabled={busy} onChange={event => { setExperimental(event.target.checked); setSelected(new Set()); }} />Enable experimental Codex and Antigravity sign-in sharing</label>
              <p className="mt-1 text-muted-foreground">Independent Kilns refresh sign-in tokens separately, which can sign out either Kiln or conflict with provider policies. Signing in on each Kiln separately is safer.</p>
            </div> : null}
            {!sourceProviders.length ? <p>{sourceHost.endpoint.label} has no provider credentials to share. Add a key or sign in there, then compare again.</p> : null}
            {step === 2 ? hosts.filter(host => host.endpoint.id === destination).map(host => <fieldset key={host.endpoint.id} disabled={busy} className="rounded border p-2">
              <legend className="px-1 font-medium">{host.endpoint.label}</legend>
              <p className="mb-1 break-all text-muted-foreground">Kiln address: {host.endpoint.url || 'No address configured'}</p>
              {sourceProviders.map(provider => {
                const key = selectionKey(host.endpoint.id, provider.providerId);
                const blocked = sharingBlock(provider, host, experimental);
                const destinationMatches = destinationProviders(provider, host);
                const destinationReview = destinationMatches.length ? destinationMatches : host.providers.filter(row => row.configIdentity && (row.providerId === provider.providerId || row.configIdentity.name === provider.configIdentity?.name));
                return <div key={key} className="py-1"><label className="flex items-start gap-2"><input type="checkbox" className={checkboxControlClass} aria-label={`Share ${provider.providerId} to ${host.endpoint.label}`} disabled={Boolean(blocked)} checked={!blocked && selected.has(key)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(key); else next.delete(key); return next; })} /><span>{provider.providerId} · {provider.source === 'environment' ? 'Environment key' : provider.type === 'oauth' ? 'Subscription sign-in' : 'API key'}</span></label>
                  <p className="ml-5 text-muted-foreground">{blocked ?? 'Missing — selected credentials will be added only if still missing.'}</p>
                  {provider.configIdentity ? <div className="ml-5">
                    <ConfigReview config={provider.configIdentity} label={`Source ${sourceHost.endpoint.label} configuration for ${provider.providerId}`} />
                    {destinationReview.some(row => row.configIdentity) ? destinationReview.map(row => <ConfigReview key={row.providerId} config={row.configIdentity!} label={`Destination ${host.endpoint.label} configuration for ${provider.providerId}`} />) : <p className="mt-1 text-muted-foreground">{host.endpoint.label} has no matching custom configuration to review.</p>}
                  </div> : null}
                </div>;
              })}
            </fieldset>) : null}
            <p className="text-muted-foreground">Custom providers require the exact same provider name, base URL and model IDs on both Kilns. Missing or changed configurations are skipped; sharing never installs configuration.</p>
            {step === 2 ? <Button size="xs" disabled={busy || !targets.length} onClick={() => setStep(3)}>Review {count} {count === 1 ? 'selection' : 'selections'}</Button> : <>
              <p className="font-medium">Share {count} {count === 1 ? 'credential' : 'credentials'} with {destinationHost?.endpoint.label}</p>
              <p className="text-muted-foreground">Scope: anyone able to use the destination Kiln can use these provider accounts. Only missing credentials are added. No connections, provider configurations or model defaults are changed.</p>
              <ul aria-label="Reviewed providers" className="space-y-2">{targets.flatMap(target => target.providers.map(provider => <li key={provider.providerId}>
                <strong>{provider.providerId}</strong> · {provider.type === 'oauth' ? 'Experimental subscription sign-in — token refresh may break either sign-in' : 'Stored API key'}
                {provider.configIdentity ? <ConfigReview config={provider.configIdentity} label={'Reviewed source configuration for ' + provider.providerId} /> : null}
                {provider.destinationConfigIdentity ? <ConfigReview config={provider.destinationConfigIdentity} label={'Reviewed destination configuration for ' + provider.providerId} /> : null}
              </li>))}</ul>
              <Button size="xs" className="self-start max-w-full whitespace-normal h-auto min-h-9" disabled={busy || !targets.length} onClick={() => void share()}>{busy ? <Loader2 className="animate-spin" /> : null}Share {count} reviewed {count === 1 ? 'selection' : 'selections'}</Button>
            </>}
          </> : null}
          {step > 0 ? <Button size="xs" variant="outline" className="self-start" disabled={busy} onClick={() => setStep(step - 1)}>Back</Button> : null}
        </> : null}
      </>}
    </div> : null}
    {notice ? <p role="status" className="mt-3 text-xs">{notice}</p> : null}
  </section>;
}
