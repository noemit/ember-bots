import { describe, expect, test } from 'bun:test';
import { applyLiveDeltas } from './src/lib/liveStream';
import type { ChatMessage, MessagePart } from './src/types';

/**
 * Applying a streamed chunk is the one place the renderer writes to a transcript from the wire rather
 * than from a read, so the rules it must obey are narrow: only appends, only into the live message,
 * and `null` (meaning "ask REST") whenever the shape is not exactly what it expected.
 */
const live = (parts: MessagePart[], text = ''): ChatMessage => ({
  id: 'pi-live',
  role: 'assistant',
  text,
  parts,
  completed: false,
  live: true,
  createdAt: 1_000,
});

const settled: ChatMessage = {
  id: 'e1',
  role: 'user',
  text: 'why?',
  parts: [{ type: 'text', id: 'e1-0', text: 'why?' }],
  completed: true,
};

describe('applying streamed appends', () => {
  test('writes into the live message and recomputes its text, leaving the rest identical', () => {
    const held = [settled, live([{ type: 'text', id: 'pi-live-0', text: 'Hello' }], 'Hello')];
    const next = applyLiveDeltas(held, [
      { index: 0, kind: 'text', text: ' wor' },
      { index: 0, kind: 'text', text: 'ld' },
    ]);
    expect(next).not.toBeNull();
    expect(next?.[1]).not.toBe(held[1]);
    expect(next?.[1].text).toBe('Hello world');
    expect(next?.[1].parts).toEqual([{ type: 'text', id: 'pi-live-0', text: 'Hello world' }]);
    // The settled message is reused, not copied, so its row does not re-render.
    expect(next?.[0]).toBe(settled);
  });

  test('opens a reasoning part for a block that has not appeared yet', () => {
    const held = [live([{ type: 'text', id: 'pi-live-0', text: 'Answer' }], 'Answer')];
    const next = applyLiveDeltas(held, [{ index: 1, kind: 'thinking', text: 'weighing' }]);
    expect(next?.[0].parts).toEqual([
      { type: 'text', id: 'pi-live-0', text: 'Answer' },
      { type: 'reasoning', id: 'pi-live-1', text: 'weighing' },
    ]);
    // Reasoning is not part of the message text, matching how a read builds it.
    expect(next?.[0].text).toBe('Answer');
  });

  test('keeps parts in content-block order when a later block streams first', () => {
    const held = [live([{ type: 'reasoning', id: 'pi-live-1', text: 'think' }])];
    const next = applyLiveDeltas(held, [{ index: 0, kind: 'text', text: 'said' }]);
    expect(next?.[0].parts.map((part) => part.id)).toEqual(['pi-live-0', 'pi-live-1']);
    expect(next?.[0].text).toBe('said');
  });

  test('nothing to append leaves the array identity alone', () => {
    const held = [live([{ type: 'text', id: 'pi-live-0', text: 'x' }], 'x')];
    expect(applyLiveDeltas(held, [])).toBe(held);
    // A zero-length delta is not a change.
    expect(applyLiveDeltas(held, [{ index: 0, kind: 'text', text: '' }])).toBe(held);
  });

  test('no live message, or a block that changed shape, means ask REST', () => {
    const noLive = [settled];
    expect(applyLiveDeltas(noLive, [{ index: 0, kind: 'text', text: 'x' }])).toBeNull();
    // A thinking delta arriving on a text block is a shape change, not an append.
    const mismatched = [live([{ type: 'text', id: 'pi-live-0', text: 'x' }], 'x')];
    expect(applyLiveDeltas(mismatched, [{ index: 0, kind: 'thinking', text: 'y' }])).toBeNull();
  });
});
