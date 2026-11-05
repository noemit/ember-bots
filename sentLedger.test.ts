import { expect, test } from 'bun:test';
import {
  missingSent,
  recordSent,
  PENDING_SEND_TTL_MS,
  SENT_LEDGER_GRACE_MS,
  type SentLedger,
} from './src/lib/sentLedger';
import type { ChatMessage } from './src/types';

const user = (id: string, text: string): ChatMessage => ({
  id,
  role: 'user',
  text,
  parts: [{ type: 'text', id: `${id}-t`, text }],
  completed: true,
});
const assistant = (id: string): ChatMessage => ({ id, role: 'assistant', text: 'hi', parts: [], completed: true });

test('missingSent flags a send absent from the transcript, past grace and not pending', () => {
  const ledger: SentLedger = new Map();
  recordSent(ledger, 'k', { id: 'c1', text: 'hello', at: 1000 });
  // Inside the grace window: not flagged.
  expect(missingSent(ledger, 'k', [], new Set(), 1000 + 5_000)).toEqual([]);
  // Past grace and absent: flagged.
  expect(missingSent(ledger, 'k', [assistant('a1')], new Set(), 1000 + 20_000).map((record) => record.id)).toEqual([
    'c1',
  ]);
});

test('missingSent clears when present by id or outgoing shape, or still pending', () => {
  const ledger: SentLedger = new Map();
  recordSent(ledger, 'k', { id: 'c1', text: 'hello', at: 0 });
  recordSent(ledger, 'k', { id: 'c2', text: 'world', at: 0 });
  const now = 20_000;
  // c1 present by id; c2 present by outgoing shape under a fresh server id.
  expect(missingSent(ledger, 'k', [user('c1', 'hello'), user('srv-2', 'world')], new Set(), now)).toEqual([]);
  // Pending sends are suppressed.
  expect(missingSent(ledger, 'k', [], new Set(['c1', 'c2']), now)).toEqual([]);
});

test('missingSent prunes records older than the TTL', () => {
  const ledger: SentLedger = new Map();
  recordSent(ledger, 'k', { id: 'old', text: 'x', at: 0 });
  expect(missingSent(ledger, 'k', [], new Set(), 10 * 60_000)).toEqual([]);
  expect(ledger.get('k')).toEqual([]);
});

/**
 * A placed send whose echo never lands used to be invisible to this ledger: the id stayed pending
 * for the life of the process, and pending was a structural exemption. Pending now means what it
 * says — an echo is on its way — and an aged one is reported like anything else.
 */
test('an aged pending send is reported instead of being exempt for ever', () => {
  const ledger: SentLedger = new Map();
  recordSent(ledger, 'k', { id: 'c1', text: 'never echoed', at: 0 });
  const pending = new Set(['c1']);
  // Young pending: the echo is plausibly on its way, so nothing is claimed.
  expect(missingSent(ledger, 'k', [], pending, SENT_LEDGER_GRACE_MS + 1_000)).toEqual([]);
  expect(missingSent(ledger, 'k', [], pending, PENDING_SEND_TTL_MS - 1)).toEqual([]);
  // Past the pending TTL the bubble may be the only trace there ever was.
  const reported = missingSent(ledger, 'k', [], pending, PENDING_SEND_TTL_MS + 1);
  expect(reported.map((record) => record.id)).toEqual(['c1']);
  expect(reported[0].text).toBe('never echoed');
});

test('a pending send that is on screen is not reported, however old', () => {
  const ledger: SentLedger = new Map();
  recordSent(ledger, 'k', { id: 'c1', text: 'unconfirmed bubble', at: 0 });
  // The bubble says "Not confirmed" itself; the ledger has nothing to add.
  expect(missingSent(ledger, 'k', [user('c1', 'unconfirmed bubble')], new Set(['c1']), PENDING_SEND_TTL_MS * 2)).toEqual([]);
});
