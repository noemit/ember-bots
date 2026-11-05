/**
 * A page is bounded by bytes, not only by rows.
 *
 * `limit` counts entry records, and records are wildly unequal in size: a text turn is a few KB,
 * a turn carrying a screenshot is megabytes because the image is base64 inside the record. So
 * `limit=500` was a bound of 500 *rows* — on a conversation with screenshots that is a bound of
 * gigabytes — and the read materializes every record it selects (`pi-durable`'s `readEntries`
 * does `parseJson` per row). One request was enough to take the process past Bun's heap ceiling,
 * which is how the Windows Hearth kept dying.
 *
 * These tests pin the properties the fix depends on:
 *   1. a page never exceeds the byte budget unless a single entry does;
 *   2. a page cut short reports a `next` cursor that actually resumes, with no gap or repeat;
 *   3. a single oversized entry is still returned, alone — refusing it would stall a client;
 *   4. a normal page is untouched.
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

type Stack = { server: HearthServer; harness: HarnessType };

let stack: Stack;
let home: string;

const openStack = async (port: number): Promise<Stack> => {
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "faux-1", input: ["text"] }] }).provider);
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context,
  );
  const server = startHearthServer({
    config: hearthConfig({ home, port, workspace: home }),
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
  return { server, harness };
};

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${stack.server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });

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

type Page = { entries: { id: number }[]; next?: { after: number } };

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-pagebytes-"));
  stack = await openStack(46191);
});

afterAll(async () => {
  await stack.server.close();
  await stack.harness.close(context);
  // Windows holds the sqlite handle for a moment after close; a leftover temp dir is not a failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

const newConversation = async (): Promise<number> => {
  const conversation = await stack.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  return conversation.id as unknown as number;
};

describe("entry pages are bounded by bytes", () => {
  test("a page of large entries stops at the byte budget and hands back a cursor", async () => {
    const id = await newConversation();
    // Six ~3 MB entries: 18 MB of payload, past the 12 MB budget, yet only six rows — far under
    // the 500-row limit that was previously the only bound.
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 6; i++) await tx.appendEntry(id as never, imageTurn(3 * 1024 * 1024) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}/entries?limit=100&images=ref`)).json()) as Page;

    expect(JSON.stringify(body.entries).length).toBeLessThanOrEqual(12 * 1024 * 1024 + 256 * 1024);
    expect(body.entries.length).toBeLessThan(6);
    expect(body.next).toBeDefined();
    expect(typeof body.next!.after).toBe("number");
  });

  test("the cursor a byte-capped page returns resumes with no gap and no repeat", async () => {
    const id = await newConversation();
    const written: number[] = [];
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 6; i++) {
        const record = await tx.appendEntry(id as never, imageTurn(3 * 1024 * 1024) as never);
        written.push(record.id as unknown as number);
      }
    }, context);

    // Walk the whole conversation using only the cursors the server hands back.
    const seen: number[] = [];
    let url = `/conversations/${id}/entries?limit=100&images=ref`;
    for (let page = 0; page < 20; page++) {
      const body = (await (await api(url)).json()) as Page;
      seen.push(...body.entries.map((entry) => entry.id));
      if (!body.next) break;
      url = `/conversations/${id}/entries?limit=100&images=ref&cursor=${encodeURIComponent(JSON.stringify(body.next))}`;
    }

    // Every entry exactly once: a byte cut must not skip the boundary entry or repeat it.
    expect(seen.length).toBe(written.length);
    expect(new Set(seen).size).toBe(written.length);
  });

  test("a single entry larger than the whole budget is still returned, alone", async () => {
    const id = await newConversation();
    // 20 MB in one entry. Refusing it would stall the client forever, so the contract is
    // "return it, and nothing beside it".
    await stack.harness.commit(async (tx) => {
      await tx.appendEntry(id as never, imageTurn(20 * 1024 * 1024) as never);
      await tx.appendEntry(id as never, textTurn(100) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}/entries?limit=100&images=ref`)).json()) as Page;

    expect(body.entries.length).toBe(1);
    expect(body.next).toBeDefined();
  });

  test("a small page is unaffected: every entry, no cursor", async () => {
    const id = await newConversation();
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 10; i++) await tx.appendEntry(id as never, textTurn(500) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}/entries?limit=100&images=ref`)).json()) as Page;

    expect(body.entries.length).toBe(10);
    expect(body.next).toBeUndefined();
  });
});

/**
 * The row cap is what bounds `pi-durable`'s in-memory parse, so its value is load-bearing rather
 * than cosmetic: `scanEntries` materializes every row it selects before the byte budget can trim
 * the response. These pin the contract so a future "let callers ask for more" change has to argue
 * with a test that says why 500 was too many.
 */
describe("the page row cap bounds what one read materializes", () => {
  test("limit above the cap is refused, naming the cap", async () => {
    const id = await newConversation();
    const response = await api(`/conversations/${id}/entries?limit=101&images=ref`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("1 to 100");
  });

  test("the cap itself is accepted", async () => {
    const id = await newConversation();
    const response = await api(`/conversations/${id}/entries?limit=100&images=ref`);

    expect(response.status).toBe(200);
  });

  test("a request for the cap returns at most that many rows", async () => {
    const id = await newConversation();
    // More entries than the cap, each small, so the row cap (not the byte budget) is the thing
    // that stops the page. 101 rows asked for 100 back is the cap doing its job.
    await stack.harness.commit(async (tx) => {
      for (let i = 0; i < 130; i++) await tx.appendEntry(id as never, textTurn(40) as never);
    }, context);

    const body = (await (await api(`/conversations/${id}/entries?limit=100&images=ref`)).json()) as Page;

    expect(body.entries.length).toBe(100);
    expect(body.next).toBeDefined();
  });
});
