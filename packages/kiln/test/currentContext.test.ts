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
  expect(value).toEqual({ currentContextTokens: 2010, currentContextEpoch: 'initial' });
});
test('applied summary invalidates retained old assistant usage until a genuinely newer request answers', () => {
  const head = { id: 10 } as ContextView['head'];
  const summary = { role: 'user' as const, content: 'summary', timestamp: 30 };
  const compacted = currentContextOf({ head, messages: [summary, assistant(9000, 20)] });
  expect(compacted.currentContextTokens).toBeLessThan(9000);
  expect(compacted.currentContextEpoch).toBe('10');
  expect(currentContextOf({ head, messages: [summary, assistant(9000, 20), assistant(512, 40)] }).currentContextTokens).toBe(512);
});
