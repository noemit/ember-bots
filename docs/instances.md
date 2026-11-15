# Connections and remote access

[Back to the README](../README.md)

## The included Kiln

The desktop app includes a local Kiln, shown as **This computer**. It starts with Ember and stops
when Ember quits. On macOS, closing a window does not quit the app. History stays on disk after quit.

Ember can connect to other Kilns without owning their lifetime. A standalone backend continues
running when you quit Ember.

## Add and share a Kiln

Use **Settings → Instances → Add instance** to connect a local or remote Kiln by URL and bearer token.
See [Kiln sharing](kiln-sharing.md) for conditional tailnet setup, Cloudflare Access and platform support.

## Ollama

Open **Settings → Providers**, select the Kiln that should run the model, and find **Ollama**.
The same option appears during onboarding. No account or API key is needed.

Install and start [Ollama](https://ollama.com/download) on that Kiln’s computer. Install a model
there, for example with `ollama pull llama3.2:3b`, choosing one that fits the computer’s memory.
Downloads can be large; Ember never installs software, downloads models or changes network settings.
Choose **Test / Refresh** to discover installed models, then keep the current default or explicitly
choose a new one. Existing chat selections do not change.

The default service address is `http://127.0.0.1:11434` **on the selected Kiln**, not on the computer
showing this window. **Change address** supports another computer or container that Kiln can already
reach. Enter the service address without `/v1`; **Test / Refresh** saves it on that host.
**Reset address** removes the saved override and restores the host’s `OLLAMA_HOST` setting, or the
loopback default if no environment setting exists. An invalid environment address is reported so you
can correct it with **Change address**. You do not need to edit environment files.
Do not expose a keyless Ollama service to the public internet. For an authenticated proxy, use a
custom provider instead.

Ollama discovery reads `/api/tags`; inference uses the existing OpenAI-compatible transport at
`/v1/chat/completions`. Models are offered conservatively as text-only, without reasoning controls,
with an 8k context / 4k output budget. An empty installation offers no invented models: pull one on
the Ollama computer, then refresh.

## Self-hosted OpenAI-compatible models

In **Settings → Providers**, select the Kiln that should make inference requests, then choose
**Add custom provider**. The same editor is available during onboarding.

Give it a display name and the server's API base URL, including its path, for example
`http://spark:8000/v1`. LAN hosts, remote hosts, ports and nested API paths are supported. The address
must be reachable **from the selected Kiln**, not just from the computer showing Ember. HTTP is
unencrypted; use it only on a network you trust.

An API key is optional. Choose **Discover models** to read `<base URL>/models`, or enter the exact
model IDs your server accepts, one per line. Manual IDs work even when discovery is unavailable.
Models use standard OpenAI chat completions, with conservative 8k context / 4k output defaults and
text input. No environment variables or configuration-file edits are needed.

Saving makes the models available in the model picker and offers **Keep current default** or
**Choose default model**. Existing model choices never change automatically. Edit or remove the
provider from the same screen; changing a keyed server's URL requires re-entering its key or
explicitly choosing keyless access. Removing a provider removes its saved key too, but leaves
existing chats and their model choices intact.

Configuration belongs to that Kiln. Keys use its private credential store and are never returned
by provider/configuration reads or saved in Ember settings. Each saved key is bound to its exact
normalized API base URL. Editing or removing a provider cancels its old requests; refresh models
before retrying a pending send. If Kiln cannot verify a saved key's destination (including an older
unbound credential), re-enter it in this editor or explicitly choose keyless access.

## Standalone Kiln with Tinder

