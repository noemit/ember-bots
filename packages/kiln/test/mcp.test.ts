import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  actionNameOf,
  buildMcpTools,
  commonActionPrefix,
  isReadOnlyMcpTool,
  mcpContentToHearth,
  mcpNamespaces,
  readMcpConfig,
} from '../src/mcp';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'faux-mcp.ts');
const browserFixture = join(here, 'fixtures', 'faux-browser.ts');

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
    const result = await tool.execute({ text: 'hi' }, {} as never, BACKGROUND_CONTEXT);
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
    const api = { output: () => {} } as never;
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
