import { describe, expect, test } from 'bun:test';
import {
  equalMessage,
  reconcileFullTranscript,
  reconcileTranscriptAppend,
  reconcileTranscriptTail,
  shareMessageReferences,
} from './src/lib/transcriptReconciliation';
import type { ChatMessage, MessagePart } from './src/types';

const textPart = (id: string, text: string): MessagePart => ({ type: 'text', id, text });

const user = (id: string, text: string): ChatMessage => ({
  id,
  role: 'user',
  text,
  parts: [textPart(`${id}-text`, text)],
  completed: true,
});

const assistant = (id: string, text: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  parts: [textPart(`${id}-text`, text)],
  completed: true,
  ...overrides,
});

const ids = (messages: readonly ChatMessage[]): string[] => messages.map((message) => message.id);

describe('message equality and structural sharing', () => {
  test('identical content is equal and reuses the previous array', () => {
    const previous = [user('u1', 'hi'), assistant('a1', 'yo')];
    expect(equalMessage(previous[1], assistant('a1', 'yo'))).toBe(true);
    expect(shareMessageReferences(previous, [user('u1', 'hi'), assistant('a1', 'yo')])).toBe(previous);
  });

  test('replaces a message when any rendered field changes', () => {
    const expectReplaced = (before: ChatMessage, after: ChatMessage) => {
      const result = reconcileFullTranscript([before], [after], new Set());
      expect(result.messages[0]).toBe(after);
    };

    const base = assistant('a1', 'hello', {
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    expectReplaced(base, { ...base, tokens: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 } });
    expectReplaced(base, { ...base, aborted: true, error: 'Stopped' });
    expectReplaced(base, { ...base, model: { providerID: 'p', modelID: 'm', variant: 'high' } });
    expectReplaced(base, { ...base, parts: [textPart('a1-other', 'hello')] });
    expectReplaced(base, { ...base, parts: [{ type: 'reasoning', id: 'a1-text', text: 'hello' }] });

    const toolBase: ChatMessage = {
      ...assistant('a1', ''),
      parts: [{ type: 'tool', id: 'a1-tool', call: { id: 'c1', tool: 'bash', status: 'running' } }],
    };
    expectReplaced(toolBase, {
      ...toolBase,
      parts: [
        { type: 'tool', id: 'a1-tool', call: { id: 'c1', tool: 'bash', status: 'running', title: 'ls' } },
      ],
    });
    expectReplaced(toolBase, {
      ...toolBase,
      parts: [
        {
          type: 'tool',
          id: 'a1-tool',
          call: { id: 'c1', tool: 'bash', status: 'completed', output: 'done' },
        },
      ],
    });

    const fileBase: ChatMessage = {
      ...assistant('a1', ''),
      parts: [{ type: 'file', id: 'a1-file', file: { filename: 'a.txt', mime: 'text/plain', url: 'data:one' } }],
    };
    expectReplaced(fileBase, {
      ...fileBase,
      parts: [{ type: 'file', id: 'a1-file', file: { filename: 'a.txt', mime: 'text/plain', url: 'data:two' } }],
    });
    expectReplaced(fileBase, {
      ...fileBase,
      parts: [{ type: 'file', id: 'a1-file', file: { filename: 'b.txt', mime: 'text/plain', url: 'data:one' } }],
    });
    expectReplaced(fileBase, {
      ...fileBase,
      parts: [{ type: 'file', id: 'a1-file', file: { filename: 'a.txt', mime: 'image/png', url: 'data:one' } }],
    });
  });

  test('a cyclic tool input does not throw', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const tool: ChatMessage = {
      ...assistant('a1', ''),
      parts: [{ type: 'tool', id: 'a1-tool', call: { id: 'c1', tool: 'bash', status: 'running', input: cyclic } }],
    };
    expect(() => equalMessage(tool, { ...tool })).not.toThrow();
    expect(() =>
      reconcileFullTranscript([tool], [{ ...tool, completedAt: 5 }], new Set())
    ).not.toThrow();
  });
});

