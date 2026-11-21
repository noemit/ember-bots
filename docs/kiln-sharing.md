# Connect Ember to another Kiln

In **Settings → Computers and Containers → Add computer or container**, choose **On this computer** or **On another computer or container**. Enter a name, the Kiln API URL and its bearer token. You do not have to choose a network type first. **Connection help** has optional Tailscale, Cloudflare Tunnel and custom-proxy guidance.

Use **Test connection** before saving. The desktop test verifies Kiln’s health identity and an authenticated one-item conversation-list request; sharing reuses that same health/readiness checker and proves anonymous denial on the conversation route. A successful test means this Ember desktop reached Kiln and authenticated. It does not prove that another computer can connect.

## Local by default

Fresh Kiln installations, including standalone Tinder, default to binding `127.0.0.1` instead of all interfaces. Pre-upgrade databases retain the established implicit bind through the existing migration policy. The included Kiln already used loopback. Existing explicit `HEARTH_BIND` and `EMBER_BIND` values retain their precedence and are not overwritten.

**Migration:** existing explicit `HEARTH_BIND` and `EMBER_BIND` values keep their precedence. The existing `kiln-bind-default` migration preserves the implicit wildcard bind for pre-upgrade standalone databases, so this integration does not silently disconnect those clients. Changing that established bind is a deliberate administrator action: set `HEARTH_BIND=127.0.0.1` (or the legacy `EMBER_BIND`) in your service environment, configure a reviewed tailnet forward or HTTPS tunnel, and restart that service yourself. Review firewall rules and retain bearer authentication. Ember never rebinds, restarts or stops an externally managed Kiln.

## Share this Kiln

The host's **Settings → Remote access → Share this Kiln** explains its listener and lifetime. Opening the panel inspects sharing read-only; **Check sharing** refreshes that review. Verified conditional-update access and loopback authentication make **Enable remote Kiln access** available. Press it deliberately to create a persistent tailnet-only TCP forward. **Reveal connection details** then shows a separately copyable URL and bearer token for adding a connection on the other computer. Treat the token as full authority over that Kiln.

Only an included Kiln started by this Ember is eligible for networking changes. Existing unowned forwards can be inspected, not adopted or removed. External Kilns receive instructions, never process or networking changes.

**Platform support and validation:**

| Host installation | Automatic transport | Validation here |
| --- | --- | --- |
| Linux system daemon | Root-owned `/var/run/tailscale/tailscaled.sock` | Disposable Unix HTTP/CAS integration on Linux; no live daemon changes |
| macOS App Store GUI | Official same-user `IPNExtension` proof lookup, authenticated literal-loopback proxy | Synthetic lookup output and loopback auth/CAS fixtures; native Mac check still required |
| macOS system-extension GUI | Official `/Library/Tailscale/ipnport` symlink and protected `sameuserproof-<port>` file | Temporary proof layout and loopback auth/CAS fixtures; native Mac check still required |
| macOS standalone daemon | Root-owned `/var/run/tailscaled.socket` | Same Unix protocol fixture; native Mac check still required |
| Windows | **Gated off**: official identification-level named-pipe connection not established in Node | No native Windows integration; manual commands remain available |

Mac discovery follows Tailscale’s own safesocket order: same-user App Store proof, system-extension proof, then standard daemon socket. It does not read browser profiles, provider credentials or arbitrary environment-selected directories. The local-daemon proof stays only in backend memory and is sent in Basic auth solely to `127.0.0.1` at the discovered port; it is never copied, logged, returned to the renderer, persisted with endpoints or sent to Kiln. Ambiguous or invalid proofs fail closed. Permission, missing-daemon and unsupported-ETag errors leave mutation controls unavailable with recovery guidance; there is no unsafe CLI-write fallback. Finder-launched Ember can use the official `/Applications/Tailscale.app/Contents/MacOS/Tailscale` CLI entry point for bounded read-only feature help when no PATH symlink exists.

The included Kiln starts with Ember and stops when Ember quits. A persistent Tailscale forward may remain configured after quitting, but cannot serve an absent backend. Closing a macOS window is not quitting. A standalone Tinder service has an independent lifetime and remains running when an Ember client quits.

### Tailscale

