import { deriveSessionName as fallbackName, matchRole, titleCase, type NameInput } from './sessionNameFallback';

/** Topic extraction is deliberately local: prompts never leave Ember just to name a chat.
 * The human's first request supplies the initial topic. `sessionRename` may add specificity once
 * from the first completed exchange; human titles and independently seeded blobs never change.
 */
const TOPICS: readonly { pattern: RegExp; subject: string; characters: readonly string[] }[] = [
  { pattern: /\b(token|tokens)\b/i, subject: 'Token', characters: ['Locksmith', 'Keykeeper', 'Sentinel'] },
  { pattern: /\b(login|log in|sign[ -]?in|oauth|authentication|auth)\b/i, subject: 'Login', characters: ['Locksmith', 'Keykeeper', 'Sentinel'] },
  { pattern: /\b(readme|documentation|docs)\b/i, subject: 'Readme', characters: ['Scribe', 'Bookbinder', 'Editor'] },
  { pattern: /\b(blob|blobs|avatar|avatars|creature|creatures)\b/i, subject: 'Blob', characters: ['Sculptor', 'Animator', 'Painter'] },
  { pattern: /\b(rail|sidebar)\b/i, subject: 'Rail', characters: ['Cartographer', 'Carpenter', 'Navigator'] },
  { pattern: /\b(schedule|scheduled|cron|reminder)\b/i, subject: 'Schedule', characters: ['Clockmaker', 'Timekeeper', 'Scheduler'] },
  { pattern: /\b(colou?r|palette|theme|appearance)\b/i, subject: 'Palette', characters: ['Painter', 'Dyer', 'Designer'] },
  { pattern: /\b(queue|queued|inbox)\b/i, subject: 'Queue', characters: ['Sorter', 'Porter', 'Courier'] },
  { pattern: /\b(worker|workers|crew|delegat\w*)\b/i, subject: 'Crew', characters: ['Conductor', 'Foreman', 'Navigator'] },
  { pattern: /\b(database|sqlite|postgres|sql)\b/i, subject: 'Database', characters: ['Archivist', 'Librarian', 'Architect'] },
  { pattern: /\b(memory|cache|cached|caching)\b/i, subject: 'Memory', characters: ['Librarian', 'Keeper', 'Mechanic'] },
  { pattern: /\b(tailnet|tailscale|reconnect|network|socket|dns|proxy)\b/i, subject: 'Network', characters: ['Navigator', 'Mechanic', 'Sentinel'] },
  { pattern: /\b(test|tests|testing)\b/i, subject: 'Test', characters: ['Inspector', 'Detective', 'Auditor'] },
];

/**
 * Words that frame a request without naming its subject.
 *
 * Deliberately generous. Every word here is one that would otherwise become the *topic* of a
 * session name — "lets close the design gap" used to produce "Lets Cartographer" because `lets`,
 * `close`, `design` and `gap` were all absent. A word only earns a place if it reads as scaffolding
 * in an opening line: conversational filler, social openings, and the bare verbs of asking.
 *
 * Kept lowercase; lookups lowercase the candidate first, so capitalisation never matters.
 */
const FILLER = new Set((
  'a an the this that these those it its i im we us you your our my me please can could would should ' +
  'will shall may might must want need like just help lets let dont doesnt didnt cant cannot wont ' +
  'to of for on in at by with and or is are was were be been being do does did done not no yes ok okay ' +
  'how what why when where which who whom whose some any all more most much many now also then too very ' +
  'really quite rather just only even still yet again back about into onto from up out off over under ' +
  'fix repair build implement create add remove change make update improve investigate research explain ' +
  'plan review audit project work thing things something everything anything nothing issue issues bug bugs ' +
  'broken failing error errors problem problems ok okay hello hi hey thanks thank continue sure hmm ' +
  // Openings and frames that carry no subject of their own.
  'lets let us we should i want id want to do need should could lets just close open start begin finish ' +
  'gap gaps design look looking see check checking figure figuring sort sorting get getting going go ' +
  'good great nice perfect okay alright right well so well anyway also plus and then first next finally ' +
  // Verbs of speech and stance rather than of work.
  'think feels feel seems seem guess suppose wonder wondering ask asking tell telling say saying ' +
  'note notice remember consider considering maybe perhaps probably actually basically literally '
).split(' ').filter(Boolean));

/** Ignore pasted code, links, paths and credentials rather than putting private fragments in a title. */
const requestText = (text: string): string => text
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/https?:\/\/\S+|(?:[~/.][\w.-]*\/)[\w/.-]+/g, ' ')
  .replace(/\b(?:token|password|secret|authorization|bearer|api[ _-]?key)\s*[:=]\s*\S+/gi, ' ')
  .split(/\n\s*\n/)[0].slice(0, 600);

/**
 * The subject a request names, or undefined when it names none.
 *
 * Split out of `deriveSessionName` so callers that need to know *whether* there was a subject can
 * ask without re-deriving the name. `sessionRename` uses it to decide whether a conversation's
 * request was informative enough to keep, or whether the agent's first reply is better evidence.
 */
