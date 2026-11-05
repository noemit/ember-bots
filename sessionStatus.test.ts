import { describe, expect, test } from 'bun:test';
import { deriveSessionStatus, STALL_AFTER_MS } from './src/lib/sessionStatus';
import type { BallState, Session } from './src/types';

/** A worker stub whose `lead` points at the leader in these cases. */
const worker = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  instanceId: 'hearth',
  kind: 'worker',
  lead: { instanceId: 'hearth', sessionId: 'leader' },
  ...extra,
});

/** A trivial lookup: every worker is in `state`, unless the case says otherwise. */
const states = (state: BallState) => () => state;

describe('deriveSessionStatus', () => {
  test('a running turn reads as working, whatever the crew is doing', () => {
    expect(deriveSessionStatus({ state: 'active' })).toEqual({ kind: 'working', text: 'Working…' });
    expect(deriveSessionStatus({ state: 'idle', busy: true })).toEqual({
      kind: 'working',
      text: 'Working…',
    });
    expect(deriveSessionStatus({ state: 'idle', sending: true })).toEqual({
      kind: 'working',
      text: 'Working…',
    });
    // Streaming output can arrive before the status poll catches up.
    expect(
      deriveSessionStatus({ state: 'idle', busy: true, workers: [worker('w1')], workerStateFor: states('active') })
    ).toEqual({ kind: 'working', text: 'Working…' });
  });

  test('an idle leader waits on one worker, singular', () => {
    expect(
      deriveSessionStatus({ state: 'idle', workers: [worker('w1')], workerStateFor: states('active') })
    ).toEqual({ kind: 'waiting-crew', text: 'Waiting on 1 worker…' });
  });

  test('an idle leader waits on two workers, plural', () => {
    expect(
      deriveSessionStatus({
        state: 'idle',
        workers: [worker('w1'), worker('w2')],
        workerStateFor: states('active'),
      })
    ).toEqual({ kind: 'waiting-crew', text: 'Waiting on 2 workers…' });
  });

  test('an idle leader with no workers renders nothing', () => {
    expect(deriveSessionStatus({ state: 'idle' })).toBeNull();
    expect(deriveSessionStatus({ state: 'idle', workers: [] })).toBeNull();
  });

  test('a resting crew (idle or reported) renders nothing, since nothing more is coming', () => {
    expect(
      deriveSessionStatus({ state: 'idle', workers: [worker('w1')], workerStateFor: states('idle') })
    ).toBeNull();
  });

  test('a worker waiting on input is not "working" for an idle leader, but is still an open wait', () => {
    const status = deriveSessionStatus({
      state: 'idle',
      workers: [worker('w1', { needsInput: true })],
      workerStateFor: states('idle'),
    });
    expect(status).toEqual({ kind: 'waiting-crew', text: 'Waiting on 1 worker…' });
    expect(status?.kind).not.toBe('working');
  });

  test('a pending question asks for a reply only when its card is not already in the transcript', () => {
    expect(deriveSessionStatus({ state: 'idle', pendingPrompt: 'question' })).toEqual({
      kind: 'needs-reply',
      text: 'Waiting for your reply…',
    });
    expect(
      deriveSessionStatus({ state: 'idle', pendingPrompt: 'permission', promptCardVisible: true })
    ).toBeNull();
  });

  test('a pending prompt outranks a crew wait: the user is the blocker', () => {
    expect(
      deriveSessionStatus({
        state: 'idle',
        pendingPrompt: 'permission',
        workers: [worker('w1')],
        workerStateFor: states('active'),
      })
    ).toEqual({ kind: 'needs-reply', text: 'Waiting for your reply…' });
  });
});

/**
 * A live turn that has produced nothing for a long time is the one failure mode the UI cannot see:
 * a wedged run and a model reasoning hard are, from the client, the same picture. These pin the
 * threshold, the copy, and — most importantly — that it never fires without a real measurement.
 */
