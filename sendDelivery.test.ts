import { describe, expect, test } from 'bun:test';
import {
  abortReceiptOf,
  deliveryAfterAcceptance,
  steerAbandoned,
  stopHeldMessage,
  submitOutcomeOf,
  UNCONFIRMED_SEND_MS,
} from './src/lib/sendDelivery';

/**
 * The send path has no clock. These tests pin the three-way answer a submit may give and the
 * delivery state the bubble ends in: a 2xx is confirmation (queued or placed), a definite failure
 * is the only reason to offer a retry, and nothing about elapsed time can turn a sent message
 * doubtful.
 */

test('a busy follow-up is accepted as queued, naming its submission id', () => {
  const outcome = submitOutcomeOf({ submissionId: 42, status: 'queued', mode: 'followUp' });
  expect(outcome).toEqual({ kind: 'accepted', queued: true, steer: false, submissionId: '42' });
});

test('a queued steer is accepted as queued and as a steer, so it keeps a factual note', () => {
  const outcome = submitOutcomeOf({ submissionId: 7, status: 'queued', mode: 'steer' });
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') return;
  expect(outcome.queued).toBe(true);
  expect(outcome.steer).toBe(true);
  // A steered message stays in the transcript: `queued` here is the note, never doubt.
  expect(deliveryAfterAcceptance(outcome)).toBe('queued');
});

test('a placed message is unconfirmed, not sent: the echo is what proves it', () => {
  const outcome = submitOutcomeOf({ submissionId: 3, status: 'placed', mode: 'followUp' });
  expect(outcome).toEqual({ kind: 'accepted', queued: false, steer: false, submissionId: '3' });
  // A 2xx says the host took it. It does not say the message is in the conversation, and a placed
  // send whose echo never lands used to render as an ordinary sent message for ever, then vanish on
  // reload with no notice. `unconfirmed` is the state that admits the difference.
  expect(deliveryAfterAcceptance(outcome)).toBe('unconfirmed');
  expect(UNCONFIRMED_SEND_MS).toBeGreaterThan(0);
});

test('a queued follow-up carries a queued note; the caller moves the bubble to its queue row', () => {
  const outcome = submitOutcomeOf({ submissionId: 9, status: 'queued', mode: 'followUp' });
  expect(outcome.kind).toBe('accepted');
  // The note is not what decides the destination: `sendTo` moves a queued follow-up out of the
  // transcript (the queue row is its home) before this value could show. Asserting the value keeps
  // the two readings from drifting apart.
  expect(deliveryAfterAcceptance(outcome)).toBe('queued');
});

test('a 2xx with no status field is still confirmation', () => {
  // An older wire answers with nothing useful; the answer itself is what confirms the send.
  expect(submitOutcomeOf({}).kind).toBe('accepted');
  expect(submitOutcomeOf(null).kind).toBe('accepted');
  expect(submitOutcomeOf('ok').kind).toBe('accepted');
});

test('an explicit rejected submission is a definite failure, not a queued message', () => {
  const outcome = submitOutcomeOf({ status: 'rejected', error: 'inbox is full' });
  expect(outcome).toEqual({ kind: 'failed', error: 'inbox is full' });
});

test('steer is read from the request when the wire does not name a mode', () => {
  const outcome = submitOutcomeOf({ submissionId: 5, status: 'queued' }, { steer: true });
  expect(outcome.kind === 'accepted' && outcome.steer).toBe(true);
});

test('nothing about a send is timing-based', async () => {
  // The optimistic bubble starts as `sending` and only the server's answer moves it. A queued
  // message's echo can take as long as the running turn does, so there is deliberately no clock
  // here: no timer, no elapsed time, nothing that could turn a sent message into doubt.
  const source = await Bun.file(new URL('./src/lib/sendDelivery.ts', import.meta.url)).text();
  expect(source).not.toContain('setTimeout');
  expect(source).not.toContain('setInterval');
  expect(source).not.toContain('Date.now');
  expect(source).not.toContain('elapsed');
});

/**
 * A steer is held by the host until the turn's next boundary, and a turn that is *stopped* never
 * reaches one — pi-durable settles queued inputs `unanswered` and drops them. The bubble then waits
 * forever, pinned to the bottom of the transcript, so later messages appear above it. This is the
 * predicate that decides when to call that: conservatively, or it accuses a message that landed.
 */
describe('a steer that can no longer be placed', () => {
  const base = { delivery: 'queued' as const, createdAt: 1_000, sessionBusy: false, landed: false, now: 12_000 };

  test('fires once the session is idle past the grace', () => {
    expect(steerAbandoned(base)).toBe(true);
  });

  test('never fires while the turn still runs, or inside the grace', () => {
    expect(steerAbandoned({ ...base, sessionBusy: true })).toBe(false);
    expect(steerAbandoned({ ...base, now: 1_000 + 5_000 })).toBe(false);
  });

  test('never fires for text that is already on the transcript or in the queue', () => {
    expect(steerAbandoned({ ...base, landed: true })).toBe(false);
  });

  test('never fires for a request still in flight or one already reported failed', () => {
    for (const delivery of ['sending', 'failed', undefined] as const) {
      expect(steerAbandoned({ ...base, delivery })).toBe(false);
    }
    expect(steerAbandoned({ ...base, createdAt: undefined })).toBe(false);
  });
});

