import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { hearthConfig, ensureHome, ensureToken, hearthBuild, kilnVersion } from "./config";
import { hearthDefault, hearthModels } from "./models";
import { hearthRegistry } from "./registry";
import { anyConversationBusy, startHearthServer, type HearthServer } from "./server";
import { backupDatabase } from "./backup";
import { startScheduler } from "./scheduler";
import { startCrewSupervisor } from "./crew";
import { buildMcpTools, mcpNamespaces, mcpSection, readMcpConfig } from "./mcp";
import { prepareScopeShell, SHELL_SLICE } from "./shell";
import { pruneScratch, sessionEnv } from "./scratch";

/**
 * Every line this process writes carries an ISO timestamp.
 *
 * The host's log is the only record of when it stopped, and it had none: the supervisor's restart lines
 * and Hearth's own `listening` / `restart (reason)` lines were all undated, so "it went down around then"
 * was unanswerable except by correlating with file mtimes. A timestamp per line costs nothing and turns
 * that question into a grep.
 *
 * `console.log`/`console.error` are wrapped rather than replaced by a logger: the rest of the process
 * keeps printing exactly as it does today, and anything that writes through `console` (including a
 * dependency) is stamped too.
 */
for (const level of ["log", "error", "warn"] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    // The timestamp is its own argument rather than one more in the list: a `%s`/`%d` in the
    // message would otherwise be applied to the stamp instead of the value it was written for.
    if (args.length === 0) write(new Date().toISOString());
    else if (typeof args[0] === "string") write(`%s ${args[0]}`, new Date().toISOString(), ...args.slice(1));
    else write(new Date().toISOString(), ...args);
  };
}

const context = BACKGROUND_CONTEXT;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long a session's scratch directory survives untouched (see `src/scratch.ts`). */
const SCRATCH_TTL_DAYS = 3;
/** Self-restart exit code. Non-zero so a restart-on-failure supervisor (e.g. the Windows
 *  scheduled task) brings Hearth back; listeners that restart on any exit do too. */
const RESTART_EXIT_CODE = 75;

const envFlag = (name: string, fallback: boolean): boolean => {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
};
const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hashFile = (path: string): string | undefined => {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
};

/**
 * Self-update after a `git pull`: poll the checkout's build id and, when the commit changes,
 * restart Hearth so it runs the new code. It waits for an idle moment (durable runs still resume
 * if it has to force) and refuses to restart when `bun.lock` changed — a code restart against
 * stale dependencies would crash-loop; `scripts/hearth.sh update` installs first.
 */
const startBuildWatcher = (opts: { cwd: string; initialBuild: string; restart: (reason: string) => void }): void => {
  const intervalMs = envNumber("HEARTH_RELOAD_INTERVAL_MS", 5_000);
  const lockPath = join(opts.cwd, "bun.lock");
  const lockHash = hashFile(lockPath);
  let depsChanged = false;
  let candidate: string | undefined;
  const timer = setInterval(() => {
    if (!depsChanged && lockHash !== undefined && hashFile(lockPath) !== lockHash) {
      depsChanged = true;
      console.error(
        "[hearth] dependencies changed (bun.lock); run `scripts/hearth.sh update` to install and restart — auto-reload paused"
      );
      return;
    }
    if (depsChanged) return;
    const current = hearthBuild(opts.cwd);
    if (!current || current === opts.initialBuild) {
      candidate = undefined;
      return;
    }
    if (candidate !== current) {
      // Confirm on the next tick so a `git pull` mid-write can't trigger a restart.
      candidate = current;
      return;
    }
    clearInterval(timer);
    opts.restart(`new build ${current}`);
  }, intervalMs);
  timer.unref?.();
};

/**
 * The Hearth host: sole owner of the durable SQLite storage, the providers it serves, and
 * the wire Ember talks to. Comes up with the container; `resume()` continues whatever the
 * last process left unfinished.
 */