export const subjectOf = (text: string): string | undefined => {
  const clean = requestText(text);
  const topic = TOPICS.find(({ pattern }) => pattern.test(clean));
  // Unknown subjects still use the person's vocabulary, never the folder's name. Require
  // ordinary words; long identifiers, numbers and opaque strings make poor mnemonic names.
  //
  // Only the words *before* the first content word are skipped, and only ones already in FILLER,
  // so an opening of pure scaffolding does not hand the topic to the first auxiliary that happens
  // to survive the list ("why do we have so many folders" must not become "Have").
  const words = clean.match(/\b[a-zA-Z][a-zA-Z-]{2,19}\b/g) ?? [];
  const isWeak = (candidate: string): boolean => {
    const lower = candidate.toLowerCase();
    return (
      FILLER.has(lower) ||
      WEAK_LEAD.has(lower) ||
      /^[A-Fa-f\d]{12,}$/.test(candidate) ||
      // Verb shapes no subject has. An agent's answer opens with what it *did* ("found", "added",
      // "asked"), and an -ed/-ing word opening a sentence is a report of an action, not a topic.
      // This is a shape test rather than another word list: the list would need every verb in English,
      // and a suffix rule covers the whole regular class in one line.
      (/^[a-z]{4,}(?:ed|ing)$/.test(lower) && !NON_VERB_ED.has(lower))
    );
  };
  let index = 0;
  while (index < words.length && isWeak(words[index])) index += 1;
  const word = words[index];
  return topic?.subject ?? (word ? titleCase(word) : undefined);
};

/**
 * Nouns that look like past participles but are subjects, not actions.
 *
 * Without this the suffix rule would reject "Nested Scout" for a message about nested workers, or
 * "Setting Designer" for one about the settings page. Small and closed on purpose: if a real noun is
 * missing here the name simply falls through to the next word, which is a wrong noun rather than a
 * broken one.
 */
const NON_VERB_ED = new Set([
  'nested', 'setting', 'settings', 'headless', 'embedded', 'extended', 'wrapped', 'grouped',
  'backed', 'based', 'typed', 'styled', 'cached', 'scoped', 'shared', 'merged', 'tagged',
  'naming', 'building', 'drawing', 'string', 'strings', 'evening', 'morning', 'ceiling',
]);

/**
 * Words that are never a subject even when they survive the filler list.
 *
 * They are the auxiliaries and pronouns that open a question ("have", "does", "were", "there"),
 * plus the bare determiners a lowercase sentence hides. Keeping them separate from FILLER documents
 * why they are rejected: not because they are scaffolding, but because naming a session "Have" is
 * always wrong even when it is the first real word.
 */
const WEAK_LEAD = new Set([
  'have', 'has', 'had', 'does', 'did', 'do', 'is', 'are', 'was', 'were', 'be', 'been',
  'there', 'their', 'them', 'they', 'you', 'your', 'our', 'we', 'us', 'me', 'my', 'i',
  // Past-tense reporting verbs. An agent's answer usually opens "I found…", "I changed…", "I added…" —
  // the verb reports the action and names no topic, so taking it as the subject gives "Found Scout".
  'found', 'added', 'changed', 'fixed', 'removed', 'updated', 'wrote', 'checked', 'looked', 'ran',
  'got', 'made', 'set', 'used', 'put', 'took', 'saw', 'moved', 'renamed', 'replaced', 'deleted',
  'created', 'built', 'tested', 'verified', 'confirmed', 'noticed', 'realised', 'realized', 'worked',
  // Present-tense verbs and bare states that a sentence about *anything* would produce. These are
  // the words left after the past-tense openers above, so a reply like "everything works as you
  // asked, so there is nothing left" has to name nothing rather than become "Works Scout".
  // Irregular past tenses are here too: the -ed suffix rule below cannot see "asked", "told", "kept".
  'works', 'work', 'is', 'does', 'fits', 'looks', 'seems', 'appears', 'passes', 'fails',
  'left', 'right', 'sure', 'true', 'false', 'fine', 'okay', 'done', 'now', 'still', 'again',
  'asked', 'told', 'said', 'kept', 'held', 'sent', 'went', 'came', 'took', 'gave', 'brought',
  'thought', 'knew', 'meant', 'understood', 'began', 'spent', 'built', 'found', 'got',
]);

export const deriveSessionName = (input: NameInput = {}): string => {
  const text = requestText(input.text ?? '');
  const subject = subjectOf(text);
  const topic = TOPICS.find(({ pattern }) => pattern.test(text));
  if (!subject) return fallbackName({ ...input, text });
  const characters = topic?.characters ?? [matchRole(text)?.name ?? 'Scout'];
  const taken = new Set((input.taken ?? []).map((name) => name.trim().toLowerCase()));
  for (const character of characters) {
    const name = `${subject} ${character}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  const base = `${subject} ${characters[0]}`;
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
};
