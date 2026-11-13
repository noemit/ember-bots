import * as React from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import SecretInput from './ui/secret-input';
import { piCustomProviders, type PiCustomProvider } from '../piApi';

/** Shared by Settings and onboarding. Remounted per Kiln so secrets never follow host switches. */
export default function CustomProviders({ endpointId, hostName, onChange }: {
  endpointId: string; hostName: string; onChange: (name?: string) => Promise<void>;
}) {
  const [providers, setProviders] = React.useState<PiCustomProvider[]>([]);
  const [editing, setEditing] = React.useState<PiCustomProvider | 'new' | null>(null);
  const [name, setName] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [ids, setIds] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [replaceKey, setReplaceKey] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  React.useEffect(() => {
    let active = true;
    const counter = generation;
    void piCustomProviders<{ providers: PiCustomProvider[] }>(endpointId).then(result => { if (active) setProviders(result.providers); }).catch(() => {
      // Older hosts still show their normal providers. The editor explains compatibility on use.
    });
    return () => { active = false; counter.current++; };
  }, [endpointId]);
  const start = (provider: PiCustomProvider | 'new') => {
    generation.current++;
    setEditing(provider); setError(''); setApiKey(''); setReplaceKey(false); setRemoving(null);
    setName(provider === 'new' ? '' : provider.name);
    setBaseUrl(provider === 'new' ? '' : provider.baseUrl);
    setIds(provider === 'new' ? '' : provider.modelIds.join('\n'));
  };
  const savedKey = editing && editing !== 'new' && editing.hasApiKey;
  const secret = savedKey && !replaceKey ? undefined : apiKey;
  const run = async (operation: () => Promise<void>) => {
    const version = generation.current;
    setBusy(true); setError('');
    try { await operation(); } catch (failure) {
      if (version === generation.current) setError(`${hostName}: ${failure instanceof Error ? failure.message : 'Kiln did not answer. Retry when it is available.'}`);
    } finally { if (version === generation.current) setBusy(false); }
  };
  const refresh = async () => setProviders((await piCustomProviders<{ providers: PiCustomProvider[] }>(endpointId)).providers);
  return <section className="flex flex-col gap-2" aria-label="Custom OpenAI-compatible providers">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium">Custom / OpenAI-compatible</h3>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => start('new')}>Add custom provider</Button>
    </div>
    <p className="text-xs text-muted-foreground">Connect a self-hosted server, including a LAN host such as NVIDIA Spark. {hostName} makes the requests and stores any API key; Ember does not save it.</p>
    {providers.map(provider => <div key={provider.id} className="flex flex-wrap items-center gap-2 border-b py-2 text-xs">
      <div className="min-w-0 flex-1"><p className="font-medium">{provider.name}</p><p className="break-all text-muted-foreground">{provider.baseUrl} · {provider.hasApiKey ? 'API key saved' : 'No key needed'}</p></div>
      <Button size="xs" variant="ghost" aria-label={`Edit ${provider.name}`} disabled={busy} onClick={() => start(provider)}>Edit</Button>
      <Button size="xs" variant="ghost" aria-label={`Remove ${provider.name}`} disabled={busy} onClick={() => { setRemoving(provider.id); setEditing(null); setApiKey(''); setError(''); }}>Remove</Button>
      {removing === provider.id ? <div className="w-full space-y-2" role="group" aria-label={`Remove ${provider.name}`}>
        <p>Remove this provider and its key from {hostName}? Existing model choices stay unchanged and may need a replacement.</p>
        <Button size="xs" variant="destructive" disabled={busy} onClick={() => void run(async () => {
          await piCustomProviders(endpointId, `/${provider.id}`, 'DELETE'); setRemoving(null); await refresh(); await onChange();
        })}>Confirm remove</Button>{' '}<Button size="xs" variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
      </div> : null}
    </div>)}
    {editing ? <form className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Custom provider editor" onSubmit={event => {
      event.preventDefault(); void run(async () => {
        await piCustomProviders(endpointId, editing === 'new' ? '' : `/${editing.id}`, editing === 'new' ? 'POST' : 'PUT', {
          name, baseUrl, modelIds: ids.split('\n').map(id => id.trim()).filter(Boolean), ...(secret === undefined ? {} : { apiKey: secret }),
        });
        setApiKey(''); setEditing(null); await refresh(); await onChange(name);
      });
    }}>
      <label className="space-y-1 text-xs">Display name<Input required maxLength={100} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="Spark · DeepSeek" /></label>
      <label className="space-y-1 text-xs">Base URL<Input required type="url" value={baseUrl} disabled={busy} onChange={event => setBaseUrl(event.target.value)} placeholder="http://spark:8000/v1" /></label>
      <p className="text-xs text-muted-foreground">Include the API path, usually /v1. HTTP and HTTPS hosts, ports and paths are supported. HTTP is unencrypted; use it only on a network you trust.</p>
      {savedKey ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={replaceKey} disabled={busy} onChange={event => { setReplaceKey(event.target.checked); setApiKey(''); }} />Replace or remove saved API key</label> : null}
      {!savedKey || replaceKey ? <label className="space-y-1 text-xs">API key (optional)<SecretInput value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} placeholder="Leave empty for a keyless server" /></label> : <p className="text-xs text-muted-foreground">The saved key stays on {hostName}. If you change the base URL, re-enter the key or choose keyless access.</p>}
      <Button type="button" size="xs" variant="secondary" disabled={busy || !baseUrl.trim()} onClick={() => void run(async () => {
        const result = await piCustomProviders<{ modelIds: string[]; error?: string }>(endpointId, '/discover', 'POST', {
          baseUrl, ...(editing === 'new' ? {} : { id: editing.id }), ...(secret === undefined ? {} : { apiKey: secret }),
        });
        if (result.error) setError(result.error);
        else setIds(current => [...new Set([...current.split('\n').filter(Boolean), ...result.modelIds])].join('\n'));
      })}>{busy ? 'Waiting for Kiln…' : 'Discover models'}</Button>
      <label className="space-y-1 text-xs">Model IDs (one per line)<textarea className="min-h-20 w-full rounded-md border bg-transparent p-2 text-xs" required value={ids} disabled={busy} onChange={event => setIds(event.target.value)} placeholder="deepseek-v4.1-flash" /></label>
      <p className="text-xs text-muted-foreground">Discovery is optional. Enter the exact model ID your server accepts even if discovery fails. Models use standard OpenAI chat completions; context defaults to 8k and text input.</p>
      <div className="flex gap-2"><Button type="submit" size="xs" disabled={busy || !name.trim() || !baseUrl.trim() || !ids.trim()}>Save custom provider</Button><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => { generation.current++; setEditing(null); setApiKey(''); setError(''); }}>Cancel</Button></div>
    </form> : null}
    {error ? <p role="status" className="text-xs text-destructive">{error}</p> : null}
  </section>;
}