export const runKiln = async (): Promise<void> => {
  const config = hearthConfig();
  const fresh = ensureHome(config);
  const token = ensureToken(config);

  const storage = await openNodeSqliteStorage(config.databasePath);
  const { models, seeded, store, localRuntimes, customProviders } = await hearthModels(join(config.home, "auth.json"));
  // Restore the last dynamic catalogs before recovered work resumes, but do no network I/O here:
  // a slow provider must not keep /health down. The network refresh starts after the server listens.
  const restored = await models.refresh({ allowNetwork: false }).catch((error: unknown) => {
    console.error("[hearth] stored model restore failed:", error instanceof Error ? error.message : error);
    return { errors: new Map<string, Error>() };
  });
  const restoreErrors = [...restored.errors.keys()];
  if (restoreErrors.length > 0) {
    console.error(`[hearth] stored model restore failed for: ${restoreErrors.join(", ")}`);
  }
  const mcpConfigPath = join(config.home, "mcp.json");
  const mcp = await buildMcpTools(readMcpConfig(mcpConfigPath), mcpConfigPath);
  // MCP servers (Playwright first) register their tools into the same registry. The loaded config
  // path and servers also go into the prompt, so an agent can't misattribute where its tools came from.
  // The registry is built after them so `codemode` knows their namespaces (a script sees
  // `tools.github_search(...)`, grouped under `github`) from the first request on.
  const registry = hearthRegistry(config.home, { namespaces: mcpNamespaces(mcp.summary) });
  if (mcp.tools.length > 0) {
    registry.install({ name: "mcp", tools: mcp.tools, sections: [mcpSection(mcp.summary)] });
  }
  // Every command gets two things from the environment Hearth builds:
  //  - `HEARTH_CONVERSATION`, the tag that lets Hearth attribute a process an agent left running to
  //    the session that started it (`src/processes.ts`), and stop it on that session's behalf;
  //  - `TMPDIR` (and Windows' `TMP`/`TEMP`) pointing at a disk-backed directory under `HEARTH_HOME`,
  //    because `/tmp` is tmpfs on a Linux desktop and agents had filled 5.7 GB of it.
  // Windows' environment is not readable from outside a process, so the tag is only read on Linux;
  // setting it everywhere keeps the two hosts' command lines otherwise identical.
  const shellEnvFor = (conversationId: number): Record<string, string> => sessionEnv(config.home, conversationId);
  // A command runs under a wrapper that puts it in its own transient systemd scope (see
  // `src/shell.ts`), so what an agent starts is not charged to — or killed with — this unit.
  // `undefined` means "the platform's own shell": no systemd here, or a wrapper that could not be
  // written, and commands still work exactly as before.
  const shellPath = prepareScopeShell({ home: config.home });
  if (shellPath !== undefined) {
    console.log(`[hearth] agent commands run in ${SHELL_SLICE} (shell ${shellPath})`);
  }
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd, conversationId }) => new NodeExecutionEnv({
        cwd: cwd ?? process.cwd(),
        shellEnv: shellEnvFor(Number(conversationId)),
        ...(shellPath === undefined ? {} : { shellPath }),
      }),
    },
    context
  );
  harness.resume();

  let server: HearthServer | undefined;
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  let crew: ReturnType<typeof startCrewSupervisor> | undefined;
  let backupTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hearth] ${signal}, closing`);
    if (backupTimer) clearInterval(backupTimer);
    scheduler?.stop();
    crew?.stop();
    mcp.close();
    await server?.close();
    await harness.close(context);
    process.exit(code);
  };

  // Graceful self-restart for `POST /admin/restart` and the build watcher: wait (briefly) for an
  // idle moment so a live stream isn't cut, then exit into the supervisor's restart.
  let restarting = false;
  const restart = (reason: string): void => {
    void (async () => {
      if (restarting || shuttingDown) return;
      restarting = true;
      console.log(`[hearth] restart: ${reason}`);
      const deadline = Date.now() + envNumber("HEARTH_RESTART_GRACE_MS", 60_000);
      while (Date.now() < deadline) {
        try {
          if (!(await anyConversationBusy(harness, storage))) break;
        } catch {
          break;
        }
        await sleep(1_000);
      }
      await sleep(150); // let an in-flight HTTP response flush before we close
      await shutdown(`restart (${reason})`, RESTART_EXIT_CODE);
    })();
  };

  const started = await startHearthServer({
    config,
    token,
    storage,
    harness,
    models,
    defaultAgent: hearthDefault(),
    store,
    version: kilnVersion,
    build: hearthBuild(process.cwd()),
    restart,
    // Reported by `GET /providers` so a client can explain a missing local runtime instead of
    // showing an empty list: "Ollama is running but has no models" is not the same fix as
    // "LM Studio is not answering", and neither is a missing credential.
    localRuntimes,
    customProviders,
    alignmentConfig: customProviders,
  });
  server = started;

  void models
    .refresh()
    .then((refresh) => {
      const refreshErrors = [...refresh.errors.keys()];
      if (refreshErrors.length > 0) {
        console.error(`[hearth] model refresh failed for: ${refreshErrors.join(", ")}`);
      }
    })
    .catch((error: unknown) => {
      console.error("[hearth] model refresh failed:", error instanceof Error ? error.message : error);
    });

  console.log(
    `[hearth] listening on ${config.bind}:${started.port} (storage ${config.databasePath}${fresh ? ", fresh" : ""})`
  );
  // Due-times live in a durable doc; this loop submits due tasks and survives restarts.
  scheduler = startScheduler(harness);
  // Crew reports live in each leader's crew doc; this loop reports settled workers and wakes leaders.
  crew = startCrewSupervisor(harness, storage);
  if (seeded.length > 0) console.log(`[hearth] adopted OpenCode credentials for: ${seeded.join(", ")}`);

  const backup = () => {
    try {
      console.log(`[hearth] backup: ${backupDatabase(config.databasePath, config.backupsDir)}`);
    } catch (error) {
      console.error("[hearth] backup failed:", error instanceof Error ? error.message : error);
    }
  };
  backup();
  backupTimer = setInterval(backup, BACKUP_INTERVAL_MS);
  backupTimer.unref?.();

  // Scratch is bounded by age, not by the platform's default (ten days of `/tmp`, which a 4.7 GB
  // video job survived). Run it at boot and daily: a host that is never restarted still gets swept.
  const sweep = () => {
    const { removed, bytes } = pruneScratch(config.home, { ttlMs: SCRATCH_TTL_DAYS * 24 * 60 * 60 * 1000 });
    if (removed.length > 0) {
      console.log(`[hearth] scratch: removed ${removed.length} stale entr${removed.length === 1 ? "y" : "ies"} (${Math.round(bytes / (1024 * 1024))} MB)`);
    }
  };
  sweep();
  const scratchTimer = setInterval(sweep, BACKUP_INTERVAL_MS);
  scratchTimer.unref?.();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Auto-reload on a new commit (opt out with HEARTH_AUTORELOAD=0); no-op outside a git checkout.
  const build = hearthBuild(process.cwd());
  if (build !== undefined && envFlag("HEARTH_AUTORELOAD", true)) {
    startBuildWatcher({ cwd: process.cwd(), initialBuild: build, restart });
  }
};

// Diagnostics run before configuration, storage, listeners or background services start.
const main = async (): Promise<void> => {
  if (process.argv.includes('--self-test-codemode')) {
    const { selfTestCodemode } = await import('./codemodeSelfTest');
    await selfTestCodemode();
    return;
  }
  await runKiln();
};

if (import.meta.main) void main().catch((error: unknown) => {
  console.error("[hearth] fatal:", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
