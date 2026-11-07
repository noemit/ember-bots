import { deriveSessionName as fallbackName, matchRole, titleCase, type NameInput } from './sessionNameFallback';

/** Topic extraction is deliberately local: prompts never leave Ember just to name a chat.
 * Only the human's first request supplies the topic. Names are stored at creation, so later
 * responses, polls and human renames cannot change them or their independently seeded blobs.
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

const FILLER = new Set(('a an the this that it its i we you my our your please can could would should want need like just help me us to of for on in at by with and or is are be do does not dont how what why some all more now also fix repair build implement create add remove change make update improve investigate research explain plan review audit project work thing something everything issue issues bug broken failing error ok okay yes no hello hi hey thanks thank continue sure hmm').split(' '));

/** Ignore pasted code, links, paths and credentials rather than putting private fragments in a title. */
const requestText = (text: string): string => text
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/https?:\/\/\S+|(?:[~/.][\w.-]*\/)[\w/.-]+/g, ' ')
  .replace(/\b(?:token|password|secret|authorization|bearer|api[ _-]?key)\s*[:=]\s*\S+/gi, ' ')
  .split(/\n\s*\n/)[0].slice(0, 600);

export const deriveSessionName = (input: NameInput = {}): string => {
  const text = requestText(input.text ?? '');
  const topic = TOPICS.find(({ pattern }) => pattern.test(text));
  // Unknown subjects still use the person's vocabulary, never the folder's name. Require
  // ordinary words; long identifiers, numbers and opaque strings make poor mnemonic names.
  const word = (text.match(/\b[a-zA-Z][a-zA-Z-]{2,19}\b/g) ?? [])
    .find((candidate) => !FILLER.has(candidate.toLowerCase()) && !/^[A-Fa-f\d]{12,}$/.test(candidate));
  const subject = topic?.subject ?? (word ? titleCase(word) : undefined);
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
