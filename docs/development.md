# Developing Ember

[Back to the README](../README.md)

## Local setup

Install Node.js 22.12+ and Bun 1.4.2. From this repository’s root:

```sh
bun install
bun install --cwd packages/kiln
bun run dev
```

`dev` builds the included Kiln, renderer and Electron code, then launches the app. For an isolated
profile alongside a daily install:

```sh
EMBER_DATA_DIR=/tmp/ember-canary bun run dev
```

The profile has its own data, local Kiln port and Chromium profile. Quitting it stops only its own
Kiln. OpenChamber’s configuration is shared and read-only. Do not enable remote access in both
profiles at once.

For renderer work with mock data and hot reload:

```sh
bun run dev:web
```

Open `http://localhost:5179`. `?threads` demonstrates source links and quiet internal coordination;
`?legacy` selects the OpenChamber mock. These fixtures do not operate on real accounts or sessions.

## Development and verification

| Command | Purpose |
| --- | --- |
| `bun run dev` | Build and launch Electron with the included Kiln |
| `bun run dev:web` | Run the renderer with synthetic sessions under Vite |
| `bun run build` | Build Kiln, renderer and Electron code |
| `bun run typecheck` | Check renderer, Electron and Kiln TypeScript projects |
| `bun run lint` | Run ESLint |
| `bun run test` | Run Bun unit and regression tests |
| `bun run check` | Run typecheck, lint and unit tests |
| `bun run test:e2e` | Run Playwright browser regressions against the mock UI |
| `bun run test:native` | Build and test Electron IPC and authenticated remote access with isolated fixtures |
| `bun run buddy-arena` | Run the Buddy avatar development playground |

### Packaged code-mode sandbox

`bun run build:harness` and `bun run dist:cli` embed QuickJS WASM and a separate worker entrypoint.
Both commands then **run the just-built executable with `--self-test-codemode` automatically**.
Compilation alone is not success: a nonzero exit, launch failure, signal or 20-second timeout fails
the build, removes the unchecked executable, and stops the packaging command. The check runs with
an empty temporary working directory and an allowlisted environment, without credentials, models,
server startup or a live-service restart. There is no skip flag.
Keep the worker beside both main entrypoints and retain Bun's default entry naming/root: its sibling
URL must resolve in both source Bun and the compiled module graph. The shared sandbox factory loads
WASM only when code mode is enabled; never replace its worker sandbox with inline execution.

Run `bun test ./tests/packagedCodemode.test.ts` to build both production binaries, copy each into an
isolated temporary directory, and exercise `--self-test-codemode`. This offline diagnostic runs before
server/database startup, calls a host tool from QuickJS, times out an infinite loop while checking
host responsiveness, and verifies a subsequent execution succeeds. It needs no provider or installed
`node_modules`, creates no user profile, and the test kills a stuck executable after 20 seconds.
Run this regression natively on macOS, Linux and Windows for their respective releases. The shared
build script supports native targets only and rejects extra arguments, including target/skip flags.
If cross-compilation is added later, any cannot-execute exception must be explicit and documented;
the artifact must still pass this check on its target platform before release. Never interpret a
launch failure as a reason to silently skip verification. `tests/packagingGate.test.ts` also checks
the script's fail-closed behavior for both binaries and all three platform naming conventions. Upstream Bun limitations still apply to built-ins that do not poll QuickJS's interrupt flag.

Install the browser before running Playwright suites:

```sh
bunx --no-install playwright install chromium
```

Before submitting changes:

```sh
bun run check
bun run build
```

Also run browser tests for UI changes, and native tests for Electron, persistence or remote-access
changes. The native suite requires a GUI-capable environment. It isolates its home directory,
browser profile, settings and upstream instance; it does not operate on real sessions or validate
real Tailnet routing.

## Architecture

Ember’s renderer handles the workspace and interactions. The Electron process owns native
integration, settings, authenticated transport and optional browser access. Kiln owns agent
execution, conversation history, permissions, queues and background thread coordination. Additional
Kilns and OpenChamber hosts connect through the same renderer-facing API layer.

```text
electron/          Native process, preload bridge, transports, remote server, persistence
src/App.tsx        Workspace state and cross-instance coordination
src/components/    UI, composers, transcripts, model picker and settings
src/hooks/         Polling, settings persistence, feedback and queues
src/lib/           Reconciliation, caching, naming, search and workspace helpers
src/blob/          Creatures, moods, palettes, animation and dock rendering
src/dev/           Browser-only mock bridge and fixtures
packages/kiln/     Durable harness, Tinder CLI, server and harness tests
e2e/               Browser and native integration tests
tests/             Renderer and desktop unit/regression tests
sketches/          Standalone design studies outside the app build
```

SSE events are invalidation hints; REST responses remain authoritative. Reads are coalesced,
streaming uses bounded transcript tails, and full reads repair history. The transcript cache has a
byte budget, while protecting visible conversations and pending sends; it is not a hard process
memory limit.

See [AGENTS.md](../AGENTS.md) for invariants and [Kiln’s README](../packages/kiln/README.md) for its
wire contract. New background threads use durable task versions, result references and selective
continuations rather than repeated report text. Retrieval, verification and human read marks are
separate concepts.

## Packaging

| Command | Output |
| --- | --- |
| `bun run dist:mac` | macOS desktop distribution |
| `bun run dist:linux` | Linux AppImage and archive |
| `bun run dist:win` | Windows desktop installer |
| `bun run dist:cli` | Standalone Tinder executable |

Build on the target platform. Outputs go to `release/`. On **macOS, Linux and Windows**, the included
Kiln (`build:harness`) and standalone Tinder (`dist:cli`) must pass the automatic packaged codemode
self-test before distribution. Preserve this gate in every release path; do not ship a binary made
with a direct `bun build --compile` invocation that bypasses it. See the [sandbox verification
instructions](#packaged-code-mode-sandbox) above for the offline regression.

macOS release signing and notarization
require the release credentials; a source build alone does not establish that a published binary
was signed or notarized.

The [Windows workflow](../.github/workflows/windows.yml) builds the installer and Tinder, creates
checksums, and launches the packaged app with a fresh profile to check its included Kiln lifecycle.
Successful runs upload the `ember-windows-x64` artifact.

## Contributing

Start with a concrete problem or proposed interaction in
[GitHub Issues](https://github.com/noemit/ember-bots/issues), or submit a focused pull request.
For UX changes, explain how the human reviews work, makes a decision or steers the bot. Prefer
cohesive modules, explicit ownership and progressively revealed controls.

Follow [AGENTS.md](../AGENTS.md), run the checks appropriate to the change, and document material
limitations. Shipped changes update [CHANGELOG.md](../CHANGELOG.md) and the appropriate package
version according to [VERSIONING.md](../VERSIONING.md). Kiln versions independently.

README work uses the repository-scoped [README Atlas skill](../.agents/skills/readme-atlas/SKILL.md).
Verify commands and distribution claims against source and actual release assets; label sample
screenshots and keep the first-use path separate from contributor setup.
