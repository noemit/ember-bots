import type { DelegatorChoices } from './delegatorModels';
import { modelRefKey } from '../types';

/**
 * Standing instructions a new session can start with, as a small shipped library.
 *
 * Hearth has always accepted `instructions` on an agent change — it becomes a reserved section of the
 * system prompt (`INSTRUCTIONS_KEY` in pi-durable), not a first message — but nothing in Ember ever
 * sent it, so every session started with whatever its folder's `AGENTS.md` said and nothing else.
 *
 * These are prompts in the sense that matters here: they say what the session is *for*, and they are
 * numbered so the coordination steps are explicit. Each one names a job, a scope and the one
 * thing it must not do, because a prompt that only says "be careful" changes nothing.
 *
 * The first entry is deliberately empty: "Pi Classic" means *nothing added* — the harness prompt as it
 * is. A list of roles with no way to choose none is a list that changes every session by default.
 */
export type InstructionPreset = {
  id: string;
  /** Shown in the picker. */
  name: string;
  /** One line under the name: what picking it makes the session. */
  blurb: string;
  /** The text that lands in the session's standing instructions; empty means nothing is added. */
  instructions: string;
  /** Shown instead of the text when there is none to show. */
  note?: string;
};

export const INSTRUCTION_PRESETS: readonly InstructionPreset[] = [
  {
    id: 'classic',
    name: 'Pi Classic',
    blurb: 'Nothing added — the harness prompt as it is.',
    instructions: '',
    note: 'No standing instructions. The session gets ember-harness\'s own system prompt and its folder\'s AGENTS.md, exactly as a session started before this existed.',
  },
  {
    id: 'delegator',
    name: 'Ultra Delegator',
    blurb: 'Stays available while delegated tasks do substantial work.',
    instructions: [
      'You are the foreground coordinator. The human thinks, decides and steers; help them do that.',
      'Use the exact configured worker models below: route easier tasks to Easier tasks and harder tasks to Harder tasks. The human configured these choices in the UI. Honor explicit user overrides. If a configured model is unavailable, tell the human to replace it in Standing instructions; never silently substitute or dispatch an unapproved replacement.',
      'Respond promptly, clarify the outcome, and send substantial execution into delegated tasks with session spawn.',
      'Give each task a concrete outcome title, a self-contained brief, acceptance criteria and evidence requirements.',
      'Keep the conversation available: session wait registers a durable continuation and returns immediately for tasks.',
      'Give a useful update before calling wait alone; it releases the turn automatically. Do not poll or occupy the foreground waiting for background work.',
      'You may answer questions, inspect a small result and make quick decisions directly. Heavy execution belongs in worker tasks.',
      'Prioritize the human’s new direction over routine completions. Use message or stop to redirect existing tasks for corrections; spawn a new task for unrelated work.',
      'Each task runs in a worker conversation, shown as Tasks in Ember. Default workers complete explicitly with their current assignment token; a final reply is not Done. Done is their claim, not your verification.',
      'Read results when useful. Retrieved is not verified or incorporated: check evidence before claiming success.',
      'Quote relevant findings and include their /threads/<conversationId> source links so the human can explore them.',
      'Coordinate silently. Do not acknowledge every completion or repeat reports the human already saw.',
      'Speak when you have a useful answer, meaningful change, decision, blocker or final outcome.',
      'Delegation is not completion. Resume until the agreed outcome is delivered, unless the human redirects or stops it.',
    ].map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
  },
];

const MODEL_MARKER = '\n\nWorker model configuration (Ember v1):\n';

export function delegatorInstructions(choices: DelegatorChoices): string {
  // JSON keeps provider/model boundaries unambiguous even when a model id contains slashes.
  const configured = { harder: choices.harder, easier: choices.easier };
  const routing = (['harder', 'easier'] as const).map(role =>
    `${role === 'harder' ? 'Harder' : 'Easier'} tasks: ${choices[role] ? modelRefKey(choices[role]!) : 'not configured — do not dispatch'}.`
  ).join('\n');
  return INSTRUCTION_PRESETS[1].instructions + MODEL_MARKER + JSON.stringify(configured) + '\n' + routing;
}

/** Recognize only our exact generated format. Edited or retired prose stays custom, untouched. */
export function delegatorChoices(instructions: string | undefined): DelegatorChoices | undefined {
  if (!instructions?.includes(MODEL_MARKER)) return undefined;
  try {
    const parsed: unknown = JSON.parse(instructions.split(MODEL_MARKER)[1].split('\n')[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const choices = parsed as DelegatorChoices;
    for (const role of ['harder', 'easier'] as const) {
      const value = choices[role];
      if (value !== undefined && (!value || typeof value.providerID !== 'string' || !value.providerID.trim() || typeof value.modelID !== 'string' || !value.modelID.trim() || value.providerID === 'default' || value.modelID === 'default')) return undefined;
    }
    return delegatorInstructions(choices) === instructions ? choices : undefined;
  } catch { return undefined; }
}

/** Empty text is classic; generated model routing is still Ultra Delegator. */
export const presetFor = (instructions: string | undefined): InstructionPreset | undefined =>
  instructions === undefined ? undefined : INSTRUCTION_PRESETS.find(preset => preset.instructions === instructions)
    ?? (delegatorChoices(instructions) ? INSTRUCTION_PRESETS[1] : undefined);
