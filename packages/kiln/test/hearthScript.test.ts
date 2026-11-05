/**
 * `scripts/hearth.sh` must defer to the device launcher where one exists.
 *
 * The bug this guards: on macOS the launchd agent runs Hearth on 3005, but `hearth.sh`
 * defaulted `HEARTH_PORT` to 3002 and `restart` spawned its own supervisor there — two Hearths,
 * one on a port nothing expects. These tests run the real script with a stubbed PATH, so they
 * never touch a real Hearth: `launchctl`/`schtasks` record what was asked of them, and `bun`/
 * `setsid` fail loudly if the script tries to start its own process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "hearth.sh");

/**
 * The bash to run the script under.
 *
 * Bun on Windows cannot spawn an MSYS path: `/bin/bash` exists for the shell but not for
 * `uv_spawn`, which fails with ENOENT because it needs a Windows-visible path. Resolving `bash`
 * from PATH works on every platform — Git Bash, WSL, Linux, and macOS all put it there — and
 * keeps this suite running the real script rather than skipping it off Linux.
 */
const BASH = Bun.which("bash") ?? "bash";

type Fixture = { home: string; bin: string; calls: string; root: string };

const shim = (dir: string, name: string, body: string): void => {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
};

/**
 * A PATH where every command the script may reach is a recording shim. `uname` reports the
 * platform under test, `launchctl`/`schtasks` log their argv, and `curl` answers /health from a
 * file so the script's health loop follows the fixture.
 */
const fixture = (platform: "Darwin" | "Linux" | "MINGW64_NT", options: { supervised: boolean }): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "hearth-sh"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const calls = join(root, "calls.log");
  writeFileSync(calls, "");
  const log = (line: string) => `echo "${line} $*" >> "${calls}"`;

  shim(bin, "uname", `case "$1" in -s) echo "${platform}" ;; *) echo "${platform}" ;; esac`);
  shim(bin, "launchctl", `if [ "$1" = "list" ]; then exit ${options.supervised ? 0 : 1}; fi\n${log("launchctl")}`);
  shim(bin, "schtasks", `if [ "$1" = "/query" ]; then exit ${options.supervised ? 0 : 1}; fi\n${log("schtasks")}`);
  // Health: an "up" file makes curl succeed for any URL, so the post-restart wait returns at once.
  shim(bin, "curl", `if [ -f "${root}/up" ]; then exit 0; fi\necho "curl $*" >> "${calls}"\nexit 7`);
  shim(bin, "tr", `exec /usr/bin/tr "$@"`);
  // Any attempt to start Hearth locally is a failure of the thing under test.
  shim(bin, "bun", `echo "bun $*" >> "${calls}"; echo "SCRIPTS STARTED BUN" >&2; exit 99`);
  shim(bin, "setsid", `echo "setsid $*" >> "${calls}"; echo "SCRIPTS STARTED SETSID" >&2; exit 98`);
  shim(bin, "nohup", `echo "nohup $*" >> "${calls}"; echo "SCRIPTS STARTED NOHUP" >&2; exit 97`);
  shim(bin, "sleep", "exit 0");
  // `url` asks Tailscale for the address other devices reach this host at. Reporting nothing keeps
  // the output predictable, and exercises the fallback (local interface, then 127.0.0.1).
  shim(bin, "tailscale", "exit 1");
  // `seq` bounds the script's post-start health loop (`seq 1 360`, 0.25s apart = 90s of waiting),
  // which three tests would otherwise sit through in full: the fixture never answers /health for
  // them, so the loop always runs to the end. Trimming the range keeps those tests honest (the loop
  // still runs, the failure path is still taken) without paying 90s of wall clock — and without
  // relying on the sleep shim, which exits instantly but can still cost a process spawn per round
  // (~20ms under MSYS bash on Windows).
  shim(bin, "seq", `if [ "$2" = "360" ]; then exec /usr/bin/seq 1 3; fi\nexec /usr/bin/seq "$@"`);

  return { home, bin, calls, root };
};