/**
 * A stop's receipt: Hearth withdraws every queued input and re-parks it in the same mode, then says
 * how many it kept (`parking.ts`, `server.ts`). That answer is the only evidence a client has that a
 * steer which never ran is *waiting* rather than lost — and the difference between a bubble that
 * says "Waiting for the turn to pause" and one that offers to send the message a second time.
 */
describe('a stop that kept its queue', () => {
  test('reads the parked count and previews, and tolerates a host that says nothing', () => {
    expect(abortReceiptOf(true, { ok: true, parked: 2, parkedText: ['fix the tests', 'then commit'] })).toEqual({
      ok: true,
      parked: 2,
      parkedText: ['fix the tests', 'then commit'],
    });
    expect(abortReceiptOf(true, { ok: true })).toEqual({ ok: true, parked: 0, parkedText: [] });
    expect(abortReceiptOf(false, null)).toEqual({ ok: false, parked: 0, parkedText: [] });
    expect(abortReceiptOf(true, { parked: 'two', parkedText: 'fix it' })).toEqual({
      ok: true,
      parked: 0,
      parkedText: [],
    });
  });

  const receipt = { ok: true, parked: 1, parkedText: ['Memory*'] };

  test('a kept message is matched by text, including a truncated preview', () => {
    expect(stopHeldMessage(receipt, 'Memory*')).toBe(true);
    // The host truncates its preview, so the bubble's fuller text still matches it.
    expect(stopHeldMessage(receipt, 'Memory*  and then run the suite')).toBe(true);
  });

  test('a stop that kept nothing holds nothing', () => {
    expect(stopHeldMessage({ ok: true, parked: 0, parkedText: [] }, 'Memory*')).toBe(false);
    expect(stopHeldMessage(undefined, 'Memory*')).toBe(false);
    // A preview of some other message is not this one.
    expect(stopHeldMessage({ ok: true, parked: 1, parkedText: ['something else'] }, 'Memory*')).toBe(false);
  });

  test('a message with no text cannot be told apart from a kept one, so it is treated as kept', () => {
    expect(stopHeldMessage(receipt, '   ')).toBe(true);
  });
});

describe('a steer the host still holds', () => {
  const base = {
    delivery: 'queued' as const,
    createdAt: 1_000,
    sessionBusy: false,
    landed: false,
    now: 12_000,
  };

  test('is never called abandoned, so no bubble offers to send it again', () => {
    // Nothing on the transcript or in the queue yet, and the session reads idle: every signal the
    // old predicate had says "abandoned". The receipt says otherwise, and the receipt is the truth.
    expect(steerAbandoned({ ...base, hostHolds: true })).toBe(false);
    // Without it — the host kept nothing — the bubble is an honest failure.
    expect(steerAbandoned({ ...base, hostHolds: false })).toBe(true);
  });
});

/**
 * A settlement that never reached the transcript. Hearth answers a retried `requestId` with the
 * record it already has, so an input stopped before placement comes back as a 2xx body with
 * `status: "unanswered"` and no entry. Reading that as an acceptance is how a bubble sat in the
 * transcript looking sent for a message that would never run.
 */
describe('a submission that settled without landing', () => {
  test('an unanswered submission with no entry is a definite failure, with the reason', () => {
    const outcome = submitOutcomeOf({ submissionId: 12, status: 'unanswered', mode: 'followUp', reason: 'aborted' });
    expect(outcome).toEqual({ kind: 'failed', error: 'aborted' });
    expect(submitOutcomeOf({ submissionId: 12, status: 'unanswered' }).kind).toBe('failed');
  });

  test('an error message is preferred over the reason, and a bare settlement still fails', () => {
    expect(submitOutcomeOf({ status: 'unanswered', error: 'provider failed', reason: 'stale' })).toEqual({
      kind: 'failed',
      error: 'provider failed',
    });
    expect(submitOutcomeOf({ status: 'unanswered' })).toEqual({ kind: 'failed', error: undefined });
  });

  test('an unanswered submission that did place an entry is in the conversation, not a failure', () => {
    // It ran, then was stopped: the message exists and the transcript holds it.
    const outcome = submitOutcomeOf({ submissionId: 12, status: 'unanswered', mode: 'followUp', entry: 880 });
    expect(outcome.kind).toBe('accepted');
  });

  test('a write entry answered `done` is an ordinary acceptance', () => {
    const outcome = submitOutcomeOf({ submissionId: 13, status: 'done', mode: 'write' });
    expect(outcome.kind).toBe('accepted');
  });
});
