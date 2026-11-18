import * as React from 'react';
import { Trash2 } from 'lucide-react';
import InstanceAlignment from './InstanceAlignment';
import EndpointForm from './EndpointForm';
import { Button } from '@/components/ui/button';
import { endpointError, endpointTestCopy, removeEndpoint, upsertEndpoint, type EndpointDraft } from '@/lib/endpoints';
import type { EmberSettingsPatch, Instance, PiEndpoint } from '../types';

export type EndpointsSettingsProps = {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>;
  onRefreshInstances?: () => void;
  initialRemovingId?: string | null;
};
const empty: EndpointDraft = { label: '', url: '', token: '' };

export const BUILTIN_LOCAL_ENDPOINT_ID = 'pi:local';

export const canRemoveEndpoint = (endpoint: Pick<PiEndpoint, 'id'>): boolean =>
  endpoint.id !== BUILTIN_LOCAL_ENDPOINT_ID;

export const initialEndpointLocation = (endpoints: readonly Pick<PiEndpoint, 'id'>[]): 'local' | 'remote' =>
  endpoints.some((endpoint) => endpoint.id === BUILTIN_LOCAL_ENDPOINT_ID) ? 'remote' : 'local';

export const commitEndpoints = (
  next: PiEndpoint[],
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>,
  onRefreshInstances?: () => void,
): Promise<void> =>
  Promise.resolve(onChange({ piEndpoints: next })).then(
    () => {
      onRefreshInstances?.();
    },
    () => undefined,
  );

export const confirmRemoveEndpoint = (
  endpoints: PiEndpoint[],
  removingId: string,
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>,
  onRefreshInstances?: () => void,
): { nextRemoving: null; promise: Promise<void> | null } => {
  const target = endpoints.find((endpoint) => endpoint.id === removingId);
  if (!target || !canRemoveEndpoint(target)) return { nextRemoving: null, promise: null };
  return {
    nextRemoving: null,
    promise: commitEndpoints(removeEndpoint(endpoints, removingId), onChange, onRefreshInstances),
  };
};

