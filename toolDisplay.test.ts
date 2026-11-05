/**
 * The folded tool display: one line for a turn's tools, and when folding is allowed at all.
 *
 * The rule this exists for is a reader's: a long agentic turn is mostly tools, and someone following
 * the prose should not have to scroll past twenty rows of them. So the count, the phrase and the
 * exclusion of image-carrying blocks are pinned here rather than eyeballed against a live turn.
 */
import { describe, expect, test } from 'bun:test';
import {
  bundleConsecutiveToolMessages,
  countToolCalls,
  foldedToolsLabel,
  foldsIntoRollup,
  isToolDisplay,
  toolMenuOptions,
  type ToolDisplay,
} from './src/lib/toolDisplay';

describe('the folded line', () => {
  test('counts while the turn is live, and says so with an ellipsis', () => {
    expect(foldedToolsLabel(3, { live: true })).toBe('Using tools (3)…');
    expect(foldedToolsLabel(1, { live: true })).toBe('Using tool (1)…');
    expect(foldedToolsLabel(24, { live: true })).toBe('Using tools (24)…');
  });

  test('a finished turn stops promising more', () => {
    // The ellipsis is a promise of more to come; once the turn ends it is a lie.
    expect(foldedToolsLabel(3, { live: false })).toBe('Used 3 tools');
    expect(foldedToolsLabel(1, { live: false })).toBe('Used 1 tool');
  });

  test('nothing to show is an empty string, so the caller draws no line', () => {
    expect(foldedToolsLabel(0, { live: true })).toBe('');
    expect(foldedToolsLabel(0, { live: false })).toBe('');
  });
});

describe('the count', () => {
  test('counts calls, not rows: a repeated tool is still several tools', () => {
    // `bash × 3` folds into one row but the turn used three tools, and that is the number that says
    // the turn is doing work.
    expect(
      countToolCalls([
        { type: 'text' },
        { type: 'tools', calls: [{}, {}, {}] },
        { type: 'tools', calls: [{}] },
      ])
    ).toBe(4);
  });

  test('text, reasoning and files contribute nothing', () => {
    expect(countToolCalls([{ type: 'text' }, { type: 'reasoning' }, { type: 'file' }])).toBe(0);
  });
});

describe('what folds', () => {
  test('tool blocks fold', () => {
    expect(foldsIntoRollup({ type: 'tools', calls: [{}] })).toBe(true);
  });

  test('a block carrying images does not', () => {
    // The transcript shows those even when tool rows are hidden; folding one into a count would
    // lose the picture rather than defer it.
    expect(foldsIntoRollup({ type: 'tools', calls: [{}, { images: [{ url: 'x' }] }] })).toBe(false);
    expect(foldsIntoRollup({ type: 'tools', calls: [{ images: [] }] })).toBe(true);
  });

  test('anything that is not a tool block does not', () => {
    for (const type of ['text', 'reasoning', 'file', 'ask']) {
      expect(foldsIntoRollup({ type })).toBe(false);
    }
  });
});

describe('reading the stored mode', () => {
  test('accepts exactly the two modes it knows', () => {
    expect(isToolDisplay('list')).toBe(true);
    expect(isToolDisplay('collapsed')).toBe(true);
    // A settings file from a half-finished experiment must not become a third mode.
    expect(isToolDisplay('expanded')).toBe(false);
    expect(isToolDisplay(undefined)).toBe(false);
    expect(isToolDisplay(0)).toBe(false);
  });
});

/**
 * What the view menu offers.
 *
 * The owner's rule: the tool options only make sense with tool use on, and they are *absent* rather
 * than disabled when it is off. Also pinned: the naming — "Expand tool call details by default"
 * says when the expansion happens, and "List all tools" says what it skips (the folded line).
 */
describe('the tool options in the view menu', () => {
  const view = (over: Partial<{ hideToolCalls: boolean; expandToolCalls: boolean; toolDisplay: ToolDisplay }> = {}) => ({
    hideToolCalls: false,
    expandToolCalls: false,
    toolDisplay: 'collapsed' as ToolDisplay,
    ...over,
  });

  test('are absent while tool use is hidden — not disabled', () => {
    expect(toolMenuOptions(view({ hideToolCalls: true }))).toEqual([]);
  });

  test('are exactly two, in the order a reader meets them', () => {
    const options = toolMenuOptions(view());
    expect(options.map((option) => option.label)).toEqual([
      'Expand tool call details by default',
      'List all tools',
    ]);
  });

  test('each reports its own state', () => {
    const off = toolMenuOptions(view());
    expect(off.map((option) => option.checked)).toEqual([false, false]);

    const on = toolMenuOptions(view({ expandToolCalls: true, toolDisplay: 'list' }));
    expect(on.map((option) => option.checked)).toEqual([true, true]);

    // The two are independent: folding the list while still expanding details is a real choice.
    const mixed = toolMenuOptions(view({ expandToolCalls: true, toolDisplay: 'collapsed' }));
    expect(mixed.map((option) => option.checked)).toEqual([true, false]);
  });
});

describe('bundling consecutive tool-only assistant steps', () => {
  type TestPart = { type: string; id: string; text?: string; call?: { tool: string; images?: unknown[] } };
  type TestMsg = { id: string; role: 'user' | 'assistant'; error?: string; parts: TestPart[] };

  const toolMsg = (id: string, tool = 'read'): TestMsg => ({
    id,
    role: 'assistant',
    parts: [{ type: 'tool', id: `${id}-t`, call: { tool } }],
  });

  const proseMsg = (id: string, text: string, withTool?: string): TestMsg => ({
    id,
    role: 'assistant',
    parts: [
      ...(withTool ? [{ type: 'tool', id: `${id}-t`, call: { tool: withTool } }] : []),
      { type: 'text', id: `${id}-txt`, text },
    ],
  });

  test('bundles three consecutive 1-tool assistant steps into a single 3-tool rollup on the following assistant step', () => {
    const items = [
      { index: 0, message: { id: 'u1', role: 'user' as const, parts: [{ type: 'text', id: 'u1-0', text: 'check files' }] } },
      { index: 1, message: toolMsg('a1', 'read') },
      { index: 2, message: toolMsg('a2', 'read') },
      { index: 3, message: proseMsg('a3', 'All done.', 'bash') },
    ];

    const bundled = bundleConsecutiveToolMessages(items, {
      toolDisplay: 'collapsed',
      hideToolCalls: false,
    });

    expect(bundled).toHaveLength(2);
    expect(bundled[1].message.id).toBe('a3');
    expect(bundled[1].message.parts.filter((p) => p.type === 'tool')).toHaveLength(3);
  });

  test('bundles a trailing run of pure-tool steps into one row when no prose step follows yet', () => {
    const items = [
      { index: 0, message: toolMsg('a1', 'read') },
      { index: 1, message: toolMsg('a2', 'edit') },
      { index: 2, message: toolMsg('a3', 'bash') },
    ];

    const bundled = bundleConsecutiveToolMessages(items, {
      toolDisplay: 'collapsed',
      hideToolCalls: false,
    });

    expect(bundled).toHaveLength(1);
    expect(bundled[0].message.parts).toHaveLength(3);
  });

  test('leaves items untouched when toolDisplay is list', () => {
    const items = [
      { index: 0, message: toolMsg('a1', 'read') },
      { index: 1, message: toolMsg('a2', 'read') },
    ];

    const unbundled = bundleConsecutiveToolMessages(items, {
      toolDisplay: 'list',
      hideToolCalls: false,
    });

    expect(unbundled).toHaveLength(2);
  });
});
