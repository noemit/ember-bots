import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  CommandWatch,
  TAG_ENV,
  briefCommand,
  hostMemory,
  leftoverNote,
  leftoversFrom,
  megabytes,
  parseRss,
  parseStat,
  pressureOf,
  resetProcessCache,
  scanLeftovers,
  snapshotLinux,
  tagOf,
  windowsTimeToMs,
  type ProcessRow,
} from "../src/processes";
import { watchBash } from "../src/leftovers";
import type { ToolRegistration } from "@earendil-works/pi-durable";

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-proc-"));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  resetProcessCache();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `/proc` with the files `snapshotLinux` reads. The real ones are the same shape, which is the
 * point: everything subtle here (a `comm` with a space, a missing environ, an orphan) is a case a
 * machine has and a test can build.
 */
const writeProc = (root: string, pid: number, options: {
  ppid: number;
  command?: string;
  comm?: string;
  conversation?: number;
  rssKb?: number;
  startTicks?: number;
  environ?: boolean;
}): void => {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  const comm = options.comm ?? options.command ?? "proc";
  // Fields 3..22 as the kernel writes them: state ppid pgrp session tty tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime.
  writeFileSync(
    join(dir, "stat"),
    `${pid} (${comm}) S ${options.ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${options.startTicks ?? 100}`
  );
  writeFileSync(join(dir, "cmdline"), options.command === undefined ? "" : `${options.command.split(" ").join("\0")}\0`);
  writeFileSync(join(dir, "status"), `Name:\t${comm}\nVmRSS:\t${options.rssKb ?? 1024} kB\n`);
  if (options.environ !== false) {
    writeFileSync(
      join(dir, "environ"),
      `${options.conversation === undefined ? "" : `${TAG_ENV}=${options.conversation}\0`}PATH=/usr/bin\0`
    );
  }
};

