import { expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ContextCompactionStatus from '../src/components/ContextCompactionStatus';
import type { Session } from '../src/types';
import { withTestRoot } from './fixtures/reactRoot';

const render = (change: Partial<Session>) =>
  renderToStaticMarkup(<ContextCompactionStatus session={{ ...change } as Session} host="Tower" onCompact={() => {}} />);

test('progress, no-op and failures never report a successful compaction', () => {
  expect(render({})).toBe('');
  const pending = render({ compacting: true });
  expect(pending).toContain('Tower');
  expect(pending).not.toContain('Context compacted');
  const failed = render({ compactionFailure: { error: 'provider refused', trigger: 'threshold' } });
  expect(failed).toContain('Tower');
  expect(failed).toContain('Try compacting again');
  expect(failed).not.toContain('Context compacted');
});

test('an existing historical summary is not announced as a newly completed attempt', () => {
  expect(render({ contextCompaction: { entryId: 42, reason: 'threshold' }, currentContextTokens: 5000 })).toBe('');
});

test('a session with undefined epoch/tokens on initial mount displays its very first compaction pill after mount', async () => {
  await withTestRoot(async ({ render: renderLive, text }) => {
    await renderLive(<ContextCompactionStatus session={{} as Session} host="Tower" onCompact={() => {}} />);
    expect(text()).toBe('');

    await renderLive(
      <ContextCompactionStatus
        session={{ compacting: true } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toContain('Tower is compacting context');

    await renderLive(
      <ContextCompactionStatus
        session={{
          contextCompaction: { entryId: 7, reason: 'threshold' },
          currentContextEpoch: '7',
          currentContextTokens: 3200,
        } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toContain('Context compacted automatically. Older messages remain in the transcript.');
  });

  // Fast compaction finishing between polls (no intermediate compacting: true observed).
  await withTestRoot(async ({ render: renderLive, text }) => {
    await renderLive(<ContextCompactionStatus session={{} as Session} host="Tower" onCompact={() => {}} />);
    expect(text()).toBe('');

    await renderLive(
      <ContextCompactionStatus
        session={{
          contextCompaction: { entryId: 9, reason: 'manual' },
          currentContextEpoch: '9',
          currentContextTokens: 2100,
        } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toContain('Context compacted. Older messages remain in the transcript.');
    expect(text()).not.toContain('automatically');
  });
});

test('a historical compaction present on initial mount stays suppressed across context hydration until a newer compaction lands', async () => {
  await withTestRoot(async ({ render: renderLive, text }) => {
    await renderLive(
      <ContextCompactionStatus
        session={{ contextCompaction: { entryId: 42, reason: 'threshold' } } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toBe('');

    await renderLive(
      <ContextCompactionStatus
        session={{
          contextCompaction: { entryId: 42, reason: 'threshold' },
          currentContextEpoch: '42',
          currentContextTokens: 5000,
        } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toBe('');

    await renderLive(
      <ContextCompactionStatus
        session={{
          contextCompaction: { entryId: 43, reason: 'manual' },
          currentContextEpoch: '43',
          currentContextTokens: 3500,
        } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toContain('Context compacted. Older messages remain in the transcript.');

    await renderLive(
      <ContextCompactionStatus
        session={{ currentContextEpoch: 'initial', contextCompaction: null } as Session}
        host="Tower"
        onCompact={() => {}}
      />
    );
    expect(text()).toBe('');
  });
});
