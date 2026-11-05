import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { createRegistry, Harness, defineExtension, defineTool, type Harness as HarnessType } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";

/**
 * Submission actions: an abort belongs to the conversation in its path, and a retried `requestId`
 * either returns the submission that placed the message or places it — never a settled no-op that
 * reads as "sent".
 */
const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

/** A tool slow enough that a conversation is genuinely busy while a queue is being built. */
const Slow = defineExtension({
  name: "slow",
  tools: [
    defineTool({
      name: "slowecho",
      description: "Echo after a pause",
      parameters: obj({ text: str() }),
      replay: "safe",
      execute: async ({ text }) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { output: [{ type: "text", text: `echo: ${text}` }] };
      },
    }),
  ],
});

let home: string;
let harness: HarnessType;
let server: HearthServer;
let faux: ReturnType<typeof fauxProvider>;

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });

const body = async (response: Response): Promise<any> => response.json();

const createConversation = async (title: string): Promise<number> => {
  const response = await api("/conversations", {
    method: "POST",
    body: JSON.stringify({ title, model: { provider: "faux", modelId: "faux-1" } }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id?: unknown }).id as number;
};

const submit = (conversation: number, draft: Record<string, unknown>): Promise<Response> =>
  api(`/conversations/${conversation}/submit`, { method: "POST", body: JSON.stringify(draft) });

/** Hold a conversation in a run so the next inputs queue behind it. */
const holdBusy = async (conversation: number): Promise<void> => {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("slowecho", { text: "busy" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("free")]),
  ]);
  const response = await submit(conversation, { type: "input", content: "hold the turn" });
  expect(response.status).toBe(201);
};

/** The conversation's inbox as the wire reports it, bounded to what is queued. */
const queuedText = async (conversation: number): Promise<string[]> => {
  const queue = await body(await api("/queue"));
  const session = queue.sessions.find((each: any) => Number(each.sessionId) === conversation);
  return (session?.items ?? []).map((item: any) => item.text);
};

/** The text of one entry's first message, when it is a user turn. */
const userTextOf = (entry: any): string | undefined => {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.find((part: any) => part?.type === "text")?.text;
  return undefined;
};

/** How many `user` entries of one exact text the conversation holds. */
const userEntries = async (conversation: number, text: string): Promise<number> =>
  (await body(await api(`/conversations/${conversation}/entries?limit=100`))).entries.filter(
    (entry: any) => userTextOf(entry) === text
  ).length;

const settle = async (conversation: number): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = await body(await api("/conversations"));
    if (list.conversations.find((each: any) => each.id === conversation)?.busy === false) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-actions-"));
  faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Ready.")])]);
  // Inferred: `createModels()` returns the concrete type, which carries `setProvider`;
  // the exported `Models` interface is only the read side.
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Slow);
  const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  server = startHearthServer({
    config: hearthConfig({ home, port: 0, workspace: home }),
    token: TOKEN,
    storage,
    harness,
    models,
    defaultAgent: { model: { provider: "faux", modelId: "faux-1" } },
    store: new FileCredentialStore(join(home, "auth.json")),
    version: "9.9.9",
    build: "testsha",
  });
});

