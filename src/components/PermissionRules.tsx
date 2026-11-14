import * as React from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import type { PermissionRequest } from '../types';
import { approvalCommand, loadPermissionRules, previewPermissionRule, revokePermissionRule, savePermissionRule, type PermissionPolicy, type PermissionRule, type PermissionRulePreview } from '../lib/permissionRules';

const failure = (error: unknown) => error instanceof Error ? error.message : 'Kiln did not answer. Try again here, or cancel and use Allow once or Deny.';
function Policy({ policy }: { policy: PermissionPolicy }) {
  return <div className="space-y-2 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
      <dt className="text-muted-foreground">Exact arguments</dt><dd className="font-mono text-xs">{JSON.stringify(policy.argv)}</dd>
      <dt className="text-muted-foreground">Working directory</dt><dd className="font-mono text-xs">{policy.cwd}</dd>
      <dt className="text-muted-foreground">Executable</dt><dd className="font-mono text-xs">{policy.executable}</dd>
      <dt className="text-muted-foreground">Environment</dt><dd>Fixed clean environment, not the shell’s inherited variables.</dd>
      <dt className="text-muted-foreground">Time limit</dt><dd>{policy.maxTimeoutSeconds} seconds per command.</dd>
      <dt className="text-muted-foreground">Scope</dt><dd>This conversation only; never the whole project.</dd>
    </dl>
    <details><summary className="cursor-pointer text-xs text-muted-foreground">Actual Kiln policy</summary><pre className="max-h-52 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap break-all">{JSON.stringify(policy, null, 2)}</pre></details>
  </div>;
}
export function SimilarPermissionDialog({ request, onClose, onSaved, onReturnFocus }: { request: PermissionRequest; onClose(): void; onSaved(): void; onReturnFocus(): void }) {
  const [command, setCommand] = React.useState(() => approvalCommand(request));
  const [preview, setPreview] = React.useState<PermissionRulePreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const fieldId = React.useId();
  const check = async () => {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await previewPermissionRule(request, command)); }
    catch (err) { setError(failure(err)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview?.supported || !preview.policy) return;
    setBusy(true); setSaving(true); setError('');
    try { await savePermissionRule(request, command); onSaved(); onClose(); }
    catch (err) { setError(failure(err)); setPreview(null); setBusy(false); setSaving(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
    <DialogHeader><DialogTitle>Allow similar commands</DialogTitle><DialogDescription>Remember an exact command for this conversation only. No project sharing or inheritance. This does not make a command safe: scripts and tests can run arbitrary code.</DialogDescription></DialogHeader>
    <section aria-label="Allow once now" className="space-y-1 text-sm">
      <h3 className="font-medium">Allow once now</h3>
      <pre className="rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">{approvalCommand(request)}</pre>
    </section>
    <label htmlFor={fieldId} className="text-sm font-medium">Remember this exact command</label>
    <Input id={fieldId} aria-describedby={`${fieldId}-help`} value={command} disabled={busy} onChange={(event) => { setCommand(event.target.value); setPreview(null); setError(''); }} />
    <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">Editing changes only the rule for future commands. The original command above will be allowed once separately. Preview again after every edit.</p>
    <Button variant="outline" disabled={busy} onClick={() => void check()}>{busy ? 'Waiting for Kiln…' : 'Preview rule'}</Button>
    {preview ? <section aria-label="Kiln policy preview" className="space-y-2 text-sm">
      <p>{preview.supported ? 'Kiln will persist this policy for future commands. Only exact matches in this conversation, canonical working directory, executable and clean environment can skip approval.' : 'Kiln cannot remember this command. Use Allow once or Deny instead.'}</p>
      {preview.reason ? <p>{preview.reason}</p> : null}{preview.policy ? <Policy policy={preview.policy} /> : null}
    </section> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <DialogFooter><Button variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button disabled={busy || !preview?.supported || !preview.policy} onClick={() => void save()}>Save rule and allow once</Button></DialogFooter>
  </DialogContent></Dialog>;
}
export function PermissionRulesButton({ instanceId, sessionId }: { instanceId: string; sessionId: string }) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const [rules, setRules] = React.useState<PermissionRule[] | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const refreshVersion = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const result = await loadPermissionRules(instanceId, sessionId);
      if (version === refreshVersion.current) { setRules(result.rules); setError(''); }
    } catch (err) { if (version === refreshVersion.current) setError(failure(err)); }
  }, [instanceId, sessionId]);
  React.useEffect(() => {
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener('ember:permission-rules-changed', changed);
    return () => window.removeEventListener('ember:permission-rules-changed', changed);
  }, [refresh]);
  const revoke = async (id?: string) => {
    ++refreshVersion.current;
    setBusy(true); setError('');
    try { await revokePermissionRule(instanceId, sessionId, id); await refresh(); }
    catch (err) { setError(failure(err)); }
    finally { setBusy(false); }
  };
  return <>
    <Button ref={trigger} size="xs" variant="ghost" onClick={() => { setOpen(true); void refresh(); }} aria-label={`Remembered rules${rules ? `: ${rules.length}` : ''}`}>Rules{rules ? ` ${rules.length}` : ''}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Remembered permission rules</DialogTitle><DialogDescription>Conversation only. These rules do not apply to other conversations or share across the project. Revoking a rule restores future approval prompts; it cannot stop a command already allowed.</DialogDescription></DialogHeader>
      {!rules && !error ? <p role="status" className="text-sm text-muted-foreground">Asking Kiln for remembered rules…</p> : null}
      {rules ? <><p className="text-sm">{rules.length} remembered {rules.length === 1 ? 'rule' : 'rules'}</p><ul className="max-h-80 space-y-3 overflow-auto">{rules.map((rule) => <li key={rule.id}><Policy policy={rule} /><Button size="xs" variant="outline" disabled={busy} onClick={() => void revoke(rule.id)} aria-label={`Revoke ${rule.argv.join(' ')}`}>Revoke</Button></li>)}</ul></> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh rules</Button><Button variant="outline" disabled={busy || !rules?.length} onClick={() => void revoke()}>Clear all</Button><Button onClick={() => setOpen(false)}>Close</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
