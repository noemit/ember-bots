/** Synthetic prose for judging long-message layout without changing the everyday demo fixtures. */
const sections = [
  ['Keep the human’s decision visible',
    'The first screen should make it easy to understand what the bot is doing, what it has learned, and whether it needs a decision. Those are different kinds of information. A stream of tool output can explain activity without telling the reader what matters. A useful reply should lead with the finding, connect it to the original request, and leave supporting evidence available below.',
    'For this workspace, I would keep the conversation as the place where the person thinks and steers. Background work can continue elsewhere, but the foreground should remain easy to interrupt. A person should be able to ask a question, change a constraint, or say that a direction is no longer useful without waiting for every worker to finish.'],
  ['Give each module one reason to change',
    'A cohesive module owns a complete concern: its inputs, its decisions, and the small amount of state needed to carry them out. The session naming module should decide how a prompt becomes a relevant name. It should not need to know how the rail renders, how the provider authenticates, or whether a conversation is open in a split view.',
    'The same principle applies to read acknowledgement. The rules for which messages need a read mark belong together. The visual bubble can depend on those rules without reimplementing them. When a tool-only step stops counting as unread, that decision should change once and reach the rail, the conversation, and scheduled runs through the same derivation.'],
  ['Make the common path small',
    'Most people opening a conversation want to read the latest useful reply and send a direction. They should not have to inspect model settings, scheduling controls, thread metadata, and connection details to do that. Those controls still matter, but they can appear when the person opens a tray, changes a setting, or asks for more detail.',
    'Progressive disclosure works best when the hidden material has an obvious home. A small Threads control can explain that work is happening elsewhere without displaying every internal exchange. A model picker can retain its current choice without showing all provider configuration. The test is whether someone can predict where to look when they finally need the extra control.'],
  ['Preserve identity across the workspace',
    'The creature is a memory aid. Its colour, silhouette, and name should stay stable while the surrounding information changes. Someone may remember the purple tangle long before they remember the exact title of the authentication investigation. That recognition should continue when the chat moves from the rail to the composer, opens in a second column, or returns from the archive.',
    'Animation can add useful state without replacing that identity. Working should suggest ongoing effort; thinking should feel different; a question should make the need for human input legible. These distinctions should survive at a small size, and reduced-motion mode should retain a clear static cue rather than making every state look identical.'],
  ['Separate acknowledgement from navigation',
    'Opening a chat is navigation. Reading a message is a human act, and acknowledging that reading is an explicit choice. The application should not silently collapse those three things into one timestamp. A person might open a conversation to inspect a file, copy a command, or answer an earlier question without having read the newest reply.',
    'The unread bubble should therefore acknowledge one reply immediately, show a visible check, then leave quietly. Go to new messages should move the reader without changing their marks. Mark all as read is useful for a larger backlog, but it should not become the only way to dismiss two messages. Tool execution history does not need the same acknowledgement treatment as a substantive answer.'],
  ['Treat background threads as inspectable work',
    'A thread needs a concrete outcome, a stable identity, and a result that can be referred to later. It does not need to perform a social ritual of reporting back every time it finishes. If the foreground has already used a finding, receiving the same finding again as a report creates repetition without adding confidence.',
    'The useful alternative is a durable outcome with an evidence reference. The leader can quote a finding and let the person open the source thread when they want to inspect it. Retrieval, verification, and incorporation should remain separate facts. Looking at a result does not prove that it is correct, and storing a completion event does not mean the human has read it.'],
  ['Make long replies easy to scan',
    'A long message should have a readable measure, clear paragraphs, and headings that describe the next idea. It should not become a stack of decorative cards. The structure comes from the argument: the finding, the evidence, the consequence, and the decision it supports. Lists help when items are parallel; prose is better when one point depends on the previous one.',
    'This deliberately lengthy example is useful because a layout that feels calm with two sentences can become awkward after several screens. Watch whether the reply feels too wide, whether headings interrupt the rhythm, whether the composer crowds the last paragraph, and whether the read bubble still belongs clearly to this message rather than floating near an unrelated control.'],
  ['Keep provider configuration local unless asked',
    'A connected provider belongs to the host that will run the work. Two computers can use different accounts, model defaults, and local runtimes for sensible reasons. Sharing settings should be deliberate and should explain which direction information moves. An alignment action should fill gaps without quietly replacing working credentials.',
    'API keys and subscription sign-ins also behave differently. A stored key can be copied to another trusted host when the person asks. An account sign-in may rotate tokens or depend on a provider-specific flow. Presenting both as interchangeable credentials would hide an important distinction. The interface should keep that difference understandable without making the normal setup feel technical.'],
  ['Use errors to explain the next useful step',
    'An error is often the point where the person most needs clear language. Naming the host helps them understand whether the problem belongs to this computer, a remote instance, or a provider. A sentence that points to the visible recovery control is more useful than an isolated failure label. The message should fit the seriousness of the situation.',
    'For example, a host that may be asleep deserves a calm explanation and a retry path. A failed send needs to keep the draft and attachments available. A background retry should not look like a permanent failure. These distinctions reduce the amount of interpretation the person has to do before they can decide what to try next.'],
  ['Keep scheduled output in the ordinary conversation flow',
    'A scheduled run produces messages, so its output should arrive as a normal session. The person should be able to recognize the creature, read the reply, and acknowledge it using the same controls as any other conversation. A small indication of what started the run can provide context without creating a second inbox.',
    'The schedule itself has a different purpose: it describes a trigger, its timing, and its next run. Keeping those details in Scheduled avoids duplicating an administrative list in the main rail. Older runs still need to be accessible, including archived conversations, because a person may want to compare what changed between yesterday’s result and today’s result.'],
  ['Verify transitions as visible behaviour',
    'A component can exist in the document while being invisible to the reader. A passing test that finds a check icon does not prove that the check stayed painted long enough to see. The same problem appears with loading states, confirmation toasts, and a creature travelling between the rail and composer.',
    'Tests should observe the property that matters: visible opacity, a stable target, a persisted read mark, or a message that remains available after reload. Manual inspection adds a different kind of evidence. It can reveal that a transition feels abrupt or that an action looks destructive even when the underlying operation is correct. Both forms of verification have a place.'],
  ['Leave room for the person to disagree',
    'The bot’s recommendation is a proposal. It should make the tradeoff understandable, show what evidence supports it, and preserve the person’s ability to choose another direction. A highly capable assistant can still reduce agency if it turns every uncertain finding into a confident instruction or hides the alternatives that would change the decision.',
    'My recommendation is to make the common flow calmer first, then add optional depth where a real task needs it. The workspace should help the human hold the problem in mind. If a new control makes the interface busier without making a decision easier, it probably belongs behind a disclosure or should wait until its purpose is clearer.'],
];

