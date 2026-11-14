import { describe, expect, test } from 'bun:test';
import {
  compactionFailureMessage,
  compactionLogLine,
  compactionNotice,
  compactionOutcome,
  watchCompaction,
  rememberCompactionTask,
  forgetCompactionTask,
  consumeCompactionFailure,
} from '../src/lib/compaction';

/**
 * A compaction the host accepts and then does not perform used to be silent: a 202, and nothing
 * ever changed. These pin the reading of the only signal there is (the summary's compaction flag)
 * and the sentence a person gets when the answer is "nothing".
 */
const trace = (over: Partial<Parameters<typeof compactionOutcome>[0]> = {}) => ({
  accepted: true,
  sawCompacting: false,
  entriesBefore: 20,
  entriesAfter: 20,
  ...over,
});

describe('what a compaction did', () => {
  test('a refusal is a failure, not a no-op', () => {
    expect(compactionOutcome(trace({ accepted: false }))).toBe('failed');
    expect(compactionNotice('failed')).toBeNull();
  });

  test('only placed-summary evidence means it landed', () => {
    expect(compactionOutcome(trace({ sawCompacting: true, taskStatus: 'landed' }))).toBe('landed');
    expect(compactionNotice('landed')).toBeNull();
  });

  test('a task failure after 202 is a failure and names the reason', () => {
    expect(compactionOutcome(trace({ sawCompacting: true, error: 'No model is configured' }))).toBe('failed');
    expect(compactionOutcome(trace({ sawCompacting: false, error: 'Summarization produced no text' }))).toBe('failed');
    const message = compactionFailureMessage('Model xai/grok-4 is not available');
    expect(message).toContain('Model xai/grok-4 is not available');
    expect(message).toMatch(/try again/i);
  });

  test('a fast compaction that already shrunk the transcript before the first poll still counts as landed', () => {
    expect(compactionOutcome(trace({ sawCompacting: false, entriesBefore: 20, entriesAfter: 8 }))).toBe('landed');
  });

  test('accepted, never flagged: the silent path', () => {
    // Exactly what a live host does on a transcript that already fits: 202, then the flag stays
    // false and the entries never move.
    expect(compactionOutcome(trace())).toBe('unknown');
    expect(compactionOutcome(trace({ taskStatus: 'nothing' }))).toBe('nothing');
  });
});

describe('the sentence for a compaction that did nothing', () => {
  test('says nothing was compacted and why', () => {
    const notice = compactionNotice('nothing');
    expect(notice).toBeTruthy();
    expect(notice).toMatch(/nothing to compact/i);
    expect(notice).toMatch(/unchanged/i);
  });

  test('no jargon and no alarm', () => {
    const notice = compactionNotice('nothing') ?? '';
    expect(notice).not.toContain('!');
    expect(notice).not.toMatch(/\b(error|failed|undefined|null|token)\b/i);
  });
});

describe('the log line', () => {
  test('one line carrying the facts a "nothing happened" report needs', () => {
    const line = compactionLogLine(trace({ taskStatus: 'nothing' }), { instanceId: 'pi:hearth', sessionId: '42' }, 1_700_000_000_000);
    expect(line).toContain('instance=pi:hearth');
    expect(line).toContain('session=42');
    expect(line).toContain('outcome=nothing');
    expect(line).toContain('accepted=true');
    expect(line).toContain('compacting=false');
    expect(line).toContain('entries=20->20');
    expect(line.includes('\n')).toBe(false);
  });
});

