## 1.7.0

### Added
- `GET /directories?scope=computer` lets an authenticated user browse existing work outside the
  suggested workspace. Default requests remain restricted to the configured workspace; browsing
  neither moves files nor changes the host configuration.

## 1.6.1

### Fixed
- Honor `HEARTH_BIND` / `EMBER_BIND`, including Ember's loopback-only bundled launch.
- Embed the package version so installed binaries report their version outside a checkout.
- Include Kiln in the compiled Tinder launcher for standalone operation without an installed Bun.
  A Tinder-managed backend has an independent lifetime; Ember's bundled backend stops with the GUI.

## 0.42.0

### Added
- **A brief can ask to be woken only on failure.** `session spawn` gains `report: "always" |
  "on-failure"`. With `on-failure`, a worker that succeeds settles silently: no `hearth.crew-report`
  entry in the leader's transcript, no line in the wake digest, and no wake — while the crew doc still
  says `reported`, so `list` and Ember's crew strip draw it as finished, and `results` still returns
  the text for a leader that asks.

  The reason is arithmetic. A worker told "run the tests" that answers "all 64 tests pass" produced
  three artefacts for one bit: a transcript entry, a digest line, and a leader turn paraphrasing it.
  Three of those from a fan-out is a lot of reading for no information.

  - **A failure is always shown**, whatever the policy: the option is "don't interrupt me with good
    news", not "don't tell me when it breaks". Pinned in `crewDelivery.test.ts`.
  - **Quiescence no longer wakes a crew with nothing to show.** A generation whose every worker
    settled silently would otherwise have delivered a digest of "(no report yet)" — the interruption
    the option exists to avoid, carrying no information. `hasVisibleReport` gates it; the deadline
    still wakes, which is what ends a hung crew.
  - **Absent means `always`**, so a crew spawned before this existed behaves exactly as it did.

### Notes
- `CrewEntry.delivery` records the policy on the entry rather than reading it from the call later:
  the supervisor judges a report many ticks after the tool returned, and a re-tasked worker must keep
  the policy its spawn chose. `silentReport` holds the unshown answer for `results`.
- Ten new tests in `test/crewDelivery.test.ts` — the pure rule (what a silent success says, that a
  shown report wins over a stale silent one, that the digest stays quiet) and the supervisor's two
  paths, success and failure.

## 0.41.0

### BREAKING
- **The event stream is gone; the wire now carries conversation state.** pi-durable 1.5.0 removed
  `watchEvents()` and its event types (`message_update`, `turn_end`, `tool_execution_update`, …), so
  `WS /conversations/:id/events` sends four frames instead, derived from the conversation view and the
  operations that moved it: `view` (the live documents on attach, or after an overflow), `text` (text
  and thinking appends, the only per-token frame), `appended` (entries that landed) and `changed`
  (`kinds` names what moved — `live`, `run_start`, `run_end`, `run_failure`, `compaction`, `inbox`,
  `agent`, `usage`, `provider`, `conversation`, `entries`). **No frame carries history**: the window
  exists so a mount stops holding the transcript, and a 100-entry window on the wire would undo that
  per reconnect. History is `GET /conversations/:id/entries`, as it was.
