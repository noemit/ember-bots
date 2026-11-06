import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where an agent's commands run, so their memory is not charged to Hearth.
 *
 * On Linux a `bash` child — and anything it backgrounds — inherits Hearth's cgroup, which is
 * `hearth.service`. On 2026-11-04 that unit held an Ember dev build, `vite`, a thumbnail server and
 * Playwright's Chromium; Hearth itself was ~20% of the 4.3 GB, and systemd-oomd killed the unit
 * (243 processes) for the whole of it. The same restart that killed Hearth also killed everything
 * the agents were running, which is not a cleanup policy — it is an accident.
 *
 * So each command runs in its own **transient scope** under `hearth-agents.slice`, a sibling of
 * `hearth.service`:
 *
 *   user@1000.service/hearth.slice/hearth-agents.slice/run-<id>.scope
 *   user@1000.service/app.slice/hearth.service
 *
 * which means (measured here, 20 ms for the first call and ~10 ms after): the apps an agent starts
 * are accounted separately, a restart of Hearth leaves them alone (they are now visible and
 * stoppable through the `processes` wire, so leaving them is a choice rather than a leak), and a
 * `MemoryMax` on the slice makes systemd kill *those* processes instead of the host.
 *
 * The mechanism is a shell wrapper written into `HEARTH_HOME`, because that is the one hook
 * pi-durable offers: `NodeExecutionEnv({ shellPath })` spawns `<shellPath> -c <command>`. The
 * wrapper execs `systemd-run --scope … /bin/bash -c <command>`.
 *
 * Detection happens once at boot (`prepareScopeShell`), and the wrapper still checks for the user
 * manager's socket before every command, so a host without systemd — a container, macOS, Windows, a
 * session with no user manager — just runs the command directly. Windows is excluded outright: its
 * shell is Git Bash, and a `sh` wrapper in front of it would be a second translation layer.
 */

/** The slice every agent command runs in: a sibling of `hearth.service`, not a child of it. */
export const SHELL_SLICE = "hearth-agents.slice";

/** Environment variable that turns the wrapper off (`off`, `0`, `false`), or on (`1`), regardless of detection. */
export const SCOPE_SHELL_ENV = "HEARTH_SCOPE_SHELL";

/**
 * The wrapper's text. Pure, so the shape is testable: it must fall through to a plain shell rather
 * than fail when there is no user manager, and it must never swallow the command's exit status.
 */
export const scopeShellScript = (bashPath: string, slice = SHELL_SLICE): string =>
  `#!/bin/sh
# Written by Hearth (src/shell.ts). Runs each command in its own transient systemd scope under
# ${slice}, so an agent's processes are accounted — and killed, if it comes to that — separately
# from Hearth itself.
#
# The socket check is the cheap guard against a host with no user manager (a container, a bare
# session): one stat per command, and the command runs directly instead of failing.
#
if [ -n "\${XDG_RUNTIME_DIR:-}" ] && [ -S "\${XDG_RUNTIME_DIR}/systemd/private" ]; then
  exec systemd-run --user --scope --quiet --collect --slice=${slice} ${bashPath} "$@"
fi
exec ${bashPath} "$@"
`;

export type ScopeShellOptions = {
  home: string;
  /** Defaults to `/bin/bash`; resolved the same way pi-durable would. */
  bashPath?: string;
  /** Test seam: `false` skips the systemd probe. */
  probe?: () => boolean;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

/** Whether the wrapper should be used at all, from the environment and the platform. */
export const scopeShellWanted = (
  options: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {}
): boolean => {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return false;
  const value = (options.env ?? process.env)[SCOPE_SHELL_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") return true;
  return !["0", "false", "no", "off"].includes(value);
};

/**
 * Does this host have a user manager that can start a scope? Probed once, at boot, because a
 * failure per command would be noise and a wrapper that cannot work is worse than none.
 */
export const scopeShellProbe = (options: { run?: (args: string[]) => void } = {}): boolean => {
  const run =
    options.run ??
    ((args: string[]) => {
      execFileSync("systemd-run", args, { timeout: 5_000, stdio: "ignore" });
    });
  try {
    run(["--user", "--scope", "--quiet", "--collect", `--slice=${SHELL_SLICE}`, "/bin/true"]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Write the wrapper and answer the path to give `NodeExecutionEnv`, or `undefined` to use the
 * platform's own shell. Called once at boot; a wrapper that cannot be written is not an error —
 * every command still runs, just in Hearth's cgroup as before.
 */
export const prepareScopeShell = (options: ScopeShellOptions): string | undefined => {
  if (!scopeShellWanted({ ...(options.platform ? { platform: options.platform } : {}), ...(options.env ? { env: options.env } : {}) })) {
    return undefined;
  }
  if (!(options.probe ?? scopeShellProbe)()) return undefined;
  const bashPath = options.bashPath ?? "/bin/bash";
  const path = join(options.home, "hearth-shell");
  try {
    mkdirSync(options.home, { recursive: true });
    writeFileSync(path, scopeShellScript(bashPath), { mode: 0o755 });
    chmodSync(path, 0o755);
  } catch (error) {
    console.error(
      `[hearth] could not write the scope shell at ${path} (${error instanceof Error ? error.message : error}); commands run in hearth.service's cgroup`
    );
    return undefined;
  }
  return path;
};
