import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { TAG_ENV } from "./processes";

/**
 * A session's temporary files, on disk and bounded.
 *
 * Agents write scratch to `/tmp` — screenshots, JSON dumps, downloaded archives, and on 2026-11-03 a
 * video job whose intermediate files came to **4.7 GB**. On Linux `/tmp` is tmpfs on the usual
 * desktop/container image, so that is anonymous memory: it pushed 4.7 GB of the host into swap, and
 * killing processes did not give any of it back (measured on Heliograph 2026-11-04: `Shmem` 42 MB
 * against 5.7 GB of tmpfs, five of six GB in swap). Nothing in Hearth bounded it either — the
 * default `systemd-tmpfiles` rule only removes files older than ten days.
 *
 * So each conversation's commands get a `TMPDIR` under `HEARTH_HOME/tmp`, on the same disk as the
 * database, named after the conversation. `pruneScratch` removes one that has not been touched for
 * `ttlMs`, and the host calls it at boot and once a day. A directory counts as touched while
 * anything inside it is newer than the threshold, so a long job that keeps writing is never removed
 * from under itself.
 *
 * This does not stop an agent typing `/tmp/...` explicitly — the copy in the prompt says what `/tmp`
 * is on this host — but every ordinary tool (a Python `tempfile`, a build's `TMPDIR`, a shell `mktemp`)
 * follows the environment and lands here.
 */

export const scratchRoot = (home: string): string => join(home, "tmp");

/** One conversation's scratch space; the caller passes this to the session's shell as `TMPDIR`. */
export const scratchDirFor = (home: string, conversationId: number): string => join(scratchRoot(home), `conversation-${conversationId}`);

/** Create (or make sure of) a conversation's scratch directory and mark it as just used. */
export const ensureScratchDir = (home: string, conversationId: number, now = Date.now()): string | undefined => {
  const dir = scratchDirFor(home, conversationId);
  try {
    mkdirSync(dir, { recursive: true });
    // The directory's own mtime only changes when an entry is added or removed, and a process that
    // appends to one file for a day would otherwise look abandoned. `pruneScratch` reads mtimes
    // anyway; touching it here keeps a session that is merely *running* out of the reaper's way.
    utimesSync(dir, new Date(now), new Date(now));
    return dir;
  } catch {
    // A scratch directory is a convenience: without one, commands fall back to the platform's own
    // TMPDIR rather than failing, so a read-only `HEARTH_HOME` must not break every command.
    return undefined;
  }
};

/**
 * The environment every command of one conversation runs with: the tag that makes what it leaves
 * running attributable (`src/processes.ts`), and a `TMPDIR` on disk instead of `/tmp`.
 *
 * `TMP`, `TEMP` and `TMPDIR` are all set because the three platforms disagree about which one they
 * read, and a tool that reads the "wrong" one silently falls back to the platform's temp directory —
 * which is the memory-backed one this exists to avoid.
 */
export const sessionEnv = (home: string, conversationId: number, now = Date.now()): Record<string, string> => {
  const dir = ensureScratchDir(home, conversationId, now);
  return {
    [TAG_ENV]: String(conversationId),
    ...(dir === undefined ? {} : { TMPDIR: dir, TMP: dir, TEMP: dir }),
  };
};

/** The newest mtime inside `dir`, or the directory's own when it is empty/unreadable. */
const newestTouch = (dir: string, fallback: number): number => {
  let newest = fallback;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const info = statSync(path);
      newest = Math.max(newest, info.mtimeMs);
      // One level deeper covers `tmp/work/...` without walking a tree an agent may have filled with
      // a build's thousands of files; a directory's mtime moves when its entries change anyway.
      if (info.isDirectory()) {
        for (const child of readdirSync(path)) {
          try {
            newest = Math.max(newest, statSync(join(path, child)).mtimeMs);
          } catch {
            // vanished between readdir and stat
          }
        }
      }
    } catch {
      // vanished between readdir and stat
    }
  }
  return newest;
};

export type PruneResult = { removed: string[]; bytes: number };

/** Size of a directory tree, bounded so a reaper cannot spend longer measuring than removing. */
const dirBytes = (dir: string, budget = 20_000): number => {
  let total = 0;
  let visited = 0;
  const walk = (path: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= budget) return;
      visited += 1;
      const child = join(path, entry);
      try {
        const info = statSync(child);
        if (info.isDirectory()) walk(child);
        else total += info.size;
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  walk(dir);
  return total;
};

/**
 * Remove scratch entries that have not been touched for `ttlMs`. Returns what went, so the caller
 * can log one line instead of quietly reclaiming gigabytes.
 */
export const pruneScratch = (
  home: string,
  options: { ttlMs?: number; now?: number } = {}
): PruneResult => {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 3 * 24 * 60 * 60 * 1000;
  const root = scratchRoot(home);
  const removed: string[] = [];
  let bytes = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed, bytes };
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let touched: number;
    try {
      const info = statSync(path);
      touched = info.isDirectory() ? newestTouch(path, info.mtimeMs) : info.mtimeMs;
      if (now - touched < ttlMs) continue;
      bytes += info.isDirectory() ? dirBytes(path) : info.size;
    } catch {
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // A locked file is not worth failing a sweep over; the next one tries again.
    }
  }
  return { removed, bytes };
};
