/**
 * The deadline on a session's leftover programs.
 *
 * Two facts drive this whole module, and both come from the host having no expiry of its own:
 *
 *   - a leftover program runs until *something* stops it, so Ember's own deadline is the only thing
 *     that ends one on time — and it only works while Ember is running;
 *   - the deadline is counted from when the program started, not from when Ember noticed it, so a
 *     window opened an hour later finds more of them due rather than granting a fresh ninety minutes.
 *
 * The countdown wording is pinned here too, because "expiring in 80 min" is what the tray shows
 * instead of a start time: the useful number is how long there is to decide, not when it began.
 */
import { describe, expect, test } from 'bun:test';
import {
  deadlineTitle,
  expiryLabel,
  minutesLeft,
  msUntilNextDeadline,
  planReaping,
  processExpiry,
  processKey,
  reapRetryDelay,
  PROCESS_EXTENSION_MS,
  PROCESS_LIFETIME_MS,
  soonestExpiry,
} from './src/lib/processExpiry';

const MINUTE = 60_000;
const started = 1_700_000_000_000;

describe('the deadline', () => {
  test('is ninety minutes from when the program started', () => {
    expect(PROCESS_LIFETIME_MS).toBe(90 * MINUTE);
    const expiry = processExpiry(started, started);
    expect(expiry.expiresAt).toBe(started + 90 * MINUTE);
    expect(expiry.remainingMs).toBe(90 * MINUTE);
    expect(expiry.expired).toBe(false);
  });

  test('counts down rather than restarting when Ember looks again', () => {
    // Ten minutes in, eighty are left: reopening the window does not reset the clock.
    expect(minutesLeft(processExpiry(started, started + 10 * MINUTE).remainingMs)).toBe(80);
    // Reopened a day later: already overdue, not freshly granted.
    expect(processExpiry(started, started + 24 * 60 * MINUTE).expired).toBe(true);
  });

  test('an extension is added, not substituted', () => {
    const once = processExpiry(started, started, PROCESS_EXTENSION_MS);
    const twice = processExpiry(started, started, PROCESS_EXTENSION_MS * 2);
    expect(once.expiresAt).toBe(started + 90 * MINUTE + 10 * MINUTE);
    expect(twice.expiresAt).toBe(started + 90 * MINUTE + 20 * MINUTE);
  });

  test('a negative extension cannot shorten the life', () => {
    expect(processExpiry(started, started, -60 * MINUTE).expiresAt).toBe(started + 90 * MINUTE);
  });

  test('is overdue exactly at the deadline, not a millisecond after', () => {
    expect(processExpiry(started, started + 90 * MINUTE).expired).toBe(true);
    expect(processExpiry(started, started + 90 * MINUTE - 1).expired).toBe(false);
  });
});

describe('the countdown', () => {
  test('reads in minutes, rounded up so "1 min" is still time to act', () => {
    expect(expiryLabel(80 * MINUTE)).toBe('expiring in 80 min');
    expect(expiryLabel(59_000)).toBe('expiring in 1 min');
    expect(expiryLabel(1)).toBe('expiring in 1 min');
  });

  test('never says "0 min"', () => {
    expect(expiryLabel(0)).toBe('expiring now');
    expect(expiryLabel(-5 * MINUTE)).toBe('expiring now');
  });

  test('says which clock time when asked for the detail', () => {
    const title = deadlineTitle(started + 90 * MINUTE, started);
    expect(title).toContain('Ember stops this at');
    // The clock time as this locale spells it, not a fixed 24-hour assumption.
    const expected = new Date(started + 90 * MINUTE).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(title).toContain(expected);
  });
});

describe('the session countdown', () => {
  test('is the earliest deadline among its programs', () => {
    const early = processExpiry(started, started);
    const late = processExpiry(started + 30 * MINUTE, started);
    expect(soonestExpiry([late, early])).toBe(early);
  });

  test('is nothing when nothing is running', () => {
    expect(soonestExpiry([])).toBeNull();
  });
});

