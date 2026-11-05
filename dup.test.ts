import { describe, expect, test } from 'bun:test';
import { piEntriesToMessages } from './src/lib/piMapping';

/**
 * The duplication report: during a turn the latest message sometimes appears twice.
 *
 * `liveGenerationMessage` guards against showing the live slot a second time, but its guard only
 * compares **text** (`last.text === text && text !== ''`). While the model is still reasoning, the
 * live message has reasoning parts and no text, so the guard cannot fire and the same generation is
 * drawn twice: once as the settled entry, once as the live slot.
 */
const liveWith = (thinking: string, text = '') => ({
  run: { taskId: 1, inputs: [1] },
  generation: {
    attempt: 1,
    message: {
      role: 'assistant',
      content: [
        ...(thinking ? [{ type: 'thinking', thinking, thinkingSignature: 'reasoning_content' }] : []),
        ...(text ? [{ type: 'text', text }] : []),
      ],
      provider: 'moonshotai',
      model: 'kimi-k3',
      timestamp: 1792857422931,
      stopReason: 'pending',
    },
  },
});

const settledOnlyThinking = [
  {
    id: 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Weighing the options', thinkingSignature: 'reasoning_content' }],
        provider: 'moonshotai',
        model: 'kimi-k3',
        stopReason: 'error',
        timestamp: 1792857422000,
      },
    ],
  },
];

const settledWithText = [
  {
    id: 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Weighing the options', thinkingSignature: 'reasoning_content' },
          { type: 'text', text: 'Because.' },
        ],
        provider: 'moonshotai',
        model: 'kimi-k3',
        stopReason: 'stop',
        timestamp: 1792857422000,
      },
    ],
  },
];

describe('the live slot is not drawn on top of the message it duplicates', () => {
  test('text present: the guard fires and only the settled entry shows', () => {
    const messages = piEntriesToMessages(settledWithText as never, liveWith('Weighing the options', 'Because.') as never);
    expect(messages).toHaveLength(1);
    expect(messages[0].live).toBeUndefined();
  });

  test('reasoning only: the same generation must not appear twice', () => {
    const messages = piEntriesToMessages(
      settledOnlyThinking as never,
      liveWith('Weighing the options') as never
    );
    // The bug: two assistant messages carrying the same reasoning.
    const reasoningBlocks = messages.filter((m) => m.parts.some((p) => p.type === 'reasoning'));
    expect(reasoningBlocks).toHaveLength(1);
  });

  test('genuinely new reasoning still shows while it streams', () => {
    const messages = piEntriesToMessages(
      settledOnlyThinking as never,
      // The model kept thinking past what the settled entry holds: this is new content.
      liveWith('Weighing the options, and then some further thought about the second order effect') as never
    );
    expect(messages).toHaveLength(2);
    expect(messages[1].live).toBe(true);
  });

  test('an in-flight turn with no settled entry at all still shows', () => {
    const messages = piEntriesToMessages([], liveWith('Just started reasoning') as never);
    expect(messages).toHaveLength(1);
    expect(messages[0].live).toBe(true);
  });
});
