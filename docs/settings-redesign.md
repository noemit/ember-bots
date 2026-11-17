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
  under a Local models disclosure. Sharing stays a secondary reviewed flow. The existing dense comparison matrix and review
  panel are intentionally preserved; this is NOT the approved staged source → destination → providers
  → review wizard. A guided wrapper remains a design gap for root review. Security remains its existing
  fill-only, exact custom binding, source-peer reachability and experimental OAuth consent policies.
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

Actual production React renderer captures (the existing mock bridge supplies isolated test accounts)
are under `/home/em/reports/ember-settings-production/evidence/`. This is not a live credential audit.
The implementation task report in that directory records commands and limitations. No release or
version bump is part of this work.
