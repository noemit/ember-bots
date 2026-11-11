/**
 * A conversation's provisional name, and the better one it earns once it has a reply.
 *
 * `deriveSessionName` names a session from **the human's first message alone**, at creation. That is
 * the right seed — deterministic, offline, available before the host has answered — but it is often
 * the weakest evidence available. "lets close the design gap" names the *intent* of the opening
 * line; the reply that says "I changed `sessionNames.ts` and added two tests" carries the subject.
 *
 * So a fresh conversation gets a **provisional** name, and is upgraded **once** when its first reply
 * lands. Three rules keep that from reviving the "What Gardener" bug the roster exists to prevent:
 *
 *   1. **One upgrade, ever.** It happens when a session is first seen with a substantive reply and
 *      is still marked provisional. It never runs again — not on later turns, not after a reconnect.
 *   2. **A human rename always wins.** Marking is local state, not a title prefix: a title the person
 *      edited stops being provisional the moment they edit it, because renaming clears the mark.
 *   3. **No reply, no rename.** Until the agent has said something substantial the name stays as it
 *      was created.
 *
 * The mark deliberately does **not** live in the title string. A prefix would have had to be stripped
 * at each of the twenty places a title is rendered, persisted into the host's conversation record,
 * and kept out of search and previews. Local state has none of those problems: the title is always
 * exactly what the rail should show, and "is this still provisional?" is a `Set` lookup.
 */

import { deriveSessionName, subjectOf } from './sessionNames';

/**
 * The shortest reply worth renaming a session from.
 *
 * A first reply is often "Sure — looking now." or an echo of a tool call, and naming a session from
 * that is worse than leaving it as created. Forty characters is roughly a sentence; below it there
 * is rarely a subject. Deliberately conservative — a session whose first reply stays short keeps the
 * name its request earned, which is the safe direction.
 */
export const MIN_REPLY_LENGTH = 40;

/** Whether a reply says enough to name a conversation from. */
export const replyIsSubstantive = (reply: string | undefined): boolean =>
  Boolean(reply && reply.trim().length >= MIN_REPLY_LENGTH);

export type UpgradeInput = {
  /** The human's first message — the name the session was created with. */
  request: string;
  /** The agent's first reply, once there is one. */
  reply?: string;
  directory?: string;
  project?: string;
  taken?: readonly string[];
};

/**
 * The name to upgrade to, or null to leave the session alone.
 *
 * Null covers every "do nothing" case — no reply, a short reply, or a request that already named its
 * own subject — so callers can evaluate this every time they see a session without tracking whether
 * a reply has arrived. The decision is made from the evidence, so it cannot drift from a flag.
 *
 * The request keeps its privileged position. `subjectOf` asks whether it named anything; when it
 * did, the name already describes the work and the reply is ignored. The reply is only consulted for
 * the case this feature exists for: an opening line that was pure intent.
 */
export const upgradedName = (input: UpgradeInput): string | null => {
  const request = input.request ?? '';
  const reply = (input.reply ?? '').trim();
  if (!replyIsSubstantive(reply)) return null;
  // The request named its own subject: that name stands, and the reply is not allowed to displace it.
  if (subjectOf(request)) return null;
  // A reply with no subject of its own is no better than what the request produced.
  if (!subjectOf(reply)) return null;
  return deriveSessionName({
    text: reply,
    directory: input.directory,
    project: input.project,
    taken: input.taken,
  });
};

/**
 * A name to show before the host has answered anything.
 *
 * The session exists but no reply has landed, so there is no subject yet. Still a roster name, so the
 * rail never shows a bare id.
 */
export const waitingName = (seed: string): string => deriveSessionName({ text: '', seed });
