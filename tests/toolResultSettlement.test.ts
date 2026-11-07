import { describe, expect, test } from 'bun:test';
import {
  piEntriesToMessages,
  settleToolResults,
  toolResultSettlements,
  type PiEntry,
} from '../src/lib/piMapping';
import { reconcileTranscriptAppend } from '../src/lib/transcriptReconciliation';
import type { ChatMessage } from '../src/types';

/**
 * A tool call and its result are two entries. Ember usually reads them in two pages: the assistant
 * turn commits while the tool runs, and the result arrives in a later `since` read. These tests pin
 * the two halves of that handover: the result must settle the call the transcript already holds,
 * and a call with no result must never claim it completed.
 */

const assistantWithCall = (stopReason = 'toolUse'): PiEntry => ({
  id: 100,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      timestamp: 1_000,
      stopReason,
      content: [
        { type: 'text', text: 'checking the file' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
      ],
    },
  ],
});

const resultFor = (overrides: Record<string, unknown> = {}): PiEntry => ({
  id: 101,
  kind: 'pi.tool-result',
  model: [
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      isError: false,
      timestamp: 1_100,
      content: [{ type: 'text', text: 'file contents here' }],
      ...overrides,
    },
  ],
});

const toolPartOf = (messages: readonly ChatMessage[]) => {
  const part = messages.flatMap((message) => message.parts).find((candidate) => candidate.type === 'tool');
  if (!part || part.type !== 'tool') throw new Error('no tool part');
  return part.call;
};

describe('a tool call with no result is unsettled, never completed', () => {
  test('a call whose result has not arrived is pending', () => {
    const messages = piEntriesToMessages([assistantWithCall()]);
    const call = toolPartOf(messages);
    expect(call.status).toBe('pending');
    expect(call.output).toBeUndefined();
  });

  test('an authoritative read marks a finished turn’s unsettled call interrupted', () => {
    // The turn ended (`stopReason: 'stop'`) and no result entry exists: Hearth cut the step short.
    const messages = piEntriesToMessages([assistantWithCall('stop')], undefined, { authoritative: true });
    const call = toolPartOf(messages);
    expect(call.status).toBe('interrupted');
    expect(call.error).toMatch(/interrupted/i);
  });

  test('a toolUse entry whose run is over is interrupted, not left pending', () => {
    // `stopReason: 'toolUse'` means the turn was still going when the entry was written. With no run
    // in flight it never continued: nothing will settle this call, so "pending" would be a spinner
    // for ever. (While a run *is* active, the newest entry's call stays pending — see the dead-run
    // cases below.)
    const messages = piEntriesToMessages([assistantWithCall('toolUse')], undefined, { authoritative: true });
    expect(toolPartOf(messages).status).toBe('interrupted');
  });
});

