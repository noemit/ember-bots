# Connections and remote access

[Back to the README](../README.md)

## The included Kiln

The desktop app includes a local Kiln, shown as **This computer**. It starts with Ember and stops
when Ember quits. On macOS, closing a window does not quit the app. History stays on disk after quit.

Ember can connect to other Kilns without owning their lifetime. A standalone backend continues
running when you quit Ember.

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
