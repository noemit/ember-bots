import { chmodSync, existsSync } from "node:fs";

const IGNORED_CHMOD_CODES = new Set([
  "ENOENT",
  "ENOSYS",
  "EPERM",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

/**
 * Enforce strict POSIX mode bits (`0o700` for directories, `0o600` for private files) even when a
 * path already existed with looser permissions or `umask` softened creation, while ignoring
 * unsupported `chmod` errors on Windows or exotic filesystems.
 */
export const tightenPermissions = (
  targetPath: string,
  mode: number,
  chmod: (path: string, mode: number) => void = chmodSync
): void => {
  try {
    chmod(targetPath, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && IGNORED_CHMOD_CODES.has(code)) return;
    throw error;
  }
};

/**
 * Tighten a SQLite database file and its `-wal` / `-shm` sidecars (when present) to `0o600`.
 */
export const tightenSqlitePermissions = (
  databasePath: string,
  chmod: (path: string, mode: number) => void = chmodSync
): void => {
  if (!databasePath || databasePath === ":memory:") return;
  tightenPermissions(databasePath, 0o600, chmod);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) {
      tightenPermissions(sidecar, 0o600, chmod);
    }
  }
};