const run = (f: Fixture, args: string[], env: Record<string, string> = {}): { code: number; out: string } => {
  const proc = Bun.spawnSync([BASH, SCRIPT, ...args], {
    env: {
      PATH: `${f.bin}:/usr/bin:/bin`,
      HOME: f.root,
      HEARTH_HOME: f.home,
      // Keep the script from ever writing a pidfile into a real home.
      HEARTH_SUPERVISOR: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
};

const recorded = (f: Fixture): string => readFileSync(f.calls, "utf8").trim();

let fixtures: Fixture[] = [];
const make = (platform: "Darwin" | "Linux" | "MINGW64_NT", supervised: boolean): Fixture => {
  const f = fixture(platform, { supervised });
  fixtures.push(f);
  writeFileSync(join(f.root, "up"), ""); // health answers while the fixture is "up"
  return f;
};

afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

describe("hearth.sh delegation", () => {
  test("on the Mac with launchd installed, restart asks launchd and starts nothing itself", () => {
    const f = make("Darwin", true);
    const { code, out } = run(f, ["restart"]);
    expect(recorded(f).split("\n")).toEqual([
      "launchctl stop dev.ember.hearth",
      "launchctl start dev.ember.hearth",
    ]);
    expect(out).not.toContain("SCRIPTS STARTED");
    expect(code).toBe(0);
    expect(existsSync(join(f.home, "hearth.pid"))).toBe(false);
  });

  test("start and stop delegate the same way", () => {
    const f = make("Darwin", true);
    run(f, ["start"]);
    run(f, ["stop"]);
    expect(recorded(f)).toBe(
      ["launchctl start dev.ember.hearth", "launchctl stop dev.ember.hearth"].join("\n")
    );
  });

  test("with no launcher, the script spawns its own supervisor (Linux container path)", () => {
    const f = make("Linux", false);
    // Health is down on Linux here, so the local start path runs and reaches setsid → bun.
    rmSync(join(f.root, "up"));
    const { out } = run(f, ["restart"]);
    expect(recorded(f)).not.toContain("launchctl");
    expect(recorded(f)).not.toContain("schtasks");
    // It did try to start locally: the shims record the attempt (rather than passing vacuously).
    expect(out).toContain("SCRIPTS STARTED");
  });

  test("HEARTH_SUPERVISOR=none forces the script's own supervisor even where a launcher exists", () => {
    const f = make("Darwin", true);
    run(f, ["restart"], { HEARTH_SUPERVISOR: "none" });
    expect(recorded(f)).not.toContain("launchctl");
  });

  test("status names the supervising launcher", () => {
    const f = make("Darwin", true);
    const { out } = run(f, ["status"]);
    expect(out).toContain("supervisor: launchd");
    expect(out).toContain("3005");
  });
});

describe("what a failed start tells you", () => {
  test("names the launcher, the port, and that the log is the place to look", () => {
    const f = make("Darwin", true);
    rmSync(join(f.root, "up")); // launchd "starts" it and nothing ever answers
    writeFileSync(join(f.home, "hearth.log"), "error: port 3005 is already in use\n");
    const { code, out } = run(f, ["start"]);
    expect(code).toBe(1);
    // Who was asked, on what port, and where the reason is — not just "it didn't come up".
    expect(out).toContain("launchd");
    expect(out).toContain("3005");
    expect(out).toContain("hearth.log");
    // The failure names the help already on screen: the log, and the health command.
    expect(out).toContain("/health");
  });

  test("the last lines of the log come back with the failure, so the reason is right there", () => {
    const f = make("Darwin", true);
    rmSync(join(f.root, "up"));
    writeFileSync(join(f.home, "hearth.log"), "starting\nerror: EADDRINUSE 0.0.0.0:3005\n");
    const { out } = run(f, ["start"]);
    expect(out).toContain("EADDRINUSE 0.0.0.0:3005");
  });
});

describe("hearth.sh port", () => {
  test("reads the port a launcher wrote to $HEARTH_HOME/port", () => {
    const f = make("Darwin", true);
    writeFileSync(join(f.home, "port"), "3007\n");
    const { out } = run(f, ["status"]);
    expect(out).toContain("3007");
  });

  test("defaults to 3005 off Linux, not 3002", () => {
    const f = make("Darwin", true);
    const { out } = run(f, ["status"]);
    expect(out).toContain("port 3005");
  });

  test("keeps 3002 on Linux (the container)", () => {
    const f = make("Linux", false);
    const { out } = run(f, ["status"]);
    expect(out).toContain("hearth:");
    // No launcher: status prints no supervisor line, and never claims a Mac port.
    expect(out).not.toContain("port 3005");
  });
});
