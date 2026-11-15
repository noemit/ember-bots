import { expect, test } from 'bun:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ContextView } from '@earendil-works/pi-durable';
import { currentContextOf } from '../src/currentContext';

const assistant = (tokens: number, timestamp: number) => {
  const message = fauxAssistantMessage('recorded answer', { timestamp });
  return { ...message, usage: { ...message.usage, input: tokens, totalTokens: tokens } };
};
test('current context uses latest applicable usage plus trailing content, never lifetime sum', () => {
  const value = currentContextOf({ head: undefined, messages: [assistant(1000, 1), assistant(2000, 2),
    { role: 'user', content: 'x'.repeat(35), timestamp: 3 },
  ] });
  expect(value).toMatchObject({ currentContextTokens: 2010, currentContextEpoch: 'initial' });
  expect(value.currentContextHistoryTokens).toBeLessThan(100);
});
test('applied summary invalidates retained old assistant usage until a genuinely newer request answers', () => {
  const head = { id: 10 } as ContextView['head'];
  const summary = { role: 'user' as const, content: 'summary', timestamp: 30 };
  const compacted = currentContextOf({ head, messages: [summary, assistant(9000, 20)] });
  expect(compacted.currentContextTokens).toBeLessThan(9000);
  expect(compacted.currentContextEpoch).toBe('10');
  expect(currentContextOf({ head, messages: [summary, assistant(9000, 20), assistant(512, 40)] }).currentContextTokens).toBe(512);
});

test('a huge first system prompt is real context, not older conversation content', () => {
  const system = { role: 'system' as const, content: 'instructions '.repeat(35_000), timestamp: 1 };
  const user = { role: 'user' as const, content: 'Hello', timestamp: 2 };
  const initial = currentContextOf({ head: undefined, messages: [system, user] });
  expect(initial.currentContextTokens).toBeGreaterThan(100_000);
  expect(initial.currentContextHistoryTokens).toBeLessThan(10);
  // Once measured, provider usage still includes instructions and must not become history size.
  const measured = currentContextOf({ head: undefined, messages: [system, user, assistant(140_000, 3)] });
  expect(measured.currentContextTokens).toBe(140_000);
  expect(measured.currentContextHistoryTokens).toBeLessThan(20);
  const empty = currentContextOf({ head: undefined, messages: [] });
  expect(empty.currentContextTokens).toBe(0);
  expect(empty.currentContextHistoryTokens).toBe(0);
});
test('genuinely large conversation remains distinguishable from large system instructions', () => {
  const value = currentContextOf({ head: undefined, messages: [
    { role: 'user', content: 'history '.repeat(60_000), timestamp: 1 }, assistant(150_000, 2),
    { role: 'user', content: 'continue', timestamp: 3 },
  ] });
  expect(value.currentContextTokens).toBeGreaterThan(100_000);
  expect(value.currentContextHistoryTokens).toBeGreaterThan(100_000);
});

test('even a huge first input or first tool run is not older conversation history', () => {
  const first = { role: 'user' as const, content: 'large request '.repeat(40_000), timestamp: 1 };
  expect(currentContextOf({ head: undefined, messages: [first] }).currentContextHistoryTokens).toBe(0);
  expect(currentContextOf({ head: undefined, messages: [first, assistant(160_000, 2)] }).currentContextHistoryTokens).toBe(0);
});
