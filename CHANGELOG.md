## Unreleased

### Added
- Inspect worker threads in a roomy live conversation dialog without replacing the main workspace. Promoted peers still open as normal sessions.
- Set an instance’s default model directly from the model picker without changing the current conversation.
- Setup requires an available default model and offers OpenCode sign-up guidance for people without a provider account.

## 1.20.6

### Changed
- The sidebar width control sits beside the app name in the top bar, following the macOS window buttons. The name uses a neutral, bolder treatment, and the rail no longer repeats the control.

## 1.20.5

### Fixed
- Crystal facets share a connected mesh instead of overlapping planes. Shading follows each face's angle, reflections stay on the same cuts, and sparkles sit at shared corners.

## 1.20.4

### Changed
- Working Lava moves more quickly and visibly, with larger deformations and a different long sequence of pulls, sideways shifts and separations for each character.

## 1.20.3

### Changed
- Mosaic has larger, uneven eyes with bigger pupils and catchlights. Its pupils follow the cursor in both directions and make more expressive working and thinking glances.

## 1.20.2

### Fixed
- Rail hover actions sit on an opaque, bordered surface and reserve space beside the title, so their icons no longer blend into or cover session text.

## 1.20.1

### Changed
- The active agent beside the composer shows the same project/folder and instance metadata as rail agents, while retaining its background and spacing.

## 1.20.0

### Added
- Mosaic eyes follow a nearby mouse in whole-pixel steps while keeping their blinks. Scribble has a more visible pupil range, and the blob gallery now enables cursor tracking for all three styles with eyes.

### Fixed
- Pupils return to their normal gaze when the pointer leaves the window or tracking is disabled.

## 1.19.8

### Removed
- Removed the rail’s unread-message count shortcut and its separate reading modal, including the modal-only loading, commenting and navigation code. Conversation read controls remain available.

## 1.19.7

### Changed
- Hovering or focusing a message’s unread indicator shows a “Mark as read” tooltip to its right.

## 1.19.6

### Fixed
- Lava approval and question states keep their slow fluid motion without shaking the whole blob and badge.

## 1.19.5

### Fixed
- Go to new messages aligns the start of the reply with 28px of reading space above it. The destination highlight fades over five seconds and restarts on another jump.

## 1.19.4

### Fixed
- Unread notification circles match the question and lock badges in size and position across every blob style and display size.
- Question and lock badges share a stronger secondary theme accent. Clay uses mint with black symbols, and errors use a clearer rose-red with a dark symbol.

## 1.19.3

### Added
- A long-message demo at `?fixture=long-messages` opens two substantial replies with paragraphs, headings, a table and code for inspecting conversation layout.

## 1.19.2

### Changed
- Lava drifts through uneven stretches and partial separations on independent, seeded rhythms. Sideways currents change the droplet’s path between splits, and colour pools meander instead of spinning steadily.
- The blob gallery shows three distinct examples of each style in every state, with matching characters across states and in the larger previews.

## 1.19.1

### Fixed
- Read acknowledgements hold a visible check before spinning and fading away. Reduced-motion mode shows a static check briefly.

## 1.19.0

### Added
- Settings → Instances offers “Align all my instances”: review connected Kilns, import missing connections, and optionally copy missing stored API keys from one chosen source. Existing credentials and settings are preserved; subscription sign-ins stay on their original hosts. Requires Kiln 1.10.0.

### Fixed
- Peer-list updates merge connections instead of erasing peers learned from another Ember setup.

## 1.18.8

### Fixed
- Crystal’s working highlight follows each facet’s angle and stops at its edges, with softer reflections on shaded faces.

## 1.18.7

### Changed
- Expanded the README with provider connection methods, upcoming sign-in work and a short Tailscale guide for access across devices.

## 1.18.6

### Fixed
- Opening an archived run from Scheduled restores the conversation so its unread messages can be read.

### Changed
- Removed scheduled plans from the main rail. Plans remain in the Scheduled tab; their messages continue to arrive as ordinary sessions.

## 1.18.5

### Changed
- Documented unsigned Windows installer warnings beside the download instructions.

## 1.18.4

### Changed
- Crystal’s working state gently loops through facet reflections and soft sparkles, distinct from its thinking animation.

## 1.18.3

### Fixed
- Scribble’s legs extend behind its body into the centre of the tangle, keeping their upper ends hidden during movement.

## 1.18.2

### Changed
- Reworked the README around human review and steering, a labelled screenshot, verified release downloads and first use. Detailed usage, connections and contributor guidance now live in linked docs. Source setup installs the harness dependencies explicitly.
- Added the repository-scoped README Atlas skill, pinned to upstream commit `18f60638764ce36910d5977c1cea4c47dce9990d`, with its MIT licence and reference files.

## 1.18.1

### Changed
- Composer trays, comments and side questions sit above the composer connection. Expanding them no longer enlarges the row shared by the agent identity and text input.

## 1.18.0

### Added
- Background threads store durable outcomes and evidence references without repeating routine crew reports in the main chat. Thread continuations release the foreground, prioritize human input, survive restarts and suppress delivery of results already retrieved. Existing workers retain their legacy delivery policy.
- Quoted `/threads/<id>` links open the source thread. The composer’s Threads tab shows running and human-input counts; internal notices never become visible messages or read targets.

### Changed
- Ultra delegator keeps substantial execution in background threads while permitting small foreground inspections and decisions. It subscribes to outcomes instead of polling, and coordinates without routine acknowledgements.

## 1.17.0

### Changed
- New chats combine the first human prompt's topic with a whimsical character, such as Login Locksmith. Collisions retain the topic; vague prompts retain the seeded character fallback. Names are set once at creation, preserving human renames and blob identities without an extra model call.


## 1.16.0

### Changed
- The rail now runs from older chats to newer ones, with the current chat anchored at its lower
  edge beside the composer. Creatures move between the list and this dock, neighbouring rows
  slide into place, and the chat’s colour continues across the connection. Names and folders
  identify the destination without an extra label. Settings remains available at the rail’s top.
- Agent replies sit directly on the conversation surface; user messages retain their bubbles.
  Conversation text defaults to 14px with more open spacing. Settings → General offers sizes
  from 12px to 20px for reading and composing, saved across restarts.


## 1.15.9

### Changed
- Lava’s approval and question states now separate and reform as liquid, with a calmer pace than
  working. Active states use curved droplet paths, independently phased lobes and stronger body
  deformation instead of rocking as one solid shape. Decision badges stay still.

## 1.15.8

### Fixed
- Mosaic’s error eyes use the same full-size pixels as its body. Larger X eyes fit each
  silhouette, including mirrored shapes. Blinks also use whole cells; all Mosaic details now
  follow a single pixel grid.

## 1.15.7

### Changed
- The bottom-rail layout study now animates creatures between the rail and composer, slides
  neighbouring chats into place, and reveals the new conversation with its colour. A slow-motion
  control makes the handover easier to review; reduced motion uses an immediate switch.

## 1.15.6

### Changed
- Scribble raises its hand only for questions. Working cycles through wire movement while looking
  left, right and away, followed by a stretch; the gallery previews each gesture separately.
- Buddy thinks with stronger leaning, squashing, rising and eye movement. Lava gathers, stretches
  and melts while thinking, with its colours following the moving material.
- Removed Lava’s orbit ring; Crystal alone uses it. Decision badges and reduced-motion poses remain.

## 1.15.5

### Fixed
- Mosaic’s error eyes are now blocky crosses made from square pixels,
  replacing the thin diagonal strokes. The larger eyes remain inside every silhouette.

## 1.15.4

### Added
- A standalone, interactive HTML study at `sketches/bottom-rail.html`: recent chats sit near
  the bottom and the active chat’s identity flows into a shared composer strip. Uses sample
  data with local draft switching; the application’s rail is unchanged.

## 1.15.3

### Changed
- Mosaic glances from side to side while working, looks up with longer holds while thinking,
  and occasionally blinks. Eye movements stay on the pixel grid, vary in phase between chats,
  and stop with eyes open under reduced motion. Idle and error faces remain still.

## 1.15.2

### Changed
- Scribble turns as a solid tangle with independently moving wire bundles, mixed sharp/round/bent
  tips and crossing strands, instead of flattening sideways.
- Thinking belongs to each creature: Buddy looks up and tilts, Scribble’s wires twitch, Mosaic’s
  tiles light in stepped patterns, Lava’s inner colours circulate, and Crystal’s facets glint.
  Removed the shared thinking ring; decision badges and reduced-motion support remain.
- Mosaic’s error face has crossed eyes. Lava’s outline is thinner, translucent and body-coloured;
  Crystal’s quieter glow follows its irregular silhouette instead of a circle.
- The blob gallery includes an enlarged comparison of all five thinking animations.

## 1.15.1

### Changed
- Moved Ember’s 126 unit and regression test files from the repository root into `tests/`,
  updating imports, source-file checks, lint configuration and Windows CI. Existing test
  commands still run both Ember and Kiln suites.

## 1.15.0

### Changed
- Scribble's working animation cycles through a head scratch, a turn and a small stretch, with
  coordinated feet and eyes, quiet holds, and different starting phases for each chat.
- Mosaic stays anchored while grid-aligned pixels appear and disappear along both sides.
  Both styles stay still when idle and respect reduced-motion preferences.

### Added
- A local blob review gallery (`bun run dev:blobs`) uses the app's five renderers in all eight states.
  Includes enlarged working previews, Scribble gesture shortcuts, size/theme/colour controls,
  pause and reduced-motion previews. It runs independently of chats and account settings.

## 1.14.5

### Fixed
- Added 3px below the agent identity beside the composer so the name has more breathing room.

## 1.14.4

### Fixed
- Subscription sign-in no longer claims success when Kiln has forgotten an attempt or restarted.
  Failed attempts offer Try again, and stale responses cannot overwrite a newer login.
- OpenAI subscription sign-in explains device-code permissions when needed and hides expired codes
  after failure. Success is shown only after Kiln confirms that the connection was saved.
- Expanded fresh-profile packaged-app checks for issue #2: setup copy and spacing, OpenAI device-code
  startup/cancellation, existing folders, folder creation/recovery, workspace persistence and glows.

## 1.14.3

### Fixed
- All 27 colour swatches can be saved: desktop validation previously rejected the last five.
  The picker and validator now share one palette, with stable persisted indices.
- Appearance colours and shapes survive desktop validation without empty traits erasing inherited
  choices. The picker now previews the same scope-resolution rules used after Save.
- Switching between custom colours and swatches keeps the colour input, preview and saved avatar
  consistent, including theme-adjusted swatches and Lava's secondary colours.
- Editing a shared colour explains when a chat's separate override takes precedence.

## 1.14.2

### Fixed
- Tool-call steps no longer get read bubbles or count as unread messages, including completed
  steps with commentary. They no longer prevent a reply’s read mark from advancing.
- Folding tool history into a final reply preserves that reply’s read indicator. Turn failures
  remain eligible for acknowledgement; pending approvals and questions keep their own controls.

## 1.14.1

### Fixed
- Scheduled plans show an unread dot and open their newest unread run. Their counters survive
  restarts and visits to Scheduled, clearing only with explicit message read marks.
- Automatic cleanup keeps unread scheduled results. New output in a previously archived recurring
  chat stays discoverable on its plan; opening it restores the chat.
- Read marks survive archiving/restoring and staggered instance loading during startup.
- A cached empty unread digest no longer hides a later report while fresh messages load.

## 1.14.0

### Added
- Copy and Reply shortcuts at the end of each message-details row, revealed on row hover or
  keyboard focus and always available on touch devices. The original copy shortcut stays.
- Reply adds the chosen message as composer context, keeps the draft and focuses the input.

### Fixed
- Existing Kiln chats show their effective thinking level: an unset host setting means Off.
  Leaving the setting unchanged shows “Keep Off” (or its current level), rather than suggesting
  a provider default. Historical reply labels continue to use the level recorded for that turn.

## 1.13.0

### Changed
- A top-of-conversation “Go to new messages” control jumps to the newest unread reply without
  marking anything read. “Mark all as read” appears when multiple unread replies are loaded.
- Each unread reply has a 44px read-bubble target. Pressing it immediately shows a check that spins
  and fades away; reduced-motion preferences use a quiet fade. Individual read marks persist.
- Removed the ambiguous floating read action and the duplicate icon-only header action. Unread
  controls now use the same finished-reply eligibility as the reading view.

## 1.12.0

### Added
- Scribble avatars: seeded, scratchy creatures with tiny feet, six silhouettes and uneven white eyes
  outlined in dark ink. Supports custom colours, all avatar sizes and shared status indicators.
- Scribble keeps still when idle and waddles while working, with reduced-motion support.

## 1.11.1

### Removed
- The generic “Next” reply suggestions above the composer, along with their unused generation logic.

## 1.11.0

### Added
- Standard, Large and Extra large avatar sizes in Settings, with the existing size kept as the default.
  Rail rows, project/group views and the compact rail adapt to the choice.
- The composer carries its chat’s blob, name and subtle identity colour, so the destination stays
  recognizable beside the message you are writing.

## 1.10.0

### Changed
- Replaced Pip with Mosaic: crisp pixel characters with seeded silhouettes, colour ribbons and square eyes.
  Existing Pip selections migrate to Mosaic. Custom colours and six shapes are available in appearance settings.
- Mosaic keeps chat identity consistent across the rail, conversation, reading view and dock, with static
  idle poses, stepped working motion and reduced-motion support.

### Fixed
- Dock icons merge avatar bodies and status overlays into one valid SVG before rendering.

## 1.9.1

### Fixed
- The compiled OAuth regression uses an absolute credential path, matching Kiln's data directory
  and avoiding a Bun Windows error when recursively creating `.`.

## 1.9.0

### Added
- Windows installer builds now include `kiln.exe`, run a fresh-profile packaged-app smoke test,
  and provide the installer, standalone Tinder and checksums through the Windows build workflow.
- Folder browsing offers New folder, with cancellation, explicit selection and recovery when a
  name already exists or the parent is not writable.

### Fixed
- Standalone Kiln and Tinder embed the SDK's OAuth flows, fixing packaged OpenAI sign-in failing
  with a missing `openai-codex.js` module. A compiled regression exercises the full device-code
  exchange and saved credential without accessing a real account.
- Setup says “Setting up Ember Bots,” gives the heading 10px more vertical padding on each side,
  and says Ember “has” the Kiln token. Background glows are softer and follow their blobs' colours.
- The OpenAI sign-in dialog uses the subscription name instead of the SDK's legacy provider label.
- Browser regressions now follow the current host labels, explicit tool-list setting and project
  picker. The mock reports empty conversations like Kiln does, restoring dropped-create retry coverage.

## 1.8.0

### Added
- Choose the workspace where your projects or work already live, separately for each instance,
  during setup or from the project picker and Settings.
- A compact project menu above the composer shows recent folders, searches workspace projects,
  and reveals deeper browsing or path entry on demand. Empty folders can be selected too.

### Changed
- Removed the always-visible folder path field from new chats. The selected folder stays visible
  on the picker, with its full path on hover.
- Workspace setup preserves provider/model defaults and other instance preferences.
- Included Kiln 1.7.0 supports explicit authenticated folder browsing outside its suggested workspace.

## 1.7.0

### Added
- Rail markers show the programs each chat has running, including compact, project and group views.
- Each chat gets its own stable colour. Appearance defaults to this chat, offers a custom colour
  picker, and uses the same resolved colour for the blob and its soft background glow.
- Adding an API key or signing in to a provider offers a choice to keep or change the instance's
  default model, both during setup and in Settings.

### Changed
- Removed Home. Ember opens the workspace directly; the rail keeps unread reading available.
- Approval choices are Allow and Switch to YOLO mode, alongside Deny. YOLO uses the same shield
  and label in approval cards, the composer and crews, with its conversation-wide scope explained.
- Muting notifications is stored separately from read marks and never marks incoming messages read.
  Existing quiet-session preferences migrate without changing their recorded read history.

### Fixed
- The reader respects Enter on focused buttons and uses the conversation's selected model without
  silently substituting another. Unsent feedback stays in place when that model is unavailable
  and appears in the composer when opening its conversation from the reader.

## 1.6.9

### Fixed
- Finishing or dismissing setup opens a new-session draft on an available Kiln. Empty Home also
  defaults to a draft once session lists have loaded, without creating a conversation until send.
  Existing sessions, other views and drafts are preserved, and hidden/offline hosts are not chosen.

## 1.6.8

### Changed
- Setup fills the window instead of sitting inside a framed modal. Soft ember glows and blurred
  lava/crystal blobs add atmosphere behind translucent reading surfaces; the 16px typography stays.

## 1.6.7

### Fixed
- Setup uses 16px text instead of 10–15px copy, with larger introduction headings, a roomier dialog
  and wrapping step descriptions. The Ember metaphor uses bold emphasis instead of italics.

## 1.6.6

### Changed
- Refined the Ember/Kiln introduction with the fire metaphor and the details Ember shows about
  agents’ work, including actions, images, errors and supported model thinking.

## 1.6.5

### Changed
- Fresh setup starts with the Ember/Kiln explanation and diagram, followed by a page for choosing
  where Kiln runs. Optional installation, Tinder and Tailscale instructions stay behind disclosures,
  with a copyable agent setup prompt. The local Kiln status and Retry remain on the second page.

## 1.6.4

### Changed
- Setup explains Ember, Kiln and agents in everyday language. The introduction replaces terms such
  as instance, host and GUI with concrete descriptions; the AI setup step explains access keys and
  the container example explains what a container means.

## 1.6.3

### Changed
- Step 1 of setup illustrates Ember connected to its included Kiln and optional Kilns in a container,
  on a Mac Studio or on an old PC. The explanation distinguishes GUI and backend responsibilities,
  independent storage, shared connections and bundled versus standalone lifetimes.

## 1.6.2

### Fixed
- A genuinely fresh install shows provider setup even when its bundled Kiln starts successfully.
  The guide stays available across reloads and restarts until dismissed; existing installations
  retain their migration behavior.

## 1.6.1

### Fixed
- Bundled Kiln starts from the development build as well as an installed app. Isolated Ember
  profiles use their own local port and Chromium storage instead of colliding with the daily app.
- Onboarding Retry starts Kiln again, waits for its result, and refreshes the connection state.
  Spawn failures are handled, and an unexpected Kiln exit updates its reported state.
- Quitting Ember waits for its bundled Kiln to stop. Independently managed Kilns remain running.
- The bundled backend honors the loopback bind address and reports its embedded package version.
- The compiled Tinder download includes the standalone backend (`tinder serve`). Generated services
  launch Tinder itself without requiring Bun, preserve custom ports, and quote installation paths.
- Updated native integration coverage for drafts and usage; added real-binary startup, retry,
  profile isolation and lifecycle checks.

## 1.6.0

### Added — a first-run guide
Ember used to open onto an empty Home and leave you to work out that an instance existed, that it
needs a token, and that a model provider is a separate thing again. There is now a guide that tells
that story once, in order: what Ember and Kiln are (with a blob), whether a harness is running on
this computer, the token in plain words, an optional step for a container or server, giving the
instance a model, and starting a first agent.

It is **adaptive**: a working install on one computer sees five steps and never the container
instructions, and its token step is a single "Show it" button. It appears when **nothing works** —
no local harness *and* no remote answering — which is not the same as "first launch". An install
that has ever had a working host records `onboardedAt` and is never shown the guide, so upgrading
does not lecture anyone who has been using Ember for months. Esc and "Skip for now" work from every
step; it can be reopened from Settings.

### Added — a colour cue per column
- **A soft wash of the agent's own colour in the top-left of each session column.** It is the same
  colour the blob and the rail use, so a column is recognisable before you read its title. Deliberately
  faint — one wide radial gradient at low alpha, no blur filter (a blurred 400px layer is repainted on
  scroll) — and painted in its own `pointer-events-none` layer so it never enters a hit test or scrolls
  with the transcript.

### Fixed — the composer
- **It grows much further, and scrolls when full.** The cap was 160px, about eight lines, and the
  box had `overflow-hidden`, so pasting a stack trace silently clipped the rest with no bar and no
  sign there was more. It now grows to 320px with a thin themed scrollbar, and no longer hides text.
- **It can be dragged.** The handle was disabled (`resize-none`, inherited from the shared
  `Textarea`), and even if it had been enabled the height was recomputed from the text on every
  render, so a drag snapped back. A dragged height now wins until you drag it back to automatic, up
  to two thirds of the window.
- **Sending resets the size.** The height was about the message that just left, not the next one.

### Added — subscription sign-in, and the providers it needed
- **Sign in with ChatGPT Plus/Pro**, **Meta**, and **OpenRouter** now have buttons on the providers
  page. They were absent for a dull reason: the providers were never registered, so `/providers`
  could not offer them, so no button could be drawn — "how do I log in to my ChatGPT account" had
  the answer "you can't, that provider isn't listed".
- **A flow that only asks *how* to sign in is now answerable.** ChatGPT and Radius ask "browser or
  device code" before starting; Hearth answers **device code**, which is the branch that works with
  no browser and no callback server. Any other question is still refused, because an invented answer
  either rejects the flow or silently picks a default.
