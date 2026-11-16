# Release contract

This is the fixed website/download contract introduced by **Ember 1.24.0**, tag `v1.24.0`,
with Kiln `1.12.0`, published and promoted to Latest on 2026-11-16. See [the release record](docs/releases/1.24.0.md).
It does not authorize another release or changes to existing published tags, filenames or bytes.
Subsequent versions follow [Versioning](VERSIONING.md).

Stable release page: https://github.com/noemit/ember-bots/releases/latest

## Permanent downloads

All links use `https://github.com/noemit/ember-bots/releases/latest/download/` plus the exact filename.
The first compliant release, 1.24.0, is now public with all nine downloads and audited manifests.
The website lives separately; changing this repository does not deploy it. Website deployment
still needs its own authorization.

| Platform | Primary download | Secondary download |
| --- | --- | --- |
| macOS Apple Silicon | [Ember-macos-arm64.dmg](https://github.com/noemit/ember-bots/releases/latest/download/Ember-macos-arm64.dmg) | [Ember-macos-arm64.zip](https://github.com/noemit/ember-bots/releases/latest/download/Ember-macos-arm64.zip) |
| Windows x64 | [Ember-windows-x64-setup.exe](https://github.com/noemit/ember-bots/releases/latest/download/Ember-windows-x64-setup.exe) | [Ember-windows-x64.zip](https://github.com/noemit/ember-bots/releases/latest/download/Ember-windows-x64.zip) |
| Linux x64 | [Ember-linux-x64.AppImage](https://github.com/noemit/ember-bots/releases/latest/download/Ember-linux-x64.AppImage) | [Ember-linux-x64.tar.gz](https://github.com/noemit/ember-bots/releases/latest/download/Ember-linux-x64.tar.gz) |

Standalone Tinder uses the same prefix: [tinder-macos-arm64](https://github.com/noemit/ember-bots/releases/latest/download/tinder-macos-arm64),
[tinder-windows-x64.exe](https://github.com/noemit/ember-bots/releases/latest/download/tinder-windows-x64.exe),
[tinder-linux-x64](https://github.com/noemit/ember-bots/releases/latest/download/tinder-linux-x64).
All **nine** downloads are required before promoting Latest. Windows Tinder is built by the existing
Windows pipeline; this is not evidence that a current public release contains it.

## Rules

- Version, tag, release title and packaged version agree. No drafts or prereleases on the stable channel.
- Build final names directly: `package.json` configures builder per platform/target with `${arch}`;
  Tinder names follow the compile target, not the build host. AppImage uses the pre-pack hook
  to normalize builder’s x86_64 spelling to x64 before artifact generation. Never label x64 as ARM. Adding architectures
  needs an explicit contract/index review; the initial gate requires only the three platforms above.
- Standard updater metadata is `latest-mac.yml`, `latest.yml` (signed Windows only),
  `latest-linux.yml`. Keep generated URLs, sizes, SHA-512 values and associated `.blockmap` filenames.
  Never rename after hashing. Upload every generated external map; AppImage's map is embedded.
- Include `SHA256SUMS-macos.txt`, `SHA256SUMS-windows.txt`, `SHA256SUMS-linux.txt` covering final
  downloads, maps and offered channel metadata. Checksums are not code signatures.
- Published bytes, metadata and tags are immutable. Fix mistakes in the next patch; no `--clobber`.
  Identical filenames across **different releases** are intentional: GitHub scopes assets by tag.
- Latest promotion waits for all nine downloads, manifests, applicable updater metadata and native
  release checks. Missing Windows downloads block promotion; never publish broken advertised links.
- Signed automatic updates and manual distribution are separate. An owner-approved **unsigned Windows**
  release must be labelled unsigned, may trigger Windows warnings, and is manual-update-only. It must
  have no `latest.yml` and no packaged stable updater marker. Never disable signature verification or
  invent a publisher to advertise updates. ZIP, tar.gz and Tinder always update manually.

## Assembly and promotion

Use clean output/staging directories. Do not use `--prepackaged` for release AppImages: it bypasses
the naming hook. Build AppImage architectures in separate invocations/directories (mixed architectures
on one shared builder target are refused); additional architectures still need a contract/index review. Follow [native signing and updater gates](docs/updating.md),
including checking the macOS ZIP as well as the DMG. Give the owner Mac commands before Linux packaging.
`bun run dist:cli` emits the final target-specific Tinder name; do not rename it.

Generate each platform's manifest (example next release; only after separate release authorization):

```sh
node scripts/release-assets.mjs checksums release macos 1.24.0 manual
node scripts/release-assets.mjs checksums release windows 1.24.0 manual
node scripts/release-assets.mjs checksums release linux 1.24.0 manual
```

Run each command on that platform's staging directory, not with absent platforms. For signed Windows
use `signed` consistently instead of `manual`. Stage only intended assets; unsigned Windows staging
must exclude generated `latest.yml`. The Windows CI workflow produces manual/test artifacts without
publishing or enabling updates; native checks and owner approval still precede distribution.

Create an authorized draft with `gh release create v1.24.0 --draft --title 'Ember 1.24.0' --latest=false`
and upload the complete verified set without replacing any existing asset. Assemble/download it into
one otherwise-empty directory and run:

```sh
node scripts/release-assets.mjs audit staging 1.24.0 manual
# Only after native verification and explicit publication approval:
node scripts/release-assets.mjs promote 1.24.0 manual
```

Promotion downloads the **actual draft**, verifies required files, metadata SHA-512/size/URLs and all
SHA-256 manifests, rejects unexpected assets and concurrent changes, then explicitly sets
`draft=false`, `prerelease=false`, `make_latest=true`. No automatic tag-triggered publishing is added.
The script cannot verify Apple/Windows trust from Linux: native signature, notarization, architecture
and installed-update checks remain mandatory human gates, not assertions made by a hash audit.

Existing 1.23 updater-enabled installations follow the next release's generated metadata URLs; they
need no filename migration. electron-updater validates cached downloads against the new metadata hash,
not merely the basename. Older installations without updater support bootstrap manually. Signed Mac
A→B and Windows trust checks remain outstanding until actually exercised; do not claim them from a
filename/configuration test.
