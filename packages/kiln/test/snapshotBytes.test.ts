/**
 * The full read is bounded by bytes, and by rows, like an entries page.
 *
 * `GET /conversations/:id` used to answer with the whole active transcript, built through
 * `viewState()`. On this host's largest conversation that was a 44 MB response and a measured
 * **238 MB of peak heap for one request** — every record parsed into objects, then stringified
 * twice (once per entry to measure, once for the body). It is the largest single allocation Hearth
 * makes, and JSC does not return those pages, so the process ratcheted up until systemd-oomd killed
 * the unit (2026-11-04: a Chromium that this host's own Playwright MCP launched found no memory for
 * its GPU process and died on the "GPU process isn't usable" check).
 *
 * The snapshot is now the newest page of the transcript, at most 12 MB of JSON, with a `next`
 * cursor for what was left out. These tests pin what must stay true:
 *   1. a snapshot too large to send is cut, and says so with a `next` that resumes;
 *   2. entries stay chronological, which is the order a snapshot has always been in;
 *   3. walking with `next` sees every entry exactly once, with no gap and no repeat;
 *   4. a small conversation is untouched — every entry, no cursor;
 *   5. a single entry larger than the whole budget is still returned, alone;
 *   6. the row cap, not the byte budget, is what bounds `pi-durable`'s parse.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";

const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
/** Mirrors `SNAPSHOT_BYTE_BUDGET` in `src/server.ts`; the JSON overhead is the envelope's. */
const BUDGET = 12 * 1024 * 1024;
const SLACK = 256 * 1024;

type Stack = { server: HearthServer; harness: HarnessType };

let stack: Stack;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-snapshotbytes-"));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "faux-1", input: ["text"] }] }).provider);
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context,
  );
  const server = startHearthServer({
    config: hearthConfig({ home, port: 46193, workspace: home }),
    token: TOKEN,
    storage,
    harness,
    models,
    defaultAgent: { model: { provider: "faux", modelId: "faux-1" } },
    store: new FileCredentialStore(join(home, "auth.json")),
    version: "9.9.9",
    build: "testsha",
    restart: () => {},
  });
  stack = { server, harness };
});

