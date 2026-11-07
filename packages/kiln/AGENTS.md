# Hearth

> **Local notes:** read `AGENTS.local.md` in this repo root if it exists (it is gitignored, so it
> is per-machine and may be absent). It holds things that must not be published: credentials
> handling, local paths, machine-specific quirks, and anything you are told to remember privately.
> `AGENTS.md` is tracked and public — never put secrets in it. If something you learn belongs only
> on this machine, write it to `AGENTS.local.md` rather than here.

## Copy is the product

**All copy is marketing, especially error messages.** They are the moment a person most needs a
sentence that helps, and the moment a product is most often written badly — `Couldn't load this
session` says what failed and nothing else: not who, not why, not what to do about it.

Every user-facing string is something someone reads while trying to get work done. Write it like
that. Applies to errors, empty states, loading text, tooltips, buttons, confirmation dialogs and
settings descriptions — not just the marketing site.

What good copy does here:

- **Name the actor.** "Remote host didn't answer" beats "Couldn't reach this session". If the host is at
  fault, say so and name it; if the request timed out, say that instead.
- **Never a dead end.** In the *failure* state, point at the recovery that is already on screen
  ("the Refresh button is above", "try again once it's back").
- **Say what the reader can conclude.** "It may be asleep or off the network" gives them a mental
  model; "an error occurred" gives them nothing.
- **No shouting, no jargon.** No exclamation marks, no bare HTTP codes, no `undefined`/`null`/stack
  words, no "Something went wrong."
- **Match the register of the thing.** A calm status line is not a red alert; a transient retry is
  not a failure. Styling and wording must agree — see `src/lib/transcriptStatus.ts` for the split.

When you change copy, look at where it renders, not just the string. And write a test for the
*qualities* (names the actor, offers a next step, no jargon) rather than the exact wording, so the
sentence can be improved later without the test becoming a rubber stamp — see the `error copy` block
in `transcriptStatus.test.ts`.

Ember's durable agent harness (**Kiln**) on Pi Durable — see `README.md` for the wire contract and
`scripts/README.md` for per-device operational details.

## Commands

- `bun run start` — run the host in the foreground.
- `bun run check` — typecheck (`tsc --noEmit`) + `bun test` (224 tests, faux provider, no
  network). Run before committing.
- `scripts/hearth.sh` — the control script: `start|stop|restart|status|url|token|logs`
  (supervisor with restart-on-exit; data in `HEARTH_HOME`, default `/root/.pi` or `~/.hearth`).
  `scripts/from-mac.sh` runs the same commands over SSH (`<host>`).
  `scripts/serve.sh` is a back-compat alias for `hearth.sh start`. `scripts/install-windows.ps1`
  and `scripts/hearth-watchdog.ps1` install the Windows launcher (a supervising runner plus a
  watchdog task) and live in this repo; the macOS launchd agent and the container entrypoint
  stanza are host-specific one-offs kept outside it.
- Pi packages are pinned to exact versions (see `package.json`); the API changes without
  notice, so upgrade deliberately and re-run the tests.

## Paths on Windows: two conventions in one session

The `bash` tool runs **Git Bash (MSYS)**, whose paths look like `/c/Users/<you>/x`. The `read`, `write`
and `edit` tools resolve paths with **Windows** rules, where a leading slash means "root of the current
drive" — so `/c/Users/<you>/x` is not an error, it is `C:\c\Users\<you>\x`. A read then fails with an
ENOENT naming a path nobody typed, and a **write succeeds**, creating that tree and reporting success,
so the file lands somewhere no one will look.

So: **use `C:/Users/<you>/...` in the file tools, and `/c/Users/<you>/...` only inside `bash`.** When a
path comes out of shell output (`pwd`, `find`, `ls`), translate it before handing it to a file tool.

