import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandWatch, listPosixProcesses, parseElapsed, readReportedPids } from "../src/processes";
import { leftoverRecorderSuffix } from "../src/shell";

/**
 * The macOS path of "what did this command leave running".
 *
 * Three versions of this mechanism shipped before one worked, so the shape is pinned here:
 *
 * 1. a poll every 1500ms — looked before the spawn, and after the reparent
 * 2. a poll every 250ms — same, because there is no moment in between for a 3ms command
 * 3. **the shell reports its own children**, which is what this file tests
 *
 * The earlier version of this test was worse than useless: it asserted a counter it incremented
 * itself, so it passed while the feature was broken. Everything below reads real state.
 */

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-leftovers-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parsing ps elapsed time", () => {
  test("the shapes ps emits", () => {
    // `ps` prints mm:ss under an hour — there is no bare-seconds form to accept.
    expect(parseElapsed("00:05")).toBe(5_000);
    expect(parseElapsed("01:05")).toBe(65_000);
    expect(parseElapsed("02:01:05")).toBe(7_265_000);
    expect(parseElapsed("3-02:01:05")).toBe(((3 * 24 + 2) * 60 * 60 + 60 + 5) * 1_000);
  });

  test("something unparseable is null, not the epoch", () => {
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("n/a")).toBeNull();
    expect(parseElapsed("1:2:3:4:5")).toBeNull();
  });
});

describe("ps rows carry a real start time", () => {
  test("elapsed becomes an age relative to now", () => {
    const rows = listPosixProcesses({ run: () => "  4242     1   8192 01:05 sleep 60\n", now: () => 1_000_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe(4242);
    expect(rows[0]?.rssBytes).toBe(8192 * 1024);
    expect(rows[0]?.startedAt).toBe(1_000_000 - 65_000);
  });

  test("a row whose etime cannot be read is dropped, not given a wrong age", () => {
    expect(listPosixProcesses({ run: () => "  7     1   100 not-a-time bash\n", now: () => 5 })).toHaveLength(0);
  });
});

describe("what the shell reports", () => {
  test("the recorder writes $! and jobs -p to $HEARTH_LEFTOVERS", () => {
    const suffix = leftoverRecorderSuffix();
    expect(suffix).toContain("HEARTH_LEFTOVERS");
    expect(suffix).toContain("$!");
    expect(suffix).toContain("jobs -p");
    // Never touches the command's exit status: appending to a `&&` chain or a failing command must
    // not change what the tool reports.
    expect(suffix.trimEnd().endsWith("true")).toBe(true);
    expect(suffix).not.toContain("exit");
  });

  test("the recorder really records a background job, in bash", () => {
    const dir = tempDir();
    const report = join(dir, "cmd.pids");
    // Exactly the shape the tool builds: the user's command, a newline, then the recorder.
    const script = `sleep 3 &\n${leftoverRecorderSuffix()}`;
    const run = Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, HEARTH_LEFTOVERS: report },
    });
    expect(run.exitCode).toBe(0);
    const pids = readReportedPids(report);
    expect(pids.length).toBeGreaterThanOrEqual(1);
    // A pid the test can see is a pid it can clean up.
    expect(pids[0]).toBeGreaterThan(1);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("the exit status survives the suffix", () => {
    const dir = tempDir();
    const report = join(dir, "cmd.pids");
    const run = Bun.spawnSync(["bash", "-c", `exit 7\n${leftoverRecorderSuffix()}`], {
      env: { ...process.env, HEARTH_LEFTOVERS: report },
    });
    // The command's own status, not the recorder's.
    expect(run.exitCode).toBe(7);
  });

  test("without the variable nothing is written anywhere", () => {
    const dir = tempDir();
    const run = Bun.spawnSync(["bash", "-c", `sleep 0.1 &\n${leftoverRecorderSuffix()}`], {
      env: { ...process.env, HEARTH_LEFTOVERS: "" },
    });
    expect(run.exitCode).toBe(0);
  });
});

describe("CommandWatch attributes what the report names", () => {
  test("a reported pid that is still alive becomes this conversation's leftover", () => {
    const dir = tempDir();
    const report = join(dir, "cmd.pids");
    writeFileSync(report, "4242\n4243\n");
    const watch = new CommandWatch({
      conversationId: 9,
      selfPid: 1,
      reportPath: report,
      // 4242 survived, reparented to init; 4243 is gone.
      list: () => [{ pid: 4242, ppid: 0, command: "sleep 60", rssBytes: 8192, startedAt: 1_000 }],
    });
    const finish = watch.start();
    finish();
    expect(watch.recorded).toBe(1);
  });

  test("a pid still parented to Hearth is not a leftover", () => {
    const dir = tempDir();
    const report = join(dir, "cmd.pids");
    writeFileSync(report, "4242\n");
    const watch = new CommandWatch({
      conversationId: 9,
      selfPid: 1,
      reportPath: report,
      // ppid 1 === selfPid: the command has not really exited.
      list: () => [{ pid: 4242, ppid: 1, command: "still running", rssBytes: 1, startedAt: 1 }],
    });
    watch.start()();
    expect(watch.recorded).toBe(0);
  });

  test("a missing report is zero, not an error", () => {
    const watch = new CommandWatch({
      conversationId: 9,
      selfPid: 1,
      reportPath: join(tempDir(), "never-written.pids"),
      list: () => [],
    });
    watch.start()();
    expect(watch.recorded).toBe(0);
  });

  test("junk in the report is ignored", () => {
    const dir = tempDir();
    const report = join(dir, "cmd.pids");
    writeFileSync(report, "not-a-pid\n0\n-3\n1\n4242\n");
    expect(readReportedPids(report)).toEqual([4242]);
  });
});
