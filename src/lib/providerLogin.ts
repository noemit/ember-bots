/**
 * What a sign-in poll actually tells us.
 *
 * Only an explicit completion confirms that the host stored this flow's credential. A missing
 * flow can also mean a restart or an expired failure: it says nothing about authentication.
 */
export type LoginPollOutcome =
  | { kind: 'pending' }
  | { kind: 'complete' }
  | { kind: 'failed'; error: string }
  /** No answer at all (no bridge, a timeout, a 5xx): stop, say so, and let the reader try again. */
  | { kind: 'unreachable'; error: string };

type PollAnswer = {
  ok: boolean;
  status: number;
  state?: { status?: string; error?: string };
  error?: string;
};

export const loginPollOutcome = (answer: PollAnswer): LoginPollOutcome => {
  if (!answer.ok) {
    if (answer.status === 404) return {
      kind: 'failed',
      error: 'Kiln no longer has this sign-in attempt, so Ember cannot confirm it succeeded. Try again to start a new sign-in.',
    };
    return {
      kind: 'unreachable',
      error:
        answer.error ??
        "ember-harness didn't answer, so this sign-in's progress is unknown. Check that the host is running, then try again.",
    };
  }
  if (answer.state?.status === 'complete') return { kind: 'complete' };
  if (answer.state?.status === 'failed') {
    return { kind: 'failed', error: answer.state.error ?? 'ember-harness could not finish signing in.' };
  }
  return { kind: 'pending' };
};

/**
 * What a sign-in link should be labelled with.
 *
 * The device flow's `verificationUri` comes from the host, so it is not guaranteed to be a valid
 * absolute URL. `new URL(...)` throws a `TypeError` on anything else ("example.com/device",
 * "http://", a truncated string) — and a throw during render takes the whole dialog, and the tree
 * around it, down with it. A bare host is a nicety, so it degrades instead: an unparseable URI is
 * shown as the raw string the host sent, which is at least what the reader would paste.
 */
export const verificationHostLabel = (uri: string | null | undefined): string => {
  const raw = (uri ?? '').trim();
  if (!raw) return 'the sign-in page';
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw;
  }
};