This is upstream behaviour, not a Hearth defect, and it is deliberate: earendil-works/pi closed the
same report as working-as-intended (`/c/foo` really is `CURRENT_DRIVE:\c\foo` on Windows) and pointed
at agent instructions like this one as the remedy — issue
[#4688](https://github.com/earendil-works/pi/issues/4688), where a user reports the identical trap.
Do not file it again; if it ever needs revisiting, the maintainers asked for a session that shows a
frontier model falling into it.

## Conventions

- The single Bun process owns `/root/.pi/hearth.sqlite` (WAL). Never open it from another
  process while Hearth runs (tests use their own temp dirs).
- Everything on the wire is authenticated with the bearer token in
  `/root/.pi/hearth.token`. Never log or commit it. `HEARTH_HOME` relocates data for tests.
- Conversations, entries, submissions: **numbers** on the wire; conversation summaries
  are newest-first, snapshot entries chronological, `GET /entries` pages newest-first.
- Approvals and questions are **documents keyed by the tool task id** — the gate parks,
  then polls the document, so reruns after a crash resume the same wait. Don't move that
  state into memory.
- `wrapTool` matches by tool name: the approvals gate wraps `read`/`view`/`write`/`edit`/`bash`
  wherever they come from. New gated tools need a `gate(...)` entry in `src/approvals.ts`.
- **A session's shell environment is built in one place** (`sessionEnv` in `src/scratch.ts`): it
  carries `HEARTH_CONVERSATION`, which is what makes a process an agent leaves running attributable
  to its session (`src/processes.ts`), and a `TMPDIR` on disk under `HEARTH_HOME`. Anything that
  starts a command for a conversation must go through it — a command without the tag leaves a
  process nobody can attribute, list, or offer to stop.
- **Agent commands run under the scope shell when the host can** (`src/shell.ts` →
  `NodeExecutionEnv({ shellPath })`): a wrapper that puts each command in its own transient scope in
  `hearth-agents.slice`, a sibling of `hearth.service`, so what an agent starts is not charged to —
  or killed with — the host's unit. Nothing else needs to know; but do not spawn a conversation's
  command by hand, or it lands back in Hearth's cgroup.
- **A crew never spawns itself into a tree.** Every spawn passes `spawnGuard` (`src/crew.ts`,
  installed before `Sessions`): refused when the meta says `delegates: false`, when the conversation
  was woken with its crew's reports less than `CREW_SPAWN_MIN_GAP_MS` ago, or when it has asked for
  `SPAWN_BUDGET` workers in the last hour. The `session` tool enforces the same rules inside its
  commit; keep the two in step (`spawnRefusal` is the pure definition). Don't add a "spawn to relay
  my report" path: the report-back wake is an answer, not a request.
- Messaging resolves a name the same way everywhere: the caller's own crew doc first (crew name or
  composed title via `findCrewTarget`), then the registered agent directory. Another leader's
  worker is refused, never driven, so keep crew dispatch inside that order.
- Reads never enable scheduling: after a reopen, `src/index.ts` must `resume()` and make
  a progress call (`waitForIdle`) before recovered work runs. Keep that in `index.ts`.
- `bun run check` before every commit; commit and push `main`.
- **Versioning:** every shipped change bumps `package.json` `version` per `VERSIONING.md`
  (semver), and `/health` reports it. Record it in `CHANGELOG.md`.

## Background thread delivery

New `session spawn` calls use `report: "thread"`; absent persisted delivery still means legacy
`always`. Keep that compatibility boundary. `threadResults.ts` owns task versions, retrieval receipts
and completion eligibility; `threadSupervisor.ts` owns selective resumptions. Submission plus receipts
must remain one transaction, and admission must recheck foreground/inbox state and current result
versions. Never equate retrieved with verified, incorporated or human-read. `session wait` registers
thread subscriptions and releases the tool round; legacy crews keep the blocking wait contract.
Only metadata goes in `hearth.thread-result` and `hearth.thread-notice`; result prose stays in the
worker/result document. Failures and human blockers remain actionable without a subscription. The
leader must never answer or approve on the human's behalf merely because a thread is blocked.
