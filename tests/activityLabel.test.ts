import { describe, expect, test } from 'bun:test';
import { deriveActivityLabel, toolActivityText } from '../src/lib/activityLabel';

describe('deriveActivityLabel', () => {
  test('names the chat, not the model, while it thinks', () => {
    expect(
      deriveActivityLabel({ busy: true, sending: false, lastRole: 'assistant', title: 'Blog update' })
    ).toEqual({ text: '· thinking', title: 'Blog update' });
  });

  test('falls back to plain "Thinking" without a title, or with a blank one', () => {
    expect(deriveActivityLabel({ busy: true, sending: false, lastRole: 'assistant' })).toEqual({
      text: 'Thinking',
    });
    expect(
      deriveActivityLabel({ busy: true, sending: false, lastRole: 'assistant', title: '   ' })
    ).toEqual({ text: 'Thinking' });
  });

  test('trims a title so padding cannot stretch the line', () => {
    expect(
      deriveActivityLabel({ busy: true, sending: false, lastRole: 'assistant', title: '  Blog update ' })
    ).toEqual({ text: '· thinking', title: 'Blog update' });
  });

  test('a running tool wins over the thinking branch', () => {
    expect(
      deriveActivityLabel({
        busy: true,
        sending: false,
        lastRole: 'assistant',
        runningTool: 'bash',
        title: 'Blog update',
      })
    ).toEqual({ text: 'Running bash' });
  });

  test('an unsent optimistic send says Sending', () => {
    expect(deriveActivityLabel({ busy: true, sending: true, lastRole: 'user', title: 'X' })).toEqual({
      text: 'Sending',
    });
  });

  test('pending prompts keep their own wording, even with a title', () => {
    expect(
      deriveActivityLabel({ busy: true, sending: false, prompt: 'permission', title: 'Blog update' })
    ).toEqual({ text: 'Waiting for approval' });
    expect(
      deriveActivityLabel({ busy: true, sending: false, prompt: 'question', title: 'Blog update' })
    ).toEqual({ text: 'Waiting for an answer' });
  });

  test('a brand-new session is never silent', () => {
    // The request is out before any run exists to watch, so `busy` is still false: a send in flight
    // is its own state, and checking it first is what stops a new column looking untouched.
    expect(deriveActivityLabel({ busy: false, sending: true, lastRole: 'user' })).toEqual({ text: 'Sending' });
    // Accepted and nothing running yet: the second before the first token.
    expect(deriveActivityLabel({ busy: false, sending: false, lastRole: 'user' })).toEqual({ text: 'Starting' });
  });

  test('a parked or failed message does not borrow the line', () => {
    // A queued message's home is the queue row; a failed one has a bubble with a reason. Saying
    // "Starting" over either would promise something that is not going to happen.
    expect(
      deriveActivityLabel({ busy: false, sending: false, lastRole: 'user', lastDelivery: 'queued' })
    ).toBeNull();
    expect(
      deriveActivityLabel({ busy: false, sending: false, lastRole: 'user', lastDelivery: 'failed' })
    ).toBeNull();
  });

  test('an idle session renders nothing', () => {
    expect(deriveActivityLabel({ busy: false, sending: false, title: 'Blog update' })).toBeNull();
  });
});

describe('a status the host has not answered for', () => {
  test('never claims the turn is starting or thinking', () => {
    // Without a status, "Starting" (a user message waiting for its first reply) would be a guess
    // dressed as progress. The session's status row says unknown; this line stays silent.
    expect(
      deriveActivityLabel({ busy: false, sending: false, lastRole: 'user', lastDelivery: undefined, statusUnknown: true })
    ).toBeNull();
    expect(deriveActivityLabel({ busy: false, sending: false, lastRole: 'user', statusUnknown: true })).toBeNull();
  });

  test('but a live turn and a pending prompt are still stated, because they are known', () => {
    expect(
      deriveActivityLabel({ busy: true, sending: false, lastRole: 'assistant', statusUnknown: true })?.text
    ).toBe('Thinking');
    expect(
      deriveActivityLabel({ busy: false, sending: false, prompt: 'permission', statusUnknown: true })?.text
    ).toBe('Waiting for approval');
  });

  test('a known idle session still gets its "Starting" bridge', () => {
    expect(
      deriveActivityLabel({ busy: false, sending: false, lastRole: 'user', lastDelivery: undefined })
    ).toEqual({ text: 'Starting' });
  });
});

