> **Reminder:** Check `/workspace/AGENTS.md` first for general container usage and best practices (ports, binding, host access, etc.) — it applies to every project in this workspace.

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

- **Name the actor.** "Tower didn't answer" beats "Couldn't reach this session". If the host is at
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
in `tests/transcriptStatus.test.ts`.

# Ember

Desktop control room for **Kiln** (`packages/kiln`, Ember's durable agent harness) and **OpenChamber**. One window shows the most recent sessions across every connected instance (`~/.ember` / `settings.piEndpoints` and `~/.config/openchamber/settings.json`).

**Kiln lifecycle:** Ember is the GUI and connects to multiple Kilns. It ships with a default local
Kiln that starts with Ember and stops when Ember quits; do not detach that bundled process or add
a keep-running-on-quit mode. On macOS, closing the window is not quitting the app. Tinder is the
entry point for a standalone backend with an independent lifetime. Connecting to a Tinder-managed
Kiln does not give Ember ownership of it, and quitting Ember must leave it running.

## Product direction (1.9.0)

- Project selection is one anchored menu shared by setup, the composer and Settings. A per-instance
  `workspaceDirectory` is the user's chosen parent folder for browsing, separate from `directory`
  (the optional default project for new chats). Recent projects come from non-worker, active chats.
  Kiln's suggested workspace is only a starting point; explicit `scope=computer` directory requests
  let the human browse existing work elsewhere. Path entry and New folder are revealed on demand.
  Folder creation never overwrites an existing folder or creates a missing parent tree.
- Message details end in Copy and Reply shortcuts, revealed by footer hover or keyboard focus and
  visible on touch devices. Reply attaches that message to the existing composer draft and focuses it;
  the original gutter Copy remains. Kiln's unset conversation thinking level resolves to Off, and an
  unchanged reasoning choice says “Keep <level>”. Historical footers use the turn's recorded level.
- The composer has no generic “Next” reply suggestions; the human supplies the next direction.
- The human thinks, decides and steers. Read marks record explicit acknowledgement; muting a chat
  (`settings.mutedSessions`) suppresses notification indicators without changing those marks. Legacy
  `readMarks.quiet` is migrated at the settings boundary and never advances reading automatically.
- Unread navigation lives above the transcript: “Go to new messages” jumps to the newest unread
  finished reply without marking it. Multiple unread replies offer “Mark all as read”. Each reply's
  `MessageReadButton` has a 44px hit area and immediate check/spin/fade confirmation (fade only for
  reduced motion). Read eligibility is shared with `unreadDigest`; live output is never marked early.
  Tool-call steps (including commentary) need no read receipt. Folded tool rows keep the final
  reply’s original eligibility, and tool steps never block advancing a reply’s read mark.
- Home has been removed. Startup restores the workspace or opens a recent chat; an empty install
  starts a draft on an available Kiln. Unread reading remains accessible from the rail.
- `settings.blobSize` chooses Standard, Large or Extra large on recognition surfaces through
  `AvatarSizeContext`; transcript icons keep their compact size. ComposerIdentity repeats the current
  chat’s resolved blob and name beside the input, whose faint tint uses that same colour.
- Blobs are mnemonic devices for chats. Automatic colours are stable per session, independent of
  project membership and visibility. The appearance picker defaults to one chat and accepts a custom
  hex colour; the blob and soft background glow must use the same resolved identity. Project/task
  appearance overrides remain explicit choices. Appearance previews use the same scope resolver as
  saved avatars; absent/undefined traits never erase inherited choices. Swatches and the custom
  colour input share the theme-adjusted palette. Desktop validation returns sparse overrides.
  `electron/avatarPalette.ts` is the single indexed palette for the picker and desktop validator;
  keep existing indices stable when extending it so saved choices keep their meaning.
- A rail process marker means that chat has programs running on its host, using the same
  `session.processes` summary as the composer's Processes tray. It is not connection status.
- Approval actions say Allow and Switch to YOLO mode, alongside Deny. The shared `YoloLabel` is the
  mode's shield/word treatment. YOLO delegates all tool approvals for that conversation.
- Adding a provider, by key or sign-in, offers a choice to keep or change the instance's default
  model. Credentials never select a replacement model implicitly.
- Sign-in succeeds only when Kiln reports completion after saving the credential. A missing login
  can mean a restart or a forgotten failure; never treat a 404 as success. Each dialog attempt owns
  its polling lifetime so an old response cannot replace the current code or result.

## Background threads (1.18.0 / Kiln 1.9.0)

- New Kiln workers default to `delivery: thread` in `hearth.sessions`. A final result stays in the
  result document and worker transcript; `hearth.thread-result` records only identifiers/status and
  evidence references. Existing delivery-less entries retain the legacy report contract.
- `session wait` subscribes to task versions and returns `control.terminate`, releasing the foreground
  instead of polling. `threadSupervisor.ts` admits an internal metadata notice only after the
  foreground and human inbox clear; notice submission and receipts are atomic. Failures, stops and
  blockers are prioritized; a retrieved result cannot trigger a later completion delivery.
- `session results(name?)` returns bounded outcomes plus source links and records retrieved versions.
  `session read(name,cursor?,since?)` pages bounded raw evidence and does not consume final results.
  Retrieval, verification, incorporation and human read marks are separate concepts.
- The composer shelf says Threads and shows running / needs-you counts. `/threads/<id>` Markdown
  links resolve through a column-scoped `ThreadLinkContext` to known descendants on the same host;
  unknown targets render as text. Internal notices and completion events never become visible
  transcript messages or unread targets. Ultra delegator uses durable continuations and permits
  small foreground decisions; it does not demand delegation for every action.

## Workspace connection (1.16.0)

- The rail displays older entries above newer entries and pins the current chat beside the input
  on desktop. `workspaceConnection.tsx` owns the measured geometry shared by LeftRail and ChatView:
  the active column reports its real footer height and input centre through ResizeObserver, so the
  rail’s dock aligns through textarea growth and attachments. Trays, comments, side questions and draft options sit in a separate section above the measured composer band; opening them never enlarges the agent/input row. Inputs remain in
  their session’s ChatView DOM; drafts, focus, drag/drop and split columns retain their boundaries.
  Mobile keeps the identity inside the composer and the rail retains its complete session list.
- `AvatarTransitionContext` enables identity movement only within the rail’s LayoutGroup. Blob
  delegates this optional wrapper to AvatarTransition; transcript, reading, settings and dock-icon
  renderers never participate. Shared ids use the full instance/session key. RailItem immediately
  makes exiting rows inert and aria-hidden while their visual handover finishes. The active dock
  keeps session actions in its context menu and renames on double-click; no “you’re talking to” label.
- Agent prose has no bubble fill or wrapping border; user bubbles remain. `conversationFontSize`
  is a persisted, validated whole-pixel size from 12–20, default 14. The CSS variable
  `--conversation-text-size` reaches transcripts, reading sheets and composer text; toolbar and
  metadata sizing stays independent. Settings → General contains the control and a live preview.

## Packaging

- `scripts/build-binaries.mjs` builds Kiln and standalone Tinder with platform-correct executable
  names. Windows resources must contain `kiln.exe`; the launcher resolves that exact name.
- `models.ts` registers `registerBunOAuthFlows()` before creating providers. Keep this registration:
  SDK variable imports cannot load OAuth modules from standalone binaries. `tests/packagedOAuth.test.ts`
  compiles and runs a complete offline device-code exchange from an empty directory.
- `.github/workflows/windows.yml` builds installer artifacts and runs `playwright.packaged.config.ts`
  against the packaged executable, with a fresh profile and its own bundled Kiln.

## Commands

- `bun run dev:blobs` — standalone blob review at `http://127.0.0.1:5181/blob-gallery.html`.
  Uses the production React renderers for all styles/states without a bridge or account data.
  Three seeded examples per style keep distinct shapes and colours consistent across states;
  `blobGalleryExamples.ts` owns their identities. Custom colour applies to all three.
  Gesture previews reset CSS animation phases; do not detach them into script-controlled animations
  that could survive reduced-motion settings. `blob-gallery.html` is dev-only, outside the app build.
- `bun run dev` — build renderer + electron, then launch Electron.
- `EMBER_DATA_DIR=<dir> bun run dev` — run this build side-by-side with the daily Ember as
  **Ember Canary**: it keeps its own settings, model-stats and activity log under that directory
  (the wordmark and window title say "Ember Canary"), so the two never fight over `~/.ember`.
  OpenChamber's settings are shared but read-only. Don't enable remote access on both — they'd
  contend for port 57821.
- `bun run dev:web` — renderer only under Vite with a mock bridge (`src/dev/mockBridge.ts`) so the UI
  can be exercised in a plain browser. The mock loads automatically when `window.ember` is absent.
  The default is the **pi mock** (`src/dev/mockPi.ts` — Hearth semantics); `?legacy` loads the
  OpenCode/OpenChamber mock (`src/dev/mockLegacy.ts`) that the legacy e2e suite still drives.
- `bun run typecheck` — both tsconfigs (renderer + electron).
- `bun run lint` — eslint (typescript-eslint + `react-hooks/rules-of-hooks` and `exhaustive-deps`).
  Every `eslint-disable` must carry a `-- reason`. The React Compiler rules are intentionally off.
- `bun run test` — Bun regression tests for API pagination/failures, transport security, and theme contrast.
- `bun run check` — typecheck + lint + test; run this before committing.
- `bun run build` — typecheck the renderer, build it to `dist/`, and emit electron main/preload to `dist-electron/`.
- `bun.lock` is intentionally untracked (`packageManager` pins the Bun version instead).

## Completion

- When a requested task is complete and its checks pass, commit the intended files and push `main`.
  If checks cannot run or need a live/manual pass, say so before pushing.
- **Versioning:** every shipped change bumps `package.json` `version` per `VERSIONING.md` (semver)
  and adds a `CHANGELOG.md` entry.

## Layout

- `tests/` — Ember’s Bun unit and regression tests. Keep new app tests here, not at the root.
  Run one with `bun test ./tests/<name>.test.ts`; `bun run test` discovers these and Kiln’s
  package-local tests. Browser/native tests remain in `e2e/`.

- `electron/` — main process (reads OpenChamber hosts, probes health, proxies API calls, stores
  Ember settings in `~/.ember/settings.json`) and the preload bridge. OpenChamber's
  `settings.json` is consulted on every proxied request, so it's cached by mtime
  (`readOpenchamberSettings`). The settings contract (`EmberSettings`, `BlobStyle`,
  `InstanceDefaults`) lives once in `electron/transport.ts` and is imported by main and preload;
  the renderer keeps its own copy in `src/types.ts` because the two tsconfigs have separate roots
  and main parses persisted JSON into its trusted shapes at the boundary. Opt-in remote access
  serves the app on the detected Tailscale IPv4 address at port `57821`; it requires a locally
  hashed password and uses an HttpOnly session cookie. Over that Tailscale address the page is
  served on **plain HTTP**, so it is not a *secure context*: `crypto.randomUUID` and
  `navigator.clipboard` do not exist there (they threw `crypto.randomUUID is not a function` on
  every send, 0.74.2). Renderer code must therefore generate ids with `randomId()`
  (`src/lib/randomId.ts`, which falls back to `crypto.getRandomValues`) and copy with
  `copyText()` (`src/lib/clipboard.ts`, `execCommand` fallback) — never those two globals
  directly. `tests/randomId.test.ts` scans `src/` to keep it that way. A durable activity log
  (`electron/activity.ts`, fed by `describeEvent` in `electron/eventStream.ts`) records whitelisted
  milestone events — bounded, single-line summaries only — as JSONL in
  `~/.ember/activity/activity-YYYY-MM-DD.jsonl` (mode 0600, buffered flush + flush-on-quit,
  30-day retention sweep, per-day size cap). Events now carry `id`/`at` and that optional
  `summary` on `EmberEvent`; the renderer threads them through `parseEmberEvent`.
- `src/App.tsx` — owns the data state: instances, per-instance sessions/states/models/queues,
  selection, pollers, and the send/reload/archive/permission handlers. Sessions are keyed by
  `sessionKey()` (`instanceId::sessionId`) because ids repeat across instances. A bounded in-memory
  message cache (`MESSAGE_CACHE_LIMIT`, the open-session cap plus a small margin) holds full
  transcripts; sidebar previews warm the compact summary map (`summaries`) and fold their tail into
  a transcript that is *already* cached (`mergeBackgroundTail`; never inserting one, and never
  spending a full read on a background session whose tail no longer overlaps).
  Freshness is version-based, not time-based: `transcriptVersion` records the session `updated` each
  cached transcript reflects. A column coming on screen always refreshes (`showTranscript`: tail
  when cached, full otherwise), and an on-screen column refreshes when the session list shows a
  newer `updated`. Those switch-in reads are `priorityReads`, which preview warming waits behind;
  warming also runs working sessions first.
  Transcript state is keyed by session so switching renders the cached transcript before the first
  paint while the fresh fetch runs, and it is pruned to the open sessions plus whatever the cache
  still holds, so it can't grow with every session ever shown. Session polls merge per id with the
  newer `updated` winning
  (`mergePolledSessions`), and an optimistic user bubble keeps its id registered until a poll shows
  the server's copy (`releaseReconciledOptimistic`), so neither can flicker out. Because that
  registration is indefinite, so the bubble also carries a *delivery state* (client-only
  `delivery` on `ChatMessage`, read by `src/lib/sendDelivery.ts`): `sending` while the request is
  in flight; `queued` once the server answered that it holds the message and will place it at the
  turn's next boundary (rendered "Waiting for the turn to pause", with Discard withdrawing it from
  the host); `unconfirmed` once the server says it placed the message, which is a claim and not
  proof — the transcript's echo is — so a bubble whose echo never lands says so after
  `UNCONFIRMED_SEND_MS` and offers Send again / Copy / Discard, and its pending id ages out into a
  retained `unconfirmedSends` set (`PENDING_SEND_TTL_MS`) rather than being re-appended for ever;
  and `failed` only on a definite failure (a transport error, a non-2xx response, or a refused
  submission) which offers Send again (replaying the stored `PromptInput`, attachments and all),
  Copy and Discard; `pendingInputs` in `App.tsx` is what makes those replays exact, and retained
  bubbles keep their ids registered so a poll can't drop them. Nothing else is doubted by age: a
  `queued` steer whose turn is over is decided by evidence, not a timer — the stop's own receipt
  (`POST /abort` returns `{parked, parkedText}`) and the inbox say whether the host still holds it,
  and only a message the host does *not* hold becomes "Stopped before this was sent." A stop that
  kept messages refreshes the queue at once, because re-parked items carry fresh ids. The workspace is
  `openSessions` (ordered keys) plus `activeSession`; `selected` is derived from `activeSession`, and
  a per-key `transcripts` map backs every open column. `visibleColumns` (in `src/lib/workspace.ts`)
  decides what renders: **one column, the active session**, or — with the `splitView` setting on —
  as many as fit (`MIN_COLUMN_WIDTH` 420), active first. There is **no tab strip**: a session that
  is not open is not hidden somewhere, it is simply in the rail. Closing a column (`minimizeSession`)
  removes it from `openSessions`, so the view falls back to whatever else is open, or to Home.
  `Cmd/Ctrl+1–9` activates that slot in `openSessions`.
  Startup restores the workspace or opens a recent chat. With no sessions it opens a new-session
  draft on an available Kiln after session lists finish loading; finishing or dismissing onboarding
  opens a draft too. No conversation is created until send. Selection
  prefers the included Kiln and excludes hidden or unavailable hosts (`src/lib/emptyHome.ts`).
  The transcript poll and `isLoaded` predicate cover the visible columns. Open keys are
  persisted in Ember settings and pruned when their instance or session is archived/gone
  (`pruneWorkspace`). Archiving the column being read hands over instead of exiting: with nothing else
  open, the workspace opens the next session in the rail's own order (`nextSessionAfterArchive` in
  `lib/projectGroups.ts`, captured before the archive bumps `updated`), skipping workers and archived
  rows and preferring a non-minimized tab; a genuinely empty rail still goes Home. The rail lists active
  sessions only; archived ones are collected into
  `archivedSessions` behind the rail's archive screen, and a project's `+` seeds the new-agent
  draft with `newSessionDirectory`. Ember keeps one project in the workspace at a time: `openProject`
  opens exactly the sessions its card showed (most recent as columns, the rest as tabs, so
  out-of-window/archived sessions in the same folder don't leak in) and `openSession` replaces the
  group when the session belongs to a different project, so two projects' columns never mix by
  default.
- `src/hooks/` — concerns pulled out of App: `useFeedback` (error banner + retry, notice toast,
  live-region announcements), `useEmberSettings` (optimistic writes to main with revision guarding),
  `useMessageQueue` (the server-owned queue handlers, see Notes; every handler takes an explicit
  `QueueTarget` so one hook instance serves all columns), `usePoll` (run-then-wait loop with a
  variable interval), `useActivity` (the activity home's data: fetched history merged with live
  event summaries, bounded and de-duped by event id), `useSelectionComments` (watches the document
  selection inside one transcript and positions the comment bar over it; `Mod+Alt+C` opens its
  reply input, so the bar never needs a mouse).
- `src/lib/` — `sessionNames` (topic + curated character from the initial human prompt, e.g. Login Locksmith; local and deterministic, set once on creation, never renaming an existing chat. Collisions preserve the topic before numbering. Unknown subjects use filtered prompt vocabulary; vague prompts use `sessionNameFallback`'s seeded tone/character vocabulary. Folder names are seed only. Tests in `topicSessionNames.test.ts` cover the active policy; `sessionNames.test.ts` covers the fallback), `useStableCallback` (pin a prop's identity for `React.memo` children),
  `messageSignature` (digest-based change detection for polls), `invalidation` (event → resource
  mapping and the coalescing `InvalidationQueue`), `projectGroups` (`buildRailEntries` grouping +
  `blobStripLayout`), `bulkArchive` (bulk-archive target selection), `workspace`, `clipboard`,
  `activityView` (pure derivations for the Home screen: live/history merge, day grouping with
  collapsed tool runs, entry → session links), `readState` (per-message marks: `through`/`ids`/`readAt`,
  compaction, prune; unit-tested in `tests/readState.test.ts`), `unreadDigest` (a card's rows: eligibility,
  excerpts cut with "…", sticky prompts, "most unread first" ordering; unit-tested in
  `tests/unreadDigest.test.ts`), `sharedLinks` (link kind/title/de-dup for Home's right column), `piMapping` (Hearth wire → Ember
  shapes; unit-tested in `tests/piMapping.test.ts`), `endpoints` (Hearth endpoint id derivation,
  URL normalization/validation, upsert/remove, token masking; unit-tested in
  `tests/endpoints.test.ts`), `pendingCreate` (the draft's messages and notes, held while its session is
  created; pure transitions, unit-tested in `tests/pendingCreate.test.ts`), `newSessionFailure` (why a
  create failed, in a sentence that names the host and the next step; unit-tested), `crew` (coagent
  helpers: `isWorker`, `crewByLeader`, transitive
  `leaderNeedsInput`, `crewDepth` and `blockedWorkersUnder`/`blockedWorkersAmong` (which workers are
  blocked at any depth), `workerStateLabel`, `promotionNameFor`, and the `[crew] …` report parser;
  unit-tested in `tests/crew.test.ts`), `gallery` (renderable-image detection, a message's image gallery,
  and the zoom math; unit-tested in `tests/gallery.test.ts`), `activityLabel` (the live activity line's
  wording; unit-tested in `tests/activityLabel.test.ts`), and `sessionStatus` (the transient
  activity status line's derivation: working / waiting on crew / needs your reply / nothing;
  unit-tested in `tests/sessionStatus.test.ts`).
- `electron/eventStream.ts` — SSE client for the two per-instance streams (see Data freshness).
  It parses frames, keeps only `{ instanceId, type, sessionId?, directory? }`, and reconnects with
  jittered backoff; main fans hints out to windows (`ember:event`) and to `/remote/events`.
  Each subscription has a connect-phase deadline (a blackholed connect can't stall the read loop
  forever) and a byte-silence stall detector, plus `restartAll()` for system resume. Recovery is
  layered: a 60s watchdog re-probes every instance so an `unreachable` verdict self-heals (probe
  results broadcast only on change), and `powerMonitor` `resume` bounces all sockets and reprobes
  immediately; the renderer also reprobes on `online` and after a failed session reload.
- `electron/piClient.ts` — the Hearth transport for the pi transition: endpoints come from
  Ember's own settings (`piEndpoints`:
  `{ id, label, url, token }`), every request carries the endpoint's bearer token, and each
  endpoint's conversation event streams + task graph become `pi:<event>` invalidation hints on
  the same `ember:event` channel — REST stays the source of truth, so pi hints carry no
  payloads beyond the bounded `summary` milestone types contribute to the activity log
  (`describePiEvent`). The instance list merges pi endpoints as `kind: 'pi'` records (probed via
  `/health`), the 60s watchdog re-syncs the watch set, and sockets reconnect with jittered
  backoff that is forgiven only by a **stable** connection (15s up), never by an accepted socket —
  an accept-then-close host used to be retried at the base delay forever (`electron/streamBackoff.ts`,
  unit-tested; the incident is Ember 0.71.1 / Hearth 0.36.0) — and a reconnect re-snapshots by design.