- `pi.live` moves to version 3 (pi-durable's own migration): `compactionFailure.reason` is `trigger`,
  a run has `turns`, and `runFailure` records why the newest run ended without an answer. A host on
  1.4.0 cannot read what this version writes.
- Tool schemas come from `@earendil-works/pi-schema` (JSON Schema), not TypeBox through pi-ai.

### Changed
- **Each watched conversation now holds a window, not its whole transcript.** With `Conversation.watch`
  and `{ min: 50, max: 100 }`, the mount keeps the newest 50 entries and grows to 100 instead of holding
  everything since the last compaction. Measured on this host's data (`scripts/diag/window-cost.ts`):
  **275 MB of active entry JSON → 93 MB**, and the earlier measurement of 341 MB of heap for 169 mounts
  should fall by a similar fraction (`scripts/diag/mounts.ts` measures it on a backup).
- **A provider failure is durable state now.** `pi.live.runFailure` carries the reason a run ended
  without an answer (`model_error`, `no_model`, `aborted`, `interrupted`, `restart_limit`, …), so the
  snapshot's documents already expose what `TODO.md`'s `F5` said was invisible — no logging side
  channel needed.
- **The reasoning level is recorded by the library**, from the request that was actually made: an
  assistant entry now always carries the level it ran at (including `off`), and a level the provider
  echoed is corrected to the one Hearth asked for. Hearth's own `levelStamp` hook existed only to fill
  that gap, and is deleted with its tests.
- Hearth's `ws` stream relies on 1.5.0's fixes for a watcher keeping whole streamed strings alive
  (`#9265`) and for partial commits copying every growing argument.

### Note
- A view frame this host cannot describe still sends `changed` with `kinds: ["unknown"]`: a client
  should take its tail read, never show a transcript that stopped.

## 0.40.0

### Changed
- **An agent's commands no longer run inside Hearth's systemd unit.** On Linux every `bash` child —
  and everything it backgrounded — inherited Hearth's cgroup, so systemd-oomd charged an agent's dev
  server, browser or video job to Hearth and killed the unit for the total: 7.5 GB and 243 processes
  on 2026-11-04, of which Hearth itself was ~20%. Each command now runs through a wrapper shell
  (`src/shell.ts`) that starts it in a **transient scope** under `hearth-agents.slice`, a sibling of
  `hearth.service`. Measured: a backgrounded child lands in
  `user@1000.service/hearth.slice/hearth-agents.slice/run-<id>.scope`, ~10 ms per command, with the
  environment, working directory, stdin and exit status unchanged. Two consequences, both meant:
  the host is no longer killed for what its agents do, and a Hearth restart no longer kills them —
  they stay visible on their session, with the Stop that 0.39.0 added. Hosts without a user manager
  (the container, macOS, Windows) run commands exactly as before; `HEARTH_SCOPE_SHELL=0` opts out.
- **A memory cap for those processes is one command** (`scripts/hearth-agents-slice.sh`, a user
  drop-in, no sudo): `MemoryHigh=4G`, `MemoryMax=6G` by default, so systemd kills inside the slice
  instead of taking the machine down. Opt-in because the right number is the operator's.
- **MCP servers are killed by tree, on both platforms.** `McpClient.close()` signalled only the
  launcher (`npx -y @playwright/mcp`), so `node playwright-mcp` and its Chromium were orphaned on
  every clean shutdown. They are now spawned in their own process group and the group is ended
  (SIGTERM, then SIGKILL if a browser ignores it); on Windows, `taskkill /T /F`.
- **Backpressure is no longer mistaken for a gap.** Measured against Bun 1.4.2 with a client that
  stops reading: 40 sends reported bytes, 17 reported `-1`, 1,943 reported `0`, and the client
  received exactly 57 frames — so `-1` means **queued** and `0` means **dropped**. The old code
  treated both as "not queued" and answered with a full snapshot retried for a minute, pushing more
  bytes into a full buffer and replaying the transcript as it was *when the stream attached*. Now
  `-1` pauses the stream until Bun reports `drain` (closing it if it never does), and `0` closes the
  socket (1013) so the client reconnects and attaches to a fresh snapshot. `backpressureLimit` is
  stated (16 MB, Bun's default) rather than inherited, and `closeOnBackpressureLimit` is off so the
  decision stays here.
- **A socket that closes while its stream is attaching no longer leaks the watch.** `open` stored the
  stream only after `await watchEvents(...)` and `close` stopped only what it could see, so a close in
  that window left a view mount attached for ever — one pinned transcript, and `translate` running on
  every commit. The attach now checks whether the socket is still open and stops its own stream.

### Notes
- `scripts/README.md` has the slice section: what runs where, the cap, and the check.
- Windows still has no Job Object around the runner, so a crash that skips `close()` leaves the MCP
  chain alive; and the process ledger is in memory there, so a leftover from before a restart is no
  longer attributed. Both are in `TODO.md`, with what to look for on Windows.

---

## 0.39.0

### Added
- **A session can see, and stop, what its own commands left running.** Every command now carries
  `HEARTH_CONVERSATION=<id>` in its environment, inherited by everything it starts — `nohup`, `setsid`
  and `&` included — and Hearth reads it back to attribute a surviving process to the session that
  caused it. A process counts as left behind when it is still tagged and no longer runs inside a live
  command (its ancestor chain no longer reaches Hearth), which also means one left by a **previous**
  Hearth run is still attributed after a restart. `GET /conversations` summaries gain
  `processes: { count, rssBytes, items }` when there are any, `GET /conversations/:id/processes` lists
  them with the host's memory level, and `POST /conversations/:id/processes/stop` stops them (SIGTERM,
  then SIGKILL only when the caller asks for `force`). A pid is only signalled while the scan still
  attributes it to that conversation, so a recycled pid cannot be killed by a stale client.
- **The agent is told what it left running, in the tool result.** A `bash` command that leaves
  something behind gets one appended line naming the processes, their cost, what the user sees, and
  the exact `kill` — the diff is per command, so a process is mentioned once and not on every later
  call. It is a result, not a prompt rule, because that is what a model acts on.
- **A session's scratch is on disk and bounded.** Commands get `TMPDIR`/`TMP`/`TEMP` under
  `<HEARTH_HOME>/tmp/conversation-<id>`, and the host sweeps anything untouched for three days at boot
  and once a day. `/tmp` is tmpfs on a Linux desktop: measured on Heliograph 2026-11-04, 5.7 GB of it
  was in use and 5 GB of that had been pushed to swap, 4.7 GB of it one video job's intermediates. The
  platform's own rule only removes `/tmp` files older than ten days.
- **`/health` reports the host's memory**, including `rssBytes`, `heapUsedBytes`, the machine's
  `availableBytes` with a `level`, and how many processes are left running host-wide. The 2026-11-04
  OOM kill could not be split between Hearth and the processes its agents had launched, because
  neither number was recorded anywhere.

### Notes
- On Linux the tag is read from `/proc/<pid>/environ`. Elsewhere a process's environment is not
  readable without native code, so the table is polled while a command runs and recorded in a ledger;
  that path is **conservative** (it records nothing while two commands are in flight, since a wrong
  attribution could stop another session's process) and, on Windows, it does not survive a restart
  yet. The Linux path is what is verified here: tested end to end against a real shell and process
  table.
- The notice this feeds is Ember's; Hearth only answers what is left and stops what is asked.

---

## 0.38.0

### Changed
- **A spawned session registers itself.** `session spawn` used to create a conversation that no name
  pointed at; a name only existed once a human promoted a worker, so the directory read empty while a
  whole crew was running. Every conversation the tool creates — a worker or an explicit peer — is now
  registered in the same commit, under its title. A repeated title takes a suffix (`Migrate schema 2`)
  instead of refusing the spawn, and a replayed spawn reuses the row its conversation already has.
  This is what makes "every agent has a name" true rather than a thing to remember.
- Promotion stays human-only on purpose: it forks a worker into an ownerless peer, changing who the
  conversation belongs to, which is not something an agent should do to itself.

### Notes
- The registry is host-wide (`hearth.agents`), so the mirror file `agents.json` grows with the crew.
  Entries whose conversation is gone are already dropped by `mergeDirectory` when reading the
  directory; the rows themselves are not pruned yet (filed in `TODO.md`).
- Pinned order is untouched: an automatically registered session is unpinned, so it sorts by recency
  under anything a person pinned.

### Fixed
- `the default workspace trusts /workspace only on Linux` read the ambient `HEARTH_WORKSPACE` and so
  failed in any agent's own shell, where the host sets it. The override is cleared for the default's
  assertion, which is what the test means to check.

---

## 0.37.0

### BREAKING
- **`GET /conversations/:id` returns a bounded page, not the whole transcript.** It used to answer
  with every active entry, built through `viewState()`, and that was the largest allocation this
  host made: measured here on 2026-11-04, the 951-entry conversation was a **44 MB response and
  ~238 MB of peak heap for one request** (every record parsed, then `JSON.stringify`d twice — once
  per entry to measure, once for the body). Two clients opening a few long conversations is
  therefore gigabytes of transient heap, and JSC never returns those pages, so the process ratchets
  up until systemd-oomd kills the unit. That is how the 16:44 kill happened, and why the Chromium
  this host's own Playwright MCP launched found no memory for its GPU process and died on the
  "GPU process isn't usable" check (`coredumpctl`, SIGTRAP).

  The snapshot is now the newest **100** entries (the same row cap as `/entries`, because the row
  count is what bounds the parse) and at most **12 MB** of JSON, cut with the same byte budget and
  keyset cursor. Entries stay **oldest-first**, and a `next` on the answer names *older* entries, so
  a client prepends each further page rather than appending; send it back as `cursor` here or to
  `GET /conversations/:id/entries`. A conversation small enough to fit is unchanged apart from the
  absent `next`, and a single entry larger than the whole budget is still returned alone rather than
  stalling a client. `docs` and `images=ref` work as before.

  A client that treated the snapshot as the whole transcript must page it. The live state the
  snapshot exists for (`pi.live`, `pi.agent`, `pi.inbox`, `pi.usage`, `pi.provider`) is read without
  materializing any entries at all, which is most of the saving.

### Changed
- The byte budget counts an entry **as materialized**, not as sent: `images=ref` makes the answer
  smaller but never buys more rows, because the parse — not the response — is what costs the heap.
- **`GET /conversations/:id/entries?docs=1` no longer reads the transcript to find the documents.**
  It went through `viewState()` — a view mount materializes the whole active transcript — and then
  used only the five small documents, on the route a streaming client re-reads every few hundred
  milliseconds. The documents are now read directly (`documentsOf`, also what the snapshot uses),
  so a `docs=1` page costs its page and nothing more. Response shape is unchanged.

---

## 0.36.2

### Fixed
- **The stream ceiling was set below the client's own watch cap, so it refused ~100 legitimate
  streams for good.** Ember watches up to **200** conversations, one socket each
  (`MAX_WATCHED_CONVERSATIONS`), plus the task graph. 0.36.0 capped a peer at 96, which on this host
  meant the ceiling was permanently saturated: every stream past it was refused, its retries looked
  like a smaller storm (≈6 connections/second, 118 established), and the client's conversations
  outside the first 96 silently had no live updates. The ceiling is now **256**, which clears the 200
  plus the task graph and a second window; the burst (48) and rate (6/s) limits still bound a real
  storm, since those — not the ceiling — are what throttle a reconnect loop.
- A test now pins the relationship: the ceiling must be greater than Ember's watch cap, and 200
  streams plus the task graph must be admitted. The previous ceiling would have failed that test.

---

## 0.36.1

### Fixed
- **A refused stream closes its connection instead of keeping it alive.** The 429 was a normal
  keep-alive response, so a client that opens a stream, ignores the refusal and tries again left one
  ESTABLISHED socket behind per attempt — measured from the storming Mac: **4,152 established
  connections in 60 s**, all to port 3011, with the 96-stream ceiling holding. A refusal now sends
  `connection: close`, so the ceiling bounds connections as well as streams.

  This does not cure that client: it ignores the answer and reopens, which is why the client-side fix
  (Ember 0.71.1: backoff forgiven only by a connection that stayed up 15 s) is the decisive half. It
  stops the host's own socket table being the casualty meanwhile.

---

## 0.36.0

### Fixed
- **A slow client no longer turns into a reconnect storm.** Measured on this machine: Ember on
  macOS (`100.64.0.2`) against Hearth on the remote host opened **2,272 connections in 83 seconds**
  (~27/second), leaving 6,915 sockets in `TimeWait` and pushing **36.7 GB** of snapshots through the
  tailnet. The mechanism was a loop with two halves: the host closed a WebSocket on the **first**
  `send()` that returned `-1` (backpressure, not death), the client reconnected **immediately**
  because it forgave its backoff on open, and every reconnect was answered with a fresh snapshot that
  hit the same backpressure.
  A frame that cannot be written now means *this socket is behind*, not *this socket is dead*:
  further deltas are skipped, **one** fresh snapshot is owed and retried with backoff (250 ms → 2 s),
  and the stream resumes as soon as a frame fits. Only a socket that cannot take a frame for **60 s**
  is closed for a resync — and then after a jittered 200–1000 ms, so a fleet of clients never comes
  back in lockstep. A keepalive without a resync to offer simply skips.
- **Stream upgrades are admitted per peer.** A token bucket (burst 48, then 6/second) and a ceiling of
  96 live streams per remote address: a client that reconnects in a loop is throttled at the upgrade
  instead of being multiplied by it, whatever its own backoff does. A refusal is a retryable
  `429` with a `retry-after` and a sentence saying which limit was hit, not a dropped socket, and one
  `[hearth] refusing a stream from …` line per peer per 5 s. `src/streamLimit.ts`, unit-tested.

### Notes
- The client half of this loop lives in Ember (`electron/piClient.ts`): its reconnect backoff is now
  forgiven only by a connection that stayed up for 15 s, not by an accepted socket. A host can no
  longer be made to look like an outage by closing one socket.
- `RESYNC_CLOSE_CODE` / `1013` and the reason string are unchanged: a client that does get closed
  still knows to resync.

---

## 0.35.1

### Fixed
- **A failed `start`/`restart` now says what happened instead of pointing at a file.** The old
  line was `hearth did not come up under launchd; check ~/.hearth/hearth.log` — no port, no reason,
  and on macOS nothing to distinguish "still booting" from "the agent is not loaded". The new
  report names the launcher and the health URL it waited on, quotes the last 15 lines of the log
  inline (where the reason almost always already is), and gives the two commands that finish the
  job from the same terminal: `tail -f` the log, and the authenticated `/health` curl. On macOS it
  also suggests `launchctl list dev.ember.hearth`, whose second column is the agent's last exit.
  `restart` shares it (`failed_to_start` in `scripts/hearth.sh`), so the two paths cannot drift.
## 0.35.0

### BREAKING
- **`GET /conversations/:id/entries` caps `limit` at 100, down from 500.** A client sending
  `limit=500` now gets a 400 naming the cap and must page at 100 with the cursor it already
  receives in `next`. `limit` counts rows, and rows are not the same size — a text turn is a few KB
  while a turn carrying a screenshot is megabytes, because the image is base64 inside the entry
  record — and `pi-durable`'s `scanEntries` runs `parseJson` on every row it selects. 500 was
  therefore a bound of 500 records held in memory at once, which on an image-heavy conversation took
  the process past Bun's heap ceiling: the Windows host died of it at ~19h uptime, with 15,099
  SQLite "out of memory" errors in the log before the fatal `0xC0000409`. The cursor is a keyset, so
  paging more is cheap — extra rounds cost latency, never correctness.

### Added
- **A page is bounded by bytes as well as rows.** `PAGE_BYTE_BUDGET` (12 MB) trims a page after the
  read, and a trimmed page reports `next` so the caller can continue. One entry larger than the whole
  budget is still returned, alone: refusing it would stall a client forever on a single huge entry,
  and one entry is a bounded cost. This guards the wire and the client — it is downstream of the
  read, so it cannot prevent the parse spike, which is what the row cap is for.
- **`scripts/hearth-prune.py`** — age-out policies, dry-run by default: strip base64 image payloads
  from entries older than 7 days (rewriting the part as `{ type, mimeType, dataOmitted }` so the
  conversation still reads), and move conversations idle longer than 7 days into
  `backups/archive.sqlite`. Archive-then-delete with a read-back verification, and a full backup
  before any mutation. The store is append-only — `pi-durable` has no delete or retention API, and
  issue #11026 is the open request for one — so without this it only ever grows.
- **`scripts/hearth-prune.ps1`** and **`scripts/install-prune-task.ps1`** — the daily runner (stop,
  prune, always restart, verify `/health`) and its 03:00 scheduled task. `hearth.sh prune` runs it by
  hand.

### Fixed
- **`prune_backups` deleted the backup its own run had just written.** The `hearth-*.sqlite` glob
  also matched `hearth-prune-<stamp>.sqlite`, so a run counted its safety snapshot among the files to
  keep and then removed it in the same pass. Those snapshots and `archive.sqlite` are now excluded —
  the archive holds the only copy of what the prune moved.

### Changed
- On this host's database, the prune took 335.6 MB to 224.8 MB live plus a 22.5 MB archive (38
  conversations, 7301 entries), with 81.6 MB of base64 payload dropped from 141 entries.
  `integrity_check` and `foreign_key_check` clean, archive verified complete.

The prune reads pi-durable's tables directly by SQL, which #11026 warns can break on upgrade. It is
a bridge until a storage-level delete exists, not a permanent answer.

---

## 0.34.2

### Fixed
- **The reasoning level a turn ran at is now persisted, so a client can show it.** pi-ai declares
  `AssistantMessage.thinkingLevel`, but nothing in this stack ever wrote it — pi-durable passes the
  level as `options.reasoning` and drops it, and only three adapters ever set
  `providerThinkingLevel` — so Ember's new `provider / model · level` footer had nothing to render.
  A new `level-stamp` extension (`src/levelStamp.ts`) reads the conversation's configured
  `thinkingLevel` from `AgentDoc` in an `afterResponse` hook and fills `message.thinkingLevel` when the
  provider left it absent, which is durable because that hook runs before `appendAssistant` persists
  the same object. It never overwrites a value the provider set, never touches
  `providerThinkingLevel`, validates against pi-ai's level vocabulary (a stale doc value stamps
  nothing rather than an illegal string), and stamps nothing when the conversation has no level — a
  fabricated `"off"` would be a lie. The code records the one honest caveat: the level is read at
  classification, so a mid-turn `/configure` labels that round with the level then in force, and
  `HookApi` exposes no checkpoint read.

