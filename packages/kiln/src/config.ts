import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import packageInfo from "../package.json";
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
        if (candidate !== config.tokenPath) {
          writeFileSync(config.tokenPath, `${existing}\n`, { mode: 0o600 });
        }
        return existing;
      }
    } catch {
      // not there yet — try next or generate below
    }
  }
  mkdirSync(config.home, { recursive: true });
  // Four words, not 64 hex characters: this value is copied between machines by hand.
  const token = generateToken();
  writeFileSync(config.tokenPath, `${token}\n`, { mode: 0o600 });
  writeFileSync(emberTokenPath, `${token}\n`, { mode: 0o600 });
  return token;
};

/** Ensure the data home exists; returns whether this is a fresh start. */
export const ensureHome = (config: HearthConfig): boolean => {
  const fresh = !existsSync(config.databasePath);
  mkdirSync(config.home, { recursive: true });
  try {
    // Never persist an explicit environment override as the implicit default.
    writeFileSync(join(config.home, "kiln-bind-default"), `${defaultBind(config.home)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return fresh;
};

/** Best-effort short git SHA of the checkout, so `/health` names the running build.
 *  Reads `.git` directly — the `git` CLI can be missing or refuse a foreign-owned checkout
 *  on Windows, which silently yielded no build id. */
export const hearthBuild = (dir: string): string | undefined => {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7); // detached HEAD
    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : "";
    if (!ref) return undefined;
    const refPath = join(dir, ".git", ref);
    if (existsSync(refPath)) {
      const sha = readFileSync(refPath, "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
    }
    for (const line of readFileSync(join(dir, ".git", "packed-refs"), "utf8").split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.split(" ")[0].slice(0, 7);
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
