/**
 * Reading a failed model turn.
 *
 * A provider answers with a status and a JSON envelope, and pi-ai flattens that into
 * `errorMessage` as `"429: {\"message\":\"…\",\"type\":\"…\"}"`. The transcript used to show only the
 * `stopReason` (`The model turn failed (error)`), which told you nothing actionable — you could not
 * tell an overloaded engine from a rate limit from a drained balance, and those need three
 * different responses.
 *
 * This module turns that string into something a person can act on: the HTTP status, a short
 * category, the provider's own sentence, and whether retrying could possibly help. It is pure, so
 * the classification is pinned by tests instead of by squinting at a live failure.
 */
export type TurnFailure = {
  /** HTTP status the provider returned, when the message carried one. */
  status?: number;
  /** Machine-readable provider type, e.g. `engine_overloaded_error`. */
  code?: string;
  /** Provider's own wording, trimmed of identifiers. Falls back to the raw text. */
  detail: string;
  /** Whether waiting and trying again can plausibly succeed. */
  retryable: boolean;
  /** A one-line plain-language name for the category. */
  kind: 'rate-limit' | 'quota' | 'overloaded' | 'auth' | 'server' | 'timeout' | 'network' | 'refused' | 'unknown';
};

const KIND_LABEL: Record<TurnFailure['kind'], string> = {
  'rate-limit': 'Rate limited',
  quota: 'Out of credit',
  overloaded: 'Provider overloaded',
  auth: 'Not authorised',
  server: 'Provider error',
  timeout: 'Timed out',
  network: 'Connection lost',
  refused: 'Request refused',
  unknown: 'Failed',
};

export const failureLabel = (failure: TurnFailure): string =>
  failure.status ? `${KIND_LABEL[failure.kind]} (${failure.status})` : KIND_LABEL[failure.kind];

/**
 * Provider messages carry account, project and key identifiers. They make the banner unreadable
 * and they are not the user's own key when a proxy is in front, so they are redacted rather than
 * displayed.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // Order matters: the whole bracketed id is replaced first, because the bare-identifier rules
  // below would otherwise eat its middle and leave a fragment like "<org-…>" unstripped.
  [/<ak-[^>]*>/gi, ''],
  [/<org-[^>]*>/gi, ''],
  // org-… / proj-… / ak-… identifiers, wherever they were inserted into a sentence.
  [/\borg-[0-9a-f]{8,}\b/gi, 'org-…'],
  [/\bproj-[0-9a-f]{8,}\b/gi, 'proj-…'],
  [/\bak-[0-9a-z]{8,}\b/gi, 'key-…'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-…'],
];

export const redact = (text: string): string => {
  const masked = REDACTIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text
  );
  // A redaction inside a sentence leaves the punctuation around a hole ("for account , please").
  // Tidy the seams so the sentence still reads.
  return masked
    // "account , please" -> "account, please"
    .replace(/\s+([,.;:!?])/g, '$1')
    // A hole that swallowed the whole object leaves "for account , please"; drop the dangling
    // preposition phrase only when punctuation follows it directly.
    .replace(/\s+(for|of|to|in|by)\s+(?=[,.;:!?])/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

/** `"429: {…}"` or `"429 — {…}"` or a bare envelope. */
const splitStatus = (raw: string): { status?: number; body: string } => {
  const match = /^\s*(\d{3})\s*[:\-–—]?\s*([\s\S]*)$/.exec(raw);
  if (!match) return { body: raw.trim() };
  const status = Number(match[1]);
  // Only treat the leading number as a status when it looks like one.
  if (status < 100 || status > 599) return { body: raw.trim() };
  return { status, body: match[2].trim() };
};