Connect both computers to your tailnet and allow their connection in tailnet ACLs/grants. For a loopback Kiln on port 3002, the relevant CLI commands are:

```sh
tailscale serve --help
tailscale serve status --json
# Deliberately create a persistent tailnet TCP forward:
tailscale serve --bg --tcp=3002 127.0.0.1:3002
# Remove only that port's forward when you no longer want it:
tailscale serve --tcp=3002 off
```

Review existing Serve configuration first. Do not use `serve reset`: other services may rely on it. Never use Funnel for this workflow. Raw TCP forwarding preserves Kiln's bearer and WebSocket authentication; Tailscale encrypts transport between tailnet members even though the API URL uses `http://`.

A detected Tailscale IP is not a reachability check. The host checks its authenticated loopback listener, the configured forward, and an authenticated request through that forward from the host itself. Even success cannot prove a remote computer's ACL permissions. Run **Test connection** in the other Ember desktop; check its tailnet connection and policy if it fails.

**Conditional updates and ownership:** Ember never executes Serve CLI mutations. It reads LocalAPI `/localapi/v0/serve-config`, verifies its SHA-256 ETag against the response bytes, then sends the exact ETag in `If-Match` when adding or removing its TCP handler. The daemon checks the hash and writes under its mutex. A competing change fails the precondition; Ember does not retry over it. Unrelated Web, services, foreground and TCP settings are carried through unchanged. The new handler is top-level, matching the persistence of `serve --bg`, not an ephemeral foreground session. Funnel is never enabled.

An atomic local receipt records the daemon node ID, loopback target and the acknowledged configuration ETag. Disable requires that exact receipt and current configuration digest. Prior authority is durably cleared before an enable/removal request is sent; a new receipt is written only after an acknowledged enable and verification. A timeout therefore cannot preserve a stale receipt that would adopt a later matching foreign configuration. Even an unrelated later Serve edit invalidates the receipt: Ember conservatively refuses removal rather than guessing that it still owns the setup. Review changed configurations on the host yourself. A matching preexisting forward without a receipt is not adopted. Earlier CLI-sharing `pending`/`active` records lack an acknowledged conditional receipt and cannot authorize deletion; their existing forward is left in place for administrator review. Kiln lifecycle and sharing operations are serialized within Ember; external writers are guarded by the daemon's conditional update.

If a newly created forward fails verification, rollback rereads the current configuration and removes only that new port, with another `If-Match`. A changed daemon identity/configuration or failed precondition prevents rollback; Ember leaves newer settings intact and reports the uncertain outcome. It never restores a whole old snapshot or resets other services. If a write's acknowledgement is lost—even if the daemon actually applied it—Ember does not manufacture a receipt from target equality. Check sharing can show the matching forward read-only, but it cannot adopt or delete it. Review Serve on the host before changing it manually. The daemon’s ETag is a content hash, not a monotonic revision or global proof of writer identity; identical restored configurations are not distinguishable. No claim of global atomic authorship is made.

### Cloudflare Tunnel and Access

Configure your own Cloudflare Tunnel to the host's loopback Kiln, then enter its HTTPS URL. Ember does not create tunnels or publish ports. Keep Kiln bearer authentication enabled.

If Cloudflare Access protects that route, create an appropriate service-token policy and open **Advanced → Cloudflare Access** in the endpoint form. Enter its client ID and client secret in addition to the Kiln bearer token. Interactive browser sign-in does not authenticate desktop HTTP or WebSocket connections.

The gate credentials use main’s existing OS-encrypted `access`/`hasAccessSecret` storage (never a parallel plaintext field); locked credentials never fall back to bearer-only authentication, sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers to that HTTPS endpoint, and never exported to remote browsers or peer Kilns. Both REST requests and streaming WebSockets carry those headers. Redirect following is disabled so credentials are not forwarded to another origin. The connection test distinguishes an identifiable Access redirect, Kiln's own unauthorized response, and an unidentifiable proxy rejection rather than guessing from a blanket status code. Diagnostics do not echo response bodies or credentials.

## Not Ember browser remote access

Ember's optional browser server on **port 57821** displays the desktop interface and uses an Ember password/session cookie. It is not the Kiln API. Do not paste that address or browser password into Add instance. Browser remote access cannot manage endpoint secrets or host-sharing commands.

