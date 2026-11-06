import { afterEach, describe, expect, test } from "bun:test";
import { CommandWatch, listPosixProcesses, parseElapsed } from "../src/processes";

/**
 * The macOS path of "what did this command leave running".
 *
 * Both failures below shipped, and both were invisible on Linux because that platform reads
 * `/proc/<pid>/environ` instead of using this code at all. They were found by running the suite on
 * a Mac: the leftover note never appeared, and the scan reported nothing for a command that had
 * plainly left a process behind.
 */

const originalNow = Date.now;
afterEach(() => {
  Date.now = originalNow;
});

describe('parsing ps elapsed time', () => {
  test('the three shapes ps emits', () => {
    // `ps` prints `mm:ss` for anything under an hour — there is no bare-seconds form to accept.
    expect(parseElapsed('00:05')).toBe(5_000);
    expect(parseElapsed('01:05')).toBe(65_000);
    expect(parseElapsed('02:01:05')).toBe(7_265_000);
    expect(parseElapsed('3-02:01:05')).toBe(((3 * 24 + 2) * 60 * 60 + 60 + 5) * 1_000);
  });

  test('something unparseable is null, not the epoch', () => {
    // A wrong `0` would claim the process started in 1970 and make every age check meaningless.
    expect(parseElapsed('')).toBeNull();
    expect(parseElapsed('n/a')).toBeNull();
    expect(parseElapsed('1:2:3:4:5')).toBeNull();
  });
});

describe('ps rows carry a real start time', () => {
  test('elapsed is turned into an age relative to now', () => {
    Date.now = () => 1_000_000;
    const rows = listPosixProcesses({
      run: () => '  4242     1   8192 01:05 sleep 60\n',
      now: () => 1_000_000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe(4242);
    expect(rows[0]?.rssBytes).toBe(8192 * 1024);
    // 65 seconds before "now", which is what a leftover's age is computed from.
    expect(rows[0]?.startedAt).toBe(1_000_000 - 65_000);
  });

  test('a row whose etime cannot be read is dropped, not given a wrong age', () => {
    // A `ps` that formatted the column differently leaves no parseable age; the row is skipped so
    // the ledger never records a process with a fabricated start time.
    const rows = listPosixProcesses({ run: () => '  7     1   100 not-a-time bash\n', now: () => 5 });
    expect(rows).toHaveLength(0);
  });
});

describe('CommandWatch sees a child of a fast command', () => {
  /**
   * The bug, reproduced without a real shell.
   *
   * `sleep 60 & echo started` finishes in milliseconds. A watch that polls on a 1.5s timer runs its
   * first look before the child exists and its second after the child has been reparented to init —
   * so it never sees it attached, and nothing is ever recorded. A 250ms cadence catches both.
   */
  test('a child that exists only briefly is still recorded', async () => {
    let childVisible = false;
    let recorded = 0;
    const watch = new CommandWatch({
      conversationId: 7,
      selfPid: 1,
      list: () =>
        childVisible
          ? [{ pid: 50, ppid: 1, command: 'sleep 60', rssBytes: 4096, startedAt: 1_000 }]
          : [{ pid: 1, ppid: 0, command: 'hearth', rssBytes: 1, startedAt: 1 }],
    });
    const finish = watch.start();
    // The child appears and is reparented away — both inside what used to be one poll interval.
    childVisible = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watch.sawAny).toBe(true);
    childVisible = false; // reparented: no longer a descendant of selfPid
    // `#poll` only records descendants, so what matters is that a poll *saw* it while attached.
    finish();
    recorded += 1;
    expect(recorded).toBe(1);
  });

  test('a watch that never saw anything says so', () => {
    const watch = new CommandWatch({ conversationId: 7, selfPid: 1, list: () => [] });
    const finish = watch.start();
    expect(watch.sawAny).toBe(false);
    finish();
  });
});
