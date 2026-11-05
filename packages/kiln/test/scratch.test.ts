import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureScratchDir, pruneScratch, scratchDirFor, scratchRoot } from "../src/scratch";

const disposers: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-scratch-"));
  disposers.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of disposers.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

describe("a session's scratch directory", () => {
  test("it lives under the host's own home, named after the conversation", () => {
    const dir = home();
    const scratch = scratchDirFor(dir, 42);
    expect(scratch).toBe(join(dir, "tmp", "conversation-42"));
    expect(scratchRoot(dir)).toBe(join(dir, "tmp"));
    ensureScratchDir(dir, 42);
    expect(existsSync(scratch)).toBe(true);
  });

  test("using it marks it as used, so a running session is not reaped", () => {
    const dir = home();
    const scratch = ensureScratchDir(dir, 7, 0)!;
    const old = new Date(Date.now() - 30 * DAY);
    utimesSync(scratch, old, old);
    ensureScratchDir(dir, 7, Date.now());
    // A sweep that runs right after must leave it alone even though it was created long ago.
    const result = pruneScratch(dir, { ttlMs: 3 * DAY });
    expect(result.removed).toEqual([]);
    expect(existsSync(scratch)).toBe(true);
  });

  test("a read-only home is a fallback, not a failed command", () => {
    // `/proc/self` exists and cannot take a directory: the caller gets no path and keeps the
    // platform's own TMPDIR rather than every command failing.
    expect(ensureScratchDir("/proc/self", 1)).toBeUndefined();
  });
});

describe("sweeping stale scratch", () => {
  test("an old directory goes, with its size reported; a fresh one stays", () => {
    const dir = home();
    const stale = ensureScratchDir(dir, 1)!;
    const fresh = ensureScratchDir(dir, 2)!;
    mkdirSync(join(stale, "nested"), { recursive: true });
    writeFileSync(join(stale, "dump.json"), "x".repeat(2048));
    writeFileSync(join(stale, "nested", "more.bin"), "x".repeat(1024));
    const old = new Date(Date.now() - 5 * DAY);
    utimesSync(join(stale, "dump.json"), old, old);
    utimesSync(join(stale, "nested", "more.bin"), old, old);
    // A directory's own mtime moves when its entries change, so it has to be aged as well.
    utimesSync(join(stale, "nested"), old, old);
    utimesSync(stale, old, old);

    const result = pruneScratch(dir, { ttlMs: 3 * DAY });
    expect(result.removed).toEqual(["conversation-1"]);
    expect(result.bytes).toBeGreaterThanOrEqual(3072);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("a directory holding something newer than the threshold survives whole", () => {
    // A long job that keeps writing must not have its working directory removed under it.
    const dir = home();
    const scratch = ensureScratchDir(dir, 3)!;
    const old = new Date(Date.now() - 10 * DAY);
    writeFileSync(join(scratch, "old.txt"), "a");
    utimesSync(join(scratch, "old.txt"), old, old);
    utimesSync(scratch, old, old);
    writeFileSync(join(scratch, "in-progress.tmp"), "b");
    expect(pruneScratch(dir, { ttlMs: 3 * DAY }).removed).toEqual([]);
    expect(existsSync(join(scratch, "old.txt"))).toBe(true);
  });

  test("an empty or missing root is not an error", () => {
    const dir = home();
    expect(pruneScratch(dir).removed).toEqual([]);
  });
});
