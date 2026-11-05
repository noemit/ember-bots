import { describe, expect, test } from 'bun:test';
import { compactionLogLine, compactionNotice, compactionOutcome } from './src/lib/compaction';

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

  test('the flag means it really started', () => {
    expect(compactionOutcome(trace({ sawCompacting: true, entriesAfter: 8 }))).toBe('landed');
    expect(compactionNotice('landed')).toBeNull();
  });

  test('accepted, never flagged: the silent path', () => {
    // Exactly what a live host does on a transcript that already fits: 202, then the flag stays
    // false and the entries never move.
    expect(compactionOutcome(trace())).toBe('nothing');
  });
});

describe('the sentence for a compaction that did nothing', () => {
  test('says nothing was compacted and why', () => {
    const notice = compactionNotice('nothing');
    expect(notice).toBeTruthy();
    expect(notice).toMatch(/nothing to compact/i);
    expect(notice).toMatch(/already fit|fits/i);
  });

  test('no jargon and no alarm', () => {
    const notice = compactionNotice('nothing') ?? '';
    expect(notice).not.toContain('!');
    expect(notice).not.toMatch(/\b(error|failed|undefined|null|token)\b/i);
  });
});

describe('the log line', () => {
  test('one line carrying the facts a "nothing happened" report needs', () => {
    const line = compactionLogLine(trace(), { instanceId: 'pi:hearth', sessionId: '42' }, 1_700_000_000_000);
    expect(line).toContain('instance=pi:hearth');
    expect(line).toContain('session=42');
    expect(line).toContain('outcome=nothing');
    expect(line).toContain('accepted=true');
    expect(line).toContain('compacting=false');
    expect(line).toContain('entries=20->20');
    expect(line.includes('\n')).toBe(false);
  });
});
