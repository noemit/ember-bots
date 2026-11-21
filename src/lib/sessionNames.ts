/** Offline, extractive task titles. Keep phrases, never invent a character or a topic. */
export type NameInput = { text?: string; directory?: string; project?: string; seed?: string; taken?: readonly string[] };

/** Remove quoted instructions, payloads and credentials before looking for task prose. */
export const namingProse = (text: string): string => text
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/<([\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
  .replace(/^\s*>.*$/gm, ' ')
  .replace(/[“"][^”"\n]*[”"]/g, ' ')
  .replace(/https?:\/\/\S+|(?:^|\s)(?:~\/|\.{1,2}\/|\/)[\w/.-]+|\b[\w.-]+\/[\w.-]+\/[\w/.-]+/g, ' ')
  // Credential clauses are not naming evidence. Drop the clause, not just its first word:
  // Authorization: Bearer <value> and unpunctuated password/API key values must stay private.
  .replace(/\b[\w-]+\s*=\s*\S+[\s\S]*$/g, ' ')
  .replace(/\b\w+_(?:KEY|TOKEN|SECRET|PASSWORD)\b[\s\S]*$/gi, ' ')
  .replace(/\b(?:password|secret|authorization|api[ _-]?key)\b\s+(?!(?:reset|rotation|management|handling|validation|middleware|flow|recovery|storage|settings|support|authentication|screen|page)\b)\S+[\s\S]*$/gi, ' ')
  .replace(/\b(?:password|secret|authorization|bearer|api[ _-]?key)\s*[:=][\s\S]*$|\bbearer\s+\S+[\s\S]*$/gi, ' ')
  .replace(/\btoken\b\s*(?::|=|is)\s*[\s\S]*$/gi, ' ')
  .replace(/\btoken\s+(?!(?:refresh|expiry|expiration|storage|budget|usage|count|limit|rotation|validation|exchange|handling|cache|streaming)\b)\S+[\s\S]*$/gi, ' ')
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_|eyJ)[\w.-]+/g, ' ')
  .replace(/\b\S{36,}\b/g, ' ')
  .replace(/[*`#]/g, '').slice(0, 1200);

const vague = /^(?:(?:let['’]?s|let us)\s+)?(?:go|continue|proceed|help|hello|hi|hey|ok(?:ay)?|yes|thanks|do (?:it|this|that)|fix (?:it|this|that)|close the design gap|take a look|what do you think)[.!?\s]*$/i;
const action = /^(?:fix(?:ing|ed)?|repair(?:ing|ed)?|add(?:ing|ed)?|updat(?:e|ing|ed)|improv(?:e|ing|ed)|chang(?:e|ing|ed)|implement(?:ing|ed)?|creat(?:e|ing|ed)|writ(?:e|ing)|wrote|build(?:ing)?|built|remov(?:e|ing|ed)|review(?:ing|ed)?|investigat(?:e|ing|ed)|plan(?:ning|ned)?|explain(?:ing|ed)?|draft(?:ing|ed)?|research(?:ing|ed)?)\s+/i;
const requestLead = /^(?:(?:please|can you|could you|would you|i need you to|we need to)\s+)*/i;
const contextLead = /^(?:(?:context|background)\s*:|(?:some|for) context\b|(?:here(?: is|[’']s)|below is) (?:some |the )?(?:context|background|log|output)\b)/i;
const sentenceCase = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** A contiguous object phrase is stronger evidence than a bag of matching keywords. */
const subjectFromSentence = (sentence: string): string | undefined => {
  let clean = sentence.trim();
  if (!clean || vague.test(clean) || /\b(?:ignore .*instructions|system prompt|(?:rename|name|call) (?:this|the) (?:chat|session|conversation)|(?:set )?the title|title (?:must|should))\b/i.test(clean)) return undefined;
  clean = clean.replace(/^(?:(?:hi|hey|hello)[,!]?\s+)?(?:(?:can|could|would) you\s+|(?:i|we) (?:want|need)(?: you)? to\s+|please\s+|let['’]?s\s+)+/i, '')
    .replace(/^(?:i|we)\s+(?:(?:have|just|also)\s+)*/i, '');
  // Keep at most two requested objects, with their original connecting words and technical case.
  const clauses = clean.split(/\s+(?:and(?: then)?|plus)\s+|[,;]\s*(?=(?:add|fix|update|remove|write)\b)/i).slice(0, 2);
  const objects = clauses.map(clause => clause
    .split(/[.!?](?:\s|$)|\n|\s+(?:so that|because|which|so|now|instead|to make|to ensure)\s+/i)[0]
    .replace(action, '').replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+(?:please|for me|with|using)$/i, '').trim())
    .filter(part => part && !action.test(part + ' ') && !vague.test(part) && !/^(?:it|this|that|something|everything|anything|done)$/i.test(part));
  if (!objects.length) return undefined;
  const result = objects.join(' and ');
  // Do not turn a long paragraph into a clipped, misleading three-keyword label.
  if (result.length > 72 || result.split(/\s+/).length > 12) return undefined;
  if (!/\p{L}/u.test(result)) return undefined;
  return sentenceCase(result);
};

const sentencesOf = (text: string): string[] => namingProse(text).trim().split(/[.!?](?:\s|$)|\n/).map(sentence => sentence.trim()).filter(Boolean);

export const subjectOf = (text: string): string | undefined => subjectFromSentence(sentencesOf(text)[0] ?? '');

/** A context-first prompt may put its actual request after the introduction. */
export const requestSubjectOf = (text: string): string | undefined => {
  const [opening = '', ...rest] = sentencesOf(text);
  const initial = subjectFromSentence(opening);
  if (initial && !contextLead.test(opening)) return initial;
  // Only explicit requests qualify after an introduction: don't extract arbitrary later prose.
  for (const sentence of rest) {
    if (!action.test(sentence.replace(requestLead, ''))) continue;
    const subject = subjectFromSentence(sentence);
    if (subject) return subject;
  }
  return undefined;
};

export const uniqueTaskTitle = (base: string, taken: readonly string[] = []): string => {
  const occupied = new Set(taken.map(name => name.trim().toLocaleLowerCase()));
  let title = base;
  for (let suffix = 2; occupied.has(title.toLocaleLowerCase()); suffix += 1) title = base + ' ' + suffix;
  return title;
};

export const deriveSessionName = (input: NameInput = {}): string =>
  uniqueTaskTitle(requestSubjectOf(input.text ?? '') ?? 'New conversation', input.taken);
