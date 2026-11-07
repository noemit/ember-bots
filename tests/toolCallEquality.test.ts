import { describe, expect, test } from 'bun:test';
import { equalMessage, reconcileFullTranscript, toolCallEqual } from '../src/lib/transcriptReconciliation';
import type { ChatMessage, NestedToolCall, ToolCall } from '../src/types';

const nested = (overrides: Partial<NestedToolCall> = {}): NestedToolCall => ({
  id: 'c1',
  name: 'read',
  args: '{"path":"src/App.tsx"}',
  status: 'running',
  ...overrides,
});

const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  id: 'call-1',
  tool: 'codemode',
  status: 'running',
  input: { code: 'const a = 1;' },
  ...overrides,
});

const assistantWith = (toolCall: ToolCall): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  text: '',
  parts: [{ type: 'tool', id: 'a1-tool', call: toolCall }],
  completed: false,
});

describe('tool call equality', () => {
  test('identical calls are equal, including their nested calls', () => {
    expect(toolCallEqual(call({ nestedCalls: [nested()] }), call({ nestedCalls: [nested()] }))).toBe(true);
  });

  test('a nested call settling is a change', () => {
    const running = call({ nestedCalls: [nested()] });
    const settled = call({ nestedCalls: [nested({ status: 'ok', durationMs: 120 })] });
    expect(toolCallEqual(running, settled)).toBe(false);
  });

  test('nested errors, names and args are compared', () => {
    const base = call({ nestedCalls: [nested({ status: 'error' })] });
    expect(toolCallEqual(base, call({ nestedCalls: [nested({ status: 'error', error: 'boom' })] }))).toBe(false);
    expect(toolCallEqual(base, call({ nestedCalls: [nested({ status: 'error', name: 'bash' })] }))).toBe(false);
    expect(toolCallEqual(base, call({ nestedCalls: [nested({ status: 'error', args: '{}' })] }))).toBe(false);
    expect(toolCallEqual(base, call({ nestedCalls: [] }))).toBe(false);
  });

  test('the full-output path is compared', () => {
    expect(toolCallEqual(call(), call({ fullOutputPath: '/tmp/out.txt' }))).toBe(false);
  });
});

describe('reconciliation keeps a call whose nested calls moved', () => {
  // The signature only digests input/output/diff, so without `toolCallEqual` these two calls look
  // identical and the reconciler would hand React the stale object, freezing the row mid-script.
  const before = assistantWith(call({ nestedCalls: [nested()] }));
  const after = assistantWith(call({ nestedCalls: [nested({ status: 'ok', durationMs: 900 })] }));

  test('equalMessage sees the change', () => {
    expect(equalMessage(before, before)).toBe(true);
    expect(equalMessage(before, after)).toBe(false);
  });

  test('a full reconcile replaces the message object', () => {
    const result = reconcileFullTranscript([before], [after], new Set());
    expect(result.messages[0]).toBe(after);
  });

  test('a full-output path landing replaces the message object', () => {
    const withPath = assistantWith(call({ fullOutputPath: '/tmp/full.txt' }));
    expect(reconcileFullTranscript([before], [withPath], new Set()).messages[0]).toBe(withPath);
  });
});
