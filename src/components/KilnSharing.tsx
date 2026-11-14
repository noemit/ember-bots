import * as React from 'react';
import { Button } from '@/components/ui/button';
import SecretInput from '@/components/ui/secret-input';
import { copyText } from '@/lib/clipboard';

/** Deliberate host-side sharing; never reveal Kiln credentials during inspection. Scoped daemon auth stays in main. */
export default function KilnSharing() {
  const [status, setStatus] = React.useState<{ state: 'ready' | 'off' | 'blocked'; enabled: boolean; message: string; url?: string; canChange?: boolean; instructions?: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [details, setDetails] = React.useState<{ url: string; token: string } | null>(null);
  const [notice, setNotice] = React.useState('');
  const available = typeof window.ember.kilnSharing === 'function' && typeof window.ember.kilnSharingDetails === 'function';
  React.useEffect(() => {
    if (!available) return;
    let current = true;
    window.ember.kilnSharing!('inspect').then(result => { if (current) setStatus(result); }).catch(() => {
      if (current) setStatus({ state: 'blocked', enabled: false, message: 'Ember could not check this computer’s Kiln. Reopen Settings to try again.' });
    });
    return () => { current = false; };
  }, [available]);
  const change = async (action: 'inspect' | 'enable' | 'disable') => {
    setBusy(true); setDetails(null); setNotice('');
    try { setStatus(await window.ember.kilnSharing!(action)); }
    catch { setNotice('Ember could not change sharing on this computer. Try the sharing button again.'); }
    finally { setBusy(false); }
  };
  const reveal = async () => {
    setBusy(true);
    try {
      const result = await window.ember.kilnSharingDetails!();
      setDetails(result);
      if (!result) setNotice('This computer’s Kiln is not ready to share. Check sharing above, then try again.');
    } catch { setNotice('Ember could not retrieve the connection details. Try Reveal connection details again.'); }
    finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-2 rounded-lg border p-3 text-xs" aria-label="Share this Kiln">
    <h3 className="font-medium">Share this Kiln</h3>
    <p className="text-muted-foreground">The included Kiln stays on this computer by default. Sharing lets another Ember direct its bots; only share its bearer token with someone you trust.</p>
    <p className="text-muted-foreground">The included Kiln stops when you quit Ember. On macOS, closing the window does not quit. A Tinder-managed Kiln runs independently: Ember does not own or stop that process. Ember cannot change sharing for an attached external Kiln; configure it on its host yourself. The forward stays configured after Ember quits, but the included backend is then stopped.</p>
    {!available ? <p>Open Ember on the computer running this Kiln to change sharing. A remote browser cannot enable it or reveal its token.</p> : <>
      <p role="status">{status?.message ?? 'Ember is checking sharing on this computer…'}</p>
      {status && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void change('inspect')}>Check sharing</Button>
        {status.canChange === true && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(status.enabled ? 'disable' : 'enable')}>{status.enabled ? 'Turn off remote Kiln access' : 'Enable remote Kiln access'}</Button>}
        {status.state === 'ready' && !details && <Button size="sm" variant="outline" disabled={busy} onClick={() => void reveal()}>Reveal connection details</Button>}
      </div>}
      {status?.state === 'ready' && details && <div className="flex flex-col gap-2 rounded bg-muted p-2">
        <p>On the other computer, choose On another computer and enter these details. The token grants control of this Kiln.</p>
        <label>Remote Kiln URL<input aria-label="Shared Kiln URL" readOnly value={details.url} className="mt-1 w-full rounded border bg-background p-2" /></label>
        <label>Bearer token<SecretInput aria-label="Shared Kiln bearer token" readOnly value={details.token} className="mt-1 w-full rounded border bg-background p-2" /></label>
        <div className="flex gap-2"><Button size="xs" variant="outline" onClick={async () => setNotice(await copyText(details.url) ? 'Kiln URL copied.' : 'Ember could not copy the URL. Select the URL above and copy it manually.')}>Copy Kiln URL</Button><Button size="xs" variant="outline" onClick={async () => setNotice(await copyText(details.token) ? 'Bearer token copied. Keep it private.' : 'Ember could not copy the token. Try copying again.')}>Copy bearer token</Button><Button size="xs" variant="ghost" onClick={() => setDetails(null)}>Hide details</Button></div>
      </div>}
    </>}
    {status?.instructions && <details className="text-muted-foreground"><summary className="cursor-pointer py-2">Reviewed Tailscale commands</summary><p>These are instructions, not commands Ember runs. Review existing settings and coordinate with anyone else managing this host before changing a port. Never use Funnel or reset unrelated forwards.</p><pre className="my-2 select-all whitespace-pre-wrap rounded border p-2">{status.instructions}</pre><Button size="xs" variant="outline" onClick={async () => setNotice(await copyText(status.instructions!) ? 'Commands copied. Review this host’s Serve configuration before running them.' : 'Ember could not copy the commands. Select them above and copy by hand.')}>Copy commands</Button></details>}
    {notice && <p role="status">{notice}</p>}
    <p className="text-muted-foreground">This shares the Kiln API, not Ember’s browser UI. Browser access is a separate setting on port 57821.</p>
  </section>;
}
