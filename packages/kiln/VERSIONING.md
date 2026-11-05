# Versioning

Hearth ships **semantic versions**, not commit hashes. The running version is what `/health`
reports (`version`, read from `package.json` at startup) and what Ember's Instances menu shows.

## Scheme (semver; the wire is pre-1.0)

- **MINOR** `0.x.0` — a backwards-compatible feature: a new route, a new field, new behaviour.
- **PATCH** `0.0.x` — a fix: bug/perf/docs/tests with no new surface.
- **BREAKING** — the wire isn't frozen pre-1.0, so a breaking change (a route removed/renamed, a
  response shape changed, an auth/behaviour change a client depends on) also bumps the **minor**
  and must be called out as `BREAKING` in the changelog. Bump **major** only once we commit to a
  frozen 1.0 wire.

Rules:

- Bump exactly one level per shipped change; when unsure, take the higher level.
- The version lives in `package.json` (`version`). Never hard-code it in source — `/health`
  reads it via `hearthVersion`.
- Every release gets a `CHANGELOG.md` entry (`Added` / `Changed` / `Fixed` / `BREAKING`).

## Workflow (per change)

1. Read the diff and pick the level (patch/minor/breaking).
2. Bump `version` in `package.json`.
3. Add a `CHANGELOG.md` entry.
4. `bun run check`.
5. Commit as `feat|fix: … (0.x.y)`.
6. Restart the running Hearth so `/health` reports the new version.

Ember and Hearth version independently; a wire change usually bumps Hearth and Ember together.
