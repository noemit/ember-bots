/**
 * What the comment bar's submit button says, and where its reply goes.
 *
 * The bar used to have one word — "Add" — which described the shelf it wrote to and nothing about
 * what pressing it does. That was fine while a comment could only be a note; now that a comment can
 * go into the composer's own submission path, the button has to say which one, because "Add" and
 * "Send" are different promises about whether the agent is about to be interrupted.
 *
 * Three outcomes, and the copy names the one that will happen:
 *
 *   - **Send** — the agent is idle, so the turn starts now.
 *   - **Queue** — the agent is busy, so it lands behind the running turn.
 *   - **Steer** — YEET mode, so it joins the running turn instead of waiting behind it.
 *
 * Keeping this in one pure function means the label, the aria-label and the tooltip cannot disagree
 * with the behaviour, and a test can ask the same question the button does.
 */

/** The composer states a comment can be submitted into. */
export type CommentDelivery = 'send' | 'queue' | 'steer';

export type CommentDeliveryInput = {
  /** True while the agent is mid-turn, or when a follow-up is already waiting. */
  busy: boolean;
  /** YEET mode: every message steers the running turn instead of queueing behind it. */
  yeet: boolean;
};

/**
 * Which delivery applies. YEET wins over busy: it is a steer *only* because there is a turn to steer
 * into, and the composer sends it as one either way (`steer: yeet` in `ChatView`).
 */
export const commentDelivery = ({ busy, yeet }: CommentDeliveryInput): CommentDelivery => {
  if (yeet) return 'steer';
  return busy ? 'queue' : 'send';
};

/** The button's own word. Short enough to sit in a 28px-tall bar. */
export const commentSubmitLabel = (delivery: CommentDelivery): string => {
  switch (delivery) {
    case 'steer': return 'Steer';
    case 'queue': return 'Queue';
    default: return 'Send';
  }
};

/**
 * The aria-label, which has to be a full sentence because it is read without the surrounding bar.
 *
 * A screen reader hears this out of context, so it names the object ("annotation") rather than
 * relying on the toolbar's own label, and says what happens next.
 */
export const commentSubmitDescription = (delivery: CommentDelivery, count: number): string => {
  const noun = count === 1 ? 'annotation' : 'annotations';
  switch (delivery) {
    case 'steer':
      return `Steer the running turn with ${count} ${noun}`;
    case 'queue':
      return `Queue ${count} ${noun} behind the running turn`;
    default:
      return `Send ${count} ${noun}`;
  }
};

/** The tooltip: the short label, what it does, and the promise the word alone cannot carry. */
export const commentSubmitHint = (delivery: CommentDelivery): string => {
  switch (delivery) {
    case 'steer':
      return 'Steer: joins the running turn now (YEET mode is on)';
    case 'queue':
      return 'Queue: waits behind the running turn, which is not interrupted';
    default:
      // "bot", not "agent": this repo's copy rule (tests/botCopy.test.ts) reserves "agent" for
      // protocol tokens and filenames, because the product calls them bots everywhere else.
      return 'Send: the bot is idle, so this starts a turn now';
  }
};
