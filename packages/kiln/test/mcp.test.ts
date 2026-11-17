import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { AutoAcceptDoc, pendingApprovals, replyApproval, setAutoAccept } from '../src/approvals';
import {
  actionNameOf,
  buildMcpTools,
  commonActionPrefix,
  isReadOnlyMcpTool,
  mcpContentToHearth,
  mcpNamespaces,
  mcpSection,
  readMcpConfig,
} from '../src/mcp';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'faux-mcp.ts');
const browserFixture = join(here, 'fixtures', 'faux-browser.ts');

const autoAcceptApi = {
  taskId: 1,
  callId: 'c1',
  conversationId: 1,
  output: () => {},
  snapshot: async (doc: unknown) => (doc === AutoAcceptDoc ? { enabled: true, allowed: [] } : undefined),
  commit: async () => {},
} as never;

test('readMcpConfig tolerates a missing or malformed file', () => {
  expect(readMcpConfig(join(here, 'does-not-exist.json'))).toEqual({ mcpServers: {} });
});

test('buildMcpTools spawns a server, registers its tools, and calls one', async () => {
  const { tools, close, summary } = await buildMcpTools(
    { mcpServers: { faux: { command: 'bun', args: ['run', fixture] } } },
    '/tmp/mcp.json'
  );
  try {
    expect(tools.map((tool) => tool.name)).toEqual(['faux__echo']);
    expect(summary).toEqual({
      configPath: '/tmp/mcp.json',
      servers: [{ name: 'faux', toolCount: 1, command: `bun run ${fixture}` }],
    });
    const tool = tools[0];
    // 1.4.0 results carry `output`, and MCP tools are callable from a codemode script.
    const result = await tool.execute({ text: 'hi' }, autoAcceptApi, BACKGROUND_CONTEXT);
    expect(result.output).toEqual([{ type: 'text', text: 'echo: hi' }]);
    expect(tool.callers).toEqual(['model', 'tools']);
    // No readOnlyHint and no config override: an MCP call may change the world, so no rerun.
    expect(tool.replay).toBe('unsafe');
  } finally {
    close();
  }
}, 20_000);

test('commonActionPrefix/actionNameOf strip the shared tool-name prefix', () => {
  expect(commonActionPrefix(['browser_navigate', 'browser_click', 'browser_take_screenshot'])).toBe('browser_');
  expect(commonActionPrefix(['echo'])).toBe('');
  expect(commonActionPrefix([])).toBe('');
  expect(actionNameOf('browser_navigate', 'browser_')).toBe('navigate');
  expect(actionNameOf('echo', 'browser_')).toBe('echo');
});

test('isReadOnlyMcpTool trusts annotations.readOnlyHint and the config overrides, nothing else', () => {
  expect(isReadOnlyMcpTool({ command: 'x' }, { name: 'search', annotations: { readOnlyHint: true } })).toBe(true);
  expect(isReadOnlyMcpTool({ command: 'x' }, { name: 'search', annotations: { readOnlyHint: false } })).toBe(false);
  expect(isReadOnlyMcpTool({ command: 'x' }, { name: 'search' })).toBe(false);
  // A server that predates annotations, or one name in a mixed server.
  expect(isReadOnlyMcpTool({ command: 'x', readOnly: true }, { name: 'click' })).toBe(true);
  expect(isReadOnlyMcpTool({ command: 'x', readOnlyTools: ['search'] }, { name: 'search' })).toBe(true);
  expect(isReadOnlyMcpTool({ command: 'x', readOnlyTools: ['search'] }, { name: 'click' })).toBe(false);
  // Only an explicit `true` counts.
  expect(isReadOnlyMcpTool({ command: 'x' }, { name: 'search', annotations: { readOnlyHint: 'yes' as never } })).toBe(
    false
  );
});

test('mcpNamespaces groups each non-collapsed server by its `<server>_` prefix', () => {
  const namespaces = mcpNamespaces({
    configPath: '/tmp/mcp.json',
    servers: [
      { name: 'github', toolCount: 3, command: 'gh-mcp' },
      { name: 'playwright', toolCount: 1, command: 'npx playwright', tool: 'browser', actions: 25 },
      { name: 'broken', toolCount: 0, command: 'nope' },
    ],
  });
  expect(namespaces).toEqual([{ name: 'github', prefix: 'github_', description: 'MCP server github' }]);
});

