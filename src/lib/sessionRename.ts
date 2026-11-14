/** Conservative, offline refinement of a provisional title from one completed exchange. */
import { deriveSessionName, subjectOf } from './sessionNames';
import { matchRole } from './sessionNameFallback';

export const MIN_REPLY_LENGTH = 40;

/** Strip evidence which must never supply a title (including secrets and pasted code). */
const prose = (text: string): string => text
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/https?:\/\/\S+|(?:[~/.][\w.-]*\/)[\w/.-]+/g, ' ')
  .replace(/\b(?:token|password|secret|authorization|bearer|api[ _-]?key)\s*[:=]\s*\S+/gi, ' ')
  .slice(0, 1200);

/** Length alone admits long promises. Require actual explanatory/result prose, not a preamble. */
export const replyIsSubstantive = (reply: string | undefined): boolean => {
  const text = prose(reply ?? '').trim();
  if (text.length < MIN_REPLY_LENGTH || (text.match(/\b[a-z]{2,}\b/gi)?.length ?? 0) < 7) return false;
  if (/^(?:sure|okay|ok|yes|understood|on it|thanks)\b/i.test(text) &&
      !/\b(?:fixed|changed|added|found|because|cause|implemented|resolved)\b/i.test(text)) return false;
  if (/^(?:(?:i|we)[’']?\s*(?:will|ll|am going to|are going to|can)|let me|(?:i am|i[’']m|we are|we[’']re)\s+(?:checking|looking|investigating|working))\b/i.test(text)) return false;
  return Boolean(subjectOf(text));
};

export type UpgradeInput = {
  request: string;
  reply?: string;
  directory?: string;
  project?: string;
  taken?: readonly string[];
  /** Exact creation title, including its originally selected character/collision suffix. */
  initialTitle?: string;
};

/**
 * Closed vocabulary of concrete facets, not arbitrary reply nouns. A facet only earns a place if
 * the reply also explicitly mentions the human's subject; generic reports cannot replace it.
 * Order is deterministic, with shared (human + reply) facets preferred over reply-only detail.
 */
const FACETS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Redirect', pattern: /\bredirect(?:s|ed|ing)?\b/i },
  { name: 'Refresh', pattern: /\brefresh(?:es|ed|ing)?\b/i },
  { name: 'Persistence', pattern: /\b(?:persist(?:ence|ed|ing)?|storage|stored|saving)\b/i },
  { name: 'Tint', pattern: /\b(?:tint|tinted|tinting)\b/i },
  { name: 'Contrast', pattern: /\bcontrast\b/i },
  { name: 'Overflow', pattern: /\boverflow(?:s|ed|ing)?\b/i },
  { name: 'Ordering', pattern: /\b(?:ordering|reorder(?:ed|ing)?|sorting)\b/i },
  { name: 'Cancellation', pattern: /\b(?:cancellation|cancel(?:led|ing)?)\b/i },
  { name: 'Recovery', pattern: /\b(?:recovery|reconnect(?:ed|ing)?)\b/i },
  { name: 'Streaming', pattern: /\bstream(?:ing|ed)?\b/i },
  { name: 'Migration', pattern: /\bmigrat(?:ion|e|ed|ing)\b/i },
  { name: 'Search', pattern: /\bsearch(?:ing)?\b/i },
];

/** Topic aliases let a reply say sidebar when the human said rail, without changing the subject. */
const ANCHORS: Readonly<Record<string, RegExp>> = {
  Login: /\b(?:login|log in|sign[ -]?in|oauth|authentication|auth)\b/i,
  Rail: /\b(?:rail|sidebar)\b/i,
  Blob: /\b(?:blob|avatar|creature)s?\b/i,
  Palette: /\b(?:colou?r|palette|theme|appearance)\b/i,
  Queue: /\b(?:queue|queued|inbox)\b/i,
  Schedule: /\b(?:schedule|scheduled|cron|reminder)\b/i,
  Crew: /\b(?:worker|crew|delegat\w*)s?\b/i,
  Memory: /\b(?:memory|cache|cached|caching)\b/i,
  Network: /\b(?:tailnet|tailscale|reconnect|network|socket|dns|proxy)\b/i,
};

/**
 * Null means the exchange adds no measurable specificity. Keep the request's subject and curated
 * character; only add one concrete facet. Unknown requests may acquire the reply's subject, as
 * before, but a named human subject is never replaced by an unrelated or generic reply topic.
 */
export const upgradedName = (input: UpgradeInput): string | null => {
  if (!replyIsSubstantive(input.reply)) return null;
  const request = prose(input.request ?? '');
  const reply = prose(input.reply ?? '');
  const subject = subjectOf(request);
  if (!subject) {
    const replySubject = subjectOf(reply);
    if (!replySubject) return null;
    // Even a subjectless opening can name the intent (plan, fix, investigate). Keep that role
    // instead of letting incidental tests in the result turn a design task into an Inspector.
    const intent = matchRole(request);
    if (!intent) return deriveSessionName({ ...input, text: reply });
    const name = replySubject + ' ' + intent.name;
    const taken = new Set((input.taken ?? []).map(value => value.trim().toLowerCase()));
    let suffix = 1;
    while (taken.has((name + (suffix === 1 ? '' : ' ' + suffix)).toLowerCase())) suffix += 1;
    return name + (suffix === 1 ? '' : ' ' + suffix);
  }
  // subjectOf only emits alphabetic words and hyphens, never regex metacharacters.
  const anchor = ANCHORS[subject] ?? new RegExp('\\b' + subject + 's?\\b', 'i');
  if (!anchor.test(reply)) return null;
  const facets = FACETS.filter(({ name, pattern }) => name !== subject && pattern.test(reply));
  const facet = facets.find(({ pattern }) => pattern.test(request)) ?? facets[0];
  if (!facet) return null;
  // Keep the existing roster character, not a new role inferred from a generic test report.
  const base = input.initialTitle?.startsWith(subject + ' ') && input.initialTitle.slice(subject.length + 1).trim()
    ? input.initialTitle
    : deriveSessionName({ text: request, directory: input.directory, project: input.project });
  const name = subject + ' ' + facet.name + base.slice(subject.length);
  const taken = new Set((input.taken ?? []).map(value => value.trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let suffix = 2;
  while (taken.has((name + ' ' + suffix).toLowerCase())) suffix += 1;
  return name + ' ' + suffix;
};

export const waitingName = (seed: string): string => deriveSessionName({ text: '', seed });
