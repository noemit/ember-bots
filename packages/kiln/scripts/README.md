# Hearth — running it on each device

Hearth is one process per device, each with its own SQLite, token, and port. Ember lists all of
them side by side via `piEndpoints` in `~/.config/ember/settings.json`.

## Example devices

| Device | Repo | `HEARTH_HOME` | Port | Client reaches it at |
|---|---|---|---|---|
| **Linux container** | `/workspace/hearth` | `/root/.pi` | 3002 (published) | `http://100.64.0.1:3002` |
| **Windows (native)** | `$env:USERPROFILE\workspace\hearth` | `$env:USERPROFILE\.hearth` | 3011 (if Docker owns 3000–3010; 8302 is a safe alternative) | `http://100.64.0.1:3011` |
| **macOS (Local)** | `~/hearth` | `~/.hearth` | 3005 | `http://127.0.0.1:3005` |

On macOS, port 3005 avoids common local conflicts (3000/3002/6080). On Windows with Docker Desktop
publishing 3000–3010/5432/8080, a Windows-native Hearth uses 3011+ and needs a firewall rule;
use `.hearth` if `$env:USERPROFILE\.pi` already holds an older `pi-coding-agent` tree.

## Start / stop / inspect — `scripts/hearth.sh`

Works on Linux, macOS, and Windows Git Bash, from the repo root or from `scripts/`:

```sh
~/hearth/scripts/hearth.sh start|stop|restart|update|status|url|token|logs
cd ~/hearth/scripts && ./hearth.sh start        # same thing
```

`hearth.sh` only works with `./` (or a path) — the repo is not on `PATH`, so a bare `hearth.sh`
is `command not found`, and `~/scripts/hearth.sh` looks in your home directory, not in the repo
(the script lives at `~/hearth/scripts/`).

`update` pulls the latest commit, runs `bun install --frozen-lockfile`, and restarts — the
explicit deploy path. With the default `HEARTH_AUTORELOAD` a plain `git pull` already restarts
Hearth onto the new commit, so `update` matters mainly when `bun.lock` changed (the watcher sees
the lock change and deliberately pauses rather than restart onto stale dependencies).

**Where a device launcher exists, `start`/`stop`/`restart` delegate to it** — launchd
`dev.ember.hearth` on macOS (override with `HEARTH_LAUNCHD_LABEL`), the `Hearth` scheduled task on
native Windows — because the launcher owns the `HEARTH_HOME`, the port, and the log. Without the
guard, `restart` on macOS used to spawn a second Hearth on 3002 while launchd's own kept 3005.
`HEARTH_SUPERVISOR=none` forces this script's supervisor instead. The port comes from
`$HEARTH_HOME/port` when present, else 3002 on Linux and 3005 elsewhere; a Linux container with no
launcher always uses this script.

After any update, confirm `/health` reports the version you pulled — the version is read from
`package.json` at startup, so a stale process reports the old one.

`HEARTH_HOME` defaults to `/root/.pi` on Linux and `~/.hearth` elsewhere. Linux uses `setsid`
for a real process-group supervisor; macOS/Windows fall back to `nohup`.

## Device launchers

The Windows launcher lives in this repo, parameterized per host:

- **Windows:** `scripts/install-windows.ps1`. Run once from PowerShell **as admin**
  on the host. It writes a supervising runner (`%HEARTH_HOME%\hearth-run.cmd` — restarts the Bun
  process on exit, including auto-reload after a `git pull`), registers the **Hearth** logon
  task, registers the **Hearth Watchdog** task (`scripts/hearth-watchdog.ps1`: keeps the port's
  firewall rule and restarts Hearth if it stops answering), and opens the port.

The macOS launchd agent and the container entrypoint stanza are host-specific one-offs kept outside
the repo:

