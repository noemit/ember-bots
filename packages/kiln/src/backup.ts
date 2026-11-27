import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tightenPermissions } from "./permissions";

const KEEP = 30;

const dayKey = (at = new Date()): string =>
  `${at.getFullYear()}-${`${at.getMonth() + 1}`.padStart(2, "0")}-${`${at.getDate()}`.padStart(2, "0")}`;

const userTablesOf = (db: DatabaseSync): string[] => {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name?: unknown }>;
  return rows.map((row) => String(row.name ?? "")).filter(Boolean);
};

/**
 * Read-only verification of a SQLite snapshot: non-empty file, `PRAGMA integrity_check` returns
 * `ok`, and every user table present in the source database exists in the backup.
 */
export const verifyBackup = (backupPath: string, expectedTables: readonly string[]): boolean => {
  try {
    if (!existsSync(backupPath)) return false;
    const stats = statSync(backupPath);
    if (!stats.isFile() || stats.size === 0) return false;
    const db = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const check = db.prepare("PRAGMA integrity_check(1)").all() as Array<Record<string, unknown>>;
      const status = check.length === 1 ? Object.values(check[0] ?? {})[0] : undefined;
      if (status !== "ok") return false;
      const present = new Set(userTablesOf(db));
      for (const table of expectedTables) {
        if (!present.has(table)) return false;
      }
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
};

const quarantineCorrupt = (target: string): void => {
  const quarantined = `${target}.corrupt-${Date.now()}-${process.pid}`;
  try {
    renameSync(target, quarantined);
  } catch {
    try {
      unlinkSync(target);
    } catch {
      // If neither rename nor unlink succeeds, the subsequent publish rename will fail loudly.
    }
  }
};

/**
 * One consistent, verified snapshot per day into the backups directory (off the container layer),
 * via SQLite's `VACUUM INTO` into a temporary sibling followed by read-only verification and
 * atomic rename. Invalid pre-existing snapshots are quarantined and replaced; older backups are
 * pruned to KEEP only after a verified snapshot is in place.
 */
export const backupDatabase = (sourcePath: string, backupsDir: string): string => {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  tightenPermissions(backupsDir, 0o700);
  const target = join(backupsDir, `hearth-${dayKey()}.sqlite`);

  const sourceDb = new DatabaseSync(sourcePath);
  let expectedTables: string[];
  try {
    sourceDb.exec("PRAGMA busy_timeout = 5000;");
    expectedTables = userTablesOf(sourceDb);

    let needsSnapshot = true;
    if (existsSync(target)) {
      if (verifyBackup(target, expectedTables)) {
        tightenPermissions(target, 0o600);
        needsSnapshot = false;
      } else {
        quarantineCorrupt(target);
      }
    }

    if (needsSnapshot) {
      const temp = join(backupsDir, `.hearth-${dayKey()}.${process.pid}.${Date.now()}.tmp.sqlite`);
      try {
        sourceDb.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
        tightenPermissions(temp, 0o600);
        if (!verifyBackup(temp, expectedTables)) {
          throw new Error(`Backup verification failed for ${target}`);
        }
        renameSync(temp, target);
        tightenPermissions(target, 0o600);
      } catch (error) {
        try {
          if (existsSync(temp)) unlinkSync(temp);
        } catch {
          // best effort cleanup of failed temporary snapshot
        }
        throw error;
      }
    }
  } finally {
    sourceDb.close();
  }

  // Only prune older backups once today's verified snapshot is confirmed on disk.
  const backups = readdirSync(backupsDir)
    .filter((name) => /^hearth-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - KEEP))) {
    const stalePath = join(backupsDir, stale);
    if (stalePath === target) continue;
    try {
      unlinkSync(stalePath);
    } catch {
      // best effort
    }
  }
  return target;
};
