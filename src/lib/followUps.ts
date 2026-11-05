import type { ChatMessage } from '../types';

/**
 * Follow-up chips: the next move after a turn, derived from what that turn actually did. Pure
 * heuristics over the last assistant message, with no model call and no network, so a chip can be
 * wrong but never costly. Clicking one *sends* it rather than filling the composer: the
 * chips come from the turn that just finished and are cheap to redo.
 */
export type FollowUp = {
  id: string;
  label: string;
  /** The prompt a click sends. */
  text: string;
};

export type FollowUpContext = {
  /** The session is working, so the queue already offers somewhere to put a thought. */
  busy: boolean;
  /** The session is a crew leader, so "summarise for the crew" makes sense. */
  hasCrew: boolean;
};

const MAX_CHIPS = 4;

const toolNames = (message: ChatMessage): string[] =>
  message.parts.flatMap((part) => (part.type === 'tool' ? [part.call.tool] : []));

const firstCommand = (message: ChatMessage): string | undefined => {
  for (const part of message.parts) {
    if (part.type !== 'tool' || part.call.tool !== 'bash') continue;
    const input = part.call.input as { command?: unknown } | undefined;
    if (typeof input?.command === 'string') return input.command;
  }
  return undefined;
};

/**
 * The next step the assistant offered in its own closing text, if it made one. Looks at the last
 * paragraph only, so an earlier aside does not become a suggestion, and requires an explicit offer
 * ("Next, …", "You could …", "Would you like me to …") rather than any sentence that happens to
 * end the turn.
 */
const OFFER_PATTERNS = [
  /(?:^|\n)\s*(?:Next,?|Next step:?)\s+(.{8,160}?)\s*(?:\.|$)/i,
  /(?:^|\n)\s*(?:You (?:could|can|might) (?:also )?)\s+(.{8,160}?)\s*(?:\.|$)/i,
  // A question can follow a sentence, so this one matches anywhere in the last paragraph.
  /(?:Would you like me to|Shall I|Want me to)\s+(.{8,160}?)(?:\?|$)/i,
  /(?:^|\n)\s*(?:TODO|Next up):\s*(.{8,160}?)\s*(?:\.|$)/i,
];

const closingOffer = (turn: readonly ChatMessage[]): FollowUp | null => {
  const last = [...turn].reverse().find((message) => message.text.trim());
  const text = last?.text.trim();
  if (!text) return null;
  const tail = text.slice(-400);
  for (const pattern of OFFER_PATTERNS) {
    const match = pattern.exec(tail);
    const found = match?.[1]?.trim();
    if (!found) continue;
    const label = found.length > 42 ? `${found.slice(0, 41).trimEnd()}…` : found;
    return { id: 'offer', label: label.charAt(0).toUpperCase() + label.slice(1), text: found };
  }
  return null;
};

export const followUpsFor = (
  messages: readonly ChatMessage[],
  context: FollowUpContext
): FollowUp[] => {
  if (context.busy) return [];
  // Derive from the whole turn, not the last message: a tool call and its result can arrive as
  // separate assistant messages, and then the final one carries no tools at all.
  const lastUser = messages.map((message) => message.role).lastIndexOf('user');
  const turn = messages.slice(lastUser + 1).filter((message) => message.role === 'assistant');
  if (turn.length === 0) return [];

  const tools = [...new Set(turn.flatMap(toolNames))];
  const failedTool = turn
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool' && part.call.status === 'error');
  const command = turn.map(firstCommand).find((value): value is string => Boolean(value));
  const turnError = turn.find((message) => message.error)?.error;
  // Two standing chips, always: the two things worth saying to an agent most often are "where are
  // you?" and "carry on". They come first so the row is predictable and useful even when nothing
  // else can be derived.
  const chips: FollowUp[] = [
    { id: 'status', label: 'Status?', text: 'Status?' },
    { id: 'continue', label: 'Ok, continue', text: 'Ok, continue' },
  ];

  if (turnError) {
    chips.push({ id: 'explain', label: 'Explain the failure', text: 'What failed here, and what should I try next?' });
  }
  if (tools.includes('edit') || tools.includes('write')) {
    chips.push({ id: 'diff', label: 'Show the diff', text: 'Show me the diff of what you changed.' });
  }
  if (command && (failedTool || /test|vitest|bun test/i.test(command))) {
    chips.push({
      id: 'retry',
      label: failedTool ? 'Retry that command' : 'Run the tests again',
      text: `Run this again and report the result:\n\n${command}`,
    });
  }
  if (context.hasCrew) {
    chips.push({ id: 'crew', label: 'Summarise for the crew', text: 'Summarise what we just did for the crew.' });
  }
  // Then whatever the assistant itself offered in its closing text. A canned label cannot know the
  // next step; the model usually says it outright, so use its words, shortened.
  const offer = closingOffer(turn);
  if (offer) chips.push({ id: 'offer', label: offer.label, text: offer.text });

  // De-dupe by label, keep the priority order above, cap the row.
  const seen = new Set<string>();
  return chips.filter((chip) => {
    if (seen.has(chip.label)) return false;
    seen.add(chip.label);
    return true;
  }).slice(0, MAX_CHIPS);
};