- `src/api.ts` + `src/piApi.ts` + `src/lib/piMapping.ts` — the api layer dispatches per
  instance kind (`isPiInstance`, remembered from `listInstances`), so App is wire-agnostic:
  OpenChamber instances keep their REST paths, Hearth conversations ride `piRequest` and map
  through the pure mappers (conversations→sessions, entries→transcript with tool-result
  merging, a live-slot status for running tools, approvals→permission cards, parked
  questions→question cards, models→catalogue, inbox→queued messages). Hearth's in-flight
  generation (`pi.live.generation.message`) maps to a trailing `live` assistant message, so the
  reasoning streaming into a turn renders; `reconcileTranscriptTail` carries it over a bounded
  tail read (which never returns the live doc) until a settled message for that turn lands. An
  assistant entry that only reasoned is still a message: the mapper keeps any entry with parts,
  so a step cut short can't drop the block the user was reading. The queue is wired for pi:
  `GET /queue` aggregates each conversation's inbox, so queued follow-ups render, reconcile with
  Hearth's submission ids and can be withdrawn (`submissions/:id/abort`) or sent now as a steer.
  Steers are in that list too (`mode: "steer"`, labelled "Waiting for the turn to pause"): they are
  real inbox items the host holds, and leaving them out made a parked steer invisible and
  unwithdrawable. Only followed-ups are offered send-now/edit/merge/park — a steer is withdrawn, not
  re-dispatched — and `queue` rows that are steers never count as "the queue is not empty" for the
  composer's queue mode or its landing spinner. A submission that comes back `status: "placed"`
  adopts no queue row: it is running, not queued.
  Reordering works via Hearth's `PUT /conversations/:id/queue/order` (the inbox is ID-ordered, so the server withdraws and
  re-submits in the new order — fresh ids). A busy submit always comes back `status: "queued"`,
  so App reads the submission `mode` to tell a steer (`Alt+Enter` / send-now — keep the optimistic
  bubble, land it at its boundary) from a follow-up (drop the bubble, show the queue row). Server-side
  auto-accept is wired too: Hearth
  carries each conversation's `autoAccept` flag on its summary, so the YOLO toggle reads and
  writes the policy. Scheduled tasks are wired too: Hearth exposes a due-times doc at
  `GET /scheduled-tasks`, mapped into the rail's scheduled view (project derived from the task's
  `cwd`, last run bound by session), with run-now and model edits dispatching to Hearth. Images are
  attachable (send, queue and steer alike): `piInputContent` turns an attachment into a pi-ai
  content part, and anything that is not an image is refused by name since the agent reads those
  from its own workspace.
  Endpoints are managed in Settings → Instances (`src/components/EndpointsSettings.tsx`
  + `src/lib/endpoints.ts`): add/edit/remove, masked tokens, a live status from the instance
  list, and a Test probe through `piRequest`. Values are user config in `settings.piEndpoints`
  — never code — so the feature is safe for a public repo; main resolves a just-added endpoint
  on demand so a probe works before the next instance sync.