describe("reading a process table", () => {
  test("the stat fields are counted from the last parenthesis", () => {
    // A comm with a space and parentheses: `split(" ")` misnumbers every field after it.
    const stat = `42 (npm exec (weird) thing) S 7 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345`;
    expect(parseStat(stat)).toEqual({ ppid: 7, startTicks: 12345 });
  });

  test("the tag is the conversation id, and a malformed one is not a tag", () => {
    expect(tagOf(`PATH=/usr/bin\0${TAG_ENV}=17\0HOME=/root\0`)).toBe(17);
    expect(tagOf(`PATH=/usr/bin\0HOME=/root\0`)).toBeUndefined();
    expect(tagOf(`${TAG_ENV}=\0`)).toBeUndefined();
    expect(tagOf(`${TAG_ENV}=zero\0`)).toBeUndefined();
  });

  test("memory is read in bytes, and a missing line is zero", () => {
    expect(parseRss("Name:\tbash\nVmRSS:\t   2048 kB\n")).toBe(2 * 1024 * 1024);
    expect(parseRss("Name:\tbash\n")).toBe(0);
  });

  test("a command line is one short line, and an empty one still says something", () => {
    expect(briefCommand("node   --flag\n  value")).toBe("node --flag value");
    expect(briefCommand("x".repeat(300)).length).toBe(160);
    expect(briefCommand("")).toBe("(no command line)");
  });

  test("sizes are the ones a person reads", () => {
    expect(megabytes(0)).toBe("0 B");
    expect(megabytes(512)).toBe("1 KB");
    expect(megabytes(325 * 1024 * 1024)).toBe("325 MB");
    expect(megabytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("what counts as left behind", () => {
  test("a command in flight is not a leftover; an orphan is", () => {
    const root = tempDir();
    // 100 is this "Hearth": a running command's shell is its child, the orphan's chain ends at init.
    writeProc(root, 100, { ppid: 1, comm: "hearth" });
    writeProc(root, 200, { ppid: 100, command: "bash -lc make", conversation: 7 });
    writeProc(root, 300, { ppid: 200, command: "vite --port 5179", conversation: 7, rssKb: 320_000 });
    writeProc(root, 400, { ppid: 1, command: "thumbserve.py", conversation: 7, rssKb: 23_000 });
    writeProc(root, 500, { ppid: 1, command: "someone-elses", conversation: 8 });
    writeProc(root, 600, { ppid: 1, command: "untagged" });

    const grouped = leftoversFrom(snapshotLinux({ procRoot: root }), 100);
    expect([...grouped.keys()].sort()).toEqual([7, 8]);
    // 300 runs *inside* the live command (its chain reaches Hearth), so it is that command's work,
    // not something left behind; 400 was reparented when its shell exited, so it is.
    expect(grouped.get(7)?.map((entry) => entry.pid)).toEqual([400]);
    expect(grouped.get(7)?.[0]?.command).toBe("thumbserve.py");
    expect(grouped.get(7)?.[0]?.rssBytes).toBe(23_000 * 1024);
  });

  test("a process left by a previous Hearth run is still attributed", () => {
    const root = tempDir();
    // The old Hearth (90) is gone; the process it started is now init's child, tag intact.
    writeProc(root, 100, { ppid: 1, comm: "hearth" });
    writeProc(root, 900, { ppid: 1, command: "playwright-mcp", conversation: 12 });
    const grouped = leftoversFrom(snapshotLinux({ procRoot: root }), 100);
    expect(grouped.get(12)?.map((entry) => entry.pid)).toEqual([900]);
  });

  test("an unreadable environ is skipped, not guessed at", () => {
    const root = tempDir();
    writeProc(root, 100, { ppid: 1, comm: "hearth" });
    writeProc(root, 300, { ppid: 1, command: "root-owned", conversation: 7, environ: false });
    expect(leftoversFrom(snapshotLinux({ procRoot: root }), 100).size).toBe(0);
  });
});

describe("the memory pressure a client renders", () => {
  test("the levels are ratios, above the point of failure", () => {
    const total = 16 * 1024 ** 3;
    expect(pressureOf({ totalBytes: total, availableBytes: 8 * 1024 ** 3 })).toBe("normal");
    expect(pressureOf({ totalBytes: total, availableBytes: 2.2 * 1024 ** 3 })).toBe("normal");
    expect(pressureOf({ totalBytes: total, availableBytes: 1.5 * 1024 ** 3 })).toBe("low");
    expect(pressureOf({ totalBytes: total, availableBytes: 0.7 * 1024 ** 3 })).toBe("critical");
    // A host that reports nothing is not a crisis.
    expect(pressureOf({ totalBytes: 0, availableBytes: 0 })).toBe("normal");
  });

  test("host memory carries its own level", () => {
    const memory = hostMemory({
      read: () => ({ totalBytes: 1000, availableBytes: 10 }),
    });
    expect(memory).toEqual({ totalBytes: 1000, availableBytes: 10, level: "critical" });
  });
});

describe("the line an agent reads", () => {
  const leftovers = [
    { pid: 300, command: "vite --port 5179", rssBytes: 320 * 1024 * 1024, startedAt: 1 },
    { pid: 400, command: "thumbserve.py", rssBytes: 23 * 1024 * 1024, startedAt: 2 },
  ];

  test("it names the processes, the cost and the command that ends them", () => {
    const note = leftoverNote(leftovers);
    expect(note).toContain("vite --port 5179");
    expect(note).toContain("pid 300");
    expect(note).toContain("320 MB");
    expect(note).toContain("kill 300 400");
    // What the human can do, so the agent knows the cost of leaving it.
    expect(note).toContain("Stop button");
  });

  test("it never becomes a wall of text", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      pid: 500 + index,
      command: `worker-${index}`,
      rssBytes: 1024,
      startedAt: 0,
    }));
    const note = leftoverNote(many);
    expect(note).toContain("and 4 more");
    expect(note).toContain("kill 500 501 502 503 504 505 506 507 508");
  });
});

describe("telling a platform's time apart", () => {
  test("WMI and CIM both become epoch milliseconds", () => {
    expect(windowsTimeToMs("/Date(1712345678901)/")).toBe(1712345678901);
    expect(windowsTimeToMs("2024-04-05T17:34:38.901Z")).toBe(1712338478901);
    expect(windowsTimeToMs("nonsense")).toBe(0);
  });
});

describe("the ledger, where /proc is not available", () => {
  const returns: Array<() => void> = [];
  afterEach(() => {
    for (const undo of returns.splice(0)) undo();
  });
  const row = (pid: number, ppid: number, createdAt: number, command = "worker"): ProcessRow => ({
    pid,
    ppid,
    command,
    rssBytes: 1024,
    startedAt: createdAt,
  });

  /**
   * The ledger is fed by what the *shell* reported, not by what a poll happened to see.
   *
   * The tests here used to model a watch observing a child while it was still attached. That design
   * could not work — for a command that finishes in milliseconds there is no moment to observe — so
   * it was replaced (see `CommandWatch`). What remains to pin is the reading half: a reported pid
   * that is alive and no longer ours becomes a leftover, and one whose identity changed does not.
   */
  const withReport = (pids: number[], run: (finish: () => void) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-ledger-"));
    const path = join(dir, "cmd.pids");
    writeFileSync(path, pids.join("\n"));
    returns.push(() => rmSync(dir, { recursive: true, force: true }));
    return path;
  };

  test("a reported process that outlives the command is recorded, a dead one is not", () => {
    // Real epoch milliseconds: the ledger ages rows out, so a synthetic `1000` is already ancient.
    const t0 = Date.now() - 60_000;
    const table: ProcessRow[] = [row(1, 0, 0, "init"), row(10, 1, 0, "hearth"), row(30, 1, t0 + 100, "vite")];
    const path = withReport([30, 31], () => {});
    const watch = new CommandWatch({ conversationId: 5, selfPid: 10, reportPath: path, list: () => table });
    watch.start()();
    const scan = scanLeftovers({ platform: "win32", list: () => table, fresh: true });
    // 30 survived; 31 was reported but is gone.
    expect(scan.byConversation.get(5)?.map((entry) => entry.pid)).toEqual([30]);
  });

  test("a reported pid that is now a different process is not attributed", () => {
    // The identity is (pid, startedAt): a recycled pid must not inherit the conversation's blame.
    const watch = new CommandWatch({ conversationId: 5, selfPid: 10, reportPath: withReport([30], () => {}), list: () => [] });
    watch.start()();
    // Nothing alive at all, so nothing recorded — the same outcome a stale pid gets.
    expect(scanLeftovers({ platform: "win32", list: () => [], fresh: true }).all).toEqual([]);
  });
});

describe("the note a bash wrapper appends", () => {
  const tool = (output: string): ToolRegistration => ({
    name: "bash",
    description: "test",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ output: [{ type: "text", text: output }] }),
  } as unknown as ToolRegistration);

  const api = { conversationId: 7 as never } as never;
  const context = {} as never;
  const leftovers = [{ pid: 300, command: "vite --port 5179", rssBytes: 320 * 1024 * 1024, startedAt: 1 }];

  test("it is appended when the command left something behind", async () => {
    const scanned: Array<Map<number, typeof leftovers>> = [new Map(), new Map([[7, leftovers]])];
    const wrapped = watchBash(tool("started"), {
      platform: "linux",
      scan: () => ({ byConversation: scanned.shift() ?? new Map(), all: [] }),
    });
    const result = (await wrapped.execute({}, api, context)) as { output: Array<{ type: string; text: string }> };
    expect(result.output).toHaveLength(2);
    expect(result.output[1]?.text).toContain("vite --port 5179");
    expect(result.output[1]?.text).toContain("kill 300");
  });

  test("a leftover that was already running is not mentioned again", async () => {
    const already = new Map([[7, leftovers]]);
    const wrapped = watchBash(tool("just checking"), { platform: "linux", scan: () => ({ byConversation: already, all: [] }) });
    const result = (await wrapped.execute({}, api, context)) as { output: Array<{ type: string; text: string }> };
    expect(result.output).toHaveLength(1);
    expect(result.output[0]?.text).toBe("just checking");
  });

  test("an error result keeps its error and still says what is running", async () => {
    const failing = { ...tool(""), execute: async () => ({ output: [{ type: "text", text: "exit 1" }], isError: true }) } as unknown as ToolRegistration;
    const scanned: Array<Map<number, typeof leftovers>> = [new Map(), new Map([[7, leftovers]])];
    const wrapped = watchBash(failing, { platform: "linux", scan: () => ({ byConversation: scanned.shift() ?? new Map(), all: [] }) });
    const result = (await wrapped.execute({}, api, context)) as { isError?: boolean; output: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.output.at(-1)?.text).toContain("Left running");
  });

  test("a tool without a conversation is left alone", async () => {
    let calls = 0;
    const wrapped = watchBash(tool("hi"), {
      platform: "linux",
      scan: () => {
        calls += 1;
        return { byConversation: new Map(), all: [] };
      },
    });
    await wrapped.execute({}, { conversationId: undefined } as never, context);
    expect(calls).toBe(0);
  });
});

describe("a real process, stopped the way the route stops it", () => {
  test("SIGTERM ends it, and SIGTERM that is ignored is still there", async () => {
    // The route's mechanics, not its HTTP: signal, then poll for the deadline.
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });
    const pid = child.pid!;
    try {
      // The signal must arrive after `trap` runs, or the shell dies before it ignores anything.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(process.kill(pid, 0)).toBe(true);
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 150));
      // It ignored the polite request — the "refused" outcome the client turns into Force stop.
      expect(process.kill(pid, 0)).toBe(true);
      process.kill(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
