# Settings navigation and placements

Settings uses five categories. Canonical IDs and old entrypoint mapping live in
`src/lib/settingsNavigation.ts`: `general` → Appearance; `instances` → Computers and
Containers. The toolbar opens Providers; instance and outage entrypoints open Computers and
Containers; Add providers keeps its conversation's computer selected. Categories use Radix tabs
for keyboard navigation, a desktop sidebar and a two-column mobile category list.

## Preserved functionality

- **Providers:** saved credential inventory and primary Add provider, API keys, subscription
  sign-in, explicit keep/change default-model decision, removal confirmation, Custom/OpenAI-compatible
  definitions and Ollama. Credential badges report storage, not health. Ollama's existing setup is
  under a Local models disclosure. Sharing stays secondary to the inventory: a guided source → destination → providers → review flow.
  The metadata comparison is available in an optional disclosure, not the primary interaction.
  Changing source or destination clears selected providers and experimental consent; going Back alone
  retains the reviewed choices. Final review names both URLs, credential count, selected providers and
  destination access scope. Existing fill-only, exact custom binding, source-peer reachability,
  desktop-only and explicit experimental OAuth consent policies are unchanged.
  Model experience clearing/retention remains here because it describes model use.
- **Computers and Containers:** connection creation/test/edit/removal and Access credentials,
  reviewed instance alignment, all per-computer model/provider/marker/workspace/project/YOLO defaults
  and existing bulk default controls. Local Ember updates and daily-update preferences remain here,
  distinct from remote Kiln updates. Remote updates have manual ownership guidance, not fake controls.
- **Appearance:** all theme choices; independent interface/conversation/composer sizes and live
  text samples; real Blob renderers for avatar style and size.
- **Conversations:** recent-session window, split view, scheduled-run auto-hide, explicit unread
  and conversation muting guidance. Context & compaction follows these preferences using the reviewed component from task 159425.
  It saves authenticated per-Kiln thresholds and retained-token targets, not local appearance preferences.
- **Remote access:** existing password-gated browser access, listener status, reviewed HTTPS proxy
  setup, recovery warning, Share this Kiln, URL/masked-token reveal/copy, and advanced local-token
  rotation. Browser access, backend sharing and provider sharing remain independent.

No settings schema, auth API, credential-sharing transport, updater backend or process ownership
contract was added. Existing externally managed Kilns remain external; the included Kiln still stops
when Ember quits. Native macOS/Windows installation and physical phone behavior need device testing.

## Evidence

Browser tests capture the production React renderer with isolated fixture accounts. Screenshots
are written to Playwright’s per-test output directory, not a machine-specific report folder.
These fixtures are not a live credential audit. No release or version bump is part of this work.

## Production copy review integration

Applied the root-approved Gemini production review, with security/runtime details preserved: no global
autosave promise; connection/Kiln terminology and correct Remote access paths; compaction defaults and
all smaller-model clamps in a disclosure; no retired ratings language. Generic sign-in prompts remain
generic. Ollama still resolves on the selected Kiln and retains install/resource guidance; custom-model
8k/text defaults remain accessible. Remote HTTPS retains sign-out/anonymous-API checks. Kiln sharing
retains forwarding persistence, external process ownership and independent full-control token warnings.
No updater backend, remote-control facade, version bump, publication or process-lifetime change was added.
The new sharing steps received a second contextual Gemini review; final copy removes repeated guidance
and correctly pluralizes the selected and added credential counts.
