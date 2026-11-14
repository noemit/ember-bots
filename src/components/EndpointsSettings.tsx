import * as React from 'react';
import { Trash2 } from 'lucide-react';
import InstanceAlignment from './InstanceAlignment';
import EndpointForm from './EndpointForm';
import KilnSharing from './KilnSharing';
import { Button } from '@/components/ui/button';
import { endpointError, endpointTestCopy, removeEndpoint, upsertEndpoint, type EndpointDraft } from '@/lib/endpoints';
import type { EmberSettingsPatch, Instance, PiEndpoint } from '../types';

type Props = {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onRefreshInstances?: () => void;
};
const empty: EndpointDraft = { label: '', url: '', token: '' };

export default function EndpointsSettings({ endpoints, instances, onChange, onRefreshInstances }: Props) {
  const [location, setLocation] = React.useState<'local' | 'remote'>('local');
  const [draft, setDraft] = React.useState<EndpointDraft>(empty);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const [testing, setTesting] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, string>>({});
  const revision = React.useRef(0);
  const desktop = typeof window.ember.testPiEndpoint === 'function';
  const commit = (next: PiEndpoint[]) => {
    onChange({ piEndpoints: next });
    window.setTimeout(() => onRefreshInstances?.(), 50);
  };
  const changeDraft = (next: EndpointDraft) => {
    revision.current += 1; setDraft(next); setError(''); setResults(prev => ({ ...prev, draft: '' }));
  };
  const save = () => {
    const failure = endpointError(draft, endpoints);
    if (failure) { setError(failure); return; }
    commit(upsertEndpoint(endpoints, draft));
    changeDraft(empty); setEditing(null);
  };
  const test = async (value: EndpointDraft, key: string) => {
    const failure = endpointError(value);
    if (failure) { setResults(prev => ({ ...prev, [key]: failure })); return; }
    const version = revision.current;
    setTesting(key);
    try {
      const result = await window.ember.testPiEndpoint!(value);
      if (key !== 'draft' || revision.current === version) setResults(prev => ({ ...prev, [key]: endpointTestCopy(value.label, result.outcome) }));
    } catch {
      if (key !== 'draft' || revision.current === version) setResults(prev => ({ ...prev, [key]: endpointTestCopy(value.label, 'unreachable') }));
    } finally { setTesting(null); }
  };
  return <div className="flex flex-col gap-4">
    <section aria-label="Add instance" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Add instance</h3>
      <div className="flex gap-2" role="group" aria-label="Where will Kiln run?">
        <Button size="sm" variant={location === 'local' ? 'secondary' : 'outline'} aria-pressed={location === 'local'} onClick={() => setLocation('local')}>On this computer</Button>
        <Button size="sm" variant={location === 'remote' ? 'secondary' : 'outline'} aria-pressed={location === 'remote'} onClick={() => setLocation('remote')}>On another computer</Button>
      </div>
      {location === 'local' ? <>
        <p className="text-xs text-muted-foreground">Ember includes a local Kiln. No network setup is needed. It starts with Ember and stops when you quit Ember, not when you close its window on macOS.</p>
        <KilnSharing />
        <details className="text-xs"><summary className="cursor-pointer py-2">Connect a separate local Kiln</summary><p className="mb-2 text-muted-foreground">A Tinder-managed Kiln has its own lifetime. Use its local URL and bearer token; quitting Ember leaves it running.</p><Button size="sm" variant="outline" onClick={() => { changeDraft({ ...empty, url: 'http://127.0.0.1:3003' }); setLocation('remote'); }}>Enter local connection details</Button></details>
      </> : <>
        <p className="text-xs text-muted-foreground">Enter the URL and bearer token from the computer running Kiln. In Ember there, use Share this Kiln. For Tinder, ask its owner for connection details. Adding a connection does not change that host’s network.</p>
        {!desktop ? <p className="text-xs">Open Ember on the desktop to add, edit or test connections. This browser cannot read or change their credentials.</p> : <>
          {editing && <p className="text-xs font-medium">Editing instance</p>}
          <EndpointForm draft={draft} onChange={changeDraft} />
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={testing !== null} onClick={() => void test(draft, 'draft')}>{testing === 'draft' ? 'Testing connection…' : 'Test connection'}</Button><Button size="sm" onClick={save}>{editing ? 'Save instance' : 'Add instance'}</Button>{editing && <Button size="sm" variant="ghost" onClick={() => { changeDraft(empty); setEditing(null); }}>Cancel edit</Button>}</div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {results.draft && <p role="status" className="text-xs">{results.draft}</p>}
        </>}
      </>}
    </section>
    {endpoints.length > 0 && <section aria-label="Connected instances" className="flex flex-col gap-2 border-t pt-3">
      <h3 className="text-xs font-medium">Connected instances</h3>
      {endpoints.map(endpoint => <div data-endpoint={endpoint.id} key={endpoint.id} className="rounded-lg border p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{endpoint.label}</span><span className="text-muted-foreground">{instances.find(i => i.id === endpoint.id)?.status === 'ready' ? 'Connected' : 'Not connected'}</span>
          {desktop && <><Button size="xs" variant="ghost" disabled={testing !== null} onClick={() => void test(endpoint, endpoint.id)}>{testing === endpoint.id ? 'Testing…' : `Test `}</Button><Button size="xs" variant="ghost" onClick={() => { changeDraft(endpoint); setEditing(endpoint.id); setLocation('remote'); }}>Edit {endpoint.label}</Button><Button size="xs" variant="ghost" onClick={() => commit(removeEndpoint(endpoints, endpoint.id))}><Trash2 />Remove {endpoint.label}</Button></>}
        </div><p className="mt-1 break-all text-muted-foreground">{endpoint.url}</p>{results[endpoint.id] && <p className="mt-2" role="status">{results[endpoint.id]}</p>}
      </div>)}
    </section>}
    <InstanceAlignment instances={instances} endpoints={endpoints} onSave={commit} />
  </div>;
}
