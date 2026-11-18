# Native document exploration: bounded design contract

## Resolution and authority

A chat filename is only a candidate until Kiln verifies it. Resolution order is: explicit host-owned absolute/relative path; structured provenance from a successful tool operation that records path and known working directory; then bounded lookup inside the conversation's project scope. Never infer a file read/write from shell command text or prose claims. Duplicate basenames, missing/ambiguous/unverified candidates, and unsupported legacy hosts remain plain text. Never cross hosts implicitly or scan a home disk. Batch/dedupe visible references by host + conversation and bound cache lifetime; invalidate on relevant tool completion, refresh, or conversation open.

## Server/transport boundary

Inspect existing Kiln endpoints before adding routes. Any new route must authenticate with the already configured endpoint credential and bind requests to the selected conversation. Kiln must enforce project-root and explicitly evidenced artifact-root scope, canonical paths, traversal and symlink containment, regular-file-only reads, allowed types, count/size/time limits, and no special files or secret paths. Ember resolves and verifies on the selected host only. Legacy hosts without this contract do not create links.

## Preview isolation

Document bytes are fetched through the trusted bridge, never loaded as raw HTML at the Ember app origin. Markdown renders with raw HTML disabled and relative links can only open separately verified safe docs. HTML preview is static Basic HTML: scripts are always blocked; sanitize active markup and enforce sandbox + restrictive CSP against scripts, event handlers, javascript URLs, forms, frames, plugins, redirects, external network/CSS imports, credentials, and Ember bridge access. Same rules must apply to a popout. Do not weaken existing remote/browser security or retain private contents in PWA caches/storage; clear preview state on logout/expiry. Local images/styles are optional only if proven to remain bounded and same-root.

## UX

Accessible modal identifies host and path, provides rendered/source toggle when practical, Refresh, Download and Open in new window. A deleted/unreadable file yields a host-named recovery message. Detect scripts and calmly disclose that the static view may miss content; offer copy-only prompts (never auto-submit) to serve the original or regenerate a separate script-free HTML/CSS copy, preserving the original. Prompts include correct host/path. Explicit web URLs remain web links. Use `copyText()`.

## Evidence required

Tests cover provenance, duplicate/missing paths, host isolation, bounded caches, traversal/symlink escape, size/type denial and authenticated transport. Browser adversarial tests must show no script, network, navigation, or bridge access in both modal and popout; sanitizer unit tests alone are insufficient. Capture Markdown, static HTML, script notice and plain-text unresolved reference. Run `bun run check` and focused browser/native tests where feasible; state real Tailscale/device validation limits. No release bump, deployment, or network changes. Commit on isolated task branch; coordinator reviews before main push.
