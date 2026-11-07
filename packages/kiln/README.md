# Hearth

Ember's durable agent harness, built on [Pi Durable](https://github.com/earendil-works/pi)
(`@earendil-works/pi-durable`, pinned — the upstream API changes without notice).
Hearth is the single Bun process that owns the SQLite storage, serves the providers,
runs the tools behind an approval gate, and exposes the wire Ember talks to. It replaces
OpenChamber/OpenCode as Ember's backend in the transition plan
(see the plan in the Ember repo: `PI_TRANSITION_PLAN.md`).

- Storage: `$HEARTH_HOME/hearth.sqlite` (WAL) — `/root/.pi` in a container, `~/.hearth` on
  macOS/Linux, `%USERPROFILE%\.hearth` on Windows. A nightly `VACUUM INTO` backup goes to
  `$HEARTH_BACKUPS_DIR`, defaulting to `$HEARTH_HOME/backups` (local disk); containers can set
  `/workspace/backups`. 30 are kept.
- Port: `3002` bound to `0.0.0.0` (published; reachable across a tailnet at e.g.
  `http://100.64.0.1:3002`). `HEARTH_PORT` overrides.
- Auth: every route (and WebSocket) requires the bearer token from `$HEARTH_HOME/hearth.token`
  (generated on first start, mode 0600). Also accepted as `?token=` for WebSocket clients.
- `HEARTH_HOME` (default `/root/.pi` or `~/.hearth`) relocates storage + token for tests and canary runs.

## Bundled and standalone lifetimes

Ember ships a default local Kiln. Launching Ember starts it; quitting Ember stops it. Closing a
window on macOS leaves the app and its Kiln running. Conversation history stays on disk.

For a backend that lives independently, use the compiled Tinder download: `tinder serve` runs
Kiln in the foreground, with no Bun installation or checkout required. `tinder setup --headless`
writes a service definition; run the activation command it prints to start the background service.
Ember can connect to multiple Kilns, and quitting the GUI leaves Tinder-managed backends running.
Use separate homes and ports when running multiple backends on one computer.

## Run from source

```sh
bun run start                 # foreground
scripts/hearth.sh start       # detached supervisor (start|stop|restart|status|url|token|logs)
scripts/from-mac.sh start     # the same, over SSH from a remote machine
bun run check                 # typecheck + tests (224 tests, no network)
```

`scripts/README.md` covers running Hearth across devices (macOS, Windows, and Linux containers).
The Windows launcher is in `scripts/` (`install-windows.ps1`, `hearth-watchdog.ps1`); the macOS
launchd agent and the container entrypoint stanza are host-specific one-offs kept outside the repo.

## The wire

HTTP for lists and actions; WebSockets for streams. All bodies are JSON — a failure too: every
non-2xx carries `{ "error": "…" }`, a sentence that names what was wrong (the route, the method, the
id, the field) and what to send instead, never a stack trace.

