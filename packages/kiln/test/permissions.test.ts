import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { backupDatabase } from "../src/backup";
import { ensureHome, ensureToken, hearthConfig } from "../src/config";
import { FileCredentialStore, FileModelsStore } from "../src/credentials";
import { tightenPermissions, tightenSqlitePermissions } from "../src/permissions";
import { ensureScratchDir, pruneScratch, scratchRoot, writeScratchFile } from "../src/scratch";

const dirs: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-perms-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const modeOf = (targetPath: string): number => statSync(targetPath).mode & 0o777;

describe("tightenPermissions helper", () => {
  test("ignores ENOSYS, EPERM, EINVAL, ENOTSUP, EOPNOTSUPP, and ENOENT on exotic filesystems", () => {
    for (const code of ["ENOSYS", "EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOENT"]) {
      const fakeChmod = () => {
        const err = new Error(`chmod failed: ${code}`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      };
      expect(() => tightenPermissions("/exotic/path", 0o600, fakeChmod)).not.toThrow();
    }
  });

  test("rethrows unexpected filesystem errors", () => {
    const fakeChmod = () => {
      const err = new Error("disk I/O failure") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    };
    expect(() => tightenPermissions("/broken/path", 0o600, fakeChmod)).toThrow("disk I/O failure");
  });

  test("tightenSqlitePermissions skips :memory: and absent WAL/SHM sidecars", () => {
    const root = tempRoot();
    const dbPath = join(root, "plain.sqlite");
    writeFileSync(dbPath, "sqlite");
    const touched: Array<[string, number]> = [];
    tightenSqlitePermissions(":memory:", (path, mode) => touched.push([path, mode]));
    expect(touched).toEqual([]);

    tightenSqlitePermissions(dbPath, (path, mode) => touched.push([path, mode]));
    expect(touched).toEqual([[dbPath, 0o600]]);
  });
});

describe.skipIf(process.platform === "win32")("POSIX directory (0o700) and file (0o600) enforcement in Kiln", () => {
  test("ensureHome and ensureToken enforce 0o700 on home and 0o600 on token & bind-default files", () => {
    const root = tempRoot();
    const freshHome = join(root, "fresh-home");
    const previousUmask = process.umask(0o000);
    try {
      const cfg = hearthConfig({ home: freshHome });
      expect(ensureHome(cfg)).toBe(true);
      ensureToken(cfg);
      expect(modeOf(freshHome)).toBe(0o700);
      expect(modeOf(cfg.tokenPath)).toBe(0o600);
      expect(modeOf(join(freshHome, "ember.token"))).toBe(0o600);
      expect(modeOf(join(freshHome, "kiln-bind-default"))).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }

    // Pre-existing permissive home and files are tightened in place.
    const legacyHome = join(root, "legacy-home");
    mkdirSync(legacyHome, { recursive: true, mode: 0o755 });
    chmodSync(legacyHome, 0o755);
    const emberToken = join(legacyHome, "ember.token");
    const bindDefault = join(legacyHome, "kiln-bind-default");
    writeFileSync(emberToken, "apple-river-cloud-stone\n", { mode: 0o644 });
    chmodSync(emberToken, 0o644);
    writeFileSync(bindDefault, "127.0.0.1\n", { mode: 0o644 });
    chmodSync(bindDefault, 0o644);

    const legacyCfg = hearthConfig({ home: legacyHome });
    ensureHome(legacyCfg);
    ensureToken(legacyCfg);
    expect(modeOf(legacyHome)).toBe(0o700);
    expect(modeOf(legacyCfg.tokenPath)).toBe(0o600);
    expect(modeOf(emberToken)).toBe(0o600);
    expect(modeOf(bindDefault)).toBe(0o600);
  });

  test("SQLite database, WAL, and SHM sidecars are tightened to 0o600 after opening", async () => {
    const root = tempRoot();
    const home = join(root, "kiln-home");
    const cfg = hearthConfig({ home });
    ensureHome(cfg);

    const storage = await openNodeSqliteStorage(cfg.databasePath);
    try {
      tightenSqlitePermissions(cfg.databasePath);
      expect(modeOf(cfg.databasePath)).toBe(0o600);
      expect(existsSync(`${cfg.databasePath}-wal`)).toBe(true);
      expect(modeOf(`${cfg.databasePath}-wal`)).toBe(0o600);
      if (existsSync(`${cfg.databasePath}-shm`)) {
        expect(modeOf(`${cfg.databasePath}-shm`)).toBe(0o600);
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  test("backupDatabase enforces 0o700 on backupsDir and 0o600 on VACUUM INTO snapshots", async () => {
    const root = tempRoot();
    const dbPath = join(root, "hearth.sqlite");
    const backupsDir = join(root, "backups");
    mkdirSync(backupsDir, { recursive: true, mode: 0o755 });
    chmodSync(backupsDir, 0o755);

    const storage = await openNodeSqliteStorage(dbPath);
    try {
      tightenSqlitePermissions(dbPath);
      const snapshot = backupDatabase(dbPath, backupsDir);
      expect(existsSync(snapshot)).toBe(true);
      expect(modeOf(backupsDir)).toBe(0o700);
      expect(modeOf(snapshot)).toBe(0o600);

      // Re-running on the same day tightens an existing permissive backup too.
      chmodSync(backupsDir, 0o755);
      chmodSync(snapshot, 0o644);
      expect(backupDatabase(dbPath, backupsDir)).toBe(snapshot);
      expect(modeOf(backupsDir)).toBe(0o700);
      expect(modeOf(snapshot)).toBe(0o600);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  test("scratch directories enforce 0o700 and writeScratchFile enforces 0o600", () => {
    const root = tempRoot();
    const tmpRoot = scratchRoot(root);
    mkdirSync(tmpRoot, { recursive: true, mode: 0o755 });
    chmodSync(tmpRoot, 0o755);

    const dir = ensureScratchDir(root, 99)!;
    expect(modeOf(tmpRoot)).toBe(0o700);
    expect(modeOf(dir)).toBe(0o700);

    const file = join(dir, "note.txt");
    const previousUmask = process.umask(0o000);
    try {
      writeScratchFile(file, "secret scratch");
    } finally {
      process.umask(previousUmask);
    }
    expect(modeOf(file)).toBe(0o600);

    chmodSync(tmpRoot, 0o755);
    pruneScratch(root);
    expect(modeOf(tmpRoot)).toBe(0o700);
  });

  test("FileCredentialStore and FileModelsStore enforce 0o700 parent dir and 0o600 files even under umask 0", async () => {
    const root = tempRoot();
    const credDir = join(root, "creds");
    mkdirSync(credDir, { recursive: true, mode: 0o755 });
    chmodSync(credDir, 0o755);

    const authFile = join(credDir, "auth.json");
    const modelsFile = join(credDir, "models-store.json");
    const previousUmask = process.umask(0o000);
    try {
      const store = new FileCredentialStore(authFile);
      await store.modify("openai", async () => ({ type: "api_key", key: "sk-secret" }));
      const modelsStore = new FileModelsStore(modelsFile);
      await modelsStore.write("openai", { models: [], checkedAt: 1 });
    } finally {
      process.umask(previousUmask);
    }

    expect(modeOf(credDir)).toBe(0o700);
    expect(modeOf(authFile)).toBe(0o600);
    expect(modeOf(modelsFile)).toBe(0o600);
  });
});
