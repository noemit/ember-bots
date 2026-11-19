declare const KILN_STANDALONE: boolean; // Defined only by the standalone build.

// Bun 1.4.2 snapshots the trust policy for fetch/WebSocket before running JS:
// assigning process.env here is too late, and compiling in --use-system-ca would
// silently override NODE_USE_SYSTEM_CA=0.
// Desktop and Tinder services already supply this at spawn, so keep their original PID.
if (typeof KILN_STANDALONE !== 'undefined' && KILN_STANDALONE && process.env.NODE_USE_SYSTEM_CA === undefined) {
  const argv = [process.execPath, ...process.argv.slice(2)];
  const env = { ...process.env, NODE_USE_SYSTEM_CA: '1' };
  if (process.platform !== 'win32') {
    // POSIX replacement keeps PID, signals, stdio and the supervisor's exit status.
    process.execve!(process.execPath, argv, env);
  } else {
    // Windows has no execve. For a direct launch, wait for the same console program;
    // Ctrl+C is delivered to both processes by the console, and its exit code is ours.
    const child = Bun.spawnSync(argv, { env, detached: false, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exit(child.exitCode);
  }
}
