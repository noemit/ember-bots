# Using Ember

[Back to the README](../README.md)

## Chats and drafts

Choose a project or chat in the rail. The current chat sits beside the composer; other chats remain
in the rail. Enable Split view to show more than one conversation. Minimize closes a column without
hiding the chat. **Hide session** (the crossed-out eye) puts the chat away and offers **Undo**;
a working, queued or input-blocked chat asks for confirmation first. Ember does not send a stop
command, but hiding a leader also hides its workers and stops any working workers. Open
**Hidden sessions** in the rail to find it again; **Unhide session** (the eye) brings it back.

The current bot beside the composer keeps both actions: hover it or tab to **Hide session** and
**New bot in this folder**. New bot opens a draft on that bot’s instance in the same folder; nothing
is created until you send. These actions also work in the mini rail and beside an undocked composer.

**Snooze session** moves one chat into **Snoozed**, directly below rail search. The section starts
collapsed and still shows its count, unread messages and requests needing you. Expand it or search
to open a snoozed chat; opening it does not unsnooze it. **Unsnooze session** returns it to the main list.
There is no timer or automatic wake-up: work, queues, drafts and notifications continue unchanged,
and nothing is marked read. Hide is separate; hiding a snoozed chat keeps its snooze preference when
you unhide it. Snoozing never applies to a whole project or to the **For later** notes tray.

Draft text and model choices persist across launches. Attachments and reply context stay in memory.
An unavailable model or reasoning level keeps your draft and choice visible: refresh the catalogue
or choose a replacement explicitly. **Server default** is an intentional selection.

Messages sent while a chat is busy can wait in the host’s follow-up queue. Alt/Option+Enter steers
the running turn instead. Notes stay parked until you send them or bring them back into the composer.
A chat’s running programs appear in its Processes tray and rail indicator.

Read marks belong to the human. Use New unread messages to navigate without acknowledging a reply;
click a reply or press its read bubble when you have read it. A brief background highlight and a
“Marked read” confirmation offer Undo without leaving the conversation. Selecting text or using a
link does not mark a reply read. With several unread replies, Mark all as read clears them together.
Tool steps do not need receipts. “↑ Jump to your last message” appears only when your last message
is above the view and none of your messages is visible; jumping never marks anything read.

Select part of a response or plan to comment on it. Comments remain drafts in a tray until you send
them together. Internal thread-result retrieval does not change your read marks.

## Background threads

The **Threads** shelf shows the chat’s workers grouped under their first-level supervisor, with
second-level workers indented. Open any row to read its live conversation, answer a question or
follow its result links without leaving the main chat. Older, deeper crews remain readable too.
Thread retrieval and navigation never acknowledge messages on your behalf.

New crews have two worker levels: the main chat starts a first-level worker, which can start
second-level workers. If a second-level worker needs help, its new worker joins it as a sibling
under the same supervisor, rather than adding a third level. The requester keeps access to the
work it asked for; unrelated siblings do not gain access to each other. Spawn rate and budget
safeguards still apply, and no replacement or extra worker is started automatically.

## Questions

The **Questions** shelf collects decisions from the current chat and its workers, grouped by their
source. A question does not stop unrelated work. Work that depends on your decision must wait;
silence is never permission. Security approvals remain separate and still block the action.

Read the context, options and recommendation, then choose an option or write an answer. The shelf
keeps the question’s history and shows whether Kiln is holding your answer or has admitted it to the
originating chat. Saving an answer is not proof that the agent has read or acted on it. Answers wait
for the current turn and queued human directions rather than interrupting them.

A stopped, hidden, missing or reassigned origin cannot silently restart or receive permission for a
new assignment. Its answer stays held for explicit review. Withdrawing a question ends that request;
it does not undo work already performed. Older blocking questions and OpenChamber forms continue to
appear in the conversation.

## Context and compaction

Ember offers a quiet **Compact** recommendation above the composer at approximately 100,000
current-context tokens, or 60% of the selected model’s context window if that is lower. The smaller-window
threshold leaves room for the next reply and tool output; it is conservative advice, not a guarantee
that a particular prompt fits. This measures the active context, not summed billed tokens or crew usage.
Hosts that do not report current context do not show the recommendation.

Compaction is your choice. Ember does not automatically compact from this recommendation, interrupt a
running turn, start a worker, or change your model. Kiln’s existing near-limit/overflow safety
compaction remains unchanged. Wait for the turn to finish, then choose **Compact**
to summarize older context while retaining recent messages. A conversation that already fits may have
nothing to compact. Dismiss hides the advice through further growth and polling; a new context prefix
(after compaction/reset) or a substantial drop in usage rearms it. Dismissal is local to the mounted
conversation view, not a permanent setting.