| Route | Meaning |
|---|---|
| `GET /health` | Liveness (auth still required). Also `memory`: the host's own `rssBytes`/`heapUsedBytes`, the machine's `totalBytes`/`availableBytes` with a `level` (`normal`/`low`/`critical`), and `leftRunning` — how many processes agents left behind, host-wide. That is what turns "Hearth was killed for memory" into a number instead of a guess. |
| `GET /conversations` | Every conversation: id, parent/owner, cwd, model, thinkingLevel, title, archived, lastEntryId (newest first). Each summary also carries `busy`, `autoAccept` (server-side YOLO), `compacting` (a compaction task in flight) and `cost` — USD that conversation has spent, summed from its own `pi.usage` ledger (0 for one that has never run), so a client can show a per-session total without reading its transcript. A session whose commands left something running also carries `processes: { count, rssBytes, items }` (the heaviest few), which is what a client draws its "still running, with a Stop button" notice from; the envelope carries `host.memory` (the same shape as `/health`'s) because whether that notice is information or a warning depends on the whole machine, not on the session. |
| `POST /conversations` | Create: `{ cwd?, model? {provider, modelId}, thinkingLevel?, title? }`. |
| `GET /conversations/:id?cursor&images` | Snapshot: the conversation record (`id`, plus `parent`/`owner` edges), the newest page of active entries (**chronological**), and docs (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`, `pi.provider`). The page is the newest 100 entries and at most 12 MB of JSON — the row cap is what bounds `pi-durable`'s parse, which is why it matches `/entries` — and a `next` means older entries were left out. That cursor names *older* entries (prepare to prepend, not append) and is the same keyset `/entries` takes; a conversation that fits is unchanged apart from the absent `next`. |
| `GET /conversations/:id/entries?limit&cursor&since&docs&images` | Page entries; newest first; `next` is the opaque cursor — send it back as `cursor` unchanged. `limit` is a whole number from 1 to 100 (50 when absent) and `since=<entryId>` returns only entries *newer* than that one (exclusive) — the incremental read a streaming client repeats — and a `next` on such an answer means entries in between were left out. The cap is 100 rather than 500 because a page is materialized in memory as it is read and an entry can carry a multi-megabyte image: paging more is cheap (the cursor is a keyset), holding more is not. A page is additionally bounded to 12 MB of JSON, so a page of screenshot-heavy entries may come back shorter than `limit` with a `next` to continue from. `images=ref` replaces every inline image payload with `{ type: "image-ref", entryId, index, mimeType }`; without it the base64 rides in the entry, which is what a client that cannot resolve a reference needs. |
| `GET /conversations/:id/entries/:entryId/images/:index` | The bytes of the `index`-th image of an entry, counted across its messages in order. `content-type` is the image's own. This is what an `image-ref` points at; a `view` tool result is 2.3MB of base64, and a session with nine of them cost ~20MB per entry page until the reference existed. |
| `WS /conversations/:id/events` | The conversation's **state** stream (pi-durable 1.5.0; the old event protocol is gone). Each message is an array of frames. First: `{ "type": "view", conversation, docs }` — the live documents (`pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`, `pi.provider`), never entries: history is `GET /conversations/:id/entries`. Then, per commit: `{ "type": "text", deltas: [{ index, kind, text }] }` for appends to the in-flight answer (the only per-token frame); `{ "type": "appended", entries }` for entries that landed; and `{ "type": "changed", kinds }` for everything else, where `kinds` is any of `live` (a tool slot moved), `run_start`, `run_end`, `run_failure`, `compaction` (history may have been rewritten), `inbox`, `agent`, `usage`, `provider`, `conversation`, `entries`, or `unknown` (take a tail read). An overflow re-sends a `view`. |
| `WS /tasks/stream` | The live task graph, sent whole on attach and after every change. |
| `POST /conversations/:id/submit` | `{ type: "input", content: string, whenBusy?: "steer"\|"followUp"\|"reject", requestId? }` or `{ type: "write", entry: { kind, data? }, requestId? }` → `{ submissionId, status, mode, entry?, reason? }`. `status` is one of `placed` (in the transcript, a run owns it), `queued` (waiting for the turn in progress), `done` (a write appended its entry) or `unanswered` (settled without an answer — it never ran, or the run failed); `reason` says why when it is `unanswered` (`aborted`, `stale`, a provider failure) and `entry` is the entry id when there is one. A client that reads only `placed`/`queued` has to treat `unanswered` as unsent. `mode` is `steer`\|`followUp`\|`write` (a busy steer and a busy follow-up are both `queued`, so `mode` is what tells them apart); `whenBusy: "reject"` on a busy conversation is a 409 rather than a queue. `requestId` is idempotent across restarts: a retry returns the submission that already placed the message, and a submission that settled **without** reaching the transcript (stopped before it ran) is re-placed with a fresh submission id — so a retry cannot report a message as sent that never arrived. |
| `POST /conversations/:id/submissions/:sid/abort` | Withdraw a queued submission from *this* conversation's inbox → `{ ok, result }`, where `result` is `aborted`, `already_placed` (too late: the turn took it) or `settled` (it is over). Submission ids are global but the route is not: an id belonging to another conversation is a 404 and that conversation's inbox is untouched. |
| `PUT /conversations/:id/queue/order` | `{ itemIds }` (every queued message once) → reorder the inbox: each queued input is withdrawn and re-submitted in that order (fresh ids); returns `{ revision, session }`. |
| `GET /conversations/:id/processes` | `{ host: { memory }, processes }` — every process this conversation's commands left running (`pid`, `command`, `rssBytes`, `startedAt`), heaviest first. A process is "left" when it is still tagged with this conversation and no longer runs inside a live command (see `src/processes.ts`), so one left by a *previous* Hearth run is still attributed. |
| `POST /conversations/:id/processes/stop` | `{ pids, force? }` → `{ results: [{ pid, command?, outcome }], host, processes }`, where `outcome` is `stopped`, `gone` (not there, or not this conversation's to stop) or `refused` (it took SIGTERM and is still alive — a client asks before `force`, which is SIGKILL). A pid is only signalled when the scan still attributes it to this conversation, so a recycled pid cannot be killed by a stale client. `processes` is the state *after*, so the caller does not have to re-read to redraw. |
| `POST /conversations/:id/abort` | Stop the conversation's current work. Returns as soon as the abort is requested (it never waits for a long step), clearing any parked approvals/questions; the run winds down in the background. |
| `POST /conversations/:id/compact` | `{ instructions? }` → `{ taskId }`. |
| `POST /conversations/:id/fork` | `{ at? }` (default newest entry) → the new conversation. |
| `POST /conversations/:id/reset` | `{ handoff? }` starts a fresh context. |
| `POST /conversations/:id/configure` | `{ model?, thinkingLevel?, cwd?, instructions? }` (null clears a field). |
| `PATCH /conversations/:id` | `{ title?, archived? }` — Ember's rename/archive; null clears. |
| `GET /models` | The merged provider catalog + `{ provider, modelId }` default. |
| `GET /usage` | Token/cost totals across every conversation. |
| `GET /approvals` | Pending tool approvals across conversations. |
| `POST /approvals/:conversationId/:key/reply` | `{ decision: "once" \| "always" \| "reject" }`. |
| `PUT /conversations/:id/auto-accept` | `{ enabled: boolean }` — server-side YOLO; holds while Ember is closed. |
| `GET /scheduled-tasks` | Every scheduled task plus the process `timezone`. |
| `POST /scheduled-tasks` | Create: `{ name, prompt, schedule, enabled?, conversationId?, cwd?, model?, thinkingLevel? }`. |
| `PATCH /scheduled-tasks/:id` | Update any subset of the create fields. |
| `DELETE /scheduled-tasks/:id` | Remove a task. |
| `POST /scheduled-tasks/:id/run` | Run now. |
| `GET /context-rules` | Every keyword-triggered context rule. |
| `POST /context-rules` | Create: `{ keywords: string[], text, enabled? }`. |
| `PATCH /context-rules/:id` | Update any subset. |
| `DELETE /context-rules/:id` | Remove a rule. |
| `GET /questions` | Pending parked questions. |
| `POST /questions/:conversationId/:key/reply` | `{ answer: string \| null }` (null dismisses). |

**Durability:** approvals and questions park in conversation documents keyed by the tool
task id, then the tool waits on the document — so a crash rerun finds the same parked
request and keeps waiting, and decisions survive restarts. Approving "always" remembers
the tool per conversation. A run interrupted mid-tool is re-issued on reopen; reads never
drive scheduling — recovered work runs when the host calls `resume()` plus a progress
call (`waitForIdle`), which `src/index.ts` does at startup.

**Conversation ids, entry ids and submission ids are numbers on the wire.**

**Stopping:** `POST /conversations/:id/abort` marks the run and returns without waiting for it to
wind down (`ABORT_FAST_RETURN_MS`, 250ms), clearing parked approvals/questions first — so Ember's
stop is immediate even when a tool is wedged. Every gated coding tool and MCP tool is wrapped in
`withAbortRace` (`src/interrupt.ts`), which races the step against the run's abort signal; a tool
that ignores cancellation is cut loose and settles `aborted` instead of pinning the abort. A step
cut short is committed as an aborted tool result, which Ember renders as `[step interrupted]`.

**Keyword context:** a session-scoped rules doc (`hearth.context-rules`) injects a snippet when a
submitted message mentions one of its keywords (case-insensitive). The snippet lands as a
`hearth.context` `write` entry ahead of the input — the model sees it, the transcript skips it.
Rules survive restarts. `GET/POST /context-rules`, `PATCH/DELETE /context-rules/:id`.

**AGENTS.md:** the conversation cwd's `AGENTS.md` (or `CLAUDE.md`) is rendered into the system
prompt every request by the `agents-md` extension, so an edit shows up on the next turn.

**Images (`view` tool):** pi-durable's `read` refuses images ("reading images is not supported"),
so an agent could not see a screenshot even on a vision-capable model. The `view` tool reads an
image file (PNG, JPEG, GIF, WebP or BMP), sniffs the format, and returns it as an `ImageContent`
block — the same shape MCP image results use — which pi-ai hands to the model's vision input. Gated
by approvals like `read`.

**Background threads (`session` tool):** conversations may delegate by default. A worker is an
ownerless conversation with `kind: "worker"` and `lead`; a peer (`kind: "peer"`) is a separate,
visible chat. Give each thread a concrete outcome `title` and a self-contained `brief`; absent a
title, its brief's first line supplies one. Identity survives follow-up work and renames.

New spawns default to `report: "thread"`. The supervisor records a versioned outcome and its final
assistant-entry reference in `hearth.sessions`, and appends one content-free `hearth.thread-result`
event. It does **not** copy the report into the leader's transcript. `results(name?)` retrieves up
to three bounded outcomes (8,000 characters each), including `/threads/<conversationId>` source
links; it records which result versions were retrieved, independently of verification,
incorporation, and human read marks. `read(name, cursor?, since?)` returns status and up to 12
entries with bounded evidence; `cursor` pages history and `since` reads new evidence oldest first.
Raw evidence reads do not mark an outcome retrieved.

A thread can itself coordinate nested threads: its durable suspended state prevents an intentionally
released run from being reported as a failure to its parent.

`wait(name?)` registers a durable subscription to current thread task versions and ends the tool
round without another model request when it is the round's only control. It does not poll for ten
minutes. Once the foreground run and human inbox are clear, the supervisor coalesces available
outcome identifiers into an internal `hearth.thread-notice` continuation. Submission and delivery
receipts share a transaction. Already-retrieved results do not wake again. Failures, stopped
threads and human-input blockers are actionable without a subscription; blockers never authorize
the leader to answer or approve for the human. A subscribed task still running beyond the
15-minute crew deadline produces one status notice. The agent can coordinate silently and quote
selected findings rather than acknowledge each completion.

Existing entries without a delivery field retain legacy `always` behavior. Explicit `report:
"always"` and `"on-failure"` retain report-card delivery and role-based numbered titles; a legacy
crew's `wait` still waits for quiescence. Depth, burst, post-wake and hourly loop guards remain.
Worker concurrency is unlimited by default, with `HEARTH_MAX_ACTIVE_WORKERS` as an optional ceiling.
There is no host-wide model slot that a background wait holds; provider rate limits and latency
still apply. `list`, `status`, `message` and `stop` manage threads, and delegation may be disabled
without preventing inspection of earlier work. Archiving a leader still cascades to its workers,
never peers.

Clients render the crew from the conversation summaries: `kind`, `lead`, `delegates` and
`needsInput` are on `/conversations`, so a hidden worker never needs a fetch of its own. Workers
are hidden from Ember's rail and surface only in the leader's strip; a worker's parked question
rolls up to its leader's `needsInput`.

**Named agents (`agents` tool):** a per-host registry (`hearth.agents`) binds a **name** to a
conversation — one name per host, duplicates rejected. `GET /directory` merges the registry with
each conversation's live summary (title, kind, busy, `needsInput`), pinned first, skipping
conversations that are gone. The `agents` tool lets an agent list the directory (`directory`),
send a message to a peer by name (`send`, idempotent per tool task), and `pin`/`unpin`; there is
deliberately **no agent-facing `register`** — only a human names an agent. A `known_agents`
standing section keeps pinned + three recent agents in every prompt, read from an atomic
`<home>/agents.json` mirror of the registry (the doc stays the source of truth). A human
**promotes** a worker to a peer (`POST /conversations/:id/promote`): Hearth forks it into an
ownerless `kind: "peer"`, keeps `lead` as history, registers the name, and links the old worker
via `promotedTo`.

**Messaging a crew (`agents send`):** a leader can give one of its own workers another task
instead of spawning a fresh one. `send` resolves the caller's **own crew first**, by the crew name
it spawned or by the composed title (`Researcher #1`, case-insensitive), and only then falls back
to the registered directory, so registered-name behaviour is unchanged. `followUp: true` queues the
message, which is what a busy worker wants: it lands at that worker's next turn boundary instead of
interrupting the turn it is in; without it the message steers. Replies are short: `Queued for
Researcher #1.` or `Sent to Researcher #1.`. A worker of another leader is refused
(`Refused: <title> is in another leader's crew (conversation N), so only that leader can message
it.`), checked against the other crews on the host, so a conversation only drives the crew it
started; a genuinely unknown name keeps the old `No agent named <name>. Only a human can register
an agent.` reply. `session message` accepts the composed title as well as the crew name.

**Scheduled tasks:** due-times live in a session-scoped document (`hearth.scheduler`), so they
survive restarts. A tick loop submits due tasks to their target conversation (created on first
run from `cwd`/`model`), and each submit carries a `requestId` of `taskId:instant` — idempotent
across restarts, so a crash cannot double-run a task. Missed occurrences run once on the next
tick. `schedule` is `{ kind: "once", at }`, `{ kind: "daily", time: "HH:mm", timezone? }`, or
`{ kind: "weekly", time, weekdays: [0-6], timezone? }`; `timezone` defaults to the process zone.

## MCP servers

Hearth spawns MCP servers over stdio and registers their tools into every conversation.
Configure them in `$HEARTH_HOME/mcp.json` (Claude-style):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless", "--no-sandbox",
               "--user-data-dir", "/workspace/.playwright-profile"]
    }
  }
}
```

Each server's tools are exposed as `<server>__<tool>`; an MCP `inputSchema` is JSON Schema, so it
becomes the tool's parameters verbatim. Servers that fail to start are logged and skipped.
Restart Hearth after editing the file. `--user-data-dir` gives Playwright a persistent,
logged-in profile; `--isolated` (or a distinct dir) keeps concurrent clients from conflicting.
MCP `image` result parts (e.g. a Playwright screenshot) are forwarded as image content, so
image-capable models see the pixels rather than a JSON blob.

**Collapsing a server into one tool.** A server with many tools can be presented as a single
action-dispatch tool instead of one tool per MCP tool (Playwright's 25 → one `browser`):

```json
{
  "mcpServers": {
    "playwright": {
      "tool": "browser",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless", "--no-sandbox"]
    }
  }
}
```

`tool` names the collapsed tool; `action` selects the underlying MCP tool and the remaining
inputs are forwarded (top-level or under `parameters`). The action set is the server's tool names
with a shared prefix stripped — the longest common `_`-delimited prefix by default, or an explicit
`actionPrefix` — and `exclude: ["<action>"]` omits actions. Every action is exposed by default,
including unsafe ones like Playwright's `run_code_unsafe`, which stays behind the approval gate.

At startup Hearth logs the loaded config path and each server's tool/action count, and states them
in the system prompt (`mcp_servers`), so an agent reports the real provenance instead of guessing.

## Updating

Pull the new commit on the host and Hearth restarts itself onto it — no separate restart step:

```sh
git -C ~/hearth pull --ff-only   # Hearth notices the new commit and restarts (HEARTH_AUTORELOAD)
```

`HEARTH_AUTORELOAD` defaults to on; set it to `0` to disable, and `HEARTH_RELOAD_INTERVAL_MS`
(default 5000) tunes the poll. The restart waits for an idle moment (durable runs resume if it has
to force) and is skipped when `bun.lock` changed — a restart against stale dependencies would
crash-loop. For that case, or for an explicit deploy, use `scripts/hearth.sh update` (or
`scripts/from-mac.sh update` over SSH): `git pull` + `bun install` + restart.

The host must be supervised so it comes back after the restart — that is already true: the Mac's
launchd `KeepAlive` agent, the container's entrypoint loop / `hearth.sh` supervisor, and the
Windows logon task (configured to restart on failure — Hearth exits 75 on a self-restart so it
does). `POST /admin/restart` (bearer-authenticated, optional `{"reason": "…"}`) triggers the same
graceful restart over the wire, so a client like Ember can offer a Restart button per host.

## Providers

`src/models.ts` registers opencode-go, **opencode (OpenCode Zen)**, xai, openai, deepseek, google
(Gemini) and fireworks, plus orcarouter (custom baseURL + env key + a fetched dynamic catalog) when
`ORCAROUTER_BASE_URL` + `ORCAROUTER_API_KEY` are set, plus the two Kimi slots below when either
holds a key.

### Gemini (`google`)

Gemini has no slot of its own: pi-ai's `google` provider is registered at boot (`src/models.ts`) and
carries Gemini's catalog, so adding it is a credential, not a code change.

```sh
scripts/hearth.sh provider set google <GEMINI_API_KEY>
```

or `GEMINI_API_KEY` in the environment (a stored credential wins). The key comes from
[AI Studio](https://aistudio.google.com/apikey); the newer `AQ.…` keys work too — Google takes them
in the `x-goog-api-key` header, which is what pi-ai's `google-generative-ai` API sends. A key that
is an OAuth-style token rather than an API key answers 401 on every request.

No restart is needed: `GET /models` serves `getAvailable()`, which resolves each provider's
credential per request, so Gemini's models appear as soon as the key is stored and disappear when it
is removed. `GET /providers` lists `google` either way, with `credential` null until a key is stored.

A billing or model-availability failure is not a credential failure, and it reads that way on the
wire: `POST /submit` still answers `placed`, and the run then ends with a `pi.assistant` entry whose
`stopReason` is `error` and whose `errorMessage` carries Google's own sentence — a 402 ("Your
prepayment credits are depleted…") when the project has no credits, a 404 ("no longer available to
new users") for a retired id. The conversation and its transcript are preserved; nothing is
retried, so top up billing at [AI Studio](https://ai.studio/projects) or pick a current model from
`GET /models` and send the turn again.

### Kimi (Moonshot), under its own provider ids

Two slots, both from `src/kimi.ts`, because Moonshot sells two things with different keys and
different endpoints:

| Provider id | Key (env, stored-first) | Base URL | Catalog |
| --- | --- | --- | --- |
| `moonshotai` | `KIMI_API_KEY` / `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | read at boot from `GET /models`; pi-ai's Moonshot list is the offline fallback |
| `kimi-coding` | `KIMI_CODING_API_KEY` | `https://api.kimi.com/coding/v1` | pi-ai's Kimi Code list (`k3`, `kimi-for-coding`, …) |

