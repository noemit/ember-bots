/**
 * What a pasted reply to a sign-in question should be, and whether it can be sent at all.
 *
 * A browser-callback sign-in (Google Antigravity, OpenAI's ChatGPT flow) finishes by sending the
 * browser to a loopback address on the machine running Kiln. When the person signed in somewhere
 * else, the redirect fails to load and the address bar still holds the whole answer — so that URL
 * is what gets pasted back. People also paste just the code, or the shorter `code=...&state=...`
 * tail, and both are worth accepting: refusing a correct answer because of its packaging is the
 * kind of dead end that reads as "it didn't work" when it did.
 *
 * This is deliberately a *shape* check, not a verification: the host is the one that knows whether
 * the code is real, single-use and unexpired, and guessing here would only turn a clear answer from
 * the host into a vaguer complaint from Ember. The check exists to stop the obvious non-answer (an
 * empty field, a sentence, the wrong page) from being sent and failing slowly on the other side.
 */

export type LoginAnswerVerdict =
  /** Ready to send. */
  | { ok: true; value: string }
  /** Nothing typed yet: the Send button waits rather than explaining. */
  | { ok: false; reason: null }
  /** Something was typed and it is not an answer; `reason` says what to do instead. */
  | { ok: false; reason: string };

const CODE = /^[\w./+=-]{8,4096}$/;

/**
 * Whether a full URL looks like the sign-in's redirect rather than some other page.
 *
 * The host tells us the address it is listening on (`redirectUri`, e.g.
 * `http://localhost:51121/oauth-callback`), and a pasted URL that agrees with it — same scheme,
 * host and path — is what we want. Older Hearth builds do not send one, so an absent template falls
 * back to accepting any URL that carries a `code`, which is a narrower claim than accepting anything.
 */
const looksLikeRedirect = (value: string, template: string | undefined): boolean => {
  let pasted: URL;
  try {
    pasted = new URL(value);
  } catch {
    return false;
  }
  if (pasted.protocol !== 'http:' && pasted.protocol !== 'https:') return false;
  if (!template) return pasted.searchParams.has('code');
  let expected: URL;
  try {
    expected = new URL(template);
  } catch {
    return pasted.searchParams.has('code');
  }
  // `localhost` and `127.0.0.1` are the same listener in every practical case: the host binds one
  // and tells the browser the other, and a person who trimmed nothing should not be corrected.
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const sameHost = pasted.host === expected.host || (loopback(pasted.hostname) && loopback(expected.hostname));
  return sameHost && pasted.pathname === expected.pathname;
};

/**
 * Judge a typed reply against the question the host asked.
 *
 * `placeholder` is the host's own hint about the expected shape (it sends the redirect URI there),
 * and it is treated as a template — never as an answer to fall back to.
 */
export const judgeLoginAnswer = (text: string, placeholder?: string): LoginAnswerVerdict => {
  const value = text.trim();
  if (!value) return { ok: false, reason: null };

  if (/^https?:\/\//i.test(value)) {
    return looksLikeRedirect(value, placeholder)
      ? { ok: true, value }
      : {
          ok: false,
          reason: 'That address is not the sign-in’s redirect. Copy the whole URL from the browser’s address bar after signing in — it starts with the address shown above.',
        };
  }

  // Anything shaped like `scheme:` is a URL of some kind, and the only URL that answers this
  // question is the loopback redirect. Refusing the rest here keeps a pasted `javascript:` or
  // `file:` string from being read as a login code by the shape check below.
  if (/^[a-z][\w+.-]*:/i.test(value)) {
    return {
      ok: false,
      reason: 'That is not the sign-in’s redirect. Copy the whole URL from the browser’s address bar after signing in — it starts with the address shown above.',
    };
  }

  // A `code=…&state=…` tail pasted without its scheme is still the redirect, just abbreviated. This
  // is checked before the bare-code shape so `javascript:…?code=` cannot slip through as a code.
  if (/(^|[?&])code=/.test(value)) return { ok: true, value: `?${value.replace(/^\?/, '')}` };

  if (CODE.test(value)) return { ok: true, value };
  return {
    ok: false,
    reason: 'That does not look like the sign-in’s reply. Paste the full URL from your browser’s address bar, or just the code it contains.',
  };
};

/** The address shown to the person, shortened to what they need to recognise it. */
export const signInAddressLabel = (placeholder?: string): string => {
  const raw = (placeholder ?? '').trim();
  if (!raw) return 'the sign-in’s redirect address';
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return raw;
  }
};
