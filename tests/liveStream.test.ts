import { describe, expect, test } from 'bun:test';
import {
  applyLiveDeltas,
  isTerminalStreamEvent,
  StreamDeltaCoalescer,
} from '../src/lib/liveStream';
import type { ChatMessage, LiveDelta, MessagePart } from '../src/types';

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

describe('16ms rAF stream delta coalescing', () => {
  const makeHarness = () => {
    let nextHandle = 1;
    const frames = new Map<number, () => void>();
    const cancelled: number[] = [];
    const flushes: Array<{ instanceId: string; sessionId: string; deltas: LiveDelta[] }> = [];
    const coalescer = new StreamDeltaCoalescer(
      (instanceId, sessionId, deltas) => {
        flushes.push({ instanceId, sessionId, deltas });
      },
      (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      (handle) => {
        cancelled.push(handle);
        frames.delete(handle);
      }
    );
    const runNextFrame = () => {
      const first = frames.entries().next();
      if (first.done) return false;
      const [handle, callback] = first.value;
      frames.delete(handle);
      callback();
      return true;
    };
    return { coalescer, frames, cancelled, flushes, runNextFrame };
  };

  test('coalesces multiple pi:message_update chunks per (instanceId, sessionId) into one animation frame', () => {
    const { coalescer, frames, flushes, runNextFrame } = makeHarness();
    coalescer.push('pi:local', 's1', [{ index: 0, kind: 'text', text: 'Hel' }]);
    coalescer.push('pi:local', 's1', [{ index: 0, kind: 'text', text: 'lo ' }]);
    coalescer.push('pi:local', 's2', [{ index: 0, kind: 'thinking', text: 'plan' }]);
    coalescer.push('pi:local', 's1', [{ index: 0, kind: 'text', text: 'world' }]);

    // Only one animation frame is scheduled across all token arrivals in the 16ms window.
    expect(frames.size).toBe(1);
    expect(flushes).toHaveLength(0);

    expect(runNextFrame()).toBe(true);
    expect(frames.size).toBe(0);
    expect(flushes).toEqual([
      {
        instanceId: 'pi:local',
        sessionId: 's1',
        deltas: [
          { index: 0, kind: 'text', text: 'Hel' },
          { index: 0, kind: 'text', text: 'lo ' },
          { index: 0, kind: 'text', text: 'world' },
        ],
      },
      {
        instanceId: 'pi:local',
        sessionId: 's2',
        deltas: [{ index: 0, kind: 'thinking', text: 'plan' }],
      },
    ]);
  });

  test('flushes synchronously before terminal events and cancels redundant rAF handles', () => {
    expect(isTerminalStreamEvent('pi:message_end')).toBe(true);
    expect(isTerminalStreamEvent('pi:turn_end')).toBe(true);
    expect(isTerminalStreamEvent('pi:run_end')).toBe(true);
    expect(isTerminalStreamEvent('pi:message_update')).toBe(false);

    const { coalescer, frames, cancelled, flushes, runNextFrame } = makeHarness();
    coalescer.push('pi:local', 's1', [{ index: 0, kind: 'text', text: 'final ' }]);
    coalescer.push('pi:local', 's1', [{ index: 0, kind: 'text', text: 'words' }]);
    expect(frames.size).toBe(1);

    // Terminal event arrives before rAF fires: flushes synchronously and cancels the pending frame.
    coalescer.flushSession('pi:local', 's1');
    expect(flushes).toEqual([
      {
        instanceId: 'pi:local',
        sessionId: 's1',
        deltas: [
          { index: 0, kind: 'text', text: 'final ' },
          { index: 0, kind: 'text', text: 'words' },
        ],
      },
    ]);
    expect(frames.size).toBe(0);
    expect(cancelled).toEqual([1]);
    expect(runNextFrame()).toBe(false);
  });

  test('takeKey drains buffered deltas for a fetched transcript and flushAll drains on unmount', () => {
    const { coalescer, frames, cancelled, flushes } = makeHarness();
    coalescer.push('pi:local', 's1', [{ index: 0, kind: 'text', text: 'chunk-a' }]);
    coalescer.push('pi:local', 's2', [{ index: 0, kind: 'text', text: 'chunk-b' }]);

    const taken = coalescer.takeKey('pi:local::s1');
    expect(taken).toEqual([{ index: 0, kind: 'text', text: 'chunk-a' }]);
    expect(flushes).toHaveLength(0);
    expect(frames.size).toBe(1);

    // Unmount flushes remaining sessions synchronously and cancels the scheduled frame.
    coalescer.flushAll();
    expect(flushes).toEqual([
      {
        instanceId: 'pi:local',
        sessionId: 's2',
        deltas: [{ index: 0, kind: 'text', text: 'chunk-b' }],
      },
    ]);
    expect(frames.size).toBe(0);
    expect(cancelled).toEqual([1]);
  });
});
