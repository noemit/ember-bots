import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ContextRecommendation from '../src/components/ContextRecommendation';
import {
  contextRecommendationThreshold as threshold,
  observeContextRecommendation as observe,
  shouldRecommendContextCompaction as visible,
} from '../src/lib/contextRecommendation';
import { piConversationToSession } from '../src/lib/piMapping';

const high = { scope: 'host::session', tokens: 100_000, epoch: 'initial', window: 200_000 };

describe('context recommendation policy', () => {
  test('inclusive 100k ceiling, earlier at 60% of small windows, unknown windows conservative', () => {
    expect(threshold(1_000_000)).toBe(100_000);
    expect(threshold(128_000)).toBe(76_800);
    for (const window of [undefined, 0, -10, NaN, Infinity]) expect(threshold(window)).toBe(100_000);
    expect(visible(observe(undefined, high), high)).toBe(true);
    const below = { ...high, tokens: 99_999 };
    expect(visible(observe(undefined, below), below)).toBe(false);
    const small = { ...high, window: 50_000, tokens: 30_000 };
    expect(visible(observe(undefined, small), small)).toBe(true);
  });

  test('dismissed high episode stays dismissed through polls, growth, missing counts and boundary jitter', () => {
    const dismissed = { ...observe(undefined, high), dismissed: true };
    for (const tokens of [100_000, 180_000, 99_999, 80_001, undefined, NaN, Infinity]) {
      const next = { ...high, tokens };
      expect(observe(dismissed, next)).toBe(dismissed);
      expect(visible(dismissed, next)).toBe(false);
    }
  });

  test('meaningful observed reduction rearms, but does not display until high again', () => {
    const dismissed = { ...observe(undefined, high), dismissed: true };
    const low = { ...high, tokens: 80_000 };
    const rearmed = observe(dismissed, low);
    expect(rearmed.dismissed).toBe(false);
    expect(visible(rearmed, low)).toBe(false);
    expect(visible(observe(rearmed, high), high)).toBe(true);
  });

  test('session, reset/compaction epoch, and threshold policy changes start a new episode', () => {
    const dismissed = { ...observe(undefined, high), dismissed: true };
    for (const change of [{ scope: 'another-session' }, { epoch: 'compaction-2' }, { window: 100_000 }]) {
      expect(observe(dismissed, { ...high, ...change }).dismissed).toBe(false);
    }
    // Model changes with the same effective threshold are not a new reason to nag.
    expect(observe(dismissed, { ...high, window: 1_000_000 })).toBe(dismissed);
  });

  test('invalid or absent current snapshots never recommend', () => {
    for (const tokens of [undefined, -1, NaN, Infinity]) {
      const observation = { ...high, tokens };
      expect(visible(observe(undefined, observation), observation)).toBe(false);
    }
  });

  test('summary mapping preserves authoritative zero and epoch, rejects invalid counts and never uses cost', () => {
    expect(piConversationToSession('host', { id: 1, cost: 100_000 }).currentContextTokens).toBeUndefined();
    expect(piConversationToSession('host', { id: 1, currentContextTokens: 0, currentContextEpoch: 'reset-2' }))
      .toMatchObject({ currentContextTokens: 0, currentContextEpoch: 'reset-2' });
    for (const count of [NaN, Infinity, -1]) {
      expect(piConversationToSession('host', { id: 1, currentContextTokens: count }).currentContextTokens).toBeUndefined();
    }
  });
});

describe('context recommendation rendering', () => {
  const render = (props: Partial<React.ComponentProps<typeof ContextRecommendation>> = {}) => {
    let requests = 0;
    const html = renderToStaticMarkup(<ContextRecommendation {...high} busy={false} compacting={false} onCompact={() => { requests++; }} {...props} />);
    expect(requests).toBe(0);
    return html;
  };
  test('calm named section offers explicit Compact and accessible dismiss; no alert', () => {
    const html = render();
    expect(html).toContain('aria-label="Context recommendation"');
    expect(html).toContain('aria-label="Dismiss context recommendation"');
    expect(html).toContain('>Compact</button>');
    expect(html).toContain('summarize older turns');
    expect(html).toContain('keep recent messages');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('!');
  });
  test('busy and compacting states disable Compact, not dismissal', () => {
    for (const props of [{ busy: true }, { compacting: true }]) {
      const html = render(props);
      expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(1);
      expect(html).toContain('Dismiss context recommendation');
    }
    expect(render({ busy: true })).toContain('when the running turn finishes');
    expect(render({ compacting: true })).toContain('Compacting…');
  });
  test('no advice for unknown or below threshold context', () => {
    expect(render({ tokens: undefined })).toBe('');
    expect(render({ tokens: 99_999 })).toBe('');
  });
  test('ChatView uses host snapshot above input and has no automatic compaction effect', () => {
    const source = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');
    expect(source).toContain('tokens={session.currentContextTokens}');
    expect(source.indexOf('<ContextRecommendation')).toBeLessThan(source.indexOf('data-composer-surface'));
    expect(source).not.toContain('autoCompactedRef');
    expect(source).not.toContain('onCompact();');
  });
});
