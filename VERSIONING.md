# Versioning

Ember ships **semantic versions**. The version lives in `package.json` (`version`).

## Scheme (semver)

- **MINOR** `0.x.0` — a new feature (a new surface, a new backend capability wired into the UI).
- **PATCH** `0.0.x` — a fix: bug/perf/docs/tests with no new surface.
- **BREAKING** — while pre-1.0, a breaking change also bumps the **minor** and is called out as
  `BREAKING` in the changelog. Bump **major** only once we commit to a frozen 1.0.

Rules:

- Bump exactly one level per shipped change; when unsure, take the higher level.
- Every release gets a `CHANGELOG.md` entry (`Added` / `Changed` / `Fixed` / `BREAKING`).

## Workflow (per change)

1. Read the diff and pick the level.
2. Bump `version` in `package.json`.
3. Add a `CHANGELOG.md` entry.
4. `bun run check` (and `test:e2e` / `test:native` when the change warrants).
5. Commit as `feat|fix: … (0.x.y)`.

Ember and Hearth version independently; a Hearth wire change usually bumps Ember too. The
Instances menu shows each Hearth's reported version.
