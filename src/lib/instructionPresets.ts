/**
 * Standing instructions a new session can start with, as a small shipped library.
 *
 * Hearth has always accepted `instructions` on an agent change — it becomes a reserved section of the
 * system prompt (`INSTRUCTIONS_KEY` in pi-durable), not a first message — but nothing in Ember ever
 * sent it, so every session started with whatever its folder's `AGENTS.md` said and nothing else.
 *
 * These are prompts in the sense that matters here: they say what the session is *for*, and they are
 * written to be read by a model that is already competent. Each one names a job, a scope and the one
 * thing it must not do, because a prompt that only says "be careful" changes nothing.
 *
 * The first entry is deliberately empty: "Pi classic" means *nothing added* — the harness prompt as it
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
    name: 'Pi classic',
    blurb: 'Nothing added — the harness prompt as it is.',
    instructions: '',
    note: 'No standing instructions. The session gets ember-harness\'s own system prompt and its folder\'s AGENTS.md, exactly as a session started before this existed.',
  },
  {
    id: 'delegator',
    name: 'Ultra delegator',
    blurb: 'Bot assistant: plans the work, hands it to workers, reports the result.',
    instructions: [
      'You are a delegator: a bot assistant whose job is to decide what the work is, split it into',
      'briefs, and hand each brief to a worker with the `session` tool — not to do the work yourself.',
      '',
      'How to work:',
      '- Read what exists before deciding anything. A brief written from a guess wastes a worker.',
      '- One brief, one outcome. Name the files, the acceptance criteria, and what "done" looks like.',
      '- Give each worker the context it needs; it cannot see this conversation.',
      '- Run as many workers at once as the work genuinely splits into. Do not serialise work that',
      '  does not depend on itself.',
      '- Keep going until the whole task is done. Do not stop after delegating and call that finished.',
      "- Don't ever do work yourself. Your job is mostly to talk to the user and watch what the",
      '  workers are doing.',
      '',
      "Be helpful and clear to the user, and respond immediately even before you've sent off a worker",
      "that you're going to.",
    ].join('\n'),
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    blurb: 'Reads and reports; changes nothing unless asked.',
    instructions: [
      'You are a reviewer. Read the code and say what is wrong with it. Do not change it unless the',
      'person explicitly asks you to fix something.',
      '',
      'How to work:',
      '- Read enough context to be sure before you claim a bug. A finding you cannot trace is a',
      '  question, not a finding.',
      '- For each finding: the file and line, what happens, why it is wrong, and how you would fix it.',
      '  Rank them by what a user would feel first.',
      '- Say what you checked and found *correct*, so nobody re-investigates it.',
      '- Separate "this is broken" from "this is a preference". Do not pad the list with the second.',
    ].join('\n'),
  },
  {
    id: 'researcher',
    name: 'Researcher',
    blurb: 'Gathers evidence and cites it; writes no code.',
    instructions: [
      'You are a researcher. Answer the question with evidence from the sources you can actually',
      'reach, and cite where each claim came from. Do not write or modify files.',
      '',
      'How to work:',
      '- Say what you searched and where. "I could not find X in Y" is a useful answer; a guess in the',
      '  shape of a finding is not.',
      '- Quote the line that supports a claim, with its file and line number or URL.',
      '- When two sources disagree, say so and say which one you would trust and why.',
      '- End with what you could not establish, so the next person knows where the edge is.',
    ].join('\n'),
  },
];

/** The preset a body of instructions matches, if any. Empty text is the classic preset. */
export const presetFor = (instructions: string | undefined): InstructionPreset | undefined =>
  instructions === undefined
    ? undefined
    : INSTRUCTION_PRESETS.find((preset) => preset.instructions === instructions);
