import { describe, expect, test } from 'bun:test';
import { isTurnLive, outputSignature } from '../src/lib/turnActivity';
import type { ChatMessage, MessagePart, ToolCall } from '../src/types';

const assistant = (completed: boolean): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  text: '',
  parts: [],
  completed,
});
const user = (): ChatMessage => ({ id: 'u1', role: 'user', text: 'hi', parts: [], completed: true });

describe('isTurnLive', () => {
  test('an idle session with an aborted (incomplete) turn is not live', () => {
    // The aborted-turn bug: `stopReason: 'toolUse'` never becomes `completed`, but the server
    // says idle, so the activity line must stop.
    expect(isTurnLive({ sending: false, state: 'idle', last: assistant(false) })).toBe(false);
  });

  test('an active session is live regardless of the last message', () => {
    expect(isTurnLive({ sending: false, state: 'active', last: assistant(true) })).toBe(true);
  });

  test('an optimistic send is live before the server reports active', () => {
    expect(isTurnLive({ sending: true, state: 'idle', last: user() })).toBe(true);
  });

  test('an incomplete turn bridges a poll lag when the server is not idle', () => {
    expect(isTurnLive({ sending: false, state: 'needs-input', last: assistant(false) })).toBe(true);
  });

  test('a finished turn on an idle session is not live', () => {
    expect(isTurnLive({ sending: false, state: 'idle', last: assistant(true) })).toBe(false);
  });

  test('an empty transcript on an idle session is not live', () => {
    expect(isTurnLive({ sending: false, state: 'idle', last: undefined })).toBe(false);
  });

  test('an unanswered status is not live, even with an unfinished last turn', () => {
    // The composer reads this to decide queue-vs-send and the transcript reads it to decide whether
    // to say "thinking". An unknown status must do neither on a guess: an unfinished last message is
    // also what a stopped turn leaves behind.
    expect(isTurnLive({ sending: false, state: 'unknown', last: assistant(false) })).toBe(false);
    // Our own send in flight is direct evidence and still counts.
    expect(isTurnLive({ sending: true, state: 'unknown', last: user() })).toBe(true);
  });

  test('a generation the host is streaming is live even then, because it is observed', () => {
    const streaming = { ...assistant(false), live: true };
    expect(isTurnLive({ sending: false, state: 'unknown', last: streaming })).toBe(true);
    // A *settled* live slot under a known idle verdict stays out; that is the stale case.
    expect(isTurnLive({ sending: false, state: 'idle', last: streaming })).toBe(false);
  });
});

const streaming = (parts: MessagePart[], text = ''): ChatMessage => ({
  id: 'a2',
  role: 'assistant',
  text,
  parts,
  completed: false,
  live: true,
});

const tool = (call: Partial<ToolCall>): MessagePart => ({
  type: 'tool',
  id: 'p1',
  call: { id: 'c1', tool: 'bash', status: 'running', ...call },
});

/**
 * The transcript feeds this signature to the session status line as "when output last arrived". A
 * live turn whose signature does not move is reported as silent ("No new output for 5m, the run may
 * be stuck"), so every part that visibly streams has to move it — and nothing else may.
 */
describe('outputSignature', () => {
  test('a missing message is stable, and is not the caller\'s idle marker', () => {
    // The transcript passes `'idle'` itself when no turn is live (see isTurnLive); an empty live turn
    // must not reuse that string, or a run starting before its transcript loads would inherit the
    // previous run's silence instead of restarting the stopwatch.
    expect(outputSignature(undefined)).toBe('0/0');
    expect(outputSignature(undefined)).toBe(outputSignature(undefined));
    expect(outputSignature(undefined)).not.toBe('idle');
  });

  test('a fully settled message gives the same string every call', () => {
    const message = streaming([
      { type: 'text', id: 't1', text: 'done' },
      tool({ status: 'completed', output: 'ok', title: 'bun test' }),
      { type: 'file', id: 'f1', file: { filename: 'a.png', mime: 'image/png', url: 'data:x' } },
    ], 'done');
    // No new output ⇒ no reset of the stopwatch, so the string must be byte-identical.
    expect(outputSignature(message)).toBe(outputSignature({ ...message }));
    // …and a message that genuinely finished is not mistaken for an empty (or idle) one.
    expect(outputSignature(message)).not.toBe('0/0');
    expect(outputSignature(message)).not.toBe('idle');
  });

  test('growing reasoning changes the signature while the text length stays put', () => {
    // The bug: reasoning lives in ONE part whose own text grows, so `text.length` and
    // `parts.length` are both unchanged for as long as the model thinks.
    const before = streaming([{ type: 'reasoning', id: 'r1', text: 'Let me think' }]);
    const after = streaming([{ type: 'reasoning', id: 'r1', text: 'Let me think about it more' }]);
    expect(after.text.length).toBe(before.text.length);
    expect(after.parts.length).toBe(before.parts.length);
    expect(outputSignature(after)).not.toBe(outputSignature(before));
  });

  test('streaming text still changes it', () => {
    const before = streaming([{ type: 'text', id: 't1', text: 'Hel' }], 'Hel');
    const after = streaming([{ type: 'text', id: 't1', text: 'Hello' }], 'Hello');
    expect(outputSignature(after)).not.toBe(outputSignature(before));
  });

  test('a tool streaming output changes it, and so does its status', () => {
    const quiet = streaming([tool({ output: '' })]);
    const streamingOut = streaming([tool({ output: 'compiling…' })]);
    const longer = streaming([tool({ output: 'compiling… done' })]);
    expect(outputSignature(streamingOut)).not.toBe(outputSignature(quiet));
    expect(outputSignature(longer)).not.toBe(outputSignature(streamingOut));
    expect(outputSignature(streaming([tool({ status: 'completed', output: 'compiling… done' })])))
      .not.toBe(outputSignature(longer));
  });

  test('a codemode script reporting a nested call changes it', () => {
    const one = streaming([tool({ nestedCalls: [
      { id: 'c1', name: 'read', args: '{"path":"a"}', status: 'running' },
    ] })]);
    const settled = streaming([tool({ nestedCalls: [
      { id: 'c1', name: 'read', args: '{"path":"a"}', status: 'ok', durationMs: 4 },
    ] })]);
    expect(outputSignature(settled)).not.toBe(outputSignature(one));
  });

  test('a new part registers even when the existing ones are unchanged', () => {
    const before = streaming([{ type: 'reasoning', id: 'r1', text: 'hm' }]);
    const after = streaming([
      { type: 'reasoning', id: 'r1', text: 'hm' },
      { type: 'text', id: 't1', text: '' },
    ]);
    expect(outputSignature(after)).not.toBe(outputSignature(before));
  });

  test('a part kind this build does not know is handled, not thrown on', () => {
    const future = { type: 'citation', id: 'c9', source: 'x' } as unknown as MessagePart;
    const message = streaming([future]);
    expect(() => outputSignature(message)).not.toThrow();
    expect(outputSignature(message)).toBe(outputSignature(streaming([future])));
    // It is still output: a live turn carrying only an unknown part is not reported as empty.
    expect(outputSignature(message)).not.toBe('0/0');
  });
});