---

## 0.34.1

### Docs
- Backlogged the missing reasoning-level stamp. Ember renders `provider / model · level` in a turn's
  footer and maps both `thinkingLevel` and `providerThinkingLevel`, but nothing in this stack writes
  either: **0 of 14,625 `pi.assistant` entries on this host carry it**, because pi-durable's
  `generation.js` passes the level as pi-ai `options.reasoning` and never copies it onto the message
  (only the pi monorepo's own agent loop does). The entry records the verified ordering that makes a
  fix possible — `afterResponse` fires at `generation.js:395`, before `appendAssistant` persists the
  same object at `:591`, so a hook that sets `message.thinkingLevel` sticks — and the open question of
  where the value may be read without risking a mislabelled turn.

---

## 0.34.0

### Added
- **Upgraded `@earendil-works/{chord,pi-ai,pi-durable}` to `1.4.0` and added durable Code Mode
  (`codemode`, `tool_search`, and `scratchpad`).**
  - `src/codemode.ts` installs `@earendil-works/pi-durable/codemode` (`createCodemodeExtension` with
    QuickJS `CodemodeSandbox` from `@earendil-works/pi-codemode`), `@earendil-works/pi-durable/tool-search`
    (`createToolSearchExtension`), and a companion `scratchpad` tool (`ScratchpadTool`) backed by
    `CodemodeStoreDoc` (`pi.codemode.store`).
  - Scripts run in QuickJS, call conversation tools as `tools.<name>(args)`, keep intermediate data out
    of the LLM context with `store(key, value)` and `load(key)`, and deterministically replay from the
    committed journal across restarts without re-executing finished calls.
  - `scratchpad` (`list`, `get`, `set`, `delete`, `clear`) reads and writes the same rewindable
    `CodemodeStoreDoc` so direct tool calls and subagent workflows can inspect, seed, or clear stored
    values without writing a script.
  - `src/mcp.ts` exposes MCP tools with `callers: ["model", "tools"]`, sets `replay: "safe"` when
    `annotations.readOnlyHint === true` (or configured `readOnly` / `readOnlyTools`), and exports
    `mcpNamespaces` so `codemode` groups MCP tools by server prefix.

---

## 0.33.0

### Changed
- **Removed `opencode-go` from the registered providers (kept `opencode` / OpenCode Zen).** OpenCode Go
  is no longer registered in `src/models.ts` or discovered in `src/model-discovery.ts`; `hearthDefault`
  now defaults to `opencode/glm-5.3-flash` when `HEARTH_DEFAULT_MODEL` is unset.
- **No default active-worker ceiling (`HEARTH_MAX_ACTIVE_WORKERS`).** The hard-coded 4-worker cap is
  lifted by default (settable via `HEARTH_MAX_ACTIVE_WORKERS`), re-checked inside the spawn commit so
  parallel tool calls cannot race past a configured ceiling, and reflected dynamically in the `session`
  tool description and prompt section.

### Fixed
- **Context entries (`hearth.context`, reply context, queued instructions) now reach the model (`A1`).**
  `pi-durable` builds model requests from `entry.model`, so `{ kind, data }` write entries were
  invisible to the LLM. `contextEntry()` now carries a framed user-role text message in `entry.model`
  alongside `kind`/`data`, `parseSubmission` accepts `entry.model` on client `write` entries, and
  `whenBusy: "reject"` is checked before context injection so a 409 leaves no orphan context entries.
- **Completed OAuth sign-ins are persisted on the flow's terminal event, and superseded flows cannot
  clobber their replacement (`A4`).** `createLoginSupervisor` persists via `store.modify` as soon as a
  device-code flow completes (rather than only inside the initial 10s POST window), strips the raw
  secret from `GET /providers/:id/login` in favour of `credentialType`, guards terminal transitions by
  state identity, and advertises only flows Hearth can complete (`xai`, `kimi-coding`).
- **Provider credentials and catalogs (`E3`, `E4`, `E5`, `E6`, `E7`, `E8`).** Mapped OpenCode's
  `fireworks-ai` key alias onto `fireworks` on load and import; flagged expired OAuth credentials and
  environment-backed keys; registered `kimi-coding` (with shipped OAuth) and `moonshotai` so keys can
  be added at runtime and trigger background `models.refresh()`; preserved pi-ai's shipped Moonshot
  pricing, `maxTokens`, and `KIMI_COMPAT` on K2/K3 reasoning models; attached image resize limits and
  default thinking level maps to synthesized discovery/router models; and gated MCP image blocks in
  `mcpContentToHearth` against `MAX_IMAGE_BYTES`.
- **Queue parking across Stop and Reorder (`D5`).** `POST /conversations/:id/abort` re-reads the inbox
  inside the post-abort commit and preserves each item's `steer | followUp` mode; `PUT /queue/order`
  reorders via `parkInputs` in a single commit without calling `conversation.submit`, so reordering a
  stopped conversation's parked queue never starts a run.
- **Crew bookkeeping (`D4`, `D6`, `D8`) and follow-ups on busy workers.** `session` `status`, `stop`,
  and `message` all resolve workers by crew key or composed title (`Researcher #1`), and `stop` clears
  parked approvals/questions; `crewOutcome` and `wait` are scoped to the current generation;
  `rearmWorker` advances/aligns the generation and records `followUpAt` on busy workers so the
  supervisor waits for the queued turn; and `archiveCrew` marks active workers `stopped` and clears
  their pending prompts.
- **Scheduler durability and timezone isolation (`D2`, `D3`, `D9`).** `tick` and `runScheduledTaskNow`
  persist `task.conversationId` (`??=`) and title new task conversations with `task.name`;
  `parseSchedule` validates `timezone` via `Intl.DateTimeFormat`, and `tick` isolates `isDue` per task
  so a bad stored zone cannot block later tasks.
- **Tool replay safety, stream overflow snapshots, and backup busy timeout.** `gateTool` in
  `src/approvals.ts` preserves each tool's own `replay` policy (`"unsafe"` on `bash`) instead of
  forcing `"safe"`; WebSocket `stream.start` strips `entries` from overflow `snapshot` events via
  `snapshotWithoutHistory`; and `backupDatabase` sets `PRAGMA busy_timeout = 5000` before `VACUUM INTO`.

---

## 0.32.12

### Docs
- **Gemini is documented as a provider you add with a credential, not a code change.** pi-ai's
  `google` provider was already registered in `src/models.ts`, so what was missing was the set-up
  path: `README.md` now covers `provider set google <key>` (or `GEMINI_API_KEY`, stored-first), notes
  that the newer `AQ.…` keys work because pi-ai sends `x-goog-api-key`, and records that no restart
  is needed since `GET /models` serves `getAvailable()` and resolves the credential per request.
  Also records how a non-credential failure surfaces: `submit` answers `placed`, then the run ends
  with a `pi.assistant` entry at `stopReason: error` carrying Google's sentence — 402 for depleted
  prepay credits, 404 for a retired model id. No behaviour change.

---

## 0.32.11

### Fixed
- **The wire tests did not typecheck.** `bun test` passed, but `bun run typecheck` failed with twelve
  errors in `wireErrors`, `wireActions` and `wireStream`: they annotated `createModels()` with the
  exported `Models` interface, which is the read side and has no `setProvider`, and they read fields
  from `response.json()` while it is `unknown`. Inference plus explicit casts; no behaviour change, and
  the failing-test set is unchanged (21 platform failures, same names).

---

## 0.32.10

### Docs
- Backlogged a per-conversation **reach** choice: today every delegating conversation can address any
  named peer on the host through the `agents` extension, and there is no way to start one that may only
  see the workers it creates. The entry records the two modes, where enforcement has to live (a
  `beforeTool` hook plus the tool's own commit, the `spawnGuard` pattern), the invariants a change must
  keep, and the open questions — the field name, the default, narrowing vs widening, and whether a
  crew-scoped session should still be listed to others.

---

## 0.32.9

### Fixed
- **Every failure is JSON again, and bad input no longer reaches a throw.** An uncaught throw at the
  boundary was answered by Bun's development error page: ~50 KB of `text/html` carrying the absolute
  install path, the `node_modules` layout and a stack frame. A JSON client cannot parse that, so a bad
  query read as a crash — and "all bodies are JSON" failed exactly when the client was confused.
  `Bun.serve` now has an `error()` handler (real errors to the log, a safe sentence to the caller), and
  the boundaries validate: `limit` is a whole number 1…500 (was `Number(raw) || 50`, so `2.5` reached
  SQLite's `LIMIT`), `cursor` must be the `{after}` object a page returned, `since` an entry id,
  `whenBusy` one of the documented values (`reject` is a 409, not a 500), and a fork `at` must belong
  to that conversation. A malformed `%` escape is a 400 instead of a `URIError`, a body that is not
  JSON is a 400 instead of silently `{}` (which on create made an empty conversation with a 201), and
  a 404 now names what is missing — route, method, conversation, entry, image, rule, task, approval.
- **A queued message could be withdrawn through the wrong conversation.** `POST
  /conversations/:id/submissions/:sid/abort` looked the submission up globally, so the conversation in
  the path was decorative: a crossed or stale id withdrew another conversation's message and answered
  `{ok:true}`. It is scoped to the path's conversation now, answers `{ok, result}` with `aborted`,
  `already_placed` or `settled`, and a submission from another conversation is a 404.
- **A retried submit could be told "sent" for a message that never ran.** `POST /submit` returned only
  `placed|queued`, dropping the `done`/`unanswered` statuses and their `reason`, and its idempotency
  path returned a settled `unanswered` submission as-is — including one that never wrote an entry — so
  a client retrying after a dropped socket got a 201 and the message never ran. The answer now carries
  the full status set with `reason`, and a retry of one that never reached the transcript is re-placed
  under a fresh key (`<id>#2`, `#3`, …) while a retry of one that did place stays a no-op; twenty
  attempts of one id is a 409 telling the caller to start a new one. Keyword-context injection rides
  the placement, so a retry cannot write the same context entries twice.
- **A dropped stream frame is no longer silent.** `ws.send`'s return value was discarded, and Bun
  returns `0` for *dropped*: with a client that stops reading, frames vanished from the 21st 1 MB
  onward while the socket stayed open, and the server-push protocol has no sequence or ack to reveal
  the gap. A frame that cannot be written (`0`, `-1`, or a send that throws) now closes the socket
  with `1013 "send buffer full; resync"`, logs one line per socket, and stops the stream; nothing is
  buffered for a client that is not reading. The keepalive uses the same path.
- README's wire table now documents the submit statuses and their `reason`, the retry rule, the abort
  result, and the `limit`/`cursor` bounds.

---

## 0.32.8

### Docs
- `TODO.md` now carries the 2026-10-29 full audit as its source for the next batch: the lead report at
  `_audit/full-2026-10-29/AUDIT.md` (165 graded findings over Hearth 0.32.7 and Ember 0.62.4, with the
  wire measured live) plus the per-strand files. The P0/P1 findings for this repo are filed as
  actionable entries with their audit IDs (`A1`, `A4`, `D2`, …), the file:line that proves each, and
  what the fix has to satisfy; P2 items stay indexed in audit §G. No behaviour changed.

---

# Changelog

All notable changes to Hearth. Versions follow `VERSIONING.md`.

## 0.32.7

### Docs
- Backlogged lifting `MAX_ACTIVE_WORKERS` (four concurrent workers), which is an arbitrary load guardrail
  rather than a policy. Recorded with what a change has to keep — the rate, hourly-budget and wake-gap
  guards are what stop a report-back loop becoming a tree, and only the *active* cap bounds parallelism
  — plus two things worth fixing at the same time: the cap is checked outside the commit (so it has
  never been a hard limit) and the `session` tool's description hard-codes "4" for the model, which must
  follow the code whatever it becomes.

---

## 0.32.6

### Docs
- The Windows path trap is closed as a documentation matter: the rule now lives in the **host's own
  workspace guide** (`<workspace>\AGENTS.md`), which is what every agent on this machine
  reads, in addition to this repo's `AGENTS.md`. The entry is off `TODO.md`.

---

## 0.32.5

### Docs
- **The Windows path rule is now written down where an agent will read it** (`AGENTS.md`, "Paths on
  Windows: two conventions in one session"): `/c/...` inside `bash`, `C:/...` in the file tools, and
  translate anything that came out of shell output. That is the remedy upstream recommends.
- The TODO entry no longer proposes reporting it: it was reported and closed as working-as-intended
  ([earendil-works/pi#4688](https://github.com/earendil-works/pi/issues/4688)). The maintainers hold
  that `/c/foo` really is `CURRENT_DRIVE:\c\foo` on Windows, decline to change the default prompt, and
  asked for a session showing a frontier model failing if it is ever revisited. What stays open on our
  side is only whether to normalise `/c/...` in a wrapper as belt-and-braces.

---

## 0.32.4

### Docs
- Sharpened the Windows path entry after checking whose bug it is: pi-durable picks Git Bash as the
  shell on win32 and resolves file paths with Win32 rules, so the mismatch is inside the dependency,
  not in how a caller uses it. Also verified it is **unfixed in 1.4.0**, so upgrading would not help.
  A paste-ready report with a reproduction and a suggested patch now sits at
  `../pi-durable-windows-path-report.md`.

---

## 0.32.3

### Docs
- Backlogged the Windows path trap: `bash` reports MSYS paths (`/c/Users/...`) and the pinned
  `pi-durable` tools resolve a leading slash as `<drive>:\`, so a read fails with a puzzling ENOENT
  while a **write succeeds into `C:\c\Users\...`** — a phantom tree, reported as success. Found the
  hard way while auditing this repo, and recorded with the wrapper fix to try plus the note that the
  real fix is upstream, where the path is resolved.

---

## 0.32.2

### Fixed
- **Running a scheduled task by hand no longer stacks a second run on a busy conversation.** If the
  task's conversation was still working, `run now` queued a second copy of the whole prompt behind the
  first while both submits reported `ok` — so a double-clicked button, or a caller testing its own task,
  fired the pipeline again and again with no signal that it had. A manual run now refuses with a reason
  when the target has a run in flight, and leaves `lastRunAt` alone so a refusal does not consume a real
  occurrence. (`refused: true` on the outcome, which the wire already answers with 409.)

---

## 0.32.1

### Docs
- Corrected the "system prompt per session" TODO. It claimed nothing was implemented; the capability
  exists — `instructions` on an agent change is a reserved prompt section, accepted at creation and
  through `/configure`. What is missing is an Ember surface, and the "delegator" idea is a design
  decision, not plumbing.

---

## 0.32.0

### Added
- **A conversation summary carries what that conversation has spent (`cost`, USD).** Summed from its own
  `pi.usage` ledger — every model bucket and every tool bucket — so a client can show a per-session
  total without reading the transcript to add it up. `/usage` stays the fleet-wide total; this is the
  one session's share, on a response a client already fetches. A conversation that has never run
  reports `0` rather than omitting the field: it has spent nothing, and a client that cannot tell
  "nothing" from "unknown" has to render both.

---

## 0.31.1

### Fixed
- **A worker that hangs now wakes its leader at the deadline.** The supervisor's quiescence and deadline
  check sat behind `if (!touched) continue;`, and `touched` was only set when a tick *changed*
  something. A worker that hangs changes nothing, so for fifteen minutes the deadline was never even
  read — and a leader asleep waiting for a report stayed asleep. The check now runs on every tick that
  has active workers; a conversation with no active crew still costs exactly one document read.
- **A report that lands after the generation's wake is delivered.** Delivery was recorded as one
  boolean per generation, which says *that* a wake happened but not *what* it carried, so a second (or
  late) worker's report was written to the crew doc and never shown to the leader — who had already
  been told "(no report yet)". A wake is now identified by its content (the generation plus every
  report it carries), the doc remembers the last key delivered, and the wake's `requestId` is derived
  from that key: pi-durable reacquires a known requestId without writing, so a per-generation id would
  have swallowed every later wake as a duplicate of the first.
- **`message`/`send` to a settled worker is reported again.** A worker that had already reported kept
  `state: reported` when it was handed new work, and the supervisor only watches `starting | running`,
  so the new answer was never turned into a report — `session wait` said "Crew settled." while the
  worker was working. The entry now goes back to `starting` with its old report cleared, a fresh start
  grace (`taskAt`), and a watermark (`answerFrom`) so the *previous* answer cannot be reported as the
  new one. Both fields are optional: a document written before them falls back to `spawnedAt` and
  "any assistant entry counts", which is the fresh-worker case.
  Known gap, filed in `TODO.md`: a follow-up *queued* behind a busy worker still lands on a `reported`
  entry, so that answer goes unreported.

---

## 0.31.0

### Added
- **An entry page can carry a reference to its images instead of the images themselves.** A `view` tool
  result is a screenshot: 2.3MB of base64 inside a single entry record, and a session here has nine of
  them — so every read of its entry page cost ~20MB, mostly for images nobody had scrolled to.
  `GET /conversations/:id/entries?images=ref` replaces each image block with
  `{ type: "image-ref", entryId, index, mimeType }`, and the new
  `GET /conversations/:id/entries/:entryId/images/:index` serves the bytes on demand (counted across
  the entry's messages in order, `content-type` from the block itself).
  Opt-in on purpose: with no `images` parameter the payload is exactly what it was, so this can ship
  before the client that reads references does, and a client that cannot resolve one is unaffected.

---

## 0.30.0

### Added
- **`GET /conversations/:id/entries` can be read incrementally: `since=<entryId>`.** A streaming
  client re-reads a transcript every few hundred milliseconds, and until now each of those reads was
  a fresh tail of whole entry records — measured **21.3MB** for one session carrying screenshots,
  almost all of it unchanged since the previous read. `since` returns only entries *newer* than the
  one the reader already holds (exclusive, so the anchor is never re-sent), which makes the cost
  proportional to what changed and zero when nothing did. A `next` cursor on such an answer means
  entries in between did not fit the limit, so the caller must not treat it as a complete delta.

### Changed
- **A stream snapshot carries the live state and no history.** 0.29.4 bounded `entries` to the last
  200 rather than removing it, which was not enough: this host has a conversation of **122 entries
  totalling 45MB**, so the slice never fired — measured 43MB per attach and 79.6MB for one reconnect
  of all 68 conversations a client watches. The payload was discarded by the only client that reads
  it (`ember/electron/piClient.ts` reduces frames to event types and asks REST for the rest), so it
  was pure cost. `entries` is now always empty and every other field is untouched.

### BREAKING
- A client that rendered history straight from the stream snapshot must read
  `GET /conversations/:id/entries` instead. Ember never did; the field stays in the payload so the
  shape is unchanged, but it no longer carries anything.

---

## 0.29.4

### Fixed
- **Attaching to a long conversation no longer ships the entire history on the socket.** The stream
  snapshot carried `entries` — the whole conversation — so every attach, and every *reconnect*,
  sent the full transcript in one frame. One session here measured **47MB**: larger than the client's
  own 32MB response budget, and enough that parsing it blocks the client long enough to look like a
  freeze or a dropped connection. From the reader's side that is indistinguishable from the app
  falling over, which is exactly how it was reported.

  Ember discards those entries anyway: `electron/piClient.ts` turns stream frames into invalidation
  hints and refetches over REST, so the transfer bought nothing. The snapshot's history is now
  bounded to the last 200 entries; every other field — `run`, `generation`, `tools`, `inbox`,
  `agent`, `usage` — is untouched, and the full history stays available on
  `GET /conversations/:id/entries`, which is where a client should ask for it.

- **Idle streams no longer depend on the client reconnecting to stay alive.** The wire is
  server-push only, so a quiet conversation sent nothing at all; the framework's idle timeout would
  eventually close it and the client would reconnect on a schedule. Streams now send an empty batch
  every 25s — valid JSON, zero events, ignored by every client — and the socket's idle ceiling is
  raised. A probe held a socket open for 150s to confirm the old behaviour was *not* the disconnect
  users were seeing; this is a guard, not the fix above.

---

## 0.29.3

### Changed
- **Two entries in `TODO.md` were finished or wrong, so they are gone.** The Ember
  sign-in button shipped in Ember 0.45.0, and the git-auth entry described the token as living in
  `.git/config` when it is written into `~/.gitconfig` by `run.sh` on every container start. That
  one is restated with what is actually true and still open.

---

## 0.29.2

### Fixed
- **A scheduled task no longer parks forever on its first tool call.** A scheduled run submits a
  prompt into a conversation that nobody is watching, so when the agent reached its first `bash` or
  write, the approval gate waited for a human who was never going to arrive. The run still reported
  `ok` — the submit itself had succeeded — which made it look healthy while the conversation sat in
  `needsInput` indefinitely.

  `runTask` now turns auto-accept on for the target conversation before submitting. That is the
  correct semantic for a scheduled run: it was configured in advance by a human who is not present,
  so the gate is answered at configuration time rather than at execution time.

  Found as uncommitted work in the working tree and committed here, so it would not be lost the way
  earlier uncommitted work was.

---

## 0.29.1

### Changed
- **`AGENTS.md` states that all copy is marketing, especially error messages.** Every user-facing
  string is something a person reads while trying to get work done, and the failure state is where a
  product is most often written badly — Hearth returns machine-shaped errors, so the temptation is to
  surface them verbatim. The rule asks for the opposite: name the actor, never leave a dead end,
  say what the reader can conclude, and keep the styling and the wording in agreement (a transient
  retry is not a failure). Applies to errors, empty states, loading text, tooltips and settings
  descriptions.

---

## 0.29.0

### Added
- **Interactive provider sign-in over HTTP, so an OAuth provider can be re-authorized from a
  client instead of a terminal.** Some providers only issue a token through a browser round-trip,
  and pi-ai already implements those flows — xAI is a device-code flow — but `login` blocks until
  the human finishes, and this server speaks JSON rather than SSE. `src/login.ts` runs each flow as
  a small in-memory state machine: `POST /providers/:id/login` starts it and returns the device
  code as soon as the provider emits it, `GET /providers/:id/login` reports pending/complete/failed
  and hands over the credential once, and `DELETE` cancels. Nothing is written to disk until the
  credential is complete, so an abandoned login leaves no trace, and a second start supersedes the
  first because a stale code is worse than a replaced one.

  `GET /providers` now carries a `signIn` field (`label` plus whether a flow is `pending`) for
  providers that support it, so a client can offer a button without knowing which flows exist.

  `bun scripts/provider.ts login <id>` finally exists too. Ember's Providers panel has claimed
  since it was written that OAuth providers "sign in on the host with `hearth.sh provider login`",
  but no such command was ever implemented — the credential in `auth.json` had no way to be
  renewed. It now prints the verification URL and code, then polls until approval.

  Verified against xAI: `POST` returns a real device code, `GET` reports it pending, and `DELETE`
  settles it as cancelled. Actually completing a login needs a human to approve the code, so the
  token exchange itself is exercised by tests with a fake provider rather than live.

---

## 0.28.3

### Added
- **`TODO.md`, and a rule in `AGENTS.md` that keeps it honest.** Open work and known bugs now
  live in one place instead of being carried in a conversation: `AGENTS.md` says to add an entry
  when something is reported or discovered, with enough detail to pick up cold (what is wrong,
  which file, what the fix must satisfy), and to **remove** it — not tick it — in the same commit
  that fixes it. Git is the history; this file is the live list.

  Seeded with what this machine actually has open: the xAI OAuth credential whose refresh token
  xAI now rejects (`invalid_grant`, so every `xai/*` model is listed and unusable), the missing
  health check and retry that let three different dead pins fail silently in one afternoon, the
  never-started per-session system prompt with the append-vs-replace decision it hinges on, and
  the push token sitting in plaintext in `.git/config`.

---

## 0.28.2

### Changed
- **Per-machine notes live in a gitignored `AGENTS.local.md`, and `AGENTS.md` says so.**
  `AGENTS.md` is tracked and pushed to a public remote, so it is the wrong place for
  machine-specific or sensitive detail — credentials handling, local paths, host-vs-container
  quirks. The file now opens by directing a reader to `AGENTS.local.md` when it exists and stating
  plainly that it does not; `AGENTS.local.md` is ignored, created on demand, and seeded with the
  one lesson this machine has already paid for: push from the container, because the host's
  remotes carry no credentials and fail with `Repository not found`, which reads like a missing
  repository rather than an authentication problem.

---

## 0.28.1

### Added
- **A test that pins assistant-entry timing, so `tok/s` and the duration chip can't silently lose
  their data again.** No runtime code changed: the timing was already there, and this records
  where it comes from and why it survives.

  What the data layer actually holds, from the compiled dependency and from live history:

  - `AssistantMessage.timestamp` is **request start**, not the moment the generation finished
    (pi-ai `types.d.ts`: "Unix timestamp in milliseconds when the request started"). So an
    assistant entry has always carried a real start time.
  - `AssistantMessage.durationMs` is the monotonic span from that start to the response's end,
    stamped by `AssistantMessageEventStream` on `done`/`error`/`end`
    (pi-ai `utils/event-stream.js`). It is the **request-start → completion** metric, so it
    includes time-to-first-token; provider-level first-token timing is not exposed to the harness
    at all.
  - `appendAssistant` writes `{ model: [message] }`, and neither pi-durable nor Hearth touches
    `durationMs`, so both fields are persisted verbatim and served by `GET /conversations/:id/entries`.
  - `Models.streamSimple` wraps every provider in `lazyStream`, whose `forwardStream` re-pushes the
    final event into a second `AssistantMessageEventStream`. The framework therefore re-times the
    message even when a provider does not, which makes `durationMs` structural rather than a
    per-provider courtesy.

  Measured on the live database before writing anything: 6492 assistant entries carry
  `durationMs` (1227–5726 ms among a sample), every entry from id 10000 on is timed, and the
  untimed remainder is history from before the field existed (ids below ~5613). Old entries are
  untouched: no `durationMs` means no duration and no `tok/s`, as before — nothing backfilled.

  `test/timing.test.ts` runs real generations through `Harness` and asserts the persisted entry
  carries a plausible non-zero span between request start and completion, that a legacy entry
  written without timing stays quiet, and that pi-ai's own faux provider produces the same result
  when scripted with a response factory. Verified to fail when the span is corrupted (`-1`), so it
  is a real guard rather than a test that passes on any input.

### Note
- Ember's `piMapping.ts` maps `completedAt` from `message.timestamp` — the same field as
  `createdAt` — so it computes a zero-length turn and `tokensPerSecond` returns `null`. The fix
  belongs on the Ember side (`completedAt = timestamp + durationMs`); Hearth needs no change. With
  that one line, a real entry yields `673 output / 5.726 s ≈ 117.5 tok/s`.

## 0.28.0

### Fixed
- **Stopping a conversation no longer swallows its queue.** `POST /conversations/:id/abort` used
  to lose every queued message. pi-durable's `Conversation.abort()` withdraws each queued input —
  it settles it `unanswered` with reason `aborted` and removes it from `pi.inbox` — which is the
  right default for a task being killed, but the wrong answer for the user's stop button. Observed
  before the fix: queue a follow-up, press stop, and the message is gone with no entry and no
  trace, while `POST /abort` answered `{ ok: true }` as though nothing else had happened. The
  outcome also *looked* nondeterministic, because whether a queued steer had already been placed
  at a boundary depended on timing.

  The policy now, chosen for predictability rather than cleverness:

  - **Nothing is dropped, and nothing is auto-sent.** A stop ends the run and leaves the
    conversation idle. It never starts the conversation again on the queued message — pressing
    stop and then watching it carry on reads as "stop didn't work".
  - **The queue is preserved, in the same order, as ordinary queued messages.** After the abort
    settles, the withdrawn inputs are written back into `pi.inbox` as `queued` submissions (the
    same shape a message queued behind a busy turn has), in one commit. They drain by the normal
    rule: the next submission places them, oldest first. A stop needs no special case in the
    ordering, so there is exactly one rule for when a queued message runs.
  - **The stop says what it kept.** The response gains `parked` (a count) and `parkedText` (a
    bounded preview of each kept message) so a client can tell the user their message was kept.
    Both fields are absent when nothing was queued, so the response shape for the empty case is
    byte-for-byte what it was.

  Queued `write` items are untouched: an abort never withdrew them, and re-placing one would
  duplicate the entry. Re-queueing uses a deterministic request id derived from the original inbox
  id, so a crash between the abort and the park replays into the same submission rather than a
  duplicate.

### Added
- `src/parking.ts`: `parkedInputs` (what a stop must keep: `steer`/`followUp` items, in order,
  never `write`), `parkRequestId`, and `parkInputs` (re-queue inside one commit).

---

## 0.27.2

### Fixed
- **A failed worker no longer leaves its leader waiting, and a failure is a message.** `session
  wait` polled the crew doc for a worker in `starting | running`, but only the background
  supervisor tick moves a worker out of those states. Two consequences, both fixed:

  - A worker whose brief never landed (stopped before it ran, or its conversation ended first)
    has no assistant entry and no run, so it looked exactly like a worker that had just been
    spawned. The tick's 10-second start grace therefore left it `starting` for the whole grace, and
    `wait` sat on its ten-minute deadline for a worker that could never answer. The tick now proves
    "this worker can never run" (no live submission, and no `pi.user` **or** `pi.assistant` entry)
    and settles it `failed` immediately.
  - When the worker *had* failed, `wait` returned "Crew settled." — a success-shaped sentence over a
    crew in which nothing succeeded, with the failure folded into a blob of text. `wait` now heads
    its answer with `Crew finished with failures — do not wait for the workers marked FAILED or
    STOPPED.` and still says `Crew settled.` only when nothing in the crew failed.

  A `stopped` worker is covered by the same rule: it is finished, so it is never something to wait
  for, and it is reported as `STOPPED` rather than as `(no report yet)` (which read as though an
  answer were still coming).
- **`results` and the crew wake digest distinguish failure from silence.** A worker with no report
  used to render as `(no report yet)` whatever its state, so a `failed` worker read like a pending
  one. `session results` now renders `FAILED — this worker ended without a report`, and the wake
  digest a leader is woken with starts with `FINISHED WITH FAILURES` when any worker in the
  generation failed. The supervisor's own failure report now says what went wrong ("This worker
  failed: …", "This worker never started: …") instead of the flat "No answer."
- One definition of "active" (`isActiveWorker` in `src/sessions.ts`) is now shared by the supervisor
  and `wait`, so a state cannot count as active for one and settled for the other.

---

## 0.27.1

### Fixed
- **`AGENTS.md` and `README.md` disagreed with reality about the suite**: they advertised "13 tests"
  and "72 tests" respectively, while `bun test` runs **202 across 19 files**. A fresh agent
  following either number would have been surprised by the runtime and might have dismissed
  failures as pre-existing. Both now say 202.

---

## 0.27.0

### Added
- **`GET /conversations/:id/entries?docs=1` returns the conversation's documents with the page.**
  A client watching a running turn needs `pi.live` - the generation's reasoning and text, which only
  become an entry when the turn ends - on every streaming event. The full snapshot carries the whole
  transcript (~830KB on a long conversation) and is far too much to re-read per delta; the entries
  page is ~1KB and now carries the documents too (~4KB in total). Without the flag the response is
  byte-for-byte what it was, so existing callers are unaffected. Ember's live reasoning display is
  the first client; it is what turns "the thinking shows up at the end" into streaming.

---

## 0.26.0

### Added
- **Kimi and Moonshot have first-class provider slots** (`src/kimi.ts`): `moonshotai` for a
  Moonshot platform key (`KIMI_API_KEY` / `MOONSHOT_API_KEY`, base `https://api.moonshot.ai/v1`)
  and `kimi-coding` for a Kimi Code plan key (`KIMI_CODING_API_KEY`, base
  `https://api.kimi.com/coding/v1`). Slots are registered at startup when the corresponding key is
  in the environment or already in Hearth's credential store. `moonshotai` reads `GET /models` and
  overlays the account's catalog on pi-ai's offline fallback; `kimi-coding` uses pi-ai's plan
  catalog. `KIMI_BASE_URL` / `KIMI_CODING_BASE_URL` support gateways, and `KIMI_REASONING=off` is
  an escape hatch for an endpoint that rejects reasoning fields.
- `FileModelsStore` persists dynamic model catalogs to `$HEARTH_HOME/models-store.json` using
  atomic temp-and-rename writes and mode 0600.

### Changed
- Startup restores persisted catalogs without network access before recovered work resumes, then
  refreshes providers in the background after the server listens. A slow or failing `/models`
  endpoint no longer holds `/health` down during boot.

### Fixed
- **Provider catalog reads send their credential.** The new `moonshotai` read and the pre-existing
  `orcarouter` read both pass the resolved API key as `Authorization: Bearer …` (and propagate the
  refresh abort signal). Previously a bare fetch got Moonshot's 401; pi-ai then retained the stale
  shipped catalog, hiding `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed`.
- **`hearth.sh` no longer declares a slow cold start dead.** All three post-start/restart health
  loops now allow 90s instead of 10s. The Linux container's roughly 20s cold boot had made every start exit 1 and
  could leave the container watchdog retrying without ever reaching a healthy state.
- The default workspace is `/workspace` only on Linux. A Windows-native Hearth under Git Bash could
  otherwise see that directory and browse the wrong tree; other platforms use `$HOME/workspace` or
  `$HOME` as before.

## 0.25.0

### Fixed
- **A crew can no longer spawn itself into an infinite tree.** A leader that read "delegate when it
  helps" as "a crew just reported, spawn another one" could keep a spawn loop running: every wake
  answered with a fresh crew, every fresh crew producing another wake. Three guards now bound it,
  each enforced in a `beforeTool` hook (the `session` tool carries the same rules inside its own
  commit, so nothing that reaches it another way slips past):
  - **The switch is enforced.** `delegates: false` (Ember's plain chats, and a leader whose crews
    were turned off) used to be a flag on the summary only — every conversation still had the tool.
    A spawn now refuses with text the model can act on.
  - **One crew at a time.** A conversation may not start a new generation's crew for
    `CREW_SPAWN_MIN_GAP_MS` (10 min) after being woken with its crew's reports. A fan-out is
    instantaneous; a second crew moments after a wake is the loop's edge. Spawns inside one
    generation stay free, so four workers in one turn still work.
  - **An hourly budget.** At most `SPAWN_BUDGET` (20) workers asked for per conversation per hour,
    counted across generations, so even a model that waits out every window cannot keep going.
    Spawn timestamps are now retained for a day instead of only the burst window, so the budget
    survives a restart.
- The depth cap refuses one level *before* the tool disappears (a depth-2 worker's spawn is
  refused, depth 3 has no tool), so a worker whose `lead` chain can't be read — which would otherwise
  look like a root at depth 0 — still cannot spawn for ever.
- The crew prompt section and the worker instructions say a crew report is an answer, not a request
  for more workers; the report-back wake leads with that instruction.

## 0.23.1

### Fixed
- **Reasoning for Kimi K3 and K3.1 is on by default**, because the model reasons whether or not
  anything asks it to. A live call against `https://api.moonshot.ai/v1` (`kimi-k3.1-pro`, no
  thinking parameter, `max_tokens: 8`) answered with empty `content`, a `reasoning_content`
  string and `completion_tokens_details.reasoning_tokens`: there is no switch to send, and the
  model record is what decides whether that text is kept. 0.23.0 shipped the same code path but
  gated it behind `ORCAROUTER_REASONING=1`, which made the fix opt-in and left a default install
  still dropping the model's reasoning. `ORCAROUTER_REASONING` now defaults to `auto`: reasoning
  on for a `kimi-k3*` model, off for anything else, and `1`/`0` still force it either way.
- Kimi K3's verified window (**1,048,576** tokens) is used when the catalog reports no
  `context_window` and no `ORCAROUTER_CONTEXT_WINDOW` is set, so `kimi-k3`, `kimi-k3.1-pro` and
  `kimi-k3.1-pro-highspeed` no longer inherit the generic 128k assumption, which would have
  compacted a conversation at an eighth of the room available. A configured or catalog-reported
  window still wins, and the model is no longer logged as a guessed limit.
- The reasoning shape is keyed off the model id (`kimi-k3*`) rather than the endpoint URL. A
  gateway in front of Moonshot keeps the effort field and the reasoning echo, and Kimi K2.x, whose
  `thinking` object this slot does not send, is left at `reasoning: false` instead of being given
  a `reasoning_effort` field it rejects.

### Note
- pi-ai's openai-completions adapter already maps a streamed `reasoning_content` delta into a
  thinking block and its `reasoning_tokens` into usage, with no `reasoning` gate, so nothing was
  needed on the adapter side: `reasoning: true` on the model is what makes pi-ai offer thinking
  levels and Hearth render the reasoning. This was checked by streaming a `reasoning_content`
  chunk through the real adapter in `test/orcarouter.test.ts`.
- Still unverified without a key: the live `/models` payload (whether it reports a window at all),
  `kimi-k3.1-pro-highspeed` behaviour, and whether the endpoint accepts a `max_tokens` above its
  131,072 default.
- The running Hearth must be restarted for the new defaults: `scripts/hearth.sh restart` (or the
  device's equivalent).

## 0.23.0

### Fixed
- **Reasoning is reachable through the `orcarouter` slot.** The dynamic provider hardcoded
  `reasoning: false`, so a thinking model's chain of thought was dropped and no effort field was
  ever sent. With `ORCAROUTER_REASONING=1` the fetched models now advertise reasoning, carry the
  thinking-level map pi-ai clamps against, and send the model's effort field on every request.
  Kimi K3.1 Pro is the reference case: it always thinks and takes a top-level `reasoning_effort`
  of `low`/`high`/`max` (default `max`), returns its reasoning as `reasoning_content`, and
  requires that content echoed back on multi-turn and tool-calling requests, so a `kimi*` id or a
  `moonshot` endpoint also gets `max_tokens` as the output field and
  `requiresReasoningContentOnAssistantMessages`. pi-ai detects that shape from a Moonshot base
  URL, which a gateway would hide, so it is set explicitly. Any other reasoning model on the slot
  gets plain OpenAI `reasoning_effort` and no level map.
- **The slot's limits no longer guess a small window in silence.** `context_window`/`max_tokens`
  from the catalog still win; when the catalog reports none, `ORCAROUTER_CONTEXT_WINDOW` /
  `ORCAROUTER_MAX_TOKENS` are used, and only then the defaults. Every model that falls back to a
  default is logged with the limit it did not report, so a 128k assumption can be seen and
  corrected rather than trusted. With reasoning on, the unconfigured output fallback is 32k, not
  8k, because a reasoning pass and the answer share that budget and 8k truncates a thinking turn
  before it reaches an answer or a tool call.

### Added
- `ORCAROUTER_REASONING`, `ORCAROUTER_INPUT` (`text` by default, `text,image` for vision, with
  the 2000px / 4.5 MiB image resize limits pi-ai ships for Kimi), `ORCAROUTER_CONTEXT_WINDOW` and
  `ORCAROUTER_MAX_TOKENS`. All are optional and env-only (no new config file), and the two
  existing names, `ORCAROUTER_BASE_URL` and `ORCAROUTER_API_KEY`, behave exactly as before, so a
  current setup that sets only those two produces the same models it did in 0.22.0.
- `src/orcarouter.ts` holds the slot's env parsing and catalog-entry mapping as pure functions
  (the whole block had outgrown its place in `src/models.ts`); `test/orcarouter.test.ts` covers
  reasoning on and off, image input on and off, reported/configured/default limits, the clamp of
  an unnamed thinking level, the zero cost, the old env names alone, and the request body pi-ai
  actually posts.

### Note
- Cost stays at zero for these models: a dynamic endpoint publishes no pricing, so Hearth reports
  no cost rather than an invented one, and Ember shows no provider cost for them.
- The running Hearth must be restarted for the slot to pick this up, and the new env vars are read
  at startup: `scripts/hearth.sh restart` (or the device's equivalent).