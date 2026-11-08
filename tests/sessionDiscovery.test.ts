import { describe, expect, test } from 'bun:test';
import { observeSessionDiscovery } from '../src/lib/sessionDiscovery';
import type { Session } from '../src/types';

const row = (id: string, extra: Partial<Session> = {}): Session => ({ id, instanceId: 'a', ...extra });
const complete = { completeSnapshot: true };

describe('complete host-wide discovery evidence', () => {
  test('the first complete snapshot is a baseline; subsequent unseen ids are new', () => {
    const first = observeSessionDiscovery({}, 'a', [row('existing')], complete);
    expect(first.eligible).toEqual([]);
    const fresh = row('external');
    const next = observeSessionDiscovery(first.state, 'a', [row('existing'), fresh], complete);
    expect(next.eligible).toEqual([fresh]);
    expect(next.state.a.completeSnapshot).toBe(true);
    // A pending local create can defer allocation without consuming this candidate.
    expect(observeSessionDiscovery(next.state, 'a', [fresh, fresh], complete).eligible).toEqual([fresh]);
    expect(first.state.a.seenIds.has('external')).toBe(false);
  });

  test('a successful empty complete response establishes a baseline', () => {
    const first = observeSessionDiscovery({}, 'a', [], complete);
    expect(first.eligible).toEqual([]);
    expect(observeSessionDiscovery(first.state, 'a', [row('new')], complete).eligible).toEqual([row('new')]);
  });

  test('archived restoration and hidden workers becoming peers do not create new identities', () => {
    const first = observeSessionDiscovery({}, 'a', [
      row('archived', { archived: 100 }),
      row('worker', { kind: 'worker' }),
      row('child', { parentId: 'leader' }),
      row('lead-only', { lead: { instanceId: 'a', sessionId: 'leader' } }),
    ], complete);
    expect(observeSessionDiscovery(first.state, 'a', [
      row('archived'), row('worker', { kind: 'peer' }), row('child'), row('lead-only'),
    ], complete).eligible).toEqual([]);
    const hidden = observeSessionDiscovery(first.state, 'a', [
      row('new-worker', { kind: 'worker' }),
      row('new-lead-only', { lead: { instanceId: 'a', sessionId: 'leader' } }),
      row('new-archived', { archived: 100 }),
      row('new-child', { parentId: 'leader' }),
    ], complete);
    expect(hidden.eligible).toEqual([]);
    expect(observeSessionDiscovery(hidden.state, 'a', [
      row('new-worker', { kind: 'peer' }), row('new-lead-only'), row('new-archived'), row('new-child'),
    ], complete).eligible).toEqual([]);
  });

  test('a new peer may retain historical lead metadata', () => {
    const first = observeSessionDiscovery({}, 'a', [], complete);
    const peer = row('peer', { kind: 'peer', lead: { instanceId: 'a', sessionId: 'leader' } });
    expect(observeSessionDiscovery(first.state, 'a', [peer], complete).eligible).toEqual([peer]);
  });

  test('the first complete snapshot after partial responses re-baselines', () => {
    const partial = observeSessionDiscovery({}, 'a', [row('page-one')]);
    expect(partial.state.a.completeSnapshot).toBe(false);
    const nextPage = observeSessionDiscovery(partial.state, 'a', [row('old-unseen', { updated: 9_999_999_999_999 })]);
    expect(nextPage.eligible).toEqual([]);
    const fullRows = [row('page-one'), row('old-unseen'), row('another-old')];
    const full = observeSessionDiscovery(nextPage.state, 'a', fullRows, complete);
    expect(full.eligible).toEqual([]);
    expect(observeSessionDiscovery(full.state, 'a', [...fullRows, row('brand-new')], complete).eligible.map(s => s.id)).toEqual(['brand-new']);
  });

  test('late hosts establish independent complete baselines; foreign rows cannot contaminate them', () => {
    const first = observeSessionDiscovery({}, 'a', [], complete);
    const late = observeSessionDiscovery(first.state, 'b', [row('existing-b', { instanceId: 'b' }), row('foreign')], complete);
    expect(late.eligible).toEqual([]);
    expect(late.state.a).toBe(first.state.a);
    expect(late.state.b.seenIds.has('foreign')).toBe(false);
    const newB = row('new-b', { instanceId: 'b' });
    expect(observeSessionDiscovery(late.state, 'b', [newB], complete).eligible).toEqual([newB]);
  });

  test('partial lists never establish novelty even after a complete baseline', () => {
    const first = observeSessionDiscovery({}, 'a', [], complete);
    const partial = observeSessionDiscovery(first.state, 'a', [row('partial-only')]);
    expect(partial.eligible).toEqual([]);
    // Fail closed once a row was seen without complete-snapshot evidence.
    expect(observeSessionDiscovery(partial.state, 'a', [row('partial-only')], complete).eligible).toEqual([]);
  });
});
