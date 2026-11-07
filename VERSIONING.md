# Versioning

Ember uses semantic versions. The release version lives in `package.json` (`version`).
Commits and pushes are development work; they are not releases.

## Scheme (semver)

- **PATCH** — backwards-compatible fixes, with no new features.
- **MINOR** — backwards-compatible features.
- **MAJOR** — breaking changes after 1.0. Before 1.0, breaking changes bump the minor.

Choose one bump for the complete batch since the last public release. Use the highest level
required by that batch, rather than counting commits or individual features.

## Development

- Commit and push completed work without changing the version.
- Optional changelog notes go under `Unreleased`, not a new numbered entry per commit.
- A local build or test package does not require a release version bump.

## Release workflow

1. Review all changes since the last public release and choose the next semantic version.
2. Bump `version` in `package.json` once for the release.
3. Consolidate the batch into one dated `CHANGELOG.md` entry (`Added` / `Changed` / `Fixed` /
   `BREAKING`). Move any `Unreleased` notes into that entry.
4. Run `bun run check` and relevant end-to-end or native checks.
5. Commit the release preparation, then build every platform from that same commit.
6. Publish the matching tag and release only when publication is authorized.

Do not reuse or lower a version already published. Release tags and packaged application versions
must agree. These rules do not retroactively rename existing releases.

Ember and Kiln version independently. Only bump Kiln when preparing its release; a wire change
only requires a new Ember version when Ember is also being released.
