# Versioning

Kiln ships **semantic versions**, not commit hashes. The running version is what `/health`
reports (`version`, embedded from `package.json` at build time) and what Ember's Instances menu shows.

## Scheme (semver)

- **PATCH** — backwards-compatible fixes, with no new features.
- **MINOR** — backwards-compatible features: new routes, fields, or behaviour.
- **MAJOR** — breaking changes after 1.0, including incompatible routes, response shapes,
  authentication, or behaviour. Before 1.0, breaking changes bump the minor.
- Call out breaking changes as `BREAKING` in the changelog.

Rules:

- Bump once per release for the complete batch since the last public release. Ordinary commits
  and pushes do not bump versions. Choose the highest semantic level required by the batch.
- The version lives in `package.json` (`version`). Never hard-code it in source — `/health`
  uses the embedded `kilnVersion`, so launch directories cannot change it.
- Every release gets a `CHANGELOG.md` entry (`Added` / `Changed` / `Fixed` / `BREAKING`).

## Workflow (per release)

1. Review the complete batch since the last public release and pick the level.
2. Bump `version` in `package.json`.
3. Consolidate the batch into one `CHANGELOG.md` entry. Optional development notes go under
   `Unreleased`, not numbered entries for individual commits.
4. `bun run check`.
5. Commit the release preparation and build from that commit.
6. Publish the matching tag and release only when authorized. Restart the deployed Kiln so
   `/health` reports the new version.

Local builds do not require version bumps. Do not reuse or lower published versions. Tags and
packaged versions must agree. After 1.0, breaking changes bump major, features minor, and fixes patch.

Ember and Kiln version independently; only bump each when preparing its release.
