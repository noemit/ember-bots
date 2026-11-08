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
  id: string;
  role: 'user' | 'assistant';
  error?: string;
  parts: readonly {
    type: string;
    text?: string;
    call?: { id?: string; tool: string; status?: string; images?: unknown[] };
  }[];
};

/** Only invisible text/reasoning may accompany a foldable run. Images and errors stay inline. */
export const isPureFoldableToolStep = (
  message: BundlableToolMessage,
  options: { reasoningHidden?: boolean; showQuestions?: boolean } = {}
): boolean => {
  if (message.role !== 'assistant' || message.error) return false;
  let hasTool = false;
  for (const part of message.parts) {
    if (part.type === 'file' || (part.type === 'text' && part.text?.trim())) return false;
    if (part.type === 'reasoning' && part.text?.trim() && !options.reasoningHidden) return false;
    if (part.type === 'tool') {
      if (part.call?.tool === 'ask') {
        if (options.showQuestions !== false) return false;
        continue;
      }
      if (part.call?.images?.length) return false;
      hasTool = true;
    }
  }
  return hasTool;
};

export type ToolPresentationItem<T> = {
  message: T;
  index: number;
  /** Original transcript positions, for navigation/search; never substitute presentation IDs. */
  sourceIndices?: number[];
};

/** A call ID survives the live-message → settled-entry handover, unlike the message ID. */
export const toolRollupIdentity = (message: BundlableToolMessage): string =>
  message.parts.find(part => part.type === 'tool' && part.call?.tool !== 'ask' && !part.call?.images?.length)?.call?.id ?? message.id;

/** A mixed row may anchor a run only when its visible content ends in foldable tools. */
const hasTrailingFoldableTools = (
  message: BundlableToolMessage,
  options: { reasoningHidden?: boolean; showQuestions?: boolean }
): boolean => {
  if (message.role !== 'assistant' || message.error) return false;
  let trailingTool = false;
  for (const part of message.parts) {
    // Keep images, attachments and question cards independent of cross-message rollups.
    if (part.type === 'file' || (part.type === 'tool' &&
        (part.call?.images?.length || (part.call?.tool === 'ask' && options.showQuestions !== false)))) return false;
    if (part.type === 'tool' && part.call?.tool !== 'ask') trailingTool = true;
    else if ((part.type === 'text' && part.text?.trim()) ||
        (part.type === 'reasoning' && part.text?.trim() && !options.reasoningHidden)) trailingTool = false;
  }
  return trailingTool;
};

/** Presentation only: new prose/reasoning starts a boundary; trailing tools may anchor the next run. */
export const bundleConsecutiveToolMessages = <
  TPart extends BundlableToolMessage['parts'][number],
  TMessage extends BundlableToolMessage & { parts: TPart[] },
>(
  items: readonly ToolPresentationItem<TMessage>[],
  options: {
    toolDisplay: ToolDisplay;
    hideToolCalls: boolean;
    reasoningHidden?: boolean;
    showQuestions?: boolean;
  }
): ToolPresentationItem<TMessage>[] => {
  if (options.toolDisplay !== 'collapsed' || options.hideToolCalls) {
    return items as ToolPresentationItem<TMessage>[];
  }
  const result: ToolPresentationItem<TMessage>[] = [];
  let run: ToolPresentationItem<TMessage>[] = [];
  const flush = () => {
    if (!run.length) return;
    const parts: TPart[] = [];
    const calls = new Map<string, number>();
    const mixedAnchor = !isPureFoldableToolStep(run[0].message, options);
    if (mixedAnchor && run.length === 1) {
      result.push(run[0]);
      run = [];
      return;
    }
    for (const [position, { message }] of run.entries()) {
      for (const part of message.parts) {
        if (part.type !== 'tool' || part.call?.tool === 'ask') {
          if (mixedAnchor && position === 0) parts.push(part);
          continue;
        }
        const id = part.call?.id;
        const previous = id ? calls.get(id) : undefined;
        if (previous === undefined) {
          if (id) calls.set(id, parts.length);
          parts.push(part);
        } else {
          // A stale live slot may coexist with its settled entry. Never let it replace the result.
          const status = parts[previous].call?.status;
          const incoming = part.call?.status;
          if (!status || status === 'running' || status === 'pending' ||
              (incoming && incoming !== 'running' && incoming !== 'pending')) parts[previous] = part;
        }
      }
    }
    result.push({
      ...run[0],
      message: { ...run[0].message, parts },
      sourceIndices: run.flatMap(item => item.sourceIndices ?? [item.index]),
    });
    run = [];
  };
  for (const item of items) {
    if (isPureFoldableToolStep(item.message, options)) run.push(item);
    else {
      flush();
      if (hasTrailingFoldableTools(item.message, options)) run.push(item);
      else result.push(item);
    }
  }
  flush();
  return result;
};
