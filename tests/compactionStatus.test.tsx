import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ContextCompactionStatus from '../src/components/ContextCompactionStatus';
import type { Session } from '../src/types';
const render = (change: Partial<Session>) => renderToStaticMarkup(<ContextCompactionStatus session={{ ...change } as Session} host="Tower" onCompact={() => {}} />);
test('progress, no-op and failures never report a successful compaction', () => {
  expect(render({})).toBe('');
  const pending = render({ compacting: true });
  expect(pending).toContain('Tower'); expect(pending).not.toContain('Context compacted');
  const failed = render({ compactionFailure: { error: 'provider refused', trigger: 'threshold' } });
  expect(failed).toContain('Tower'); expect(failed).toContain('Try compacting again'); expect(failed).not.toContain('Context compacted');
});
test('an existing historical summary is not announced as a newly completed attempt', () => {
  expect(render({ contextCompaction: { entryId: 42, reason: 'threshold' }, currentContextTokens: 5000 })).toBe('');
});