describe('full reconciliation', () => {
  test('updating only the last message preserves every earlier object', () => {
    const previous = [user('u1', 'hi'), assistant('a1', 'start')];
    const updated = assistant('a1', 'start more');
    const result = reconcileFullTranscript(previous, [user('u1', 'hi'), updated], new Set());
    expect(result.messages).not.toBe(previous);
    expect(result.messages[0]).toBe(previous[0]);
    expect(result.messages[1]).toBe(updated);
  });

  test('append preserves existing objects', () => {
    const previous = [user('u1', 'hi')];
    const appended = assistant('a1', 'new');
    const result = reconcileFullTranscript(previous, [user('u1', 'hi'), appended], new Set());
    expect(result.messages[0]).toBe(previous[0]);
    expect(result.messages[1]).toBe(appended);
  });

  test('removal and reorder follow the authoritative response', () => {
    const a = user('a', 'A');
    const b = user('b', 'B');
    expect(ids(reconcileFullTranscript([a, b], [b], new Set()).messages)).toEqual(['b']);
    expect(ids(reconcileFullTranscript([a, b], [b, a], new Set()).messages)).toEqual(['b', 'a']);
  });

  test('matches a direct optimistic id and reports it for release', () => {
    const optimistic = user('msg_opt', 'Hello');
    const current = [user('u1', 'Earlier'), optimistic];
    const fetched = [user('u1', 'Earlier'), user('msg_opt', 'Hello')];
    const result = reconcileFullTranscript(current, fetched, new Set([optimistic.id]));
    expect(result.reconciledOptimisticIds).toEqual(['msg_opt']);
    expect(ids(result.messages)).toEqual(['u1', 'msg_opt']);
  });

  test('a new legacy server id matches the optimistic turn, not an older identical one', () => {
    const previous = user('u1', 'Hello');
    const optimistic = user('msg_opt', 'Hello');
    const server = user('msg_server', 'Hello');
    const pending = new Set([optimistic.id]);

    const notYetIndexed = reconcileFullTranscript([previous, optimistic], [previous], pending);
    expect(ids(notYetIndexed.messages)).toEqual(['u1', 'msg_opt']);
    expect(notYetIndexed.reconciledOptimisticIds).toEqual([]);

    const indexed = reconcileFullTranscript([previous, optimistic], [previous, server], pending);
    expect(ids(indexed.messages)).toEqual(['u1', 'msg_server']);
    expect(indexed.reconciledOptimisticIds).toEqual(['msg_opt']);
  });

  test('two transcripts reconcile independently', () => {
    const a = [user('a1', 'a')];
    const b = [user('b1', 'b')];
    const ra = reconcileFullTranscript(a, [user('a1', 'a')], new Set());
    const rb = reconcileFullTranscript(b, [user('b1', 'b changed')], new Set());
    expect(ra.messages).toBe(a);
    expect(rb.messages[0].text).toBe('b changed');
    expect(b[0].text).toBe('b');
  });
});