- `src/components/ReadingSheet.tsx` + `SheetMessage.tsx` — the **reading view**: one session's unread
  messages, whole, in a dialog over a blurred Home (`DialogContent`'s `overlayClassName` is what blurs
  it). It grows with the message up to `max-h-[min(88vh,900px)]`, so a one-line reply gets a small
  sheet rather than an empty 900px box, and it is `min(94vw,1100px)` wide with the prose at a 780px
  measure (`sm:max-w-none` is required — the dialog primitive's `sm:max-w-lg` otherwise keeps it
  512px). `SheetMessage` renders one message the way a reader needs it —
  Markdown prose (the same renderer as the transcript), reasoning folded, one line per tool with its
  output behind a disclosure, images in the shared viewer — and no virtualizer, footer or pin
  affordances. The header says where you are ("1 of 4 unread"), **Mark all read** clears the session
  and **Mark read** marks the message you just read and moves to the next; `j`/`k` move, `x`/Enter
  mark, Esc closes. Nothing is marked on open or on render. A pending approval or question is a card
  that hands over to the conversation (`Open conversation`), because it is answered, not read. A
  session with nothing left says **You're caught up on …** and offers the next unread session. The
  messages come from `loadMessageAppend` since one entry before the mark (else a 32-message tail),
  loaded once per open — never on every mark, and never a full transcript.
  **Comments can be drafted here** (selection → the same `SelectionCommentBar`; a tray under the
  message). Drafts are written to
  `commentMemory` under the session's composer key, the same entry the conversation's tray reads, so
  closing the view hands them over unsent; `commentDraftsVersion` makes an already-mounted column
  re-read them. **Sending from here** is the tray's **Send N comments**: `sendReadingComments` resolves
  the target from `readingSession` (never the selected column) and the model from the session's own last
  model, else the instance default; with no model loaded it refuses with a reason and the drafts stay,
  and a failed send keeps them too. **Notes** can be
  parked here too (`Note` in the footer → a one-line field → the session's `For Later` card, via the
  app-level `handleSaveNote`), which needs no model and no send. **Open conversation** is an icon in
  the sheet's header, so the footer stays one line.
