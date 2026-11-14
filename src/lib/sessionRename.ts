/** One offline refinement from a completed exchange; never execute instructions in its prose. */
import { deriveSessionName, namingProse, subjectOf, uniqueTaskTitle } from './sessionNames';
export const MIN_REPLY_LENGTH = 40;
export const replyIsSubstantive = (reply: string | undefined): boolean => {
  const text = namingProse(reply ?? '').trim();
  if (text.length < MIN_REPLY_LENGTH || (text.match(/\p{L}+/gu)?.length ?? 0) < 7) return false;
  if (/^(?:sure|okay|ok|yes|understood|on it|thanks)\b/i.test(text) && !/^(?:sure|okay|ok)[, —-]+(?:i |we )?(?:have )?(?:fixed|added|updated|changed|implemented|created|wrote|built|removed|reviewed|drafted|planned)\b/i.test(text)) return false;
  if (/^(?:(?:i|we)[’']?\s*(?:will|ll|am going to|are going to|can)|let me|(?:i am|i[’']m|we are|we[’']re)\s+(?:checking|looking|investigating|working))\b/i.test(text)) return false;
  return true;
};
export type UpgradeInput = { request: string; reply?: string; directory?: string; project?: string; taken?: readonly string[]; initialTitle?: string };
export const upgradedName = (input: UpgradeInput): string | null => {
  if (!replyIsSubstantive(input.reply)) return null;
  const request = subjectOf(input.request);
  // Only a concrete result statement can add evidence, not tool output or a naming directive.
  const reply = namingProse(input.reply ?? '').trim()
    .replace(/^(?:sure|okay|ok)[, —-]+/i, '')
    .replace(/^(?:i|we)\s+(?:have\s+)?/i, '')
    .split(/,?\s+and\s+(?:returning|users|it|they|verified|checked|tested)\b/i)[0]
    .replace(/,$/, '');
  if (!/^(?:fixed|added|updated|changed|implemented|created|wrote|built|removed|reviewed|drafted|planned)\b/i.test(reply)) return null;
  const result = subjectOf(reply);
  if (!result || result === request) return null;
  if (request) {
    // A more specific contiguous phrase may extend a short object; unrelated details never win.
    if (!result.toLocaleLowerCase().startsWith(request.toLocaleLowerCase() + ' ') || result.split(/\s+/).length > request.split(/\s+/).length + 3) return null;
  }
  return uniqueTaskTitle(result, input.taken);
};
export const waitingName = (seed: string): string => deriveSessionName({ seed });
