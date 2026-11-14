import * as React from 'react';
import { Cpu, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { piOllamaSettings, type PiOllamaState } from '../piApi';

type Props = { endpointId: string; hostName: string; onChange: (connected: boolean) => void | Promise<void> };

/** One named, keyless flow, shared by first-run and Settings. Remount when the host changes. */
export default function OllamaSetup({ endpointId, hostName, onChange }: Props) {
  const [state, setState] = React.useState<PiOllamaState | null>(null);
  const [address, setAddress] = React.useState('http://127.0.0.1:11434');
  const [advanced, setAdvanced] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void piOllamaSettings(endpointId).then(value => {
      if (!mounted.current) return;
      setState(value); setAddress(value.baseUrl); setAdvanced(value.baseUrl !== value.defaultBaseUrl);
    }).catch(() => {
      if (mounted.current) setError(hostName + ' did not return its Ollama setup. Test / Refresh to retry; if it still fails, update Kiln on that host.');
    }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [endpointId, hostName]);
  const test = async (reset = false) => {
    setBusy(true); setError(null);
    try {
      // Never overwrite an existing host address with the UI fallback before reading it.
      const value = await piOllamaSettings(endpointId, !state ? 'GET' : reset ? 'DELETE' : 'PUT', address);
      if (!mounted.current) return;
      setState(value); setAddress(value.baseUrl);
      if (reset) setAdvanced(false);
      await onChange(value.hasModels && !value.problem);
    } catch (cause) {
      if (mounted.current) setError(hostName + ': ' + (cause instanceof Error ? cause.message : 'Kiln did not answer. Test / Refresh to retry.'));
    } finally { if (mounted.current) setBusy(false); }
  };
  return <section className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3" aria-label="Ollama setup">
    <div className="flex items-center gap-2"><Cpu className="size-4 text-muted-foreground" /><h3 className="text-sm font-medium">Ollama</h3><span className="text-xs text-muted-foreground">No account or API key</span></div>
    <p className="text-xs text-muted-foreground">Run models on {hostName}. The default address is on that Kiln’s computer, not the computer running this window.</p>
    <p className="break-all text-xs text-muted-foreground">Ollama address: {state?.baseUrl ?? 'http://127.0.0.1:11434'}</p>
    {state ? <p className="text-xs" aria-live="polite">{state.problem ?? (state.hasModels ? 'Ollama is ready on ' + hostName + ' · ' + state.models.length + ' installed model' + (state.models.length === 1 ? '' : 's') : state.running ? 'Ollama is running on ' + hostName + ', but no models are installed.' : 'Ollama is not answering on ' + hostName + '. Start Ollama there, then Test / Refresh.')}</p> : null}
    <p className="text-xs text-muted-foreground">Install Ollama from <button type="button" className="underline underline-offset-2" onClick={() => void window.ember.openExternal('https://ollama.com/download')}>ollama.com</button> and start it on {hostName}. To add a model, run for example <code className="select-all">ollama pull llama3.2:3b</code> there, then Test / Refresh. Choose a model that fits that computer; downloads can be large. Ember does not install or download anything.</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="secondary" disabled={busy || loading} onClick={() => void test()}>{busy || loading ? <Loader2 className="size-3 animate-spin" /> : null}Test / Refresh</Button>
      <Button size="xs" variant="ghost" disabled={busy || loading || !state} onClick={() => setAdvanced(value => !value)} aria-expanded={advanced}>Change address</Button>
      {state?.customAddress ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void test(true)}>Reset address</Button> : null}
    </div>
    {advanced ? <div className="flex flex-col gap-1.5">
      <label htmlFor={'ollama-address-' + endpointId} className="text-xs">Ollama service address</label>
      <Input id={'ollama-address-' + endpointId} value={address} disabled={busy} onChange={event => setAddress(event.target.value)} className="h-8 text-xs" spellCheck={false} autoComplete="off" />
      <p className="text-xs text-muted-foreground">For another computer or a container, enter an address {hostName} can already reach, without /v1. Test / Refresh saves it on {hostName}. Reset address restores {state?.defaultBaseUrl ?? 'the host’s default'}. This does not change Ollama’s network settings; do not expose it to the public internet.</p>
    </div> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </section>;
}