afterAll(async () => {
  await server.close();
  await harness.close(context);
  // Windows holds the sqlite handle for a moment; a leftover temp dir is not a failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe("submission actions", () => {
  test("an abort is scoped to the conversation in the path", async () => {
    const owner = await createConversation("abort owner");
    const other = await createConversation("abort other");

    await holdBusy(owner);
    const mine = await body(await submit(owner, { type: "input", content: "queued in the owner" }));
    expect(mine.status).toBe("queued");
    expect(await queuedText(owner)).toEqual(["queued in the owner"]);

    // A crossed or stale id must not withdraw the owner's message: 404, and the inbox is intact.
    const crossed = await api(`/conversations/${other}/submissions/${mine.submissionId}/abort`, { method: "POST" });
    expect(crossed.status).toBe(404);
    const crossedBody = (await crossed.json()) as { error?: string };
    expect(typeof crossedBody.error).toBe("string");
    expect(crossedBody.error).toContain(String(mine.submissionId));
    expect(await queuedText(owner)).toEqual(["queued in the owner"]);

    // The owner's own abort still works, and says what it did.
    const own = await api(`/conversations/${owner}/submissions/${mine.submissionId}/abort`, { method: "POST" });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true, result: "aborted" });
    expect(await queuedText(owner)).toEqual([]);

    await api(`/conversations/${owner}/abort`, { method: "POST" });
    await settle(owner);
  });

  test("the answer reports the full status set, with the reason when unanswered", async () => {
    const conversation = await createConversation("statuses");

    // `write` settles `done` and carries the entry it appended.
    const write = await body(
      await submit(conversation, { type: "write", entry: { kind: "test.note", data: { text: "a note" } } })
    );
    expect(write.status).toBe("done");
    expect(write.mode).toBe("write");
    expect(typeof write.entry).toBe("number");

    // An input on an idle conversation is placed and names its entry.
    faux.setResponses([fauxAssistantMessage([fauxText("answered")])]);
    const placed = await body(await submit(conversation, { type: "input", content: "hello there" }));
    expect(placed.status).toBe("placed");
    expect(placed.mode).toBe("followUp");
    expect(typeof placed.entry).toBe("number");
    expect(placed.reason).toBeUndefined();
    await settle(conversation);

    // A queued input behind a running turn, withdrawn before it runs, settles `unanswered` with
    // the reason — and a status a client can act on instead of guessing.
    await holdBusy(conversation);
    const queued = await body(await submit(conversation, { type: "input", content: "queued then stopped" }));
    expect(queued.status).toBe("queued");
    expect(queued.mode).toBe("followUp");
    await api(`/conversations/${conversation}/submissions/${queued.submissionId}/abort`, { method: "POST" });
    const settled = await body(await api(`/conversations/${conversation}/submissions/${queued.submissionId}/abort`, { method: "POST" }));
    // A second withdrawal is not a success pretending to be one.
    expect(settled.ok).toBe(false);
    expect(settled.result).toBe("settled");
    await api(`/conversations/${conversation}/abort`, { method: "POST" });
    await settle(conversation);
  });

  test("a retried requestId after an unanswered submission places the message", async () => {
    const conversation = await createConversation("retry unanswered");
    await holdBusy(conversation);
    const first = await body(
      await submit(conversation, { type: "input", content: "the message that must arrive", requestId: "retry-a" })
    );
    expect(first.status).toBe("queued");
    // Stop it before it reaches the transcript: the client's retry is all the user has left.
    await api(`/conversations/${conversation}/submissions/${first.submissionId}/abort`, { method: "POST" });
    expect(await userEntries(conversation, "the message that must arrive")).toBe(0);
    await api(`/conversations/${conversation}/abort`, { method: "POST" });
    await settle(conversation);

    // The retry carries the same requestId and the same message.
    faux.setResponses([fauxAssistantMessage([fauxText("answered the retry")])]);
    const again = await body(
      await submit(conversation, { type: "input", content: "the message that must arrive", requestId: "retry-a" })
    );
    expect(again.submissionId).not.toBe(first.submissionId);
    expect(["placed", "queued"]).toContain(again.status);
    await settle(conversation);
    expect(await userEntries(conversation, "the message that must arrive")).toBe(1);

    // And a third retry of the same id is a no-op: the newest attempt reached the transcript.
    const third = await body(
      await submit(conversation, { type: "input", content: "the message that must arrive", requestId: "retry-a" })
    );
    expect(third.submissionId).toBe(again.submissionId);
    await settle(conversation);
    expect(await userEntries(conversation, "the message that must arrive")).toBe(1);
  });

  test("a retried requestId after a placed submission places nothing extra", async () => {
    const conversation = await createConversation("retry placed");
    faux.setResponses([
      fauxAssistantMessage([fauxText("first answer")]),
      fauxAssistantMessage([fauxText("second answer")]),
    ]);
    const first = await body(await submit(conversation, { type: "input", content: "said once", requestId: "retry-b" }));
    expect(first.status).toBe("placed");
    await settle(conversation);

    const retry = await body(await submit(conversation, { type: "input", content: "said once", requestId: "retry-b" }));
    expect(retry.submissionId).toBe(first.submissionId);
    expect(retry.entry).toBe(first.entry);
    await settle(conversation);
    expect(await userEntries(conversation, "said once")).toBe(1);
  });
});
