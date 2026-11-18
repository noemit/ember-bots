import { expect, test } from 'bun:test';
import { DailyUpdateChecks, UPDATE_CHECK_INTERVAL_MS as DAY, UPDATE_CHECK_JITTER_MS as JITTER, updateCheckDue } from '../electron/dailyUpdateChecks';
import { withoutDesktopOnlySettings } from '../electron/transport';

test('due policy handles fresh installs, clock rollback, invalid state and exactly one day', () => {
  const now = DAY * 10;
  for (const last of [undefined, 0, -1, '10', NaN, Infinity, now + 1, now - DAY]) expect(updateCheckDue(last, now)).toBe(true);
  for (const last of [now, now - DAY + 1]) expect(updateCheckDue(last, now)).toBe(false);
});

test('attempt receipts survive restart and failure; off suppresses automatic but not manual checks', async () => {
  let now = DAY * 10, last: unknown, enabled = true;
  const calls: boolean[] = [];
  const create = () => new DailyUpdateChecks({ enabled: () => enabled, lastAttempt: () => last, now: () => now,
    recordAttempt: async at => { last = at; }, check: async quiet => { calls.push(quiet); return { phase: 'idle', supported: true, currentVersion: '1.0.0' }; } });
  const first = create();
  await first.check(); await first.check();
  expect(calls).toEqual([true]);
  first.dispose();
  const reopened = create();
  await reopened.check(); expect(calls).toEqual([true]);
  now += DAY;
  enabled = false; await reopened.check(); expect(calls).toEqual([true]);
  await reopened.check(true); expect(calls).toEqual([true, false]);
  enabled = true; await reopened.check(); expect(calls).toHaveLength(2);
  now += DAY; await reopened.check(); expect(calls).toEqual([true, false, true]);
});

test('concurrent startup, wake and timer checks share one attempt; manual check after quiet one is explicit', async () => {
  let resolve!: () => void, last = 0;
  const calls: boolean[] = [];
  const runner = new DailyUpdateChecks({ enabled: () => true, lastAttempt: () => last, now: () => DAY,
    recordAttempt: async at => { last = at; }, check: async quiet => { calls.push(quiet); if (quiet) await new Promise<void>(r => { resolve = r; }); return { phase: 'idle', supported: true, currentVersion: '1.0.0' }; } });
  const automatic = runner.check();
  await Promise.resolve();
  const wake = runner.check(), timer = runner.check(), manual = runner.check(true);
  expect(calls).toEqual([true]);
  resolve();
  await Promise.all([automatic, wake, timer, manual]);
  expect(calls).toEqual([true, false]);
});

test('failed attempts are not retried automatically on every wake', async () => {
  let last = 0, calls = 0;
  const runner = new DailyUpdateChecks({ enabled: () => true, lastAttempt: () => last, now: () => DAY,
    recordAttempt: async at => { last = at; }, check: async () => { calls++; throw Error('offline'); } });
  await expect(runner.check()).rejects.toThrow();
  await runner.check();
  expect(calls).toBe(1);
});

test('no background request without durable receipt; manual recovery remains available', async () => {
  let calls = 0;
  const runner = new DailyUpdateChecks({ enabled: () => true, lastAttempt: () => 0,
    recordAttempt: async () => { throw Error('disk full'); }, check: async () => { calls++; return { phase: 'idle', supported: true, currentVersion: '1.0.0' }; } });
  await runner.check(); expect(calls).toBe(0);
  await runner.check(true); expect(calls).toBe(1);
  runner.dispose(); await runner.check(true); expect(calls).toBe(1);
  expect(withoutDesktopOnlySettings({ automaticUpdateChecks: false, theme: 'clay' })).toEqual({ theme: 'clay' });
});


test('daily jitter is bounded, persisted before networking and stable across restart', async () => {
  let now = DAY * 10, last = 0, next = 0, calls = 0;
  const create = (random = 0.5) => new DailyUpdateChecks({ enabled: () => true, lastAttempt: () => last, nextAttempt: () => next,
    now: () => now, random: () => random, recordAttempt: async (at, due) => { last = at; next = due; },
    check: async () => { expect(next).toBeGreaterThan(now); calls++; return { phase: 'idle', supported: true, currentVersion: '1.0.0' }; } });
  const runner = create(); await runner.check();
  expect(next).toBe(now + DAY + JITTER / 2); expect(calls).toBe(1); runner.dispose();
  const restarted = create(1); now += DAY;
  await restarted.check(); expect(calls).toBe(1);
  now = next; await restarted.check(); expect(calls).toBe(2);
  expect(next).toBe(now + DAY + JITTER);
  await restarted.check(true); expect(calls).toBe(3);
});

test('corrupt or far-future jitter cannot suppress checks indefinitely; no early checks', () => {
  const last = DAY * 10;
  expect(updateCheckDue(last, last + DAY, last + DAY + JITTER)).toBe(false);
  expect(updateCheckDue(last, last + DAY + JITTER, last + DAY + JITTER)).toBe(true);
  for (const next of [NaN, Infinity, 'future', last + DAY * 100, last - 1]) expect(updateCheckDue(last, last + DAY, next)).toBe(true);
});

test('skipping an automatic check while an update download is busy does not burn the 24h window', async () => {
  let now = DAY * 10;
  let last = 0;
  let next = 0;
  let busy = true;
  let checkCalls = 0;
  let recordCalls = 0;
  const runner = new DailyUpdateChecks({
    enabled: () => true,
    busy: () => busy,
    lastAttempt: () => last,
    nextAttempt: () => next,
    now: () => now,
    random: () => 0.5,
    recordAttempt: async (at, due) => {
      recordCalls++;
      last = at;
      next = due;
    },
    check: async () => {
      checkCalls++;
      return { phase: busy ? 'downloading' : 'idle', supported: true, currentVersion: '1.0.0' };
    },
  });

  // Automatic check while download is busy skips cleanly without persisting an attempt receipt.
  expect(await runner.check()).toBeUndefined();
  expect(recordCalls).toBe(0);
  expect(checkCalls).toBe(0);
  expect(last).toBe(0);
  expect(next).toBe(0);

  // Once the busy download finishes (e.g. failed), the automatic check runs immediately without waiting 24h.
  busy = false;
  now += 60_000;
  await runner.check();
  expect(recordCalls).toBe(1);
  expect(checkCalls).toBe(1);
  expect(last).toBe(now);
  expect(next).toBe(now + DAY + JITTER / 2);

  // Also rolls back the window if a download starts concurrently while `recordAttempt` is flushing.
  const prevLast = last;
  const prevNext = next;
  now = next;
  const raceRunner = new DailyUpdateChecks({
    enabled: () => true,
    lastAttempt: () => last,
    nextAttempt: () => next,
    now: () => now,
    random: () => 0.25,
    recordAttempt: async (at, due) => {
      last = at;
      next = due;
    },
    check: async () => ({ phase: 'downloading', progress: 50, supported: true, currentVersion: '1.0.0' }),
  });
  const skipped = await raceRunner.check();
  expect(skipped?.phase).toBe('downloading');
  expect(last).toBe(prevLast);
  expect(next).toBe(prevNext);
  expect(updateCheckDue(last, now, next)).toBe(true);
});