- **macOS:** a launchd LaunchAgent (`dev.ember.hearth`, `KeepAlive`, logs to `~/.hearth/hearth.log`).
  There is no installer for it in this repo, so if `launchctl list dev.ember.hearth` fails the
  agent is missing and `hearth.sh start` will report failure after 90s of waiting on `:3005`. The
  shortest way back is to run Hearth unsupervised and install the agent later:

  ```sh
  HEARTH_SUPERVISOR=none ~/hearth/scripts/hearth.sh start   # nohup + disown, dies on logout
  ```

  This is a restart-on-logout host now, not a service; reinstall the LaunchAgent before relying on
  it across a reboot. Check first, because a loaded-but-kept-alive agent and a missing one look the
  same from `hearth.sh status` alone:

  ```sh
  launchctl list dev.ember.hearth        # 2nd column is the last exit code; 0 = it ran fine
  tail -n 40 ~/.hearth/hearth.log        # the reason a start failed is in here
  ```
- **Linux container:** an entrypoint stanza before the container's `while true; wait -n` loop.
  ⚠️ If `/root/.pi` is **not** a named volume, `hearth.sqlite`/`hearth.token` are lost on container
  recreation — mount `-v pi-hearth:/root/.pi/hearth` and set `HEARTH_HOME=/root/.pi/hearth` (keep
  the DB off a host bind mount like `/workspace`: SQLite WAL over a bind mount is a locking hazard).
  Backups already land in `$HEARTH_BACKUPS_DIR` — default `$HEARTH_HOME/backups` (containers can set
  `/workspace/backups`), 30 kept.

## Where an agent's processes run (Linux) — `scripts/hearth-agents-slice.sh`

Every command Hearth runs for a session goes through a wrapper shell (`src/shell.ts`) that starts it
in a **transient systemd scope** under `hearth-agents.slice`, a sibling of `hearth.service`:

```
user@1000.service/hearth.slice/hearth-agents.slice/run-<id>.scope   ← an agent's dev server, browser, job
user@1000.service/app.slice/hearth.service                          ← Hearth itself
```

Why: on 2026-11-04 an agent-launched Ember build, `vite`, a thumbnail server and Playwright's
Chromium were all inside `hearth.service`, which systemd-oomd then killed for 7.5 GB — 243 processes,
Hearth included, most of it not Hearth. Now those processes are accounted separately, a Hearth
restart leaves them running (and they are listed on their session, with a Stop), and a cap on the
slice kills *them* rather than the host.

The cap is opt-in and per-user (no sudo):

```sh
~/hearth/scripts/hearth-agents-slice.sh          # MemoryHigh=4G, MemoryMax=6G
~/hearth/scripts/hearth-agents-slice.sh 2G 3G    # tighter
~/hearth/scripts/hearth-agents-slice.sh off      # remove it
systemctl --user show hearth-agents.slice -p MemoryHigh -p MemoryMax
```

Hosts without a user manager (containers, macOS, Windows) skip the wrapper and run commands
exactly as before; `HEARTH_SCOPE_SHELL=0` turns it off on a Linux host that has one.

## Health check across devices — `scripts/health.sh`

```
# ~/.hearth/endpoints  (or $HEARTH_HOME/endpoints)
Container  http://100.64.0.1:3002  @/root/.pi/hearth.token
Windows    http://100.64.0.1:3011  @~/.hearth/hearth.token
Local      http://127.0.0.1:3005   @~/.hearth/hearth.token
```

`scripts/health.sh` prints `up`/`DOWN` per endpoint and exits non-zero if any is down. A
published port with nothing listening answers with an empty reply (not a 401) — that is a down
Hearth, not an auth problem.

## Remote control over SSH — `scripts/from-mac.sh`

```sh
HEARTH_SSH_HOST=remote-host scripts/from-mac.sh start   # or pass host as first arg; HEARTH_SSH_PORT/USER
scripts/from-mac.sh remote-host token
scripts/from-mac.sh remote-host url                     # prints the address Ember should use (real HostName + Hearth port)
```

## Point Ember at all of them

`~/.config/ember/settings.json` (or the canary dir):

```json
"piEndpoints": [
  { "id": "container", "label": "Container", "url": "http://100.64.0.1:3002", "token": "<container token>" },
  { "id": "windows",   "label": "Windows",   "url": "http://100.64.0.1:3011", "token": "<windows token>" },
  { "id": "local",     "label": "Local",     "url": "http://127.0.0.1:3005",  "token": "<local token>" }
]
```

Each device mints its own token on first start (`scripts/hearth.sh token`).