## Implementation validation and remaining manual check

Development tests inject command runners and use temporary profiles, synthetic credentials and loopback test servers only. No test changes live Tailscale configuration. The Unix HTTP/CAS protocol is tested against disposable sockets, not the live Tailscale daemon. Actual tailnet ACLs, root-socket permissions, native macOS integration, persistent routing across restarts, and a real configured Cloudflare Access service-token policy still require an explicit manual check by the host owner. Windows mutation controls remain gated. The implemented Mac discovery/proxy paths are not claimed as natively validated until the owner-authorized Mac check passes.

### Serve semantics reviewed

Read-only installed CLI review: Tailscale 1.104.2, `tailscale serve --help` advertises `--bg`, `--tcp` and tailnet-only Serve. Upstream v1.80.3 source provides the contract:

- [`cmd/tailscale/cli/serve_v2.go`](https://github.com/tailscale/tailscale/blob/v1.80.3/cmd/tailscale/cli/serve_v2.go): `runServeCombined` lines 242–318 persist the parent configuration and use `Foreground` only without `--bg`; `applyTCPServe` lines 534–559 sets the TCP destination; `removeTCPServe` lines 769–782 removes only the selected TCP port.
- [`ipn/serve.go`](https://github.com/tailscale/tailscale/blob/v1.80.3/ipn/serve.go): `ServeConfig.TCP` is explicitly for the Tailscale IP addresses; its ETag becomes `If-Match` on `SetServeConfig`.
- The CLI's `validateConfig` allows a same-mode background TCP destination to be replaced. It does not provide Ember with an external ownership lock.

Atomic-access research evidence (public source only; no live LocalAPI/state/credential inspection):

- [`ipn/localapi/localapi.go`](https://github.com/tailscale/tailscale/blob/v1.80.3/ipn/localapi/localapi.go), `serveServeConfig`: GET returns a SHA-256 ETag; POST forwards `If-Match` to `SetServeConfig` and returns a precondition failure on mismatch.
- [`ipn/ipnlocal/serve.go`](https://github.com/tailscale/tailscale/blob/v1.80.3/ipn/ipnlocal/serve.go), `SetServeConfig` / `setServeConfigLocked`: the mutex covers comparison of the previous JSON hash and the configuration write.
- [`safesocket/pipe_windows.go`](https://github.com/tailscale/tailscale/blob/v1.80.3/safesocket/pipe_windows.go), `connect`: `DialPipeAccessImpLevel` explicitly uses `PipeImpLevelIdentification`. A plain Node pipe connection has not been established as an equivalent authenticated integration here.
- [`safesocket/safesocket_darwin.go`](https://github.com/tailscale/tailscale/blob/v1.80.3/safesocket/safesocket_darwin.go), `localTCPPortAndTokenMacsys` and `localTCPPortAndTokenDarwin`: GUI variants discover a local proxy port plus same-user proof; sandboxed and standalone variants differ. Only synthetic/temp proof fixtures were used during development; no real proof files were opened.

### Packaging

Atomic sharing uses Node’s built-in Unix HTTP transport and filesystem APIs, with no native addon or Go helper. Standard system socket paths are fixed rather than accepted through remote IPC or environment overrides. This integration preserves main’s existing `undici` WebSocket implementation for separate Cloudflare Access headers, including its real Node/TLS redirect-leak fixture. The earlier task-only `ws` dependency was dropped during rebase; no dependency or lockfile addition is needed. Existing packaged-app tests and a native owner-authorized network pass remain necessary before declaring a platform validated.

Mac GUI source contract additionally reviewed at Tailscale commit [`0d822c9d3ab06465e95868fe63c6a26fff55e170`](https://github.com/tailscale/tailscale/blob/0d822c9d3ab06465e95868fe63c6a26fff55e170/safesocket/safesocket_darwin.go): `readMacosSameUserProof`, `readMacsysSameUserProof`, and `portAndTokenFromSameUserProof` use the same scoped discovery paths. [`client/local/local.go`](https://github.com/tailscale/tailscale/blob/0d822c9d3ab06465e95868fe63c6a26fff55e170/client/local/local.go), `DoLocalRequest`, supplies Basic auth for the local proxy. These internal APIs may change; unsupported layouts are refused rather than guessed at.
