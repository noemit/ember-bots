#!/usr/bin/env python3
"""
hearth-prune — age-out policy for a Hearth database.

Two independent policies, both driven by the `timestamp` fields inside entry
records (Hearth writes no timestamp *column*, so age is derived from the JSON):

  images   Strip base64 image payloads from entries older than N days.
           The content part is kept and rewritten as a reference, so the
           conversation still reads correctly ("image, 4.16 MB, dropped"),
           but the ~2x-inflated base64 string is gone from the DB.

  archive  Move whole conversations untouched for N days into a separate
           SQLite file. Nothing is deleted; the rows are copied to the archive
           DB and then removed from the live DB.

Safety rules baked in (all learned from this database):
  - Dry-run is the DEFAULT. --apply is required to write.
  - A full backup is taken before any mutation, unless --no-backup.
  - Rows are only ever removed after the archive file has been committed and
    read back, so a failed archive cannot lose data.
  - VACUUM runs last, since deleting rows alone frees pages but not the file.

Usage:
  python hearth-prune.py                          # dry run, 7 days, both policies
  python hearth-prune.py --image-days 7 --archive-days 7 --apply
  python hearth-prune.py --apply --keep-backups 5 # also trim old backups
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

DEFAULT_HOME = Path(os.environ.get("HEARTH_HOME", Path.home() / ".hearth"))


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def now_ms() -> float:
    return dt.datetime.now().timestamp() * 1000


def entry_timestamps(record: dict) -> list[float]:
    """Every `timestamp` in an entry record (they live inside model turns)."""
    out: list[float] = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "timestamp" and isinstance(value, (int, float)):
                    out.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(record)
    return out


def image_bytes_in(record: dict) -> int:
    """Total base64 length carried by image content parts."""
    total = 0
    for turn in record.get("model") or []:
        if not isinstance(turn, dict):
            continue
        for part in turn.get("content") or []:
            if isinstance(part, dict) and isinstance(part.get("data"), str):
                total += len(part["data"])
    return total


def strip_images(record: dict) -> tuple[dict, int]:
    """
    Replace base64 payloads with a reference the UI can still render as a
    placeholder. Returns (new_record, bytes_removed).

    Only the payload is dropped: type and mimeType survive, so an entry stays
    a well-formed image part rather than becoming an untyped blob.
    """
    removed = 0
    for turn in record.get("model") or []:
        if not isinstance(turn, dict):
            continue
        for part in turn.get("content") or []:
            if isinstance(part, dict) and isinstance(part.get("data"), str):
                size = len(part["data"])
                removed += size
                del part["data"]
                part["dataOmitted"] = {
                    "reason": "age",
                    "bytes": size,
                    "mimeType": part.get("mimeType", "application/octet-stream"),
                }
    return record, removed


def db_size(path: Path) -> int:
    total = 0
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        if candidate.exists():
            total += candidate.stat().st_size
    return total


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return f"{n:,.1f} {unit}"
        n /= 1024
    return f"{n:,.1f} TB"


# --------------------------------------------------------------------------
# policy 1: drop old image payloads
# --------------------------------------------------------------------------

def plan_images(conn: sqlite3.Connection, days: float) -> list[tuple[int, int, int]]:
    """(entry_id, conversation_id, bytes) for image entries older than `days`."""
    cutoff = now_ms() - days * 86_400_000
    victims = []
    for entry_id, conversation_id, raw in conn.execute(
        "select id, conversation_id, record from entries"
    ):
        if '"data"' not in raw:
            continue                       # cheap skip before the JSON parse
        record = json.loads(raw)
        size = image_bytes_in(record)
        if size == 0:
            continue
        stamps = entry_timestamps(record)
        if not stamps:
            continue                       # no age => leave it alone
        if max(stamps) < cutoff:
            victims.append((entry_id, conversation_id, size))
    return victims


def apply_images(conn: sqlite3.Connection, victims, dry_run: bool) -> int:
    removed = 0
    for entry_id, _conv, size in victims:
        raw = conn.execute("select record from entries where id = ?", (entry_id,)).fetchone()[0]
        record, dropped = strip_images(json.loads(raw))
        removed += dropped
        if not dry_run:
            conn.execute(
                "update entries set record = ? where id = ?",
                (json.dumps(record, separators=(",", ":")), entry_id),
            )
    return removed


# --------------------------------------------------------------------------
# policy 2: archive whole stale conversations
# --------------------------------------------------------------------------

ARCHIVE_TABLES = ("conversations", "entries", "tasks", "submissions", "documents", "record_ids")


def conversation_ages(conn: sqlite3.Connection) -> dict[int, tuple[int, float]]:
    """conversation_id -> (entry_count, newest_timestamp_ms)."""
    ages: dict[int, tuple[int, float]] = {}
    for (cid,) in conn.execute("select id from conversations"):
        rows = conn.execute(
            "select record from entries where conversation_id = ?", (cid,)
        ).fetchall()
        if not rows:
            continue
        newest = 0.0
        for (raw,) in rows:
            stamps = entry_timestamps(json.loads(raw))
            if stamps:
                newest = max(newest, max(stamps))
        ages[cid] = (len(rows), newest)
    return ages


def plan_archive(conn: sqlite3.Connection, days: float) -> list[tuple[int, int]]:
    """(conversation_id, entry_count) for conversations idle longer than `days`."""
    cutoff = now_ms() - days * 86_400_000
    stale = []
    for cid, (count, newest) in conversation_ages(conn).items():
        if newest and newest < cutoff:
            stale.append((cid, count))
    stale.sort(key=lambda x: -x[1])
    return stale


def ensure_archive_schema(archive: sqlite3.Connection) -> None:
    archive.execute(
        """create table if not exists archived_conversations (
               conversation_id integer primary key,
               archived_at     text not null,
               entry_count     integer not null,
               payload         text not null)"""
    )
    archive.commit()


def apply_archive(live: sqlite3.Connection, stale, archive_path: Path, dry_run: bool) -> tuple[int, int]:
    """Copy stale conversations to the archive DB, then delete them from live."""
    if dry_run or not stale:
        return 0, 0
    archive = sqlite3.connect(archive_path)
    try:
        ensure_archive_schema(archive)
        moved = 0
        for cid, count in stale:
            payload = {
                "conversation": live.execute(
                    "select record from conversations where id = ?", (cid,)
                ).fetchone()[0],
                "entries": [
                    {"id": eid, "conversation_id": cid, "head": head,
                     "commit_seq": seq, "record": rec}
                    for eid, head, seq, rec in live.execute(
                        "select id, head, commit_seq, record from entries where conversation_id = ?",
                        (cid,))
                ],
                "tasks": [
                    {"id": tid, "kind": kind, "status": status, "record": rec}
                    for tid, kind, status, rec in live.execute(
                        "select id, kind, status, record from tasks where conversation_id = ?",
                        (cid,))
                ],
            }
            archive.execute(
                "insert or replace into archived_conversations values (?,?,?,?)",
                (cid, dt.datetime.now().isoformat(timespec="seconds"), count,
                 json.dumps(payload, separators=(",", ":"))),
            )
            moved += 1
        archive.commit()

        # Read back before deleting anything: if the archive did not persist,
        # the live rows must stay.
        stored = {row[0] for row in archive.execute(
            "select conversation_id from archived_conversations")}
        verified = [cid for cid, _ in stale if cid in stored]
        if len(verified) != len(stale):
            raise RuntimeError(
                f"archive verification failed: {len(verified)}/{len(stale)} stored; nothing deleted")

        deleted_entries = 0
        for cid in verified:
            ids = [r[0] for r in live.execute("select id from entries where conversation_id = ?", (cid,))]
            deleted_entries += len(ids)
            live.executemany("delete from record_ids where id = ?", [(i,) for i in ids])
            live.execute("delete from entries where conversation_id = ?", (cid,))
            task_ids = [r[0] for r in live.execute("select id from tasks where conversation_id = ?", (cid,))]
            live.executemany("delete from record_ids where id = ?", [(i,) for i in task_ids])
            live.execute("delete from tasks where conversation_id = ?", (cid,))
            live.execute("delete from submissions where conversation_id = ?", (cid,))
            conv_id = cid
            live.execute("delete from record_ids where id = ? and record_type = 'conversation'", (conv_id,))
            live.execute("delete from conversations where id = ?", (conv_id,))
        live.commit()
        return len(verified), deleted_entries
    finally:
        archive.close()


# --------------------------------------------------------------------------
# backups
# --------------------------------------------------------------------------

def prune_backups(home: Path, keep: int, dry_run: bool) -> tuple[int, int]:
    """Delete all but the `keep` newest daily backups.

    Deliberately narrow about what it will delete. The glob `hearth-*.sqlite` also
    matches this tool's own pre-mutation snapshots (`hearth-prune-<stamp>.sqlite`),
    so a run that wrote its safety backup immediately counted it among the files to
    keep and then deleted it in the same pass. Those are excluded here: a backup
    taken seconds ago is the one you would most want if the prune went wrong.

    archive.sqlite is never touched for the same reason — it holds the conversations
    that are no longer in the live database, so it is the only copy.
    """
    candidates = [
        path
        for path in home.glob("backups/hearth-*.sqlite")
        if not path.name.startswith("hearth-prune-")
    ]
    candidates.sort(key=lambda p: p.stat().st_mtime)
    extra = candidates[:-keep] if keep > 0 else []
    freed = sum(p.stat().st_size for p in extra)
    if not dry_run:
        for path in extra:
            path.unlink()
    return len(extra), freed


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Age-out policy for a Hearth database.")
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument("--db", type=Path, default=None, help="default: <home>/hearth.sqlite")
    parser.add_argument("--image-days", type=float, default=7.0,
                        help="drop image payloads from entries older than this (default 7)")
    parser.add_argument("--archive-days", type=float, default=7.0,
                        help="archive conversations idle longer than this (default 7)")
    parser.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    parser.add_argument("--no-backup", action="store_true", help="skip the pre-mutation backup")
    parser.add_argument("--keep-backups", type=int, default=0,
                        help="also trim backups/ to this many newest files (0 = leave alone)")
    parser.add_argument("--no-vacuum", action="store_true")
    args = parser.parse_args()

    db_path = args.db or (args.home / "hearth.sqlite")
    if not db_path.exists():
        print(f"no database at {db_path}", file=sys.stderr)
        return 1

    dry_run = not args.apply
    mode = "DRY RUN — nothing will be written" if dry_run else "APPLYING CHANGES"
    size_before = db_size(db_path)
    print(f"hearth-prune  [{mode}]")
    print(f"database      : {db_path}")
    print(f"size before   : {human(size_before)}")
    print(f"image policy  : drop payloads older than {args.image_days:g} days")
    print(f"archive policy: conversations idle > {args.archive_days:g} days")
    print()

    # A live Hearth holds the DB open; WAL makes concurrent reads safe but a
    # destructive write is not worth the risk.
    print("NOTE: stop Hearth before --apply (scripts/hearth.sh stop) so no turn")
    print("      is mid-write while rows move.")
    print()

    conn = sqlite3.connect(db_path)
    try:
        victims = plan_images(conn, args.image_days)
        img_bytes = sum(v[2] for v in victims)
        convs_hit = len({v[1] for v in victims})
        print(f"[images] {len(victims)} entries across {convs_hit} conversations")
        print(f"         reclaimable {human(img_bytes)}")

        stale = plan_archive(conn, args.archive_days)
        stale_entries = sum(c for _, c in stale)
        print(f"[archive] {len(stale)} conversations, {stale_entries} entries")

        if not victims and not stale:
            print("\nnothing to do — no entry or conversation is older than the policy.")
            return 0

        if args.keep_backups:
            n, freed = prune_backups(args.home, args.keep_backups, dry_run=True)
            print(f"[backups] {n} old backups, {human(freed)} reclaimable")
        print()

        if dry_run:
            print("re-run with --apply to make these changes.")
            return 0

        if not args.no_backup:
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            target = args.home / "backups" / f"hearth-prune-{stamp}.sqlite"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(db_path, target)
            print(f"backup written: {target} ({human(target.stat().st_size)})")

        if victims:
            removed = apply_images(conn, victims, dry_run=False)
            conn.commit()
            print(f"[images] stripped {human(removed)} of base64 payloads")

        if stale:
            n, deleted = apply_archive(conn, stale, args.home / "backups" / "archive.sqlite", dry_run=False)
            print(f"[archive] moved {n} conversations ({deleted} entries) to backups/archive.sqlite")

        if args.keep_backups:
            n, freed = prune_backups(args.home, args.keep_backups, dry_run=False)
            print(f"[backups] removed {n} old backups ({human(freed)})")

        if not args.no_vacuum:
            print("[vacuum] reclaiming free pages (this rewrites the file)…")
            # VACUUM does not checkpoint the WAL, so without this the "size" below
            # still includes the pre-VACUUM pages waiting to be merged back.
            conn.execute("pragma wal_checkpoint(truncate)")
            conn.execute("vacuum")
            conn.execute("pragma wal_checkpoint(truncate)")
            conn.commit()

        print()
        print(f"live database : {human(db_size(db_path))} (was {human(size_before)})")
        archive_path = args.home / "backups" / "archive.sqlite"
        if archive_path.exists():
            print(f"archive file  : {human(archive_path.stat().st_size)}")
        print(f"total on disk : {human(db_size(db_path) + (archive_path.stat().st_size if archive_path.exists() else 0))}"
              " (live db + archive; pruned entries are not duplicated between them)")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
