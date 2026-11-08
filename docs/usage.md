# Using Ember

[Back to the README](../README.md)

## Chats and drafts

Choose a project or chat in the rail. The current chat sits beside the composer; other chats remain
in the rail. Enable Split view to show more than one conversation. Minimize closes a column without
archiving the chat. Archive puts the chat away and offers Undo; a working, queued or input-blocked
chat asks for confirmation first. Archiving does not send a stop command.

Draft text and model choices persist across launches. Attachments and reply context stay in memory.
An unavailable model or reasoning level keeps your draft and choice visible: refresh the catalogue
or choose a replacement explicitly. **Server default** is an intentional selection.

Messages sent while a chat is busy can wait in the host’s follow-up queue. Alt/Option+Enter steers
the running turn instead. Notes stay parked until you send them or bring them back into the composer.
A chat’s running programs appear in its Processes tray and rail indicator.

Read marks belong to the human. Use Go to new messages to navigate without acknowledging a reply;
press its read bubble when you have read it. With several unread replies, Mark all as read clears
them together. Tool steps do not need receipts.

Select part of a response or plan to comment on it. Comments remain drafts in a tray until you send
them together. Internal thread-result retrieval does not change your read marks.

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

Scheduled runs can archive themselves a day after finishing, controlled by **Settings → Sessions →
Auto-archive scheduled runs**. Working or open runs remain available, and archived runs can be
found through the scheduled view.