const parseBody = (body: string): { message?: string; type?: string } => {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      // Both `{message,type}` and `{error:{message,type}}` appear in the wild.
      const inner =
        record.error && typeof record.error === 'object'
          ? (record.error as Record<string, unknown>)
          : record;
      return {
        message: typeof inner.message === 'string' ? inner.message : undefined,
        type: typeof inner.type === 'string' ? inner.type : undefined,
      };
    }
  } catch {
    // Not JSON: the body is the message (a proxy's plain-text error page, say).
  }
  return { message: body };
};

const classify = (status: number | undefined, code: string | undefined, detail: string): TurnFailure['kind'] => {
  const haystack = `${code ?? ''} ${detail}`.toLowerCase();
  // Quota outranks the status: a drained balance also arrives as 429 but retrying will not help.
  if (/credit|balance|quota|billing|insufficient|recharge|exceeded_current_quota/.test(haystack)) {
    return 'quota';
  }
  if (/overloaded|engine_overloaded|capacity|busy|try again later/.test(haystack)) return 'overloaded';
  if (status === 429 || /rate.?limit|too many requests|tpm|rpm/.test(haystack)) return 'rate-limit';
  if (status === 401 || status === 403 || /unauthor|forbidden|invalid.*key|api key/.test(haystack)) return 'auth';
  if (status === 408 || /timed? ?out|deadline/.test(haystack)) return 'timeout';
  if (/network|fetch failed|econn|socket|connection/.test(haystack)) return 'network';
  if (status === 400 || status === 422 || /refus|invalid|rejected|unsupported/.test(haystack)) return 'refused';
  if (status !== undefined && status >= 500) return 'server';
  return 'unknown';
};

/**
 * Non-retryable: the request itself is wrong (auth, a bad parameter, a refused submission), or the
 * account is out of credit. Everything transient — overloaded, rate limited, a 5xx, a timeout —
 * can genuinely succeed on a retry.
 */
const isRetryable = (kind: TurnFailure['kind']): boolean =>
  kind === 'overloaded' || kind === 'rate-limit' || kind === 'server' || kind === 'timeout' || kind === 'network';

/**
 * A provider's sentence, shortened for a banner. The rate-limit text in particular is a paragraph
 * of numbers; the useful part is the first clause.
 */
const shorten = (text: string, limit = 220): string => {
  const cleaned = redact(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  const cut = cleaned.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : limit)}…`;
};

/**
 * Read a failed turn's message. `raw` is pi's `errorMessage`; `stopReason` is the fallback when
 * the provider sent no envelope (the turn simply stopped with `error`).
 */
export const readTurnFailure = (raw: string | undefined, stopReason?: string): TurnFailure => {
  const source = (raw ?? '').trim();
  if (!source) {
    // No envelope at all: the turn stopped with `error` and the provider said nothing more.
    return {
      detail: `The model stopped${stopReason ? ` (${stopReason})` : ''} without reporting a reason.`,
      retryable: true,
      kind: 'unknown',
    };
  }

  const { status, body } = splitStatus(source);
  const { message, type } = parseBody(body);
  const detail = shorten(message ?? body ?? source);
  const kind = classify(status, type, `${type ?? ''} ${detail}`);
  return { status, code: type, detail, retryable: isRetryable(kind), kind };
};

/**
 * The banner text for a failed turn: what failed, and what to do about it. One line for the
 * summary, the provider's own words underneath.
 */
export const describeTurnFailure = (failure: TurnFailure): string => {
  const head = failureLabel(failure);
  const guidance = failure.retryable
    ? failure.kind === 'rate-limit' || failure.kind === 'overloaded'
      ? 'Try again in a moment, or switch model.'
      : 'Try again.'
    : failure.kind === 'quota'
      ? 'Add credit with your provider, then try again.'
      : failure.kind === 'auth'
        ? 'Check the API key for this provider.'
        : undefined;
  // Three lines, because the transcript splits on them: the title is the summary, then the
  // provider's own words, then what to do. A banner-wide one-liner made the status hard to find.
  const lines = [head, failure.detail];
  if (guidance) lines.push(guidance);
  return lines.join('\n');
};
