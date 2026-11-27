import * as React from 'react';
import { ArrowUpCircle, Check, Copy, Trash2 } from 'lucide-react';
import InstanceAlignment from './InstanceAlignment';
import EndpointForm from './EndpointForm';
import SshEndpointSetup from './SshEndpointSetup';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { endpointError, endpointTestCopy, removeEndpoint, upsertEndpoint, type EndpointDraft } from '@/lib/endpoints';
import { kilnUpdateState } from '@/lib/kilnUpdateNotice';
import type { ModelRefreshOptions } from '@/lib/providerSharing';
import type { EmberSettingsPatch, Instance, PiEndpoint } from '../types';

export type EndpointsSettingsProps = {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>;
  onRefreshInstances?: () => void;
  onRefreshModels?: (endpointId: string, options?: ModelRefreshOptions) => Promise<unknown> | void;
  initialRemovingId?: string | null;
};
const empty: EndpointDraft = { label: '', url: '', token: '' };

export const BUILTIN_LOCAL_ENDPOINT_ID = 'pi:local';

export const canRemoveEndpoint = (endpoint: Pick<PiEndpoint, 'id'>): boolean =>
  endpoint.id !== BUILTIN_LOCAL_ENDPOINT_ID;

export const initialEndpointLocation = (endpoints: readonly Pick<PiEndpoint, 'id'>[]): 'local' | 'remote' =>
  endpoints.some((endpoint) => endpoint.id === BUILTIN_LOCAL_ENDPOINT_ID) ? 'remote' : 'local';

export type CommitEndpointsResult = {
  ok: boolean;
  error?: string;
};

const sanitizeFailureDetail = (error: unknown): string | undefined => {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const trimmed = raw.trim();
  if (!trimmed || /\b(HTTP\s*\d+|undefined|null|stack)\b/i.test(trimmed)) return undefined;
  return trimmed.replace(/!+$/, '');
};

export const formatEndpointSaveError = (
  label: string,
  action: 'save' | 'remove',
  error?: unknown,
): string => {
  const detail = sanitizeFailureDetail(error);
  const name = label.trim() || 'this connection';
  if (action === 'remove') {
    return `Ember couldn't remove ${name}${detail ? ` (${detail})` : ''}. Your settings file may be read-only or unavailable right now — check that it is writable and choose Confirm remove again.`;
  }
  return `Ember couldn't save ${name}${detail ? ` (${detail})` : ''}. Your settings file may be read-only or unavailable right now — check that it is writable and try again.`;
};

export const commitEndpoints = (
  next: PiEndpoint[],
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>,
  onRefreshInstances?: () => void,
): Promise<CommitEndpointsResult> =>
  Promise.resolve(onChange({ piEndpoints: next })).then(
    () => {
      onRefreshInstances?.();
      return { ok: true };
    },
    (error: unknown) => ({
      ok: false,
      error: sanitizeFailureDetail(error),
    }),
  );

