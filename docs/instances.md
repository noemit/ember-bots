# Connections and remote access

[Back to the README](../README.md)

## The included Kiln

The desktop app includes a local Kiln, shown as **This computer**. It starts with Ember and stops
when Ember quits. On macOS, closing a window does not quit the app. History stays on disk after quit.

Ember can connect to other Kilns without owning their lifetime. A standalone backend continues
running when you quit Ember.

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
published; Windows workflow artifacts include `tinder-cli.exe`.

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

## Remote access

For a short walkthrough, see [Use Ember over Tailscale](tailscale.md).

This is browser access to the Ember app running on your desktop, separate from connecting Ember to
a remote Kiln. It is disabled by default.

1. Connect Tailscale on the desktop host and the device you want to use.
2. In **Settings → General**, set a remote-access password.
3. Enable **Allow access over Tailscale**.
4. Open `http://<tailscale-ip>:57821`, using the host’s Tailscale IPv4 address.
5. Sign in with the password you set and keep Ember running on the host.

The listener binds to the detected Tailscale IPv4 address, not all network interfaces. It serves
plain HTTP inside the Tailnet, hashes the password, and uses an HttpOnly, SameSite=Strict session
cookie. Do not expose it through public port forwarding.

Browser clients use the desktop host’s settings and model-experience store. Logout closes event
streams; disabling or restarting remote access disconnects clients. If remote access does not
start, check that the host has a Tailscale IPv4 address and a configured password, then inspect the
terminal running Ember for its listening address or error. Two Ember profiles should not enable
remote access simultaneously: both would use port 57821.

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

On the computer running Kiln, open **Settings → Instances → Share this Kiln**, then choose
**Enable remote Kiln access**. This is an explicit network configuration change. Ember checks
Tailscale membership, checks that Kiln rejects anonymous API requests, and creates one persistent
background **Serve TCP** forward only when its port is unused. It never enables Funnel and does
not replace another Serve setup. It verifies the forwarded address both without and with the
bearer token before offering **Reveal connection details**. Merely detecting a Tailscale IP does
not prove Kiln is reachable. Tailscale ACLs must still allow the other computer to connect.

The copyable URL and bearer token belong in **On another computer** on the second desktop.
Keep the token private: it grants control of Kiln. **Turn off remote Kiln access** removes only
the forward Ember recorded as its own; changed or conflicting rules require administrator review.
A failed readiness check can still leave sharing enabled if rollback could not complete: use the
stop-sharing action and read its result rather than assuming the forward was removed.

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