describe('what to reap', () => {
  const candidate = (over: Partial<Parameters<typeof planReaping>[0][number]> = {}) => ({
    instanceId: 'hearth',
    sessionId: 's1',
    extensionMs: 0,
    processes: [{ pid: 10, startedAt: started }],
    ...over,
  });

  test('only the expired pids, and only their sessions', () => {
    const plan = planReaping(
      [
        candidate(),
        candidate({ sessionId: 's2', processes: [{ pid: 20, startedAt: started + 60 * MINUTE }] }),
      ],
      started + 91 * MINUTE
    );
    expect(plan).toEqual([{ instanceId: 'hearth', sessionId: 's1', pids: [10] }]);
  });

  test('a granted extension keeps the program out of it', () => {
    const plan = planReaping([candidate({ extensionMs: 10 * MINUTE })], started + 95 * MINUTE);
    expect(plan).toEqual([]);
    // ...until ten minutes are up too.
    expect(planReaping([candidate({ extensionMs: 10 * MINUTE })], started + 101 * MINUTE)).toEqual([
      { instanceId: 'hearth', sessionId: 's1', pids: [10] },
    ]);
  });

  test('a session with nothing due is absent rather than empty', () => {
    expect(planReaping([candidate()], started)).toEqual([]);
  });
});

describe('when to wake next', () => {
  const candidate = (processes: { pid: number; startedAt: number }[], extensionMs = 0) => ({
    instanceId: 'hearth',
    sessionId: 's1',
    extensionMs,
    processes,
  });

  test('is the soonest deadline, not a fixed poll', () => {
    expect(msUntilNextDeadline([candidate([{ pid: 1, startedAt: started }])], started, 60 * MINUTE)).toBe(
      60 * MINUTE
    );
    // Two programs: the earlier one decides.
    expect(
      msUntilNextDeadline(
        [candidate([{ pid: 1, startedAt: started + 60 * MINUTE }, { pid: 2, startedAt: started }])],
        started + 89 * MINUTE,
        60 * MINUTE
      )
    ).toBe(1 * MINUTE);
  });

  test('is zero once something is overdue, so the tick happens at once', () => {
    expect(msUntilNextDeadline([candidate([{ pid: 1, startedAt: started }])], started + 200 * MINUTE)).toBe(0);
  });

  test('is nothing at all when there is nothing running', () => {
    expect(msUntilNextDeadline([], started)).toBeNull();
    expect(msUntilNextDeadline([candidate([])], started)).toBeNull();
  });
});

/**
 * A stop that keeps failing must not become a hammer.
 *
 * An overdue program stays overdue until a stop lands, so "check again in 500ms" turns into two
 * requests a second for as long as a host is asleep. The ladder is the hook's, but the numbers it
 * climbs are worth pinning: slow enough to leave a sleeping host alone, quick enough that a host
 * that comes back is dealt with promptly.
 */
describe('the retry ladder', () => {
  test('every failure waits longer than the last', () => {
    const waits = [1, 2, 3, 4, 5, 6].map(reapRetryDelay);
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    for (let index = 1; index < waits.length; index += 1) {
      expect(waits[index]).toBeGreaterThanOrEqual(waits[index - 1]);
    }
  });

  test('it tops out rather than going quiet for ever', () => {
    // Half a minute is the ceiling: a host that comes back is reaped within the minute, and a host
    // that stays away is not asked more than twice a minute.
    expect(reapRetryDelay(20)).toBe(30_000);
  });
});

describe('filing an extension', () => {
  test('is per session, and per host', () => {
    // Two hosts can hand out the same conversation id; an extension bought on one must not lengthen
    // a deadline on the other.
    expect(processKey({ instanceId: 'hearth', id: '98' })).toBe('hearth::98');
    expect(processKey({ instanceId: 'openchamber', id: '98' })).not.toBe(
      processKey({ instanceId: 'hearth', id: '98' })
    );
    expect(processKey({ instanceId: 'hearth', id: '98' })).not.toBe(
      processKey({ instanceId: 'hearth', id: '99' })
    );
  });
});