export const confirmRemoveEndpoint = (
  endpoints: PiEndpoint[],
  removingId: string,
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>,
  onRefreshInstances?: () => void,
): { nextRemoving: null; promise: Promise<CommitEndpointsResult> | null } => {
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
  onRefreshModels,
  initialRemovingId = null,
}: EndpointsSettingsProps) {
  const [location, setLocation] = React.useState<'local' | 'remote' | 'ssh'>(() => initialEndpointLocation(endpoints));
  const [draft, setDraft] = React.useState<EndpointDraft>(empty);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(initialRemovingId);
  const [removingInFlight, setRemovingInFlight] = React.useState<string | null>(null);
  const [updatingSshId, setUpdatingSshId] = React.useState<string | null>(null);
  const [copiedUninstallId, setCopiedUninstallId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [removeError, setRemoveError] = React.useState('');
  const [testing, setTesting] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, string>>({});
  const revision = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const desktop =
    typeof window !== 'undefined' &&
    window.ember?.capabilities?.endpointManagement !== false &&
    typeof window.ember?.testPiEndpoint === 'function';
  const commit = (next: PiEndpoint[]) => commitEndpoints(next, onChange, onRefreshInstances);
  const changeDraft = (next: EndpointDraft) => {
    revision.current += 1; setDraft(next); setError(''); setResults(prev => ({ ...prev, draft: '' }));
  };
  const save = async () => {
    if (saving || removingInFlight !== null) return;
    const failure = endpointError(draft, endpoints);
    if (failure) { setError(failure); return; }
    setSaving(true);
    setError('');
    const result = await commit(upsertEndpoint(endpoints, draft));
    if (!mounted.current) return;
    setSaving(false);
    if (!result.ok) {
      setError(formatEndpointSaveError(draft.label || 'this connection', 'save', result.error));
      return;
    }
    changeDraft(empty);
    setEditing(null);
    setRemoving(null);
    setRemoveError('');
  };
  const performRemove = async (endpoint: PiEndpoint) => {
    if (removingInFlight !== null || saving) return;
    setRemovingInFlight(endpoint.id);
    setRemoveError('');
    const { promise } = confirmRemoveEndpoint(endpoints, endpoint.id, onChange, onRefreshInstances);
    const result: CommitEndpointsResult = promise
      ? await promise
      : { ok: false, error: 'built-in connections stay managed by Ember' };
    if (!mounted.current) return;
    setRemovingInFlight(null);
    if (!result.ok) {
      setRemoveError(formatEndpointSaveError(endpoint.label, 'remove', result.error));
      return;
    }
    setRemoving(null);
    setRemoveError('');
    setError('');
    setResults((prev) => {
      if (!(endpoint.id in prev)) return prev;
      const next = { ...prev };
      delete next[endpoint.id];
      return next;
    });
    if (editing === endpoint.id) {
      changeDraft(empty);
      setEditing(null);
    }
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
  const canSsh = desktop && typeof window.ember?.setupSshKiln === 'function';
  const handleSshConnected = async (endpoint: PiEndpoint, message: string) => {
    const next = upsertEndpoint(endpoints, endpoint);
    await commit(next);
    if (mounted.current) {
      setResults((prev) => ({ ...prev, [endpoint.id]: message }));
    }
  };
  const updateSshEndpoint = async (endpoint: PiEndpoint) => {
    if (!endpoint.ssh || !window.ember?.setupSshKiln || updatingSshId !== null) return;
    setUpdatingSshId(endpoint.id);
    try {
      const result = await window.ember.setupSshKiln({
        target: endpoint.ssh.target,
        label: endpoint.label,
        lifetime: endpoint.ssh.lifetime,
        remotePort: endpoint.ssh.remotePort,
        mode: 'update',
        remoteHome: endpoint.ssh.remoteHome,
        binaryPath: endpoint.ssh.binaryPath,
        existingEndpointId: endpoint.id,
      });
      if (!mounted.current) return;
      if (result.ok) {
        await handleSshConnected(result.endpoint, result.message);
      } else {
        setResults((prev) => ({ ...prev, [endpoint.id]: result.message }));
      }
    } catch {
      if (mounted.current) {
        setResults((prev) => ({
          ...prev,
          [endpoint.id]: `Ember couldn’t update Kiln on ${endpoint.label} over SSH. Check the SSH connection and try again.`,
        }));
      }
    } finally {
      if (mounted.current) setUpdatingSshId(null);
    }
  };
  const sshUninstallCommandFor = (endpoint: PiEndpoint): string => {
    const bin = endpoint.ssh?.binaryPath || '$HOME/.local/bin/tinder';
    return `systemctl --user disable --now ember-kiln.service 2>/dev/null; rm -f "$HOME/.config/systemd/user/ember-kiln.service" "${bin}"`;
  };
  return <div className="flex flex-col gap-4">
    <section aria-label="Add connection" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Add computer or container</h3>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Where is Kiln running?">
        <Button size="sm" variant={location === 'local' ? 'secondary' : 'outline'} aria-pressed={location === 'local'} onClick={() => setLocation('local')}>On this computer</Button>
        <Button size="sm" variant={location === 'remote' ? 'secondary' : 'outline'} aria-pressed={location === 'remote'} onClick={() => setLocation('remote')}>On another computer or container</Button>
        {canSsh ? (
          <Button size="sm" variant={location === 'ssh' ? 'secondary' : 'outline'} aria-pressed={location === 'ssh'} onClick={() => setLocation('ssh')}>Over SSH</Button>
        ) : null}
      </div>
      {location === 'local' ? <>
        <p className="text-xs text-muted-foreground">Ember includes a local Kiln. No network setup is needed. It starts with Ember and stops when you quit Ember, not when you close its window on macOS.</p>
        <details className="text-xs"><summary className="cursor-pointer py-2">Connect a separate local Kiln</summary><p className="mb-2 text-muted-foreground">A Tinder-managed Kiln has its own lifetime. Use its local URL and bearer token; quitting Ember leaves it running.</p><Button size="sm" variant="outline" onClick={() => { setEditing(null); changeDraft({ ...empty, url: 'http://127.0.0.1:3003' }); setLocation('remote'); }}>Enter local connection details</Button></details>
      </> : location === 'ssh' ? (
        <SshEndpointSetup onConnected={handleSshConnected} />
      ) : <>
        <p className="text-xs text-muted-foreground">Enter the Kiln URL and bearer token. In the other Ember, open Settings → Remote access → Share this Kiln. For Tinder, ask its owner for connection details. Connecting never changes that host’s network.</p>
        {!desktop ? <p className="text-xs">Open Ember on the desktop to add, edit or test connections. This browser cannot read or change their credentials.</p> : <>
          {editing && <p className="text-xs font-medium">Editing connection</p>}
          <EndpointForm draft={draft} onChange={changeDraft} />
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={testing !== null || saving || removingInFlight !== null} onClick={() => void test(draft, 'draft')}>{testing === 'draft' ? 'Testing connection…' : 'Test connection'}</Button><Button size="sm" disabled={saving || removingInFlight !== null} onClick={() => void save()}>{saving ? (editing ? 'Saving connection…' : 'Adding connection…') : (editing ? 'Save connection' : 'Add connection')}</Button>{editing && <Button size="sm" variant="ghost" disabled={saving || removingInFlight !== null} onClick={() => { changeDraft(empty); setEditing(null); }}>Cancel edit</Button>}</div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {results.draft && <p role="status" className="text-xs">{results.draft}</p>}
        </>}
      </>}
    </section>
    {endpoints.length > 0 && <section aria-label="Computers and containers" className="flex flex-col gap-2 border-t pt-3">
      <h3 className="text-xs font-medium">Computers and containers</h3>
      {endpoints.map(endpoint => {
        const instance = instances.find(i => i.id === endpoint.id);
        const updateOlder = Boolean(endpoint.ssh && canSsh && instance && kilnUpdateState(instance) === 'older');
        return <div data-endpoint={endpoint.id} key={endpoint.id} className="rounded-lg border p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{endpoint.label}</span><span className="text-muted-foreground">{({ ready: 'Connected', checking: 'Checking connection', unreachable: 'Not answering', unsupported: 'Needs a compatible Kiln' })[instance?.status ?? 'checking']}</span>
          {desktop && <>
            <Button size="xs" variant="ghost" disabled={testing !== null} onClick={() => void test(endpoint, endpoint.id)}>{testing === endpoint.id ? 'Testing…' : 'Test'}</Button>
            {updateOlder ? (
              <Button size="xs" variant="outline" disabled={updatingSshId !== null} onClick={() => void updateSshEndpoint(endpoint)}>
                <ArrowUpCircle className="size-3" aria-hidden="true" />
                {updatingSshId === endpoint.id ? 'Updating via SSH…' : 'Update via SSH'}
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" disabled={saving || removingInFlight !== null} onClick={() => { setRemoving(null); setRemoveError(''); changeDraft(endpoint); setEditing(endpoint.id); setLocation('remote'); }}>Edit {endpoint.label}</Button>
            {canRemoveEndpoint(endpoint) && (
              <Button
                size="xs"
                variant="ghost"
                disabled={saving || removingInFlight !== null}
                onClick={() => {
                  setRemoving(endpoint.id);
                  setRemoveError('');
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
        <p className="mt-1 break-all text-muted-foreground">
          {endpoint.ssh
            ? `via SSH (${endpoint.ssh.target} · ${endpoint.ssh.lifetime === 'ephemeral' ? 'This session only' : 'Background service'}) · ${endpoint.url}`
            : endpoint.url}
        </p>
        {results[endpoint.id] && <p className="mt-2" role="status">{results[endpoint.id]}</p>}
        {desktop && canRemoveEndpoint(endpoint) && removing === endpoint.id ? (
          <div className="mt-2 space-y-2 border-t pt-2" role="group" aria-label={`Remove ${endpoint.label}`}>
            <p className="text-muted-foreground">
              Remove {endpoint.label} and its saved credentials from this Ember?{' '}
              {endpoint.ssh?.lifetime === 'ephemeral'
                ? `Its session-only SSH tunnel will close; conversations remain on ${endpoint.ssh.target}.`
                : `${endpoint.label} keeps running, and its conversations stay on that host.`}
            </p>
            {endpoint.ssh?.lifetime === 'service' ? (
              <div className="space-y-1 rounded bg-muted/40 p-2">
                <p className="text-muted-foreground">
                  To uninstall Tinder from {endpoint.ssh.target} yourself later, run:
                </p>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <code className="min-w-0 flex-1 break-all">{sshUninstallCommandFor(endpoint)}</code>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      void copyText(sshUninstallCommandFor(endpoint)).then((ok) => {
                        if (ok && mounted.current) setCopiedUninstallId(endpoint.id);
                      });
                    }}
                  >
                    {copiedUninstallId === endpoint.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                    {copiedUninstallId === endpoint.id ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            ) : null}
            {removeError ? <p role="alert" className="text-destructive">{removeError}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="destructive"
                disabled={removingInFlight !== null}
                onClick={() => void performRemove(endpoint)}
              >
                {removingInFlight === endpoint.id ? 'Removing…' : 'Confirm remove'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={removingInFlight !== null}
                onClick={() => { setRemoving(null); setRemoveError(''); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>;
      })}
    </section>}
    <InstanceAlignment instances={instances} endpoints={endpoints} onSave={commit} onProviderChange={onRefreshModels} />
  </div>;
}
