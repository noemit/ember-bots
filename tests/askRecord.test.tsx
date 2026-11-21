import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import AskRecord from '../src/components/AskRecord';
import type { ToolCall } from '../src/types';

const question = 'Which version should we ship?';
const input = { question, options: ['Stable', 'Preview'] };
const receipt = '{"id":"182818","key":"182818","conversationId":"177961","revision":1,"created":true}';
const render = (fields: Partial<ToolCall>) => renderToStaticMarkup(
  <AskRecord call={{ id: 'ask-1', tool: 'ask', status: 'completed', input, ...fields }} />
);

test('create receipt shows the question and where to answer, not receipt metadata or a decision', () => {
  const html = render({ input: { ...input, action: 'create' }, output: receipt });
  for (const text of [question, 'Questions']) expect(html).toContain(text);
  expect(html).not.toMatch(/182818|conversationId|created|Stable|Preview|You answered:/);
});

test('failed creates keep their diagnostic rather than suggesting the question was delivered', () => {
  const diagnostic = 'Could not create question: superseded question was dismissed';
  const html = render({ input: { ...input, action: 'create' }, status: 'error', error: diagnostic });
  expect(html).toContain(diagnostic);
  expect(html).not.toContain('Open Questions');
});

test('blocking asks keep the pending, answer, dismissal, and interruption paths', () => {
  expect(render({})).toBe('');
  const html = render({ output: 'The user answered: Stable' });
  expect(html).toMatch(/You answered:.*Stable/s);
  expect(render({ status: 'error', output: 'The user dismissed this question.' })).toContain('You dismissed');
  expect(render({ status: 'interrupted', error: 'Stopped' })).toContain('was interrupted');
});
