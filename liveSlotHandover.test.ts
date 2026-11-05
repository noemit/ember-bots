/**
 * The live slot and the entry that supersedes it are one message, and they must never both be drawn.
 *
 * Reachable on every step of a turn: a generation streams into the `pi-live` slot (createdAt T),
 * Hearth commits its `pi.assistant` entry (createdAt T -- the same provider message, because pi-ai
 * stamps `timestamp` when the request *starts*) and clears `pi.live.generation` in one commit, and a
 * `since` read lands before the successor generation has committed its first partial. That read
 * carries the entry and no live, so `survivingLive` used to test `T >= T` and keep the slot: the
 * answer drawn twice, for as long as it took any later read to replace the slot. Measured on two
 * busy conversations, that was 14 episodes in 170 s, each 1.4-3.5 s, and longer where a slow tool sat
 * between the entry and the next generation.
 *
 * Shapes are real (conversation 32786, entry e44051 and its predecessors); the partial is that entry
 * truncated, which is what Hearth stores in `pi.live.generation.message`.
 */
import { describe, expect, test } from 'bun:test';
import { piEntriesToMessages, type PiEntry, type PiMessage } from './src/lib/piMapping';
import {
  reconcileTranscriptAppend,
  reconcileTranscriptTail,
} from './src/lib/transcriptReconciliation';
import { applyLiveDeltas } from './src/lib/liveStream';
import type { ChatMessage } from './src/types';

const T = 1_793_288_396_566; // real: the pi-ai request-start stamp shared by slot and entry
const reasoning = 'Confirmed: withdrawQueuedInputs — abort settles the queued items, so the row leaves.';

const userEntry: PiEntry = {
  id: 30,
  kind: 'pi.user',
  model: [{ role: 'user', content: 'what is left?', timestamp: T - 9_000 }],
};
const assistantEntry: PiEntry = {
  id: 51,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Told the worker the repro is gone, and filed it.' }],
      provider: 'deepseek',
      model: 'deepseek-flash',
      stopReason: 'stop',
      timestamp: T,
      durationMs: 4_100,
    },
  ],
};
const assistantToolEntry: PiEntry = {
  id: 52,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: reasoning },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
      ],
      provider: 'deepseek',
      model: 'deepseek-flash',
      stopReason: 'toolUse',
      timestamp: T,
      durationMs: 1_200,
    },
  ],
};

/** `pi.live.generation.message` while that generation is in flight: the same message, truncated. */
const liveFor = (entry: PiEntry) => {
  const message = (entry.model ?? [])[0] as PiMessage;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const content = blocks.map((block) =>
    block.type === 'text'
      ? { ...block, text: (block.text ?? '').slice(0, 8) }
      : block.type === 'thinking'
        ? { ...block, thinking: (block.thinking ?? '').slice(0, 12) }
        : block
  );
  return { run: { inputs: [1] }, generation: { attempt: 1, message: { ...message, content, stopReason: 'pending' } } };
};

/** The streamed remainder, as `LiveDelta`s the transport hands the renderer. */
const deltasFor = (entry: PiEntry) => {
  const message = (entry.model ?? [])[0] as PiMessage;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.flatMap((block, index) =>
    block.type === 'text'
      ? [{ index, kind: 'text' as const, text: (block.text ?? '').slice(8) }]
      : block.type === 'thinking'
        ? [{ index, kind: 'thinking' as const, text: (block.thinking ?? '').slice(12) }]
        : []
  );
};

const sameAnswer = (messages: readonly ChatMessage[]): string[] => {
  const byAnswer = new Map<string, string[]>();
  for (const message of messages) {
    const key = message.text.trim()
      ? `text:${message.text.trim()}`
      : `reasoning:${message.parts.flatMap((p) => (p.type === 'reasoning' ? [p.text.trim()] : [])).join('\n')}`;
    if (key === 'reasoning:') continue;
    byAnswer.set(key, [...(byAnswer.get(key) ?? []), message.id]);
  }
  return [...byAnswer.values()].filter((who) => who.length > 1).map((who) => who.join(' + '));
};

/** The transcript as it stands while the generation streams: settled turns + the live slot. */
const streaming = (entry: PiEntry): ChatMessage[] => {
  const seeded = piEntriesToMessages([userEntry], liveFor(entry));
  return applyLiveDeltas(seeded, deltasFor(entry)) ?? seeded;
};

describe('the live slot and the entry that supersedes it', () => {
  test('a since read carrying the entry must retire the slot', () => {
    const held = streaming(assistantEntry);
    expect(held.map((m) => m.id)).toEqual(['e30', 'pi-live']); // one answer on screen while streaming
    // Hearth committed the entry and cleared pi.live.generation; this read carries only the entry.
    const result = reconcileTranscriptAppend(held, piEntriesToMessages([assistantEntry], undefined), new Set());
    expect(result.messages.map((m) => m.id)).toEqual(['e30', 'e51']);
    expect(sameAnswer(result.messages)).toEqual([]);
  });

  test('a tail read carrying the entry must retire the slot', () => {
    const held = streaming(assistantEntry);
    const result = reconcileTranscriptTail(held, piEntriesToMessages([userEntry, assistantEntry], undefined), new Set());
    expect(result.messages.map((m) => m.id)).toEqual(['e30', 'e51']);
    expect(sameAnswer(result.messages)).toEqual([]);
  });

  test('an idle since read must not keep the superseded slot', () => {
    const held = streaming(assistantEntry);
    const entryLanded = reconcileTranscriptAppend(held, piEntriesToMessages([assistantEntry], undefined), new Set()).messages;
    // Nothing new since the newest entry; the next poll carries the entry in its base and no live.
    const next = reconcileTranscriptAppend(entryLanded, piEntriesToMessages([], undefined), new Set());
    expect(sameAnswer(next.messages)).toEqual([]);
  });

  test('a successor generation delta folded into the stale slot must not be drawn beside the entry', () => {
    const held = streaming(assistantEntry);
    const entryLanded = reconcileTranscriptAppend(held, piEntriesToMessages([assistantEntry], undefined), new Set()).messages;
    // `pi:message_update` for the *next* generation: `applyLiveDeltas` finds the stale slot by id.
    const grown = applyLiveDeltas(entryLanded, [{ index: 0, kind: 'text', text: ' Next: reading the diff.' }]);
    // With no slot left there is nothing to fold a successor's deltas into (`null` is the caller's
    // cue to take the REST path, which is how the new generation's first chunk gets drawn).
    expect((grown ?? entryLanded).filter((m) => m.live === true)).toEqual([]);
  });

  test('a tool-use step: the reasoning block must not be drawn twice', () => {
    const held = streaming(assistantToolEntry);
    const result = reconcileTranscriptAppend(held, piEntriesToMessages([assistantToolEntry], undefined), new Set());
    expect(result.messages.map((m) => m.id)).toEqual(['e30', 'e52']);
    expect(sameAnswer(result.messages)).toEqual([]);
  });

  test('control: an entry stamped even 1 ms after the slot retires it (why the suite is green today)', () => {
    const held = streaming(assistantEntry);
    const later: PiEntry = {
      ...assistantEntry,
      model: [{ ...((assistantEntry.model ?? [])[0] as PiMessage), timestamp: T + 1 }],
    };
    const result = reconcileTranscriptAppend(held, piEntriesToMessages([later], undefined), new Set());
    expect(result.messages.map((m) => m.id)).toEqual(['e30', 'e51']);
  });
});