- `src/components/ChatView.tsx` — the transcript shell and composer. Text, model, reasoning variant,
  attachments, and reply context are kept per session; the one-line textarea grows to a
  capped height and failed sends restore the draft. Draft text and model choices persist
  across restarts (including choice-only drafts), while attachments and reply context stay in memory.
  Files attach through the paperclip, by dropping them anywhere on the column (a depth-counted
  "Drop to attach" overlay; the drop activates that column), or by pasting them into the textarea —
  all three go through `addFiles` and its **12 MB per file / 18 MB total** limits — Hearth's own
  ceilings (`MAX_IMAGE_BYTES`, `MAX_TOTAL_IMAGE_BYTES` in `hearth/src/view.ts` and `images.ts`), not
  Ember's taste: going higher would replace Ember's clear "skipped, too large" with a host refusal after
  the upload. An attachment is stored as base64 in the message, so a 12 MB image costs ~16 MB of that
  conversation's history; downscaling is the change that helps big images, not a bigger cap.
  `ProjectPicker.tsx` and `QueuedMessageList.tsx` are lazy children; the queue list is keyed by
  session so its per-item UI resets on switch. A new agent is a *draft*, not a dialog: with
  `newSessionInstanceId` set and no session selected, the composer is live under key
  `new::<instanceId>` with an instance/project/folder row above it, and the first send calls
  `onCreateAndSend`. **The message is on screen before the session exists.** An attempt is App state
  (`pendingCreates` + `draftPendingId`, `src/lib/pendingCreate.ts`) rather than a `transcripts` entry
  under a placeholder key, because a create outlives the pane (pressing × or opening another session
  does not tear it down) and a placeholder key would have to be taught to every keyed store — and
  could leak into saved settings. The draft renders the attempt as a normal transcript
  (`pendingCreateMessages` → `ChatView`'s `pendingCreate` prop) with the usual delivery states:
  `sending` while the host has not answered, `failed` with **Try again / Copy / Edit** when it
  refused (the reason is phrased by `src/lib/newSessionFailure.ts` from `SessionCreateError`'s
  status, so it can say which side failed). Once the create answers, `sendTo` inserts the real
  optimistic bubble and the pending entry is dropped in the same tick, so the handover has no empty
  frame; messages (and notes) typed while it was out follow in order. Leaving the draft does not pull
  the reader back — a session that started meanwhile gets a notice with **Open**; a refusal gets the
  banner with **Show**, which returns to the pane. A retry asks the rail first: a conversation with
  this attempt's folder and derived title, no entries, and not in the list the attempt began from is
  adopted rather than created a second time (a dropped answer may still have created it). Folder,
  model/variant and YOLO are prefilled from
  `src/lib/newSessionDefaults.ts` (folder: saved default → last-used on that instance → last-opened
  project; model/variant: saved default → server default — the last session's model is deliberately
  ignored, so a one-off image model can't hijack every new agent) until the user edits them;
  switching instance re-seeds. The draft's
  centre blob resolves through `resolveDraftIdentity`, so it previews the destination project's
  colour/override and follows the folder picker before the session exists. The header shows the
  instance and the session's folder (its cwd basename, full path on hover) as badges. The header's
  **eye menu** (`ViewMenu.tsx`) is the single home for display choices: Show / Expand thinking
  blocks (independent switches — visibility and default-open, where the old control was one
  3-way cycle), Show question & answer blocks, Show tool use (the old `hideToolCalls`), Expand tool
  calls, Show message details, Show avatars in transcript, Compact spacing, Compact rail, and Follow
  new content while streaming — plus Reset to defaults. Each persists as a setting; the eye is
  struck through when something is hidden. It replaces the top-bar View options dialog
  (`ViewOptionsDialog.tsx` is gone). Pressing
  Up on an empty composer recalls the last message the user sent, Alt/Option+Enter skips the
  busy-session queue and steers the running turn (`steer: true`), and Cmd/Ctrl+Enter saves the
  draft as a note. The header shows a stop button while the session is busy; pressing it marks the
  session idle at once and renders any in-flight step as `[step interrupted]` (`handleAbort` in
  App), then reconciles when Hearth's abort or its `run_end` event lands — a second press can't be
  lost (the button is a spinner until then). A context-usage
  cost badge beside the folder reads `crewCostState(crewCostOf(…))` (`src/lib/crewCost.ts`) — the
  session's own ledger **plus every worker below it, at any depth** — because Hearth sums one
  conversation's usage and a worker is another conversation: measured, a leader showed $1.07 while its
  17 workers held $3.87. A `+` on the total means some turns in the family were unpriced (the tooltip
  says it is a floor); nothing priced anywhere still reads "Cost unknown". The crew strip deliberately
  shows no per-worker number.
  ring (`ContextMeter.tsx`) shows the last turn's tokens against the selected model's window and
  compacts the session on click (`POST /api/session/:id/compact`); while a compaction is in flight
  it shows a "Compacting context…" spinner driven by the summary's `compacting` flag (not just the
  request), so the pending state is visible until the summary lands. The host answers `202` even when
  there is nothing to compact and then posts nothing at all, so `handleCompact` watches that flag
  for ~2s and, if it never appears, says **Nothing to compact — the recent turns already fit**
  (`src/lib/compaction.ts`, pure and tested). Every attempt also writes one line to
  `<userData>/ember-compact.log` (`electron/compactLog.ts`, mode 0600, bounded) with the outcome,
  whether the flag was ever seen, and the transcript's size either side. Beside it sits a `?` button
  (`Ask a side question`) that opens a one-line input to ask a side question (`POST /conversations/:id/btw`):
  Kiln forks the conversation into a hidden `Aside #N` worker carrying the leader's full context,
  runs the question there without interrupting the leader's turn, and reports the answer back as a
  "Side question" card in the leader's transcript. As a workspace column it shows minimize and archive controls in the
  header (`onMinimize`/`onArchive`; × archives through App's `requestArchive`, which routes busy,
  queued or input-blocked sessions through `ArchiveSessionDialog.tsx` first and always offers
  Undo — it never sends an abort), and calls `onActivate` on pointer-down so the active session
  (and the rail's row highlight) follows the column the user is working in. The active column's
  header is tinted (`data-active`); rail blobs show an underline while their session is a column
  (`visibleColumn`/`visibleKeys`), so two open panels means two underlines. Double-clicking the
  header title renames the session on its instance (`PATCH /api/session/:id` `{ title }`; the
  local copy bumps `updated` so a stale in-flight poll can't revert it).
- `src/components/CrewStrip.tsx` — **coagent crews**. Hearth leaders (the default; a session
  with `delegates`) spawn `kind: "worker"` conversations with `lead`; those workers are hidden
  from the rail, search, archive screen and palette, and surface only in the shelf's **Threads** tab
  above the leader's composer. The strip is **chips and no card**: one wrapping row of filled,
  borderless chips (blob + title + status + needs-input/`auto` badge) with a `role="group"` for
  the accessible boundary. It used to be a bordered card around bordered chips — the "chip in a
  card" report — and then a bordered strip of bordered chips; both are gone, and the shelf owns
  opening and folding, so the strip draws no fold control and never collapses itself. Clicking a
  chip opens the worker as a **transient column** — live while open, never persisted (the workspace-save effect drops worker keys). Because the strip is
  the only place a worker is visible, it also carries a row for every worker blocked on the human
  **below** the direct crew, at any depth (`blockedCrewByLeader` in App, one `blockedWorkersUnder`
  per leader), marked with its depth and opening the conversation that is actually waiting — a
  sub-agent's question used to be invisible until you opened the worker above it. Workers that are
  not blocked stay hidden, exactly as before. `App.tsx` derives
  `crewByLeader`, rolls a worker's `needsInput` up its `lead` chain to the leader's mood, and
  warns through `ArchiveSessionDialog` before a cascade archiving stops a working crew. The
  `[crew] …` wake Hearth sends at quiescence renders in `Transcript` as a "Crew report" card
  (`src/lib/crew.ts` parses it), not as a user bubble. A worker can be promoted to an
  addressable **peer** from **its own session's header** — a labelled "Promote to peer" button next
  to the title (`PromoteWorkerDialog` → `promoteSession` → Hearth's
  `POST /conversations/:id/promote`): Hearth forks it, the peer appears in the rail, and the strip
  row becomes a peer link off the worker's `promotedTo`. The header is the only place the role is
  known: a worker's conversation summary does not always carry `kind`, so `ChatView.promotable` also
  accepts "this conversation appears in my leader's crew list" (that is what the strip is drawn
  from). The icon-only control that used to sit in the header guarded on `session.kind` alone, so it
  never rendered for a real worker — there was no way to promote anything from the UI for ~20
  versions until 0.82.0 put it back, labelled. Registration itself is automatic as of 0.82.0 (see
  `hearth/src/agents.ts`), so promotion is now only for making a worker *openable and top-level*,
  not for making it addressable.
- `src/components/ImageViewer.tsx` — the **image lightbox** (`imageViewerContext.ts` provides it;
  `App.tsx` owns the one instance and renders it above the columns). Any transcript image is a
  button: `ToolImages`/`FileBlock` in `Transcript.tsx` and `Markdown.tsx` prose images open it
  through the context. Wheel/pinch zooms toward the cursor (1×–8×), drag pans when zoomed,
  double-click toggles fit ↔ 100%, and Esc/backdrop close. The gallery is the **conversation's**
  images, not one message's (`galleryForConversation` in `lib/gallery.ts`), so `←`/`→` and the
  on-screen Previous/Next buttons — only rendered when the chat holds more than one image, with an
  `n / m` counter — cross message boundaries; a download link saves. Pure derivation lives in
  `src/lib/gallery.ts`; no second window, no IPC.
- Home and its activity/link/card components were removed in 1.7.0. The rail's unread-message
  counter opens `ReadingSheet`; conversations retain explicit per-message read controls. Activity
  milestones remain recorded by main, without a separate activity page.
- `src/components/InstanceBar.tsx` — the top bar: Ember wordmark, search, **Sessions**, **Usage**
  and **Scheduled** views, then the instances menu. Sessions opens the latest chat if no column is
  open. Error/notice toasts render inline next to search. Home is no longer a view or command.
- `src/components/LeftRail.tsx` — **three widths, one toggle** (`settings.railMode`): **mini** is a
  64px dock of session blobs (tooltip = title + latest message; no search, groups or labels),
  **normal** is the 272px rail, and **wide** is about half the window, where each row shows the latest
  message over up to three lines (`SessionRow`'s `expanded`) and a project's blob strip spreads into
  the room. The panel button in the toolbar cycles them and `Cmd/Ctrl+B` does the same from anywhere.
  The rail is a single recency-ordered list from
  `src/lib/projectGroups.ts` (`buildRailEntries`). A configured project with one active session
  renders as a plain `SessionRow` whose title is the project name (a hover `+` starts a new session
  there); a project with two or more sessions renders as a `ProjectCard`. Projects with no active
  sessions are omitted — start one from New agent. Standalone (root/chat) sessions are always
  `SessionRow`s. Cards and rows interleave by most-recent activity. Clicking a project body opens the
  whole project — see App's `openProject`; the blobs are display-only (their right-click menu still
  reloads/archives that session). The toolbar is New agent + search + the archive button. **A
  scheduled run is an ordinary session** — it lives in the list like any other, with a small calendar
  mark beside its title whose tooltip says "This was triggered by a scheduled task." and names the task
  — while **plans** and run history live in the Scheduled tab, without a duplicate section in the rail.
  Scheduled counters use the same message marks as the rail, never a visit/startup timestamp.
  Opening an archived run from Scheduled restores its conversation. New output after an older host
  reused an archived scheduled conversation appears unread; archives after the latest output stay
  respected. There is no scheduled rail *mode* any more (0.78.0):
  a clock toggle used to swap the whole list for the latest run of each task, which hid the sessions
  the person was working in. Search is scoped to the rail by default; when it comes up empty it offers
  "Search all time" and "Search archived sessions", the latter listing archived hits as individual
  rows under an Archived heading (clearing the box resets the scope). Empty configured projects also
  appear in search results when their name or path matches, listed after projects that have sessions.
  The selected session is pinned into the list even when filters hide it. Above the sessions, one
  dashed row per host that is not answering names it and offers **Retry** and **Dismiss**
  (`silentInstances`/`reconcileOutageDismissals` in `src/lib/instanceHealth.ts`). Dismiss stores
  the id in `settings.dismissedOutages` and hides only the warning — that host's last-known
  sessions stay rows. A dismissal is cleared when the host answers again (`ready` or
  `unsupported`), so the next outage warns, and an explicit reprobe clears it too (asking again is
  asking again), which is the only route back once the row is gone. A host reporting
  `unsupported` is never dismissable: that is a settings problem, not an outage.
- `src/components/ProjectCard.tsx` — a multi-session project: name, `+`, and a row of 48px
  mood-carrying blobs that shrink then overflow to `+N`. Every blob carries the session title
  beneath it as a two-line chip (hard-clipped, no ellipsis), so `blobStripLayout`
  counts each item at `LABEL_WIDTH` (56px) even when blobs shrink below it. Clicking the project name/body opens the
  project; clicking a blob opens just that session; right-clicking a blob still offers the per-session
  menu. Right-clicking the `+N` chip opens a tidy-up menu ("Archive N inactive" plus "older than 1
  day / 3 days / 1 week / 2 weeks / 1 month" with counts), driven by `src/lib/bulkArchive.ts`. Bulk
  actions never touch a busy/thinking/needs-input session and share one Undo notice
  (`handleArchiveMany`). Separately, `sweepStaleScheduledRuns` in App auto-archives scheduled-task
  runs that are a day old, finished, fully read, and not open — `staleScheduledRuns` in `bulkArchive.ts` picks
  the targets, retry attempts are throttled per session, and the scheduled view still lists them
  via `scheduledSessionBindings`. The `autoArchiveScheduledRuns` setting (default on) gates it.
- `src/components/SessionRow.tsx` — the shared full session row (55px blob, title, preview,
  instance/project line, archive button, context menu) used by the rail and the archive screen.
  Optional `titleOverride`/`topMeta`/`onNewAgent` turn it into the one-session project row (project
  name as the title, instance above it); the rail passes a `topMeta` header
  (`project/folder · instance`) so every entry is labelled like a project card. Memoized; the
  timestamp is a self-ticking `RelativeTime`. Archive/restore is decided per row from
  `session.archived`; a row whose session has pins gets a small pin badge on its blob. When the row
  is the latest run of a scheduled task it also gets a hover play
  button and menu entries to run the task now or change its model and run: App resolves the task
  through `scheduledSessionBindings`/`scheduledTasksByKey`, `runScheduledTask` re-runs it server-side
  and `updateScheduledTaskModel` replays the task's own JSON with a patched `execution`.
- `src/components/ArchiveDialog.tsx` — the rail's archive screen (`archivedSessions`): every
  archived session as an individual row, newest first, with restore. Opened from the rail toolbar's
  archive button.
- App remembers each project's open order and active session (`projectLayoutsRef`) so leaving and
  returning restores the arrangement; reopening a project always reopens *all* its sessions, so
  closing one isn't a dead end.
- `src/lib/agentDirectory.ts` — the shipped half of a removed view: the **Directory** page (and its
  `e2e/directory.pw.ts`) was deleted in 0.82.0 at the owner's request, and what is left is the pure
  wire → list mapping (`agentAddress`, `buildDirectoryGroups`, `directoryCount`, `hostDirectoryNote`,
  `directoryEmptyCopy`) plus `resolveAgentName`, which governs a bare name resolving only when unique
  across hosts — the rule a cross-host `send` would rest on (see `TODO.md`). `loadDirectory` in
  `api.ts` still reads `GET /directory` per host; nothing in the UI calls it today.
- `src/components/ModelUsagePanel.tsx` — the **Usage** view: every model Ember has seen reply to,
  across instances (calls, median time, throughput, provider-reported cost, reasoning levels, the
  instance split), from `useModelStats`/`summarizeUsage`. A panel rendered in the main area, not a
  dialog: `ModelUsageDialog` is gone. It counts single model turns, not whole tasks, and only sessions
  Ember has loaded.
- `src/components/CommandPalette.tsx` — `Cmd/Ctrl+K` session/note search plus new-agent commands.
- `src/components/ui/` — shadcn/ui primitives (Tailwind v4, `radix-ui`). Add more with
  `bunx --bun shadcn@latest add <name>`.
- `src/blob/` — session avatars. `Blob.tsx` switches between `BuddyBlob` (flat, soft creatures),
  `CrystalBlob` (faceted stones that light up), `MosaicBlob` (seeded pixel silhouettes with colour ribbons and square eyes) and
  `LavaBlob` (grainy lava-lamp goo, below) and `ScribbleBlob` (seeded pen strokes, tiny legs and
  dark-outlined eyes). Scribble uses bounded SVG paths without filters; idle stays still.
  Scribble turns through independent wire-bundle angles around a solid core, never an edge-on
  flattening. Every silhouette mixes sharp, round and bent tips; crossing strands texture the back.
  Scribble’s raised hand appears only for questions; working cycles through left/right/away
  glances with the same wire movement, then a stretch, on a sixteen-second timeline.
  Thinking is style-specific: Buddy leans/squashes/rises and glances, Scribble wires twitch,
  Mosaic lights stepped tiles, Lava gathers/stretches/melts, and Crystal glints through facets.
  Only Crystal uses the orbit ring; Lava keeps decision badges without an orbit. No shared thinking ring. Reduced motion disables
  all of them; idle remains still. Mosaic uses one shared pixel grid: all drawing coordinates and dimensions are whole cells, including eyes and blinks; never subdivide cells for finer details. Error eyes are three-by-three crosses of full-size cells, positioned inside each silhouette, without diagonal strokes. Its working/thinking eyes
  use whole-cell glances and occasional blinks, with longer upward looks while thinking;
  seeded CSS phases keep chats out of sync, and reduced motion leaves the eyes open.
  Stored Pip selections migrate to Mosaic.
  Gem, Critter and Glyph were removed, and stored
  settings that still name them fall back to the default. Renderers memoize on the `identity`
  object, so App hands back the previous reference when nothing changed. Buddy pupils track the
  cursor only while it's within `NEAR_RADIUS` (`usePupilTracking.ts`), and active Buddy blobs do
  squash-and-stretch hops with a per-blob occasional somersault (`blob-hop`/`blob-flip` in
  `blob.css`); the eyes counter-scale 75% of the hop so they mostly keep their shape
  (`blob-hop-eyes`). Those two wrappers are **DOM elements, not SVG `<g>`s** — Chromium composites
  a transform on a DOM node but not on an SVG child — so everything that must not move with the
  body (the mood badges) lives in its own `.blob-overlay` layer. Idle draws no
  animation at all: motion is reserved for a session that is working, waiting or failed, so a rail
  of idle blobs is static (and costs nothing). `lib/useMotionPause.ts` pauses every animation via
  `animation-play-state` — progress survives — whenever the document is hidden. Crystal draws its volume as white/black *facet planes* clipped to the
  silhouette (`coalGeometry`… now `crystalGeometry` in `blob/crystal.ts`), so shading works on every
  palette entry in both themes with no colour maths; its heat halo is the mood channel — dark when
  idle, gently warm when busy, the secondary attention accent when it wants you, cold grey when the turn failed — and each mood
  sets that halo *statically* first, so the state survives a still frame and reduced motion (only the
  swell is dropped). Notification and `?`/lock/`!` decision badges are shared by styles
  (`blob/overlays.tsx`); notification, question and lock circles share their geometry and scale with
  the blob. Visuals key off
  a `BallMood` (`blob/mood.ts`): `busy` = hop+flip (Buddy) / subtle silhouette-shaped halo (Crystal),
  `thinking` = each style’s own movement, `input` =
  wobble + padlock badge, `question` = tilt + "?" badge, `error` = wobble + warning triangle,
  `unread` = a highlight dot. App derives the mood from the ball state plus the prompt kind
  (permission vs question), whether the last assistant turn is reasoning (`isThinkingMessages`), and
  whether an idle session has a response the user hasn't opened (per-session `lastReadAt`; the active
  column is marked read). `buddy.ts` holds
  the 16 hand-drawn silhouettes (the original 8 plus teddy, sprout, puff, cat, ghost, cloud, egg and
  mushroom) plus 11 generated ones (radial harmonics + top/bottom squash, reviewed
  in `buddy-arena/`; `bun run buddy-arena`). `blob/seed.ts`
  resolves three identity channels: project/directory + instance picks colour, a scheduled-task
  binding (or session key) picks shape, and the session key picks tilt/motion. OpenChamber task
  bindings come from each project's scheduled-task endpoint and observed `lastSessionId` mappings
  are retained in Ember settings. The appearance picker scopes overrides per session/task/project
  and stores only curated colour indexes and shape names; the project/folder scope comes first and
  is its default, so customising from a session row shares the look across that project.
  Project/directory colours use a persisted 22-entry allocation queue (directory-only "projects"
  included, so distinct directories never collide on a hash), exhausting every colour before cycling;
  the queue is pruned to the sessions currently on screen (plus the selected one), so it doesn't grow
  forever. Optional per-instance underlines use a separate 12-colour marker palette.
  `crystal.ts` holds the six named archetypes the picker offers (`quartz`, `prism`, `flint`,
  `geode`, `shard`, `cluster`) plus the seeded geometry, so a session keeps its stone and
  `shapeName` stays meaningful. The 22 **identity colours** (`IDENTITY_COLORS`) are chosen in
  OKLCH by farthest-point sampling so the base entries keep a minimum OKLab distance (no HSL
  near-duplicate greens/blues). Two extra are sampled and the closest violet/magenta pair dropped, so
  the picker doesn't read as four purples and four pinks; then sorted by hue so it reads as a
  rainbow. `applyTheme` emits `--blob-0..21` after `blob/contrast.ts` adjusts the
  whole palette together — clamping each colour to ≥3:1 against the theme's panel/elev/bg while pushing
  close pairs apart, rather than per-colour clamping that collapses them onto one lightness.
  **Lava** (`LavaBlob.tsx` + `lava.ts` + `blob-lava.css`; `tests/lava.test.tsx`) is risograph-style goo:
  two or three circles run through one SVG "goo" filter (blur, then a hard alpha threshold), so they
  melt into a single body with necks and no path is ever stored. The same filter stipples a
  translucent, body-coloured rim against `feTurbulence` grain, deepens the body's own hue just inside it, and bleeds a little
  grain into the paper. Inside sit pools — a two-tone `halo` around a lighter `core`, ~110° of hue
  away, plus a soft `glow` — drawn as soft-edged **radial gradients** rather than a second blurred
  group, because a pool belongs to its lobe and has to travel with it while an SVG filter per lobe
  would repaint the blob again; being inside an opaque body they only blend colour, so the goo's
  alpha threshold never sees them. Accents come from the *base* palette entry, since they never touch
  the surface. The **last lobe is the bud**. `tests/lava.test.tsx` pins the geometry this depends on — every
  shape fits at any turn, the bud overlaps at rest and clears the goo's bridging distance at the peak,
  no pool reaches a rim. Grain frequency and rim width scale with the rendered size so both stay near a
  CSS pixel; body grain is omitted below 64px. The rim mixes the body with its deep hue through
  `--lava-rim`, using translucent ink on both themes; standalone dock SVGs fall back to that deep hue.
  Staggering uses the seeded `--lava-<part>-delay` properties, not
  `animation-delay: inherit` — the animated groups sit two levels below the element carrying it.
- **Lava is a liquid in every active state**: busy, thinking, approval and question all separate
  and reform. Body, middle lobes, bud, pools and glow run on independent periods; `--lobe-delay`
  offsets each lobe while keeping its body and colour in phase. `lavaTiming` seeds independent
  durations and phases for the body, bud, currents and pools. `lava-split` alternates partial pulls
  with full separations; `lava-flow` adds sideways translation on a separate clock, so the bead
  takes a different path on successive splits. `lava-slosh` gives middle lobes uneven inward/outward
  drift. The main body squashes/stretches while the whole goo
  drifts in translation, without rocking as one solid shape. Approval/question use slower cycles
  and keep their badges stationary; no orbit. The shared needs-input wrapper wiggle excludes Lava
  so it cannot rock the fluid body or its badge. Idle, unread, unknown and error remain still.
  Reduced motion removes every animation and keeps badges; busy retains its detached static bud.
- **A blob's cost**: one goo filter per blob, and a busy blob re-evaluates it every frame. With 4 busy
  55px blobs an idle Ember holds 60fps at 2× DPI (same as before the extra motion, because dropping
  the pool blur paid for the transforms); a pathological page of 32 busy blobs at 2× runs ~46fps and
  is still faster than the pre-gradient version was. Nothing animates when idle, so a rail of resting
  lamps costs nothing.
- `src/blob/dockIcon.ts` — rasterises the selected session's blob (via `renderToStaticMarkup`,
  with theme CSS vars inlined since an `<img>`-loaded SVG can't see them) onto a `--sidebar`
  squircle and sends the PNG over `window.ember.setDockIcon` → `app.dock.setIcon`. Driven by an
  effect in `App.tsx` keyed on selected session, its state, blob style and theme. The mock bridge
  sets the tab favicon instead. `blob/color.ts` exposes `blobColor(style, seed)` for UI that
  wants the blob's dominant colour (the transcript's activity dot uses it).
- `src/components/Transcript.tsx` — message list: text bubbles, expandable tool rows (input/
  output/diff), collapsed reasoning (opened automatically while that turn is still streaming, so the live stream is
  visible; each block remembers a manual collapse), file parts, permission + question cards,
  a **live output tail** under a *running* call (last few lines, muted, no click needed —
  `liveOutputTail` in `src/lib/toolTail.ts`; the host streams a command's output into `pi.live`'s
  tool slot, and `applyLiveToolOutput` in `src/lib/piMapping.ts` patches it onto the row an append
  read cannot carry, because that page is normally empty. It is replaced in place by the settled
  result, which the expanded body shows in full. A **failed** call keeps its whole retained output
  (the first 400 characters used to replace it), with the host's diagnostic — "Command exited with
  code 1" — as the one red line above it, the exit code as a chip on the row (`grep` exiting 1 is an
  answer, not a crash), and "Earlier output was dropped" when the host kept only the tail),
  session-named live activity line ("Habit onboarding QA · thinking", its title ellipsized, plain
  "Thinking" without one; suppressed until initial history resolves), per-message footer (model, duration,
  cache read/write, output tok/s, provider cost when the API reports one, and a self-ticking
  "x min ago" received time), a **Copy** control in the message's hover gutter at the card's top-right
  (hidden until the row is hovered or the control is focused) that copies the message's own
  **Markdown source** (`lib/messageMarkdown.ts` — fences stay fences; reasoning and tool calls are
  opt-in there because a tool output can be huge), follow-the-bottom scrolling **only while the reader is at
  the bottom**
  (`lib/scrollIntent.ts`: a scroll is the reader's only while a gesture is recent, and a delta that
  arrived with a resize is a layout clamp, never intent — without that, a growing viewport switched
  following off by itself; ResizeObserver +
  `scrollend`), and message jump/highlight support. A tool result carrying image content (the `view`
  tool, MCP screenshots) renders the image inline in its tool row — `piMapping` carries the image
  block onto `ToolCall.images`, and `ToolRow` shows it above the expandable detail. Expanding a
  thinking block stops auto-follow and
  nudges the block into view with `block: 'nearest'`, so it doesn't yank the reader to the bottom.
  The session blob lives here rather than in the
  chat header: while a turn is pending it rides the activity line below the last message, and once
  the turn is done it tucks in beside the last assistant message. A leader that is idle but still
  has workers in flight gets one extra quiet line there (`SessionStatusLine`, fed by
  `lib/sessionStatus`): "Waiting on 2 workers…". It is transient (derived, never persisted or
  logged), a polite live region, and turns nothing off or down: the composer stays live so another
  thought can be sent. The running turn keeps the existing activity line, a resting crew renders
  nothing, and a pending question or approval is left to its card rather than repeated.
- `src/components/TranscriptTimeline.tsx` — the **whisper timeline**: a thin scrub rail down the
  transcript's right edge. Marks are assistant turns, classified by
  `lib/transcriptTimeline.ts` (pure, unit-tested): `turn`, `tool` (tool runs), `failure` (turn error
  or a failed tool) and `live` (the running turn). Each mark sits at its message's fractional index,
  so the rail reads top-to-bottom as the conversation did, and clicking one runs the same
  `jumpToIndex` the find bar uses. It renders only at ≥8 marks, and long transcripts are sampled to
  ≤40 (failures and the live mark are never dropped) — at 120 the marks packed into a dashed line
  that read as a scrollbar. Each mark is a 24px button with a one-line `aria-label`
  (`Jump to 18:41 · bash failed`). Toggled by `showActivityRail` (default on, View → Layout).
- `src/lib/comments.ts` + `src/components/CommentTray.tsx` +
  `src/components/SelectionCommentBar.tsx` are **comments on a transcript segment**. Selecting text in
  a column raises a small bar beside the selection with one Comment action and three quick replies
  (Yes / No / Hold off); a chip adds the
  comment at once, Comment opens a one-line reply field (Enter adds, Escape cancels), and
  `Mod+Alt+C` does the same from the keyboard. Selections may cross message boundaries: the words
  are captured as-is (whitespace and newlines normalised), with nothing clipped to one message.
  Comments collect as transient drafts in a tray above the composer (quote plus an editable reply,
  each removable, never the server queue, never persisted; `commentMemory` keeps them across a
  column remount for the run only). "Send N comments" assembles them into ONE ordinary user
  message through the same send path as the composer (`composeCommentMessage`): numbered
  `N. Re: "<quote>"` blocks in the order the comments were made, a blank line between blocks, then
  the composer's own text once at the end, so the agent reads the referent without a protocol. A
  successful send clears the tray; a failure keeps every row and surfaces the app's error banner,
  which is why the tray sends with `retainOnFailure: false`. `shortenQuote` keeps a long
  selection to its first line or roughly 200 characters plus an ellipsis. The pure half is
  `src/lib/comments.ts`, unit-tested in `tests/comments.test.ts`; `e2e/comments.pw.ts` covers the scene.
- `src/components/ComposerShelf.tsx` + `TrayRow.tsx` + `TrayItemDialog.tsx` — **the tray above
  the composer is one shelf**, not three stacked cards: one line of tabs (`Queue 3 · For later 2 ·
  Crew 3`, each with its count, a dot when that tray wants the human), the open tray's rows under
  it, and a chevron that folds the whole thing to that one line. A tray with nothing in it has no
  tab, and folding keeps the tabs, so nothing becomes unreachable. Which tray is open is the
  person's choice; `ChatView` only brings one forward when something *arrives* in it (a queued
  message, a saved note) and opens the shelf for a crew that has just become blocked — the first
  render is a baseline, not an arrival, so opening a session never steals the shelf. Queue rows
  deliberately draw **no exit transition**: an optimistic row that the host's row replaces is a
  different React key, and `AnimatePresence` kept the removed one mounted through its exit animation,
  drawing the same message twice for ~200ms (0.77.2). A poll also drops an optimistic row when the
  served row is the same message (`sameQueuedMessage`, one local row per served row). A `TrayRow` is
  one line of text with the model muted at the end and the row's actions appearing on hover or
  keyboard focus; **no outlines anywhere inside the band**, which is what "chip in card" was about.
  Clicking a row opens `TrayItemDialog` — the whole text, read-only, with Edit as a separate button
  (the queue has no edit operation, so its editor's Save re-enqueues the row under a new id; reading
  must not be that).
