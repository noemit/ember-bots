#!/usr/bin/env bun
/**
 * What Hearth's open streams hold: one pi-durable view mount per watched conversation.
 *
 * Runs a real `Harness.open` on a **copy** of a backup and attaches one watch per conversation, the
 * way `WS /conversations/:id/events` does, printing heap and RSS as they accumulate. It never calls
 * `resume()`, so no recovered work runs and no provider is contacted; the harness is only read.
 *
 *   bun scripts/diag/mounts.ts /var/tmp/hearth-copy.sqlite [/var/tmp/scratch]
 *
 * `HEARTH_DIAG_WATCH=watch` uses `conversation.watch()` (pi-durable 1.5.0) instead of `watchEvents()`
 * (1.4.0), so the windowed mount can be measured against the whole-transcript one on the same data.
 *
 * Measured 2026-11-04 on the 2026-11-04 backup (169 conversations): 275 MB of active entry JSON →
 * 341 MB of heap, ~500 MB RSS. See PI_DURABLE_1_5_PLAN.md §1.
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { heapStats } from "bun:jsc";
import { hearthModels } from "../../src/models";
import { hearthRegistry } from "../../src/registry";

const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;
const sample = (label: string): void => {
  Bun.gc(true);
  const heap = heapStats();
  const rss = process.memoryUsage().rss;
  console.log(`${label.padEnd(42)} heap=${mb(heap.heapSize)} extra=${mb(heap.extraMemorySize)} rss=${mb(rss)}`);
};

const source = process.argv[2];
if (!source) {
  console.error("usage: bun scripts/diag/mounts.ts <copy-of-hearth.sqlite> [scratch-dir]");
  process.exit(2);
}
// A copy, never the live database: Hearth owns its SQLite, and this must not be a second writer.
const scratch = process.argv[3] ?? mkdtempSync(join(tmpdir(), "hearth-diag-"));
const copy = join(scratch, "hearth-diag-copy.sqlite");
copyFileSync(resolve(source), copy);
const auth = join(scratch, "auth-none.json");
await Bun.write(auth, "{}");

const storage = await openNodeSqliteStorage(copy);
const { models } = await hearthModels(auth);
const harness = await Harness.open(storage, { models, registry: hearthRegistry(scratch, { namespaces: [] }) }, context);
sample("harness open, nothing mounted");

const ids: number[] = [];
let cursor: unknown;
do {
  const page = await storage.scanConversations({}, 100, cursor as never, context);
  for (const record of page.items) ids.push(record.id as number);
  cursor = page.next;
} while (cursor !== undefined);

const mode = process.env.HEARTH_DIAG_WATCH === "watch" ? "conversation.watch" : "watchEvents";
const streams: Array<{ stop(): Promise<unknown> | unknown }> = [];
let peak = 0;
const started = performance.now();
for (const [index, id] of ids.entries()) {
  if (mode === "watchEvents") {
    const { watchEvents } = await import("@earendil-works/pi-durable");
    streams.push(await watchEvents(harness, id as never, context));
  } else {
    const conversation = await harness.conversation(id as never, context);
    if (conversation === undefined) continue;
    const watchable = conversation as unknown as { watch?: (c: unknown, w: unknown) => Promise<{ stop(): Promise<unknown> }> };
    if (typeof watchable.watch !== "function") {
      console.error(
        `HEARTH_DIAG_WATCH=watch needs pi-durable 1.5.0 (it has Conversation.watch); this harness is ${process.argv[0] ? "an older version" : ""}. Falling back to watchEvents.`
      );
      const { watchEvents } = await import("@earendil-works/pi-durable");
      streams.push(await watchEvents(harness, id as never, context));
      continue;
    }
    streams.push(await watchable.watch(context, { min: 50, max: 100 }));
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  if ((index + 1) % 40 === 0) sample(`after ${index + 1} mounts (${mode})`);
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
sample(`all ${streams.length} mounted, ${seconds}s`);
console.log(`peak rss while mounting: ${mb(peak)}`);

for (const stream of streams) await stream.stop();
sample("all stopped (JSC does not return the pages)");
process.exit(0);
