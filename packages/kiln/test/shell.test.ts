import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCOPE_SHELL_ENV,
  SHELL_SLICE,
  prepareScopeShell,
  scopeShellProbe,
  scopeShellScript,
  scopeShellWanted,
} from "../src/shell";

const dirs: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-shell-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("whether the wrapper is used", () => {
  test("Linux only, and the environment can override the probe", () => {
    expect(scopeShellWanted({ platform: "linux", env: {} })).toBe(true);
    // Git Bash is the shell on Windows: a sh wrapper in front of it is a second translation layer.
    expect(scopeShellWanted({ platform: "win32", env: {} })).toBe(false);
    expect(scopeShellWanted({ platform: "darwin", env: {} })).toBe(false);
    for (const off of ["0", "off", "false", "no"]) {
      expect(scopeShellWanted({ platform: "linux", env: { [SCOPE_SHELL_ENV]: off } })).toBe(false);
    }
    expect(scopeShellWanted({ platform: "linux", env: { [SCOPE_SHELL_ENV]: "1" } })).toBe(true);
    expect(scopeShellWanted({ platform: "linux", env: { [SCOPE_SHELL_ENV]: "  " } })).toBe(true);
  });

  test("the probe answers whether a scope can actually be started", () => {
    expect(scopeShellProbe({ run: () => undefined })).toBe(true);
    expect(
      scopeShellProbe({
        run: () => {
          throw new Error("Failed to connect to bus");
        },
      })
    ).toBe(false);
    // The probe asks for exactly what the wrapper will ask for.
    const asked: string[][] = [];
    scopeShellProbe({ run: (args) => void asked.push(args) });
    expect(asked[0]).toContain(`--slice=${SHELL_SLICE}`);
    expect(asked[0]).toContain("--scope");
    expect(asked[0]).toContain("--user");
  });
});

describe("the wrapper script", () => {
  test("it execs the command in a scope, and falls through when there is no user manager", () => {
    const script = scopeShellScript("/bin/bash");
    // The command is the last thing exec'd, with the caller's arguments untouched.
    expect(script).toContain('exec systemd-run --user --scope --quiet --collect --slice=hearth-agents.slice /bin/bash "$@"');
    // No user manager: a plain shell, not a failure.
    expect(script).toContain('exec /bin/bash "$@"');
    expect(script).toContain("XDG_RUNTIME_DIR");
    expect(script).toContain("-S ");
  });

  test("a wrapper really runs a command, and what it starts lands outside Hearth's cgroup", async () => {
    // The whole point, end to end. Skipped where a transient scope cannot be started (CI containers).
    if (!scopeShellProbe()) return;
    const path = prepareScopeShell({ home: home() });
    expect(path).toBeDefined();
    expect(statSync(path!).mode & 0o111).not.toBe(0);
    expect(readFileSync(path!, "utf8")).toContain(SHELL_SLICE);
    const child = Bun.spawn([path!, "-c", 'echo hello; cat /proc/self/cgroup; exit 3'], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(child.stdout).text()).trim();
    expect(out.split("\n")[0]).toBe("hello");
    // The point of the wrapper: the command is not in a child of hearth.service's cgroup.
    expect(out).toContain(SHELL_SLICE);
    // The command's own exit status, not the wrapper's or systemd-run's.
    expect(await child.exited).toBe(3);
  });

  test("a failing probe is no wrapper, and no error", () => {
    const dir = home();
    expect(prepareScopeShell({ home: dir, probe: () => false })).toBeUndefined();
    expect(existsSync(join(dir, "hearth-shell"))).toBe(false);
  });

  test("an unwritable home is no wrapper, not a broken host", () => {
    // `/proc/self` exists and cannot be written to.
    expect(prepareScopeShell({ home: "/proc/self", probe: () => true })).toBeUndefined();
  });

  test("a written wrapper is executable, wherever the umask was", () => {
    const dir = home();
    const path = prepareScopeShell({ home: dir, probe: () => true });
    expect(path).toBe(join(dir, "hearth-shell"));
    chmodSync(path!, 0o600); // simulate a permissive-then-restrictive path: prepare must set 0755
    const again = prepareScopeShell({ home: dir, probe: () => true });
    expect(statSync(again!).mode & 0o111).not.toBe(0);
  });
});
