# Notes for the next release

Work in flight that deserves a sentence in the release notes. This is a **scratchpad, not the
changelog**: it collects the things worth boasting about while they are fresh, in whatever order they
landed. When a release is prepared, the entries here are rewritten into one dated `CHANGELOG.md`
entry per `VERSIONING.md` and this file is emptied.

Keep each entry to what a person using Ember would notice, with the detail that makes it credible.
If something was fixed because it was wrong, say what was wrong — "it used to name sessions after the
first stray word" earns more than "session naming improved".

---

## Session names: provisional, then earned

A new conversation used to be named once, from the human's first message. That is the right seed —
local, deterministic, available before the host answers — but it is often only *intent*, and the name
came out describing the ask rather than the work: "lets close the design gap" was
"Assiduous Cartographer", which tells you nothing about what happened next.

Sessions now start with that name **provisionally** and are renamed once when the bot's first
substantive reply lands, because the reply is the thing that names the subject. "Fix the tray tint"
keeps `Tray Mechanic`; a request that said nothing keeps a roster name until there is something
better. A rename by hand is final — the upgrade never touches a name a person chose — and a session
that never gets a real reply keeps the name it was created with.

Worth a sentence in the notes because the visible effect is that a rail of sessions reads as *what
each one turned out to be* rather than how each one was asked for.

## Session names no longer pick a stray word

Found while building the above, and a genuine bug rather than a refinement. Asking
"why do we have so many folders here that are ember-[something]" named the session **"Have Scout"**:
the subject picker skipped only the *first* word it did not recognise, so `why` → `do` → `we` left
`have` standing as the topic, and paired it with a Scout.

Two fixes. Weak openers are now skipped as a **run** rather than one at a time, and words that are
never a subject are rejected outright — auxiliaries and pronouns, irregular past tenses ("asked",
"found", "told"), and the regular `-ed`/`-ing` verb shape, which is what an answer almost always opens
with ("I found…", "I changed…"). The same request now falls back to a roster name instead of naming
itself after a helper verb.

## Corrected a comment that was quietly wrong

The header comment in `src/lib/sessionNameFallback.ts` claimed the noun "comes from a fixed roster,
never from the message". That was false — `matchRole` and `detectTone` read the message on every name
— and it misled two readers into thinking topic matching did not exist. It now says what the code
does: the message *selects* a noun from a closed roster but never *contributes a word* to it, which is
the property that actually makes "What Gardener" impossible.

Not a user-facing line, but worth recording: a comment that describes the design you *intended*
rather than the one you shipped is a bug with a long fuse.

## Antigravity, and a sign-in that can ask you a question

Ember can now sign in to **Google Antigravity** — the Google account that fronts Gemini, Claude and
GPT-OSS models through Cloud Code Assist. It is a *browser* sign-in rather than a device code: the
provider opens Google's consent page and expects the browser to land on a loopback address on the
machine running Kiln. That is fine when you are sitting at that machine and useless when you are not,
which is the case the interesting half of this work is about.

So a sign-in can now ask you something while it runs. The flow parks on the question, the question
appears in the dialog, you paste back the redirect URL your browser landed on, and the flow carries
on. One sentence in the dialog explains the trick that makes it work: the page *fails to load*, which
looks like an error and is actually the address you need to copy.

Deliberately, a host that cannot deliver the question refuses the flow and says which machine can
finish it, rather than offering a button that sits there. A flow parked on a question nobody can see
is worse than an honest no — it looks exactly like "still working".

Along the way the flow that already existed got honest too: ChatGPT's sign-in asks which method to
use (browser or device code) and Ember now answers "device" on the human's behalf, because a device
code is the branch that works everywhere. That button has been in Settings → Providers for several
releases and could only ever fail.

The wire is small and worth knowing: `POST /providers/:id/login` gains `{ prompt: { capable: true } }`,
a question arrives as a `question` event, and the answer goes back to
`POST /providers/:id/login/answer`. A client that says nothing keeps the old behaviour except for the
one thing that was quietly wrong: a flow blocked on a question nothing can answer now reports
`failed` with the question quoted, instead of `pending` forever.

One bug worth recording, because it is the kind that hides: the SSE reader lost any frame that
arrived split across two network reads. A fixture that delivers a whole body in one chunk cannot see
it, and neither could the first version of the test — the frame sat in the buffer, unparsed, and
since the *only* thing usually in a split frame is the finish reason, every real turn would have
reported "ended before it finished". Drafting a reasoning-then-text-then-tool-call transcript looked
perfect; a real stream would have failed on turn one.

## New provider, from the model picker

The place you notice a missing provider is the model picker: you opened it looking for a model its
host does not have yet. The way to add one was a button that only appeared when the host had *no*
models at all — so a host with two models was not a dead end, it was a detour through Settings.

There is now **+ New provider** in the picker's footer, beside Refresh. It opens the Providers screen
for that session's own host, which is where the key is pasted or the account signed in, and the two
empty-state and footer buttons read the same so they are one feature rather than two.

## Antigravity shows your account's models, not our guess at them

The first cut shipped a fixed list of eight models, so **Refresh did nothing**: it re-fetched the same
table. Models the account was entitled to simply were not in the picker, and a new Gemini release
could not appear at all.

The list now comes from the account. Every refresh reads `fetchAvailableModels` across the daily,
sandbox and production endpoints — unioned, because a new generation reaches the daily host before
production — and groups the runtime catalogue into the models a person picks: thinking-level suffixes
become the levels, `-agent` ids fold into the family they belong to, and internal placeholders and
image endpoints stay out.

Two things the stub caught that a unit test would have missed: a discovered model was priced at
**$0** (rendered as "free", hiding real spend) and Claude was reported as not reasoning. Both are now
inherited from the family, and both have tests.
