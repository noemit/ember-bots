import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const KEEP = 30;

const dayKey = (at = new Date()): string =>
  `${at.getFullYear()}-${`${at.getMonth() + 1}`.padStart(2, "0")}-${`${at.getDate()}`.padStart(2, "0")}`;

/**
 * One consistent snapshot per day into the backups directory (off the container layer),
 * via SQLite's `VACUUM INTO` — a consistent copy of a live WAL database. Returning the
 * existing file keeps it to one backup per day; old ones prune to KEEP.
 */
export const backupDatabase = (sourcePath: string, backupsDir: string): string => {
  mkdirSync(backupsDir, { recursive: true });
  const target = join(backupsDir, `hearth-${dayKey()}.sqlite`);
  if (!existsSync(target)) {
    const db = new DatabaseSync(sourcePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  }
  const backups = readdirSync(backupsDir)
    .filter((name) => /^hearth-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - KEEP))) {
    try {
      unlinkSync(join(backupsDir, stale));
    } catch {
      // best effort
    }
  }
  return target;
};
