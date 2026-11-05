#!/usr/bin/env bun
/**
 * What Hearth's streams hold, counted from storage: the whole active range (pi-durable 1.4.0) versus
 * a bounded window (1.5.0's `ConversationWindow`), per conversation and summed.
 *
 *   bun scripts/diag/window-cost.ts ~/.hearth/backups/hearth-YYYY-MM-DD.sqlite
 *
 * Answers "what would a window save on this host's data?" without running a harness. Measured
 * 2026-11-04: 275 MB → 93 MB across 168 conversations; the 12 most recently active hold 20 MB of it.
 */
import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/diag/window-cost.ts <hearth.sqlite>");
  process.exit(2);
}
const db = new Database(path, { readonly: true });
const toMb = (row: unknown): number => Number((row as { b?: number } | undefined)?.b ?? 0) / 1048576;

const rows: Array<{ id: number; active: number; window: number; last: number }> = [];
for (const { id } of db.query("select id from conversations").all() as Array<{ id: number }>) {
  const tail = (db.query("select max(id) as t from entries where conversation_id=?").get(id) as { t?: number } | undefined)?.t;
  if (tail === undefined) continue;
  // The active range: from the newest head marker's covered range (compaction), through the tail.
  const head = db
    .query("select id, head from entries where conversation_id=? and head is not null and id<=? order by id desc limit 1")
    .get(id, tail) as { id: number; head: number } | undefined;
  const active = head
    ? db
        .query(
          "select coalesce(sum(length(record)),0) as b from entries where conversation_id=? and id>=? and id<=? and (head is null or id=?)"
        )
        .get(id, head.head, tail, head.id)
    : db.query("select coalesce(sum(length(record)),0) as b from entries where conversation_id=?").get(id);
  const window = db
    .query("select coalesce(sum(length(record)),0) as b from (select record from entries where conversation_id=? order by id desc limit 100)")
    .get(id);
  rows.push({ id, active: toMb(active), window: toMb(window), last: tail });
}

const sum = (xs: typeof rows, key: "active" | "window"): number => xs.reduce((total, row) => total + row[key], 0);
console.log(`all ${rows.length} watched: active ${sum(rows, "active").toFixed(0)} MB -> window(100) ${sum(rows, "window").toFixed(0)} MB`);
rows.sort((a, b) => b.last - a.last);
for (const n of [12, 20, 40]) {
  const recent = rows.slice(0, n);
  console.log(`  ${n} most recently active: ${sum(recent, "active").toFixed(0)} MB -> window ${sum(recent, "window").toFixed(0)} MB`);
}
const largest = [...rows].sort((a, b) => b.active - a.active).slice(0, 3);
console.log(
  `largest active: ${largest.map((r) => `${r.id} ${r.active.toFixed(1)}MB->${r.window.toFixed(1)}MB`).join(", ")}`
);