describe('a result settles its call wherever the call lives', () => {
  test('same page still settles the call', () => {
    const messages = piEntriesToMessages([assistantWithCall(), resultFor()]);
    const call = toolPartOf(messages);
    expect(call.status).toBe('completed');
    expect(call.output).toBe('file contents here');
  });

  test('a result alone in a page yields no message but does yield a settlement', () => {
    const page = [resultFor()];
    // The mapper cannot invent a message for a result: the call is not in this page.
    expect(piEntriesToMessages(page)).toEqual([]);
    const settlements = toolResultSettlements(page);
    expect(settlements).toEqual([{ callId: 'call-1', status: 'completed', output: 'file contents here' }]);
  });

  test('the append path patches the call the transcript already holds', () => {
    // Read 1: the assistant turn, committed while the tool is still running.
    const held = piEntriesToMessages([assistantWithCall()]);
    expect(toolPartOf(held).status).toBe('pending');

    // Read 2: a `since` page carrying only the result.
    const page = piEntriesToMessages([resultFor()]);
    expect(page).toEqual([]);
    const appended = reconcileTranscriptAppend(held, page, new Set());
    expect(toolPartOf(appended.messages).status).toBe('pending');

    // The transport hands the settlement to the transcript commit, which patches the held part.
    const settled = settleToolResults(appended.messages, toolResultSettlements([resultFor()]));
    const call = toolPartOf(settled);
    expect(call.status).toBe('completed');
    expect(call.output).toBe('file contents here');
  });

  test('an error result settles as an error with its text', () => {
    const page = [resultFor({ isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] })];
    const settlements = toolResultSettlements(page);
    const settled = settleToolResults(piEntriesToMessages([assistantWithCall()]), settlements);
    const call = toolPartOf(settled);
    expect(call.status).toBe('error');
    expect(call.error).toContain('ENOENT');
  });

  test('an interrupted result stays interrupted', () => {
    const page = [
      resultFor({
        isError: true,
        content: [{ type: 'text', text: '<harness>\n[error] Tool read was aborted\n</harness>' }],
      }),
    ];
    const settled = settleToolResults(piEntriesToMessages([assistantWithCall()]), toolResultSettlements(page));
    expect(toolPartOf(settled).status).toBe('interrupted');
  });

  test('images ride the settlement onto the tool call', () => {
    const page = [
      resultFor({
        content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
      }),
    ];
    const settled = settleToolResults(piEntriesToMessages([assistantWithCall()]), toolResultSettlements(page));
    const call = toolPartOf(settled);
    expect(call.status).toBe('completed');
    expect(call.images?.[0]?.mime).toBe('image/png');
  });
});

describe('a failed call keeps the output the agent saw', () => {
  /** 2 000 characters of log, then the line that matters — past the old 400-character cut. */
  const longLog = [
    ...Array.from({ length: 40 }, (_, i) => `line ${i + 1}: waiting for the marker`),
    'RC=[missing]',
    'FINAL-CUT-v2.iso   1.8 MB',
  ].join('\n');

  const failed = (overrides: Record<string, unknown> = {}) =>
    [resultFor({ isError: true, content: [{ type: 'text', text: longLog }], ...overrides })];

  test('the whole retained log survives, not just its first 400 characters', () => {
    // Measured before the fix: the same 2 072-character result came back as 400 characters of
    // `error` and no output at all, so the interesting last line was simply gone.
    const settled = settleToolResults(piEntriesToMessages([assistantWithCall()]), toolResultSettlements(failed()));
    const call = toolPartOf(settled);
    expect(call.status).toBe('error');
    expect(call.output).toBe(longLog);
    expect(call.output).toContain('FINAL-CUT-v2.iso');
  });

  test('the red summary is one line, and it is the reason — the last line, not the first', () => {
    const [settlement] = toolResultSettlements(failed());
    expect(settlement.error).toBe('FINAL-CUT-v2.iso   1.8 MB');
  });

  test('the host’s own diagnostic wins over guessing from the text', () => {
    // Hearth sends `diagnostics: [{ code: 'exit_code', message: 'Command exited with code 1' }]`.
    const [settlement] = toolResultSettlements(
      failed({ details: { exitCode: 1, truncated: false, diagnostics: [{ severity: 'error', code: 'exit_code', message: 'Command exited with code 1' }] } })
    );
    expect(settlement.error).toBe('Command exited with code 1');
  });

  test('an interrupted step is unchanged: the harness text is the message, and it has no output', () => {
    const page = [
      resultFor({ isError: true, content: [{ type: 'text', text: '<harness>\n[error] Tool read was aborted\n</harness>' }] }),
    ];
    const [settlement] = toolResultSettlements(page);
    expect(settlement.status).toBe('interrupted');
    expect(settlement.output).toBeUndefined();
    expect(settlement.error).toContain('aborted');
  });

  test('exit status and truncation ride the settlement onto the call', () => {
    const settled = settleToolResults(
      piEntriesToMessages([assistantWithCall()]),
      toolResultSettlements(failed({ details: { exitCode: 1, truncated: true } }))
    );
    const call = toolPartOf(settled);
    expect(call.exitCode).toBe(1);
    expect(call.truncated).toBe(true);
    // A host that does not report them says nothing rather than inventing 0 and false.
    const [plain] = toolResultSettlements([resultFor()]);
    expect(plain.exitCode).toBeUndefined();
    expect(plain.truncated).toBeUndefined();
  });

  test('the client’s own cut says how much output there was', () => {
    const huge = 'x'.repeat(25_000);
    const [settlement] = toolResultSettlements([resultFor({ content: [{ type: 'text', text: huge }] })]);
    expect(settlement.output).toContain('… (truncated — 25,000 characters)');
    expect(settlement.output?.startsWith('x'.repeat(100))).toBe(true);
  });
});