For a headless machine, download the matching Tinder executable from
[GitHub Releases](https://github.com/noemit/ember-bots/releases/latest). The compiled executable
includes Kiln and needs neither Bun nor the desktop app. macOS ARM64 and Linux x64 downloads are
published; future Windows workflow artifacts use `tinder-windows-x64.exe` (see [release contract](../RELEASES.md)); older tags retain their original names.

On macOS or Linux, make the downloaded file executable and rename it to `tinder` if you want the
commands below to match exactly. Keep it in a permanent location before setting up a service:
service configuration records its absolute path.

```sh
# Run in this terminal; Ctrl+C stops it.
./tinder serve
```

For a service managed by systemd or launchd:

```sh
./tinder setup --headless
```

Run the enable/load command Tinder prints, then check the service and obtain its connection details:

```sh
./tinder status
./tinder token
```

The token command prints a bearer credential; keep it private. Stop a service with its service
manager. For a second Kiln on the same computer, choose a separate home and port:

```sh
./tinder serve --home ~/.ember-server --port 3003
```

Use the same `--home` and `--port` with `status` and `token`.

## Connecting another Kiln

Open **Settings → Instances** and add the Kiln’s reachable URL and bearer token. Add, edit and test
connections there. A token authorizes access to that host, so do not put it in source or screenshots.

On first launch, Ember can also seed an existing local endpoint at `http://127.0.0.1:3002` from a
local token under `~/.ember`, `~/.hearth`, `EMBER_HOME` or `HEARTH_HOME`. The included Kiln needs no
manual token setup.

## Connecting OpenChamber

Configure your instances in OpenChamber first. Ember reads its saved HTTP endpoints from:

```text
~/.config/openchamber/settings.json
```

It probes those endpoints; it does not create SSH tunnels or manage OpenChamber’s provider
credentials. For a non-default OpenChamber configuration directory when running from source:

```sh
OPENCHAMBER_DATA_DIR="/path/to/openchamber" bun run dev
```

This changes where Ember reads OpenChamber’s settings, not where Ember stores its own data.
If a host is unreachable, establish its HTTP connection or tunnel first, then use
**Instances → Reprobe instances**. Private Relay instances are not supported.

## Remote access: Ember in your browser

This is the **Ember browser UI**, not a Kiln API endpoint. **Share this Kiln** in Settings →
Instances exposes the agent API with a bearer token; it does not serve a website or install a PWA.
Browser access instead serves the desktop workspace on port **57821**, uses its own password,
and ends when Ember quits. Keep that computer awake. On macOS, closing its window is not quitting.

### Direct Tailscale HTTP (no proxy required)

1. Connect Tailscale on the desktop and the device you want to use, with a tailnet policy that
   permits access between them.
2. In the desktop's **Settings → General**, set a **Remote access password** (8–256 characters).
3. Enable browser access, leaving the HTTPS proxy origin empty.
4. Wait for the listener to report **Listening**, then open `http://<tailscale-ip>:57821` on the
   second device. Get the host's IPv4 address from Tailscale or `tailscale ip -4`.
5. Sign in with the Ember password. Bookmark the address and keep Ember running.

This binds only the detected Tailscale IPv4 address, never all interfaces. Tailscale encrypts the
network connection, but the browser still sees an HTTP website: installation and service-worker
features require HTTPS. Direct HTTP remains supported for ordinary browser use. Do not forward this
port from a public router. Two Ember profiles cannot use port 57821 simultaneously.

### Private HTTPS with an explicit reverse proxy

For an installable phone/tablet app, first provide a valid HTTPS origin that the device can reach.
Ember does **not** create certificates, change DNS, run Serve commands or alter network settings for
you. Configure a proxy **on the Ember computer**, then save its exact external HTTPS origin in the
desktop's browser-access settings. For example: `https://ember-host.your-tailnet.ts.net:8443`.
No URL path, credentials, query or fragment is allowed.

Saving the origin switches Ember's listener to **127.0.0.1:57821 only**. The old direct tailnet HTTP
address stops working. Your proxy must terminate TLS, connect to that numeric loopback address,
preserve the original external **Host** (including a non-default port), and **overwrite**
`X-Forwarded-Proto` with `https`. Do not append a comma-separated chain. Ember checks the loopback
socket peer, the configured host and protocol; forwarded host/IP headers cannot authorize a request.
A proxy on another computer/container network is not supported. Local software on the Ember host
is within this trust boundary, so do not run an untrusted local forwarder.

#### Option A: Tailscale Serve, private to your tailnet

Install/connect Tailscale on both devices and enable MagicDNS/HTTPS certificates in your tailnet
as required by [Tailscale Serve](https://tailscale.com/kb/1312/serve). Review these **read-only** commands
on the hosting computer first:

```sh
tailscale version
tailscale status --json
tailscale serve status --json
```

Use a dedicated, unused HTTPS port, for example **8443**. If Serve already has anything on that
port, **do not replace it**: choose a different unused port or ask its administrator. Do not use
`serve reset`, `funnel`, or copy a whole configuration over an existing one. The Kiln API sharing
feature may already own a different Serve forward; leave it untouched.

After reviewing the current configuration, the following is an **explicit administrator action**,
not something Ember runs:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:57821
```

Follow Tailscale's HTTPS permission prompt if needed. Copy the exact HTTPS origin printed by Serve
(including `:8443`) into Ember's HTTPS proxy origin setting, enable browser access, and open that
HTTPS address on the second Tailscale-connected device. Current Serve preserves Host and sets the
HTTPS forwarding header for this HTTP upstream. If your platform/version does not, use a supported
local proxy below rather than weakening Ember's checks. Tailnet ACLs/firewalls must permit the chosen
HTTPS port. Use **Serve**, not **Funnel**: Funnel makes a service public.

Review `tailscale serve status --json` afterwards and confirm that unrelated entries remain unchanged.
To stop this setup, disable browser access in Ember first. Only if this is still your dedicated
unchanged Serve port, remove **that port alone** with `tailscale serve --https=8443 off`. If someone
changed it meanwhile, ask its administrator instead. Never reset all Serve configuration.

#### Option B: an existing local HTTPS reverse proxy

Use a hostname/certificate your device trusts and resolves to this host. For example, in an existing
Caddy setup, add a **new, dedicated site** (do not overwrite other sites):

```caddyfile
ember.example.net {
    reverse_proxy 127.0.0.1:57821 {
        header_up Host ember.example.net
        header_up X-Forwarded-Proto https
        flush_interval -1
    }
}
```

Set Ember's proxy origin to `https://ember.example.net`. Review/reload the proxy through its normal
administrator workflow. Configure private reachability/firewall restrictions yourself; this example
does not make a public hostname private or provision a tailnet. If using a non-default HTTPS port,
include the same port in the site, upstream Host and Ember origin. For other proxies, disable response
caching and SSE buffering, allow long-lived `/remote/events` requests, and do not strip `/remote/`
paths. Do not bypass Ember login or inject permissive CORS headers.

### Verify, install and recover

From the second device, open the **configured HTTPS origin**. Confirm that the browser reports a
trusted secure connection, sign in, open an existing chat, and verify that new replies arrive live.
Then use your browser's **Install app** action, or on iPhone/iPad **Share → Add to Home Screen**.
Availability depends on browser/device support. The installed app still needs the host, network and
Ember running; installation does not run bots on the phone or make chats available offline.

Only a secret-free offline page and enumerated app-shell files are cached, not conversation HTML,
API responses, private images or credentials. An open app preserves unsent text, attachments and reply
context in memory while disconnected; keep it open. Remote drafts are deliberately not written to
browser storage or the desktop's shared drafts. Closing, refreshing or OS eviction can lose them,
particularly while offline; copy important text first. Messages whose send response was lost remain
unconfirmed, not automatically retried. Messages already accepted or queued on the host may still run.
Updates offer **Prepare update**, then a separate **Refresh to use update** action; neither refreshes
without your choice. Finish active work and resolve drafts, attachments and pending sends first.
No push notifications, offline sending, deferred upload or background sync are provided.

Before relying on the address, use a private browser window with no Ember cookie: `/remote/settings`
and `/remote/model-stats` must redirect to sign-in, never return data. An anonymous POST to
`/remote/pi` must be refused. Do not put your password or session cookie in shell history. After
signing in normally, verify chats and live replies, then sign out from **Phone app → Sign out**
and confirm that the workspace requires sign-in again. Sessions expire
after 12 idle hours and at most 7 days. Logout closes that session's event streams. Changing the
password, changing proxy origin or disabling browser access drops all listener sessions/streams;
clients must sign in again. HTTPS uses a Secure, HttpOnly, SameSite=Strict, host-only cookie; direct
HTTP uses a separate non-Secure cookie. Responses are marked no-store; proxies must respect it.

- **No listening address:** check the status in desktop settings. Direct HTTP needs a Tailscale
  IPv4 address; HTTPS proxy mode needs the local port free, not a Tailscale adapter.
- **Address not recognized:** the proxy's preserved Host/port or HTTPS header does not match the
  saved origin. Correct the proxy and the desktop setting; do not add broad trusted-host rules.
- **Another website was refused:** reopen the saved origin directly. Do not embed Ember cross-site.
- **HTTPS does not load:** check DNS, trusted certificate, private network policy, proxy availability
  and the exact port from the other device. A loopback listener being ready is not proof the proxy
  is reachable. Ember does not claim or probe certificate ownership.
- **Need direct HTTP again:** clear the HTTPS proxy origin on the desktop and save. Ember rebinds to
  the detected Tailscale IPv4 address. Review/remove only your own proxy entry separately.

No real host exposure or Tailscale changes are performed by the fixture-based automated tests.
Verify live reachability and installation on your own authorized devices before relying on them.

## Align multiple Ember setups

In **Settings → Instances**, open **Align all my instances**, then **Review instances**.
Each connected Kiln reports the connections and stored API keys it can share. Expand the connection
list to inspect addresses, then choose **Align now**. Missing connections are added to this Ember
and shared with the reviewed Kilns. Run the same action in your other Ember apps to import them there.
Newly discovered hosts are not changed until you review them in another pass.

To share providers, open **Settings → Providers → Review and share**, or use the same entry in
**Align all my instances**. Compare provider availability, choose a source, and explicitly select
which missing providers to share with which destinations. Nothing is selected automatically.
The source Kiln sends credentials directly to the selected Kilns at reviewed private-network or
HTTPS addresses. Provider secrets never pass through the settings window. Existing stored
credentials (including expired sign-ins) and environment credentials are preserved. Environment-only
keys are identified but are not exported; configure those separately on each host. Custom-provider
keys require matching reviewed provider definitions on both Kilns, including the name, base URL,
API path and models. Each host keeps its own provider ID; the review maps those existing definitions
explicitly. A missing, ambiguous or different configuration is blocked; sharing does not install or
replace provider definitions. Anyone able to use a destination Kiln can use the accounts shared
there.

**Codex and Antigravity sign-in sharing is experimental and requires a separate acknowledgement.**
Each host refreshes its own stored copy; there is no cross-host refresh coordination. Refreshing on
one computer may invalidate another computer's copy and require signing in again. The implementation
preserves Codex account information and Antigravity project/account metadata, but offline tests do
not establish the providers' live refresh-token reuse policies. Other OAuth providers are not shared.
Signing in separately on each host remains the safer option.

For a cautious live test, start with one nonessential destination that has no credential for the
selected provider. Review its address and the experimental warning, then share only that provider.
Confirm both hosts still work before relying on the copy. Test again after each has refreshed its
token; success immediately after copying is not evidence that later refreshes are independent.
If either host loses its sign-in, sign in there separately rather than overwriting its credential
through alignment. No live account or provider requests are made by the offline regression tests.

This is a deliberate one-time action, not ongoing sync. It leaves chats, folders, model defaults
and local runtimes on their own instances. Loopback addresses are not portable; use a reachable
Tailscale/private address or HTTPS URL for a host you want to share. The included Kiln can be a
provider source, but cannot receive keys from another computer through its loopback address.
Older or offline hosts are reported rather than blocking the rest; update both Kilns to a build
that supports reviewed provider sharing, check their connections, then review again. Alignment is
available in the desktop app; remote browser clients cannot access alignment routes.

## Add another Kiln

In **Settings → Instances → Add instance**, choose **On this computer** or **On another
computer**. For another computer, enter its name, Kiln URL and bearer token. Test the connection,
then add it. You do not need to choose a networking product first. Reverse-proxy URL paths and
IPv6 addresses (in brackets) are supported. Use HTTPS outside a trusted private network.

**Connection help** explains Tailscale, Cloudflare Tunnel and a custom address without changing
network settings. Under **Advanced**, a Cloudflare Access service token supplies a client ID and
client secret *in addition to* Kiln’s bearer token. Access requires HTTPS. Ember sends both
credentials on API requests and live WebSocket connections; it refuses redirects rather than
forwarding credentials to a different location. A changed server origin requires re-entering the
Access secret. The desktop stores Access credentials encrypted with its system credential store;
on Linux, unlock a supported keyring first (the plaintext `basic_text` backend is not accepted).
Remote browsers cannot edit these desktop-only credentials or enable host sharing.

## Share this computer’s Kiln

Kiln stays on loopback by default for new installations. Existing explicit bind addresses and
pre-upgrade standalone databases retain their previous bind behavior; changing that old setup is
a separate, deliberate administrator action.

On the computer running the included Kiln, open **Settings → Instances → Share this Kiln**.
The panel checks sharing read-only; **Check sharing** refreshes it. Choose **Enable remote Kiln access** deliberately. Ember verifies authenticated
readiness and anonymous denial, then uses Tailscale LocalAPI ETag/If-Match updates to add a persistent
TCP forward. CLI writes, Funnel and whole-config resets are never used. Other settings are preserved;
a concurrent change stops the operation rather than being overwritten. Controls are offered only
for an Ember-owned bundled backend. External/Tinder processes receive copy-only guidance.

Choose **Reveal connection details**, then copy its URL and bearer token into **On another computer** on the second
desktop. A successful host-side check does not prove another computer’s ACL permissions: run
**Test connection** there too. **Turn off remote Kiln access** requires the durable receipt and exact
configuration digest. Unknown or changed configurations are not adopted or deleted. If a write
was applied but its response was lost, Ember reports the uncertainty and leaves recovery read-only;
review Serve on the host rather than assuming the forward was removed. See the
[sharing safety and platform support matrix](kiln-sharing.md) for Mac proof discovery, Windows
gating and the limits of content-addressed ownership receipts.

The forward persists in Tailscale, not an Ember-owned helper process. The bundled Kiln still
stops when Ember quits, and resumes with Ember; closing a macOS window is not quitting. An
already-running Tinder-managed Kiln remains independently owned. Sharing never stops it.
**Allow Ember browser access over Tailscale** is different: that setting serves Ember’s browser
UI on port **57821**, not the Kiln agent API.

### Administrator verification (only after choosing to share)

No real tailnet, macOS or Windows exposure was exercised by the fixture-based development tests.
On the hosting computer, these read-only commands help review the actual setup:

```sh
tailscale version
tailscale status --json
tailscale serve status --json
```

Look for a background TCP forward to numeric loopback on the selected port, and no Funnel
permission for that port. Do not paste output containing private configuration into public issues.
From the second authorized tailnet computer, test the copied URL without credentials first:

```sh
curl --max-time 10 --output /dev/null --write-out '%{http_code}\n' "$KILN_URL/conversations"
```

Expect an authentication rejection. Then test with the bearer token using a private HTTP client
or Ember’s **Test connection** (avoid putting tokens in shell history or command-line arguments).
Verify an authenticated conversation listing, live output, restart persistence and stop sharing.
If Tailscale is missing, lacks Serve permission, or the network ACL blocks the request, fix that
host/network policy and test again. Never use `serve reset` to recover Ember’s single forward.
