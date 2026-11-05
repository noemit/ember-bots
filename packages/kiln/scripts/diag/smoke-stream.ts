#!/usr/bin/env bun
/**
 * Smoke a running Hearth on a **copy** of a real database: `/health`, the paged snapshot, and one
 * stream frame. This is what caught nothing-but-also-proved the 1.5.0 upgrade reads a real store —
 * run it against a second host (different HEARTH_HOME and port) before trusting a migration.
 *
 *   HEARTH_HOME=/var/tmp/hearth-smoke HEARTH_PORT=3999 bun run src/index.ts &
 *   bun scripts/diag/smoke-stream.ts 3999
 *
 * Careful: a host opened on a copy **resumes the copy's recovered tasks**, so it will start agent
 * turns from the snapshot. Stop it as soon as the checks are done (`kill`, not a pattern that can
 * match your own shell).
 */
// Smoke test against a running Hearth on a copy of a real database: the state wire, the paged
// snapshot, and what the windowed mounts cost. Run it while nothing else is using the port.
const port = process.argv[2] ?? "3999";
const token = (await Bun.file(`/var/tmp/hearth-smoke/hearth.token`).text()).trim();
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}` };

const health = await (await fetch(`${base}/health`, { headers })).json();
console.log("health:", health.version, "rss", Math.round(health.memory.rssBytes / 1048576), "MB");

const list = (await (await fetch(`${base}/conversations`, { headers })).json()).conversations as Array<{
  id: number;
  title?: string;
  updatedAt?: number;
}>;
console.log("conversations:", list.length);

// The largest one by entry count is the interesting one for the snapshot read.
const id = list[0]!.id;
const snapshot = await (await fetch(`${base}/conversations/${id}`, { headers })).json();
console.log(
  "snapshot: entries",
  Array.isArray(snapshot.entries) ? snapshot.entries.length : "n/a",
  "| next",
  snapshot.next ? "yes" : "no",
  "| docs",
  Object.keys(snapshot.docs ?? {}).join(",")
);

// One stream frame: the attach view, with documents and no history.
const url = `ws://127.0.0.1:${port}/conversations/${id}/events`;
const socket = new WebSocket(url, { headers } as never);
const frame = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no attach frame within 5s")), 5000);
  socket.onmessage = (event) => {
    clearTimeout(timer);
    resolve(String(event.data));
  };
  socket.onerror = () => {
    clearTimeout(timer);
    reject(new Error("socket error"));
  };
});
socket.close();
const parsed = JSON.parse(frame);
const attach = parsed[0];
console.log(
  "attach frame:",
  attach.type,
  "| entries",
  attach.entries === undefined ? "absent" : attach.entries.length,
  "| docs",
  Object.keys(attach.docs ?? {}).join(","),
  "| bytes",
  frame.length
);
