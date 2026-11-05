import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { COST_PRICED_TITLE, COST_UNKNOWN_LABEL, COST_UNKNOWN_TITLE, hostReportsCost, sessionCostState } from './src/lib/sessionCost';

const chatView = fs.readFileSync(path.join(import.meta.dir, 'src/components/ChatView.tsx'), 'utf8');

describe('sessionCostState', () => {
  test('a session that has never run reports nothing', () => {
    expect(sessionCostState(0, false)).toEqual({ kind: 'none' });
    expect(sessionCostState(undefined, false)).toEqual({ kind: 'none' });
  });

  test('a priced session keeps its number', () => {
    expect(sessionCostState(0.0042, true)).toEqual({ kind: 'priced', cost: 0.0042 });
    // Even a session whose transcript has not loaded yet is priced when the host says so.
    expect(sessionCostState(1.5, false)).toEqual({ kind: 'priced', cost: 1.5 });
  });

  test('a session that ran with a zero ledger is unknown, not free', () => {
    // This is the live case (7 of 99 conversations): entries exist, usage totals 0 because the
    // provider does not price the model. The old `cost > 0` test rendered nothing here.
    expect(sessionCostState(0, true)).toEqual({ kind: 'unknown' });
  });

  test('a host that sends no cost at all is unknown once the session has run', () => {
    expect(sessionCostState(undefined, true)).toEqual({ kind: 'unknown' });
  });

  test('a nonsense number is not treated as spend', () => {
    expect(sessionCostState(Number.NaN, true)).toEqual({ kind: 'unknown' });
    expect(sessionCostState(Number.POSITIVE_INFINITY, true)).toEqual({ kind: 'unknown' });
    expect(sessionCostState(-1, true)).toEqual({ kind: 'unknown' });
  });
});

describe('cost copy', () => {
  test('the unknown state says "unknown" and never claims zero', () => {
    expect(COST_UNKNOWN_LABEL.toLowerCase()).toContain('unknown');
    expect(COST_UNKNOWN_LABEL).not.toContain('$');
    expect(COST_UNKNOWN_TITLE).not.toContain('$0');
  });

  test('the tooltip names the actor and what it reported', () => {
    expect(COST_UNKNOWN_TITLE).toContain('ember-harness');
    expect(COST_UNKNOWN_TITLE.toLowerCase()).toContain('usage ledger');
    expect(COST_UNKNOWN_TITLE.toLowerCase()).toMatch(/reported no cost/);
    // Says what the reader can conclude, rather than "an error occurred".
    expect(COST_UNKNOWN_TITLE.toLowerCase()).toContain('may not price');
    expect(COST_UNKNOWN_TITLE).not.toContain('null');
    expect(COST_UNKNOWN_TITLE).not.toContain('undefined');
    expect(COST_UNKNOWN_TITLE).not.toContain('!');
  });

  test('the priced tooltip still names the ledger', () => {
    expect(COST_PRICED_TITLE.toLowerCase()).toContain('usage ledger');
  });
});

describe('the badge is wired to all three states', () => {
  test('the old `cost > 0` gate is gone, so an unpriced ran session is not silent', () => {
    // The badge used to be `typeof session?.cost === 'number' && session.cost > 0`, which is exactly
    // the condition that hid the live unpriced case.
    expect(chatView).not.toContain('session.cost > 0');
    expect(chatView).toContain("costState.kind === 'priced'");
    expect(chatView).toContain("costState.kind === 'unknown'");
    expect(chatView).toContain('COST_UNKNOWN_LABEL');
  });

  test('"has run" comes from the transcript, not from the cost itself', () => {
    expect(chatView).toContain('sessionCostState(session?.cost, messages.length > 0)');
  });

  test('an OpenChamber column draws no cost state at all', () => {
    // Not `unknown`: that badge claims the host tried and reported nothing. This host has nothing to
    // report, so the state is `none` and no badge is drawn.
    expect(chatView).toContain('hostReportsCost(instance?.kind)');
    expect(chatView).toContain("({ kind: 'none' } as const)");
  });
});

/**
 * Which hosts report spend at all.
 *
 * The badge promises one thing: what this session cost, from a ledger that priced it. Hearth's
 * usage ledger does exactly that. An OpenChamber instance also sends a per-message `cost`, but it is
 * the model's rate applied to its own token counts — an estimate that has never been reconciled
 * against a provider's invoice — and the badge has no way to say which of the two it is showing.
 *
 * So OpenChamber sessions show nothing. Not "Cost unknown": that claims the host tried and reported
 * nothing, which is a different fact from "this host does not report spend".
 */
describe('which hosts report spend', () => {
  test('Hearth does, and only Hearth', () => {
    expect(hostReportsCost('pi')).toBe(true);
    for (const kind of ['local', 'remote', 'ssh', 'relay', undefined]) {
      expect(hostReportsCost(kind)).toBe(false);
    }
  });

  test('an OpenChamber session with a real cost number still shows nothing', () => {
    // The number exists — this is not the "unknown" case — but it is not the kind of number the
    // badge claims to show, so the column takes the `none` path and draws nothing.
    const host = 'local';
    const state = hostReportsCost(host)
      ? sessionCostState(0.42, true)
      : ({ kind: 'none' } as const);
    expect(state).toEqual({ kind: 'none' });
    // Hearth's own path is untouched.
    expect(sessionCostState(0.42, true)).toEqual({ kind: 'priced', cost: 0.42 });
  });
});