- `src/components/SessionNotes.tsx` — notes parked from the composer: the shelf's **For later** tray,
  never dispatched on their own. The composer's save-as-note button (next to send) stores
  the text in Ember settings under the **session's** key (`notesKeyForSession` in
  `src/lib/projectGroups.ts`); notes used to be shared across a configured project, which meant a
  thought about one conversation surfaced in every other session in the folder. ChatView takes an
  explicit `notesKey`. Each row can send as-is, bring the text back into the
  composer (which consumes the note), or delete it; clicking the row reads it in full, as above.
  Rows carry no status dot — only a spinner while one is busy. A queued message can also be
  "parked": removed from the server queue and saved as a note.
  `PinnedMessagesDialog.tsx` shows the selected session's pinned messages in a modal, opened from
  the pin chip in the chat header; its Jump/Reply/Unpin actions reuse the transcript handlers and
  change no OpenChamber data.
- `src/components/Markdown.tsx` — assistant prose via `react-markdown` + `remark-gfm` (no raw
  HTML). A small rehype plugin reuses `Linkify.tsx`'s tokenizer to link bare local paths and
  scheme-less web addresses (`localhost:3000`, `www.…`); all anchors route through
  `window.ember.openExternal`, which prepends `http://` to the scheme-less ones. Electron main
  also opens `window.open`/new-window requests through the same helper, and the window's
  `context-menu` handler pops an edit menu (link open/copy, clipboard roles) — Electron ships
  none by default.
