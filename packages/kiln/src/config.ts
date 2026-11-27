import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import packageInfo from "../package.json";
import { tightenPermissions } from "./permissions";
import { generateToken, isUsableToken } from "./token";

/**
 * Hearth configuration. The data home defaults to /root/.pi on the container's own
 * filesystem (never /workspace — SQLite WAL over the bind mount is a file-locking
 * hazard); HEARTH_HOME overrides it for tests and canary runs.
 */
export type HearthConfig = {
  readonly home: string;
  readonly databasePath: string;
  readonly tokenPath: string;
  readonly port: number;
  readonly bind: string;
  readonly backupsDir: string;
  /** Root a client browses for new-conversation folders (`GET /directories`). */
  readonly workspace: string;
};

const envString = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
};

/**
 * The default folder root: `/workspace` (the container's mount, and the Linux convention) only on
 * Linux; elsewhere `$HOME/workspace`, else `$HOME`. The mere existence of a `/workspace` directory
 * is not enough — a Git Bash on Windows has one too, and it is not where the user's projects are.
 */
const defaultWorkspace = (): string => {
  if (process.platform === "linux" && existsSync("/workspace")) return "/workspace";
  const home = homedir();
  const homeWorkspace = join(home, "workspace");
  return existsSync(homeWorkspace) ? homeWorkspace : home;
};

const defaultHome = (): string => {
  if (existsSync("/root/.pi")) return "/root/.pi";
  return join(homedir(), ".hearth");
};

/** Retain the implicit wildcard bind only for a pre-upgrade database. Fresh homes
 * pin loopback before SQLite is created, so their second start stays private too. */
export const defaultBind = (home: string): string => {
  try {
    const saved = readFileSync(join(home, "kiln-bind-default"), "utf8").trim();
    return saved === "0.0.0.0" ? saved : "127.0.0.1";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "127.0.0.1";
  }
  return existsSync(join(home, "hearth.sqlite")) ? "0.0.0.0" : "127.0.0.1";
};

export const hearthConfig = (overrides: { home?: string; port?: number; workspace?: string } = {}): HearthConfig => {
  const home = overrides.home ?? envString("HEARTH_HOME") ?? envString("EMBER_HOME") ?? defaultHome();
  const port = overrides.port ?? (Number(envString("HEARTH_PORT") ?? envString("EMBER_PORT")) || 3002);
  // Backups default next to the data home (a local disk on every device). The container
  // sets HEARTH_BACKUPS_DIR=/workspace/backups so they land off the container layer.
  const backupsDir = envString("HEARTH_BACKUPS_DIR") ?? envString("EMBER_BACKUPS_DIR") ?? join(home, "backups");
  const workspace = overrides.workspace ?? envString("HEARTH_WORKSPACE") ?? envString("EMBER_WORKSPACE") ?? defaultWorkspace();
  return {
    home,
    databasePath: join(home, "hearth.sqlite"),
    tokenPath: join(home, "hearth.token"),
    port,
    bind: envString("HEARTH_BIND") ?? envString("EMBER_BIND") ?? defaultBind(home),
    backupsDir,
    workspace,
  };
};

/**
 * Read the auth token, generating and persisting one (mode 0600) on first start.
 *
 * A stored token is taken as it is, whatever its shape: tokens written by older builds are 64 hex
 * characters, and an upgrade must not lock a person out of the machine they are sitting at. Only a
 * *truncated* value (a half-written file) is discarded — see `isUsableToken`.
 */
export const ensureToken = (config: HearthConfig): string => {
  const emberTokenPath = join(config.home, "ember.token");
  for (const candidate of [config.tokenPath, emberTokenPath]) {
    try {
      const existing = readFileSync(candidate, "utf8").trim();
      if (isUsableToken(existing)) {
        tightenPermissions(config.home, 0o700);
        if (candidate !== config.tokenPath) {
          writeFileSync(config.tokenPath, `${existing}\n`, { mode: 0o600 });
          tightenPermissions(config.tokenPath, 0o600);
        }
        tightenPermissions(candidate, 0o600);
        return existing;
      }
    } catch {
      // not there yet — try next or generate below
    }
  }
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  tightenPermissions(config.home, 0o700);
  // Four words, not 64 hex characters: this value is copied between machines by hand.
  const token = generateToken();
  writeFileSync(config.tokenPath, `${token}\n`, { mode: 0o600 });
  tightenPermissions(config.tokenPath, 0o600);
  writeFileSync(emberTokenPath, `${token}\n`, { mode: 0o600 });
  tightenPermissions(emberTokenPath, 0o600);
  return token;
};

/** Ensure the data home exists; returns whether this is a fresh start. */
export const ensureHome = (config: HearthConfig): boolean => {
  const fresh = !existsSync(config.databasePath);
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  tightenPermissions(config.home, 0o700);
  const bindDefaultPath = join(config.home, "kiln-bind-default");
  try {
    // Never persist an explicit environment override as the implicit default.
    writeFileSync(bindDefaultPath, `${defaultBind(config.home)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  tightenPermissions(bindDefaultPath, 0o600);
  return fresh;
};

/** Walk upward from `dir` to locate the owning `.git` directory, supporting worktree `.git` files. */
const resolveGitDir = (startDir: string): { gitDir: string; commonDir: string } | null => {
  let cursor = resolve(startDir);
  while (true) {
    const dotGit = join(cursor, ".git");
    if (existsSync(dotGit)) {
      const stats = statSync(dotGit);
      if (stats.isDirectory()) {
        return { gitDir: dotGit, commonDir: dotGit };
      }
      if (stats.isFile()) {
        const pointer = readFileSync(dotGit, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/i.exec(pointer);
        if (match?.[1]) {
          const gitDir = resolve(cursor, match[1].trim());
          const commondirFile = join(gitDir, "commondir");
          const commonDir = existsSync(commondirFile)
            ? resolve(gitDir, readFileSync(commondirFile, "utf8").trim())
            : gitDir;
          return { gitDir, commonDir };
        }
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
};

/** Best-effort short git SHA of the checkout, so `/health` names the running build.
 *  Walks upward to the owning repository (including worktrees) and reads `.git` directly —
 *  the `git` CLI can be missing or refuse a foreign-owned checkout on Windows. */
export const hearthBuild = (dir: string): string | undefined => {
  try {
    const found = resolveGitDir(dir);
    if (!found) return undefined;
    const head = readFileSync(join(found.gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7); // detached HEAD
    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : "";
    if (!ref) return undefined;
    for (const root of [found.gitDir, found.commonDir]) {
      const refPath = join(root, ref);
      if (existsSync(refPath)) {
        const sha = readFileSync(refPath, "utf8").trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
      }
    }
    const packedPath = join(found.commonDir, "packed-refs");
    if (existsSync(packedPath)) {
      for (const line of readFileSync(packedPath, "utf8").split("\n")) {
        if (line.endsWith(` ${ref}`)) return line.split(" ")[0]!.slice(0, 7);
      }
    }
  } catch {
    // not a git checkout
  }
  return undefined;
};

/** The package version from `<dir>/package.json`, so `/health` names a real release. */
export const hearthVersion = (dir: string): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
  } catch {
    return undefined;
  }
};

/** Embedded by Bun, independent of the launch directory or installed runtime. */
export const kilnVersion: string = packageInfo.version;
