import { Button } from '@/components/ui/button';
import SecretInput from '@/components/ui/secret-input';
import { Input } from '@/components/ui/input';
import type { EndpointDraft } from '@/lib/endpoints';

export default function EndpointForm({ draft, onChange }: { draft: EndpointDraft; onChange: (draft: EndpointDraft) => void }) {
  return <div className="flex flex-col gap-2">
    <label className="text-xs">Instance name<Input value={draft.label} onChange={e => onChange({ ...draft, label: e.target.value })} placeholder="Studio Mac" aria-label="Instance name" /></label>
    <label className="text-xs">Kiln URL<Input value={draft.url} onChange={e => onChange({ ...draft, url: e.target.value })} placeholder="https://kiln.example.com" aria-label="Kiln URL" autoComplete="off" /></label>
    <label className="text-xs">Bearer token<SecretInput value={draft.token} onChange={e => onChange({ ...draft, token: e.target.value })} placeholder="From the computer running Kiln" aria-label="Bearer token" autoComplete="new-password" /></label>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2 font-medium">Connection help</summary>
      <p className="mb-2">Use a reachable Kiln URL and its bearer token. You do not need to choose a network type to connect.</p>
      <details><summary className="cursor-pointer py-2">Tailscale</summary><p>On the computer running Ember, open Settings → Instances → Share this Kiln and deliberately enable remote Kiln access. Connect both computers to the same Tailscale network, then copy the shared Kiln URL and bearer token here. For a standalone Tinder Kiln, ask its owner for its reachable address and token.</p></details>
      <details><summary className="cursor-pointer py-2">Cloudflare Tunnel</summary><p>Ask the host’s owner to point their tunnel at Kiln’s local API, not Ember’s browser UI. Enter the tunnel’s HTTPS URL above. If Cloudflare Access protects it, add a service credential under Advanced.</p></details>
      <details><summary className="cursor-pointer py-2">Custom connection</summary><p>Use your existing HTTPS reverse proxy or private-network address. The host must make Kiln reachable; adding an instance does not open a port or change its network settings.</p></details>
    </details>
    <details className="text-xs"><summary className="cursor-pointer py-2 font-medium">Advanced</summary>
      <p className="mb-2 text-muted-foreground">Cloudflare Access service credentials are optional and separate from Kiln’s bearer token. Ember sends them only to this connection’s configured origin. Keep them private.</p>
      <label>Cloudflare Access client ID<Input aria-label="Cloudflare Access client ID" value={draft.access?.clientId ?? ''} onChange={e => onChange({ ...draft, access: { clientId: e.target.value, clientSecret: draft.access?.clientSecret ?? '' } })} autoComplete="off" /></label>
      <label>Cloudflare Access client secret<SecretInput aria-label="Cloudflare Access client secret" placeholder={draft.hasAccessSecret ? 'Saved securely; leave blank to keep' : ''} value={draft.access?.clientSecret ?? ''} onChange={e => onChange({ ...draft, access: { clientId: draft.access?.clientId ?? '', clientSecret: e.target.value } })} autoComplete="new-password" /></label>
      {draft.access && <Button size="xs" variant="ghost" onClick={() => onChange({ ...draft, access: undefined, hasAccessSecret: undefined })}>Remove Access credentials</Button>}
    </details>
  </div>;
}