export default function EndpointsSettings({
  endpoints,
  instances,
  onChange,
  onRefreshInstances,
  initialRemovingId = null,
}: EndpointsSettingsProps) {
  const [location, setLocation] = React.useState<'local' | 'remote'>(() => initialEndpointLocation(endpoints));
  const [draft, setDraft] = React.useState<EndpointDraft>(empty);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(initialRemovingId);
  const [error, setError] = React.useState('');
  const [testing, setTesting] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, string>>({});
  const revision = React.useRef(0);
  const desktop =
    typeof window !== 'undefined' &&
    window.ember?.capabilities?.endpointManagement !== false &&
    typeof window.ember?.testPiEndpoint === 'function';
  const commit = (next: PiEndpoint[]) => {
    void commitEndpoints(next, onChange, onRefreshInstances);
  };
  const changeDraft = (next: EndpointDraft) => {
    revision.current += 1; setDraft(next); setError(''); setResults(prev => ({ ...prev, draft: '' }));
  };
  const save = () => {
    const failure = endpointError(draft, endpoints);
    if (failure) { setError(failure); return; }
    commit(upsertEndpoint(endpoints, draft));
    changeDraft(empty); setEditing(null); setRemoving(null);
  };
  const test = async (value: EndpointDraft, key: string) => {
    const failure = endpointError(value);
    if (failure) { setResults(prev => ({ ...prev, [key]: failure })); return; }
    const version = revision.current;
    setTesting(key);
    try {
      const result = await window.ember.testPiEndpoint!(value);
      if (key !== 'draft' || revision.current === version) setResults(prev => ({ ...prev, [key]: endpointTestCopy(value.label, result.outcome, result.authLayer) }));
    } catch {
      if (key !== 'draft' || revision.current === version) setResults(prev => ({ ...prev, [key]: endpointTestCopy(value.label, 'unreachable') }));
    } finally { setTesting(null); }
  };
  return <div className="flex flex-col gap-4">
    <section aria-label="Add connection" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Add computer or container</h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Where is Kiln running?">
        <Button size="sm" variant={location === 'local' ? 'secondary' : 'outline'} aria-pressed={location === 'local'} onClick={() => setLocation('local')}>On this computer</Button>
        <Button size="sm" variant={location === 'remote' ? 'secondary' : 'outline'} aria-pressed={location === 'remote'} onClick={() => setLocation('remote')}>On another computer or container</Button>
      </div>
      {location === 'local' ? <>
        <p className="text-xs text-muted-foreground">Ember includes a local Kiln. No network setup is needed. It starts with Ember and stops when you quit Ember, not when you close its window on macOS.</p>
        <details className="text-xs"><summary className="cursor-pointer py-2">Connect a separate local Kiln</summary><p className="mb-2 text-muted-foreground">A Tinder-managed Kiln has its own lifetime. Use its local URL and bearer token; quitting Ember leaves it running.</p><Button size="sm" variant="outline" onClick={() => { changeDraft({ ...empty, url: 'http://127.0.0.1:3003' }); setLocation('remote'); }}>Enter local connection details</Button></details>
      </> : <>
        <p className="text-xs text-muted-foreground">Enter the Kiln URL and bearer token. In the other Ember, open Settings → Remote access → Share this Kiln. For Tinder, ask its owner for connection details. Connecting never changes that host’s network.</p>
        {!desktop ? <p className="text-xs">Open Ember on the desktop to add, edit or test connections. This browser cannot read or change their credentials.</p> : <>
          {editing && <p className="text-xs font-medium">Editing connection</p>}
          <EndpointForm draft={draft} onChange={changeDraft} />
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={testing !== null} onClick={() => void test(draft, 'draft')}>{testing === 'draft' ? 'Testing connection…' : 'Test connection'}</Button><Button size="sm" onClick={save}>{editing ? 'Save connection' : 'Add connection'}</Button>{editing && <Button size="sm" variant="ghost" onClick={() => { changeDraft(empty); setEditing(null); }}>Cancel edit</Button>}</div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {results.draft && <p role="status" className="text-xs">{results.draft}</p>}
        </>}
      </>}
    </section>
    {endpoints.length > 0 && <section aria-label="Computers and containers" className="flex flex-col gap-2 border-t pt-3">
      <h3 className="text-xs font-medium">Computers and containers</h3>
      {endpoints.map(endpoint => <div data-endpoint={endpoint.id} key={endpoint.id} className="rounded-lg border p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{endpoint.label}</span><span className="text-muted-foreground">{({ ready: 'Connected', checking: 'Checking connection', unreachable: 'Not answering', unsupported: 'Needs a compatible Kiln' })[instances.find(i => i.id === endpoint.id)?.status ?? 'checking']}</span>
          {desktop && <>
            <Button size="xs" variant="ghost" disabled={testing !== null} onClick={() => void test(endpoint, endpoint.id)}>{testing === endpoint.id ? 'Testing…' : `Test `}</Button>
            <Button size="xs" variant="ghost" onClick={() => { setRemoving(null); changeDraft(endpoint); setEditing(endpoint.id); setLocation('remote'); }}>Edit {endpoint.label}</Button>
            {canRemoveEndpoint(endpoint) && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setRemoving(endpoint.id);
                  if (editing === endpoint.id) {
                    changeDraft(empty);
                    setEditing(null);
                  }
                }}
              >
                <Trash2 />Remove {endpoint.label}
              </Button>
            )}
          </>}
        </div>
        <p className="mt-1 break-all text-muted-foreground">{endpoint.url}</p>
        {results[endpoint.id] && <p className="mt-2" role="status">{results[endpoint.id]}</p>}
        {desktop && canRemoveEndpoint(endpoint) && removing === endpoint.id ? (
          <div className="mt-2 space-y-2 border-t pt-2" role="group" aria-label={`Remove ${endpoint.label}`}>
            <p className="text-muted-foreground">
              Remove {endpoint.label} and its saved credentials from this Ember? {endpoint.label} keeps running, and its conversations stay on that host.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="destructive"
                onClick={() => {
                  if (editing === endpoint.id) {
                    changeDraft(empty);
                    setEditing(null);
                  }
                  const { nextRemoving } = confirmRemoveEndpoint(endpoints, endpoint.id, onChange, onRefreshInstances);
                  setRemoving(nextRemoving);
                }}
              >
                Confirm remove
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>)}
    </section>}
    <InstanceAlignment instances={instances} endpoints={endpoints} onSave={commit} />
  </div>;
}
