/**
 * The transcript's two ways of drawing tool use.
 *
 * `list` is one row per tool group, as the transcript has always drawn them: `Read → config.ts`,
 * `bash → pnpm test`, and so on, each openable for its arguments and output.
 *
 * `collapsed` folds **every** tool call in a turn into a single line — "Using tools (3)…" — whose
 * count grows as the turn goes on, with the usual list behind a click. It exists because a long
 * agentic turn is mostly tools, and a reader who wants to watch the prose should not have to scroll
 * past twenty rows of them to find the next sentence. The detail is not lost, only deferred: opening
 * the line gives back exactly what `list` would have drawn.
 *
 * Pure on purpose: the count, the fold and the phrase are pinned by tests rather than by watching a
 * turn stream.
 */

/** How tool calls are drawn in a transcript. */
export type ToolDisplay = 'list' | 'collapsed';

export const TOOL_DISPLAY_VALUES: readonly ToolDisplay[] = ['list', 'collapsed'];

export const isToolDisplay = (value: unknown): value is ToolDisplay =>
  typeof value === 'string' && (TOOL_DISPLAY_VALUES as readonly string[]).includes(value);

/**
 * The line a folded turn shows.
 *
 * "Using tools (3)…" while the turn is live and "Used 3 tools" once it has finished: the ellipsis is
 * a promise of more to come, and a finished turn should stop making it. The singular is written out
 * rather than "1 tools".
 */
export const foldedToolsLabel = (count: number, { live }: { live: boolean }): string => {
  const noun = count === 1 ? 'tool' : 'tools';
  // Nothing has run yet: a count of zero is not worth a line, and the caller renders nothing.
  if (count <= 0) return '';
  return live ? `Using ${noun} (${count})…` : `Used ${count} ${noun}`;
};

/**
 * Whether a tool block belongs in the fold.
 *
 * A block carrying images is excluded: the transcript shows those even when tool rows are hidden
 * (`ToolImages`), and folding a picture into a count would lose it entirely rather than defer it.
 */
/** The shape this module reasons about: enough of a transcript block to decide the fold. */
export type FoldableBlock = { type: string; calls?: readonly { images?: unknown[] }[] };

/**
 * A type guard, so a caller filtering a union of block shapes gets the tool blocks back typed —
 * `blocks.filter(foldsIntoRollup)` narrows to the ones the rollup can take.
 */
export const foldsIntoRollup = <T extends FoldableBlock>(block: T): block is T & { type: 'tools' } =>
  block.type === 'tools' && !(block.calls ?? []).some((call) => (call.images?.length ?? 0) > 0);

/**
 * How many tool calls a turn has made, for the folded line's count.
 *
 * Counts calls, not blocks: `bash × 3` folded into one row is still three tools used, and the number
 * is what tells the reader the turn is doing work.
 */
export const countToolCalls = (blocks: readonly { type: string; calls?: readonly unknown[] }[]): number =>
  blocks.reduce((total, block) => (block.type === 'tools' ? total + (block.calls?.length ?? 0) : total), 0);

/**
 * Which tool options the view menu offers, and whether they are on.
 *
 * The two tool options are meaningless with tool use hidden — one says how to draw rows that are not
 * drawn, the other says whether to draw them in a list — so they are **omitted**, not disabled. A
 * greyed-out checkbox for something that would do nothing either way is a switch that lies about
 * what it would change; hiding it says the same thing without inviting a click.
 */
export type ToolOption = { id: 'expandToolDetails' | 'listAll'; label: string; checked: boolean };

export const toolMenuOptions = (
  view: { hideToolCalls: boolean; expandToolCalls: boolean; toolDisplay: ToolDisplay }
): ToolOption[] => {
  if (view.hideToolCalls) return [];
  return [
    {
      id: 'expandToolDetails',
      label: 'Expand tool call details by default',
      checked: view.expandToolCalls,
    },
    {
      id: 'listAll',
      label: 'List all tools',
      checked: view.toolDisplay === 'list',
    },
  ];
};