test('mcpContentToHearth forwards image parts (stripping data URL prefix and gating size) and text, stringifies the rest', () => {
  expect(
    mcpContentToHearth([
      { type: 'text', text: 'ok' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'image', data: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' },
      { type: 'image', data: 'A'.repeat(17 * 1024 * 1024), mimeType: 'image/png' },
      { type: 'resource', uri: 'x' },
    ])
  ).toEqual([
    { type: 'text', text: 'ok' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    { type: 'text', text: '(MCP image omitted: exceeds 12MB limit)' },
    { type: 'text', text: JSON.stringify({ type: 'resource', uri: 'x' }) },
  ]);
});

test('buildMcpTools collapses a server into one action-dispatch tool', async () => {
  const { tools, close, summary } = await buildMcpTools(
    { mcpServers: { playwright: { command: 'bun', args: ['run', browserFixture], tool: 'browser', exclude: ['drop'] } } },
    '/tmp/mcp.json'
  );
  try {
    expect(tools.map((tool) => tool.name)).toEqual(['browser']);
    expect(summary).toEqual({
      configPath: '/tmp/mcp.json',
      servers: [{ name: 'playwright', toolCount: 1, command: `bun run ${browserFixture}`, tool: 'browser', actions: 3 }],
    });
    // A collapsed server exposes its actions, not `<server>__<tool>` names, so nothing groups by prefix.
    expect(mcpNamespaces(summary)).toEqual([]);
    expect(tools[0].callers).toEqual(['model', 'tools']);
    // Clicking is not a read: the dispatcher must not rerun after a restart.
    expect(tools[0].replay).toBe('unsafe');
    const api = autoAcceptApi;
    // Flattened inputs, nested `parameters`, and image pass-through.
    expect((await tools[0].execute({ action: 'navigate', url: 'https://example.com' }, api, BACKGROUND_CONTEXT)).output).toEqual([
      { type: 'text', text: 'navigated to https://example.com' },
    ]);
    expect((await tools[0].execute({ action: 'click', target: '#go' }, api, BACKGROUND_CONTEXT)).output).toEqual([
      { type: 'text', text: 'clicked #go' },
    ]);
    expect((await tools[0].execute({ action: 'navigate', parameters: { url: 'https://nested' } }, api, BACKGROUND_CONTEXT)).output).toEqual([
      { type: 'text', text: 'navigated to https://nested' },
    ]);
    expect((await tools[0].execute({ action: 'take_screenshot' }, api, BACKGROUND_CONTEXT)).output).toEqual([
      { type: 'text', text: 'screenshot' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    // Excluded and unknown actions fail without calling the server.
    expect((await tools[0].execute({ action: 'drop', target: '#x' }, api, BACKGROUND_CONTEXT)).isError).toBe(true);
    expect((await tools[0].execute({ action: 'bogus' }, api, BACKGROUND_CONTEXT)).isError).toBe(true);
  } finally {
    close();
  }
}, 20_000);

test('a read-only collapsed server is replay-safe', async () => {
  const { tools, close } = await buildMcpTools(
    {
      mcpServers: {
        playwright: { command: 'bun', args: ['run', browserFixture], tool: 'browser', exclude: ['drop'], readOnly: true },
      },
    },
    '/tmp/mcp.json'
  );
  try {
    expect(tools[0].replay).toBe('safe');
  } finally {
    close();
  }
}, 20_000);

test('non-YOLO MCP tool calls park in ApprovalsDoc until approved, and YOLO calls run immediately', async () => {
  const mcp = await buildMcpTools(
    {
      mcpServers: {
        faux: { command: 'bun', args: ['run', fixture] },
        playwright: { command: 'bun', args: ['run', browserFixture], tool: 'browser' },
      },
    },
    '/tmp/mcp.json'
  );
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('faux__echo', { text: 'gated-echo' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Echo ran after approval.')]),
    fauxAssistantMessage([fauxToolCall('browser', { action: 'navigate', url: 'https://example.com' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Browser rejected.')]),
    fauxAssistantMessage([fauxToolCall('faux__echo', { text: 'yolo-echo' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('YOLO ran.')]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install({ name: 'mcp', tools: mcp.tools, sections: [mcpSection(mcp.summary)] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const conv = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });

    // 1. Direct MCP tool (`faux__echo`) parks while AutoAcceptDoc.enabled is false.
    const first = await conv.submit({ type: 'input', content: 'echo it' }, BACKGROUND_CONTEXT);
    let pending = await pendingApprovals(harness, [conv.id]);
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pending = await pendingApprovals(harness, [conv.id]);
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('faux__echo');
    expect(pending[0].arguments).toEqual({ text: 'gated-echo' });

    expect(await replyApproval(harness, conv.id, pending[0].key, 'once')).toBe(true);
    expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe('done');
    const firstEntries = JSON.stringify((await conv.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items);
    expect(firstEntries).toContain('echo: gated-echo');

    // 2. Collapsed MCP tool (`browser`) also parks; rejecting blocks execution.
    const second = await conv.submit({ type: 'input', content: 'open site' }, BACKGROUND_CONTEXT);
    pending = await pendingApprovals(harness, [conv.id]);
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pending = await pendingApprovals(harness, [conv.id]);
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('browser');
    expect(pending[0].arguments).toEqual({ action: 'navigate', url: 'https://example.com' });

    expect(await replyApproval(harness, conv.id, pending[0].key, 'reject')).toBe(true);
    expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe('done');
    const secondEntries = JSON.stringify((await conv.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items);
    expect(secondEntries).not.toContain('navigated to https://example.com');
    expect(secondEntries).toContain('The user rejected this tool call.');

    // 3. Enabling YOLO (`AutoAcceptDoc.enabled = true`) runs MCP tools without parking.
    await setAutoAccept(harness, conv.id, true, BACKGROUND_CONTEXT);
    const third = await conv.submit({ type: 'input', content: 'yolo echo' }, BACKGROUND_CONTEXT);
    expect((await third.wait(BACKGROUND_CONTEXT)).status).toBe('done');
    expect(await pendingApprovals(harness, [conv.id])).toHaveLength(0);
    const thirdEntries = JSON.stringify((await conv.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items);
    expect(thirdEntries).toContain('echo: yolo-echo');
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    mcp.close();
  }
}, 30_000);
