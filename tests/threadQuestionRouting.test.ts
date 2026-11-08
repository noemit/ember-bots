import { expect, test } from 'bun:test';
import { piReplyQuestion, piRejectQuestion } from '../src/piApi';
import type { QuestionRequest } from '../src/types';

test('thread answers and cancellations retain the origin host and worker question identity', async () => {
  const previous = (globalThis as { window?: unknown }).window;
  const calls: Array<{ instanceId: string; path: string; init: unknown }> = [];
  (globalThis as { window?: unknown }).window = { ember: {
    piRequest: async (instanceId: string, path: string, init: unknown) => {
      calls.push({ instanceId, path, init });
      return { ok: true, status: 200, data: {} };
    },
  } };
  try {
    const request: QuestionRequest = {
      id: '18:ask-1', instanceId: 'pi:first', sessionId: '18', directory: '/worker-folder',
      questions: [{ question: 'Proceed?', options: [] }],
    };
    await piReplyQuestion(request.instanceId, request, [['Yes']]);
    const other = { ...request, instanceId: 'pi:second' };
    await piRejectQuestion(other.instanceId, other);
    expect(calls).toEqual([
      { instanceId: 'pi:first', path: '/questions/18/ask-1/reply', init: { method: 'POST', body: { answer: 'Yes' } } },
      { instanceId: 'pi:second', path: '/questions/18/ask-1/reply', init: { method: 'POST', body: { answer: null } } },
    ]);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});