- `src/themes.ts` — three neutral palettes (Stone, Clay, Graphite) mapped onto shadcn CSS
  variables; `applyTheme` toggles `.dark`. `--primary` is derived from the text colour so
  buttons stay neutral, while each palette's softer `userBubble` neighbour keeps chat calm. The
  main accent is `--highlight` (Tailwind `highlight`), reserved for indicators: activity dot,
  focus ring, selection ticks, "Needs input", question cards, the wordmark. Permission cards keep
  semantic amber. Blob question/lock badges share a stronger secondary `--attention` accent with
  `--attention-foreground` symbols; error badges use `--destructive-foreground`. Clay uses mint
  attention badges with black symbols and rose-red errors, distinct from its orange main accent.

## Data freshness

Events drive invalidation; REST stays the source of truth. Nothing in the UI is ever built
from an event payload — with one bounded exception: whitelisted milestone events carry a
capped, single-line `summary` (`describeEvent` in `electron/eventStream.ts`), which is the
activity log's content and rides the same `EmberEvent` hint. Streaming chatter never gets one.

- Main subscribes each attachable instance to OpenCode 2's `/api/event` (sessions,
  messages, status, permissions, forms; frames are `{ type, location: { directory }, data,
  durable: { aggregateID } }`) and OpenChamber's `/api/notifications/stream` (`openchamber:*` —
  auto-accept policy, scheduled tasks; frames are `{ type, properties }`). Payload bodies are
  dropped in main.
