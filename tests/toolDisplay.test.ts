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
  toolRollupIdentity,
  type ToolDisplay,
} from '../src/lib/toolDisplay';

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

  test('bundles adjacent tools without absorbing the following prose step', () => {
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

    expect(bundled).toHaveLength(3);
    expect(bundled[1].message.id).toBe('a1');
    expect(bundled[1].message.parts.filter((p) => p.type === 'tool')).toHaveLength(2);
    expect(bundled[1].sourceIndices).toEqual([1, 2]);
    expect(bundled[2]).toBe(items[3]);
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

describe('tool presentation boundaries and reconciliation', () => {
  type Part = { type: string; text?: string; call?: { id: string; tool: string; status: string; output?: string; error?: string; images?: unknown[] } };
  type Message = { id: string; role: 'assistant' | 'user'; error?: string; parts: Part[] };
  const tool = (id: string, status = 'completed'): Part => ({ type: 'tool', call: { id, tool: 'bash', status } });
  const message = (id: string, parts: Part[], role: Message['role'] = 'assistant'): Message => ({ id, role, parts });
  const options = { toolDisplay: 'collapsed' as const, hideToolCalls: false };
  const items = (messages: Message[]) => messages.map((message, index) => ({ message, index }));
  const bundle = (messages: Message[], extra = {}) => bundleConsecutiveToolMessages(items(messages), { ...options, ...extra });

  test('empty and whitespace text parts do not interrupt adjacent tool rows', () => {
    const input = [message('a', [{ type: 'text', text: '' }, tool('1')]), message('b', [tool('2'), { type: 'text', text: ' \n ' }])];
    const result = bundle(input);
    expect(result).toHaveLength(1);
    expect(result[0].message.parts).toEqual([input[0].parts[1], input[1].parts[0]]);
    expect(input[0].parts).toHaveLength(2);
  });

  test('prose, user messages and shown reasoning break runs', () => {
    for (const boundary of [
      message('boundary', [{ type: 'text', text: 'Next I will check the build.' }]),
      message('boundary', [{ type: 'text', text: '' }], 'user'),
      message('boundary', [{ type: 'reasoning', text: 'Checking the hypothesis.' }]),
    ]) {
      const result = bundle([message('a', [tool('1')]), boundary, message('b', [tool('2')])]);
      expect(result).toHaveLength(3);
      expect(result[1].message).toBe(boundary);
    }
  });

  test('mixed rows anchor following tools without absorbing preceding tools or following prose', () => {
    for (const type of ['text', 'reasoning']) {
      const prefix = { type, text: 'Checking the hypothesis.' };
      const anchor = message('anchor', [prefix, tool('anchor-call')]);
      const followingProse = message('reply', [{ type: 'text', text: 'Finished.' }]);
      const input = [message('before', [tool('before')]), anchor, message('after', [tool('after')]), followingProse];
      const result = bundle(input);
      expect(result).toHaveLength(3);
      expect(result[1].message.id).toBe(anchor.id);
      expect(result[1].message.parts).toEqual([prefix, anchor.parts[1], input[2].parts[0]]);
      expect(result[1].sourceIndices).toEqual([1, 2]);
      expect(result[1].index).toBe(1);
      expect(toolRollupIdentity(result[1].message)).toBe(toolRollupIdentity(anchor));
      expect(result[2].message).toBe(followingProse);
      expect(anchor.parts).toHaveLength(2);
    }
  });

  test('content after the last tool prevents a mixed row anchoring the next run', () => {
    for (const type of ['text', 'reasoning']) {
      const anchor = message('anchor', [tool('1'), { type, text: 'A separator after the tool.' }]);
      expect(bundle([anchor, message('next', [tool('2')])])).toHaveLength(2);
    }
  });

  test('hidden reasoning permits bundling but shown reasoning is never swallowed', () => {
    const input = [message('a', [tool('1')]), message('b', [{ type: 'reasoning', text: 'Inspecting.' }, tool('2')])];
    expect(bundle(input)).toHaveLength(2);
    const folded = bundle(input, { reasoningHidden: true });
    expect(folded).toHaveLength(1);
    expect(folded[0].sourceIndices).toEqual([0, 1]);
    expect(input[1].parts[0].text).toBe('Inspecting.');
  });

  test('settled results win over duplicate live calls in either ordering', () => {
    const settled = { ...tool('same'), call: { ...tool('same').call!, status: 'error', output: 'all retained output\n'.repeat(500), error: 'exit 1' } };
    const live = tool('same', 'running');
    for (const parts of [[live, settled], [settled, live]]) {
      const result = bundle(parts.map((part, index) => message(String(index), [part])));
      expect(result[0].message.parts).toEqual([settled]);
      expect(result[0].sourceIndices).toEqual([0, 1]);
    }
  });

  test('rollup expansion identity survives append and live-to-settled message ID changes', () => {
    const live = message('live-turn', [tool('call-1', 'running')]);
    const settled = message('e12', [tool('call-1')]);
    const grown = bundle([settled, message('e13', [tool('call-2')])]);
    expect(toolRollupIdentity(live)).toBe(toolRollupIdentity(settled));
    expect(toolRollupIdentity(grown[0].message)).toBe(toolRollupIdentity(live));
    expect(grown[0].message.id).toBe('e12');
    expect(grown[0].sourceIndices).toEqual([0, 1]);
  });

  test('images remain inline and failed calls keep their full detail', () => {
    const picture = message('picture', [{ ...tool('pic'), call: { ...tool('pic').call!, images: [{ url: 'data:image/png;base64,abc' }] } }]);
    const failure = message('failure', [{ ...tool('bad'), call: { ...tool('bad').call!, status: 'error', output: 'long log\n'.repeat(1000), error: 'Command exited with code 1' } }]);
    const result = bundle([message('a', [tool('1')]), failure, picture]);
    expect(result).toHaveLength(2);
    expect(result[0].message.parts[1]).toBe(failure.parts[0]);
    expect(result[1].message).toBe(picture);
    const messageError = { ...failure, error: 'Provider stopped' };
    expect(bundle([message('a', [tool('1')]), messageError])).toHaveLength(2);
  });

  test('list and hidden modes preserve the original items unchanged', () => {
    const input = items([message('a', [tool('1')]), message('b', [tool('2')])]);
    expect(bundleConsecutiveToolMessages(input, { ...options, toolDisplay: 'list' })).toBe(input);
    expect(bundleConsecutiveToolMessages(input, { ...options, hideToolCalls: true })).toBe(input);
  });
});
