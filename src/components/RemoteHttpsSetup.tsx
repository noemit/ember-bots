import * as React from 'react';
import type { EmberSettingsPatch } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function RemoteHttpsSetup({ origin, onChange }: { origin?: string; onChange: (patch: EmberSettingsPatch) => void }) {
  const [value, setValue] = React.useState(origin ?? '');
  const [error, setError] = React.useState('');
  React.useEffect(() => setValue(origin ?? ''), [origin]);
  const desktop = window.ember.capabilities?.endpointManagement !== false;
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    try {
      if (text) {
        const parsed = new URL(text);
        if (parsed.protocol !== 'https:' || parsed.origin !== text || parsed.username || parsed.password) throw new Error();
      }
      setError('');
      onChange({ remoteAccessProxyOrigin: text });
    } catch { setError('Enter only the HTTPS origin, including its port if needed, without a path or trailing slash.'); }
  };
  return <details className="rounded-md border p-3 text-xs">
    <summary className="cursor-pointer py-1 font-medium">Install Ember on a phone with private HTTPS</summary>
    <div className="mt-3 flex flex-col gap-3">
      <p>This shares the Ember browser UI, not the Kiln API. Configure a private HTTPS reverse proxy on the Ember computer first. Ember does not change Tailscale or expose a public tunnel.</p>
      <p>Saving an origin switches Ember to loopback-only port 57821 and signs out browser sessions. Your proxy must forward to 127.0.0.1:57821, preserve the exact HTTPS Host, and set X-Forwarded-Proto to https. Keep Ember running and the computer reachable.</p>
      <p>For Tailscale Serve or Caddy setup, readiness checks and targeted rollback, follow <button className="underline" onClick={() => void window.ember.openExternal('https://github.com/noemit/ember-bots/blob/main/docs/instances.md#private-https-with-an-explicit-reverse-proxy')}>the private HTTPS guide</button>. Never reset or replace existing Serve configuration.</p>
      {desktop ? <form onSubmit={save} className="flex flex-col gap-2">
        <label htmlFor="remote-https-origin">Reviewed private HTTPS origin</label>
        <Input id="remote-https-origin" type="url" placeholder="https://computer.tailnet-name.ts.net:8443" value={value} onChange={(event) => setValue(event.target.value)} />
        {error && <p role="alert">{error}</p>}
        <Button className="self-start" variant="secondary" type="submit">Save HTTPS origin</Button>
        {origin && <Button className="self-start" variant="ghost" type="button" onClick={() => { setValue(''); onChange({ remoteAccessProxyOrigin: '' }); }}>Return to Tailscale HTTP</Button>}
      </form> : <p>Change browser access on the Ember desktop, not from this phone.</p>}
      {origin && <p>Configured address: <a className="underline" href={origin} target="_blank" rel="noreferrer">{origin}</a>. Configuration is not proof of reachability. Open it on the phone; verify sign-in, sign-out and rejected anonymous API access before relying on it.</p>}
      <p>iPhone: Safari → Share → Add to Home Screen. Android: Chrome menu → Install app. HTTP browsing still works without installation. Offline conversations, sending, background sync and push notifications are not included.</p>
    </div>
  </details>;
}
