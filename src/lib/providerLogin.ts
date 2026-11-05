/**
 * What a sign-in poll actually tells us.
 *
 * The host stores a finished credential itself, and forgets the flow shortly afterwards, so a `404`
 * on the poll means "it finished and I no longer hold it" — a success. Every *other* failure means
 * Hearth did not answer, which is not success and must not be reported as one: the old code treated
 * any failed poll as the 404 case, so a timeout, a 401 or a 500 all rendered "Signed in. Hearth
 * stored the credential on its own host." while nothing had been stored.
 */
export type LoginPollOutcome =
  | { kind: 'pending' }
  | { kind: 'complete' }
  /** 404: the flow is no longer held because it settled. The credential was stored host-side. */
  | { kind: 'swept' }
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
    if (answer.status === 404) return { kind: 'swept' };
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