`KIMI_BASE_URL` / `KIMI_CODING_BASE_URL` point a slot at a gateway, and `KIMI_REASONING=off` drops
the reasoning field for an endpoint that rejects it. A slot is registered at startup when its key
is in the environment **or** a credential is already stored for it (`scripts/hearth.sh provider set`,
or Ember's Settings → Providers). Storing the first credential for an unregistered slot therefore
takes effect on the next restart; later credential changes need no restart. Use these rather than
`orcarouter` for Kimi: the ids stay the provider's own (`kimi-k3`), the 1M window and image input
come from the catalog, and a conversation started on one host's Kimi entry is the same model id
on another host's.

### orcarouter (a dynamic OpenAI-compatible endpoint)

The slot describes whatever the endpoint lists at `GET /models`. Two env vars turn it on; the
rest are optional, and their defaults are the behaviour the slot had before they existed, so a
setup that only sets the first two keeps working:

| Env var | Default | What it does |
| --- | --- | --- |
| `ORCAROUTER_BASE_URL` | unset (slot off) | Endpoint base, e.g. `https://api.moonshot.ai/v1`. |
| `ORCAROUTER_API_KEY` | unset (slot off) | Bearer token for every request and for `/models`. |
| `ORCAROUTER_REASONING` | `auto` | `auto` turns reasoning on for a model that always reasons (Kimi K3 and K3.1) and off for any other. `1`/`true`/`yes`/`on` turns it on for every listed model, `0`/`false`/`no`/`off` for none. |
| `ORCAROUTER_INPUT` | `text` | `text,image` (or just `image`) also advertises image input, with the 2000px / 4.5 MiB resize limits pi-ai applies before sending. Unknown words are ignored. |
| `ORCAROUTER_CONTEXT_WINDOW` | unset | Fallback window used only when the catalog reports no `context_window`. |
| `ORCAROUTER_MAX_TOKENS` | unset | Fallback output cap used only when the catalog reports no `max_tokens`. |

Limits, in order: the catalog's own `context_window`/`max_tokens`; then the env fallback; then a
verified window for a model known to be much larger than the default (Kimi K3 and K3.1 are
1,048,576); then 128k of context and 8k of output, or 32k of output for a reasoning model (a
reasoning pass and the answer share that budget, so 8k truncates a thinking turn mid-thought).
Hearth logs every model that falls through to a default, naming the limit, so a guessed window is
never silent.

Cost is left at zero: a dynamic endpoint publishes no pricing, so Hearth reports no cost rather
than an invented one, and Ember shows no provider cost for these models.

Kimi K3.1 Pro (`kimi-k3.1-pro`) is the reference case, verified against the live endpoint.
Reasoning needs no request field: the model always thinks and returns its reasoning in an
assistant `reasoning_content` field, with the count in
`usage.completion_tokens_details.reasoning_tokens` (pi-ai's openai-completions adapter turns
`reasoning_content` into a thinking block, so nothing else is required). What the slot adds for
it is the model record (`reasoning: true`, so pi-ai offers thinking levels and Hearth renders the
reasoning), the top-level `reasoning_effort` field Kimi documents (`low`/`high`/`max`, default
`max`, with pi-ai's levels mapped onto it: `minimal` to `low`, `medium` to `high`, `xhigh` to
`max`; `off` cannot be requested), `max_tokens` as the output field, and the `reasoning_content`
echo K3 requires on multi-turn and tool-calling requests:

```sh
ORCAROUTER_BASE_URL=https://api.moonshot.ai/v1
ORCAROUTER_API_KEY=…
HEARTH_DEFAULT_MODEL=orcarouter/kimi-k3.1-pro
# Everything below is optional.
ORCAROUTER_INPUT=text,image
ORCAROUTER_MAX_TOKENS=131072
```

The reasoning shape follows the model id: `kimi-k3*` gets the above and keeps it behind a gateway;
anything else gets plain OpenAI `reasoning_effort` and no level map, since only that family's
levels and its `reasoning_content` echo are known. Kimi K2.x is deliberately left out: it takes a
`thinking` object that this slot does not send, so a K2 model should stay with
`ORCAROUTER_REASONING=off` (its default).

`opencode-go` and `opencode` (Zen) are the providers that aren't limited to the catalog pi-ai
ships: on every boot each asks its own list (`/inference/go/v1/models`, `/inference/v1/models`)
with the provider's own key and serves what the service lists (see `src/model-discovery.ts`) —
pi-ai's own entries keep their api and limits, ids pi-ai doesn't describe yet are described from
[models.dev](https://models.dev) with a catalog- (or family-) inferred wire API, and models
OpenCode retires stop being offered. An id whose catalog entry names no protocol this provider
can stream is probed once against the provider's own routes and offered only where one answered;
both providers speak Anthropic, both OpenAI shapes and Google as of pi-ai 1.3.0, so Go's Gemini
is offered too. It is best-effort: offline, unauthenticated or unreadable, the shipped catalog
stands. `HEARTH_DISCOVER_MODELS=0` turns it off. Credentials live in Hearth's own store
(`$HEARTH_HOME/auth.json`); on first boot Hearth adopts any existing OpenCode credentials
(`~/.local/share/opencode/auth.json`) into it, and `OPENCODE_API_KEY` remains an env fallback.
`HEARTH_DEFAULT_MODEL` (`provider/modelId`, default `opencode-go/glm-5.3-flash`) sets the default
agent.

## Repo layout

- `src/config.ts` — paths, port, token; `HEARTH_HOME`/`HEARTH_PORT` overrides.
- `src/models.ts` — provider set + credential bridge + default agent.
- `src/orcarouter.ts`: the dynamic orcarouter slot's env knobs and catalog-entry mapping (pure).
- `src/model-discovery.ts` — live `opencode-go` / `opencode` (Zen) catalogs (the service's id list, over pi-ai's catalog).
- `src/registry.ts` — CodingTools + approvals + ask + sessions + the AGENTS.md section.
- `src/approvals.ts` — the approval gate (wrapTool) + pending/auto-accept docs.
- `src/ask.ts` — the ask tool + parked-question doc.
- `src/sessions.ts` — the `session` tool (spawn/manage sibling conversations) + `hearth.sessions` doc.
- `src/interrupt.ts` — `withAbortRace`, so a step that ignores cancellation can't pin `POST /abort`.
- `src/agents.ts` — renders the conversation cwd's `AGENTS.md` into the system prompt.
- `src/meta.ts` — Ember-owned title/archive doc.
- `src/server.ts` — the wire (HTTP + WS + auth).
- `src/backup.ts` — nightly `VACUUM INTO` snapshot into `$HEARTH_BACKUPS_DIR` (default
  `$HEARTH_HOME/backups`).
- `test/` — approvals, ask, and the full wire (including reopen-resume) with the faux provider.