describe('settling is a no-op when there is nothing to change', () => {
  test('no settlements returns the same array', () => {
    const messages = piEntriesToMessages([assistantWithCall()]);
    expect(settleToolResults(messages, [])).toBe(messages);
  });

  test('a settlement for a call the transcript does not hold returns the same array', () => {
    const messages = piEntriesToMessages([assistantWithCall()]);
    const unchanged = settleToolResults(messages, [{ callId: 'other-call', status: 'completed' }]);
    expect(unchanged).toBe(messages);
  });

  test('re-applying the same settlement keeps message identity', () => {
    const first = settleToolResults(
      piEntriesToMessages([assistantWithCall()]),
      toolResultSettlements([resultFor()])
    );
    const second = settleToolResults(first, toolResultSettlements([resultFor()]));
    expect(second).toBe(first);
  });
});

/**
 * The authoritative pass settles a call the *turn* can no longer settle. A tool-calling assistant
 * entry always stops with `stopReason: 'toolUse'` — the call is what keeps the turn going — so the
 * old `!message.completed` guard skipped exactly the entries that own tool calls, and a dead step
 * stayed `pending` for ever. The run is the real test: with no run in flight nothing will settle it.
 */
describe('an authoritative read settles the calls a dead run left open', () => {
  const openCall = (id: number, reason = 'toolUse'): PiEntry => ({
    id,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        timestamp: 1_000 + id,
        stopReason: reason,
        content: [
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: `call-${id}`, name: 'read', arguments: { path: 'a.ts' } },
        ],
      },
    ],
  });

  test('a toolUse entry with no result and no run is interrupted, not pending', () => {
    const messages = piEntriesToMessages([openCall(1)], undefined, { authoritative: true });
    const call = toolPartOf(messages);
    expect(call.status).toBe('interrupted');
    expect(call.error).toMatch(/interrupted/i);
  });

  test('a run still in flight keeps its newest step pending, and settles the earlier ones', () => {
    // Two tool rounds, the second still in flight: its call may yet get a result, the first one
    // cannot — its entry is behind the newest assistant entry and no run slot names it.
    const live = { run: { inputs: [1] }, tools: [{ callId: 'call-2', status: 'running' as const }] };
    const messages = piEntriesToMessages([openCall(1), openCall(2)], live, { authoritative: true });
    const statuses = messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'tool' ? [part.call.status] : []))
    );
    expect(statuses).toEqual(['interrupted', 'running']);
  });

  test('a call a live slot is tracking is never called interrupted', () => {
    const live = { run: { inputs: [1] }, tools: [{ callId: 'call-1', status: 'running' as const }] };
    const messages = piEntriesToMessages([openCall(1)], live, { authoritative: true });
    expect(toolPartOf(messages).status).toBe('running');
  });

  test('a finished turn’s dead call settles even when a later entry continued the turn', () => {
    // The interrupted step, then a queued follow-up that already produced its own answer.
    const answered: PiEntry = {
      id: 9,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', timestamp: 2_000, stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }],
    };
    const messages = piEntriesToMessages([openCall(1), answered], undefined, { authoritative: true });
    expect(toolPartOf(messages).status).toBe('interrupted');
  });
});