/**
 * Two tools carry their meaning outside their name. `codemode` runs a script whose real work is the
 * calls it makes, and `scratchpad` acts on a key. "Running codemode" would say nothing the user can
 * act on, so both get their own wording — built from the call, never from the host's title (which is
 * raw input JSON for these two).
 */
describe('codemode and scratchpad say what they are doing', () => {
  test('a script names the nested call it is waiting on', () => {
    expect(
      deriveActivityLabel({
        busy: true,
        sending: false,
        lastRole: 'assistant',
        runningCall: {
          tool: 'codemode',
          input: { code: 'await tools.read({ path: "a.ts" })' },
          nestedCalls: [
            { id: 'c1', name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
            { id: 'c2', name: 'bash', args: '{"command":"ls"}', status: 'running' },
          ],
        },
        title: 'Refactor',
      })
    ).toEqual({ text: 'Running script · bash' });
  });

  test('a script between steps, or calling nothing, is just a running script', () => {
    const base = { busy: true, sending: false, lastRole: 'assistant' as const };
    expect(
      deriveActivityLabel({
        ...base,
        runningCall: {
          tool: 'codemode',
          nestedCalls: [{ id: 'c1', name: 'read', args: '{}', status: 'ok' }],
        },
      })
    ).toEqual({ text: 'Running script' });
    expect(deriveActivityLabel({ ...base, runningCall: { tool: 'codemode', input: { code: 'return 1' } } })).toEqual({
      text: 'Running script',
    });
  });

  test('a scratchpad call names its action and key', () => {
    const base = { busy: true, sending: false, lastRole: 'assistant' as const };
    expect(
      deriveActivityLabel({ ...base, runningCall: { tool: 'scratchpad', input: { action: 'get', key: 'matched' } } })
    ).toEqual({ text: 'Scratchpad · get matched' });
    // Only one of the two is present: say what is there, without a dangling separator.
    expect(
      deriveActivityLabel({ ...base, runningCall: { tool: 'scratchpad', input: { action: 'list' } } })
    ).toEqual({ text: 'Scratchpad · list' });
    expect(
      deriveActivityLabel({ ...base, runningCall: { tool: 'scratchpad', input: { key: 'matched' } } })
    ).toEqual({ text: 'Scratchpad · matched' });
    expect(deriveActivityLabel({ ...base, runningCall: { tool: 'scratchpad' } })).toEqual({ text: 'Scratchpad' });
  });

  test('every other tool still just names itself, and a bare name still works', () => {
    const base = { busy: true, sending: false, lastRole: 'assistant' as const };
    expect(deriveActivityLabel({ ...base, runningCall: { tool: 'bash', input: { command: 'bun test' } } })).toEqual({
      text: 'Running bash',
    });
    // A caller that only has the name (the old input) is unchanged.
    expect(deriveActivityLabel({ ...base, runningTool: 'bash' })).toEqual({ text: 'Running bash' });
  });

  test('toolActivityText is the formatter on its own, for callers that already have a call', () => {
    expect(toolActivityText({ tool: 'codemode', input: { code: 'x' } })).toBe('Running script');
    expect(
      toolActivityText({
        tool: 'codemode',
        nestedCalls: [{ id: 'c1', name: 'grep', args: '{}', status: 'running' }],
      })
    ).toBe('Running script · grep');
    expect(toolActivityText({ tool: 'scratchpad', input: { action: 'write', key: 'notes' } })).toBe(
      'Scratchpad · write notes'
    );
    expect(toolActivityText({ tool: 'read' })).toBe('Running read');
  });

  test('a new agent being created says what is happening and names the host', () => {
    expect(
      deriveActivityLabel({
        busy: false,
        sending: true,
        lastRole: 'user',
        creating: true,
        instanceLabel: 'Heliograph',
        title: 'Output Inspector',
      })
    ).toEqual({ title: 'Output Inspector', text: 'Starting this session on Heliograph' });
    // No label (an instance list still loading) must not leave a dangling "on".
    expect(
      deriveActivityLabel({ busy: false, sending: true, lastRole: 'user', creating: true, title: '  ' })
    ).toEqual({ text: 'Starting this session' });
  });

  test('a busy turn with no running call still falls back to thinking', () => {
    expect(
      deriveActivityLabel({ busy: true, sending: false, lastRole: 'assistant', runningCall: null, title: 'X' })
    ).toEqual({ text: '· thinking', title: 'X' });
  });
});