- The renderer maps a hint to REST resources in `lib/invalidation.ts` (`session.status` →
  states; `message.*` → the open transcript if it's that session, else the session list;
  `permission.*`/`question.*` → their list plus states; and so on) and pushes them through an
  `InvalidationQueue` that coalesces bursts to one refetch per resource per ~250ms — a streaming
  turn emits a `message.part.updated` per token. One "refresher" per resource in `App.tsx`
  (`refreshSessions`, `refreshStates`, `refreshMessages`, …) does the fetch and merges into state;
  timers call the same functions.
- Polling is the safety net, per instance: while an instance's OpenCode stream is live it polls
  slowly (states 30s, sessions 60s, open transcript 20s, scheduled tasks 5min); without a stream
  it polls fast (3s / 10s / 3s / 30s). A stream (re)connecting triggers a catch-up refetch of
  everything for that instance, since hints were missed while it was down. The instance menu shows
  `live` vs `polling`.
- Bridges without `onEvent` (an older remote server) simply stay on the fast cadence. The mock
  emits synthetic hints for `local` only, so both paths get exercised in `dev:web`.

## Notes

- Vite config is `vite.config.mts` (ESM) because `package.json` has no `"type": "module"` — the
  electron build needs CommonJS.
- Animations: `motion` for layout/reorder, `tw-animate-css` for Radix enter/exit.
- Errors name their layer: the transport's own 20s deadline reads "… (Ember → OpenChamber)", other
  request failures are prefixed with the instance label, and OpenChamber/OpenCode/provider messages
  pass through with their text (`proxyApiRequest` in `electron/main.ts`;
  `responseError` in `App.tsx`).
- Archiving is OpenChamber-owned in v2: `POST /api/openchamber/sessions/archive` /
  `.../unarchive` with `{ ids: [...] }` (the proxy folds `time.archived` back into session
  records). Sessions load from `/api/session?location[directory]=…` (OpenChamber drops the
  archived filter — the list includes archived rows, split client-side on `time.archived`),
  paginated through the opaque `cursor.next` query param. Archiving offers undo through the
  local notice toast.
- Busy-session queueing uses OpenChamber's server-owned queue: `GET /api/message-queue`, enqueue with
  `POST /api/message-queue/sessions/:id/items` `{ directory, item }`, remove with
  `DELETE /api/message-queue/sessions/:id/items/:itemId`, reorder with
  `PUT /api/message-queue/sessions/:id/order` `{ itemIds }`, and take the full payload for immediate
  steering with `POST /api/message-queue/sessions/:id/items/:itemId/take`. Queue items require a
  concrete `sendConfig` (`providerID`, `modelID`, optional `agent`/`variant`); Ember resolves the
  instance default before queueing. Each row shows its assigned model/variant as plain text (the
  per-item model change was removed). The
  server dispatches items once the session is idle, while Ember's per-item send-now action takes
  the item and sends it directly so it can steer the active turn. Enqueueing is optimistic: the row
  appears at once with a loader (`pending`), a failed enqueue keeps it with the error plus
  Retry/Cancel, and `mergePolledQueues` folds those local rows back into each polled snapshot.
  Editing and merging exist only Ember-side: the queue has no edit, so `replaceQueued` in
  `useMessageQueue` enqueues the new text FIRST and only then removes the row(s) it replaces, and
  puts the new item back where the survivor sat. A failure therefore leaves a visible duplicate
  rather than losing text. `src/lib/queueMerge.ts` is the pure half (blank-line joining, the
  upper/first item as the leader for mode/model/variant, the position math); the edit dialog is
  `EditQueuedMessageDialog.tsx`, "Merge up" sits on every row from the second onward, and
  "Merge all queued messages" appears under the list past three rows.
- "Recent" models in the composer are derived from the instance's own sessions (`session.model`
  from the list endpoint, newest `time.updated` first) — nothing is stored on the Ember side. The
  catalogue itself comes from `loadModels`: `GET /api/model` is a flat `Model.Info[]` list
  (each entry `{ providerID, id, name, variants?, … }`) and `GET /api/model/default` the
  configured default `{ providerID, id }`.
- Permissions: `GET /api/permission/request` lists pending requests (`{ items: [...] }`);
  replies are session-scoped: `POST /api/session/:sid/permission/:pid/reply`
  `{ reply: once|always|reject }`. The directory hints still cover the selected session, every
  open column/tab, and any directory named by a prompt event (`directoryHintsFor`), plus every
  directory that already holds a pending prompt, so a background column's prompt still resolves.
  OpenCode 2 replaces the question tool with *forms*: `GET /api/form` lists pending forms,
  `POST /api/session/:sid/form/:fid/reply` `{ answer }` (a keyed map coerced to each field's
  `valueType`), `DELETE /api/session/:sid/form/:fid` cancels. Sessions with a pending request of
  either kind are forced to the `needs-input` ball state — `/api/sessions/status` only reports
  its own tracker and `/api/session/active` the running set.
- Unread is per message (`settings.readMarks`, see Home above), so the `unread` mood means "this
  session has a message you have not marked read" — not "its `updated` moved since you looked".
  Opening a column is not reading it.
- Ball states: `/api/sessions/status` never says "error", so `error` is derived from the
  transcript: an idle session whose last message is an assistant turn with `error` set (and not
  `aborted`, i.e. a user stop) is failed. That's tracked in `failedKeys`, updated wherever
  messages enter the cache, so it covers the open session and the previewed ones. Priority is
  needs-input > active > error > idle. `needs-input` draws an orbiting ring (`blob/OrbitRing.tsx`,
  offset-path + opacity only; the marker passes behind the body via a back/front split).