describe('tail reconciliation', () => {
  test('preserves the prefix and replaces the suffix from the earliest overlap', () => {
    const current = [user('u1', 'u1'), assistant('a1', 'a1'), user('u2', 'u2'), assistant('a2', 'a2')];
    const tail = [user('u2', 'u2'), assistant('a2', 'a2 changed')];
    const result = reconcileTranscriptTail(current, tail, new Set());
    expect(result.needsFullFetch).toBe(false);
    expect(ids(result.messages)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(result.messages[0]).toBe(current[0]);
    expect(result.messages[1]).toBe(current[1]);
    expect(result.messages[3].text).toBe('a2 changed');
  });

  test('keeps an optimistic turn the tail has not indexed yet', () => {
    const optimistic = user('msg_opt', 'next');
    const current = [user('u1', 'one'), assistant('a1', 'two'), optimistic];
    const tail = [user('u1', 'one'), assistant('a1', 'two')];
    const result = reconcileTranscriptTail(current, tail, new Set([optimistic.id]));
    expect(result.needsFullFetch).toBe(false);
    expect(ids(result.messages)).toEqual(['u1', 'a1', 'msg_opt']);
    expect(result.reconciledOptimisticIds).toEqual([]);
  });

  test('a tail with no overlap asks for a full repair and keeps the current transcript', () => {
    // `x1`/`z1` are not Hearth ordinals: a wire this module cannot sequence is the cautious case, and
    // it still asks for the full read.
    const current = [user('x1', 'x'), user('x2', 'y')];
    const result = reconcileTranscriptTail(current, [assistant('z1', 'brand new')], new Set());
    expect(result.needsFullFetch).toBe(true);
    expect(result.messages).toBe(current);
  });

  test('a tail entirely newer than everything held is appended, not repaired', () => {
    // The turn outgrew the window Ember held — a long run, a poll that was turned away, a quiet
    // session that woke up. The old answer asked for the whole conversation in one response, which a
    // long session cannot deliver (32 MB response cap), so it retried for ever.
    const current = [user('e10', 'one'), assistant('e11', 'two')];
    const tail = [user('e20', 'later'), assistant('e21', 'and later')];
    const result = reconcileTranscriptTail(current, tail, new Set());
    expect(result.needsFullFetch).toBe(false);
    expect(ids(result.messages)).toEqual(['e10', 'e11', 'e20', 'e21']);
    expect(result.messages[0]).toBe(current[0]);
  });

  test('a tail that came first and reused older ids is still a rewrite', () => {
    // The hostile shape: a coalesced turn whose ids sit *below* the newest held one. Gluing it on
    // would interleave two histories.
    const current = [user('e40', 'one'), assistant('e41', 'two')];
    const result = reconcileTranscriptTail(current, [user('e2', 'a'), assistant('e3', 'b')], new Set());
    expect(result.needsFullFetch).toBe(true);
    expect(result.messages).toBe(current);
  });

  test('a tail that straddles the window still overlaps and needs no repair', () => {
    const current = [user('e10', 'one'), assistant('e11', 'two')];
    const tail = [assistant('e11', 'two, edited'), user('e12', 'three')];
    const result = reconcileTranscriptTail(current, tail, new Set());
    expect(result.needsFullFetch).toBe(false);
    expect(ids(result.messages)).toEqual(['e10', 'e11', 'e12']);
    expect(result.messages[1].text).toBe('two, edited');
  });

  test('an empty tail with a non-empty transcript asks for a full repair', () => {
    const current = [user('x1', 'x')];
    const result = reconcileTranscriptTail(current, [], new Set());
    expect(result.needsFullFetch).toBe(true);
    expect(result.messages).toBe(current);
  });

  test('an empty current transcript adopts the tail', () => {
    const tail = [user('u1', 'one'), assistant('a1', 'two')];
    const result = reconcileTranscriptTail([], tail, new Set());
    expect(result.needsFullFetch).toBe(false);
    expect(result.messages).toBe(tail);
  });
});

describe('steer ordering', () => {
  test('a placed steer lands at the server boundary, after the tool call', () => {
    const optimistic = user('msg_opt', 'make it 512x256');
    const current = [assistant('a1', 'calling bash'), optimistic];
    const serverSteer = user('srv_steer', 'make it 512x256');
    const result = reconcileFullTranscript(
      current,
      [assistant('a1', 'calling bash'), serverSteer],
      new Set([optimistic.id])
    );
    // The optimistic turn is dropped; the server copy renders at its boundary position.
    expect(ids(result.messages)).toEqual(['a1', 'srv_steer']);
    expect(result.reconciledOptimisticIds).toEqual(['msg_opt']);
  });

  test('a steer the server has not placed yet stays after the tool call, not at the top', () => {
    const optimistic = user('msg_opt', 'steer');
    const current = [assistant('a1', 'calling bash'), optimistic];
    const result = reconcileTranscriptTail(current, [assistant('a1', 'calling bash')], new Set([optimistic.id]));
    expect(ids(result.messages)).toEqual(['a1', 'msg_opt']);
  });
});

describe('the in-flight generation across a bounded tail read', () => {
  // The tail asks for Hearth's documents (`docs=1`), so it carries `pi.live` and reasoning streams
  // as it is written. A tail without one (an older Hearth, a background read) keeps the held
  // message rather than blanking it.
  const live = (createdAt: number, text: string): ChatMessage => ({
    id: 'pi-live',
    role: 'assistant',
    text,
    parts: [{ type: 'reasoning', id: 'pi-live-0', text }],
    completed: false,
    live: true,
    createdAt,
  });

  test('a tail read keeps the streaming reasoning until its settled message lands', () => {
    const question = user('e1', 'why?');
    const streaming = live(2_000, 'Weighing the options');
    const tail = [question];
    const first = reconcileTranscriptTail([question, streaming], tail, new Set());
    expect(ids(first.messages)).toEqual(['e1', 'pi-live']);
    expect(first.messages[1]).toBe(streaming);
    expect(first.needsFullFetch).toBe(false);
  });

  test('a newer settled message supersedes it', () => {
    const question = user('e1', 'why?');
    const streaming = live(2_000, 'Weighing the options');
    const settled = assistant('e2', 'Because.', { createdAt: 3_000 });
    const result = reconcileTranscriptTail([question, streaming], [question, settled], new Set());
    expect(ids(result.messages)).toEqual(['e1', 'e2']);
  });

  test('a full read that carries the settled entry retires the slot and shows the entry', () => {
    const question = user('e1', 'why?');
    const streaming = live(2_000, 'Weighing the options');
    const settled = assistant('e2', 'Because.', { createdAt: 3_000 });
    const result = reconcileFullTranscript([question, streaming], [question, settled], new Set());
    expect(ids(result.messages)).toEqual(['e1', 'e2']);
    expect(result.messages[1]).toBe(settled);
  });

  test('a full repair during a streaming turn keeps the live slot rather than blanking it', () => {
    // A compaction ending, a reconnect catch-up or a switch-in repair lands mid-turn, and a paged
    // walk carries only committed entries: it has no idea about the generation being written.
    const question = user('e1', 'why?');
    const streaming = live(4_000, 'Weighing the options');
    const result = reconcileFullTranscript([question, streaming], [question], new Set());
    expect(ids(result.messages)).toEqual(['e1', 'pi-live']);
    expect(result.messages[1]).toBe(streaming);
  });

  test('a full repair carrying the live slot uses the fetched one, not the held copy', () => {
    const question = user('e1', 'why?');
    const earlier = live(4_000, 'Weighing');
    const later = live(4_000, 'Weighing the options carefully');
    const result = reconcileFullTranscript([question, earlier], [question, later], new Set());
    expect(ids(result.messages)).toEqual(['e1', 'pi-live']);
    expect(result.messages[1]).toBe(later);
  });

  test('a full repair carrying the entry the slot previewed does not keep both', () => {
    // Same generation, same stamp: the slot and its committed entry are one message.
    const question = user('e1', 'why?');
    const streaming = live(2_000, 'Weighing the options');
    const settled = assistant('e2', 'Weighing the options', { createdAt: 2_000 });
    const result = reconcileFullTranscript([question, streaming], [question, settled], new Set());
    expect(ids(result.messages)).toEqual(['e1', 'e2']);
  });

  test('a tail that carries the live message streams the newer reasoning in place', () => {
    const question = user('e1', 'why?');
    const earlier = live(2_000, 'Weighing');
    const later = live(2_000, 'Weighing the options carefully');
    const result = reconcileTranscriptTail([question, earlier], [question, later], new Set());
    // Replaced, not appended: one live bubble whose text grows as the turn streams.
    expect(ids(result.messages)).toEqual(['e1', 'pi-live']);
    expect(result.messages[1]).toBe(later);
    expect(result.needsFullFetch).toBe(false);
  });

  test('a live message arriving on a tail read survives its settled entry later', () => {
    const question = user('e1', 'why?');
    const streaming = live(2_000, 'Weighing the options');
    const settled = assistant('e2', 'Because.', { createdAt: 3_000 });
    // While streaming the tail carries the live slot…
    const during = reconcileTranscriptTail([question, streaming], [question, streaming], new Set());
    expect(ids(during.messages)).toEqual(['e1', 'pi-live']);
    // …and once the entry lands the live slot is gone from the tail, so it is not left behind.
    const after = reconcileTranscriptTail(during.messages, [question, settled], new Set());
    expect(ids(after.messages)).toEqual(['e1', 'e2']);
  });
});

describe('an incremental (since) read', () => {
  const liveMessage = (text: string): ChatMessage => ({
    id: 'pi-live',
    role: 'assistant',
    text,
    parts: [textPart('pi-live-0', text)],
    completed: false,
    live: true,
  });

  test('appends only what is new, in order, and never twice', () => {
    const held = [user('e1', 'hi'), assistant('e2', 'hello')];
    // A server that repeats an id the client holds must not produce a second copy of it.
    const fetched = [assistant('e2', 'hello'), assistant('e3', 'more')];
    const result = reconcileTranscriptAppend(held, fetched, new Set());
    expect(ids(result.messages)).toEqual(['e1', 'e2', 'e3']);
    expect(result.needsFullFetch).toBe(false);
  });

  test('an overlapping window is idempotent, which is what an older host sends', () => {
    // A Hearth without `since` ignores it and answers with the newest entries again. Correctness must
    // not depend on the server having the feature: the ids already held are replaced in place, so the
    // transcript neither duplicates nor reorders.
    const held = [user('e1', 'a'), user('e2', 'b'), user('e3', 'c'), user('e4', 'd'), user('e5', 'e')];
    const fetched = [user('e3', 'c'), user('e4', 'd'), user('e5', 'e')];
    expect(ids(reconcileTranscriptAppend(held, fetched, new Set()).messages)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    // The whole window, still no change.
    expect(reconcileTranscriptAppend(held, held, new Set()).messages).toBe(held);
  });

  test('nothing new keeps the array identity, so nothing re-renders', () => {
    const held = [user('e1', 'hi'), assistant('e2', 'hello')];
    expect(reconcileTranscriptAppend(held, [], new Set()).messages).toBe(held);
  });

  test('a server copy of a pending send replaces it instead of sitting beside it', () => {
    const optimistic = user('client-1', 'sent twice?');
    const result = reconcileTranscriptAppend([optimistic], [user('client-1', 'sent twice?')], new Set(['client-1']));
    expect(ids(result.messages)).toEqual(['client-1']);
    expect(result.reconciledOptimisticIds).toEqual(['client-1']);
  });

  test('a pending send the server has not indexed yet stays at the end', () => {
    const optimistic = user('client-1', 'waiting');
    const held = [user('e1', 'hi'), optimistic];
    const result = reconcileTranscriptAppend(held, [assistant('e2', 'answer')], new Set([optimistic.id]));
    expect(ids(result.messages)).toEqual(['e1', 'e2', 'client-1']);
    expect(result.messages[2]).toBe(optimistic);
  });

  test('an append carrying the settled entry drops the live slot it supersedes', () => {
    // The generation was streaming into the live slot; this read brought its entry and no live.
    // Keeping both renders the same answer twice — the duplicate a reader sees, followed by the live
    // slot vanishing on the next read.
    const held = [user('e1', 'why?'), liveMessage('the answer, streamed')];
    const settledEntry = assistant('e2', 'the answer, streamed', { createdAt: 3_000 });
    expect(ids(reconcileTranscriptAppend(held, [settledEntry], new Set()).messages)).toEqual(['e1', 'e2']);
  });

  test('an append with no live keeps a slot that is still the newest thing', () => {
    // No settled entry for it yet: dropping the slot here would blank text the reader is watching.
    const held = [user('e1', 'why?'), liveMessage('still coming')];
    const result = reconcileTranscriptAppend(held, [user('e5', 'another question')], new Set());
    expect(ids(result.messages)).toEqual(['e1', 'e5', 'pi-live']);
  });

  test('a delta with no live message keeps the held generation; one with it replaces it', () => {
    const held = [user('e1', 'hi'), liveMessage('streaming')];
    expect(reconcileTranscriptAppend(held, [], new Set()).messages).toBe(held);
    const replaced = reconcileTranscriptAppend(held, [liveMessage('streaming further')], new Set());
    expect(ids(replaced.messages)).toEqual(['e1', 'pi-live']);
    expect(replaced.messages[1]?.text).toBe('streaming further');
  });
});