- **Anthropic** and **GitHub Copilot** are listed with a sentence instead of a button: Claude needs a
  code pasted back from the browser and Copilot needs a host choice, and neither can be collected
  here. A dead button is worse than an explanation.

### Added — local runtimes, and NVIDIA
- **Ollama** and **LM Studio** are providers now, with no account and no key. Both are probed on
  boot: a stopped runtime is not offered, and `GET /providers` reports why — *"Ollama is not
  answering at 127.0.0.1:11434 — is it running?"* is a different fix from *"it answered, but not
  with an Ollama model list"*, which means upgrade it.
- **NVIDIA** (`NVIDIA_API_KEY`) is registered alongside the other keyed providers.

### Fixed
- **"Left running" is now a Linux-only feature.** Attribution reads `/proc/<pid>/environ`, and there
  is no reliable substitute: three attempts failed for the same reason — without that file there is
  no dependable way to say which conversation a process belongs to. Polling the table cannot see a
  command that finishes in milliseconds, and asking the shell to report its own jobs still cannot
  tell a real leftover from a child whose parent had not yet exited. On macOS and Windows the
  wrapper now passes the command straight through: the agent is told nothing, rather than told
  something unreliable. A note that appears on some machines and not others is worse than none,
  because it teaches people to ignore it.

  The window for this was a day: the mechanism was rebuilt twice, and each rebuild fixed a real
  fault (a 1.5s poll, a `ps` call with no start time) without making the design sound. Both those
  fixes are kept where they still apply.

### Previously, on the same feature
  - **Polling could not work, and no interval would fix it.** A `ps` pass takes ~70ms and
  `sleep 60 & echo started` finishes in ~3ms, so the only polls that could run were the one
  *before* the shell spawned and the one *after* it exited and the child was reparented to launchd.
  250ms, 50ms and 10ms intervals all recorded nothing. **The shell now reports its own background
  jobs** (`$!` and `jobs -p`) to a per-command file, and that file is read once the command ends.
  Exact, free, and with no window to miss.
  - `ps` was asked for no start time, so every row carried `startedAt: 0`: a leftover could not be
    aged and the pid-reuse guard never engaged. It now reads `etime`.
  - `resetProcessCache()` cleared the *ledger* as well as the scan cache, which wiped the
    observations a test had just made — so one shipped test could never pass even with a working
    watch. The two are separate now.
- **A local harness is always listed.** It only appeared when *this launch* started it, and the
  disk fallback was skipped whenever the settings file held any endpoint — so a machine with Kiln
  installed and one remote endpoint showed no local instance at all. `attached` hosts now list too;
  rotation stays limited to hosts Ember started.
- **Settings → Instances no longer flickers.** The token row replaced itself with its spinner on
  every parent render, because the loader was a fresh `.bind()` each time and sat in a dependency
  array. It is pinned now, and the spinner only shows when there is nothing to display yet.
- **Comments were never truncated — the box was too small.** The reply field was a 24px single-line
  input that scrolled horizontally, so anything past the visible width looked lost. It is a growing
  textarea.
- **Unread messages show a dot on the bubble** they belong to, top-right, and it clears with the
  floating "Mark as read".
- `localHarnessCanRotate` is no longer written to `settings.json`.

## 1.5.3

### Fixed
- **`dist:mac` notarizes itself now.** Notarization used to be a list of `notarytool` commands a
  person pasted from a release checklist. The first time it was actually attempted the build above it
  had failed, nothing stopped the release, and the commands ran against files that did not exist.
  `electron-builder`'s `afterSign` hook (`build/notarize.js`) now submits the signed `.app` and
  **staples** the ticket to the bundle — which is what makes it validate offline, on a machine that
  has never seen it — using the same `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` variables the
  rest of the toolchain reads. A rejection fails the build instead of publishing.
- **A release can no longer ship un-notarized.** `dist:mac` sets `EMBER_RELEASE=1`, and without
  credentials the hook refuses rather than warning. `dist:mac:local` keeps the old, warning-only
  behaviour for a developer who just wants a build.
- **The bundled harness is recompiled, never reused.** `build:harness` now clears its output first.
  `build/harness/kiln` was a Linux ELF binary sitting in a gitignored directory, so a Mac build that
  ever skipped or reordered that step would have shipped a `.app` whose embedded Kiln cannot execute —
  and it would still have passed signing, because signing does not inspect architecture.
- **`electron-builder` is pinned** (`26.18.0`) instead of resolved by `bunx` on every build. A new
  major landing mid-release could break signing with no change on our side.

## 1.5.2

### Changed
- **"Mark as read" floats beside "Jump to latest"** instead of sitting under the message. The moment
  you want it is the moment the message is *not* on screen — you are scrolled up, reading the middle
  of a long turn — so a control attached to the message only worked if you had already found it. It
  now lives in the viewport's bottom corner next to Jump to latest, and acts on the **newest unread**
  turn: the mark is a watermark, so marking the latest one is what "I'm caught up" means.
- **Pointing at it tints the message it would mark**, so it is never a guess which turn moves. After
  the press that message **flashes the accent twice** — and only that message; nothing else on the
  page moves.

## 1.5.1

### Fixed
- **"Mark as read" was off screen and impossible to press.** It was a 14px circle in the message's
  left margin — which sits *outside* the transcript's scroll area. On a narrow window the row's
  padding is the only thing between the text and the viewport edge, so it was clipped to a sliver;
  on a wide one it was a speck far from the text it belonged to. A control nobody can press is not a
  control.

  It is now a **Mark as read** row under the message, where reading ends and the decision happens.
  It turns into a tick when pressed, then collapses and the turns below slide up over ~180ms, so the
  gap closes gently instead of jumping. It shows on hover and on keyboard focus (and always on a
  touch screen, where there is no pointer to hover with), so twenty unread messages don't paint
  twenty buttons over the conversation.

- **A rotated harness disappeared from the rail.** The endpoint merge only adds the harness *this
  launch started* — a token read from settings might be stale — and the restart that installs a new
  token produced a state that wasn't in that set. The token was fine and the row was gone, until the
  next launch. A rotated harness is now its own state (`restarted`), kept in the list and still
  re-tokenable.

## 1.5.0

### Added
- **See and copy the harness token in Settings → Instances → This computer.** Until now the token was
  only reachable by opening `~/.ember/hearth.token` in an editor or running `tinder token` — for a
  value whose entire purpose is being copied to another machine. It is masked until you ask (this is
  the most screenshot-prone panel in the app), Copy works without revealing, and the line under it
  says what the token is for.
- **Regenerate it from there.** One button, one confirmation that names what breaks: every other
  machine and browser pointed at this host stops connecting until the new token is copied across.
  The agents themselves are untouched.
  A token is read by the harness at startup, so this is one operation, not two: Ember stops the
  harness it started, waits for the process to exit, writes the new token to both filenames, and
  starts it again with the token already on disk. Writing the file under a running harness would have
  shown a fresh token while the process still accepted the old one.
  Only offered when Ember started the harness itself. A host Ember merely attached to — Tinder's
  service, or something older — keeps its token, because Ember does not own its restart.
- **Tokens are four words now: `apple-venison-rainbow-copper`.** Sixty-four hex characters were
  unreadable, untypable and unfixable by looking at them, so they ended up pasted into notes and chat
  messages. Four words from a 1,933-word roster carry about 43.7 bits — still far beyond guessing over
  the network (about 700 years at 200 requests a second), and now easy to retype from one screen into
  another, which is the thing people actually do with it.

### Notes
- **Existing tokens keep working.** Nothing validates the token's shape: the harness compares the
  string it read with the string in the request, so a 64-character hex token from an earlier install
  is still valid and is never rewritten. Rotating is how you get a word-form token.
- The word list ships twice — `electron/tokenWords.ts` for the app and `packages/kiln/src/token.ts`
  for the harness and CLI, which cannot share a module because electron main is compiled with
  `rootDir: electron`. `tokenWords.test.ts` fails if the copies ever drift, because the failure it
  prevents (the app showing a token the harness has never heard of) looks like a bug in neither half.
- The token is refused to the remotely served page: `ember:local-harness-token` only accepts the app's
  own `file:` window, so a paired browser session can never read the credential for the host it is
  controlling.

## 1.4.1

### Fixed
- **"New messages: Don't notify" could not be switched on — it flickered and reverted.** The row
  saved the flag, and the stored copy that main handed back had lost it: `parseReadMarks` in
  `electron/transport.ts` rebuilds every read mark from a fixed list of fields (`through`, `ids`,
  `readAt`, `comments`), and `quiet` was not among them. So each click wrote a value that was
  validated away, the optimistic row was replaced by the stored one a moment later, and the switch
  appeared stuck. The field is now carried through, and a quiet session with no read history at all
  keeps its key instead of being pruned as "a mark that says nothing".

## 1.4.0

### Fixed
- **A harness that had just started could be listed with an empty token, so every request was a
  401.** `/health` answering and the credential being readable were treated as one fact, and they are
  not: the harness binds its port and starts answering, *then* writes `hearth.token`. The first poll
  that landed in that window saw a healthy host and recorded an empty token — Ember listed a
  connection that answered its health check and rejected everything else. Reload could not fix it
  (reload re-uses the recorded token) and nothing logged it, because from the harness's side nothing
  was wrong. Ready now means **both**: it answers *and* we hold the credential it answers to
  (`harnessIsReady`). A host already running whose token we cannot read is not adopted either — that
  was the same 401 wearing a different label.

