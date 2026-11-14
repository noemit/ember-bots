import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { parseSharingProviders, selectedTargets, selectionKey, sharingBlock, sharingHostMessage, experimentalSignIn, destinationProviders, sameDefinition, type SharingHost, type ConfigIdentity } from '../lib/providerSharing';
import type { Instance, PiEndpoint } from '../types';

export type ProviderSharingProps = {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onProviderChange?: (id: string) => void;
};

function ConfigReview({ config, label }: { config: ConfigIdentity; label: string }) {
  return <div className="mt-2 break-words text-muted-foreground"><p className="font-medium">{label}</p><dl aria-label={label}>
    <div><dt className="inline font-medium">Name: </dt><dd className="inline">{config.name}</dd></div>
    <div><dt className="inline font-medium">Provider ID: </dt><dd className="inline">{config.id}</dd></div>
    <div><dt className="inline font-medium">API address: </dt><dd className="inline">{config.baseUrl}</dd></div>
    <div><dt className="inline font-medium">Models: </dt><dd className="inline">{config.modelIds.join(', ') || 'None configured'}</dd></div>
  </dl></div>;
}

/** Shared review surface. Provider credentials travel host-to-host, never through this component. */
export default function ProviderSharing({ endpoints, instances, onProviderChange }: ProviderSharingProps) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [hosts, setHosts] = React.useState<SharingHost[] | null>(null);
  const [source, setSource] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [experimental, setExperimental] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const reviewed = React.useRef('');
  const latest = React.useRef(endpoints);
  latest.current = endpoints;
  const desktop = endpoints.every(endpoint => endpoint.hasToken === undefined);
  const candidates = [...endpoints, ...instances.filter(instance => instance.kind === 'pi' && !endpoints.some(endpoint => endpoint.id === instance.id)).map(instance => ({ id: instance.id, label: instance.label, url: instance.url ?? '', token: '' }))];
  const inspect = async () => {
    if (!desktop || !window.ember.piRequest) return;
    setBusy(true); setNotice(''); setHosts(null); setSelected(new Set()); setSource(''); setExperimental(false);
    const config = JSON.stringify(endpoints);
    reviewed.current = config;
    try {
      const rows = await Promise.all(candidates.map(async (endpoint: PiEndpoint): Promise<SharingHost> => {
        try {
          const response = await window.ember.piRequest!<unknown>(endpoint.id, '/alignment');
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
    if (!desktop || !hosts || !window.ember.piRequest) return;
    if (reviewed.current !== JSON.stringify(latest.current)) {
      setHosts(null); setSelected(new Set()); setNotice('Your Kiln connections changed. Compare again before sharing providers.'); return;
    }
    const targets = selectedTargets(hosts, source, selected, experimental);
    if (!targets.length) return;
    setBusy(true); setNotice('');
    const sourceLabel = hosts.find(host => host.endpoint.id === source)?.endpoint.label ?? 'The source Kiln';
    try {
      const response = await window.ember.piRequest<{ results: Array<{ id: string; ok: boolean; keys?: number }> }>(source, '/alignment/share', { method: 'POST', body: { targets } });
      if (!response.ok || !Array.isArray(response.data?.results)) {
        setNotice(`${sourceLabel} could not finish sharing. Check its connection, then compare again before retrying.`); return;
      }
      const results = response.data.results;
      const summaries = targets.map(target => {
        const result = results.find(row => row.id === target.id);
        if (result?.ok && typeof result.keys === 'number' && Number.isFinite(result.keys)) {
          onProviderChange?.(target.id);
          return `${target.label}: ${Math.max(0, result.keys)} credentials added.`;
        }
        return `${target.label} could not finish. Check its connection and update Kiln if needed, then compare again.`;
      });
      setNotice(`${summaries.join(' ')} Existing credentials and model defaults were kept. Compare again to see the current availability.`);
    } catch { setNotice(`${sourceLabel} did not answer. Check its connection, then compare again before retrying.`); }
    finally { setBusy(false); setSelected(new Set()); setHosts(null); }
  };
  const sourceHost = hosts?.find(host => host.endpoint.id === source);
  const sourceProviders = sourceHost?.providers.filter(provider => provider.hasCredential) ?? [];
  const targets = hosts ? selectedTargets(hosts, source, selected, experimental) : [];
  const comparisonProviders = (hosts?.flatMap(host => host.providers) ?? []).filter((provider, index, all) => all.findIndex(other => provider.configIdentity && other.configIdentity ? sameDefinition(provider.configIdentity, other.configIdentity) : provider.providerId === other.providerId) === index);
  return <section className="rounded-lg border px-3 py-3" aria-label="Share providers across Kilns">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-xs font-medium">Share providers across Kilns</h3>
        <p className="mt-1 text-xs text-muted-foreground">Compare provider availability before choosing what to share.</p></div>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Close review' : 'Review and share'}</Button>
    </div>
    {open ? <div className="mt-3 flex flex-col gap-3 text-xs">
      {!desktop ? <p>Provider sharing is available in the Ember desktop app. Open Settings → Providers there to review your Kilns.</p> : <>
        <p className="text-muted-foreground">The comparison reads metadata only. Choose one source, then review each provider and destination. Existing credentials and model defaults stay unchanged. Connections are managed separately.</p>
        <Button size="xs" variant="outline" disabled={busy || !candidates.length || !window.ember.piRequest} onClick={() => void inspect()}>{busy ? <Loader2 className="animate-spin" /> : null}Compare providers</Button>
        {!candidates.length ? <p>Add a Kiln in Settings → Instances, then return here to compare providers.</p> : null}
        {hosts ? <>
          <ul className="space-y-1" aria-label="Kiln comparison status">{hosts.map(host => <li key={host.endpoint.id}>{sharingHostMessage(host)}</li>)}</ul>
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
          <label className="flex items-center gap-2">Source Kiln<select aria-label="Provider sharing source" className="min-w-0 rounded border bg-background p-1" disabled={busy} value={source} onChange={event => { setSource(event.target.value); setSelected(new Set()); setExperimental(false); }}>
            <option value="">Choose a source</option>{hosts.filter(host => host.state === 'ready').map(host => <option value={host.endpoint.id} key={host.endpoint.id}>{host.endpoint.label}</option>)}
          </select></label>
          {sourceHost ? <>
            <p className="text-muted-foreground">Credentials go directly from {sourceHost.endpoint.label} ({sourceHost.endpoint.url}) to the selected Kilns. Anyone able to use those Kilns can use these provider accounts. Nothing is selected automatically.</p>
            {sourceProviders.some(provider => provider.configIdentity) ? <details className="rounded border p-2"><summary className="cursor-pointer">Review custom provider configurations on {sourceHost.endpoint.label}</summary>
              {sourceProviders.filter(provider => provider.configIdentity).map(provider => <ConfigReview key={provider.providerId} config={provider.configIdentity!} label={`Source configuration for ${provider.providerId}`} />)}
            </details> : null}
            {sourceProviders.some(experimentalSignIn) ? <div className="rounded border p-2">
              <label className="flex items-start gap-2"><input type="checkbox" checked={experimental} disabled={busy} onChange={event => { setExperimental(event.target.checked); setSelected(new Set()); }} />Enable experimental Codex and Antigravity sign-in sharing</label>
              <p className="mt-1 text-muted-foreground">These sign-ins may stop working on either Kiln when their tokens refresh. Sharing can conflict with provider account policies. Signing in separately on each Kiln is safer. Enable this only if you accept that risk; then select each destination below.</p>
            </div> : null}
            {!sourceProviders.length ? <p>{sourceHost.endpoint.label} has no provider credentials to share. Add a key or sign in there, then compare again.</p> : null}
            {hosts.filter(host => host.endpoint.id !== source).map(host => <fieldset key={host.endpoint.id} disabled={busy} className="rounded border p-2">
              <legend className="px-1 font-medium">{host.endpoint.label}</legend>
              <p className="mb-1 break-all text-muted-foreground">Kiln address: {host.endpoint.url || 'No address configured'}</p>
              {sourceProviders.map(provider => {
                const key = selectionKey(host.endpoint.id, provider.providerId);
                const blocked = sharingBlock(provider, host, experimental);
                const destinationMatches = destinationProviders(provider, host);
                const destinationReview = destinationMatches.length ? destinationMatches : host.providers.filter(row => row.configIdentity && (row.providerId === provider.providerId || row.configIdentity.name === provider.configIdentity?.name));
                return <div key={key} className="py-1"><label className="flex items-start gap-2"><input type="checkbox" aria-label={`Share ${provider.providerId} to ${host.endpoint.label}`} disabled={Boolean(blocked)} checked={!blocked && selected.has(key)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(key); else next.delete(key); return next; })} /><span>{provider.providerId} · {provider.source === 'environment' ? 'Environment key' : provider.type === 'oauth' ? 'Subscription sign-in' : 'API key'}</span></label>
                  <p className="ml-5 text-muted-foreground">{blocked ?? 'Missing — selected credentials will be added only if still missing.'}</p>
                  {provider.configIdentity ? <div className="ml-5">
                    <ConfigReview config={provider.configIdentity} label={`Source ${sourceHost.endpoint.label} configuration for ${provider.providerId}`} />
                    {destinationReview.some(row => row.configIdentity) ? destinationReview.map(row => <ConfigReview key={row.providerId} config={row.configIdentity!} label={`Destination ${host.endpoint.label} configuration for ${provider.providerId}`} />) : <p className="mt-1 text-muted-foreground">{host.endpoint.label} has no matching custom configuration to review.</p>}
                  </div> : null}
                </div>;
              })}
            </fieldset>)}
            <p className="text-muted-foreground">Custom providers require the exact same reviewed configuration on both Kilns. A missing or changed binding is skipped; sharing never installs configuration.</p>
            <Button size="xs" disabled={busy || !targets.length} onClick={() => void share()}>{busy ? <Loader2 className="animate-spin" /> : null}Share {targets.reduce((count, target) => count + target.providers.length, 0)} reviewed selections</Button>
          </> : null}
        </> : null}
      </>}
    </div> : null}
    {notice ? <p role="status" className="mt-3 text-xs">{notice}</p> : null}
  </section>;
}
