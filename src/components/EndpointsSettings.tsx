import * as React from 'react';
import { Check, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { endpointError, maskToken, removeEndpoint, upsertEndpoint, type EndpointDraft } from '@/lib/endpoints';
import type { EmberSettingsPatch, Instance, PiEndpoint } from '../types';

type Props = {
  endpoints: PiEndpoint[];
  /** Live instances include pi endpoints, so their health shows without a manual probe. */
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  /** Ask App to reprobe instances after a change, so a new endpoint attaches promptly. */
  onRefreshInstances?: () => void;
};

type ProbeState = { status: 'idle' | 'testing' | 'up' | 'down'; detail?: string };

const statusLabel: Record<Instance['status'], string> = {
  checking: 'checking…',
  ready: 'up',
  unreachable: 'down',
  unsupported: 'unsupported',
};

const statusTone: Record<Instance['status'], string> = {
  checking: 'text-muted-foreground',
  ready: 'text-success',
  unreachable: 'text-destructive',
  unsupported: 'text-muted-foreground',
};

/**
 * Hearth endpoints: the devices Ember reads conversations from. Values are user config in
 * `settings.piEndpoints`; every Ember install adds its own. A row's status comes from the
 * live instance list, and Test probes `/health` directly through the bridge.
 */
export default function EndpointsSettings({ endpoints, instances, onChange, onRefreshInstances }: Props) {
  const [draft, setDraft] = React.useState<EndpointDraft>({ label: '', url: '', token: '' });
  const [editing, setEditing] = React.useState<EndpointDraft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<Set<string>>(() => new Set());
  const [probes, setProbes] = React.useState<Record<string, ProbeState>>({});

  const commit = (next: PiEndpoint[]) => {
    onChange({ piEndpoints: next });
    // Give main a moment to persist and sync the endpoint before reprobing instances.
    window.setTimeout(() => onRefreshInstances?.(), 50);
  };

  const add = () => {
    const failure = endpointError(draft, endpoints);
    if (failure) {
      setError(failure);
      return;
    }
    commit(upsertEndpoint(endpoints, draft));
    setDraft({ label: '', url: '', token: '' });
    setError(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const failure = endpointError(editing, endpoints);
    if (failure) {
      setError(failure);
      return;
    }
    commit(upsertEndpoint(endpoints, editing));
    setEditing(null);
    setError(null);
  };

  const probe = async (endpoint: PiEndpoint) => {
    setProbes((prev) => ({ ...prev, [endpoint.id]: { status: 'testing' } }));
    const bridge = window.ember;
    if (!bridge.piRequest) {
      setProbes((prev) => ({ ...prev, [endpoint.id]: { status: 'down', detail: 'bridge has no piRequest' } }));
      return;
    }
    const response = await bridge.piRequest<{ ok?: boolean }>(endpoint.id, '/health');
    const up = response.ok && response.status === 200;
    setProbes((prev) => ({
      ...prev,
      [endpoint.id]: up
        ? { status: 'up' }
        : { status: 'down', detail: response.status === 401 ? 'token rejected' : `HTTP ${response.status || 'no reply'}` },
    }));
  };

  const liveStatus = (endpoint: PiEndpoint): Instance['status'] | undefined =>
    instances.find((instance) => instance.id === endpoint.id)?.status;

  return (
    <div className="flex flex-col gap-3">
      {endpoints.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No ember-harness endpoints yet. Add one below — the label and address of a device running
          ember-harness, plus its token (it prints one on first start).
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {endpoints.map((endpoint) => {
            const probeState = probes[endpoint.id];
            const status = probeState?.status === 'up' ? 'ready' : probeState?.status === 'down' ? 'unreachable' : liveStatus(endpoint);
            const isEditing = editing?.id === endpoint.id;
            return (
              <div key={endpoint.id} data-endpoint={endpoint.id} className="rounded-lg border bg-muted/20 px-3 py-2">
                {isEditing ? (
                  <div className="flex flex-col gap-2">
                    <Input
                      value={editing.label}
                      onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                      placeholder="Label"
                      aria-label={`Label for ${endpoint.label}`}
                      className="h-8 text-xs"
                    />
                    <Input
                      value={editing.url}
                      onChange={(event) => setEditing({ ...editing, url: event.target.value })}
                      placeholder="http://host:3002"
                      aria-label={`Address for ${endpoint.label}`}
                      className="h-8 text-xs"
                    />
                    <Input
                      value={editing.token}
                      onChange={(event) => setEditing({ ...editing, token: event.target.value })}
                      placeholder="Token"
                      aria-label={`Token for ${endpoint.label}`}
                      className="h-8 text-xs"
                    />
                    <div className="flex items-center gap-1.5">
                      <Button size="xs" variant="ghost" onClick={() => { setEditing(null); setError(null); }}>
                        Cancel
                      </Button>
                      <div className="flex-1" />
                      <Button size="xs" onClick={saveEdit}>
                        <Check /> Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[12.5px] font-medium">{endpoint.label}</span>
                        {status ? (
                          <span className={cn('flex-none text-[10.5px]', statusTone[status])}>
                            {status === 'ready' ? '● up' : status === 'unreachable' ? '● down' : `● ${statusLabel[status]}`}
                          </span>
                        ) : null}
                        {probeState?.detail ? (
                          <span className="flex-none text-[10.5px] text-muted-foreground">{probeState.detail}</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{endpoint.url}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setRevealed((prev) => {
                              const next = new Set(prev);
                              if (next.has(endpoint.id)) next.delete(endpoint.id);
                              else next.add(endpoint.id);
                              return next;
                            })
                          }
                          className="flex-none rounded px-1 hover:bg-muted"
                          aria-label={revealed.has(endpoint.id) ? `Hide token for ${endpoint.label}` : `Show token for ${endpoint.label}`}
                        >
                          {revealed.has(endpoint.id) ? endpoint.token : maskToken(endpoint.token)}
                        </button>
                      </span>
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void probe(endpoint)}
                      disabled={probeState?.status === 'testing'}
                      aria-label={`Test ${endpoint.label}`}
                    >
                      {probeState?.status === 'testing' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => {
                        setEditing({ id: endpoint.id, label: endpoint.label, url: endpoint.url, token: endpoint.token });
                        setError(null);
                      }}
                      aria-label={`Edit ${endpoint.label}`}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => commit(removeEndpoint(endpoints, endpoint.id))}
                      aria-label={`Remove ${endpoint.label}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Add endpoint</span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            placeholder="Label (e.g. Keep)"
            aria-label="New endpoint label"
            className="h-8 flex-1 text-xs"
          />
          <Input
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            placeholder="http://host:3002"
            aria-label="New endpoint address"
            className="h-8 flex-1 text-xs"
          />
        </div>
        <div className="flex gap-2">
          <Input
            value={draft.token}
            onChange={(event) => setDraft({ ...draft, token: event.target.value })}
            placeholder="Token"
            aria-label="New endpoint token"
            className="h-8 flex-1 text-xs"
          />
          <Button size="sm" onClick={add}>
            <Plus /> Add
          </Button>
        </div>
        {error ? <p className="text-[11.5px] text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