export const longDemoPrompt = `Review this bot workspace as if we were preparing it for daily use across a laptop and an always-on computer. I care about high cohesion, low coupling, and an interface that keeps the human in charge of thinking and deciding.

Please give me a thorough review rather than a short checklist. Explain how the rail, composer, read acknowledgements, background threads, provider settings, and scheduled output fit together. Use concrete examples, call out the tradeoffs, and finish with an implementation order. Include a small comparison table and a code example so I can see how mixed content reads in a long reply.

This is a layout study as well as a product discussion. I want to scroll through a genuinely long response, select a paragraph for feedback, and see whether the message controls remain understandable. Keep the recommendations provisional: I want to review the reasoning before choosing what to build.`;

export const longDemoReview = `The workspace has a clear organising idea: **the human thinks, decides and steers**. The most useful improvements strengthen that idea while reducing the amount of interface the person has to interpret.

This is synthetic demo content. It is intentionally several screens long so you can judge paragraph spacing, headings, tables, code, selection comments, and the position of the read acknowledgement.

${sections.map(([title, first, second], index) => `## ${index + 1}. ${title}\n\n${first}\n\n${second}`).join('\n\n')}

## A small comparison

| Decision | Default | Reveal when needed |
| --- | --- | --- |
| Reading a reply | Clear prose on the conversation surface | Thinking and tool evidence |
| Background work | Compact thread status | Source findings and the thread transcript |
| Provider setup | One chosen instance and model | Optional key sharing between trusted hosts |
| Scheduled work | Ordinary session output | Triggers, history and run controls in Scheduled |

## An example boundary

The rendering component can ask for a read action without owning persistence:

\`\`\`tsx
function Reply({ message, unread, acknowledge }) {
  return (
    <article aria-label="Bot reply">
      <MessageReadButton
        unread={unread}
        onRead={() => acknowledge(message.id)}
      />
      <Markdown>{message.text}</Markdown>
    </article>
  );
}
\`\`\`

The important part is the direction of responsibility. The component expresses the human action; the read-state module decides how to store it. Other surfaces derive their unread state from the same record.

## Suggested implementation order

1. Make the everyday conversation easy to read at both narrow and wide widths.
2. Verify read acknowledgement, send recovery, and archived-run navigation.
3. Keep background coordination out of the human conversation unless it changes a decision.
4. Make cross-device setup explicit and recoverable.
5. Revisit optional controls after observing a full day of real use.

Before implementing more, I would ask you to choose which friction you feel most often. A long review can describe several worthwhile changes, but your experience should determine the next one.`;

export const longDemoFollowUp = `A second long reply lets us inspect the transition between messages rather than judging one isolated wall of text.

${sections.slice(0, 7).map(([title, first, second]) => `### ${title}\n\n${second}\n\n${first}`).join('\n\n')}

You can now scroll back to the first review, select a passage to comment on, or acknowledge this reply individually. None of this demo text is a live bot instruction or an action taken on your files.`;
