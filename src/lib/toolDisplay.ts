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

/**
 * Minimal shape of a message for deciding whether consecutive assistant steps in a turn should
 * bundle their foldable tool calls into a single "Used N tools" rollup.
 */
export type BundlableToolMessage = {
  role: 'user' | 'assistant';
  error?: string;
  parts: readonly {
    type: string;
    call?: {
      tool: string;
      images?: unknown[];
    };
  }[];
};

/**
 * True when an assistant message has foldable tool calls and no visible prose, file attachments,
 * Q&A (`ask`), image-carrying tools, or visible reasoning — so its only visible representation in
 * `collapsed` mode is a `ToolRollup` line ("Used 1 tool").
 *
 * When several such steps appear one after another before the next prose step, bundling them into
 * the following assistant step (or the last tool step of the run) produces a single "Used 3 tools"
 * line instead of repeating "Used 1 tool" on every step.
 */
export const isPureFoldableToolStep = (
  message: BundlableToolMessage,
  options: { reasoningHidden?: boolean; showQuestions?: boolean } = {}
): boolean => {
  if (message.role !== 'assistant' || message.error) return false;
  let hasFoldableTool = false;
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'file') return false;
    if (part.type === 'reasoning' && !options.reasoningHidden) return false;
    if (part.type === 'tool') {
      if (part.call?.tool === 'ask') {
        if (options.showQuestions !== false) return false;
        continue;
      }
      if ((part.call?.images?.length ?? 0) > 0) return false;
      hasFoldableTool = true;
    }
  }
  return hasFoldableTool;
};

/**
 * Bundle consecutive pure-tool assistant steps into a single message's tool rollup when
 * `toolDisplay === 'collapsed'`.
 *
 * Each step in a multi-step agent turn is its own `pi.assistant` entry, so an agent that runs three
 * sequential tool calls otherwise renders three separate `MessageRow`s each saying "Used 1 tool".
 * This folds a run of pure-tool steps into the immediately following assistant step (or into the
 * last step of the run if no assistant step follows), so the reader sees one "Used 3 tools" line
 * with all three calls inside it.
 */
export const bundleConsecutiveToolMessages = <
  TPart extends { type: string; call?: { tool: string; images?: unknown[] } },
  TMessage extends { role: 'user' | 'assistant'; error?: string; parts: TPart[] },
>(
  items: readonly { message: TMessage; index: number }[],
  options: {
    toolDisplay: ToolDisplay;
    hideToolCalls: boolean;
    reasoningHidden?: boolean;
    showQuestions?: boolean;
  }
): { message: TMessage; index: number }[] => {
  if (options.toolDisplay !== 'collapsed' || options.hideToolCalls || items.length < 2) {
    return items as { message: TMessage; index: number }[];
  }

  const result: { message: TMessage; index: number }[] = [];
  let pendingToolParts: TPart[] = [];
  let pendingLastItem: { message: TMessage; index: number } | null = null;

  const flushPending = () => {
    if (!pendingLastItem) return;
    if (pendingToolParts.length === pendingLastItem.message.parts.length) {
      result.push(pendingLastItem);
    } else {
      result.push({
        index: pendingLastItem.index,
        message: {
          ...pendingLastItem.message,
          parts: [...pendingToolParts],
        },
      });
    }
    pendingToolParts = [];
    pendingLastItem = null;
  };

  for (const item of items) {
    const pureTool = isPureFoldableToolStep(item.message, {
      reasoningHidden: options.reasoningHidden,
      showQuestions: options.showQuestions,
    });

    if (pureTool) {
      const toolParts = item.message.parts.filter(
        (part) =>
          part.type === 'tool' &&
          part.call?.tool !== 'ask' &&
          (part.call?.images?.length ?? 0) === 0
      );
      pendingToolParts.push(...toolParts);
      pendingLastItem = item;
      continue;
    }

    // If the next item is an assistant message, fold the accumulated tool calls into it so they
    // appear in its single ToolRollup ("Used N tools").
    if (pendingLastItem && item.message.role === 'assistant') {
      result.push({
        index: item.index,
        message: {
          ...item.message,
          parts: [...pendingToolParts, ...item.message.parts],
        },
      });
      pendingToolParts = [];
      pendingLastItem = null;
      continue;
    }

    flushPending();
    result.push(item);
  }

  flushPending();
  return result;
};
