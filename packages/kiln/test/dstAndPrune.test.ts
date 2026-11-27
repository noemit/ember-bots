import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDue, mostRecentOccurrence, type ScheduledTask } from "../src/scheduler";

const dailyTask = (time: string, timezone: string, lastRunAt?: number): ScheduledTask => ({
  id: "daily-ny",
  name: "Morning check",
  prompt: "check status",
  schedule: { kind: "daily", time, timezone },
  enabled: true,
  createdAt: Date.UTC(2026, 0, 1),
  ...(lastRunAt !== undefined ? { lastRunAt } : {}),
});

describe("D4: daily and weekly schedules across DST transitions", () => {
  test("does not double-fire across America/New_York fall-back (Oct 31 -> Nov 1, 2026)", () => {
    // 2026-10-31 09:00 EDT = 13:00 UTC.
    const oct31Run = Date.UTC(2026, 9, 31, 13, 0, 0);
    const task = dailyTask("09:00", "America/New_York", oct31Run);

    // 2026-11-01 00:05 EDT (04:05 UTC) and 07:00 EST (12:00 UTC) are BOTH before 09:00 EST (14:00 UTC).
    for (const beforeSlot of [
      Date.UTC(2026, 10, 1, 4, 5, 0),
      Date.UTC(2026, 10, 1, 12, 0, 0),
      Date.UTC(2026, 10, 1, 13, 59, 59),
    ]) {
      expect(mostRecentOccurrence(task.schedule, beforeSlot)).toBe(oct31Run);
      expect(isDue(task, beforeSlot)).toBe(false);
    }

    // Exactly at 2026-11-01 09:00 EST (14:00 UTC), it becomes due once.
    const nov1Run = Date.UTC(2026, 10, 1, 14, 0, 0);
    expect(mostRecentOccurrence(task.schedule, nov1Run)).toBe(nov1Run);
    expect(isDue(task, nov1Run)).toBe(true);
    expect(isDue({ ...task, lastRunAt: nov1Run }, nov1Run + 60_000)).toBe(false);
  });

  test("handles America/New_York spring-forward (Mar 7 -> Mar 8, 2026) once per occurrence", () => {
    // 2026-03-07 09:00 EST = 14:00 UTC.
    const mar7Run = Date.UTC(2026, 2, 7, 14, 0, 0);
    const task = dailyTask("09:00", "America/New_York", mar7Run);

    // 2026-03-08 08:30 EDT = 12:30 UTC (before 09:00 EDT = 13:00 UTC).
    const beforeMar8 = Date.UTC(2026, 2, 8, 12, 30, 0);
    expect(mostRecentOccurrence(task.schedule, beforeMar8)).toBe(mar7Run);
    expect(isDue(task, beforeMar8)).toBe(false);

    // 2026-03-08 09:00 EDT = 13:00 UTC.
    const mar8Run = Date.UTC(2026, 2, 8, 13, 0, 0);
    expect(mostRecentOccurrence(task.schedule, mar8Run)).toBe(mar8Run);
    expect(isDue(task, mar8Run)).toBe(true);
  });
});

describe("D3: hearth-prune.py protects active/waiting conversations and archives full state", () => {
  test("skips old conversations with pending questions or queued submissions and archives idle ones completely", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-prune-d3-"));
    try {
      const dbPath = join(home, "hearth.sqlite");
      const db = new DatabaseSync(dbPath);
      const oldTs = Date.now() - 30 * 86_400_000;
      try {
        db.exec(`
          CREATE TABLE record_ids (id INTEGER PRIMARY KEY, record_type TEXT NOT NULL);
          CREATE TABLE conversations (id INTEGER PRIMARY KEY, record TEXT NOT NULL);
          CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head TEXT, commit_seq INTEGER NOT NULL, record TEXT NOT NULL);
          CREATE TABLE tasks (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
          CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL);
          CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL, key_value TEXT NOT NULL, scope_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL);
          CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (document_id, seq));
        `);

        // Conv 1: old transcript, but has a pending human question in hearth.questions -> MUST NOT archive.
        // Conv 2: old transcript, but has a queued submission -> MUST NOT archive.
        // Conv 3: old transcript, all tasks terminal, all submissions done -> MUST archive with submissions + docs.
        for (const cid of [1, 2, 3]) {
          db.prepare("INSERT INTO record_ids VALUES (?, 'conversation')").run(cid);
          db.prepare("INSERT INTO conversations VALUES (?, ?)").run(cid, JSON.stringify({ id: cid }));
          db.prepare("INSERT INTO record_ids VALUES (?, 'entry')").run(100 + cid);
          db.prepare("INSERT INTO entries VALUES (?, ?, NULL, 1, ?)").run(
            100 + cid,
            cid,
            JSON.stringify({ model: [{ role: "user", content: "hi", timestamp: oldTs }] })
          );
        }

        // Pending question doc on Conv 1.
        db.prepare("INSERT INTO documents VALUES (10, 'hearth.questions', 0, '', 'conversation', 1, 1, NULL, '{}')").run();
        db.prepare("INSERT INTO document_revisions VALUES (10, 1, 'base', 1, ?)").run(
          JSON.stringify({ items: { q1: { status: "pending", prompt: "Choose option" } } })
        );

        // Queued submission on Conv 2.
        db.prepare("INSERT INTO record_ids VALUES (200, 'submission')").run();
        db.prepare("INSERT INTO submissions VALUES (200, 2, 'req-2', 'queued', '{}')").run();

        // Settled submission + metadata doc on Conv 3.
        db.prepare("INSERT INTO record_ids VALUES (300, 'submission')").run();
        db.prepare("INSERT INTO submissions VALUES (300, 3, 'req-3', 'done', '{\"ok\":true}')").run();
        db.prepare("INSERT INTO documents VALUES (30, 'hearth.meta', 0, '', 'conversation', 3, 1, NULL, '{}')").run();
        db.prepare("INSERT INTO document_revisions VALUES (30, 1, 'base', 1, ?)").run(
          JSON.stringify({ title: "Idle archived chat" })
        );
      } finally {
        db.close();
      }

      const script = resolve(import.meta.dir, "../scripts/hearth-prune.py");
      execFileSync("python3", [script, "--home", home, "--archive-days", "7", "--apply"], {
        encoding: "utf8",
      });

      const live = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const remaining = (live.prepare("SELECT id FROM conversations ORDER BY id").all() as Array<{ id: number }>).map(
          (r) => r.id
        );
        expect(remaining).toEqual([1, 2]);
        expect(live.prepare("SELECT id FROM documents WHERE owner_id = 3").all()).toEqual([]);
      } finally {
        live.close();
      }

      const archive = new DatabaseSync(join(home, "backups", "archive.sqlite"), { readOnly: true });
      try {
        const row = archive
          .prepare("SELECT payload FROM archived_conversations WHERE conversation_id = 3")
          .get() as { payload: string } | undefined;
        expect(row).toBeDefined();
        const payload = JSON.parse(row!.payload) as {
          submissions: unknown[];
          documents: unknown[];
          document_revisions: unknown[];
        };
        expect(payload.submissions).toHaveLength(1);
        expect(payload.documents).toHaveLength(1);
        expect(payload.document_revisions).toHaveLength(1);
      } finally {
        archive.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