describe('bounded task watcher', () => {
  test('keeps watching after spinner starts and surfaces a late failure', async () => {
    let read = 0;
    const result = await watchCompaction({ taskId: 7, delay: async () => {},
      readTask: async () => ++read < 3 ? { status: 'running' } : { status: 'failed', error: 'provider refused' },
      readSummary: async () => ({ compacting: true }),
    });
    expect(read).toBe(3);
    expect(result.sawCompacting).toBe(true);
    expect(result.taskStatus).toBe('failed');
    expect(result.error).toContain('provider refused');
  });
  test('summary pending placement is not success; waits for the actual boundary', async () => {
    let read = 0;
    const result = await watchCompaction({ taskId: 7, delay: async () => {},
      readTask: async () => ({ status: ++read < 4 ? 'pending' : 'landed' }),
      readSummary: async () => ({ compacting: false }),
    });
    expect(read).toBe(4);
    expect(result.taskStatus).toBe('landed');
  });
  test('bounds a long task and never labels it as no-op or success', async () => {
    let read = 0;
    const result = await watchCompaction({ taskId: 7, maxPolls: 3, delay: async () => {},
      readTask: async () => { read++; return { status: 'running' }; },
      readSummary: async () => ({ compacting: true }),
    });
    expect(read).toBe(3);
    expect(compactionOutcome(trace(result))).toBe('pending');
  });
  test('older hosts do not become no-ops and stale failures are ignored', async () => {
    let reads = 0;
    const result = await watchCompaction({ taskId: 7, delay: async () => {},
      readTask: async () => null,
      readSummary: async () => { reads++; return { compacting: false, compactionFailure: { taskId: 6, error: 'old error' } }; },
    });
    expect(reads).toBe(5);
    expect(compactionOutcome(trace(result))).toBe('unknown');
    expect(compactionNotice('unknown')).toMatch(/host.*refresh/i);
  });
  test('a fast failed task and a real no-op do not depend on catching a transient flag', async () => {
    for (const status of ['failed', 'nothing', 'aborted'] as const) {
      const result = await watchCompaction({ taskId: 7, delay: async () => {},
        readTask: async () => ({ status }), readSummary: async () => ({ compacting: false }),
      });
      expect(compactionOutcome(trace(result))).toBe(status);
    }
  });
});

describe('late compaction failures from existing summary refreshes', () => {
  test('only this run’s accepted task may report, once across watcher and summary paths', () => {
    const tracked = rememberCompactionTask({}, 'host::chat', 7);
    expect(consumeCompactionFailure(tracked, 'host::chat', { taskId: 6, error: 'historical' }).error).toBeUndefined();
    expect(consumeCompactionFailure(tracked, 'other::chat', { taskId: 7, error: 'different host' }).error).toBeUndefined();
    const late = consumeCompactionFailure(tracked, 'host::chat', { taskId: 7, error: 'late provider failure' });
    expect(late.error).toBe('late provider failure');
    expect(consumeCompactionFailure(late.state, 'host::chat', { taskId: 7, error: 'late provider failure' }).error).toBeUndefined();
  });
  test('retry keeps the first task observable without consuming the new task; settled tasks are forgotten', () => {
    const first = rememberCompactionTask({}, 'chat', 7);
    const retry = rememberCompactionTask(first, 'chat', 8);
    const oldFailure = consumeCompactionFailure(retry, 'chat', { taskId: 7, error: 'first attempt failed' });
    expect(oldFailure.error).toBeTruthy();
    expect(oldFailure.state.chat).toEqual([8]);
    const done = forgetCompactionTask(oldFailure.state, 'chat', 8);
    expect(consumeCompactionFailure(done, 'chat', { taskId: 8, error: 'stale snapshot' }).error).toBeUndefined();
    expect(first.chat).toEqual([7]); // transitions never mutate earlier state
  });
});

test('background compaction failure names the affected session and host, and offers recovery', () => {
  for (const detail of [undefined, 'Provider declined the summary.']) {
    const message = compactionFailureMessage(detail, '“Release planning” on Tower');
    expect(message).toContain('Release planning');
    expect(message).toContain('Tower');
    expect(message).toMatch(/try again/i);
    expect(message).not.toMatch(/undefined|null|!|HTTP \d/i);
  }
});
