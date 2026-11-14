import * as React from 'react';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { mergeConnections, portableConnection, type AlignmentSummary } from '../lib/instanceAlignment';
import type { Instance, PiEndpoint } from '../types';
import ProviderSharing from './ProviderSharing';

type Props = { instances: Instance[]; endpoints: PiEndpoint[]; onSave: (endpoints: PiEndpoint[]) => void };
type Review = { endpoint: PiEndpoint; summary: AlignmentSummary | null };

/** One deliberate alignment. Secrets are neither previewed nor kept in component state. */
export default function InstanceAlignment({ endpoints, instances, onSave }: Props) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [review, setReview] = React.useState<Review[] | null>(null);
  const [notice, setNotice] = React.useState('');
  const reviewedConfig = React.useRef('');
  const latest = React.useRef(endpoints);
  latest.current = endpoints;
  const desktop = endpoints.every(e => e.hasToken === undefined);
  const request = async <T,>(id: string, path: string, body?: unknown): Promise<T> => {
    if (!window.ember.piRequest) throw new Error('bridge unavailable');
    const response = await window.ember.piRequest<T>(id, path, body === undefined ? undefined : { method: 'POST', body });
    if (!response.ok) throw new Error('host unavailable');
    return response.data;
  };
  const inspect = async () => {
    setBusy(true); setNotice(''); setReview(null);
    reviewedConfig.current = JSON.stringify(endpoints);
    try {
      const candidates = [...endpoints, ...instances.filter(i => i.kind === 'pi' && !endpoints.some(e => e.id === i.id)).map(i => ({ id: i.id, label: i.label, url: i.url ?? '', token: '' }))];
      const rows = await Promise.all(candidates.map(async endpoint => {
        try {
          const summary = await request<AlignmentSummary>(endpoint.id, '/alignment');
          if (!Array.isArray(summary?.apiKeys) || !summary.apiKeys.every(k => typeof k === 'string') || !Array.isArray(summary.peers) || !summary.peers.every(p => typeof p?.id === 'string' && typeof p.label === 'string' && typeof p.url === 'string')) throw new Error('unsupported summary');
          return { endpoint, summary };
        }
        catch { return { endpoint, summary: null }; }
      }));
      setReview(rows);
    } finally { setBusy(false); }
  };
  const align = async () => {
    if (!review) return;
    if (reviewedConfig.current !== JSON.stringify(latest.current)) {
      setReview(null); setNotice('Your connections changed. Review instances again before aligning.'); return;
    }
    setBusy(true); setNotice('');
    const failures = new Set<string>();
    let connections = [...latest.current];
    let peersAdded = 0;
    try {
      const ready = review.filter(r => r.summary);
      for (const row of ready) {
        try {
          const data = await request<{ peers: PiEndpoint[] }>(row.endpoint.id, '/alignment/connections', {});
          connections = mergeConnections(connections, data.peers);
        } catch { failures.add(row.endpoint.label); }
      }
      // Use the latest settings when applying discoveries, preserving changes made during the request.
      const next = mergeConnections(latest.current, connections);
      const localAdded = next.length - latest.current.length;
      if (localAdded) onSave(next);
      const portable = next.filter(portableConnection);
      for (const row of ready) {
        try {
          const peers = portable.filter(p => p.url.replace(/\/+$/, '') !== row.endpoint.url.replace(/\/+$/, ''));
          const result = await request<{ connections: number }>(row.endpoint.id, '/alignment/import', { peers });
          peersAdded += result.connections;
        } catch { failures.add(row.endpoint.label); }
      }
      setNotice(`Added ${localAdded} connections to this Ember, ${peersAdded} peer connections. Existing values were kept.${failures.size ? ` ${[...failures].join(', ')} could not finish. Check their connection, then review and try again.` : ''}`);
      setReview(null);
    } finally { setBusy(false); }
  };
  const ready = review?.filter(r => r.summary) ?? [];
  return <section className="rounded-lg border px-3 py-3">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-xs font-medium">Align all my instances</h3>
        <p className="mt-1 text-xs text-muted-foreground">Add missing Kiln connections across your setups. Review provider sharing separately below.</p></div>
      <Button size="xs" variant="outline" onClick={() => setOpen(!open)} disabled={busy}><ArrowRightLeft />{open ? 'Close' : 'Review'}</Button>
    </div>
    {open ? <div className="mt-3 flex flex-col gap-3 text-xs">
      <p className="text-muted-foreground">This is a one-time alignment of the Kilns listed here. Other Ember apps can import their connections by running alignment too. Chats, folders and model defaults stay on their own instances.</p>
      {!desktop ? <p>Open these settings in the desktop app to align connection credentials.</p> : <>
        <Button size="xs" variant="outline" disabled={busy || !instances.some(i => i.kind === 'pi')} onClick={() => void inspect()}>{busy ? <Loader2 className="animate-spin" /> : null}Review instances</Button>
        {review ? <>
          <ul className="space-y-1">{review.map(row => <li key={row.endpoint.id}><strong>{row.endpoint.label}</strong> · {row.summary ? `${row.summary.peers.length} shareable connections · ${row.summary.apiKeys.length} stored API keys` : 'Not ready — check its connection or update Kiln, then review again.'}</li>)}</ul>
          <details><summary className="cursor-pointer">Connections found on these Kilns</summary><ul className="mt-2 space-y-1">{ready.flatMap(row => row.summary!.peers.map(peer => <li key={`${row.endpoint.id}:${peer.id}`}>{peer.label} · {peer.url} <span className="text-muted-foreground">via {row.endpoint.label}</span></li>))}</ul></details>
          <p className="text-muted-foreground">Only private-network or HTTPS addresses are shared. Loopback addresses stay on this computer. Newly discovered Kilns are added here; only the reviewed Kilns receive changes in this pass.</p>
          <Button size="xs" disabled={busy || ready.length === 0} onClick={() => void align()}>{busy ? <Loader2 className="animate-spin" /> : null}Align now</Button>
        </> : null}
      </>}
    </div> : null}
    {notice ? <p role="status" className="mt-3 text-xs">{notice}</p> : null}
    {open ? <div className="mt-3"><ProviderSharing endpoints={endpoints} instances={instances} /></div> : null}
  </section>;
}
