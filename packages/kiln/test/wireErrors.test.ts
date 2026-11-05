import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
 * The failure side of the wire: every malformed input and every internal fault has to leave as
 * `{"error": "…"}` with a sentence a client can act on, and none of them may carry this machine's
 * paths, the dependency layout or a stack frame. Bun's development error page did all three, at
 * 50 KB of `text/html`, for a float `limit`.
 */
const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

/** A tool that takes long enough for a conversation to be genuinely busy. */
const Slow = defineExtension({
  name: "slow",
  tools: [
    defineTool({
      name: "slowecho",
      description: "Echo after a pause",
      parameters: obj({ text: str() }),
      replay: "safe",
      execute: async ({ text }) => {
        await new Promise((resolve) => setTimeout(resolve, 750));
        return { output: [{ type: "text", text: `echo: ${text}` }] };
      },
    }),
  ],
});

let home: string;
let harness: HarnessType;
let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
let server: HearthServer;
/** A second server over the same harness, whose `conversation()` throws: the 500 path. */
let exploding: HearthServer;
/** The conversation id the exploding server fails on. */
const BOOM = 987654;
let faux: ReturnType<typeof fauxProvider>;

const api = (path: string, init?: RequestInit, at: HearthServer = server): Promise<Response> =>
  fetch(`${at.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });

/**
 * What no failure body may contain: an HTML page, an install path, the dependency layout, or a
 * stack frame. Checked as a negative on the raw text, not on the parsed body, so a nested field
 * cannot smuggle one through.
 */
const LEAKS = ["<html", "node_modules", "at async ", "\n    at ", "C:\\", "hearth-audit", "/workspace/", "pid"];

const leaksIn = (text: string): string[] => LEAKS.filter((needle) => text.includes(needle));

/** A JSON failure: the status, a JSON content type, an `error` sentence, and nothing leaked. */
const expectFailure = async (response: Response, status: number): Promise<string> => {
  const text = await response.text();
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
  expect(text).not.toContain("<html");
  expect(leaksIn(text)).toEqual([]);
  const parsed = JSON.parse(text);
  expect(typeof parsed.error).toBe("string");
  expect(parsed.error.length).toBeGreaterThan(10);
  // A sentence, not a code or a bare word: it says what happened and what to do instead.
  expect(parsed.error).not.toBe("not found");
  return parsed.error;
};

const openStack = async (deps: { harness?: HarnessType } = {}) => {
  // Inferred: `createModels()` returns the concrete type, which carries `setProvider`;
  // the exported `Models` interface is only the read side.
  const models = createModels();
  models.setProvider(faux.provider);
  return startHearthServer({
    config: hearthConfig({ home, port: 0, workspace: home }),
    token: TOKEN,
    storage,
    harness: deps.harness ?? harness,
    models,
    defaultAgent: { model: { provider: "faux", modelId: "faux-1" } },
    store: new FileCredentialStore(join(home, "auth.json")),
    version: "9.9.9",
    build: "testsha",
  });
};

const createConversation = async (title: string): Promise<number> => {
  const response = await api("/conversations", {
    method: "POST",
    body: JSON.stringify({ title, model: { provider: "faux", modelId: "faux-1" } }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id?: unknown }).id as number;
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-errors-"));
  faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Ready.")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Slow);
  storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
  harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  server = await openStack();
  // The harness a route cannot get past: `conversation()` throws with a message that looks exactly
  // like what Bun's error page used to hand the caller.
  const throwing = new Proxy(harness, {
    get(target, property, receiver) {
      if (property === "conversation") {
        return async (id: number, ctx: unknown) => {
          if (Number(id) === BOOM) {
            throw new Error(`sqlite exploded: ${process.cwd()}\\node_modules\\x\\y.js:12:7`);
          }
          return (target as any).conversation(id, ctx);
        };
      }
      const value = Reflect.get(target, property, receiver === throwing ? target : receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  exploding = await openStack({ harness: throwing });
});

afterAll(async () => {
  await exploding.close();
  await server.close();
  await harness.close(context);
  // Windows keeps the sqlite handle briefly; a leftover temp dir must not read as a test failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe("wire failures", () => {
  test("a bad `limit` is a 400 in JSON, never a page", async () => {
    const id = await createConversation("limit");
    for (const limit of ["2.5", "abc", "-1", "0", "1000", ""]) {
      const message = await expectFailure(await api(`/conversations/${id}/entries?limit=${limit}`), 400);
      expect(message).toContain("limit");
    }
    // The default still applies when the parameter is absent.
    const page = await api(`/conversations/${id}/entries`);
    expect(page.status).toBe(200);
  });

  test("a `cursor` of the wrong shape is a 400, and a syntax error stays one", async () => {
    const id = await createConversation("cursor");
    for (const cursor of [
      encodeURIComponent(JSON.stringify({ after: "x" })),
      encodeURIComponent(JSON.stringify({ after: 1.5 })),
      encodeURIComponent(JSON.stringify({ after: 0 })),
      encodeURIComponent(JSON.stringify([1])),
      encodeURIComponent(JSON.stringify({ nope: 1 })),
      encodeURIComponent("not json"),
      "%7Bnope",
    ]) {
      expect(await expectFailure(await api(`/conversations/${id}/entries?cursor=${cursor}`), 400)).toContain("cursor");
    }
    // A field the storage does not use is tolerated: only `after` decides the page.
    const tolerated = await api(
      `/conversations/${id}/entries?cursor=${encodeURIComponent(JSON.stringify({ after: 1, client: "x" }))}`
    );
    expect(tolerated.status).toBe(200);
  });

  test("a bad `since` is a 400", async () => {
    const id = await createConversation("since");
    expect(await expectFailure(await api(`/conversations/${id}/entries?since=abc`), 400)).toContain("since");
    expect(await expectFailure(await api(`/conversations/${id}/entries?since=-1`), 400)).toContain("since");
  });

  test("malformed percent-encoding in a path is a 400, not a URIError", async () => {
    for (const [path, name] of [
      ["/conversations/%ZZ", "percent-encoding"],
      ["/conversations/%", "percent-encoding"],
      ["/conversations/%E0%A4%A", "percent-encoding"],
      ["/context-rules/%ZZ", "percent-encoding"],
      ["/conversations/%ZZ/entries", "percent-encoding"],
    ] as const) {
      const message = await expectFailure(await api(path), 400);
      expect(message).toContain(name);
    }
  });

  test("`whenBusy` is validated, and `reject` on a busy conversation is a 409", async () => {
    const id = await createConversation("whenBusy");
    expect(
      await expectFailure(
        await api(`/conversations/${id}/submit`, {
          method: "POST",
          body: JSON.stringify({ type: "input", content: "hi", whenBusy: "queue-it-somewhere" }),
        }),
        400
      )
    ).toContain("whenBusy");

    // Hold the conversation busy with a slow tool, then ask to be refused rather than queued.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("slowecho", { text: "busy" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const submitted = await api(`/conversations/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "hold the turn" }),
    });
    expect(submitted.status).toBe(201);
    const refused = await api(`/conversations/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "while busy", whenBusy: "reject" }),
    });
    expect(await expectFailure(refused, 409)).toContain("busy");
    // Its advice is on screen: the two accepted values.
    const text = await (await api(`/conversations/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "again", whenBusy: "reject" }),
    })).text();
    expect(text).toContain("followUp");
  });

  test("a fork point that is not an entry of this conversation is a 400", async () => {
    const owner = await createConversation("fork owner");
    const other = await createConversation("fork other");
    await api(`/conversations/${other}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "an entry of the other one" }),
    });
    const page = (await (await api(`/conversations/${other}/entries?limit=1`)).json()) as {
      entries?: Array<{ id?: unknown }>;
    };
    const foreign = page.entries?.[0]?.id as number;
    const message = await expectFailure(
      await api(`/conversations/${owner}/fork`, { method: "POST", body: JSON.stringify({ at: foreign }) }),
      400
    );
    expect(message).toContain(`${foreign}`);
    // A nonsense boundary is refused the same way, with the value named.
    expect(
      await expectFailure(
        await api(`/conversations/${owner}/fork`, { method: "POST", body: JSON.stringify({ at: "soon" }) }),
        400
      )
    ).toContain("at");
  });

  test("a 404 says which thing was not found", async () => {
    const conversation = await createConversation("missing things");
    const known = await api(`/conversations/${conversation}/entries`);

    const noRoute = await expectFailure(await api("/nope"), 404);
    const noMethod = await expectFailure(await api("/conversations", { method: "DELETE" }), 404);
    const noAction = await expectFailure(await api(`/conversations/${conversation}/wibble`, { method: "POST" }), 404);
    const wrongMethod = await expectFailure(await api(`/conversations/${conversation}/entries`, { method: "POST" }), 404);
    const noConversation = await expectFailure(await api("/conversations/999999"), 404);
    const noEntry = await expectFailure(await api(`/conversations/${conversation}/entries/999999/images/0`), 404);

    const sentences = [noRoute, noMethod, noAction, wrongMethod, noConversation, noEntry];
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(noRoute).toContain("/nope");
    expect(noMethod).toContain("GET");
    expect(wrongMethod).toContain("entries");
    expect(noConversation).toContain("999999");
    expect(noEntry).toContain("999999");
    expect(known.status).toBe(200);
  });

  test("a malformed body is a 400 and creates nothing", async () => {
    const before = ((await (await api("/conversations")).json()) as { conversations?: unknown[] }).conversations
      ?.length as number;
    for (const body of ["not json", "{\"model\":", "[1,2,3]", "\"a string\""]) {
      const message = await expectFailure(
        await api("/conversations", { method: "POST", body }),
        400
      );
      expect(message.toLowerCase()).toContain("json");
    }
    // An empty body is a legitimately empty create, as it always was.
    const empty = await api("/conversations", { method: "POST" });
    expect(empty.status).toBe(201);
    const after = ((await (await api("/conversations")).json()) as { conversations?: unknown[] }).conversations
      ?.length as number;
    expect(after).toBe(before + 1);
  });

  test("an internal throw is a JSON 500 with no stack, path or dependency layout", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const message = await expectFailure(await api(`/conversations/${BOOM}`, undefined, exploding), 500);
      // The caller gets a sentence and a next step; the operator gets the real error in the log.
      expect(message).toContain("Hearth");
      expect(message).toContain("host log");
      expect(logged.mock.calls.flat().map(String).join(" ")).toContain("sqlite exploded");
    } finally {
      logged.mockRestore();
    }
  });
});