Kiln workers reaching about 100,000 current-context tokens receive advisory instructions to finish
their bounded assignment and leave a concise durable handoff: progress, files, commits, tests, blockers
and next steps. Their leader is advised to prefer a fresh Sol/Luna worker for substantial new work.
Small completion work and an explicit override may continue; this is guidance, not a hard execution
ban. Queued directions are retained, and no replacement worker is started automatically. Older Kilns
without this policy continue their existing worker behavior.

## Providers

Open **Settings → Providers**, choose the Kiln instance, and paste a key. Credentials stay on that
instance (in its `auth.json`) and are never sent back to the Ember window; a connected provider shows
the credential type beside its name, and **Remove credential** forgets it. Ember offers the
provider's models in the composer picker once the key is saved and the instance's catalogue refresh
completes — usually within a second, in the background.

Sign-in is offered only where the flow can finish. Everything else, including both providers below,
is an API key.

### OpenRouter

- Provider row: **OpenRouter**. Key from <https://openrouter.ai/keys>.
- Environment variable for a standalone Kiln: `OPENROUTER_API_KEY`.
- Model ids are OpenRouter's own routes, `vendor/model`, for example `anthropic/claude-sonnet-5.5`.
  With a key, the list is filtered by `GET /models/user`, so a model your account cannot use is not
  offered.
- Hearth ships OpenRouter's catalogue, so the picker is populated offline as well; the account read
  only narrows it.

### DeepInfra

- Provider row: **DeepInfra**. Key from <https://deepinfra.com/dash/api_keys>.
- Environment variable for a standalone Kiln: `DEEPINFRA_API_KEY`.
- Endpoint: `https://api.deepinfra.com/v1/openai` (OpenAI-compatible).
- Model ids are DeepInfra's routes, `vendor/model`, for example `Qwen/Qwen3-32B` or
  `anthropic/claude-opus-4-7`. The id is what is sent on the wire; the picker shows the part after
  the slash.
- The list is read from `GET /models` and cached on the instance, so it survives a restart and a
  refresh failure. Only chat models are listed — DeepInfra's embeddings, rerankers, image, video and
  speech models are not chat models and would fail on send.
- Context window, output limit and pricing come from the same response (prices are US dollars per
  million tokens). A model whose entry is missing one of those reports 0 cost or a stated default
  rather than an invented number.

## Keyboard controls

Use Cmd on macOS and Ctrl elsewhere. Tooltips show shortcuts on the relevant controls.

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+K` | Search sessions and notes, or start a new bot |
| `Cmd/Ctrl+1–9` | Activate an open session slot |
| `Cmd/Ctrl+F` within a column | Find in the conversation, including offscreen history |
| `Enter` | Send, or queue a follow-up while the chat is busy |
| `Shift+Enter` | Insert a new line |
| `Option/Alt+Enter` | Steer now instead of queueing a follow-up |
| `Cmd/Ctrl+Enter` | Save composer text as a note in an existing chat |
| `Up` in an empty composer | Recall your last sent message |
| `Cmd/Ctrl+Alt+C` with transcript text selected | Open a comment on the selection |

## Local data and model experience

The default desktop data directory is `~/.ember`. `EMBER_DATA_DIR` gives a development build its own
data and Chromium profile; OpenChamber configuration remains separate.

| Location | Purpose |
| --- | --- |
| `~/.ember/settings.json` | Appearance, workspace, drafts, model choices, notes, pins and remote-access settings |
| `~/.ember/model-stats.json` | Observed model-call metadata and personal ratings |
| `~/.ember/hearth.sqlite` | Included Kiln’s conversation history |
| `~/.ember/hearth.token` | Included Kiln’s bearer token; some CLI setups also keep `ember.token` |
| `~/.config/openchamber/settings.json` | OpenChamber instance discovery; read by Ember |

Keep settings and tokens private: settings can contain draft text and notes. Older settings under
`~/.config/ember` are migrated on launch.

Model scorecards use metadata from messages Ember already receives, not extra model evaluations.
They retain up to 10,000 observations from the last 90 days, without transcript text or tool
payloads. Clear observations and ratings in **Settings → General → Model experience**.

These are personal observations, not a benchmark or an automatic model router. Coverage is limited
to chats Ember has seen; missing costs remain unknown, and reported durations may include tools or
waiting. Helpful / Not helpful ratings reflect your assessment of a reply.

Scheduled runs can hide themselves a day after finishing, controlled by **Settings → Sessions →
Auto-hide scheduled runs**. Working or open runs remain available, and hidden runs can be
found through Scheduled or Hidden sessions.
