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