describe('a silent live turn', () => {
  const T = 1_000_000;
  /** What `deriveSessionStatus` should call the quiet stretch, derived from the same constant. */
  const minutesOf = (quietFor: number) => `${Math.floor(quietFor / 60_000)}m`;

  test('a busy turn inside the threshold is still just working', () => {
    expect(
      deriveSessionStatus({ state: 'active', busy: true, quietSince: T, now: T + STALL_AFTER_MS - 1 })
    ).toEqual({ kind: 'working', text: 'Working…' });
  });

  test('a busy turn past the threshold says how long it has been quiet', () => {
    const quietFor = STALL_AFTER_MS + 30_000;
    const status = deriveSessionStatus({
      state: 'active',
      busy: true,
      quietSince: T,
      now: T + quietFor,
    });
    expect(status?.kind).toBe('stalled');
    expect(status?.text).toContain(minutesOf(quietFor));
  });

  test('at exactly the threshold the duration is whole minutes, not "5m 0s"', () => {
    const status = deriveSessionStatus({
      state: 'active',
      busy: true,
      quietSince: T,
      now: T + STALL_AFTER_MS,
    });
    expect(status?.kind).toBe('stalled');
    // Once the threshold is minutes the seconds are noise: it names the minute it is on. The rest of
    // the sentence is pinned verbatim — the register was deliberate.
    expect(status?.text).toBe(
      `No new output for ${minutesOf(STALL_AFTER_MS)}. It may still be thinking, or the run may be stuck — Stop is below.`
    );
    expect(status?.text).not.toContain(' 0s');
  });

  test('it never asserts failure: it names both readings and points at the exit', () => {
    const status = deriveSessionStatus({
      state: 'active',
      busy: true,
      quietSince: T,
      now: T + STALL_AFTER_MS + 1_000,
    });
    const text = status?.kind === 'stalled' ? status.text : '';
    // "may still be thinking" — it does not claim the run is broken.
    expect(text.toLowerCase()).toContain('thinking');
    expect(text.toLowerCase()).toContain('stuck');
    // And it offers the one thing the reader can do about it.
    expect(text).toContain('Stop');
    // No shouting, no jargon, per the copy rule.
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/\b(error|failed|timeout)\b/i);
  });

  test('without a measurement it stays quiet rather than guessing', () => {
    // A caller that cannot say when the turn last moved must not produce a stall out of nothing.
    expect(deriveSessionStatus({ state: 'active', busy: true }).kind).toBe('working');
    expect(deriveSessionStatus({ state: 'active', busy: true, quietSince: T }).kind).toBe('working');
    expect(deriveSessionStatus({ state: 'active', busy: true, now: T }).kind).toBe('working');
  });

  test('an idle session never stalls, however long the clock runs', () => {
    expect(
      deriveSessionStatus({ state: 'idle', busy: false, quietSince: 0, now: STALL_AFTER_MS * 10 })
    ).toBeNull();
  });
});

describe('a status the host has not answered for', () => {
  test('is its own state, and says who went quiet and what still works', () => {
    const status = deriveSessionStatus({ state: 'unknown', instanceLabel: 'Tower' });
    expect(status?.kind).toBe('unknown');
    const text = status?.text ?? '';
    // Names the actor: the instance that did not answer, not "this session".
    expect(text).toContain('Tower');
    // Offers the action that is still available, so it is not a dead end.
    expect(text.toLowerCase()).toContain('send');
    // Says what the reader can conclude…
    expect(text.toLowerCase()).toContain('unknown');
    // …and never claims to know what the agent is doing.
    expect(text).not.toMatch(/working|thinking|idle/i);
    // Copy rules: no jargon, no shouting, no stray values.
    expect(text).not.toContain('!');
    expect(text).not.toMatch(/\b(undefined|null|NaN|error)\b/i);
  });

  test('without a label it still names an actor', () => {
    expect(deriveSessionStatus({ state: 'unknown' })?.text).toMatch(/^The host hasn't answered/);
  });

  test('a known live turn outranks it, and a known idle session is still quiet', () => {
    // Direct evidence beats a missing poll: the transcript says a turn is running.
    expect(deriveSessionStatus({ state: 'unknown', busy: true })?.kind).toBe('working');
    expect(deriveSessionStatus({ state: 'unknown', sending: true })?.kind).toBe('working');
    // And a session that answered "idle" is still idle — this did not turn quiet sessions loud.
    expect(deriveSessionStatus({ state: 'idle' })).toBeNull();
  });

  test('a pending prompt is knowledge, so it wins over the missing status', () => {
    expect(
      deriveSessionStatus({ state: 'unknown', pendingPrompt: 'permission', promptCardVisible: false })?.kind
    ).toBe('needs-reply');
    // With the card on screen the line would only repeat it.
    expect(
      deriveSessionStatus({ state: 'unknown', pendingPrompt: 'permission', promptCardVisible: true })?.kind
    ).toBe('unknown');
  });

  test('a crew whose host has not answered is not reported as a plain wait', () => {
    const status = deriveSessionStatus({
      state: 'idle',
      workers: [worker('w1')],
      workerStateFor: states('unknown'),
    });
    expect(status?.kind).toBe('waiting-crew');
    expect(status?.text.toLowerCase()).toContain('unknown');
    // A known working worker keeps the ordinary wording.
    expect(
      deriveSessionStatus({ state: 'idle', workers: [worker('w1')], workerStateFor: states('active') })?.text
    ).toBe('Waiting on 1 worker…');
  });
});
