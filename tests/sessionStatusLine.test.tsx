import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import SessionStatusLine from '../src/components/SessionStatusLine';
import { deriveSessionStatus, type SessionStatusKind } from '../src/lib/sessionStatus';
import type { Session } from '../src/types';

describe('available leader task status', () => {
  test('uses the requested task wording and a green availability dot', () => {
    const workers = ['a', 'b', 'c'].map(id => ({ id, instanceId: 'local', kind: 'worker' } as Session));
    const status = deriveSessionStatus({ state: 'idle', workers, workerStateFor: () => 'active' });
    expect(status?.text).toBe('Tackling 3 tasks.');
    const html = renderToStaticMarkup(<SessionStatusLine status={status} />);
    expect(html).toContain('bg-success');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('pointer-events-auto');
  });
  test('does not give working, unknown or blocked leaders the available dot', () => {
    for (const kind of ['working', 'unknown', 'needs-reply', 'stalled'] as SessionStatusKind[]) {
      const html = renderToStaticMarkup(<SessionStatusLine status={{ kind, text: 'Status' }} />);
      expect(html).not.toContain('bg-success');
    }
  });
  test('an idle leader without tasks adds no status row', () => {
    expect(renderToStaticMarkup(<SessionStatusLine status={null} />)).toBe('');
  });
});