afterAll(async () => {
  await stack.server.close();
  await stack.harness.close(context);
  // Windows holds the sqlite handle for a moment after close; a leftover temp dir is not a failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

const api = (path: string): Promise<Response> =>
  fetch(`${stack.server.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

/** One user turn carrying a single base64 image of exactly `bytes` characters. */
const imageTurn = (bytes: number) => ({
  kind: "pi.user",
  model: [
    {
      role: "user" as const,
      timestamp: Date.now(),
      content: [{ type: "image" as const, mimeType: "image/png", data: "A".repeat(bytes) }],
    },
  ],
});

const textTurn = (chars: number) => ({
  kind: "pi.user",
  model: [
    {
      role: "user" as const,
      timestamp: Date.now(),
      content: [{ type: "text" as const, text: "x".repeat(chars) }],
    },
  ],
});

type Snapshot = {
  conversation: { id: number };
  entries: { id: number }[];
  docs: Record<string, unknown>;
  next?: { after: number };
};

const newConversation = async (): Promise<number> => {
  const conversation = await stack.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  return conversation.id as unknown as number;
};

describe("the full read is bounded by bytes", () => {
  test("a snapshot of large entries is cut to the budget and hands back a cursor", async () => {
    const id = await newConversation();
    // Six ~3 MB entries against a 12 MB budget: the snapshot keeps what fits and says there is more.
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 6; i++) await tx.appendEntry(id as never, imageTurn(3 * 1024 * 1024) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}`)).json()) as Snapshot;

    expect(JSON.stringify(body.entries).length).toBeLessThanOrEqual(BUDGET + SLACK);
    expect(body.entries.length).toBeLessThan(6);
    expect(body.next).toBeDefined();
    expect(typeof body.next!.after).toBe("number");
  });

  test("entries stay chronological, and the cursor walks backwards with no gap and no repeat", async () => {
    const id = await newConversation();
    const written: number[] = [];
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 6; i++) {
        const record = await tx.appendEntry(id as never, imageTurn(3 * 1024 * 1024) as never);
        written.push(record.id as unknown as number);
      }
    }, context);

    const pages: number[][] = [];
    let url = `/conversations/${id}`;
    for (let page = 0; page < 20; page++) {
      const body = (await (await api(url)).json()) as Snapshot;
      const ids = body.entries.map((entry) => entry.id);
      // A snapshot is oldest-first, and every page of it is too.
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      pages.push(ids);
      if (!body.next) break;
      url = `/conversations/${id}?cursor=${encodeURIComponent(JSON.stringify(body.next))}`;
    }

    // Each `next` names *older* entries, so a client prepends: the pages are a walk backwards from
    // the newest entry, and every entry appears exactly once, oldest first when prepended.
    const assembled: number[] = [];
    for (const page of [...pages].reverse()) assembled.push(...page);
    expect(assembled).toEqual(written);
    // No repeat across pages either, which is what the boundary entry would be if the cut were
    // off by one.
    expect(new Set(assembled).size).toBe(written.length);
  });

  test("a single entry larger than the whole budget is still returned, alone", async () => {
    const id = await newConversation();
    // Refusing it would stall a client forever, so the contract is "return it, and nothing beside it".
    await stack.harness.commit(async (tx) => {
      await tx.appendEntry(id as never, imageTurn(20 * 1024 * 1024) as never);
      await tx.appendEntry(id as never, textTurn(100) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}`)).json()) as Snapshot;

    expect(body.entries.length).toBe(1);
    expect(body.next).toBeDefined();
  });

  test("a small conversation is unaffected: every entry, chronological, no cursor", async () => {
    const id = await newConversation();
    const written: number[] = [];
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 10; i++) {
        const record = await tx.appendEntry(id as never, textTurn(500) as never);
        written.push(record.id as unknown as number);
      }
    }, context);

    const body = (await (await api(`/conversations/${id}`)).json()) as Snapshot;

    expect(body.entries.map((entry) => entry.id)).toEqual(written);
    expect(body.next).toBeUndefined();
    // The documents the snapshot exists for are still there.
    expect(Object.keys(body.docs)).toContain("pi.agent");
    expect(body.conversation.id).toBe(id as never);
  });

  test("images=ref shrinks the body but never buys more rows than the budget allows", async () => {
    const id = await newConversation();
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 3; i++) await tx.appendEntry(id as never, imageTurn(5 * 1024 * 1024) as never);
    }, context);

    const inline = (await (await api(`/conversations/${id}`)).json()) as Snapshot;
    const refs = (await (await api(`/conversations/${id}?images=ref`)).json()) as Snapshot;

    // The budget counts the entry as materialized, because that parse is what cost the heap: a
    // reference makes the answer smaller, not the read. So the cut is the same either way, and
    // only the bytes on the wire differ.
    expect(inline.entries.length).toBe(2);
    expect(refs.entries.length).toBe(2);
    expect(JSON.stringify(refs.entries).length).toBeLessThan(JSON.stringify(inline.entries).length);
  });
});

/**
 * The row cap is what bounds `pi-durable`'s in-memory parse: `scanEntries` materializes every row it
 * selects before the byte budget can trim the response, so the row count — not the byte count — is
 * the ceiling on peak memory.
 */
describe("the snapshot row cap bounds what one read materializes", () => {
  test("more entries than the cap come back as one full page and a cursor", async () => {
    const id = await newConversation();
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 130; i++) await tx.appendEntry(id as never, textTurn(40) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}`)).json()) as Snapshot;

    expect(body.entries.length).toBe(100);
    expect(body.next).toBeDefined();
  });

  test("a page can still carry the conversation's documents", async () => {
    const id = await newConversation();
    await stack.harness.commit(async (tx) => {
      await tx.appendEntry(id as never, textTurn(40) as never);
    }, context);

    // `docs=1` is what a streaming client asks for on every event, so the documents must come back
    // without the route materializing the transcript to get them.
    const body = (await (await api(`/conversations/${id}/entries?docs=1`)).json()) as Pick<Snapshot, "entries" | "docs">;

    expect(body.entries.length).toBe(1);
    expect(Object.keys(body.docs)).toContain("pi.agent");
    expect(Object.keys(body.docs)).toContain("pi.live");
  });

  test("a cursor that is not a page cursor is refused, naming what it wanted", async () => {
    const id = await newConversation();

    const response = await api(`/conversations/${id}?cursor=${encodeURIComponent('{"after":"x"}')}`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("whole-number");
  });
});