- YOLO mode (`bypass` in the settings schema, kept for compatibility) is OpenChamber's server-side
  permission auto-accept: `GET /api/permission-auto-accept` → `{ sessions: { id: bool } }`,
  `PUT /api/permission-auto-accept/sessions/:id` `{ enabled, directory }`. The server answers
  prompts itself, so it works while Ember is closed and matches what OpenChamber shows as
  "Permission auto-accept". The policy is polled with the 10s session poll. Instances that 404 the
  route are marked unsupported and fall back to a local override plus Ember auto-replying `once`
  while the session is selected; with server support that client loop is skipped to avoid racing.
- Sending is a sequence in OpenCode 2: sticky session settings first (`POST /session/:id/model`
  `{ model: { providerID, id, variant? } }` and `/agent` `{ agent }`) — a refusal fails the send
  rather than silently falling back — then reply/queued context as `POST /session/:id/synthetic`
  `{ text, metadata }` items, then `POST /session/:id/prompt` `{ id?, text,
  files: [{ uri, name }], agents: [{ name }] }`. Stop is `POST /api/session/:id/interrupt`,
  compact `POST /api/session/:id/compact`, fork `POST /api/session/:id/fork`.

## Workspace reliability and performance

- `bun run test:e2e` runs Playwright against `dev:web`. Install its pinned Chromium with
  `bunx --no-install playwright install chromium` (the project pins `@playwright/test` 1.55.1 —
  run the CLI through `node node_modules/playwright/cli.js` if `bunx` pulls a newer standalone).
  Tests use `.pw.ts` so Bun's unit runner does not collect them. `e2e/home.pw.ts` covers the Home
  surface — no rail, a card per session and a row per message, the dot marking exactly one message
  (and surviving a reload), opening a session marking nothing, right-click Mark all as read on both
  Home and the rail, ordering, sticky requests and the counter. The pi mock keeps read state in
  `localStorage` (`ember-pi-read-state`) and only read state, so a reload behaves like a relaunch
  without letting any other fixture leak between runs. The default mock is the pi
  mock (Hearth semantics); the legacy OpenCode suites carry `?legacy`, and `e2e/pi.pw.ts`
  covers the pi slice (rail, transcripts, sends, the approvals and questions cards) with
  `e2e/queueMerge.pw.ts` covering queue editing and merging. The
  legacy mock also serves the activity home: a fixture history paged 10 at a time (so "load
  earlier days" is exercised) and milestone hints carrying `id`/`at`/`summary` for live
  appends; `e2e/activity.pw.ts` covers Home's collapsed Activity section, the Home toggle, and entry
  links.
  `?fixture=performance&noDock` supplies 85 sessions and a 10,000-message transcript;
  `&slowInstance` holds the second mock instance until `releaseSlowInstance()` is called, and
  `?outage` adds a second endpoint that is down, which is the only way to see the rail's
  "Not answering" row in a browser (`e2e/outageDismiss.pw.ts`).
- `bun run test:native` builds production assets and runs the `.native.ts` Playwright suite against
  the real Electron main/preload and authenticated remote router. It isolates HOME, Chromium profile,
  and OpenChamber settings in a temporary directory and uses a loopback upstream fixture; it never
  operates on real sessions. Requires a GUI-capable environment (validated on macOS). Remote tests
  bind the router factory to loopback; production `startRemoteServer` remains Tailscale-only. This
  covers IPC, disk persistence, production CSP/assets, remote cookies and shared drafts,
  but not real Tailnet connectivity or a packaged/notarized distribution.
- Composer persistence uses per-key `composerDraftChanges` (null deletes), not replacement snapshots.
  `composerMemory` retains transient attachments/reply context across column unmounts. Settings writes
  are serialized in both renderer and main; failed draft patches remain optimistic and retryable.
  Sending or saving a note clears content but retains a choice-only draft with the selected model and
  reasoning level. New-agent creation transfers that choice to the created session. Restore choices
  before paint, independently of session-list metadata. `modelSelection.ts` resolves concrete IDs by
  exact match: absent models/effort levels block composer sends, queues and note sends without changing
  the selection. Only the `default` sentinel delegates model choice to the server. Hearth's `off`
  level (`REASONING_OFF`) is implicitly valid: it sets no provider parameter, so it never appears in
  a model's `thinkingLevelMap`, yet conversations — workers especially — carry it, and validating it
  against the catalogue made a healthy worker look broken. The picker offers it for any model with
  levels, first in the list. `selectedModelId`
  travels through client send/queue handlers as a fallback guard, never in the upstream request body.
  Picker opening and the unavailable-model warning can refresh the catalogue; refreshes do not choose
  a replacement. Queued-message model edits forward reasoning explicitly, including an explicit
  default/cleared effort; they must not inherit the old queue item's effort by accident.
  `e2e/modelSelection.pw.ts` verifies outgoing model IDs, effort levels and persistence.
- Instance probes publish `ember:instances-updated` hints. `listInstances(false)` reads the current
  snapshot without probing; each healthy instance can load while another is still checking.
- `ReadCoordinator` serializes full/tail transcript reads. Post-mutation and authoritative event
  repairs request a read after any already-running request. Routine polls fetch tails; full repairs
  remain for terminal events, reconnects, missing overlap and 60s busy/polling or 5min idle-live safety
  checks. Routine session-list reads use one page between 5min deeper reads. Partial lists merge rather
  than deleting absent sessions. The palette can explicitly request deeper indexing.
- “Missing overlap” is not always a rewrite: `reconcileTranscriptTail` treats a tail whose ids are all
  newer than everything held (Hearth's `e<entry>` ordinals ascend by position) as an ordinary append past
  the window and glues it on — the old answer asked for a full read, which a real long session cannot
  deliver (32 MB response cap) and which nothing stopped retrying for as long as the column was open.
  `src/lib/repairBudget.ts` is the breaker on what is left: three consecutive failed full reads for one
  session stop the automatic repairs (the reader's own Refresh still goes through, one success clears
  the count), and the transcript's missing-history line then says the conversation is too large to read
  in one response and offers **Compact** — the only thing that makes the read fit — instead of a
  “Load them” that is known to fail. A full read keeps the transport's own words when it fails
  (`piLoadMessageHistory` no longer rewraps every failure as a status code), which is how the breaker
  tells “too large” from “timed out”.
- `StableChatView` stabilizes callbacks/data for its memoized child. `Transcript` is memoized separately,
  virtualizes histories over 80 visible records with TanStack Virtual, and retains expansion state
  outside virtual rows. Cmd/Ctrl+F within a column opens inline data-backed conversation search.
  A keyboard/screen-reader-accessible control offers full non-virtualized history; virtual row mounts
  are not live announcements, so scrolling does not repeatedly announce old messages.
- `TranscriptCache` accounts estimated bytes (64 MiB target plus the existing count cap). Visible
  columns and pending sends are protected; minimized/closed histories can be evicted. Protected
  working sets may exceed the target: it is not a hard process-memory limit.
- `capabilities.dockIcon` gates the dock renderer before import. Remote assets negotiate gzip/Brotli,
  with an 8 MiB compressed-asset cache; API responses remain uncached and SSE remains uncompressed.
  Remote sessions own their SSE subscriptions: logout revokes existing streams, expiry is checked on
  events and heartbeats, and disabling/restarting remote access closes existing HTTP connections.
- Personal model experience lives in the existing model picker and stores usage metadata on the
  Ember host in `model-stats.json`, separate from settings. It retains up to 10,000 observations for
  90 days, keyed by instance/session/message. Metrics describe observed model calls, not whole tasks
  or inference-only timing. No transcript text or tool payloads are retained. Clear/reset also records
  a cutoff so old polls cannot recreate cleared observations. Desktop IPC, the authenticated remote
  bridge and the mock implement it.
  **Helpful / not-helpful ratings were retired in 0.80.0** (owner: "its never been used"): the thumbs
  left the message footer in 0.79.1 and the rest followed — the `rating` field on observations, the
  `rateModel` IPC and `/remote/model-rating`, and the "n / m helpful" column in Usage. Files written
  by older builds still load; the field is dropped on read.
- At this baseline `bun.lock` is tracked, despite the older note above; dependency changes include its
  generated updates along with `package.json`.

## README editing

Use [README Atlas](.agents/skills/readme-atlas/SKILL.md) for README work. The complete vendored
skill is pinned to `chromoany/readme-atlas` commit `18f60638764ce36910d5977c1cea4c47dce9990d`;
retain its licence. Lead with human thinking, decisions and steering, show labelled real UI imagery,
and keep download/first use separate from source development. Verify release assets instead of
assuming the package version is published. Detailed usage, instance setup and contributor guidance
live in `docs/usage.md`, `docs/instances.md` and `docs/development.md`.


## Instance alignment

`InstanceAlignment.tsx` owns the explicit Settings → Instances review/apply flow. Alignment is
one-time and fill-only: imported connections preserve existing URLs/tokens; optional provider
sharing chooses one source and never copies OAuth or environment-only credentials. New Kiln
`/alignment` routes require the normal bearer authentication. GET previews contain metadata only;
POST `/alignment/connections` exports portable peer credentials to the desktop, while `/share`
sends stored API keys directly to reviewed destinations. The remote browser proxy blocks all
alignment routes. `alignment.ts` owns validation, peer merging and atomic missing-key imports.
Do not restore destructive peer-list replacement in Ember's automatic push: it sends `merge: true`
so one Ember setup cannot erase peers learned from another. Plain public HTTP and loopback URLs
are excluded from explicit sharing; HTTPS/private-network reachability remains the user's choice.
