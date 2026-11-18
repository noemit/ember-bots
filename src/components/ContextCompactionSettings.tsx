import * as React from 'react';
import { Button } from './ui/button';
import type { Instance } from '../types';

export type CompactionSettingsState = {
  preference: { compactAtTokens: number; keepRecentTokens: number } | null;
  defaults: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number };
  models: { provider: string; modelId: string; contextWindow: number; compactAtTokens: number; keepRecentTokens: number; blockingAtTokens: number; custom: boolean; supported: boolean }[];
};

const selectControlClass =
  'min-w-0 max-w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const inputControlClass =
  'mt-1 block w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

/** Host-owned settings: no Ember preference writes and no conversation configuration. */
export default function ContextCompactionSettings({
  instances,
  initialValue,
}: {
  instances: Instance[];
  initialValue?: CompactionSettingsState;
}) {
  const kilns = instances.filter(instance => instance.kind === 'pi');
  const [chosen, setChosen] = React.useState('');
  const instance = kilns.find(kiln => kiln.id === chosen) ?? kilns[0];
  const instanceId = instance?.id;
  const instanceLabel = instance?.label;
  const [value, setValue] = React.useState<CompactionSettingsState | undefined>(initialValue);
  const [at, setAt] = React.useState(() => String(initialValue?.preference?.compactAtTokens ?? 70000));
  const [keep, setKeep] = React.useState(() => String(initialValue?.preference?.keepRecentTokens ?? 5000));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const revision = React.useRef(0);
  const apply = (state: CompactionSettingsState) => {
    setValue(state);
    setAt(String(state.preference?.compactAtTokens ?? 70000));
    setKeep(String(state.preference?.keepRecentTokens ?? 5000));
  };
  const load = React.useCallback(async () => {
    const version = ++revision.current;
    setValue(undefined); setError(''); setNotice('');
    if (!instanceId) { setBusy(false); return; }
    setBusy(true);
    try {
      const result = await window.ember.piRequest?.<CompactionSettingsState>(instanceId, '/settings/compaction');
      if (revision.current !== version) return;
      if (!result?.ok) throw new Error();
      apply(result.data);
    } catch {
      if (revision.current === version) setError(`${instanceLabel} did not return compaction settings. It may need an update or be offline. Use Reload to try again.`);
    } finally { if (revision.current === version) setBusy(false); }
  }, [instanceId, instanceLabel]);
  React.useEffect(() => { void load(); return () => { revision.current += 1; }; }, [load]);
  const save = async (reset = false) => {
    if (!instance || busy) return;
    const threshold = Number(at), tail = Number(keep);
    if (!reset && (!Number.isSafeInteger(threshold) || threshold < 1024 || threshold > 10_000_000 || !Number.isSafeInteger(tail) || tail < 1 || tail >= threshold)) {
      setError('Use whole token counts: Keep recent must be positive and smaller than Compact at (up to 10,000,000).'); return;
    }
    const version = ++revision.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.ember.piRequest?.<CompactionSettingsState>(instance.id, '/settings/compaction', { method: 'PUT', body: { preference: reset ? null : { compactAtTokens: threshold, keepRecentTokens: tail } } });
      if (revision.current !== version) return;
      if (!result?.ok) throw new Error();
      apply(result.data);
      setNotice(`Saved on ${instance.label}. Applies at the next model request, including existing chats.`);
    } catch { if (revision.current === version) setError(`${instance.label} did not save compaction settings. Check the token counts and connection, then try Save again.`); }
    finally { if (revision.current === version) setBusy(false); }
  };
  return <section className="space-y-3" aria-label="Context & compaction">
    <h3 className="text-sm font-medium">Context &amp; compaction</h3>
    <p className="text-xs text-muted-foreground">Automatically summarizes older turns while keeping recent messages in full. Full history stays in the transcript. Applies to all chats on the selected Kiln.</p>
    {kilns.length ? <label className="flex items-center gap-3 text-sm">Kiln
      <select aria-label="Compaction Kiln" value={instance?.id ?? ''} onChange={event => setChosen(event.target.value)} className={selectControlClass}>
        {kilns.map(kiln => <option key={kiln.id} value={kiln.id}>{kiln.label}</option>)}
      </select></label> : <p className="text-sm text-muted-foreground">Connect a Kiln in Computers and Containers to configure automatic compaction.</p>}
    {instance ? <>
      <div className="flex items-center gap-3"><p className="text-xs text-muted-foreground">{busy ? `Asking ${instance.label}…` : value?.preference ? 'Custom token targets' : value ? 'Using default targets' : 'Settings unavailable'}</p><Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>Reload</Button></div>
      {value ? <>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">How defaults and smaller models work</summary><p className="mt-2">By default, automatic compaction is on and keeps 20,000 recent tokens. Background compaction starts 49,152 tokens below the model window; generation waits at 16,384 below it.</p><p className="mt-2">With custom targets, smaller models compact earlier to leave 16,384 tokens free. The retained tail is capped at half the effective target, leaving room for the summary and instructions. Models with a window of 16,385 tokens or less, or an unknown window, use default targets.</p></details>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">Compact at tokens<input className={inputControlClass} type="number" min="1024" max="10000000" step="1" value={at} onChange={event => setAt(event.target.value)} disabled={busy} /></label>
          <label className="space-y-1 text-sm">Keep recent tokens<input className={inputControlClass} type="number" min="1" step="1" value={keep} onChange={event => setKeep(event.target.value)} disabled={busy} /></label>
        </div>
        <p className="text-xs text-muted-foreground">Compaction starts before the next model request above your target, when older context can be summarized. It runs in the background until the model’s safety boundary, where generation waits. This is a threshold, not a hard cap. Recent messages are kept whole, so the retained token count is approximate.</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void save()}>Save compaction settings</Button><Button size="sm" variant="outline" disabled={busy || !value.preference} onClick={() => void save(true)}>Reset to defaults</Button></div>
        {value.preference ? <details className="text-xs"><summary className="cursor-pointer">Effective targets by model</summary><div className="mt-2 max-h-48 overflow-auto">{value.models.map(model => <p key={`${model.provider}/${model.modelId}`} className="py-1">{model.provider}/{model.modelId}: {model.custom ? `compact above ${model.compactAtTokens.toLocaleString()}, keep about ${model.keepRecentTokens.toLocaleString()}; wait above ${model.blockingAtTokens.toLocaleString()}` : 'Default targets (custom target unavailable)'}</p>)}</div></details> : null}
      </> : null}
    </> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
  </section>;
}