### Changed
- **Everything Ember owns now lives in `~/.ember`.** It was split across `~/.config/ember` (settings,
  model stats, activity) and `~/.ember` (the harness's home), which meant one product with two data
  directories, two backup stories and two things to delete. Both now share one directory, so deleting
  it deletes Ember. A pre-1.4 `~/.config/ember` is moved across once, before anything reads settings,
  and never overwrites a file already at the destination; token files are deliberately not carried
  over, because whichever harness is running owns the credential. `EMBER_DATA_DIR` still gives a
  canary build its own tree.

### Added
- **An empty model picker now says what to do.** A host with no providers cannot offer a model, and
  refreshing changes nothing, so the picker named the dead end. It now says *"<host> has no model
  providers yet, so there are no models to pick"* and offers **Add providers…**, which opens that
  host's Providers screen with the host already selected.

## 1.3.0

### Added
- **The desktop app now ships its agent server.** Downloading `Ember` and opening it left you with a
  control room and nothing on the machine to control: the only ways to a working host were to clone
  this repository or to run the CLI first. A desktop app that needs a terminal before it can show a
  single conversation has not been installed, it has been unpacked.
  - `bun run build` compiles Kiln (`packages/kiln`) to a single binary in `build/harness/kiln`, and
    every target copies it into the app's resources (`electron-builder` `extraResources`). The app
    starts it on first launch, on loopback, with its data home at `~/.ember`, and lists it as
    **This computer** — so instances, streams, polling and the crew strip all work unchanged.
  - **It adopts a host it did not start.** If something already answers on `127.0.0.1:3002` — a
    `tinder setup --service` host, a container, another Ember window — the app attaches to it and
    never stops it on quit. Starting a second harness would open the same SQLite file twice, so a
    lock file (`~/.ember/ember-harness.lock`) decides ownership and a stale lock from a crashed
    parent is reclaimed.
  - **Every failure is a sentence.** A missing binary, an immediate exit (with its code) and a boot
    that never answers each say what happened, name the log at `~/.ember/kiln.log`, and point at
    Settings → Instances, which still works. `electron/localHarness.ts` holds the rules and
    `localHarness.test.ts` pins them, including that an adopted host is never stopped.
  - The switch lives in Settings → Instances (`localHarnessEnabled`, persisted), so a person who only
    wants remote hosts is not asked again on the next launch.
- **The README links the versioned macOS artifacts.** It pointed at `Ember.dmg`/`Ember.zip`, which
  `v1.2.0` never published; the links now use the names the release actually has.

### Notes
- The bundled binary is not signed by `electron-builder` on its own; the harness inside
  `Contents/Resources` is what the app spawns, so a macOS build must sign it with the same Developer
  ID as the app (it is picked up by the app bundle's signature) or Gatekeeper will object at spawn
  time rather than at launch.

## 1.2.0

### Changed
- **The composer's three-dot menu absorbed the "new messages" bell.** The bell was a header
  button carrying a whole sentence ("New messages: Don't Notify") in a row of icon buttons, so it
  never fitted and it made an uncommon choice compete with the ones used every turn. It is now a
  row at the top of the view menu, under **This session**, beside *Spent* and *Instructions*, with
  both states written as sentences rather than a switch whose off position has to be guessed:
  **New messages: Don't notify** — *they are marked read as they arrive, so this session never
  shows as unread* — and **New messages: Notify** — *they appear on Home as unread and count in the
  top bar*. It is offered only where it can be observed: a worker's read mark is invisible because
  Home never lists workers, so the row does not appear there.
- **The dot on the three-dot button now says what it means.** It is the "something here is hidden"
  signal inherited from the struck-through eye the button replaced, and nothing in the UI explained
  it. The trigger's tooltip says *a dot means something here is hidden*, and a line beneath **Reset
  to defaults** says *the dot means something in this menu is switched off* whenever the dot is
  showing.

### Notes
- Kiln's `package.json` now carries the release version too. It had drifted to `0.42.0` while the
  app it ships inside read `1.1.0`, so `/health` reported a version no release page had.

## 1.1.0

### Added
- **Forget an instance that will never answer again.** The Instances menu had one control per row,
  and it was disabled for any host that was not ready — because hiding needs sessions to hide. That
  left the rows that most needed a way out with none: a container you have deleted still appears in
  `~/.config/openchamber/settings.json` (OpenChamber's own `desktopHosts` / `desktopSshInstances`),
  Ember keeps listing it, and the tick box was greyed out. Every row now carries a **Forget**
  button, enabled whether or not the host answers, which records it in `hiddenInstances` so it stays
  gone across launches. Restoring it is ticking the row again once the host is back, or
  Settings → Endpoints for a Hearth host.

### Notes
- Forget hides; it does not edit OpenChamber's settings. That file belongs to another app, and a
  Hearth endpoint already has a real Remove in Settings → Endpoints. `src/lib/instanceMenu.ts` holds
  the per-row rule (toggle vs forget) and `instanceMenu.test.ts` pins it, including that a forgotten
  row is not offered a second forget.

## 1.0.1

### Fixed
- **A Hearth saved under two names is now one endpoint, not two watch sets.** `parsePiEndpoints`
  de-duplicated by id only, so a settings file holding the same host as `http://100.66.124.73:3002/`
  and `http://100.66.124.73:3002` — a migrated entry, or a machine saved once by tailnet name and
  once by address — kept both. Each entry opens its own full set of conversation streams, and
  every stream is a **mount** on the host, so a duplicate is not a wasted socket: it is a second
  copy of every open conversation held in the host's memory. Endpoints now collapse by normalized
  URL and the first entry keeps its label and token.
- **`PiClient` has a ceiling on the sockets it holds for one endpoint** (`MAX_SOCKETS_PER_ENDPOINT`,
  the watch set plus the task stream). Subscriptions are one socket each, so the cap should never
  bind — which is the point: a client that leaks sockets takes the host's descriptor table with it.
  On 2026-11-05 a client held thousands of connections to one Hearth, the host's `/health` went from
  milliseconds to timing out, and `systemd-oomd` killed it four times in an hour. Now a socket that
  would exceed the cap waits a backoff round instead of opening, and the count is released on every
  close — opened, failed or timed out — so the number cannot drift across restarts. `socketCount()`
  exposes it for tests and diagnostics, and the cap is injectable so the test can prove it binds
  without wedging the watch set.

## 1.0.0

### Added
- **Unified public MIT release (`ember-bots`)**: **Ember** (desktop & web control room), **Kiln** (`packages/kiln`, durable agent harness), and **Tinder** (`cli/ember.ts`, setup & remote launcher CLI) under a single monorepo with pure MIT licensing and local zero-config token discovery (`~/.ember/ember.token`).
- **OS-customized default `AGENTS.md` on `ember setup`**: generates `<home>/AGENTS.md` tailored for macOS, Windows (including Git Bash vs. Windows path rules), or Linux with computer navigation, Playwright MCP browser setup, provider configuration, and remote host pairing; Kiln's `agents_md` section falls back to `<home>/AGENTS.md` when a project directory has no `AGENTS.md` of its own.
- **Scheduled view tab (`Home · Sessions · Usage · Scheduled`)**: fourth top-bar tab with a notification counter for unseen finished runs, listing runs newest-first alongside the recurring plans that trigger them (`src/components/ScheduledView.tsx`, `src/lib/scheduledView.ts`).
- **Side questions (`?` / "btw …")**: replaced the composer's fork/handoff button with a `?` button (`POST /conversations/:id/btw`) that forks a hidden `Aside #N` worker carrying the conversation's full context and reports the answer back as a **Side question** card without interrupting the running turn.
- **Cross-host Agent Directory federation & 60/hour loop budget**: `PiClient` syncs peer lists across configured endpoints (`PUT /directory/peers`), `agents send` federates across hosts (`POST /directory/send`, labeling foreign messages with `[Message from agent <host>/<sender>]`), and `resolveAddressableAgent` resolves registry names and session titles within the active window with an all-time follow-up prompt.
- **Per-session `New Messages: Notify` / `New Messages: Don't Notify` toggle** in the column header and right-click context menus across the rail, project cards, and Home, alongside per-message unread dots inside the conversation column.
- **GitHub release update checker**: checks `noemit/ember-bots` on launch and every 6 hours, showing a dismissible `Update available` pill in the top bar when a newer release is published (`src/lib/updateCheck.ts`).

### Fixed
- **Bundled consecutive tool-only steps**: consecutive pure-tool assistant steps in a turn now fold into a single `"Used N tools"` rollup (`bundleConsecutiveToolMessages` in `src/lib/toolDisplay.ts`) instead of repeating `"Used 1 tool"` on separate lines.
- **Crew strip bricks no longer collapse to 12px slivers**: moved `@container` off `BRICK_CLASS` and onto the `group/strip` wrapper in `src/components/CrewStrip.tsx`.
- **Compaction failures and `repairHalt` recovery**: exposed `pi.live.compactionFailure` on conversation summaries, surfaced post-202 compaction task failures in `handleCompact`, and cleared `repairHalt` before re-reading the compacted transcript.
- **Composer focus glow & send button accent**: kept the composer border colour and width untouched on focus, using a soft outer `box-shadow` glow on `has-focus-visible` and turning the send button `bg-highlight` while focused.
- **Bounded watched conversation streams & lazy registry pruning**: `PiClient` now watches `on-screen ∪ busy ∪ 16 most recent` conversations (with `STREAM_LIMITS.burst` raised to `256`), and Kiln lazily prunes gone/archived conversations from `AgentsDoc` and bounds `agents.json` to 200 entries.

## 0.94.2

### Fixed
- **The "earlier messages aren't loaded" line could be scrolled out of sight — exactly when it was the
  only clue.** It was the first child of the scrolling pane, so in a session whose kept tail fitted on
  screen (a short session, or a tall window) it sat above the viewport and the reader was told
  nothing; when the tail was taller than the window it showed. The same state, two different surfaces,
  decided by content height. Measured at 1366×768 with a full read the breaker had given up on:
  window 832px, history 1085px, nothing visible.
  - The line is now a slim strip **between the Find bar and the transcript**, outside the scroll
    container — visible at every scroll position and at every content height. `flex-none` with its
    own `border-b` and surface, so it reads as a boundary above the conversation rather than as the
    first message in it.
  - Moved wholesale, not duplicated: the one-action rule still holds — **Compact** when the repair
    breaker has stopped retrying, **Load them** when a repair is still allowed, in the same words.

### Notes
- `transcriptOlderHistory.test.tsx` pins this structurally, because the failure is purely positional:
  the strip precedes the scroll container in the render and does not appear in its body at all, so a
  later edit cannot quietly move it back as a "header row". Four cases, including the action wording.
- **Not verified in the running app.** The dev mock serves its whole history in one page, so
  `historyComplete` is always true there and the line never renders; forcing it meant editing the
  mock, and that probe did not take before I stopped. The change is positional and the test asserts
  the position — but a screenshot of a real truncated session is worth having before trusting it
  fully, and this is the one part of this fix I have not seen with my own eyes.

## 0.94.1

### Changed
- **The reasoning level is a brain and its own word — `🧠 Low` — instead of signal bars.** The bars
  were the defect, not just the styling: they mapped the model's level *list position* onto four
  fixed shapes, so a two-level model (`off`/`high`) and a five-level one drew the same icons, two
  middles collapsed onto one, and a single bar meant "off", "minimal" or "the model's own default"
  indifferently. The meaning existed only in the tooltip, which is exactly where an icon-only control
  cannot put it.
  - The word is **the model's own name for the level**, capitalised — the same vocabulary the popover
    lists, so there is nothing new to learn and nothing to mis-map. An unset level reads **Default**
    rather than being drawn as the lowest bar, which claimed a level the model never had.
  - It collapses the way YOLO and YEET do: below the row's 460px container query the word goes and the
    brain stays (34px), with `aria-label` and `title` still naming the level.
  - A stored level the model no longer lists still names itself rather than reading as "Default" —
    settings outlive model catalogues.

### Notes
- `reasoningLevelPicker.test.tsx` pins the word (the model's own, capitalised, case-insensitive
  match, "Default" for none, an unlisted level still named) and the control (brain not bars, the
  collapse, the accessible name).
- The model label in the queue and the transcript footer keeps the level as plain text inside
  `provider / model · low`. That is a label, not a control: an icon there would be noise.

## 0.94.0

### Fixed
- **A grouped agent's name was unreadable, and the group header repeated one.** Two separate causes,
  one card.
  - **The header named a member.** A group made from one session's "Group with…" was seeded with
    `name: ''`, and `defaultGroupName` returned *that member's own title* for a single-member group —
    so the header either drew nothing or drew the first name again over a list that already said it.
    `defaultGroupName` now returns **"Group"** for one member (two or more still joins the first two
    titles, which is a real description of a set), and the header draws **no name at all** — the
    count, then `+`, Manage and Ungroup. The row keeps `aria-label="Open group …"`, so removing the
    visible name did not remove the accessible one.
  - **Member names were clipped into illegibility.** The card drew the project card's 48px blob strip,
    where a title is a two-line 10px chip clipped at 30px — so "Habit onboarding QA · copy pass" read
    as "Habit onboarding QA ·" and two members looked identical, at the width where grouping them
    mattered most. The group card is now a **list**: a blob and the whole title per row, at any rail
    width. The project card keeps its strip, which is right for a folder of sessions you recognise by
    face.

### Notes
- `groupRow.test.tsx` is the render test this row never had — the TODO had filed its absence as
  having already cost two bugs. It pins the reading: each member's full title is present, no title
  chip is drawn beside them, the header carries the count, a group named after a member does not say
  it twice, and the accessible name survives.
- Verified by mounting the real component in the running app at 300px: `3 agents` in the header and
  three full titles below it, with the needs-input dot on the member that is waiting.

## 0.93.0

### Added
- **Reading is now something you can do from the conversation, not only from Home.** Three controls,
  and each writes the same `readMarks` Home reads — one fact, two surfaces.
  - **A dot beside every unread message.** An empty circle in the left margin, revealed on hover like
    the Copy control: click it and it fills, shows a tick, and is gone — the mark is written
    immediately, so the control shows what just happened rather than asking twice. It is only on
    assistant messages (a prompt you sent is not news), and it stays reachable by keyboard.
  - **Mark everything read, in the column header** beside Close. The tooltip says the thing that
    surprises people: *reading a session never marks it on its own.*
  - **A quiet session** — "mark all messages as read; no notifications needed" — as a bell toggle in
    the same row. The policy lives on the session's read mark rather than as a separate setting,
    because the two are the same fact: a quiet session keeps its mark at the newest message, so it
    never shows as unread. It advances whether or not the column is open, which is the point — a
    scheduled brief that finishes while you are elsewhere should not wake Home up. Turning it off
    leaves every recorded read in place: those messages were seen.

### Notes
- `lib/readState.ts` gains `isQuietSession`, `advanceQuietMark` and `withQuiet`, pinned in six cases
  (it advances, never moves backwards, does nothing for a loud session, and toggling claims nothing
  was read either way). The transcript uses the same `entryOrdinal` the marks do, so a dot marked
  here and a dot marked on Home are one number.

## 0.92.2

### Fixed
- **The composer's focus outline was a dotted hairline across the top, and this is the second attempt
  at it.** The first fix replaced a wide outer ring with a 1px **inset** ring, on the theory that a
  same-colour hairline inside the border would read as the border thickening. It does, along the
  straight edges — but the border and the inset ring are two concentric arcs **1px apart**, and at a
  14px radius they round to different pixel columns. Measured on the rendered corner, the hairline
  carried a gap (`#+#` in rows 17-18), which is what the eye reads as pixelation.
  - **Focus now thickens the border itself** (`has-focus-visible:!border-2`) instead of drawing a
    second shape beside it. One edge means one set of pixels to round; the rendered corner is a
    solid 2px line with nothing to break.
  - The distinction the earlier attempts got right is kept: a plain click (any `focus-within`) tints
    the border, and only `:focus-visible` — real keyboard focus — thickens it.

### Notes
- Three tests in `composerOutline.test.ts` pin the shape rule rather than the pixels: focus thickens
  the border, nothing draws a ring or an outline beside it, and the tint-versus-thicken split holds.
  The previous two fixes had no test, which is how this came back.

## 0.92.1

### Fixed
- **The remote-access password field never said its minimum.** The button was disabled under eight
  characters and the input carried `minLength={8}`, so the rule was enforced but invisible: a person
  typing a short password watched the button stay grey with nothing on screen explaining why. The
  field now says **"At least 8 characters"** underneath, and once a password is set, that it is
  stored as a hash on this machine and never the password itself.
  - The `8` was hardcoded three times in the component; it is one named constant now
    (`REMOTE_PASSWORD_MIN`), mirroring `MIN_REMOTE_PASSWORD_LENGTH` in `electron/remoteAuth.ts` —
    which the renderer cannot import.

## 0.92.0

### Changed
- **The host kind is named for the product, not the protocol: `ember-harness` and `openchamber`.** The
  instance menu used to say `hearth` for a `pi` host and `local`/`remote`/`ssh`/`private relay` for an
  OpenChamber one — the first named an internal codename, the rest described how a host is *reached*
  rather than what answered, so a person reading the row could not tell the two kinds apart at a
  glance. Every row now says which of the two it is, with the address still beside it.
  - **Every user-facing string follows.** 23 in the app (empty states, provider settings, sign-in
    errors, the cost tooltip, the startup line, the directory) plus the dev mock's labels, the
    instruction preset's note and the README. "Hearth" as a *protocol* — the `hearth.crew-report` entry
    kind, `faux-hearth` the model provider, the `hearth:` event vocabulary — is untouched: those are
    identifiers on the wire, not things a person reads.
  - Deliberately lower-case, both of them: they are product names used as common nouns in a row
    ("`openchamber · http://… · live`"), and capitalising one and not the other would read as a typo.

## 0.91.1

### Removed
- **Five more plans, and the comments that pointed at them.** `COAGENTS_PLAN`, `HEARTH_UI_PLAN`,
  `DELTA_STREAM_PLAN`, `LOG_PANEL_PLAN` and `PI_TRANSITION_PLAN`. Fourteen source files, `AGENTS.md`,
  `README.md` and `e2e/crew.pw.ts` carried a pointer to one of them; each now says the thing the
  pointer was standing in for. Two examples: `FollowUpChips` said "the decision recorded in
  HEARTH_UI_PLAN.md" and now says *why* a chip sends rather than fills the composer; `liveStream.ts` pointed at
  `DELTA_STREAM_PLAN.md` and now opens with the fact that Hearth's stream has been state-based since
  0.41.0.
- **The last personal name in a test.** `e2e/pi.pw.ts` used `Castle (test)` as an example endpoint
  label; it is `Studio (test)` now, matching the unit suites.

`HOME_PLAN.md` stays: phases 3–5 have not shipped, and every reference to it is still accurate.

## 0.91.0

### Removed
- **Ten plan files that describe work already shipped.** `AGENT_GROUPS_PLAN`, `IMAGE_ATTACHMENTS_PLAN`,
  `IMAGE_VIEWER_PLAN`, `INTERRUPT_PLAN`, `MULTI_SESSION_PLAN` (partly obsolete: the tab strip it plans
  was removed in 0.89.0), `NEW_SESSION_PLAN`, `PERF_1_3_PLAN`, `UI_UX_AUDIT` (an audit of 0.10.0, ~30
  versions stale) and `futurefeatures`. A public reader has no way to tell a 0.16.0 plan from a
  current one, and git keeps every one of them.
  - Two source comments that pointed at `NEW_SESSION_PLAN.md` now carry the reason instead of the
    pointer: `mockPi.ts` (why a retry re-asks the same request id) and `pendingCreate.ts` (why the
    bubble is not withheld until the host answers).
- **`home-exploration/` (3.3 MB, 46 files) and `home-mockup/`** — the Home screen's design exploration
  and its static wireframe. Working process, not the product, and 3 MB of PNGs in a client repo is
  noise. `buddy-arena/` stays: the blob silhouettes were reviewed there.
  - The two `AGENTS.md` references to `home-mockup/` and one in `HOME_PLAN.md` went with it — a doc
    that tells a contributor to run a script that no longer exists is worse than no doc.

## 0.90.6

### Notes
- **`WORKER_REPORTS_INVESTIGATION.md`**: where the noise in a crew's report-back actually comes from,
  and what could be quieter. The answer is Hearth-side (`src/crew.ts` `tick`), not Ember-side — Ember
  only renders reports. Three findings:
  - A report is written into the leader's transcript **the moment its worker settles**, and the
    quiescence wake then **repeats it in the digest** — so a six-worker fan-out has the leader read
    five reports as entries and then again as digest lines.
  - Nothing distinguishes "done, nothing to say" from "done, with a finding". A brief could carry
    `report: 'on-failure'` and a routine success would cost neither a transcript entry nor a digest
    line; `session status`/`results` already exist for a leader that wants details.
  - The 15-minute deadline wakes a leader even when every line is `(no report yet)` — deliberately,
    and pinned by a test, so it is the one of the three I would leave alone.
  No code changed. Each finding names the file, the function and the evidence.

## 0.90.5

### Changed
- **The "Ultra delegator" preset tells the bot not to do the work at all.** It used to allow it
  "only when it is smaller than the brief it would take to hand over, or when no worker can reach
  it" — a rule with two judgement calls built in, and the first one is exactly the excuse a bot
  reaches for. It now says plainly: *don't ever do work yourself; your job is mostly to talk to the
  user and watch what the workers are doing.*
- **And to answer the person first.** The old closing line made the reply a report ("what was done,
  where, and what is left") — true of the end of a job, and wrong at the start of one. The preset
  now asks for an immediate, clear reply even before a worker has been sent off, so the person is
  not left watching a spinner while the bot decides who to call.

### Notes
- Only the preset's text changed. A session already started with the old instructions keeps them —
  standing instructions are stored per session, not read from the preset at run time.

## 0.90.4

### Fixed
- **The YOLO and YEET toggles had too much space to the right of their icons.** Both carried
  `px-2` with the shared toggle's `gap-2`, and below the 490px container query the word after the
  icon is `hidden` — so the gap resolved against a label that was not there and the button was
  wider than its contents, with the padding reading as dead space on the right. Measured in the
  icon-only state: 32px wide now, 9px either side of the icon, symmetric. The padding and gap
  tighten to `px-1.5`/`gap-1`, which is what an icon actually needs, and the right padding grows
  back to `pr-2` only when the word appears.

## 0.90.3

### Fixed
- **An OpenChamber session no longer shows a cost.** It was showing one, and the badge could not say
  what it was: Hearth's number comes from a usage ledger that priced every turn, while OpenChamber's
  is the model's *rate* applied to its own token count — an estimate that has never been reconciled
  against a provider's invoice. Two different kinds of number under one badge, with no way for a
  reader to tell which they were looking at.
  - Cost is now a **Hearth capability** (`hostReportsCost` in `lib/sessionCost.ts`), and an
    OpenChamber column draws **no cost state at all** — not "Cost unknown", which would claim the
    host tried and reported nothing. That badge still appears where it belongs: a Hearth session that
    ran without a priced turn.
  - The gate covers every cost surface: the header badge, the view menu's "Spent" line, and the
    per-turn footer.

### Notes
- OpenChamber support is otherwise untouched — sessions, approvals, tools, queued follow-ups and
  metadata all render as before. Verified against the `?legacy` mock: a real session opens with the
  approval card and the folded tool line, and carries no cost badge.
- `ModelPicker` still shows a model's input/output rates. That is the provider's price list rather
  than this session's spend, so it is honest for both host kinds and stays.

## 0.90.2

### Changed
- **The test suites no longer carry a real Tailscale address.** Four suites used the owner's tailnet
  address and machine name as their example endpoint (`<tailscale-ip>`, `<host>.ts.net`).
  A tailnet address is only routable inside one tailnet, so it was never a credential — but it is
  somebody's machine, and it tells a reader the shape of a private network. They now use
  `100.64.0.1` (the first address of the block Tailscale carves from) and `box.example.ts.net`, and
  the one assertion that derived an id from the address expects `pi:100-64-0-1`. Fixture labels
  `Castle` → `Studio`. No behaviour changes; the suites are byte-identical otherwise.

### Added
- **`SHARE_AUDIT.md`**: what to clear before this repo is public — the addresses above, sixteen
  plan files (~200 KB, several describing phases that shipped versions ago), and the 3.4 MB of
  design exploration in `home-exploration/` and `home-mockup/`. It records what is already fixed
  and what is a judgement call, and keeps `AGENTS.md`, `TODO.md`, `openquestions.md`, `maybe.md`,
  `CHANGELOG.md` and the licence.

## 0.90.1

### Fixed
- **"i have too many gardeners": the same noun came back in a folder of sessions.** The roster was
  never the whole story. Three things kept a rail from getting its own characters:
  - **The bounce only ever reached animals.** A message that named no kind of work drew a creature on
    step 0 *and on every bounce after it*, so a hundred idle sessions were the same 22 creatures on
    repeat whatever the ranking did — measured on 0.88.1, 100 idle sessions held **22 distinct nouns,
    worst 11**. Bounces now draw from the whole roster.
  - **The walk ranked the message's own noun above everything.** A folder of "fix …" sessions could
    only ever be Mechanics: measured, 100 of them held **34 nouns but 29 of them Mechanic**, and a
    40-session mixed rail was **12 nouns with two of them eight times each**. The ranking is now the
    noun the rail already holds too often — the thing a person actually reads as "the same session
    again" — and the message's own noun wins ties by being *first in the walk*, so a lone fix session
    is still a Mechanic.
  - **The walk could not see every noun, and the pool was thin.** `CANDIDATE_STEPS` was 96 and the
    step-to-noun draw only reached some of the roster; the ranking also let one noun's adjectives fill
    the candidate list. The walk now keeps one entry per noun, runs long enough to reach all of them,
    and the roster grew from 64 to **96 nouns** — 32 matched trades, **22** keyword-less crafts (up
    from 10) and **42** creatures (up from 22).
  - All of it is measured on the new build:

    | rail | before (0.88.1) | after |
    |---|---|---|
    | 100 idle sessions, accumulating `taken` | 22 distinct nouns, worst 11 | **96 distinct, worst 2** |
    | 100 "fix …" sessions | 34 distinct, **29 of them Mechanic** | **96 distinct, worst 2** (Mechanic twice) |
    | 40 mixed messages ("fix", "plan", "ok", "tidy", "how") | 12 distinct, worst 8 | **40 distinct, worst 1** |

  - **`Gardener` was not being reached by keyword.** Every "garden"-ish message was checked (garden,
    plant, grow, seed, prune, tree, herb, harvest, water, root, budget) and none matched it — `garden`
    is not a keyword on any role, and `Gardener` has no keywords of its own. It entered only through
    the *collision* walk, as one of the ten keyword-less person nouns a bounce could land on — so a
    folder finished the trades it could see and then started repeating the same ten gardeners and
    bookbinders. That was the "too many gardeners", and it was a noun-*variety* problem, not a tone
    one: the fix is the wider roster and a bounce that can reach all of it.

  - **A creature on a bad day still draws only the alarmed row** (*Startled*, *Spooked*, *Ruffled*),
    a crash still never draws a placid word, the tone still carries ≥55% of 200 draws per tone, and no
    word of the message can reach a name. A lone "fix …" session still lands on Mechanic; a hundred of
    them are a band of colleagues.

### Notes
- `src/lib/sessionNames.ts`: the roster (creatures and keyword-less crafts), `creatureFor`,
  `deriveSessionName`'s candidate walk (one entry per noun, ranked by how often the rail already
  holds that noun), and `CANDIDATE_STEPS`.
- `sessionNames.test.ts` gains a **breadth** block that measures the rail rather than one name: a
  hundred idle sessions and a hundred "fix …" sessions each keep every noun to ≤3, 40+ distinct
  nouns, a single fix session lands on Mechanic ≥190/200, no two neighbours in a rail share a noun,
  and every noun in the roster is reachable. The tone, placid-word, message-leak and variety tests
  are unchanged and still pass.
- `AGENTS.md`'s naming paragraph now says what the walk does with a `taken` list, because the old
  one described the ranking this build replaces.

## 0.90.0

### Added
- **Tools can be folded into one line.** A turn that uses tools now draws them as **"Using tools
  (3)…"** — the count grows as the turn runs, and becomes **"Used 3 tools"** once it finishes — with
  the usual rows behind a click. Opening it gives back exactly what the list drew: `Read 2 files`,
  `bash`, each openable for its arguments and output. Asks, reasoning and prose are untouched; tool
  blocks **carrying images** never fold, because the transcript shows those even when tool rows are
  hidden and a count would lose the picture rather than defer it. Off by default: `list` is what the
  transcript has always drawn.
- **The view menu says which of the two you are in.** *Expand tool calls* is now **"Expand tool call
  details by default"** (it says *when*, not *that*), and a new **"List all tools"** turns the fold
  off entirely. Both are **absent** while "Show tool use" is off rather than greyed out: a disabled
  checkbox for something that would change nothing either way is a switch that lies about what it
  would do.

### Notes
- `src/lib/toolDisplay.ts` holds the three rules — the phrase, the count and the fold test — and is
  pinned in `toolDisplay.test.ts` (12 cases: live vs finished wording, counting calls rather than
  rows, image blocks excluded, the two menu options and their absence).
- The count is per message, since that is where the blocks live; a turn spanning several messages
  shows a line per message rather than one figure for the whole turn. Worth revisiting if that reads
  as two counters.
- Verified in the app against a fixture with four calls: the folded line reads "Used 4 tools",
  expanding it brings back `Read 2 files` and `bash`, and the fixture was not committed.

## 0.89.4

### Changed
- **A crew brick's "auto" chip is now the composer's YOLO chip.** They were the same thing — a
  worker inherits its spawner's auto-accept, and the chip toggled the same server-side setting — but
  the brick said "auto", which names the mechanism rather than the mode, so one feature looked like
  two. The brick now draws the same `ShieldCheck` and the same word the composer does, in the same
  warning tone, and collapses the same way: below about 420px the word goes and the shield stays.
  - The `@container` is on the **brick**, not the strip: a wrapped row of chips has no one width, and
    the collapse should answer to the room each chip actually has.

### Notes
- The chip's accessible names are "Turn off YOLO mode for <worker>" / "Turn on YOLO mode for
  <worker>", matching the composer's toggle, so a screen reader hears one vocabulary. The off state
  stays hover/focus-only: seven bricks should not carry seven words for a mode most crews inherit
  together.

## 0.89.3

### Changed
- **The queue's whole-list action now says what it does.** "Merge all" is "Merge all queued
  messages", and the "N messages become one" note beside it is gone: the button names the action, and
  a count that restated the number already written on the queue was one line of chrome too many.
  The accessible name keeps the count, because that is the one place it is useful — spoken, with no
  list in view.

## 0.89.2

### Changed
- **A queued steer no longer spends its one line on "waits for the turn to pause".** The row's text
  is the message; the fact that the host is holding it until the running turn pauses is a small
  spinner at the row's trailing edge instead. It is announced ("Waiting for the turn to pause") but
  not written, so nothing is lost for a screen reader.
  - The **leading** spinner stays what it was: a row still being created (`queueing…`). The two are
    different facts — "not placed yet" and "placed, held" — and a row never shows both.

## 0.89.1

### Fixed
- **Clicking the composer tray that is already open now folds it.** The tab did nothing when it was
  already selected: it re-selected itself, so the only way to put a tray away was the small chevron
  on the right — a second control for a gesture the tab already implies. A tab is now both "show me
  this tray" and "put it away": clicking the open one folds the shelf, clicking it again brings the
  same tray back. `aria-expanded` on the selected tab says which it will do, and the decision is
  `nextShelfState` in `ComposerShelf.tsx`, pinned in three cases.

## 0.89.0

### BREAKING
- **The tabbed session strip is gone.** `ColumnTabStrip` was a numbered line above the chat holding
  every open session that was not currently a column — overflow and anything minimized. It no longer
  exists: a session that is not open is simply in the rail, where it always was.

  What replaces it, per the owner: **one session at a time.** Clicking a row takes the view over,
  and **closing a column returns the session to the rail** — closing is now what the minimize button
  does, so it is labelled "Close this column" and the state it produced (a sticky minimized session
  waiting for a tab that no longer exists) is gone.

### Added
- **Split view, off by default.** Settings → Sessions gains a toggle: on, opening a session adds a
  column beside what is already open, as many as fit (`MIN_COLUMN_WIDTH` 420), active first so a
  click never opens off screen; off, a click replaces. This is the old side-by-side behaviour without
  the strip — nothing is ever hidden behind a tab, so the setting is the only thing deciding whether
  two sessions share the screen.

### Notes
- `visibleColumns` (`src/lib/workspace.ts`) now takes the active key and an options object rather
  than a minimized set: `(active, open, width, { splitView, minWidth })`. Its tests were rewritten
  for the new contract, including the case that used to overflow into a tab (four open, two fit, the
  active one must be one of the two).
- `openSession` no longer groups by project before deciding to add a column — that rule is what made
  the old columns disagree with the strip. Split view decides; when it is off the outgoing project's
  layout is still stashed under `projectLayoutsRef`, so returning to a project restores it.
- The Electron settings reader has an explicit field allow-list; `splitView` was added to it, and the
  dead `pinnedMessages` field was dropped from `electron/transport.ts` and the desktop store after
  the pin removal in 0.87.0 missed that half.

## 0.88.1

### Fixed
- **The tone of a message did not reach its name: a crash came out "Observant Mechanic".** `detectTone`
  was right and the name was wrong, for two structural reasons in `src/lib/sessionNames.ts`. Every
  pool was `[...COMMON_ADJECTIVES, ...its own words]` — 22 shared words with 6–12 tone words
  appended — and the draw hashes over the whole row, so 65–80% of the time a tone word was simply
  never reachable. And several of those shared words were wrong for **every** tone: *Observant*,
  *Watchful*, *Wary*, *Alert* (surveillance) plus *Gentle*, *Patient*, *Unhurried*, *Content*,
  *Cheerful*, *Dapper*, so "Gentle Beetle" for a crash was the same defect as "Gentle Mechanic".
  - **The tone's own words are now almost all of every row.** Each row carries exactly one shared
    word (*Keen* for breakage, *Steady* for building and routine, *Thoughtful* for curiosity), so
    the measured share of a tone-carrying draw is **95–100% for every tone**, up from 31–38% for a
    matched trade. Measured on 200 seeds per message:

    | first message | tone | before: tone-share | after: tone-share |
    |---|---|---|---|
    | `fix the tailnet reconnect flapping` | breakage | 38% | **100%** |
    | `FIX THE RAIL IT KEEPS JUMPING` | breakage | 38% | **100%** |
    | `fix the flaky test` | breakage | 38% | **100%** |
    | `plan the migration to the new schema` | building | 33% | **100%** |
    | `can you tidy the changelog` | routine | 31% | **100%** |
    | `ember 0.85.0 crashes on launch` | breakage | 67% (creature row, but placid) | **100%** |
    | `ok` | neutral | — | 29% (neutral has no "own" words; 189 distinct names) |

  - **The placid words are gone from everywhere a crash can reach.** *Observant*, *Watchful*, *Wary*,
    *Alert*, *Gentle*, *Patient*, *Unhurried*, *Content*, *Cheerful* and *Dapper* now live only on
    `neutral`, and `neutral` is not reachable from any tone-carrying message. A creature on a bad day
    draws its own emergency row — *Startled*, *Spooked*, *Skittish*, *Flustered*, *Ruffled*,
    *Bristly*, *Edgy* — so `ember crashes on launch` reads **Ruffled Hare**, not "Gentle Beetle".
  - **Each tone has its own register, and the brief's words are all reachable.** Building draws
    *Diligent*, *Methodical*, *Deliberate*, *Inventive*, *Studious*, *Careful*, *Thorough*; routine
    draws *Brisk*, *Deft*, *Spry*, *Snappy*, *Tidy*, *Neat*, *Handy*, *Prompt*; curiosity draws
    *Curious*, *Inquisitive*, *Inquiring*, *Perceptive*, *Attentive*, *Thoughtful*. `neutral` stays
    the widest, calmest row and the only home of *Lazy*, *Sleepy*, *Drowsy*.
  - **The collision walk no longer buries the tone either.** With a `taken` list the walk keeps the
    best free draw, ranked by the message's own noun and then by the tone — so a crash with no
    matched trade, whose only nouns are creatures, no longer bounces through 22 calm-row creatures
    drawing a placid name every time. With nothing taken the first draw wins outright, so the
    ranking only ever breaks a tie a collision created.
  - **Variety did not come back down.** The 12-Mechanic collapse stays impossible: a message that
    matches a trade draws 21–29 distinct names over 200 seeds, and a creature keeps 15 adjectives ×
    22 creatures (153).

### Notes
- `src/lib/sessionNames.ts`: the pools, `SHARED_*`, `CREATURE_BREAKAGE` / `CREATURE_CALM` and
  `deriveSessionName`'s collision selection. Still pure, offline and deterministic; the noun is still
  the fixed roster and no message word can reach a name.
- `sessionNames.test.ts` now **measures** the property instead of trusting the comment: for each
  tone, ≥55% of 200 drawn names carry a tone word; a crash never draws any word from the owner's
  placid list; a crash's and a plan's adjective sets are substantially disjoint (≤1 shared); every
  tone keeps 20+ distinct names over 200 seeds; and the no-insult / no-thing-state / no-message-word
  rules still hold.
- The comment claiming "the tone is legible" was false when measured, and is now the measurement:
  the file header and the pools' doc comment say what is true and why the earlier shape failed.

## 0.88.0

### Changed
- **A session is called "Lazy Librarian" instead of "What Gardener".** The owner's verdict on the
  last naming pass was "the names are still terrible (the words before the roles)", and "What
  Gardener" is the bug stated exactly: a word lifted out of the first message — "what", "handle",
  "way", "access" — sat where a person's name goes and read as noise. The old scheme deliberately
  *read the message backwards* past two stop lists to find a subject word, which is a lot of
  machinery for a word that was never going to sound like somebody.
  - **The noun always comes from a fixed roster, and the message can never contribute one.** That is
    the whole fix: it is not that "what" is now filtered out, it is that there is no code path from a
    message token to the name at all. 32 trades matched from the imperative or a keyword (fix →
    Mechanic, plan → Cartographer, research → Scout) plus **22 creatures** (Fox, Magpie, Otter,
    Heron, Badger, Stoat, Puffin…) which carry a session when nothing matches.
  - **The adjective carries the tone.** `detectTone` classifies the message into breakage, curiosity,
    building, routine or nothing, and the tone picks the adjective: a crash or a flapping reconnect
    is *Frantic* or *Overworked*, a plan is *Patient* or *Diligent*, a question is *Curious*, small
    tidy work is *Brisk*. All five rows start from the same shared middle, so "Patient Mechanic" and
    "Diligent Fox" are one kind of sentence.
  - **The tone reads the vocabulary a report actually uses.** "ember crashes on launch", a pasted
    `TypeError` with a stack trace, "it drops my paste every time", "keeps resetting my scroll
    position", "the page goes blank" all read as breakage now — they used to read as calm, which
    produced "Gentle Beetle" for a crash. A question word no longer outvotes a report: "WHY DOES IT
    DROP MY PASTE EVERY TIME" is a complaint, not curiosity.
  - **The pools are wide on purpose.** Each tone row is the shared middle *plus* its own words, and
    the collision walk redraws both the noun and the adjective from that noun's own row. A narrow
    per-tone row plus a verb that pins the noun meant every "fix …" session could only ever be one of
    twelve Mechanics; measured, 200 distinct seeds of one "fix the flaky test" now give **34 distinct
    names**, and a seed whose message matches a trade keeps that trade on its first draw.
  - **The folder and the project no longer leak into the name.** They are **seed only** now, which
    is what stopped a session in `/workspace/hearth` being called "Hearth …" — a directory read as a
    colleague. `App.tsx`'s `newSessionTitle` passes neither, and says so.
  - **Collisions still resolve, and never duplicate.** Same input → same name (one FNV-1a hash of
    the seed), and a `taken` hit steps the seed and redraws, preferring a name that keeps the
    message's own noun before bouncing to another — so two "fix the flaky test" sessions in a folder
    are two colleagues rather than the next adjective down a list. Only a fully exhausted set is
    numbered; 100 successive collisions never reached a number.
  - **The draw was fixed while it was there.** `hash % size` gave near-neighbours the same bucket
    (six first messages differing by one character gave six identical names), and the usual finalizer
    has an anniversary on short sequential ids. Finalising and then bucketing the 32-bit range gives
    311 distinct names from 400 seeds (worst bucket 4).

### Notes
- `src/lib/sessionNames.ts` is the rule. Exported: `deriveSessionName`, `detectTone`, `matchRole`,
  `ROLES` (each entry now says `kind: 'trade' | 'creature'`), `ADJECTIVES` (by tone),
  `MESSAGE_VOCABULARY` (a test hook), `hashSeed`, `titleCase`. Gone with the topic ladder:
  `topicOf`, `COMMON_WORDS`, `commonForm`, `STOP_WORDS` pruning, the singular/verb tables and
  `WEAK_WORDS`. Still pure and offline: no model call, no randomness.
- `sessionNames.test.ts` is rewritten to assert **qualities**: every name is a pool adjective plus a
  roster noun and nothing else; no name contains a word from a message that says "what", "handle",
  "way" or "endpoint" (unless it is a roster noun, which is a person); same input → same name; 200
  distinct seeds give 130+ distinct names with no runaway collision; `taken` never returns a
  duplicate; each tone yields its own pool (including "a creature on a bad day is wary, never
  feverish and never cheerful"); the pools have no duplicates and no insulting or
  object-state words ("Broken", "Battered", "Clumsy"); and the worst adjective-noun contradictions
  are pinned.
- `e2e/newSession.pw.ts` no longer asserts `/Ambiguous Create Gardener/` — that fixture name came
  from the old topic ladder lifting "ambiguous" out of the message. It now asserts one rail row named
  the new way (`/^[A-Z][a-z]+ [A-Z][a-z]+/`) and **no** row containing "Ambiguous", which is the
  property that matters. `e2e/pi.pw.ts`'s naming test asserted "Tailnet Mechanic" for the same
  reason; it now asserts a `<Adjective> Mechanic` that does not say "Tailnet". Both suites pass.

## 0.87.2

### Fixed
- **The crew's coloured chips sat too close to the tab above them.** The shelf's panel gave every
  tray 2px of top padding, which is enough for a text row but not for a pill sitting directly under
  its tab — the crew bricks read as crowding it. The panel now pads 4px at the top, so the gap
  between the tab's edge and the first chip is 4px instead of 2px (measured: tab bottom 752, chip
  top 756).

## 0.87.1

### Added
- **`openquestions.md`**, a live list of the questions that could not be settled while doing the
  work — the ones where a different answer would change the design rather than the wording. Each
  entry records what was decided for now (so the app is never blocked), what is still open about it,
  and what evidence would settle it. The convention is written into `AGENTS.md` beside `TODO.md` and
  `maybe.md`: write it when you hit it, delete it when it is answered.

  The first three are real and current: whether the 90-minute process deadline should survive an
  Ember restart, whether the countdown should admit it only runs while the window is open, and
  whether an extension should have a ceiling.

## 0.87.0

### BREAKING
- **Pinning a message is gone.** The Pin button in a message's hover gutter, the **Reply** chip the
  footer drew on a pinned message, the pinned-messages dialog and the pin badge in the column header,
  the pin counts on rail rows, blob strips, group cards and project cards, and `lib/pins.ts` with its
  `pinnedMessages` setting are all removed. An existing settings file's `pinnedMessages` is ignored
  and the pins in it are lost; nothing else reads it.

### Changed
- **Copy moved 2px right.** It was the upper half of the hover gutter, sharing the column with Pin;
  now it is alone there, nudged so it reads as centred over the card's edge rather than tight
  against it.
- **"Replying with pinned context" is now "Replying with context"**, and the wire's *"Earlier pinned
  message being replied to:"* is *"Earlier message being replied to:"*. The mechanism stays — a
  comment or a restored draft can still carry context into a send — but the pinned-message dialog
  was the only thing that ever set it from the transcript, so the old wording claimed something the
  app can no longer do.

### Notes
- `ChatView`'s `hasOlderHistory` existed only to warn the pinned dialog that some of its messages
  were above the loaded window; it went with the dialog. `replyToMessage` went too, since its only
  caller was the dialog's Reply action.
- Tests that pinned the removed feature were rewritten rather than deleted: the footer asserts no
  Reply chip and no Pin, and the blob strip asserts no pin badge, so the absence is now the thing
  under test.

## 0.86.0

### Added
- **A session's leftover programs get their own tray, and a deadline.** They used to be a notice
  above the composer, which pushed the input down every time a dev server started or stopped. They
  are now a fourth tray on the existing composer shelf, beside Queue, For later and Crew: a tab
  reading **Processes 2**, opened on demand, with no tab at all when nothing is running.
- **A ninety-minute deadline per program, counted from when it started.** The row says
  *expiring in 80 min* instead of *since 18:12*, because the number that matters is how long there
  is to decide — and the clock beside it buys another ten minutes, with presses adding rather than
  replacing (80 → 90 → 100). A program past its deadline reads **expiring now** in the destructive
  colour, and the tab carries the attention dot for it.
- **Ember stops what is due.** The host has no expiry of its own — a leftover program outlives the
  turn that started it until something stops it — so this is the client's job, and it only works
  while Ember is running. The deadline is fixed per program, so a window opened an hour later finds
  more of them due rather than granting a fresh ninety minutes, and the first tick after a restart
  reaps everything already past its time. It is scheduled on the next deadline rather than polled,
  and a stop that does not land backs off (2s, doubling, capped at 30s) instead of hammering a host
  that is asleep.

### Changed
- The calm sentence is now **"This agent has 2 programs running. Stop them when you no longer need
  them."** — it names the agent and offers the choice, instead of describing what will keep
  happening.

### Notes
- `src/lib/processExpiry.ts` holds the deadline arithmetic, the countdown wording and the plan of
  what to reap; `src/hooks/useProcessReaper.ts` is the timer. Both pure parts are pinned in
  `processExpiry.test.ts` (19 cases: the fixed deadline, an extension adding, "0 min" never being
  shown, the ladder, and the per-host session key).
- The extension lives in `App` beside the reaper, so the countdown a person sees and the timer that
  acts read one number. It had to be passed to `ChatView` as a **map rather than a lookup function**:
  `useStableProps` pins function props to their first identity for `React.memo`, so a callback would
  have served the extension the window had when it opened.
- Verified in the running app against a dev-mock session: the tab, the countdown, the +10 (80 → 90 →
  100), the overdue state, and an automatic stop on mount with no click. The fixture and the mock's
  `POST …/processes/stop` route were not committed.

## 0.85.0

### Changed
- **The client speaks Hearth 0.41.0's state wire.** pi-durable 1.5.0 removed the event protocol, so a
  stream sends a `view` on attach (the live documents, never history) and then only what moved:
  `text` (the appends the host already reduced), `appended` (entries that landed) and `changed`
  (a `kinds` list naming what a tail read should refresh). `electron/piClient.ts` maps each frame onto
  the hint the renderer already understood, so `invalidation.ts` keeps one vocabulary; the event
  type whitelist and the `changes` reducer are deleted, because deriving the appends moved to the
  host that sees the operations.
- A `view` — an attach, or an overflow that could not deliver every commit — now asks for one bounded
  tail read, which doubles as the repair for anything the overflow skipped. Background sessions still
  get a summary refresh rather than a transcript read, so 200 watched conversations stay cheap.
- **Ember and Hearth move together:** this build needs Hearth 0.41.0 or newer, and a Hearth on
  0.40.0 or older no longer streams to it (the conversation list and every REST read still work).
  There is no compatibility mode, by decision: the three Hearths and the one client are ours.

## 0.84.2

### Fixed
- **It was hard to scroll up from the bottom of a live chat: the first inch of every scroll was
  spent fighting the pin.** While a turn is streaming, each chunk grows the content and the
  transcript's pinned `ResizeObserver` scrolls back to the end to keep up — so a reader's wheel up
  competed with it frame by frame. Measured in the app on a 96-message session with a turn running:
  one 100px wheel up moved the view 40px and then held it there for 2.4s, until the reader had
  cleared `FOLLOW_THRESHOLD` (48px) by main force. That fight *is* the complaint.
  - **An upward gesture now leaves the end immediately.** `handleScroll` can only decide from a
    finished scroll event, which is one resize too late; a wheel or finger moving up is
    unambiguous (content only grows downward, so nothing else scrolls that way), so it disengages
    following the moment it arrives — before any chunk can pin the reader back.
  - **Deliberately not gated on the 48px threshold.** The threshold exists to tell a reader's
    scroll from a layout clamp, which is a question only the scroll event can answer; a gesture
    carries its own intent, and making the reader travel 48px of contested ground first is the
    bug. At `scrollTop 0` nothing is disengaged — that is elastic overscroll, and the scroll event
    still decides.
  - Touch is handled the same way, from the finger's own travel. A reader who is *already*
    following and sits at the bottom still stays pinned: after the fix a streaming turn held
    `scrollHeight - scrollTop - clientHeight` at 0 across ten samples, with the new content arriving.

### Notes
- The decision is `gestureLeavesBottom` in `src/lib/scrollIntent.ts`, pure and pinned in
  `scrollIntent.test.ts` (four cases: one tick is enough, a downward tick changes nothing, an
  already-departed reader is not told twice, a fling at the top is overscroll). The event wiring
  stays in `Transcript.tsx` beside the existing `scrollIntent` rule it complements.
- Reproduced and verified against a 96-message fixture served by the dev mock, with a turn
  streaming; the fixture was not committed.

## 0.84.1

### Fixed
- **There was no way to promote a worker, and the control had been missing for ~20 versions.** The
  header rendered a promote button only when `session.kind === 'worker'`, and a worker's conversation
  summary does not carry `kind` — so a real worker's column showed More actions, Minimize and Archive
  and nothing else. Reported as "there's no way to promote an agent rn from what i can see", on a host
  with a running crew. The button is back, **labelled** ("Promote to peer", beside the title rather
  than an icon in the overflow) and the predicate no longer trusts `kind` alone: a conversation that
  appears in its leader's crew list is a worker too, and that list is what the crew strip is drawn
  from.
- **The Directory tab is gone.** Owner: "remove the directory tab." It listed a per-host registry that
  is now filled in automatically, so there was nothing left to go and browse. Removed with it:
  `DirectoryView.tsx`, its e2e suite, the top bar's tab and the per-host `GET /directory` poll whose
  only consumer was that page. `lib/agentDirectory.ts` and `loadDirectory` stay — the pure mapping and
  the resolver behind a future cross-host `send` (see `TODO.md`).

### Notes
- Registration itself is automatic now, on the host: every session `session spawn` creates is
  registered under its title in the same commit (Hearth 0.38.0, `registerAgentWithSuffix`). Promotion
  is therefore only for turning a worker into an openable, top-level peer, not for giving it a name —
  and it stays a human action, because it forks the conversation and changes who owns it.
- The pi mock follows both rules: a spawned conversation gets its title from the brief and registers
  itself, `GET /directory` reflects what is actually registered (plus the pinned fixtures), and a
  promotion of a title that is already taken is refused. `e2e/crew.pw.ts` pins the promote wire (busy
  409, non-worker 400, duplicate name 400) and that the directory lists spawned sessions without
  anyone promoting anything.

---

## 0.84.0

### Changed
- **A working Lava blob actually moves now.** Owner: "the active state needs more movement." Busy used
  to be one droplet pinching off inside an otherwise still body, which at rail size read as a still
  picture. It is now four motions at once, on four clocks:
  - **The whole goo rises and rocks** — 2.4 units of travel and a 5° lean over 6.2s, the way convection
    rolls a lamp's lump. The lean is the part that carries at 30px, where a one-pixel float is
    invisible.
  - **The main lobe swells and squashes**, non-uniformly, so its two axes move against each other and
    the necks to the other lobes thicken and thin.
  - **Any middle lobe drifts** toward the body and back out along its own vector, on its own period.
  - **The bud is thrown rather than slid**: it now bends off the outward line as it leaves, so it arcs,
    and the throw is quicker (2.6s).
  - The pool churns faster while a faster glow turns the other way inside it.
  - Measured on a 55px busy blob: the silhouette changes 3.3% of its area per 140ms, against 1.1%
    before, and sways 6px sideways against 0.5px. Idle, unread and error still draw nothing at all;
    thinking still holds its outline still and only churns the colour, which is the difference the eye
    reads between "working" and "reasoning".
- **Pools are soft-edged radial gradients now**, not one blurred group. A pool belongs to its lobe and
  has to travel with it, and a filter per lobe would repaint the whole blob again for each one. This
  is also why the extra motion is free: one goo filter per blob, and a busy blob re-evaluates it once
  a frame. Four busy 55px blobs hold 60fps at 2× DPI; a pathological page of 32 runs ~46fps and is
  still faster than before the gradients (the dropped pool blur paid for the transforms). A 55px busy
  blob now carries two `blob-lava-core` groups (body and pools) that share one animation from one
  origin, so the goo never comes apart while it swells.

### Notes
- `lava.test.tsx` pins what the motion depends on: every shape fits at any turn, the droplet overlaps
  at rest and clears the goo's bridging distance at the peak *including* the sideways bend, a drifting
  lobe stays inside the box, every pool stays inside its own lobe, busy runs four animations on four
  distinct durations, and the core's keyframes actually squash rather than merely breathe.
- Checked by eye at 22/30/55/96/150px, in a 27-blob busy grid, on Stone, Clay and Graphite, at 1× and
  2× device pixels, and against the previous build side by side; the measurements above come from
  frame-by-frame silhouette masks of the same seeded blob before and after. Not run in the packaged
  Electron app.

---

## 0.83.1

### Fixed
- **A message's Copy sat where the metadata goes, and a code block had no Copy at all.** Two halves of
  one complaint.
  - **Copy moved out of the footer and into the message's hover gutter**, above the pin — so the
    gesture that reads a message as Markdown is next to the one that pins it, in one place per row.
    The footer is now only what it is named for: a message with no model, cost, duration or pin draws
    no footer line at all (`MessageFooter` returns null) instead of an otherwise-empty rule, and Copy
    survives that because it is no longer inside it.
  - **Every fenced code block gets its own Copy**, against the block rather than the message, so a
    block scrolled sideways does not carry its button off-screen. It copies the block's **raw
    source** — the text child of `pre > code`, never the rendered text — so indentation, blank lines
    and a `\` continuation survive a paste. It is always visible: unlike a message's footer there is
    nothing else on a code block to press, and hiding the only affordance behind a hover is a thing
    people fail to find. The reading view gets it too, since `SheetMessage` renders prose through the
    same `Markdown`.
- Both controls are one component (`src/components/CopyButton.tsx`): same icon states (tick, warning),
  same `sr-only` live status, same `copyText` (`lib/clipboard`) — never `navigator.clipboard` directly,
  which is absent over remote access. The code block's button says "Copy code" so a screen reader can
  tell it from the message's.

## 0.83.0

### Added
- **The folder picker descends into subfolders.** A new agent's destination was a flat list of the
  workspace root's children, so a project one level down could not be reached without leaving the
  app. The picker now walks in: a breadcrumb back to the root, an "up one level" row, a loading
  state while a host answers, and an error line rather than an empty folder when it does not. The
  host still owns the walk and refuses any path outside the root; the picker's half is the path
  arithmetic (`pathSegments`, `parentPath`, `breadcrumbPath`, `directoryName`, pure and pinned in
  `projectPickerPaths.test.ts`).

### Removed
- **The agent directory view.** It read `GET /directory` per host on a slow poll to list the agents
  a person had promoted. `DirectoryView`, its e2e spec and the polling in `App` are gone.

### Fixed
- **A new session was named after the scaffolding of its first message instead of its subject**, so
  the rail collected "Handle Gardener", "Way Librarian", "Added Gardener" and "Whether Inspector" —
  the generic word that happened to be nearest the front. The topic is now read **backwards**, from
  the end of the message, skipping words that carry no subject: a `COMMON_WORDS` tier (the ~140
  commonest English words, from `hermitdave/FrequencyWords`' `en_50k` list) on top of the existing
  `STOP_WORDS`, plus inflected forms, a complaint's adverbs ("sometimes", "entirely"), self-references
  ("itself") and question/report scaffolding ("whether", "last", "running").
  - **A report's closing verb is not its subject.** "…keeps failing", "…is stored", "…are not
    sorting" close the sentence, not the topic, so a verb-shaped word scores lower and a gerund
    never wins.
  - **A command is read the other way round.** "Fix the tailnet reconnect flapping" is about the
    *Tailnet* — what follows the imperative is what will be *done* to it — so an earlier word scores
    higher there, and a roster keyword acting on the object ("shortlist the research *datasets*")
    is treated as the action.
  - **A word the message repeats is what it is about**, and a pair only forms when the next word
    continues the name ("step counter" pairs; "scheduler handle" and "tailnet reconnect" do not).
  - **A message that names only a kind of work** ("what about the tailnet", which matches Navigator
    without ever saying what to do) now leaves the topic to the folder rather than labelling the
    session after its own role.
  - Words that are really a verb in the name's last slot are stemmed back for the test ("flapping"
    → flap, "pruned" → prune, "freezes" → freeze), while a plural of a roster noun stays a noun
    ("datasets" is Curator's dataset, not a verb).

  Measured on a 30-message corpus of realistic first messages, 24 of 30 names changed and all 24
  read as the subject: "Scheduler Handle Teacher" → "Retry Teacher", "S Handle" → "Setting Page
  Gardener", "Handle Attachment Gardener" → "Composer Gardener", "Added Gardener" → "Comment
  Gardener", "Way Librarian" → "Session Librarian", "Whether Inspector" → "Kanban Sync Inspector".

### Notes
- The rule is still `src/lib/sessionNames.ts` (`topicOf`, with `COMMON_WORDS` / `commonForm` /
  `lastWordVerb` / `pairsUp`); no model call, no randomness, still deterministic per seed.
  `sessionNames.test.ts` gains 19 cases, including "never names a session after a question word".
- The roster gained the subject words that made sessions generic by omission ("tailnet", "pricing",
  "build script") and lost keywords that were really conjunctions ("ask", "index", "transfer"), so a
  role is matched on what the work is rather than on a word that merely appears.

## 0.82.0

### Added
- **A session says what its commands left running, and stops it.** An agent that starts a dev server,
  a browser or `(nohup worker &)` leaves it running after the turn, and nothing said so: on Heliograph
  the 2026-11-04 OOM kill took 243 processes, most of them launched by agents through `bash` and still
  resident. The column now draws a notice above the composer with the programs, their size and when
  they started, and a Stop next to them (`GET/POST …/processes`, Hearth 0.39.0). Three states, and the
  machine — not the count — decides which:
  - **calm** (host memory normal): a muted status line. A dev server someone asked for is information,
    not a fault.
  - **warning / critical** (host short of memory): the same list, raised; the sentence names the host
    and what these programs hold of it, because that is what makes stopping them the useful move.
  - **refused**: a stop was asked for and the process ignored it. The only step left is force, so it
    asks first and says that unsaved work is lost.
  A stop request that never lands says **nothing was stopped** and gives the `kill` command that works
  from a terminal — a button that silently does nothing is worse than one that admits it failed.
  The answer carries the list after the stop, so the notice redraws without a second read.

### Notes
- The copy and the tone live in `src/lib/leftRunning.ts`, pure and pinned by `leftRunning.test.ts` for
  qualities (names the machine, states the cost, always a next step, no jargon) rather than for exact
  wording. The host's memory level arrives with `GET /conversations` and rides on each session row.
- Older Hearths (and OpenChamber) send no `processes` field: the notice simply does not render.

## 0.81.0

### Added
- **Lava, a fourth avatar style.** Grainy lava-lamp goo, after a risograph sheet of gradient blobs:
  two or three round lobes melted together through soft necks, a two-tone pool of a contrasting colour
  drifting inside, and a dark ink rim that stipples inward with print grain. Pick it in Settings →
  Session avatars; the appearance picker offers six shapes (`drop`, `peanut`, `trio`, `tail`, `lump`,
  `cell`), and the seed turns and mirrors each one so two sessions rarely match.
  - **Mood is the goo moving.** Busy pinches a droplet off the body and lets it melt back in; thinking
    swirls the colour inside a still outline; a question or an approval sways it gently under the shared
    orbit ring and badge; an error drains the colour out. Idle, unread and error never move, so a rail of
    resting lamps costs nothing.
  - **Every state still reads without motion.** The droplet's resting place while busy is already off
    the body, so with reduced motion a busy lamp still shows a droplet that has come away — not an idle
    blob. Thinking keeps the shared arc; questions, approvals and errors keep their badges. (The dock
    icon has no stylesheet, so its busy lamp is drawn whole and the corner dot says "busy", as before.)
  - **It holds up from the 22px rail to the dock icon.** Grain and rim width are sized to the rendered
    avatar, so the rim stays a confident line near one pixel instead of a hairline in the rail or a slab
    on the dock; body grain is left out below 64px, where a speck is a pixel of dirt.
  - **Dark themes get a coloured rim.** Near-black ink disappears into a dark surface and left the
    stipple as the visible edge, so the goo looked moth-eaten; on Clay and Graphite the rim is a deep
    shade of the blob's own hue.
- The dock icon treats Lava like Buddy: it draws its own lock, question and warning badges, so those
  moods no longer get the extra corner dot as well.

### Notes
- The silhouette is never stored as a path: the lobes are plain circles run through an SVG "goo"
  filter (blur, then a hard alpha threshold), which is what melts them and what lets a droplet leave
  and rejoin with nothing but a transform. Pure half in `src/blob/lava.ts`; `lava.test.tsx` pins the
  geometry that depends on — every shape fits at any turn, the droplet overlaps at rest and clears the
  goo's bridging distance at the peak, pools never reach the rim — plus the mood, colour and
  still-frame rules.
- Checked by eye in the browser on Stone, Clay and Graphite at 1× and 2× device pixels, at 22, 30, 55
  and 96px and in the rasterised dock icon; the appearance picker and the Settings card were exercised
  in `dev:web`. Not run in the packaged Electron app.

---

## 0.80.1

### Fixed
- **A session too large to read in one response no longer repairs itself for ever.** A full read is the
  whole conversation in one response, and Ember refuses any response over 32 MB; nothing stopped it
  asking again, so opening the column, a reconnect, the poll and every full-read event kept a futile
  request alive for as long as a session was open, against a host that was answering every small request
  in milliseconds.
  - **A tail that is simply newer than what is held is now glued on instead of asking for a full read.**
    That is what a turn looks like when it outgrew the window Ember held — a long run, a quiet session
    that woke up — and it is a genuine append, not a rewritten history. The check uses Hearth's entry
    ids, which ascend by position: every fetched id strictly newer than every held one. A tail that came
    first and reused lower ids is still treated as a rewrite and still asks for the full read.
  - **A breaker stops the automatic repairs.** Three consecutive failed full reads for one session and
    Ember stops starting them on its own (per session, and one success clears the count). The reader's
    own Refresh always goes through — asking again is asking again.
  - **The missing-history line says so and offers the way out.** Instead of a "Load them" that retries a
    request known to fail, it says the conversation is larger than Ember will read in one response and
    offers **Compact**, which is the only thing that actually shrinks the read enough to fit.
- **The full read's failure kept its own words.** `piLoadMessageHistory` re-wrapped every failure as
  *"Failed to load conversation … history (no response)."*, so the transport's "Response body is too
  large" — the one sentence that says this will not fix itself — never reached the breaker or the reader.

### Notes
- The new rule is `src/lib/repairBudget.ts` (`classifyFullReadFailure`, `RepairBudget`), unit-tested in
  `repairBudget.test.ts`; the append case is pinned in `transcriptReconciliation.test.ts`.
- Checked against a live Hearth-shaped mock; the presentational state was not screenshotted — the pi mock
  serves a synthetic history whose window is always smaller than the column, so the missing-history line
  cannot be drawn from it. What was verified in the browser: the app runs, the breaker decides from the
  transport's own message, and no full read is started once it trips.

---

## 0.80.0

### BREAKING
- **Helpful / not-helpful ratings are gone.** Owner: "retire the feature, its never been used." The
  thumbs left the message footer in 0.79.1; this removes everything behind them — the `rating` field on
  observations, the `rateModel` bridge method and its IPC handler, the `/remote/model-rating` route on
  the remote surface, and the "n / m helpful" column in Usage. The bridge method and the remote route
  are the breaking part: anything outside Ember that called `rateModel` has nothing to call now.
- `model-stats.json` files written by older builds still load; the field is dropped on read, so a
  downgrade will not find its ratings either — they were never exported anywhere.

### Changed
- The Usage panel's per-model facts now end at errors/cancellations, and the scorecard's summary line no
  longer offers to clear "observations and ratings" — it says what it actually keeps: usage metadata,
  no conversation text.

### Notes
- Two model-stats tests changed with it: the dedupe/restart case no longer rates anything, and the
  corrupt-store case now asserts the surviving entry points (`observe` and `clear`) instead of `rate`.
  A third, unrelated assertion is untouched and still pins that a stray `rating` in a hand-edited file
  is dropped rather than trusted.

---

## 0.79.3

### Changed
- **A file too big to attach now says what to do instead.** "Skipped 1 exceeding the 12 MB file / 18 MB
  total limit" was a dead end; it now adds *put it on the host's disk and send the path instead — a
  recording that big cannot ride in a message*. The agent runs on the host, so a file that is already
  there can be inspected by path (ffprobe, frames, a transcript) and only its small results come back
  into the conversation.

### Notes
- Nothing about the limit itself changed: this is a message that names the route that works. A 1 GB video
  attached here would be ~1.33 GB of base64 in one request, stored in the session for good, against a
  host that refuses anything over 12 MB per image — the ceiling is not the thing to raise, the pipe is
  the wrong shape.

---

## 0.79.2

### Changed
- **Attachments can be up to 12 MB, up from 10.** That is Hearth's own per-image ceiling
  (`MAX_IMAGE_BYTES`, `hearth/src/view.ts`), so it is as far as this number can honestly go: past it,
  Ember's clear *"Skipped 1 exceeding the 12 MB file / 18 MB total limit"* would become a refusal from
  the host after the whole upload had already gone out. The 18 MB per-message total is unchanged, because
  Hearth caps a submission's images there.
- The skip sentence is now **built from those constants** rather than hardcoded, which is how it came to
  say "10 MB" while the number lived in one place and the copy in another.

### Notes
- Verified in the browser: an 11.5 MB image attaches (it would have been skipped before), and a second
  one is refused by the 18 MB total with the real numbers in the sentence.
- Worth knowing before wanting more: an attachment is stored as base64 in the message that carried it, so
  a 12 MB image adds ~16 MB to that conversation's history for good. If big screenshots need to work
  regularly, **downscaling them on the way out** is the change that helps — a 4K PNG re-encoded to
  ~2048px is a few hundred KB with nothing a model can't read — not a larger cap.

---

## 0.79.1

### Changed
- **The copy button is where the message ends, and it is quiet.** It moved to the end of the message's
  footer, after the timestamp, and — like the other per-message controls — it stays invisible until you
  hover the message (or tab to it). Its tooltip and accessible name are just **Copy**; a longer sentence
  there only invited reading it twice. The tick that confirms a copy is unchanged, and a refused
  clipboard still says so through a screen-reader status line rather than by rewording the button.
- **The helpful / not-helpful controls are gone from the footer** (owner's request: "remove the up and
  down arrows"). The copy button takes that spot.

### Notes
- `ModelRating.tsx` and the model-stats machinery behind it are **untouched** — the observation store,
  the `rateModel` IPC and the Usage panel's "n / m helpful" column all still work. What is gone is the
  only place a rating could be *given*, so ratings will stop accumulating until there is a home for
  them again; that is filed in `TODO.md` rather than left to be discovered.
- The e2e reads the real clipboard back for both a user message and the assistant's turn, and now
  asserts the "Copied as Markdown" status line rather than a renamed button.

---

## 0.79.0

### Added
- **Any message can be copied as the Markdown it was written in.** The only copy affordances were on a
  *failed* or *unconfirmed* send, and they copied plain text; a normal message had none, so getting its
  Markdown meant selecting the rendered prose by hand — which loses code fences, tables and list
  structure. A copy button now sits in the message footer, beside the model/duration/cost line, and
  copies the message's **source**: fences stay fences, `**bold**` stays asterisks.
- It works for your own messages too, and a message copies **whole**: text parts in their original
  order, with a blank line between blocks. Attachments are named (or linked when the host gives a real
  URL) rather than pasting a megabyte of inline image data.
- The button says what happened — a tick for a moment on success, and an honest line if the browser
  refuses the clipboard (which can happen over remote access, where the page is not a secure context).
  Its accessible name carries the state, so a keyboard or screen-reader user is not left with a silent
  icon.

### Notes
- `lib/messageMarkdown.ts` is pure and tested (`messageMarkdown.test.ts`, 7 cases): source preserved
  verbatim, parts in order, a fence inside a tool's output not escaping its block, and user messages
  with files.
- **Reasoning and tool calls are deliberately excluded by default** — a tool's output can be tens of
  thousands of characters, and pasting that into a note by accident is worse than leaving it out. Both
  are one option away in the module (`includeReasoning`, `includeTools`), folded behind `<details>`, if
  you want them on the button later.
- `e2e/pi.pw.ts` reads the real clipboard back after clicking: the user's message copies as their own
  words, and the assistant's turn copies whole.

---

## 0.78.0

### Changed
- **A scheduled run is just a session now.** The rail had a clock button that swapped the whole list
  for "the latest run of each scheduled task" — so switching to it hid every session you were actually
  working in, and there was no way to see a run next to the work it belonged with. That mode is gone:
  runs stay in the normal list, with a **small calendar mark** beside the title whose tooltip says
  *This was triggered by a scheduled task* and names the task.
- **The rail's scheduled content is the plans, not the runs.** A **Scheduled** section at the bottom
  lists one row per task — its name, its schedule in words ("Every day at 09:00", "Mon, Wed at 08:15",
  "Once, 4 Nov at 09:00"), a **paused** chip, "last run failed" when that is the case, a run-now button
  and a click through to the last run. Nothing in it pretends to be a conversation.

### Fixed
- **Hearth's scheduled tasks were never fetched outside the old scheduled mode.** `refreshScheduled`
  required a project list per instance, and a Hearth has none — measured: **zero** `/scheduled-tasks`
  requests in a fresh session. It is now a target as soon as it is ready, which is what the plan
  section and the calendar marks are built on. (OpenChamber still needs its project list to ask per
  project.)

### Notes
- `lib/scheduleText.ts` is pure and tested (`scheduleText.test.ts`, 6 cases): daily, weekly with day
  names (collapsing a full week to "every day"), one-offs in local time, and `null` — not a guess —
  for a schedule shape it does not know.
- The per-row run/model actions are unchanged, so an errored run can still be retried after switching
  its model; they now appear wherever that row appears, not only in a special view.
- The Scheduled **tab** (runs newest-first with a counter) is still in `TODO.md`; this is the rail half,
  which the entry now describes as shipped.

---

## 0.77.2

### Fixed
- **A queued message is no longer drawn twice while it settles.** Queueing a follow-up (and, more
  visibly, editing one) showed the same text as two rows for about a fifth of a second — measured:
  3–4 of 40 samples at 80 ms. The cause was not the queue's bookkeeping: the optimistic row and the
  host's row were one item in state, but `AnimatePresence` kept the removed optimistic row mounted
  through its **exit transition** while the host's copy entered, crossfading two identical sentences.
  Queue rows no longer animate their exit — a removed row disappears at once (the reorder `layout`
  animation and the enter fade are unchanged).
- **A queue poll can no longer keep a second copy of a row the host already lists.** The poll has no id
  to match an optimistic row against, so it kept it alongside the host's row; it now drops the
  optimistic copy when the served row is the same message (same text, mode and file count — one local
  row per served row, so two identical messages queued back to back still stay two rows).

### Notes
- `sameQueuedMessage` + the merge rule are pure and tested (`messageQueue.test.ts`, 5 cases: the
  duplicate stops, two identical texts stay two, a different text and a mode difference are never
  swallowed, a failed row is kept).
- Found by instrumenting the queue mutations in the running app rather than by reading: the merge never
  fired during the window, and the DOM showed two rows with the same id and different React keys — an
  exiting clone, not a second item.

---

## 0.77.1

### Fixed
- **Following no longer switches itself off, and scrolling up at the bottom stops fighting the app.**
  Reported as "trouble scrolling up when I'm right at the bottom, harder when the bottom element is an
  image". Two things were wrong, and they compounded.
- **A layout clamp was read as the reader scrolling back.** The transcript decided "upward scroll" from
  a `scrollTop` decrease, but `scrollTop` also falls when the viewport grows and the browser clamps the
  scroll to the new maximum — measured: `clientHeight 403 → 431` with `scrollHeight` unchanged and
  `scrollTop 508 → 480`, no gesture anywhere. Each one was a chance for following to switch itself off,
  and under load it did: 42 messages at ~230 ms left the transcript at the **top** of an 8,428 px list
  with "Jump to latest" showing, three runs out of three. Now only a gesture can stop following — a
  wheel, touch, key or scrollbar drag inside the same window the code already tracked for the other
  direction — and a delta that arrived with a resize is ignored outright.
- **An image at the bottom no longer makes it worse.** Images reserve no height until they decode, so a
  picture appearing at the end changes the layout in one 256 px step; that step is now recognised as a
  resize rather than as the reader moving.

### Notes
- `src/lib/scrollIntent.ts` is the rule, pure and tested (`scrollIntent.test.ts`, 6 cases): a resize is
  never the reader, an upward move is the reader only while a gesture is recent, reaching the end always
  resumes following.
- `e2e/pi.pw.ts` grew the reproduction — 24 messages at ~230 ms, asserting the transcript is still at
  the end with no "Jump to latest" pill — and the two 0.74.3 tests still pass, so a real wheel up still
  stops following and Jump to latest still returns to the end.

---

## 0.77.0

### Added
- **A Directory tab: the named agents on every connected host.** Hearth has kept a per-host registry of
  named agents since the coagent work — one conversation per name, and only a *person* can register one,
  by promoting a worker — and Ember showed none of it: a promoted peer was just another row in the rail,
  with nowhere to see which names exist or where they live. **Home · Sessions · Usage · Directory** now
  lists them, grouped by host, pinned first (Hearth's own order), each row showing its blob, its
  conversation title, whether it is idle, working or **needs input**, and its address as `host/name` —
  the only unambiguous way to write a name once more than one host has agents. Clicking a row opens that
  agent's conversation.
- **The three ways a host can fail to answer are kept apart**, because they mean different things: it
  *answered* with names, it *answered and serves no directory* (an OpenChamber instance, or an older
  Hearth), or it did **not answer** — in which case its agents are unknown, not gone, and the row says
  so. A host with no names yet says how a name gets made rather than showing an empty box.
- The view reads `GET /directory` per host when it opens and refreshes on a slow poll, with a
  **Refresh** control; names change only when someone promotes a worker, so there is nothing to hurry.

### Notes
- `src/lib/agentDirectory.ts` is pure and tested (`agentDirectory.test.ts`, 10 cases): grouping and
  ordering, the three host states, the empty states, and `resolveAgentName` — the rule a cross-host
  `send` will rest on, where a bare name resolves only if it is **unique** across hosts and an ambiguous
  one is refused with both addresses offered.
- `e2e/directory.pw.ts` covers the list, opening an agent's conversation from it, and a host that is
  not answering. The pi mock grew a `GET /directory` route; its `?outage` endpoint now fails requests
  at the transport, as a dead host does (it used to answer, which made an outage look healthy).
- This is step one of the entry in `TODO.md` — the agent-facing "message another agent by name, across
  Hearths" still needs a relay both hosts can reach.

---

## 0.76.1

### Fixed
- **A leader's cost badge now counts its crew.** Hearth sums `cost` from *one* conversation's usage
  ledger, and a worker is a separate conversation with its own — so the badge read as "the price of
  this session" while showing a fraction of it (measured on this host: **$1.07** against **$3.87** in
  17 workers, 78% invisible; another leader $0.92 against $2.50). It now shows the total for the
  session **and every worker below it**, at any depth, with the split in the tooltip: "… this
  session's turns $1.07 and its crew $3.87 across 17 workers."
- **Neither half can pretend to be the whole bill.** When some turns in the family were not priced by
  the provider the total carries a `+` and the tooltip says it is a floor, so a leader whose own turns
  went unpriced no longer looks priced because a worker was. Nothing priced anywhere still reads
  **Cost unknown**, and a session that has not run still shows no badge at all.
- Finished and archived workers keep counting: the money was spent, and where the session sits now is
  a different question.

### Notes
- `src/lib/crewCost.ts` is pure and tested (`crewCost.test.ts`, 11 cases): the whole subtree rather
  than direct reports, a worker counted once, a malformed `lead` chain terminating, archived workers,
  the priced/unpriced split, and "unknown" rather than "$0".
- The crew strip still shows no per-worker cost: the chips are already dense and the badge's tooltip
  carries the split. Easy to add to each chip's tooltip if you want it there.

---

## 0.76.0

### Changed
- **A new session shows its message the moment you press Enter, and a failure stays where it
  happened.** Owner-reported: "I start a new session and it looks like nothing happened for quite a
  while." The create is the one request whose answer the person waits on with nothing else to look
  at, and until it landed the draft pane sat unchanged — same blob, same instruction list, an empty
  composer and a spinning send button — while the message was nowhere on screen.
  - The attempt is now App state, not a late side effect: `pendingCreates` + `draftPendingId`
    (`src/lib/pendingCreate.ts`). The draft renders it as a normal transcript, so the bubble is
    there before the host is asked, and its delivery states are the ones every send already uses.
  - The pane names what it is doing ("Starting this session on <host>") instead of only spinning.
  - While the session starts the composer stays live: a second message is held on the attempt
    ("Sends once this session has started.") and sent in order once the session exists; a note
    saved with Cmd/Ctrl+Enter is held too and joins the session's For later tray on success.
  - A refusal is a failed bubble **in the pane**, with **Try again**, **Copy** and **Edit** — the
    reason names the host and, for Hearth's folder refusal, the folder, which is editable right
    below. The top-bar banner is used only when the pane is not on screen, and its action says
    **Show** because that is what it does.
  - Leaving the draft (× or another session) no longer yanks the reader back when the create lands:
    the session appears with a notice and **Open**. Once a create has failed, × lets it go.
  - A create whose answer was lost (timeout, dropped socket) is now adopted on retry: a conversation
    with the attempt's folder and derived title, no entries, and absent from the list the attempt
    began from is reused instead of creating a second empty session.
  - The first send of a new Hearth conversation no longer repeats `/configure` with the model and
    level the create already carried, and a first-send failure that keeps its bubble no longer
    duplicates its reason in the top bar.

### Notes
- The pure halves are `src/lib/pendingCreate.ts` (`pendingCreate.test.ts`) and
  `src/lib/newSessionFailure.ts` (`newSessionFailure.test.ts`, copy-quality assertions);
  `SessionCreateError` (`src/lib/sessionCreateError.ts`) carries the status both wire layers report.
  `e2e/newSession.pw.ts` covers the whole arc against new mock fixtures — `?slowCreate`,
  `?failCreate` (refuses once, so a retry can succeed), `?dropCreate` (creates, then loses the
  answer) and the held-note path.
- Plan and decisions: `NEW_SESSION_PLAN.md`.

## 0.75.1

### Fixed
- **A compaction that does nothing now says so.** Hearth answers `202` for every compaction and then,
  when the transcript already fits the kept window, posts no summary, no event and no flag at all —
  so the meter stopped spinning and nothing else happened, which reads exactly like a click that
  never left. Ember now watches the session summary for the flag a real compaction sets; when it
  never appears, a notice says **Nothing to compact — the recent turns already fit.** A compaction
  that does run is unchanged: the spinner stays for its whole pending window.
- **Every attempt is written down** in `<userData>/ember-compact.log`, one line each — instance,
  session, outcome, whether the host accepted, whether a compaction ever started, and how many
  entries the transcript held either side. A "nothing happened" report is now answerable from a file
  instead of reconstructed by hand.

### Notes
- The reading of the signal and the wording are pure and tested (`src/lib/compaction.ts`,
  `compaction.test.ts`); the writer is `electron/compactLog.ts` (mode 0600, bounded to 32 KB, keeps
  the newest lines), tested against a temp directory.
- `?compactNoop` makes the pi mock behave like the host does on a small transcript (202, then
  silence), and `e2e/pi.pw.ts` asserts the notice, the idle meter, no error banner, and the line the
  renderer reports.
- The notice pill's width went from 44ch to `min(60ch, 55vw)`: at 44ch the sentence lost the clause
  after the dash, which was the part that explained it.

---

## 0.75.0

### Changed
- **The tray above the composer is one shelf, not three stacked cards.** A queued message used to
  cost two lines (text plus model) and a card border; a note cost a card and a "For Later:" prefix;
  the crew cost a strip of bordered chips. With all three present that was ~10 lines of chrome above
  the composer, and the queue clipped its own third row. Now there is one line of tabs — **Queue 3 ·
  For later 2 · Crew 3** — with the open tray's rows under it and a chevron that folds the lot to
  that single line. Measured on the same conversation: the band went from 414px to 272px with the
  same content, and to 186px folded.
- **No outlines inside the band.** Rows are plain text on one line, with the model (or "1 file") muted
  at the end; the row's actions appear in its place on hover or keyboard focus, so an idle tray is
  just words. Worker chips are filled and borderless, still tinted with the leader's colour.
- **Reading is separate from editing.** Clicking a queued message or a note opens it read-only — whole
  text, what rides with it, its model, when it was queued — with **Edit** as its own button. Before,
  the only way to read a long queued message was to open the editor whose Save re-enqueues the row
  under a new id. Steers and rows still being queued can be read too, which they could not before.
- Each tray keeps its own verbs: queue rows offer move up/down, send now, edit and withdraw, with
  **park it as a note** and **merge into the one above** behind "…"; notes offer send, edit and delete.

### Notes
- A tray with nothing in it has no tab, folding keeps the tabs, and a tray that wants the human shows
  a dot. Which tray is open is the person's choice — new items bring their own tray forward, and a
  crew that has *just* become blocked opens itself; opening a session never steals the shelf.
- `composerShelf.test.tsx` pins the shelf's qualities (one header line, no empty tab, folding keeps
  the tabs, the alert dot, nothing at all when empty). `e2e/pi.pw.ts` covers reading a queued message
  with no request behind it, and the queue/merge/notes/crew suites were updated to the new rows.

---

## 0.74.3

### Fixed
- **A message arriving no longer yanks a reader who scrolled back.** Scrolling up in a transcript
  raised the "Jump to latest" pill — the app knew the reader had stopped following — and then the
  next message scrolled to the bottom anyway, leaving the pill on screen. The cause was one effect
  doing two jobs: its scroll was unconditional, and it depended on `scrollToBottom`, whose identity
  changed with `items.length`, so every arriving message re-ran it. Measured on the mock: reading at
  200 px with the pill up, one message moved the view to 665 px (the bottom); with
  "Follow new content while streaming" unticked it moved too.
- Scrolling to the bottom now happens in exactly three cases: **opening a session** (once, on its
  latest turn — switching sessions in the same column re-arms this), **the reader already being at
  the bottom** while content grows, and an explicit **Jump to latest**. `scrollToBottom` reads the
  item count and virtualiser flag through refs, so its identity is stable and the pin effect installs
  once instead of re-running on every append. The "Follow new content while streaming" setting now
  means what it says.
- A new approval or question still scrolls into view once — but it no longer re-arms following, so it
  cannot drag a reader who was reading back through the rest of the stream.

### Notes
- `e2e/pi.pw.ts` covers both halves with real wheel input (the gesture that marks a scroll as the
  reader's): a message landing leaves the reader where they were with the pill still showing, Jump to
  latest still returns to the end, and with following off growth does not scroll at all. Both tests
  were checked against the old code, where the first one fails (measured pull to 55 px from the end).

---

## 0.74.2

### Fixed
- **Remote access over Tailscale no longer fails with `crypto.randomUUID is not a function`.**
  `crypto.randomUUID()` is only exposed by browsers in a secure context (`https:` or `localhost`).
  When opening Ember remotely over plain HTTP on a Tailscale IP (`http://100.x.y.z:57821`),
  `crypto.randomUUID` is `undefined`, so sending a message, writing reply context, or saving a new
  session group threw immediately. All renderer ID generation now goes through `randomId()`
  (`src/lib/randomId.ts`), which uses `crypto.randomUUID` when present and falls back to an RFC 4122
  v4 UUID built from `crypto.getRandomValues` (available in insecure contexts too).
- **Copying device sign-in codes works over Tailscale HTTP.** `ProviderSignInDialog` called
  `navigator.clipboard.writeText` directly, which is also undefined in insecure contexts. It now
  routes through `copyText` (`src/lib/clipboard.ts`), whose `execCommand('copy')` fallback now
  focuses and restores the temporary selection so it works inside modal focus traps.

### Notes
- `randomId.test.ts` covers RFC 4122 v4 formatting, the `getRandomValues` fallback when
  `randomUUID` is absent, the `copyText` fallback when `navigator.clipboard` is absent, and a source
  guard that renderer files never call `crypto.randomUUID` or `navigator.clipboard.writeText`
  directly. `e2e/pi.pw.ts` strips both globals before boot and verifies a full send round-trip.

---

## 0.74.1

### Fixed
- **A failed command keeps the output the agent saw.** When a tool result came back marked as an
  error, Ember kept the first 400 characters as the row's error and threw the rest away — so a
  `grep` that found nothing (exit 1, an *answer*) showed the least informative part of its log in red
  and lost the end of it, where the reason usually is. The whole retained output is now kept, exactly
  as for a successful call, with one line above it saying why: the host's own diagnostic ("Command
  exited with code 1") when it sends one, otherwise the last non-empty line.
- **The exit code is shown**, as a chip on the row when it is non-zero. It was on the wire all along
  and nothing read it, so "no match" and "the disk is full" looked identical.
- **A host-side truncation is admitted**: the host keeps a tail (2 000 lines / 50 KB) and says when it
  dropped earlier lines; the row now says so instead of showing a short log that reads as the whole
  log. Ember's own cut also reports how much it cut ("… (truncated — 25,000 characters)").

### Notes
- The red line is a *summary*, never a replacement: output and error now sit side by side, which is
  what makes a long failed log readable at all.
- An interrupted step is unchanged — its result content is the harness's "[error] Tool … was
  aborted", so that text stays the message and there is no separate output to show.
- `toolResultSettlement.test.ts` covers the three cases that were wrong (the whole log survives, the
  summary is the last line, the host diagnostic wins) plus exit status, truncation and the amount cut.
  The pi mock grew a failing-grep command, and `e2e/pi.pw.ts` asserts the row names `exit 1`, shows a
  line past the old 400-character cut, and admits the dropped prefix (29/29 green).

---

## 0.74.0

### Added
- **A running command shows what it has printed, as it prints it.** A tool row used to be a spinner
  and nothing else until the call finished — for a command that waits on a file or greps a growing
  log, that could be minutes of "is it doing anything?" with the output already arriving behind an
  expand click nobody makes. Every running call now shows the tail of its output under the row, last
  few lines, muted and clipped, no click needed. Hearth streams it (`api.output()` → the `pi.live`
  tool slot → a hint per flush); Ember now patches it onto the row that is already on screen and
  replaces it in place with the settled result, whose full output is still one click away.

### Fixed
- The streamed output was arriving on the wire and being dropped: an incremental (`since`) read
  during a running call normally returns **no new entries**, and the client only read entries — so
  the live slot's output, which rides the same response, never reached the row. It is now applied to
  the call the transcript already holds (`applyLiveToolOutput`), and a call still marked `pending`
  becomes `running` the moment its first chunk lands. A stale slot can never resurrect a settled
  call.
- A long output tail can't push the composer around: carriage-return progress redraws render as
  lines, an enormous single line is cut, and the block is height-clipped.

### Notes
- `liveOutputTail` (`src/lib/toolTail.ts`) is pure and tested; `piMapping.test.ts` covers the
  patching half (an empty page still updates the call, a settled call is untouched, nothing to change
  returns the same array so a poll cannot churn the column).
- The pi mock grew a `live tail` command whose output streams in three chunks and then settles, and
  `e2e/pi.pw.ts` asserts the tail appears while the row is still collapsed, keeps up, and gives way to
  the settled output.
- Still open (same entry in `TODO.md`): a **failed** call's output is cut to its first 400
  characters, and `exitCode`/`truncated` are never read.

---

## 0.73.1

### Fixed
- **The crew strip is chips, not chips inside a card.** A leader's workers were a wrapping row of
  bordered chips wrapped in a bordered, filled, shadowed card — a chip inside a card, with a second
  surface between the composer band and the work. The card is gone: the chips are the strip, and the
  only thing the container still owes them is the group's name and a way to fold it. The minimiser
  moved with it, from a bubble floating over the corner to a dashed chip at the end of the row
  (hover-revealed on a pointer, always shown on touch); the collapsed "Crew 2 · 1 needs input" pill
  is unchanged.

### Notes
- `crewStrip.test.tsx` gained the assertion that pins it: no card surface, still one named
  `role="group"`, and one list item per brick plus the minimiser. The bundled pi-mock suites
  (`crew.pw.ts`, `pi.pw.ts`) stay green, 35/35.

---

## 0.73.0

### Added
- **A host that is down can be answered.** The rail's "Not answering" row had nothing to click:
  one blip — a laptop that slept, a Hearth restarting — left it above every session for good. Each
  such row now carries a small × ("Stop warning about <host>"), which hides that warning and
  nothing else: the host's last-known sessions keep their rows, the top bar still counts it as not
  connected, and the Instances menu still shows its dot. A host reporting "Sessions unavailable" is
  **not** dismissable — that is a settings problem, and silence cannot fix it.
- The choice is remembered (`settings.dismissedOutages`), so a relaunch does not put the row back.
  What clears it is the only thing that ends an outage: the host answering again ("it answered, then
  went down once more" warns again; a probe still out, or an instance list that has not loaded yet,
  never counts as recovery). **Reprobe instances** clears every dismissal too — probing again is
  asking again — which is the way back once the row is gone. Dismissing shows a notice with **Undo**.

### Fixed
- The rail's empty state pointed at "Retry above" when there may be nothing above it: with every
  outage row dismissed, that sentence was a dead end. It now names the control instead — "Choose
  Reprobe instances in the Instances menu once a host is back".
- A notice's close button said **Dismiss**, which beside "No more warnings about <host>" read as the
  same action twice. It says **Close**.

### Notes
- The rules are pure and tested in `instanceHealth.test.ts` (a dismissed host is omitted and its
  sessions are untouched; an answering host clears it; a checking or unlisted host does not; the
  identity check that skips a redundant settings write) and the field ships/round-trips in
  `settingsFile.test.ts`. `instanceOutage.test.tsx` asserts the control's accessible name and that
  an unsupported host has none.
- `e2e/outageDismiss.pw.ts` (4 tests, green) covers the row, the dismissal, Undo, Reprobe and the
  healthy-then-down re-arm. It needs a host that is down, which nothing in the pi mock produced, so
  `?outage` adds a second endpoint that is not answering.

---

## 0.72.0

### Fixed
- **A host you removed from the Instances menu stays removed.** Unticking a host hid its sessions, its
  "Sessions unavailable" row and its palette entries — for that run only: the set lived in memory, so
  the next launch brought the instance back with no sign the choice had ever been made. The ids are now
  `settings.hiddenInstances`, so "remove this from my list" sticks, and creating a session on a hidden
  host un-hides it (a draft that lands in a hidden instance would otherwise look like nothing happened).
- The filters themselves were already right — the rail, Home, the palette and the workspace all read
  the current instance list and the hidden set — so nothing else about hiding changes.

### Notes
- Three tests cover the field: it ships as an empty list, a stored list round-trips through
  `parseStringArray`, and junk/duplicates are dropped rather than poisoning the filter.

---

## 0.71.1

### Fixed
- **A dropped stream no longer reconnects in a hot loop.** The reconnect backoff was forgiven on
  `open`, so a host that accepted a WebSocket and closed it a moment later (Hearth did, on the first
  frame that hit backpressure) was retried at the base delay forever. With ~25 watched conversations
  that is ~25 new connections per second — measured on the real pair: **2,272 connections in 83
  seconds**, 6,915 sockets in `TimeWait`, 36.7 GB of snapshots through the tailnet.
  A connection is now forgiven only if it **stayed up for 15 seconds**; a socket that opens and dies
  young counts as a failure and doubles the delay (1 s → 2 s → … → 30 s, ±25% jitter, per
  subscription). A stable connection that drops still retries after one base delay, so ordinary
  network blips feel the same as before.
- The policy is pure and tested in `electron/streamBackoff.ts` (5 cases: accept-then-close escalates,
  a stable connection is forgiven, the delay is capped, jitter bounds, a close with no recorded open).
- **`package.json` had been left at 0.66.3** while `CHANGELOG.md` went to 0.71.0: a shared checkout
  meant several version bumps replaced a string that was no longer there, and only the changelog
  moved. The manifest is correct again at 0.71.1.

### Notes
- The server half of the same loop is Hearth **0.36.0**: it holds one snapshot for a socket that is
  behind instead of closing it on the first `-1`, gives up after 60 s with a jittered close, and
  admits stream upgrades per peer (burst 48, then 6/s, 96 live per address). Either half alone would
  have bounded the storm; together a slow client is a slow client rather than an outage.

---

## 0.71.0

### Changed
- **The reading view is wide enough to read in.** The sheet was capped at 760px with the prose further
  capped at 640px (~70 characters) — comfortable for a book, cramped for a long agent reply, a table
  or a code block. The frame is now `min(94vw, 1100px)`, the prose column sits at a 780px measure in
  the middle, and the comment tray follows the same measure so the chrome stays where the text is.
  (`sm:max-w-none` was needed as well: the dialog primitive's variant-scoped `sm:max-w-lg` is not
  displaced by a plain `max-w-none`, which is why the sheet silently stayed 512px wide.)
- **Comments can be sent from the reading view.** The tray under the message now carries
  **Send N comments** beside its drafts, so "select, comment, send" happens without leaving the
  reader. The target and the model are resolved from *this* session, never from whichever column is
  selected: the session's own last model, else the instance default. With no model loaded the send is
  refused with a reason and every draft stays put; a failure keeps the drafts too (the tray is not
  cleared until the send is accepted). Closing the view still hands unsent drafts to the
  conversation's tray.

---

## 0.70.2

### Fixed
- **A workspace whose only open sessions are minimized now shows Home instead of an empty pane.** With
  every column minimized, `columns` was empty while `openSessions` was not, so the workspace rendered
  ChatView's "Pick a session, or start a new agent" placeholder and `activeSession` pointed at a hidden
  tab. Home is the honest surface for "nothing to read"; it was already the surface for "nothing open".
- **Sessions restores a minimized tab.** That Home hides the rail and the tab strip is what would have
  made the first fix a trap: from Home with everything minimized, the Sessions tab did nothing because
  a session *was* open. It now leaves Home and, when nothing is on screen, brings back the active
  session — or the first minimized tab — clearing the sticky minimized flag. Home's **Back to
  workspace** goes through the same path, so it can no longer be a no-op.

---

## 0.70.1

### Fixed
- **Archiving the session you are reading hands over to the next one instead of dropping you on Home.**
  Archiving was a "next, please" gesture that behaved like an exit: `closeSession` gave the active slot
  to an open neighbour, and with no neighbour it set `null`, which made Home the visible surface — so
  tidying up cost a trip back through Sessions. Now, when the archived column was the one on screen and
  nothing else is open, the workspace opens the next session **in the rail's own order** (wrapping
  once): same project first, then down the list, skipping archived rows and crew workers and
  preferring a session that is not a minimized tab — only if nothing else is left does a minimized one
  come back. A genuinely empty rail still goes Home, which is the honest answer.
- The order is captured **before** the archive is applied, because archiving bumps `updated` and would
  otherwise sort the archived session to the top and pick a stranger.
- Bulk archive (a project's tidy-up, or the stale-scheduled-run sweep) lands once on a neighbour rather
  than shuffling through intermediate actives; the sweep archives sessions that are not open, so it
  never moves the active column at all.

### Notes
- Filed while testing this: a workspace whose only open sessions are **minimized** renders neither Home
  nor a column ("Pick a session, or start a new agent"), with `activeSession` pointing at a hidden tab.
  See `TODO.md`; it predates this change.

---

## 0.70.0

### Added
- **Sessions are named from their first message instead of showing a number.** Hearth stores no title
  until someone renames a conversation, so every fresh session was its id — "57458". Ember now derives
  a name **locally, at creation**, from the message you are about to send, and sends it as `title` on
  `POST /conversations`: no model call, no extra request, and the name belongs to the conversation, so
  the rail, Home, the header and the phone all agree.
- **`<Topic> <Role>`**, e.g. **Tailnet Mechanic**, **Auth Architect**, **Dataset Curator**,
  **Step Counter Inspector**. The topic is the first content noun of the message (two words when they
  read as one thing), falling back to the folder, then the project. The role comes from a roster of
  **52**: 32 *useful* roles matched from the imperative or the subject matter ("fix" → Mechanic,
  "refactor" → Architect, "shortlist" → Curator), and 20 *playful* ones (**Gardener**, **Stargazer**,
  Ferryman, Bellringer, Beekeeper…) used only when the message gives nothing to match. A collision
  steps the role rather than repeating the name, so two similar sessions read as colleagues.
- A session with nothing to go on — "hmm", or "can you take a look" — is named from its folder
  (**Habit Gardener**). Pure and unit-tested in `sessionNames.test.ts` (27 cases: the roster split,
  the role table, topic extraction, determinism, collisions, and the playful-fallback rule).

### Fixed
- **The dev mock could hand a new conversation an id a fixture already used**, so a freshly created
  agent opened someone else's chat (its reads resolved to the fixture). Ids are now allocated above
  every fixture.

### Notes
- Naming is Hearth-only. OpenChamber instances keep the old behaviour, which is fine for a wire that
  is being retired.
- Existing sessions that already show a number are left alone: renaming is still a double-click, and
  nothing here rewrites a name you chose.

---

## 0.69.0

### Changed
- **The session list has three widths instead of two: mini · normal · wide.** One control walks them
  (and `Cmd/Ctrl+B` does the same from anywhere), remembered in `settings.railMode`:
  - **mini** — a 64px dock of blobs, the fully collapsed state. Just the sessions: blob, mood, unread
    dot, column underline, and a hover tooltip carrying the title and the latest message. New agent and
    a button back to normal sit above it; Settings is an icon at the bottom. Search, the instance
    picker, scheduled and archived are not shown — mini is for getting the rail out of the way, and
    they are one press away.
  - **normal** — the familiar 320px rail.
  - **wide** — about half the window (`min(50vw, 760px)`), where each row shows the latest message over
    up to three lines.
- Mini lists **sessions**, one blob each, ordered by recency: a project card's labels have nowhere to
  go at 64px. Expanding brings projects, groups and search back.

---

## 0.68.0

### Added
- **The session list is collapsible, and wide enough to read in.** The rail keeps its 320px shape until
  you widen it, then takes about half the window (`min(50vw, 760px)`): each row shows the **latest
  message** over up to three lines instead of one clipped line, and a project's blob strip spreads
  into the extra room. The toggle is the small panel button in the rail's toolbar, and `Cmd/Ctrl+B`
  does the same from anywhere. The choice is remembered in settings (`railExpanded`), so the rail opens
  the way you left it.
- Widening overrides **compact rail** for the preview line: hiding previews is a choice about a cramped
  320px column, and asking for the wide one is a choice to read them.

---

### Notes
- The rail's width transition is `md:` only — on a phone the drawer keeps its `min(88vw, 320px)` size,
  since there is no half-screen to give.

## 0.67.2

### Added
- **Notes can be parked from the reading view.** **Note** in the sheet's footer opens a one-line field
  ("Park a note for this session…"); Enter or **Save note** writes it to the session's own **For Later**
  card, the same place the composer's save-as-note writes, and a quiet line says where it went. Notes
  need no model and no send, which is why this half could ship while *sending* comments from the sheet
  is still open — a note never leaves Ember until you send it from the conversation.
- **Open conversation** moved into the sheet's header as an icon, so the footer keeps one line:
  Previous · Next · Note · Mark read.

---

## 0.67.1

### Fixed
- **The queue's minimize button sat on the scrollbar.** The circular "−" was pinned `-right-2`, half
  outside the band and flush with the column's right edge — right on top of the transcript's
  scrollbar, where a click meant to minimize the queue would scroll the conversation instead (and on
  Windows the scrollbar took a bite out of the button itself). It is now inset `right-6`, in the empty
  strip above the row's Send now / Edit / Cancel controls, clear of both the column's scrollbar and
  the queue list's own. The notes card's identical minimize badge moved with it.
- A pi spec now asserts the geometry rather than trusting it: the badge's right edge stays at least
  16px inside the column.

---

## 0.67.0

### Added
- **The top bar is a tab bar: Home · Sessions · Usage.** Home is the unread/read list (with its count),
  **Sessions** is the workspace (rail and columns) and returns to whatever is already open — or, with
  nothing open, **loads the most recently updated session** rather than showing an empty workspace —
  and **Usage** is now a view of its own instead of a dialog over the app.
- **Usage is a page.** `ModelUsageDialog` became `ModelUsagePanel` (same content: calls per model,
  median time, throughput, provider-reported cost, reasoning levels, instance split) rendered in the
  main area, full width, with no rail — so the numbers can be read instead of peered at through a
  640px modal. Filters and ranges behave exactly as before.
- Neither Home nor Usage renders the rail or the column tab strip; both come back with Sessions.

---

## 0.66.3

### Fixed
- **A full history read asked for more entries than the host allows, so it failed.** Hearth 0.35.0
  lowered the entries-page cap from 500 to 100 (`LIMIT_MAX`): a row can carry megabytes of base64 and
  the read parses every row it selects, so the cap is a memory bound. Asking for more is a 400, not a
  clamp — and the paged history walk asked for 250 on every request, so opening a session's full
  history against a current Hearth failed outright (`limit must be a whole number from 1 to 100`).
  The walk now pages at 100, and the tail/append reads clamp to the same cap instead of the old 500.

---

## 0.66.2

### Added
- **Every session row says whether it is Unread or Read.** A word next to the count and time: **Unread**
  in the accent when the session still holds something waiting (a message you haven't marked, or a
  request you haven't answered), **Read** in muted text once it doesn't. It is **derived from the
  messages**, not stored: there is no flag to set, and marking the last message read flips the word on
  the same click. A session whose digest hasn't loaded yet makes no claim either way.

---

## 0.66.1

### Added
- **Comments can be drafted while reading, and they survive leaving the view.** Selecting text in the
  reading view raises the same comment bar as a column (Comment plus Yes / No / Hold off), and a set
  collects in a small tray under the message — "Send 1 comment · saved for the conversation", with the
  quote and reply, each removable. The drafts are written to the `commentMemory` entry keyed by that
  session's composer key, the same one the conversation's own comment tray reads, so closing the view
  **hands them over** instead of dropping them: the column shows the exact set, unsent, and `Send N
  comments` still decides when they go out.

  Nothing is sent from the reading view, deliberately: `handleSend` targets the *selected* session,
  so sending from a sheet opened on some other session would either post to the wrong conversation or
  have to guess a model. Drafting is safe; sending stays where the model and the conversation are
  known.
- A column that is already mounted re-reads the drafts when the view closes (`commentDraftsVersion`),
  so a tray that was empty before the sheet opened is not left empty behind it.

### Notes
- The Home row's comment tally still counts **sent** comment sets only. A draft is not a comment yet.

---

## 0.66.0

### Added
- **The reading view: one session's unread messages, whole, over a blurred Home.** Home's rows now open
  `ReadingSheet` instead of the conversation, and a row's excerpt is what it always was — an index
  entry. The sheet shows the message in full (Markdown prose through the transcript's own renderer,
  reasoning folded behind a disclosure, one line per tool with its output on demand, images in the
  shared viewer), keeps the last message you read earlier above it as context, and says where you
  are ("1 of 4 unread"). It grows with the message up to `min(88vh,900px)`, so a one-line reply gets a
  small sheet rather than an empty 900px frame.
- **Marking happens where the words are.** **Mark read** marks the message you just read and moves to
  the next; **Mark all read** clears the session; `j`/`k` move, `x`/Enter mark, Esc closes. Nothing is
  marked on open or on render. A pending approval or question is a card that hands over to the
  conversation, because it is answered rather than read, and a session with nothing left says
  **You're caught up on …** and offers the next unread session.
- The sheet reads `loadMessageAppend` from one entry *before* the mark (so the sentence you left off
  on can be shown), falling back to a 32-message tail, and loads once per open — never on every mark,
  never a full transcript. A failed read keeps the messages unread and offers **Try again**.

### Changed
- **Home's per-message tick is gone.** It marked a two-line excerpt read without reading it, which is
  backwards; the dot is the indicator again and the action moved into the reading view. Right-click
  **Mark all as read** is unchanged, on Home rows and rail rows alike.
- `DialogContent` took an `overlayClassName`, which is how the reading view blurs Home rather than
  blacking it out.

### Notes
- **Not in this pass:** comments and notes from the sheet (HOME_PLAN.md phase 3). The pieces are
  proven in the column; the open question is the send path, since `handleSend` targets the *selected*
  session — recorded in `TODO.md` rather than guessed at.

---

## 0.65.1

### Added
- **A tick on every unread message, so one message can be marked read without waiting for anything.**
  The dot on a Home row was already a button, but it looked like an indicator and sat at the edge of a
  1,500px row. Each unread message now ends in a small circled check (`Mark this message read`), the
  dot is purely the indicator again, and Home's rows are capped at a readable measure so the tick sits
  next to the words instead of half a screen away. Nothing about the model changed: one tick marks one
  message, right-click still marks the session.
- **A context bar under every link.** Each link in Home's right column now says where it came from — the
  session, a quote of the message around the link (`contextAround`, windowed on the link itself) and a
  **Jump to message** action that opens that session with the message scrolled to and highlighted
  (`ChatView` gained a token-keyed `focusTarget`; the transcript's message rows carry
  `data-message-id`/`data-highlighted`). A link offered inside a *pending* question has no message to
  land on yet, so its bar says **Open session** instead of pretending.
- **`sharedLinks.test.ts`** (13 tests): link kinds (loopback = app, a document = report, a local path =
  file), titles, the de-dupe/window/cap, the context window, and that a link carries the exact message
  it was found in.

### Fixed
- **A local path ending in a document extension was classified as a "report"** rather than a file, and
  a bare `www.` host kept its prefix in the link title.

---

## 0.65.0

### Added
- **Home is a reading surface now: an unread inbox, and no rail.** The old Home was a status board —
  a "Now" strip of sessions that needed you, then the activity log — which answered "what is
  happening" but not "what did they say". It is now two columns (design and open questions in
  `HOME_PLAN.md`; the wireframe lives in `home-mockup/`, served by `bun home-mockup/serve.ts`).
  It is **one flat list**, not a stack of cards: no borders, no rounded corners, no section headings —
  consecutive sessions alternate a very slight zebra band and that is the only delineation. One row
  per *session* (blob, title, project · instance · model, unread count, time) and, under it, one row
  per unread *message* — cut on a word boundary with an "…", a filled dot each, no sender label because
  everything under a session came from that conversation. A session you are caught up on is the same
  row with no dots, no count and no message rows. The order is most unread messages first, then
  recency. Six sessions are drawn, then **Show N more sessions** (+10 a press), so Home opens on one
  screen. A row's line reads *messages · requests · comments · notes* and its link says **Open**. A
  pending approval or question is a sticky row — answered, never marked read, so it survives "Mark all
  as read". The right column is the links those sessions shared (a staging page, a report, a file), and
  it hides itself when there are none. The durable activity log survives as a collapsed **Activity**
  section at the bottom, which is the "event stream" from the sketch. The Now strip is gone: its
  prompts are rows, its failures are unread rows, and work in flight is the blob's mood.

### Changed
- **Read state is per message, and it persists.** `settings.readMarks` (`src/lib/readState.ts`) keeps
  one mark per session — a Hearth entry ordinal in `through`, out-of-order marks in `ids`, and a
  timestamp fallback for wires without ordinals. **Opening a session, or reading it on screen, marks
  nothing**: the only ways a mark moves are the dot on one message and right-click **Mark all as
  read**, offered on Home cards and on every rail row (and project-card blob). Marks are pruned with
  their sessions, and the rail's unread dot now means "a message you have not marked read" rather than
  "its `updated` moved since you looked".
- **The first launch after this upgrade starts fully read.** `settings.readSince` is written once, and
  anything older counts as read, so Home does not open with years of unread. (Read state used to be
  in memory and re-seeded as read on every launch; it now survives a relaunch — that is the point.)
- **Home knows what is unread without reading transcripts.** `lastEntryId` from each Hearth summary
  is compared with the mark, and a session that could have new messages gets one bounded read
  (`loadMessageAppend` since the mark, else a 32-message tail). Home never issues a full read, so a
  session whose history is tens of megabytes is as cheap as a short one.
- **Unread colour is the theme's highlight, not red.** Red already means *failed* everywhere in Ember
  (the error mood, failed sends), and an unread card that looked like a failed one would be worse than
  no colour at all. It is one class list in `HomeSessionCard.tsx` if that judgement changes.
- **The top bar's counter counts unread messages** — not sessions, not pending requests.
- **`ChatView` reports a sent comment set** (`onCommentsSent`) so a card's comment tally is real.
- **The rail's drawer toggle is hidden on Home**, because Home has no rail for it to open.

### Notes
- The reading sheet (unread messages one at a time over a blurred Home, with comments in place) is
  **not in this release**: Home's rows open the session at its column for now. Phase 2 in
  `HOME_PLAN.md`.
- New tests: `readState.test.ts`, `unreadDigest.test.ts` (including `excerptText`'s word-boundary
  "…"), `piMapping` coverage for `lastEntryId` and `entryOrdinal`, and `e2e/home.pw.ts` (9 specs:
  no rail, a card is a session, the dot marks exactly one message and survives a reload, opening a
  session marks nothing, right-click on Home and in the rail, ordering, sticky requests, the counter).

---

## 0.64.1

### Fixed
- **A paged history read duplicated the transcript when the host repeated a page.** `collectHistoryPages`
  appended every page's entries with no dedupe, so a host that hands back the same page for a cursor
  that does not advance had its entries collected again and again. Measured on the dev mock (a
  **4-entry** fixture): **800 messages** in the column, 200 requests, duplicate React keys for
  `e90`-`e93`, and `e2e/crew.pw.ts` failing because one crew report rendered eight times. Entries are
  now deduped by id across pages, and a page that contributes nothing new ends the walk — reported as
  **incomplete**, because a host that repeats itself never said it reached the beginning. Same case now:
  **2 requests, 4 entries**, and the reader shows its "earlier messages aren't loaded" affordance
  instead of a wrong transcript. A boundary-overlap page is idempotent too.
- **The dev mock ignored its own cursor and its own `since`.** It always answered with a `next` and
  never filtered an incremental read, which is what made the above reachable in the harness and left
  three e2e specs unusable; it now pages properly and honours `since`.
- **The "No new output for 5m" line no longer lies while reasoning streams.** The stall stopwatch was
  keyed on the message's text length and part count only, and reasoning grows inside a single part —
  so a model visibly thinking for minutes was reported as silent, which the five-minute threshold
  made the common case. `outputSignature()` in `src/lib/turnActivity.ts` now folds in every source of
  visible output: per-part text lengths (`reasoning` included), tool status/output/error/diff/image
  lengths, and how many `codemode` nested calls are still running.

---

## 0.64.0

### Changed
- **Subagents render as bricks, not full rows.** The crew strip was one ~30px row per worker inside a
  `max-h-40 overflow-y-auto` list, so a crew of six scrolled *inside* the card — a nested scroll region
  directly above the composer. It is now a wrapping `flex flex-wrap` of compact bricks: no height cap,
  no inner scroll, a 16px blob, and a truncating title. A crew of ten becomes a few short lines.
- **Workers read as one family with their leader, without losing their own identity.** Bricks tint
  from the *leader's* blob colour — a 10% `color-mix` wash and a 45% border edge, mixed with the theme
  border rather than `transparent` — so the parentage is visible at a glance. Each worker's blob keeps
  the colour it has in its own column: recolouring it would break the identity that `identityFor`
  exists to preserve. No leader identity means no tint at all, and `crew.test.ts` pins a ≥4.5:1
  contrast floor across all three themes and the whole palette (worst case 6.57).
- **Status is a signal, not a word per row.** The per-row text badges are now a dot or edge tint with
  the word in `title`/`aria-label`. `needs input` keeps its word and its highlight, `failed` gets a
  destructive surface so it cannot be mistaken for idle, and `unknown` keeps its dashed "missing
  answer, not a verdict" treatment. The accessible name stays the worker's title, so the existing
  strip locators keep working. `auto` shows only when on.

### Fixed
- **The composer's focus ring no longer draws a second outline while you type.** The 3px
  `focus-within:inset-ring` painted inside an already-bordered `rounded-xl` box; the three states now
  differ by weight — a `border-ring/55` hairline when focus is inside, plus a 1px same-colour inset
  edge when something is `:focus-visible` — so the focused edge reads as a slightly thicker border.
- **"No new output for…" waits five minutes, not ninety seconds.** Long reasoning legitimately looks
  like silence, so the 90s threshold accused healthy turns and stopped meaning anything. The copy now
  reads whole minutes ("5m", not "5m 0s") and the tests derive their expectations from the constant
  instead of hardcoding durations.
- **The composer row gives up controls progressively as a column narrows.** Container-query ladder,
  widest to narrowest: YOLO and YEET drop their labels (icons keep their full `aria-label`/`title`),
  then the handoff button hides, then `ContextMeter`, with the model button, attach and send/stop never
  hidden. The model button's wide cap was a `sm:` *viewport* query inside a container-query row, so on
  a wide screen with a narrow column it could still claim 280px — it is a container query now, and it
  can finally shrink (the `Button` base's `shrink-0` was defeating its `min-w-0`). Verified in
  Chromium across 400–1500px with no sideways scroll at any width.
- **A turn's footer names the reasoning level it ran at**, right after the model, through a shared
  `modelLabel()` that the queued-message row uses too. Both `thinkingLevel` and
  `providerThinkingLevel` are mapped from the assistant entry, on the settled and the streaming path,
  and no level renders nothing rather than a guessed "default". Note the host does not stamp either
  field yet (recorded in Hearth's `TODO.md`), so in practice this shows the model alone until it does.

---

## 0.63.0

### Added
- **Durable Code Mode (`codemode`) and `scratchpad` rendering in the transcript.**
  - `src/lib/piMapping.ts` maps live nested tool executions from `pi.live.nestedTools` while a
    `codemode` script is running and settled nested calls (`details.calls` and `details.fullOutputPath`)
    from `pi.tool-result` entries across both full and incremental (`since`) reads.
  - `src/lib/transcriptReconciliation.ts` (`toolCallEqual`) compares `nestedCalls` and `fullOutputPath`
    so live and settled nested call updates trigger `ToolRow` re-renders instead of being masked by
    structural sharing.
  - `src/components/Transcript.tsx` and `src/lib/activityLabel.ts` format `codemode` and `scratchpad`
    calls in the status line and collapsed tool header (`running <tool> (N calls)` / `N tool calls`),
    render the JavaScript source cleanly in a `Script` block (without JSON-escaped newlines), and show a
    per-step nested call timeline with status icons, arguments, durations, error messages, and
    `fullOutputPath`.

---

## 0.62.12

### Fixed
- **A live tool step is no longer drawn as interrupted, and a finished one no longer stays "running"
  for ever.** The authoritative pass that settles a dead call was gated on `message.completed`, but
  every tool-calling assistant entry ends with `stopReason: "toolUse"` — that open call is what keeps
  the turn going — so the pass skipped exactly the entries that own tool calls. It now decides from
  the run: with no `pi.live.run` the call is `interrupted`, while a run still in flight keeps its
  newest step's calls `pending` and its `live.tools` slots untouched.
- **A full-history repair no longer blanks the streaming answer.** `reconcileFullTranscript` dropped
  every live message it was handed, so a repair landing mid-turn (a compaction ending, a reconnect
  catch-up, a switch-in) erased text the reader was watching. A repair that brings no `pi.live` now
  keeps the held slot until something settles it.
- **A queued message keeps its reply and queued context.** `piEnqueueMessage` submitted the text
  alone while `piSendPrompt` wrote the context as hidden `write` entries, so a queued reply lost the
  message it answered and a queued edit lost its instructions.
- **A reasoning level chosen on a `Server default` session now reaches Hearth.** Both send paths only
  called `/configure` when a model was named, so the level was silently dropped; `thinkingLevel`
  alone is a valid configure. Session creation forwards the model and level too.
- **Cancel/"Send now" on an already-placed queue row no longer lies.** Hearth answers the withdrawal
  with HTTP 200 `{ ok: false, result: "already_settled" }`; that is now the conflict it is (409), so
  the row rolls back instead of reporting a withdrawal that never happened and re-sending a message
  the host had already run.
- **Queue reorder works when a steer is also queued.** Hearth requires every queued id once, steers
  included; the client only knew its follow-up rows and sent a short list, so the host refused it
  with nothing on screen to explain why. The full inbox order is read and merged first, leaving the
  steer where it was.
- **An `unanswered` submission is reported as failed, not sent.** A retried `requestId` that settled
  without reaching the transcript (`reason: "aborted"`, stale, a provider failure) used to render as
  an ordinary sent bubble; it now says why, unless the record carries the entry it did place.
- **A parked follow-up no longer masquerades as a live turn (`C7`).** `queuedLandingKeys` was ORed into
  `sending` on `ChatView`, so any session with a parked follow-up in its queue reported `isTurnLive ===
  true`, showing "Working…", then "…the run may be stuck — Stop is below", and a live Stop button on
  an idle conversation. `sending` is now strictly in-flight sends.
- **Cold-start model catalogues no longer flash a false "model is unavailable" error.** Before
  `modelsByInstance` finishes loading, `models` is empty; `resolveComposerModel` and `ChatView` now
  treat an unloaded catalogue as pending rather than blocking Send with a destructive error.
- **Pins, Find and Jump load or disclose earlier history (`C6`), and virtualized transcripts scroll and
  follow accurately.** The header Pin button renders from `pinnedMessageIds.size`, opening Pins or Find
  triggers `onLoadEarlier` when history is partial, `focusById` scrolls the virtualizer to the target
  index, and upward scroll detection surfaces `Jump to latest`.
- **`FollowUpChips`, `@`-mentions, `ReasoningLevelPicker`, `ImageViewer`, `InstanceBar`, `LeftRail`
  search, `PiClient` WebSockets, and Remote Access for Hearth (`pi:`) instances.** Follow-up chips
  route through the composer's model/variant/queue state; `@`-mention popups track caret movement and
  persist drafts; `ReasoningLevelPicker` can reset to `Default`; `ImageViewer` wires `+`/`-`/`0`/`1`
  zoom keys; `InstanceBar` and `LeftRail` agree on `instanceReady` (`status === 'ready'`), keep group
  rows during search, and show "Search all time" / "Search archived" below partial results; `PiClient`
  adds a 20s connect timeout, reconnects on credential changes, and restarts on OS resume; and
  `remoteServer.ts` + `remoteBridge.ts` proxy `/remote/pi` and `/remote/activity/*` without exposing
  desktop tokens.
- **A poll that predates a local change no longer reverts it.** The archive/rename/create mirrors
  bump `updated`, and the newer local copy now wins even when the poll is the row's identity.

---

## 0.62.11

### Docs
- Backlogged a cost roll-up: the header badge shows only the leader conversation's own `pi.usage`
  ledger, so a delegating session's crew spend is invisible (measured: $1.07 shown against $3.87 in
  17 workers). The entry records the client-side fix — sum descendants by the `lead` chain, count
  archived workers, keep the priced/unpriced/unknown states honest — and notes the host-side
  `costWithDescendants` field as the follow-up only if the client sum proves too fuzzy.

---

## 0.62.10

### Fixed
- **The archive action looks the same everywhere now.** The column header already used a trashcan, but
  the rail row's menu and its hover button, the project card's and group row's "Archive N inactive"
  items, the project cleanup menu, the tab strip (which used an `X`, the same glyph as close) and the
  rail's archived-sessions button still used the old archive box. Archiving is a delete-shaped action,
  so it wears the trashcan everywhere; restoring is a different action and keeps its own arrow.

---

## 0.62.9

### Fixed
- **Every Hearth bearer token was handed to the remote browser.** `GET /remote/settings` returned
  `readEmberSettings()` verbatim, so each `piEndpoints[].token` — a 64-character secret with full
  authority over a Hearth — arrived in the remote page's JSON, which has no `piRequest` and cannot even
  use it. The UI masked it (`maskToken`) while the API handed it over, and the tokens outlived the
  remote session and a password change. The remote surface now receives `token: ''` plus
  `hasToken: boolean`, remote writes strip `piEndpoints` entirely (a posted `''` would have deleted
  every endpoint), and the desktop IPC keeps the real values.
- **Remote access could be "On" over a socket that was never bound.** The server was started once at
  boot; if Tailscale came up afterwards — the normal login case — `startRemoteServer` returned `null`
  and nothing retried, while Settings kept showing the toggle on. There is now a listener state
  (`starting | listening | no-tailscale | error | off`, with the address actually bound), exposed on
  the settings read the renderer already makes, with retry on resume plus a bounded backoff; the same
  path covers `EADDRINUSE`.
- **An expired remote session looked like a broken server.** An HTML/login response was parsed as JSON
  and surfaced as `JSON Parse error: Unrecognized token '<'`. A 401/redirect on a remote route is a
  typed "session expired, sign in again" outcome now, and the event stream stops rather than
  reconnecting silently. A failed settings save on the remote surface no longer resolves as success
  and reverts the visible settings (the body is not adopted unless `ok`).
- **A corrupt file could brick or overwrite what was on disk.** `model-stats.json` memoised a
  *rejected* promise, so a single truncation disabled model experience for the process lifetime —
  including the Clear that would fix it; the bad file is moved aside and a fresh store starts. A
  corrupt `settings.json` silently reset every setting and the next save overwrote it; the unreadable
  file is preserved, defaults are used, the fact is surfaced, and writes are atomic (temp + rename).
  `preferredProvider` now round-trips instead of being dropped on read and deleted on save, and a
  second Ember instance asks for the single-instance lock instead of erasing the first one's model
  observations.
- **Remote hardening:** state-changing requests are refused cross-origin (with the same-origin app
  unaffected), the session cookie is `__Host-`/`Secure` where it can be, an oversized body is a JSON
  413 instead of a socket reset, and password hashing runs off the main thread with an input cap
  (it blocked the event loop for ~140 ms per attempt).

---

## 0.62.8

### Docs
- Backlogged a per-session **reach** choice at creation: today every session may message any named peer
  on its Hearth, with no way to ask for one that only ever sees the workers it starts. The entry records
  the two options in the words a person would read, the wire field it needs (Hearth owns the policy and
  the enforcement), and what the UI must keep honest — the choice governs what the *agent* can reach,
  not what the person can see.

---

## 0.62.7

### Fixed
- **An outage rendered as deletion.** Every list — rail, palette, archive, Home — was built from
  instances that had answered, so an unreachable Hearth's sessions vanished from all of them at once,
  each empty state confidently asserted absence, and the rail (which pins the open session back in)
  showed exactly one survivor and no siblings: the strongest possible signal that the rest were
  deleted. The rail now keeps each silent host's last-known sessions and adds one honest row for the
  host itself ("Keep isn't answering — 12 sessions hidden · Retry"), and empty states distinguish the
  three things an empty list can mean: nothing configured, nothing answering, or a real answer with
  nothing in it. The open session is still pinned in, but it no longer stands alone.
- **A 200 that was not a conversation list erased the rail.** `parseConversations` coerced anything
  non-array to `[]`, so a proxy's HTML, a `null`, an `{error}` body or a number was "zero
  conversations" — a success, applied to the list. The parser can fail now: a body that is not
  `{conversations: [...]}` returns no answer, which keeps the previous list and surfaces the host as
  unreachable; a genuine `conversations: []` is still success and still means no sessions.
- **Cost and context could not say "unknown".** The cost badge tested `cost > 0`, so never-ran,
  unpriced and unknown were all the same silence — and 7 of 99 live conversations have `cost === 0`
  with real entries, which reads as "free" rather than "the provider reports no cost". The badge now
  separates the three and says "Cost unknown" when that is the truth. The context meter compared the
  last turn's tokens against the *selected* model's window and fed that ratio to automatic
  compaction, so switching to a smaller-window model could silently rewrite the session's history on
  a window the turn never ran against. A percentage exists only when both sides are the same model;
  everything else is "Context unknown", with the reason in the tooltip, and automatic compaction
  refuses to fire on an unknown denominator (clicking still compacts).

---

## 0.62.6

### Fixed
- **Delivery was a guess in both directions, and the host knew the answer.** A `201 {status:"placed"}`
  cleared the delivery note, so a send that never landed looked sent for ever — the optimistic id
  stayed pending, every fetch re-appended the bubble, the only missing-send detector skipped it *because*
  it was pending, and the text vanished on reload with no notice. Meanwhile a steer that Hearth
  deliberately keeps across a stop was reported "Not sent. Stopped before this was sent.", with a Send
  again button that duplicated the instruction at the next turn boundary. Ember now reads what the host
  holds: `POST /abort`'s `{parked, parkedText}` receipt decides which of the two stories is true, a
  parked steer keeps its "Waiting for the turn to pause" note and offers Discard instead of a resend,
  and the queue is re-read after a stop because re-parked items carry fresh ids. Steer items are part
  of the queue snapshot (visible and withdrawable) and are excluded from the composer's queue-mode
  decisions. A placed send stays `unconfirmed` until its echo lands, then offers Not confirmed /
  Send again / Discard after a bounded grace; pending ids age out, and the ledger can now report an
  aged pending send instead of structurally exempting it. A placed enqueue also stops adding a
  phantom queue row.
- **Reply context and queued-message instructions were stored, hidden from the transcript, and never
  read by the model.** A write entry reaches model context through `entry.model` alone, so the
  `{kind, data}` shape was decoration. Ember now sends the text in `model` as a user-role text message
  (`data` stays for transcript suppression), matching Hearth's side of the contract. Hearth's half —
  keyword context rules, the same shape from its own route, and validation of what a client may put in
  `model` — is on branch `audit-fixes/context-auth`.
- **A failed sign-in poll was reported as a completed sign-in.** The host stores the credential itself
  and forgets the flow soon after, so a `404` means "it settled" — but the dialog treated *every*
  failed poll that way, so a timeout, a 401 or a 500 rendered "Signed in. Hearth stored the credential
  on its own host." while nothing had been stored. `loginPollOutcome` names the real cases; only 404
  joins complete as success, and every other failure stops with what the host said (or, when there is
  no answer at all, says so and points at the host).

---

## 0.62.5

### Fixed
- **A tool result was thrown away by every incremental read, and a call with no result claimed to be
  finished.** The result and the call it settles are separate entries; an assistant turn commits while
  the tool runs, so the `since` read almost always carries the result *alone*. The mapper looked for the
  call only in the page it was mapping, found nothing, produced no message and dropped the result — and
  once a later entry advanced the cursor it was never read again. The same mapper also defaulted a
  resultless call to `completed`, which claims an output the client does not have. Results are now
  carried as *settlements* (`toolResultSettlements`) and applied to the transcript the client already
  holds (`settleToolResults`) by `toolCallId`, wherever the call came from; applying a settlement that
  changes nothing returns the same array, so row identity is preserved. A call with no result stays
  `pending`, and a full read of a finished turn marks it `interrupted` — the truth — instead of
  completed.
- **A "full" read was the snapshot, which is only the post-compaction window, and it was called
  complete.** `GET /conversations/:id` serves the active entries: measured on the live host, 39 of 872
  entries on one conversation and 727 of 1,822 on another. Ember set `historyComplete` on that read,
  then dropped the flag on the next commit (the state was rebuilt from `{messages,status,failure}`), so
  a compacted session first hid 60–96 % of its history and then spun "Loading earlier messages…" for
  ever with no way out. The full read now walks `/entries` with the `next` cursor in bounded pages
  (250 entries, 8,000-entry cap, 200-page hard stop), maps the whole set in one pass, and reports
  `complete` only when it reached the start. `applyTranscriptCommit` merges a commit into the state
  instead of rebuilding it, so `historyComplete` survives append and tail commits. A genuinely partial
  history now says "Earlier messages aren't loaded yet." and offers to load them, rather than showing a
  spinner that cannot finish.
- **A host that had not answered was drawn as idle, and the UI acted on the guess.** `BallState` had
  no way to say "no answer", so `?? 'idle'` filled the gap in App, the blobs and the crew strip: a host
  that was restarting, unreachable, or simply not polled yet was indistinguishable from one that
  answered "idle". The composer offered a send into a turn it could not see, a dead crew read
  "resting", and "Archive N inactive" counted agents that were mid-flight. `BallState`/`BallMood` gain
  `unknown`; App records when each instance's status endpoint actually answered and derives every
  session's state from that (`lib/sessionState`): no answer, an unreachable instance, or an answer
  older than 90 s is `unknown`, while a missing entry on an answered instance is still a genuine idle.
  Sending stays enabled — the host parks a message behind a running turn — but the composer claims
  nothing and names the host that went quiet; the crew strip says "status unknown" and keeps the card
  open; archiving asks for confirmation unless the session is *known* to be quiet; blobs and the dock
  icon draw unknown as their own neutral treatment. The 16 `?? 'idle'` status decisions are gone.
- **Bulk archive could archive a working session, and "Manage" deleted members it could not see.**
  A missing mood meant "unknown", but both bulk paths read it as `idle`. `sessionStatusAnswer` now
  models `{known,mood}` explicitly and only `known && !isSessionBusy(mood)` is quietly archivable, so
  unknown is excluded regardless of age (and a scheduled sweep can no longer archive a working run
  unattended). Separately, the Manage panel was seeded from a group's *resolved* members, so a member
  on an unreachable instance was absent from the draft and saving wrote the shorter list back: an
  outage silently deleted group membership. `GroupEntry` carries the configured keys verbatim, the
  panel saves them, and unresolved members are explained with the next step that actually applies
  (reconnect the instance / re-add it / the session is gone).
- **`liveSlotHandover.test.ts` failed `bun run check` on `main`.** Seven `no-explicit-any` errors in
  the test added with 0.62.4; typed properly, no behaviour change.

---

## 0.62.4

### Fixed
- **A reply could be drawn twice, for a second or two, and then be gone.** The `pi-live` slot and the
  `pi.assistant` entry that supersedes it are the *same* provider message: pi-ai stamps `timestamp` once,
  when the request starts, and Hearth stores the streaming partial and the committed entry from that one
  message. So the guard that keeps a held slot only while nothing settled is newer than it read `T >= T`
  on exactly the frame it existed for, and the answer stayed on screen twice until some later read
  happened to replace the slot — the successor generation's first partial, or a full read. Measured on
  two busy conversations: 14 episodes in 170 s, each 1.4–3.5 s, longer where a slow tool sat between the
  entry and the next generation. `survivingLive` now retires a slot whose stamp is already settled, and
  one that renders what the last settled assistant already says (a slot that ran past an aborted
  partial), instead of relying on the ordering it cannot see.
- **Why the 0.58.3 fix shipped green:** its tests gave the settled entry `createdAt: 3_000` and the live
  message no `createdAt` at all, so they exercised `0 >= 3000` — false — and the slot was dropped by the
  timestamp rule rather than by the fix. `liveSlotHandover.test.ts` now pins the real shapes: an equal
  stamp with no partial in the read (both the `since` and the tail carrier), an idle read afterwards, a
  successor delta that used to be folded into the stale slot, a tool-use step whose reasoning was drawn
  twice, and the 1 ms-later control that the old fixtures happened to cover.

---

## 0.62.3

### Fixed
- **A worker's blob is the same blob at 22px as at full size.** The crew strip derived each row's
  identity straight from the session key (`seedIdentity`), while the rail, the transcript and the column
  ask `resolveAvatarIdentity` — which folds in the project colour, the avatar override and scheduled
  bindings. So any worker with a project colour or a picked avatar wore one blob in the strip and a
  different one the moment it opened, which is exactly when you are looking at both. The strip now asks
  the caller for the identity its column uses and only falls back to seeding from the key.
- **A finished compaction re-reads the transcript in full.** `pi:compaction_end` refreshed only the
  session list, but compaction *rewrites* history: the old prefix collapses into one summary entry with
  a fresh id. A tail read cannot see that, so the column kept showing every entry compaction had just
  removed — a successful compaction looked like nothing had happened until an unrelated event forced a
  full read. The event now invalidates `messages` in full mode (and still the list), with a test pinning
  both the visible-column and background-session shapes.

---

## 0.62.1

### Changed
- **The composer region is a boundary plus one surface, not two.** The band around the composer painted
  its own fill (`bg-card`) inside which the input card drew a second rectangle, so the follow-up chips and
  the queue above it sat on one rectangle inside another. The band keeps the `border-t` that separates the
  region from the transcript and gives up the fill; the input card is the surface.
- **The reply-context chip is a quote, not a box in a box.** `rounded-lg border bg-muted/50` inside the
  composer's bordered card was a third rectangle for one line of quoted text. It is a left accent
  (`border-l-2` in the highlight colour) on a muted row now, which says "quoted" without drawing a frame.
  Checked and left alone: the activity home and the settings panel are already one surface per block —
  their roots carry no border, so a section card there is not nested in anything.

---

## 0.62.0

### Changed
- **Standing instructions are chosen in the middle of the new-session screen, and nowhere else.** They are
  a radio list under "New agent on <instance>" and the folder: an actual `radiogroup` with a dot per row,
  an **eye** on every row that opens the prompt in full (with "Use this"), and **Custom** at the end for
  your own words. Selecting the row is the choice; the eye is for reading it first.
- **Four prompts ship, and one of them adds nothing.** *Pi classic* is the empty one — the harness prompt
  exactly as it is — because a list of roles with no way to choose none changes every session by default.
  *Ultra delegator* is the bot-assistant shape: decide the work, split it into briefs, run as many workers
  as the work actually splits into, report the result rather than the effort. *Reviewer* and *Researcher*
  keep their scopes.
- **The composer no longer carries an instructions control, in either mode.** A small dropdown beside the
  model picker read as a setting, which is the opposite of what a prompt is. An existing session's prompt
  is now one line in the view menu's "This session" section — what is in force (`Pi classic`, a preset
  name, or `Custom`) and an **Edit** that opens the same editor. Nothing about instructions appears under
  the composer any more; the capability to change it after creation is still there, one level quieter.

---

## 0.61.3

### Changed
- **The queue is a list, not a card inside a card.** A queued line of text sat three surfaces deep — the
  composer band, the queue's `Card` (border, shadow, its own background), and then each row's
  `bg-muted/50` — with three sets of padding between the text and the window. The `Card` wrapper is gone
  and the rows have no fill of their own; the band is the surface and the rows are the list. A failed row
  keeps its destructive tint, because there the colour *is* the information.
  Measured by a rule rather than taste: if removing a border does not make two regions harder to tell
  apart, it was not carrying information. The composer region and the reply-context chip are the next
  two candidates, and they are in `TODO.md` rather than done here, because the queue was the reported
  case.

## 0.61.2

### Fixed
- **A queued message can be edited before it has finished queueing.** The row had an Edit action, but the
  whole action cluster was replaced by nothing while the item was in flight — so the moment a typo is most
  obvious was the one moment the row was inert, and with a slow host or a dropped response that window is
  long. Edit is now offered from the first frame; the actions that need a server id (move, park, send now,
  merge, cancel) still wait for it, and a pending row keeps its loader so it still reads as in flight.
  There is no server-side edit, so the correction is applied the only safe way: while the row is pending the
  new text is recorded and the in-flight request is left alone; when it settles, the ordinary
  enqueue-then-remove replace runs once. While pending the only write is the request already in flight, so
  nothing can be submitted twice. A failed enqueue keeps the row with the *edited* text and its retry input
  matching it — the correction is never dropped, and the item is never duplicated.
  The dialog also pins itself to the row it opened with, so it no longer vanishes mid-typing when the local