/**
 * A `codemode` script settles with more than text: its result's `details.calls` lists the calls the
 * script made, and `details.fullOutputPath` names the file holding output the host had to cut. The
 * incremental path (a `since` read carrying only the result) is the usual way Ember learns a call
 * ended, so those fields must ride the settlement onto the call the transcript already holds.
 */
describe('a settled codemode result carries its nested calls across an incremental read', () => {
  const scriptEntry = (): PiEntry => ({
    id: 100,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        timestamp: 1_000,
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'codemode', arguments: { code: 'await tools.read({ path: "a.ts" })' } },
        ],
      },
    ],
  });

  const settledScript = (): PiEntry => ({
    id: 101,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        isError: false,
        timestamp: 1_100,
        content: [{ type: 'text', text: 'script finished' }],
        details: {
          calls: [
            { id: 1, name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
            { id: 2, name: 'bash', args: '{"command":"ls"}', status: 'error', error: 'exit 1' },
          ],
          fullOutputPath: '/tmp/codemode/out.txt',
        },
      },
    ],
  });

  test('the settlement itself carries the calls and the output path', () => {
    expect(toolResultSettlements([settledScript()])).toEqual([
      {
        callId: 'call-1',
        status: 'completed',
        output: 'script finished',
        nestedCalls: [
          { id: '1', name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
          { id: '2', name: 'bash', args: '{"command":"ls"}', status: 'error', error: 'exit 1' },
        ],
        fullOutputPath: '/tmp/codemode/out.txt',
      },
    ]);
  });

  test('settling a held codemode call patches in both fields', () => {
    // Read 1: the script call, running, with one nested call live.
    const held = piEntriesToMessages([scriptEntry()], {
      run: { inputs: [1] },
      tools: [{ callId: 'call-1', status: 'running' }],
      nestedTools: [
        { callId: 'call-1/c1', parentCallId: 'call-1', name: 'read', arguments: { path: 'a.ts' }, status: 'running' },
      ],
    });
    expect(toolPartOf(held).nestedCalls).toEqual([
      { id: 'c1', name: 'read', args: '{"path":"a.ts"}', status: 'running' },
    ]);

    // Read 2: a `since` page carrying only the result, merged in by the transport.
    const settlements = toolResultSettlements([settledScript()]);
    const settled = settleToolResults(held, settlements);
    const call = toolPartOf(settled);
    expect(call.status).toBe('completed');
    expect(call.nestedCalls).toEqual([
      { id: '1', name: 'read', args: '{"path":"a.ts"}', status: 'ok', durationMs: 12 },
      { id: '2', name: 'bash', args: '{"command":"ls"}', status: 'error', error: 'exit 1' },
    ]);
    expect(call.fullOutputPath).toBe('/tmp/codemode/out.txt');
  });

  test('re-applying the same settlement keeps message identity', () => {
    const first = settleToolResults(piEntriesToMessages([scriptEntry()]), toolResultSettlements([settledScript()]));
    const second = settleToolResults(first, toolResultSettlements([settledScript()]));
    expect(second).toBe(first);
  });

  test('a script that called nothing clears the live list rather than leaving stale steps', () => {
    // The result says `calls: []`: the live list was all there was, and it is now wrong.
    const held = piEntriesToMessages([scriptEntry()], {
      tools: [{ callId: 'call-1', status: 'running' }],
      nestedTools: [
        { callId: 'call-1/c1', parentCallId: 'call-1', name: 'read', status: 'running' },
      ],
    });
    const empty: PiEntry = {
      id: 101,
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          isError: false,
          timestamp: 1_100,
          content: [{ type: 'text', text: 'done' }],
          details: { calls: [] },
        },
      ],
    };
    expect(toolPartOf(settleToolResults(held, toolResultSettlements([empty]))).nestedCalls).toEqual([]);
  });

  test('an ordinary tool result carries neither field', () => {
    const settlements = toolResultSettlements([resultFor()]);
    expect(settlements[0].nestedCalls).toBeUndefined();
    expect(settlements[0].fullOutputPath).toBeUndefined();
  });
});
