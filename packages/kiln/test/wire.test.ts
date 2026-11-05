import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Models } from "@earendil-works/pi-ai";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import {
  createRegistry,
  Harness,
  defineExtension,
  defineTool,
  type Harness as HarnessType,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Approvals } from "../src/approvals";
import { AskTool } from "../src/ask";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { startHearthServer, type HearthServer } from "../src/server";
import { withAbortRace } from "../src/interrupt";
import { Sessions, SessionsDoc } from "../src/sessions";
import { MetaDoc } from "../src/meta";
import { AgentsDoc, agentsExtension, readAgentsMirror, registerAgent } from "../src/agents";
import { tick } from "../src/crew";
import { View } from "../src/view";

const context = BACKGROUND_CONTEXT;
const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

/** A tool that ignores cancellation entirely and is deliberately NOT wrapped. */
const Wedged = defineExtension({
  name: "wedged",
  tools: [
    defineTool({
      name: "wedged",
      description: "Ignores cancellation",
      parameters: obj({ ms: num() }),
      replay: "safe",
      execute: async ({ ms }) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { output: [{ type: "text", text: "wedged done" }] };
      },
    }),
  ],
});

/** A slow tool so a run is genuinely in flight when the process is replaced. */
const Slow = defineExtension({
  name: "slow",
  tools: [
    withAbortRace(
      defineTool({
        name: "slowecho",
        description: "Echo after a pause",
        parameters: obj({ text: str() }),
        replay: "safe",
        execute: async ({ text }) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { output: [{ type: "text", text: `echo: ${text}` }] };
        },
      })
    ),
  ],
});

const toolCall = (name: string, args: Record<string, any>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** A real 1×1 PNG, so the `view` tool has something to sniff. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

type Stack = {
  server: HearthServer;
  harness: HarnessType;
  models: Models;
  store: FileCredentialStore;
  directory: string;
  databasePath: string;
  /** Reasons passed to the server's restart callback (the process exit is a spy in tests). */
  restarts: string[];
};

let stack: Stack;
let home: string;
/** Shared faux provider: each test scripts the responses it needs before submitting. */
let faux: ReturnType<typeof fauxProvider>;
/** A second provider whose only model declares text only, so the image check has a subject. */
let blind: ReturnType<typeof fauxProvider>;

const modelsWith = (faux: ReturnType<typeof fauxProvider>) => {
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
};

const openStack = async (faux: ReturnType<typeof fauxProvider>, port: number): Promise<Stack> => {
  const models = modelsWith(faux);
  // A provider whose model cannot see images (its catalog entry has no `image` input).
  blind = fauxProvider({ provider: "blind", models: [{ id: "blind-1", input: ["text"] }] });
  models.setProvider(blind.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(View);
  registry.install(Approvals);
  registry.install({ name: "ask", tools: [AskTool] });
  registry.install(Sessions);
  registry.install(agentsExtension(home));
  registry.install(Slow);
  registry.install(Wedged);
  const storage = await openNodeSqliteStorage(stack?.databasePath ?? join(home, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  const restarts: string[] = [];
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
    restart: (reason) => restarts.push(reason),
  });
  return {
    server,
    harness,
    models,
    store: new FileCredentialStore(join(home, "auth.json")),
    directory: home,
    databasePath: join(home, "hearth.sqlite"),
    restarts,
  };
};

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${stack.server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });

const body = async (response: Response): Promise<any> => response.json();

/**
 * A private harness + storage for supervisor tests: `tick` scans every conversation, so it must
 * not share a database with the rest of the suite's un-reported workers.
 */
const openIsolated = async (): Promise<{
  harness: HarnessType;
  storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
  faux: ReturnType<typeof fauxProvider>;
  directory: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-crew-"));
  const isolated = fauxProvider();
  const models = createModels();
  models.setProvider(isolated.provider);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(View);
  registry.install(Approvals);
  registry.install({ name: "ask", tools: [AskTool] });
  registry.install(Sessions);
  registry.install(Slow);
  registry.install(Wedged);
  const storage = await openNodeSqliteStorage(join(directory, "hearth.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  return { harness, storage, faux: isolated, directory };
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "hearth-wire-"));
  faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Wire ready.")])]);
  stack = await openStack(faux, 0);
});

afterAll(async () => {
  await stack.server.close();
  await stack.harness.close(context);
  // Windows holds the sqlite handle for a moment after close; a leftover temp dir is not a failure.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe("hearth wire", () => {
  test("health answers with the token and rejects without it", async () => {
    const anonymous = await fetch(`${stack.server.url}/health`);
    expect(anonymous.status).toBe(401);
    const health = await api("/health");
    expect(health.status).toBe(200);
    const payload = await body(health);
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe("9.9.9");
    expect(payload.commit).toBe("testsha");
  });

  test("admin restart hands off to the host's supervisor with a reason", async () => {
    const response = await api("/admin/restart", { method: "POST", body: JSON.stringify({ reason: "git pull" }) });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, restarting: true, reason: "git pull", version: "9.9.9", commit: "testsha" });
    expect(stack.restarts).toEqual(["git pull"]);
    // A missing reason defaults to "requested".
    await api("/admin/restart", { method: "POST", body: JSON.stringify({}) });
    expect(stack.restarts).toEqual(["git pull", "requested"]);
  });

  test("providers report credential status and set/remove round-trips without leaking the secret", async () => {
    await stack.store.modify("faux", async () => ({ type: "api_key", key: "sk-secret" }));

    const listed = await body(await api("/providers"));
    expect(listed.providers.find((each: any) => each.id === "faux")?.credential).toBe("api_key");
    expect(JSON.stringify(listed)).not.toContain("sk-secret");

    const set = await body(
      await api("/providers/deepseek", { method: "POST", body: JSON.stringify({ type: "api_key", key: "sk-deep" }) })
    );
    expect(set).toEqual({ ok: true, provider: "deepseek", credential: "api_key" });
    const removed = await body(await api("/providers/deepseek", { method: "DELETE" }));
    expect(removed.credential).toBe(null);
    expect(await stack.store.read("deepseek")).toBeUndefined();

    const bad = await api("/providers/deepseek", { method: "POST", body: JSON.stringify({ nope: true }) });
    expect(bad.status).toBe(400);

    // Import copies whatever the host's OpenCode store holds; the shape is always an array.
    const imported = await body(await api("/providers/import", { method: "POST" }));
    expect(Array.isArray(imported.imported)).toBe(true);
  });

  test("create, submit, read entries, and page by cursor", async () => {
    const created = await api("/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Wire test", model: { provider: "faux", modelId: "faux-1" } }),
    });
    expect(created.status).toBe(201);
    const conversation = await body(created);
    expect(conversation.title).toBe("Wire test");

    const submitted = await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "hello", requestId: "wire-1" }),
    });
    expect(submitted.status).toBe(201);
    const first = await body(submitted);
    expect(first.submissionId).toBeGreaterThan(0);

    // The same requestId is idempotent: it reacquires the same submission.
    const again = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "hello", requestId: "wire-1" }),
      })
    );
    expect(again.submissionId).toBe(first.submissionId);

    const page = await body(await api(`/conversations/${conversation.id}/entries?limit=2`));
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.next).toBeDefined();

    const list = await body(await api("/conversations"));
    const listed = list.conversations.find((each: any) => each.id === conversation.id);
    expect(listed).toBeDefined();
    // Per-session spend rides on the summary, so the rail can show it without reading a transcript.
    // The faux provider may or may not price its responses, so this pins the shape, not the amount.
    expect(typeof listed.cost).toBe("number");
    expect(Number.isFinite(listed.cost)).toBe(true);
  });

  test("entries can be read incrementally with `since`", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "hello" }),
    });
    // A submit produces the user entry plus the run's entries; wait for a few rather than racing it.
    const newestPage = async () =>
      body(await api(`/conversations/${conversation.id}/entries?limit=50`));
    const deadline = Date.now() + 15_000;
    let page = await newestPage();
    while (page.entries.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      page = await newestPage();
    }
    expect(page.entries.length).toBeGreaterThanOrEqual(3);
    const ids = page.entries.map((entry: any) => entry.id);

    // Exclusive: the anchor itself is not re-sent, and nothing newer means nothing at all. This is
    // the read a streaming client repeats; returning the anchor would make "nothing changed" cost a
    // whole entry every poll.
    const current = await body(await api(`/conversations/${conversation.id}/entries?since=${ids[0]}`));
    expect(current.entries).toEqual([]);
    expect(current.next).toBeUndefined();

    // Everything newer than an older anchor, newest first, and `next` when the limit cut it short.
    const older = ids[2];
    const newer = await body(await api(`/conversations/${conversation.id}/entries?since=${older}`));
    expect(newer.entries.map((entry: any) => entry.id)).toEqual(ids.slice(0, 2));
    expect(newer.next).toBeUndefined();
    const cut = await body(await api(`/conversations/${conversation.id}/entries?since=${older}&limit=1`));
    expect(cut.entries.map((entry: any) => entry.id)).toEqual([ids[0]]);
    expect(cut.next).toBeDefined();

    // A bad anchor is a client error, not a stack trace.
    expect((await api(`/conversations/${conversation.id}/entries?since=abc`)).status).toBe(400);
    expect((await api(`/conversations/${conversation.id}/entries?since=-1`)).status).toBe(400);
  });

  test("approvals park and reply over the wire", async () => {
    faux.setResponses([
      toolCall("bash", { command: "echo wire" }),
      fauxAssistantMessage([fauxText("Approved and done.")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "run bash" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pending = await body(await api("/approvals"));
    const parked = pending.approvals.find((each: any) => Number(each.conversationId) === conversation.id);
    expect(parked).toBeDefined();
    expect(parked.tool).toBe("bash");

    const replied = await api(`/approvals/${conversation.id}/${parked.key}/reply`, {
      method: "POST",
      body: JSON.stringify({ decision: "once" }),
    });
    expect(replied.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const cleared = await body(await api("/approvals"));
    expect(cleared.approvals).toHaveLength(0);

    const snapshot = await body(await api(`/conversations/${conversation.id}`));
    const kinds = snapshot.entries.map((entry: any) => entry.kind);
    expect(kinds).toContain("pi.tool-result");
  });

  test("the `view` tool shows an image to the model as image content", async () => {
    const imagePath = join(home, "screenshot.png");
    await writeFile(imagePath, Buffer.from(PNG_1X1, "base64"));
    faux.setResponses([
      toolCall("view", { path: imagePath }),
      fauxAssistantMessage([fauxText("I can see it.")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    // `view` is gated like `read`: enable auto-accept so it runs without a parked approval.
    await api(`/conversations/${conversation.id}/auto-accept`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "look at the screenshot" }),
    });

    let toolResult: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${conversation.id}`));
      toolResult = snapshot.entries.find((entry: any) => entry.kind === "pi.tool-result");
      if (toolResult) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(toolResult).toBeDefined();
    const content = toolResult.model?.[0]?.content ?? [];
    const image = content.find((part: any) => part.type === "image");
    // The model gets pixels (ImageContent), not a stringified blob or an "unsupported image" error.
    expect(image).toBeDefined();
    expect(image.mimeType).toBe("image/png");
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
  }, 20_000);

  test("queued follow-ups can be reordered (withdraw + re-submit in order)", async () => {
    faux.setResponses([
      toolCall("wedged", { ms: 2_000 }),
      fauxAssistantMessage([fauxText("wedged done")]),
      fauxAssistantMessage([fauxText("first done")]),
      fauxAssistantMessage([fauxText("second done")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "run wedged" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const content of ["first", "second"]) {
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content, whenBusy: "followUp" }),
      });
    }

    const before = await body(await api("/queue"));
    const queued = before.sessions.find((each: any) => Number(each.sessionId) === conversation.id);
    expect(queued.items.map((item: any) => item.text)).toEqual(["first", "second"]);

    const reversed = queued.items.map((item: any) => item.id).reverse();
    const reordered = await api(`/conversations/${conversation.id}/queue/order`, {
      method: "PUT",
      body: JSON.stringify({ itemIds: reversed }),
    });
    expect(reordered.status).toBe(200);

    const after = await body(await api("/queue"));
    const again = after.sessions.find((each: any) => Number(each.sessionId) === conversation.id);
    expect(again.items.map((item: any) => item.text)).toEqual(["second", "first"]);

    // Let the run settle so the harness closes cleanly.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      if (!list.conversations.find((each: any) => each.id === conversation.id)?.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 20_000);

  test("the stream sends the live view first, then only what moved", async () => {
    // pi-durable 1.5.0 removed the event protocol: a stream now carries state. The attach frame is
    // the documents a renderer draws (and no history — that is `GET /entries`), and each later frame
    // says what changed, in the smallest shape that lets a client redraw.
    faux.setResponses([fauxAssistantMessage([fauxText("streamed")])]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const url = stack.server.url.replace("http", "ws") + "/conversations/" + String(conversation.id) + "/events?token=" + TOKEN;
    const ws = new WebSocket(url);
    const frames: any[][] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket timeout")), 5_000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")); };
    });
    ws.onmessage = (event) => {
      frames.push(JSON.parse(String(event.data)));
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Array.isArray(frames[0])).toBe(true);
    expect(frames[0][0].type).toBe("view");
    // No history on the wire, ever: the entries field is absent, not empty-but-huge.
    expect(frames[0][0].entries).toBeUndefined();
    expect(frames[0][0].docs).toBeDefined();
    expect(frames[0][0].conversation.id).toBe(conversation.id);

    await api("/conversations/" + String(conversation.id) + "/submit", {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "stream me" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const types = frames.flat().map((frame: any) => frame.type);
    // The run starting is a document change; the answer landing is an appended entry.
    expect(types).toContain("changed");
    expect(types).toContain("appended");
    const appended = frames.flat().filter((frame: any) => frame.type === "appended");
    expect(appended.flatMap((frame: any) => frame.entries).length).toBeGreaterThan(0);
    ws.close();
  });

  test("a stream never carries the transcript, even after an overflow", async () => {
    // An overflow re-sends the whole view. It must still carry no entries: the window exists so a
    // mount stops holding the transcript, and sending it here would undo that on the wire.
    faux.setResponses([fauxAssistantMessage([fauxText("streamed once")])]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const url = stack.server.url.replace("http", "ws") + "/conversations/" + String(conversation.id) + "/events?token=" + TOKEN;
    const ws = new WebSocket(url);
    const frames: any[][] = [];
    ws.onmessage = (event) => {
      frames.push(JSON.parse(String(event.data)));
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket timeout")), 5_000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")); };
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames[0][0].type).toBe("view");

    await api("/conversations/" + String(conversation.id) + "/submit", {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "stream me again" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const views = frames.flat().filter((frame: any) => frame.type === "view");
    expect(views.length).toBeGreaterThanOrEqual(1);
    for (const view of views) expect(view.entries).toBeUndefined();
    ws.close();
  }, 20_000);

  test("configure changes the model and the summary reflects it", async () => {
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const changed = await api(`/conversations/${conversation.id}/configure`, {
      method: "POST",
      body: JSON.stringify({ model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "high" }),
    });
    expect(changed.status).toBe(200);
    const list = await body(await api("/conversations"));
    const found = list.conversations.find((each: any) => each.id === conversation.id);
    expect(found.model.modelId).toBe("faux-2");
    expect(found.thinkingLevel).toBe("high");
  });

  test("rename and archive round-trip through the meta doc", async () => {
    const conversation = await body(await api("/conversations", { method: "POST", body: "{}" }));
    await api(`/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed", archived: 12345 }),
    });
    const list = await body(await api("/conversations"));
    const found = list.conversations.find((each: any) => each.id === conversation.id);
    expect(found.title).toBe("Renamed");
    expect(found.archived).toBe(12345);

    await api(`/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify({ archived: null }) });
    const restored = await body(await api("/conversations"));
    expect(restored.conversations.find((each: any) => each.id === conversation.id).archived).toBeUndefined();
  });

  test("auto-accept round-trips through the conversation summary", async () => {
    const conversation = await body(await api("/conversations", { method: "POST", body: "{}" }));
    const before = (await body(await api("/conversations"))).conversations.find(
      (each: any) => each.id === conversation.id
    );
    // Fresh conversations default to no server-side YOLO.
    expect(before.autoAccept).toBe(false);

    const toggled = await api(`/conversations/${conversation.id}/auto-accept`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    expect(toggled.status).toBe(200);

    const after = (await body(await api("/conversations"))).conversations.find(
      (each: any) => each.id === conversation.id
    );
    expect(after.autoAccept).toBe(true);
  });

  test("a run interrupted mid-tool completes on a reopened harness over the same wire", async () => {
    // Script the shared faux so the submitted run goes through the slow tool (no gate).
    faux.setResponses([
      toolCall("slowecho", { text: "recover me" }),
      fauxAssistantMessage([fauxText("Recovered.")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    // The slow tool is mid-flight: replace the whole stack like a crash would. The close
    // waits for the in-flight call, then the reopen re-runs it and finishes the run.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await stack.server.close();
    await stack.harness.close(context);

    // The reopened stack re-scripts the same responses: the interrupted generation
    // re-issues the model call, the tool re-runs, and the run answers.
    const replacement = fauxProvider();
    replacement.setResponses([
      toolCall("slowecho", { text: "recover me" }),
      fauxAssistantMessage([fauxText("Recovered.")]),
    ]);
    stack = await openStack(replacement, 0);
    // Later tests script the module-level faux; point it at the one this stack now uses.
    faux = replacement;
    stack.harness.resume();
    // Reads never enable scheduling: a progress call drives the recovered run.
    await stack.harness.waitForIdle(context);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${conversation.id}`));
      // The snapshot view lists entries chronologically; the answer lands last.
      const kinds = snapshot.entries.map((entry: any) => entry.kind);
      const newest = kinds[kinds.length - 1];
      if (newest === "pi.assistant") {
        expect(kinds).toContain("pi.tool-result");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("the interrupted run never completed after reopen");
  }, 30_000);

  test("reordering a parked queue does not start the conversation", async () => {
    // Stop parks the queue as queued submissions. A reorder that re-submitted them would *place*
    // the first one and start a run on an idle conversation — "stop, then reorder" would send.
    faux.setResponses([
      toolCall("slowecho", { text: "busy" }),
      fauxAssistantMessage([fauxText("done one")]),
      fauxAssistantMessage([fauxText("done two")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) break;
      if (Date.now() > deadline) throw new Error("conversation never became busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "parked A", whenBusy: "followUp" }),
    });
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "parked B", whenBusy: "steer" }),
    });
    await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" });
    // The stop parked both; the conversation is idle and both are still queued.
    const queueOf = async (): Promise<any> => {
      const queue = await body(await api("/queue"));
      return queue.sessions.find((entry: any) => Number(entry.sessionId) === conversation.id);
    };
    let before = await queueOf();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((before?.items ?? []).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
      before = await queueOf();
    }
    expect(before.items.map((item: any) => item.text)).toEqual(["parked A", "parked B"]);

    const reordered = await api(`/conversations/${conversation.id}/queue/order`, {
      method: "PUT",
      body: JSON.stringify({ itemIds: before.items.map((item: any) => item.id).reverse() }),
    });
    expect(reordered.status).toBe(200);
    const after = (await body(reordered)).session;
    // The order is what was asked for, and the modes survived the round trip.
    expect(after.items.map((item: any) => item.text)).toEqual(["parked B", "parked A"]);
    expect(after.items.map((item: any) => item.mode)).toEqual(["steer", "followUp"]);
    // Nothing started, and nothing was placed: an idle conversation with a parked queue stays idle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const list = await body(await api("/conversations"));
    expect(list.conversations.find((entry: any) => entry.id === conversation.id)?.busy).toBe(false);
    const snapshot = await body(await api(`/conversations/${conversation.id}`));
    expect(snapshot.entries.some((entry: any) => entry.kind === "pi.user" && entry.model?.[0]?.content === "parked A")).toBe(
      false
    );
  }, 30_000);

  test("the queue lists a busy conversation's follow-ups", async () => {
    faux.setResponses([
      toolCall("slowecho", { text: "busy" }),
      fauxAssistantMessage([fauxText("done one")]),
      fauxAssistantMessage([fauxText("done two")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    // Queue only once the run is actually in flight, or the follow-up would start its own run.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) break;
      if (Date.now() > deadline) throw new Error("conversation never became busy");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const queued = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "queued follow-up", whenBusy: "followUp" }),
      })
    );
    // A busy conversation queues the input; the response says so, so a client won't show it as sent.
    expect(queued.status).toBe("queued");
    const queue = await body(await api("/queue"));
    const session = queue.sessions.find((entry: any) => Number(entry.sessionId) === conversation.id);
    expect(session).toBeDefined();
    expect(session.items.map((item: any) => item.text)).toContain("queued follow-up");
    expect(session.items[0].mode).toBe("followUp");
  });

  test("aborting one queued submission leaves the others", async () => {
    faux.setResponses([
      toolCall("slowecho", { text: "busy" }),
      fauxAssistantMessage([fauxText("done one")]),
      fauxAssistantMessage([fauxText("done two")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) break;
      if (Date.now() > deadline) throw new Error("conversation never became busy");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const first = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "follow-up A", whenBusy: "followUp" }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "follow-up B", whenBusy: "followUp" }),
    });
    const before = await body(await api("/queue"));
    expect(
      before.sessions.find((entry: any) => Number(entry.sessionId) === conversation.id)?.items.map((item: any) => item.text)
    ).toEqual(["follow-up A", "follow-up B"]);

    // Aborting one submission must remove only that one, not the whole inbox.
    expect(
      (await api(`/conversations/${conversation.id}/submissions/${first.submissionId}/abort`, { method: "POST", body: "{}" })).status
    ).toBe(200);
    const after = await body(await api("/queue"));
    expect(
      after.sessions.find((entry: any) => Number(entry.sessionId) === conversation.id)?.items.map((item: any) => item.text)
    ).toEqual(["follow-up B"]);
  });

  test("scheduled tasks round-trip through the wire", async () => {
    const created = await api("/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        name: "Nightly brief",
        prompt: "Write the brief",
        schedule: { kind: "daily", time: "09:00" },
      }),
    });
    expect(created.status).toBe(201);
    const task = await body(created);
    expect(task.id).toMatch(/^task_/);
    const listed = await body(await api("/scheduled-tasks"));
    expect(listed.tasks.some((each: any) => each.id === task.id)).toBe(true);
    expect(typeof listed.timezone).toBe("string");

    const patched = await body(
      await api(`/scheduled-tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })
    );
    expect(patched.enabled).toBe(false);

    expect((await body(await api(`/scheduled-tasks/${task.id}`, { method: "DELETE" }))).ok).toBe(true);
    expect((await body(await api("/scheduled-tasks"))).tasks.some((each: any) => each.id === task.id)).toBe(false);
  });

  test("directories lists the workspace root's folders, refusing paths outside it", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "project-a"), { recursive: true });
    await mkdir(join(home, "project-b"), { recursive: true });
    const listed = await body(await api("/directories"));
    expect(listed.workspace).toBe(home);
    const names = listed.directories.map((entry: any) => entry.name);
    expect(names).toContain("project-a");
    expect(names).toContain("project-b");
    expect((await api(`/directories?path=${encodeURIComponent("/etc")}`)).status).toBe(400);
  });

  test("a refused whenBusy reject leaves no context entry behind", async () => {
    // The keyword rule writes a `hearth.context` entry ahead of the input. If the input is then
    // refused as busy, that entry is orphaned context the model never had a message for — so the
    // refusal has to happen before it is written.
    const rule = await body(
      await api("/context-rules", {
        method: "POST",
        body: JSON.stringify({ keywords: ["orphan"], text: "This rule must not fire." }),
      })
    );
    try {
      faux.setResponses([
        toolCall("slowecho", { text: "busy" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const conversation = await body(
        await api("/conversations", {
          method: "POST",
          body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
        })
      );
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "hold the turn" }),
      });
      const deadline = Date.now() + 5_000;
      for (;;) {
        const list = await body(await api("/conversations"));
        if (list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) break;
        if (Date.now() > deadline) throw new Error("conversation never became busy");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const refused = await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "an orphan keyword", whenBusy: "reject" }),
      });
      expect(refused.status).toBe(409);
      expect((await body(refused)).error).toContain("asked to be refused");
      const snapshot = await body(await api(`/conversations/${conversation.id}`));
      expect(snapshot.entries.some((entry: any) => entry.kind === "hearth.context")).toBe(false);
      await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" });
    } finally {
      await api(`/context-rules/${rule.id}`, { method: "DELETE" });
    }
  }, 20_000);

  test("creating a conversation with a missing folder is refused", async () => {
    const bad = await api("/conversations", {
      method: "POST",
      body: JSON.stringify({ cwd: join(home, "does-not-exist") }),
    });
    expect(bad.status).toBe(400);
  });

  test("context rules round-trip through the wire", async () => {
    const created = await api("/context-rules", {
      method: "POST",
      body: JSON.stringify({ keywords: ["vedic"], text: "Use the Vedic project rules." }),
    });
    expect(created.status).toBe(201);
    const rule = await body(created);
    expect(rule.id).toMatch(/^rule_/);
    expect((await body(await api("/context-rules"))).rules.some((each: any) => each.id === rule.id)).toBe(true);
    const patched = await body(
      await api(`/context-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })
    );
    expect(patched.enabled).toBe(false);
    expect((await body(await api(`/context-rules/${rule.id}`, { method: "DELETE" }))).ok).toBe(true);
    expect((await body(await api("/context-rules"))).rules.some((each: any) => each.id === rule.id)).toBe(false);
  });

  test("models and usage are served", async () => {
    const models = await body(await api("/models"));
    expect(models.models.some((model: any) => model.provider === "faux")).toBe(true);
    expect(models.default.modelId).toBe("faux-1");
    const usage = await body(await api("/usage"));
    expect(typeof usage).toBe("object");
  });

  test("submit reports the queue it went into (steer vs follow-up vs write)", async () => {
    faux.setResponses([
      toolCall("slowecho", { text: "busy" }),
      fauxAssistantMessage([fauxText("done one")]),
      fauxAssistantMessage([fauxText("done two")]),
      fauxAssistantMessage([fauxText("done three")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) break;
      if (Date.now() > deadline) throw new Error("conversation never became busy");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A busy conversation queues either kind; `mode` is what tells a steer apart from a follow-up.
    const steer = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "steer me", whenBusy: "steer" }),
      })
    );
    expect(steer.status).toBe("queued");
    expect(steer.mode).toBe("steer");
    const followUp = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "later", whenBusy: "followUp" }),
      })
    );
    expect(followUp.status).toBe("queued");
    expect(followUp.mode).toBe("followUp");
    const write = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "write", entry: { kind: "app.note", data: { text: "hi" } } }),
      })
    );
    expect(write.mode).toBe("write");
    await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" });
  }, 20_000);

  test("abort returns fast and settles the step even when the tool ignores its abort signal", async () => {
    // `slowecho` runs 400ms and never checks the abort signal; `withAbortRace` cuts it loose.
    faux.setResponses([
      toolCall("slowecho", { text: "wedged" }),
      fauxAssistantMessage([fauxText("never reached")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go wedge" }),
    });
    // Wait for the tool step to be genuinely running.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const snapshot = await body(await api(`/conversations/${conversation.id}`));
      if (snapshot.docs?.["pi.live"]?.tools?.some((slot: any) => slot.status === "running")) break;
      if (Date.now() > deadline) throw new Error("tool never started");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const started = Date.now();
    const aborted = await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" });
    const abortMs = Date.now() - started;
    expect(aborted.status).toBe(200);
    // Well under the 400ms the tool would otherwise take; the signal is delivered at once.
    expect(abortMs).toBeLessThan(300);
    // The interrupted result lands promptly once the race rejects the step.
    let sawInterrupted = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${conversation.id}`));
      const result = snapshot.entries.find((entry: any) => entry.kind === "pi.tool-result");
      if (result) {
        expect(result.model?.[0]?.isError).toBe(true);
        sawInterrupted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sawInterrupted).toBe(true);
  }, 20_000);

  test("abort still returns promptly for a tool that ignores cancellation and is not wrapped", async () => {
    // `wedged` never checks its signal and is not abort-wrapped: the fast-return window is the
    // backstop so a genuinely wedged step can't hang `POST /abort` for its whole duration.
    faux.setResponses([
      toolCall("wedged", { ms: 3_000 }),
      fauxAssistantMessage([fauxText("never reached")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go wedge hard" }),
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const snapshot = await body(await api(`/conversations/${conversation.id}`));
      if (snapshot.docs?.["pi.live"]?.tools?.some((slot: any) => slot.status === "running")) break;
      if (Date.now() > deadline) throw new Error("tool never started");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const started = Date.now();
    const aborted = await api(`/conversations/${conversation.id}/abort`, { method: "POST", body: "{}" });
    const abortMs = Date.now() - started;
    expect(aborted.status).toBe(200);
    // The window, plus generous scheduling slack — never anywhere near the 3s the tool runs.
    expect(abortMs).toBeLessThan(700);
    // The run eventually ends; the background abort is not dropped.
    let idle = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      if (!list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) {
        idle = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(idle).toBe(true);
  }, 20_000);

  test("the `session` tool spawns a worker by default with a lead and a copied auto-accept", async () => {
    // The spawner calls `session spawn`; the spawned worker then answers its brief.
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "helper", brief: "Say hello from the worker." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Spawned.")]),
      fauxAssistantMessage([fauxText("Hello from the worker.")]),
    ]);
    const parent = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Parent" }),
      })
    );
    // The worker copies the leader's auto-accept at spawn.
    await api(`/conversations/${parent.id}/auto-accept`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    await api(`/conversations/${parent.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Start a helper worker." }),
    });

    // Wait for the worker to appear as a new ownerless conversation.
    let worker: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      worker = list.conversations.find(
        (entry: any) => entry.kind === "worker" && entry.lead?.conversationId === parent.id
      );
      if (worker) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(worker).toBeDefined();
    // Named by role, not by the brief: no role given, so it is the first Worker.
    expect(worker.title).toBe("Worker #1");
    // Ownerless (Ember hides it by `kind`, not by ownership), with crew membership on the meta doc.
    expect(worker.owner).toBeUndefined();
    expect(worker.kind).toBe("worker");
    expect(worker.lead).toEqual({ conversationId: parent.id, host: "local" });
    expect(worker.delegates).toBe(true);
    expect(worker.autoAccept).toBe(true);
    // Inherited the parent's cwd and model.
    expect(worker.cwd).toBe(home);
    expect(worker.model).toEqual({ provider: "faux", modelId: "faux-1" });

    // The brief landed as the worker's first user entry.
    let briefLanded = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${worker.id}`));
      const first = snapshot.entries.find((entry: any) => entry.kind === "pi.user");
      if (first?.model?.[0]?.content === "Say hello from the worker.") {
        briefLanded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(briefLanded).toBe(true);

    // The worker is reachable and answers on its own.
    let answered = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${worker.id}`));
      const last = snapshot.entries[snapshot.entries.length - 1];
      if (last?.kind === "pi.assistant") {
        answered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(answered).toBe(true);
  }, 20_000);

  test("workers are titled from their role and numbered per role, never renumbered", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("session", { action: "spawn", name: "r3", brief: "Third research brief.", role: "Researcher" }),
          fauxToolCall("session", { action: "spawn", name: "r4", brief: "Fourth research brief.", role: "  Researcher  " }),
          fauxToolCall("session", { action: "spawn", name: "g1", brief: "Graphics brief.", role: "Graphics" }),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Spawned a crew.")]),
      fauxAssistantMessage([fauxText("Research done.")]),
      fauxAssistantMessage([fauxText("Research done.")]),
      fauxAssistantMessage([fauxText("Graphics done.")]),
      fauxAssistantMessage([fauxText("Idle.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Role leader" }),
      })
    );
    // Two researchers already retired from this leader's crew. Their numbers stay taken, so the
    // next Researcher is #3, not #1 (crew entries are never removed, archived or not).
    await stack.harness.commit(async (tx) => {
      const doc = await tx.doc(SessionsDoc, leader.id);
      doc.generation = 1;
      doc.woke = true;
      doc.items.r1 = {
        kind: "worker",
        conversationId: 910001 as any,
        title: "Researcher #1",
        role: "Researcher",
        roleIndex: 1,
        spawnedAt: Date.now() - 1000,
        state: "reported",
        generation: 1,
        briefRequestId: "brief",
      };
      doc.items.r2 = {
        kind: "worker",
        conversationId: 910002 as any,
        title: "Researcher #2",
        role: "Researcher",
        roleIndex: 2,
        spawnedAt: Date.now() - 1000,
        state: "stopped",
        generation: 1,
        briefRequestId: "brief",
      };
    }, context);
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn a research crew." }),
    });

    const titles = async (): Promise<string[]> => {
      const list = await body(await api("/conversations"));
      return list.conversations
        .filter((entry: any) => entry.kind === "worker" && entry.lead?.conversationId === leader.id)
        .map((entry: any) => entry.title)
        .sort();
    };
    let spawned: string[] = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      spawned = await titles();
      if (spawned.length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Same role continues from the retired numbers; a new role starts at 1; role whitespace trims.
    expect(spawned).toEqual(["Graphics #1", "Researcher #3", "Researcher #4"]);

    // The composed title is what the crew doc records too, so `list` and the strip agree.
    const doc = await stack.harness.snapshot(SessionsDoc, leader.id, context);
    expect(doc?.items.r3?.title).toBe("Researcher #3");
    expect(doc?.items.r3?.role).toBe("Researcher");
    expect(doc?.items.r3?.roleIndex).toBe(3);
    expect(doc?.items.r4?.roleIndex).toBe(4);
    expect(doc?.items.g1?.roleIndex).toBe(1);
  }, 30_000);

  test("a role-less worker is Worker #1, an explicit title wins, and a blank role is refused", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("session", { action: "spawn", name: "blank", brief: "Blank role brief.", role: "   " }),
          fauxToolCall("session", { action: "spawn", name: "helper", brief: "Role-less brief." }),
          fauxToolCall(
            "session",
            { action: "spawn", name: "named", brief: "Named brief.", role: "Researcher", title: "My Agent" }
          ),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Spawned what I could.")]),
      fauxAssistantMessage([fauxText("Worker done.")]),
      fauxAssistantMessage([fauxText("Worker done.")]),
      fauxAssistantMessage([fauxText("Idle.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Title leader" }),
      })
    );
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn workers with mixed naming." }),
    });

    const workers = async (): Promise<any[]> => {
      const list = await body(await api("/conversations"));
      return list.conversations.filter(
        (entry: any) => entry.kind === "worker" && entry.lead?.conversationId === leader.id
      );
    };
    let found: any[] = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      found = await workers();
      if (found.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(found.map((entry: any) => entry.title).sort()).toEqual(["My Agent", "Worker #1"]);

    // The brief is still the worker's first user message; only the title changed.
    const plain = found.find((entry: any) => entry.title === "Worker #1");
    let firstUser = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${plain.id}`));
      const first = snapshot.entries.find((entry: any) => entry.kind === "pi.user");
      if (first) {
        firstUser = first.model?.[0]?.content ?? "";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(firstUser).toBe("Role-less brief.");

    const snapshot = await body(await api(`/conversations/${leader.id}`));
    const toolText = snapshot.entries
      .filter((entry: any) => entry.kind === "pi.tool-result")
      .map((entry: any) => entry.model?.[0]?.content ?? "")
      .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
      .join("\n");
    expect(toolText).toContain("role cannot be blank");
    expect(toolText).toContain("Started worker \"Worker #1\"");
    expect(toolText).toContain("Started worker \"My Agent\"");
  }, 30_000);

  test("the `session` tool lists, messages and stops the worker it started", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "worker", brief: "Wait for a follow-up." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "status", name: "worker" })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "message", name: "worker", message: "Second task.", followUp: true })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "list" })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Managed the worker.")]),
      // The worker answers its brief and its follow-up.
      fauxAssistantMessage([fauxText("Worker idle.")]),
      fauxAssistantMessage([fauxText("Worker did the second task.")]),
    ]);
    const parent = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Parent" }),
      })
    );
    await api(`/conversations/${parent.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Start a worker session." }),
    });

    // The parent's turns drive the worker; find it and wait for its second answer.
    let worker: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      worker = list.conversations.find(
        (entry: any) => entry.kind === "worker" && entry.lead?.conversationId === parent.id
      );
      if (worker) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(worker).toBeDefined();

    let gotSecondTask = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${worker.id}`));
      if (snapshot.entries.some((entry: any) => entry.model?.[0]?.content === "Second task.")) {
        gotSecondTask = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(gotSecondTask).toBe(true);

    // The parent's tool results recorded the status and list outputs.
    const parentSnapshot = await body(await api(`/conversations/${parent.id}`));
    const toolText = parentSnapshot.entries
      .filter((entry: any) => entry.kind === "pi.tool-result")
      .map((entry: any) => entry.model?.[0]?.content ?? "")
      .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
      .join("\n");
    expect(toolText).toContain("worker");
    expect(toolText).toContain("Worker #1");
  }, 30_000);

  test("the `agents` tool queues to a busy worker of the leader's own crew, and steers into it", async () => {
    const make = async (title: string): Promise<any> =>
      body(
        await api("/conversations", {
          method: "POST",
          body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title }),
        })
      );
    const leader = await make("Crew leader");
    const worker = await make("Researcher #1");
    await stack.harness.commit(async (tx) => {
      // A crew doc entry is all a leader needs: the directory path is untouched.
      (await tx.doc(SessionsDoc, leader.id)).items.researcher = {
        kind: "worker",
        conversationId: worker.id,
        title: "Researcher #1",
        role: "Researcher",
        roleIndex: 1,
        spawnedAt: Date.now(),
        state: "running",
        generation: 1,
        briefRequestId: `crew-message-brief-${worker.id}`,
      };
      const meta = await tx.doc(MetaDoc, worker.id);
      meta.kind = "worker";
      meta.lead = { conversationId: leader.id, host: "local" };
    }, context);

    const entriesOf = async (id: number): Promise<any[]> =>
      (await body(await api(`/conversations/${id}`))).entries;
    const busyOf = async (id: number): Promise<boolean> =>
      (await body(await api("/conversations"))).conversations.find((entry: any) => entry.id === id)?.busy ===
      true;
    const waitFor = async (what: string, check: () => Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const toolText = async (id: number): Promise<string> =>
      (await entriesOf(id))
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
    const hasUserText = async (id: number, text: string): Promise<boolean> =>
      (await entriesOf(id)).some(
        (entry: any) => entry.kind === "pi.user" && entry.model?.[0]?.content === text
      );
    const queuedItem = async (id: number, text: string): Promise<any> => {
      const queue = await body(await api("/queue"));
      const session = queue.sessions.find((each: any) => Number(each.sessionId) === id);
      return session?.items.find((item: any) => item.text === text);
    };

    // `wedged` ignores cancellation and runs for seconds, so the worker is genuinely busy while
    // the leader writes to it. Responses are consumed in order: the worker's wedged step, the
    // leader's tool call and closing text, then the worker's answer after the boundary.
    faux.setResponses([
      toolCall("wedged", { ms: 6_000 }),
      toolCall("agents", { action: "send", name: "Researcher #1", message: "QUEUE_MARKER", followUp: true }),
      fauxAssistantMessage([fauxText("Queued it.")]),
      fauxAssistantMessage([fauxText("Worker picked up the follow-up.")]),
    ]);
    await api(`/conversations/${worker.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "hold on for a message" }),
    });
    await waitFor("the worker to be busy", () => busyOf(worker.id));
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "give the worker another task" }),
    });
    await waitFor("the queued reply", async () =>
      (await toolText(leader.id)).includes("Queued for Researcher #1.")
    );
    // The follow-up sits in the worker's inbox as a queued item until its turn boundary.
    expect((await queuedItem(worker.id, "QUEUE_MARKER"))?.mode).toBe("followUp");
    // And it arrives in the worker's own transcript once that boundary comes.
    await waitFor("the follow-up to land", () => hasUserText(worker.id, "QUEUE_MARKER"));
    await waitFor("the leader to settle", async () => !(await busyOf(leader.id)));

    // Steer (no `followUp`) takes the immediate path: the submission is a steer, not a follow-up.
    faux.setResponses([
      toolCall("wedged", { ms: 3_000 }),
      toolCall("agents", { action: "send", name: "researcher", message: "STEER_MARKER" }),
      fauxAssistantMessage([fauxText("Sent it.")]),
      fauxAssistantMessage([fauxText("Worker steered.")]),
    ]);
    await api(`/conversations/${worker.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "hold on again" }),
    });
    await waitFor("the worker to be busy again", () => busyOf(worker.id));
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "steer the worker" }),
    });
    await waitFor("the steer reply", async () => (await toolText(leader.id)).includes("Sent to Researcher #1."));
    expect((await queuedItem(worker.id, "STEER_MARKER"))?.mode).toBe("steer");
    await waitFor("the steer to land", () => hasUserText(worker.id, "STEER_MARKER"));

    // Let both settle before the next test scripts the shared faux provider.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (!(await busyOf(worker.id)) && !(await busyOf(leader.id))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, 60_000);

  test("an explicit `session spawn` with kind peer is ownerless and not a worker", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "team", brief: "Peer brief.", kind: "peer" })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Spawned a peer.")]),
      fauxAssistantMessage([fauxText("Peer answer.")]),
    ]);
    const parent = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Parent" }),
      })
    );
    await api(`/conversations/${parent.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Start a peer." }),
    });
    let peer: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      peer = list.conversations.find((entry: any) => entry.kind === "peer");
      if (peer) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(peer).toBeDefined();
    expect(peer.owner).toBeUndefined();
    expect(peer.lead).toBeUndefined();
    expect(peer.delegates).toBe(true);
  }, 20_000);

  test("a depth-3 leader refuses to spawn a fourth level", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "too-deep", brief: "Nested brief." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Understood.")]),
    ]);
    const make = async (): Promise<any> =>
      body(
        await api("/conversations", {
          method: "POST",
          body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
        })
      );
    const root = await make();
    const mid = await make();
    const near = await make();
    const leaf = await make();
    await stack.harness.commit(async (tx) => {
      (await tx.doc(MetaDoc, near.id)).lead = { conversationId: mid.id, host: "local" };
      (await tx.doc(MetaDoc, mid.id)).lead = { conversationId: root.id, host: "local" };
      (await tx.doc(MetaDoc, leaf.id)).lead = { conversationId: near.id, host: "local" };
    }, context);
    await api(`/conversations/${leaf.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn another level." }),
    });
    let toolText = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${leaf.id}`));
      toolText = snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
      if (toolText.includes("Refused")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(toolText).toContain("Refused");
    expect(toolText).toContain("depth 4");
  }, 20_000);

  test("a conversation created with delegates:false is refused a spawn, and stays refused", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "helper", brief: "Do the thing." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Doing it myself.")]),
    ]);
    const plain = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, delegates: false, title: "Plain chat" }),
      })
    );
    expect(plain.delegates).toBe(false);
    await api(`/conversations/${plain.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn a helper." }),
    });
    let toolText = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${plain.id}`));
      toolText = snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
      if (toolText.includes("Refused")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(toolText).toContain("not to delegate");
    // Nothing was created: the plain chat is still alone in the conversation beside the fixture's.
    const list = await body(await api("/conversations"));
    expect(list.conversations.some((entry: any) => entry.kind === "worker" && entry.lead?.conversationId === plain.id)).toBe(
      false
    );
  }, 20_000);

  test("a leader is refused a new crew right after being woken with its reports", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "second-crew", brief: "More work." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Report read.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, title: "Just woken" }),
      })
    );
    await stack.harness.commit(async (tx) => {
      const doc = await tx.doc(SessionsDoc, leader.id);
      doc.generation = 1;
      doc.woke = true;
      doc.wokeAt = Date.now() - 60_000;
    }, context);
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Anything else?" }),
    });
    let toolText = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${leader.id}`));
      toolText = snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
      if (toolText.includes("Refused")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(toolText).toContain("reported back");
    expect(toolText).toContain("message");
    const list = await body(await api("/conversations"));
    expect(list.conversations.some((entry: any) => entry.lead?.conversationId === leader.id)).toBe(false);
  }, 20_000);

  test("a leader with four active workers may start a fifth (no ceiling by default)", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "fifth", brief: "Another brief." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Understood.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await stack.harness.commit(async (tx) => {
      const doc = await tx.doc(SessionsDoc, leader.id);
      doc.generation = 1;
      doc.spawnedAt = [Date.now()];
      for (let index = 0; index < 4; index += 1) {
        doc.items[`w${index}`] = {
          kind: "worker",
          conversationId: (900000 + index) as any,
          title: `w${index}`,
          spawnedAt: Date.now(),
          state: "running",
          generation: 1,
          briefRequestId: "brief",
        };
      }
    }, context);
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn a fifth worker." }),
    });
    let toolText = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${leader.id}`));
      toolText = snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
      if (toolText.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Not refused: the ceiling is gone by default, so the leader got a worker, not a wall.
    expect(toolText).not.toContain("Refused");
    expect(toolText.toLowerCase()).toContain("worker");
  }, 20_000);

  test("needsInput is true while a question is parked and clears on reply", async () => {
    faux.setResponses([
      toolCall("ask", { question: "Which one?" }),
      fauxAssistantMessage([fauxText("Thanks.")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const before = (await body(await api("/conversations"))).conversations.find(
      (entry: any) => entry.id === conversation.id
    );
    expect(before.needsInput).toBe(false);
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "ask me" }),
    });
    let parked: any;
    let needsInput = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = (await body(await api("/conversations"))).conversations.find(
        (entry: any) => entry.id === conversation.id
      );
      if (found?.needsInput) {
        needsInput = true;
        const questions = await body(await api("/questions"));
        parked = questions.questions.find((each: any) => Number(each.conversationId) === conversation.id);
        if (parked) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(needsInput).toBe(true);
    expect(parked).toBeDefined();

    await api(`/questions/${conversation.id}/${parked.key}/reply`, {
      method: "POST",
      body: JSON.stringify({ answer: "one" }),
    });
    let cleared = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = (await body(await api("/conversations"))).conversations.find(
        (entry: any) => entry.id === conversation.id
      );
      if (!found?.needsInput) {
        cleared = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(cleared).toBe(true);
  }, 20_000);

  test("archiving a leader cascades to its worker (not its peer) and restores by batch", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("session", { action: "spawn", name: "wk", brief: "Worker brief." }),
          fauxToolCall("session", { action: "spawn", name: "pal", brief: "Peer brief.", kind: "peer" }),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Spawned both.")]),
      fauxAssistantMessage([fauxText("Worker answer.")]),
      fauxAssistantMessage([fauxText("Peer answer.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Crew leader" }),
      })
    );
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn a worker and a peer." }),
    });
    let worker: any;
    let peer: any;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const list = await body(await api("/conversations"));
      worker = list.conversations.find(
        (entry: any) => entry.kind === "worker" && entry.lead?.conversationId === leader.id
      );
      peer = list.conversations.find((entry: any) => entry.kind === "peer");
      if (worker && peer) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(worker).toBeDefined();
    expect(peer).toBeDefined();

    const archivedAt = Date.now();
    await api(`/conversations/${leader.id}`, { method: "PATCH", body: JSON.stringify({ archived: archivedAt }) });
    const leaderMeta = await stack.harness.snapshot(MetaDoc, leader.id, context);
    const workerMeta = await stack.harness.snapshot(MetaDoc, worker.id, context);
    const peerMeta = await stack.harness.snapshot(MetaDoc, peer.id, context);
    expect(leaderMeta?.archived).toBe(archivedAt);
    expect(workerMeta?.archived).toBe(archivedAt);
    expect(workerMeta?.archiveBatch).toBeDefined();
    expect(workerMeta?.archiveBatch).toBe(leaderMeta?.archiveBatch);
    // Peers are never cascaded.
    expect(peerMeta?.archived).toBeUndefined();

    await api(`/conversations/${leader.id}`, { method: "PATCH", body: JSON.stringify({ archived: null }) });
    const workerAfter = await stack.harness.snapshot(MetaDoc, worker.id, context);
    const peerAfter = await stack.harness.snapshot(MetaDoc, peer.id, context);
    expect(workerAfter?.archived).toBeUndefined();
    expect(workerAfter?.archiveBatch).toBeUndefined();
    expect(peerAfter?.archived).toBeUndefined();

    // Let the leader and children settle so later tests script against a quiet queue.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const list = await body(await api("/conversations"));
      const busy = list.conversations.some(
        (entry: any) => [leader.id, worker.id, peer.id].includes(entry.id) && entry.busy
      );
      if (!busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, 30_000);

  test("a busy worker is stopped before the archive cascade", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("session", { action: "spawn", name: "slow", brief: "Say hello first." })],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Spawned.")]),
      fauxAssistantMessage([fauxText("Worker ready.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ cwd: home, model: { provider: "faux", modelId: "faux-1" }, title: "Busy leader" }),
      })
    );
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Spawn a slow worker." }),
    });
    let worker: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      worker = list.conversations.find(
        (entry: any) => entry.kind === "worker" && entry.lead?.conversationId === leader.id
      );
      if (worker) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(worker).toBeDefined();

    // Wait until the worker's brief has been answered, so the next generation is ours.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${worker.id}`));
      if (snapshot.entries.some((entry: any) => entry.kind === "pi.assistant")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Drive the worker into a slow tool call deterministically, then archive the leader mid-run.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("slowecho", { text: "busy" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Slow done.")]),
    ]);
    await api(`/conversations/${worker.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Run the slow tool now." }),
    });

    let sawBusy = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = (await body(await api("/conversations"))).conversations.find(
        (entry: any) => entry.id === worker.id
      );
      if (found?.busy) {
        sawBusy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sawBusy).toBe(true);

    await api(`/conversations/${leader.id}`, { method: "PATCH", body: JSON.stringify({ archived: Date.now() }) });
    let stopped = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = (await body(await api("/conversations"))).conversations.find(
        (entry: any) => entry.id === worker.id
      );
      if (found && !found.busy && found.archived) {
        stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(stopped).toBe(true);
    const meta = await stack.harness.snapshot(MetaDoc, worker.id, context);
    expect(meta?.archived).toBeDefined();
  }, 30_000);

  test("the `session` tool's results action returns crew reports", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("session", { action: "results" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Read the reports.")]),
    ]);
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, title: "Reports" }),
      })
    );
    await stack.harness.commit(async (tx) => {
      const doc = await tx.doc(SessionsDoc, leader.id);
      doc.generation = 1;
      doc.items["wk"] = {
        kind: "worker",
        conversationId: 999001 as any,
        title: "Worker",
        spawnedAt: Date.now() - 1000,
        state: "reported",
        generation: 1,
        briefRequestId: "brief",
        report: { status: "ok", text: "REPORT_BODY_MARKER", at: Date.now(), requestId: "r" },
      };
    }, context);
    await api(`/conversations/${leader.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "Read results." }),
    });
    let toolText = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${leader.id}`));
      toolText = snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
      if (toolText.includes("REPORT_BODY_MARKER")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(toolText).toContain("REPORT_BODY_MARKER");
  }, 20_000);

  test("the crew supervisor reports a worker and wakes the leader exactly once per generation", async () => {
    const isolated = await openIsolated();
    try {
      isolated.faux.setResponses([fauxAssistantMessage([fauxText("handled the wake")])]);
      const leader = await isolated.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      const worker = await isolated.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      // The worker's final message is its report.
      await isolated.harness.commit(async (tx) => {
        await tx.appendEntry(worker.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage([fauxText("changed the thing")])],
        });
        const doc = await tx.doc(SessionsDoc, leader.id);
        doc.generation = 1;
        doc.deadlineAt = Date.now() + 60_000;
        doc.items["wk"] = {
          kind: "worker",
          conversationId: worker.id,
          title: "wk",
          spawnedAt: Date.now() - 1000,
          state: "starting",
          generation: 1,
          briefRequestId: "brief",
        };
      }, context);

      expect(await tick(isolated.harness, isolated.storage, context)).toBeGreaterThanOrEqual(1);
      const state = await isolated.harness.snapshot(SessionsDoc, leader.id, context);
      expect(state?.items["wk"]?.state).toBe("reported");
      expect(state?.items["wk"]?.report?.text).toBe("changed the thing");
      expect(state?.woke).toBe(true);

      const leaderEntries = await (await isolated.harness.conversation(leader.id, context))!.entries(
        {},
        50,
        undefined,
        context
      );
      const wakes = leaderEntries.items.filter(
        (entry) =>
          entry.kind === "pi.user" &&
          String((entry.model?.[0] as { content?: unknown } | undefined)?.content).startsWith("[crew] ")
      );
      expect(wakes).toHaveLength(1);
      const reports = leaderEntries.items.filter((entry) => entry.kind === "hearth.crew-report");
      expect(reports).toHaveLength(1);
      expect((reports[0].data as { text?: string }).text).toBe("changed the thing");
      // The digest names the worker and its state.
      expect(String((wakes[0].model?.[0] as { content?: unknown }).content)).toContain("wk (reported)");

      // A second tick changes nothing and sends no second wake.
      expect(await tick(isolated.harness, isolated.storage, context)).toBe(0);
      const after = await (await isolated.harness.conversation(leader.id, context))!.entries({}, 50, undefined, context);
      const wakesAfter = after.items.filter(
        (entry) =>
          entry.kind === "pi.user" &&
          String((entry.model?.[0] as { content?: unknown } | undefined)?.content).startsWith("[crew] ")
      );
      expect(wakesAfter).toHaveLength(1);
    } finally {
      await isolated.harness.close(context);
      await rm(isolated.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    }
  }, 20_000);

  test("an image submission reaches the transcript as image content", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("I can see it.")])]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const submitted = await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({
        type: "input",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
      }),
    });
    expect(submitted.status).toBe(201);

    // The user turn keeps its parts, so the transcript can show the image the human attached.
    const page = await body(await api(`/conversations/${conversation.id}/entries?limit=50`));
    const user = page.entries.find((entry: any) => entry.kind === "pi.user");
    expect(user).toBeDefined();
    expect(user.model[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", data: PNG_1X1, mimeType: "image/png" },
    ]);
  });

  test("`images=ref` replaces the payload with coordinates, and the bytes are served on demand", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("seen")])]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({
        type: "input",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
      }),
    });

    // Default is unchanged: a client that cannot resolve a reference keeps receiving the image.
    const plain = await body(await api(`/conversations/${conversation.id}/entries?limit=50`));
    const plainUser = plain.entries.find((entry: any) => entry.kind === "pi.user");
    expect(plainUser.model[0].content[1]).toEqual({ type: "image", data: PNG_1X1, mimeType: "image/png" });

    // Opt in and the payload becomes its coordinates -- no `data` anywhere in the page.
    const byRef = await body(await api(`/conversations/${conversation.id}/entries?limit=50&images=ref`));
    const user = byRef.entries.find((entry: any) => entry.kind === "pi.user");
    expect(user.model[0].content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(user.model[0].content[1]).toEqual({
      type: "image-ref",
      entryId: user.id,
      index: 0,
      mimeType: "image/png",
    });
    expect(JSON.stringify(byRef).includes(PNG_1X1)).toBe(false);

    // …and the bytes are exactly the ones that were submitted.
    const image = await api(`/conversations/${conversation.id}/entries/${user.id}/images/0`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(PNG_1X1);

    // Out of range, and an entry that does not exist, are 404s rather than stack traces.
    expect((await api(`/conversations/${conversation.id}/entries/${user.id}/images/9`)).status).toBe(404);
    expect((await api(`/conversations/${conversation.id}/entries/999999/images/0`)).status).toBe(404);
  });

  test("a submission refuses content parts a human turn cannot carry, and says why", async () => {
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const refused = await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: [{ type: "thinking", thinking: "nope" }] }),
    });
    expect(refused.status).toBe(400);
    // The client shows this text verbatim, so it has to name the actual problem.
    expect((await body(refused)).error).toContain("unsupported content part");
  });

  test("a queued image previews as [image] and survives a reorder", async () => {
    faux.setResponses([
      toolCall("slowecho", { text: "busy" }),
      fauxAssistantMessage([fauxText("done one")]),
      fauxAssistantMessage([fauxText("done two")]),
    ]);
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "go slow" }),
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === conversation.id)?.busy) break;
      if (Date.now() > deadline) throw new Error("conversation never became busy");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const queued = await body(
      await api(`/conversations/${conversation.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: [{ type: "image", data: PNG_1X1 }], whenBusy: "followUp" }),
      })
    );
    expect(queued.status).toBe("queued");
    await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "second", whenBusy: "followUp" }),
    });

    const queueOf = async () => {
      const queue = await body(await api("/queue"));
      return queue.sessions.find((entry: any) => Number(entry.sessionId) === conversation.id);
    };
    // An image-only queued message names its image rather than previewing as nothing.
    const before = await queueOf();
    expect(before.items.length).toBe(2);
    expect(before.items.map((item: any) => item.text)).toContain("[image]");
    // The parts come back too, so the client can keep showing the image on the queued row.
    const withImage = before.items.find((item: any) => item.text === "[image]");
    expect(withImage.content).toEqual([{ type: "image", data: PNG_1X1, mimeType: "image/png" }]);

    // Reordering withdraws and re-submits each item, so the parts must survive the round trip.
    await body(
      await api(`/conversations/${conversation.id}/queue/order`, {
        method: "PUT",
        body: JSON.stringify({ itemIds: before.items.map((item: any) => item.id).reverse() }),
      })
    );
    const after = await queueOf();
    expect(after.items.length).toBe(2);
    expect(after.items.map((item: any) => item.text)).toContain("[image]");
    expect(after.items.find((item: any) => item.text === "[image]").content).toEqual([
      { type: "image", data: PNG_1X1, mimeType: "image/png" },
    ]);
  }, 30_000);

  test("an image submission is refused by name when the model cannot see", async () => {
    // A second faux provider (registered with the stack) whose single model declares text only. The
    // image gate in ./images cannot know this: what a model sees is its catalog entry's `input`, and
    // pi-ai swaps images for a placeholder text when it lacks "image" — a silent, successful
    // turn in which the model reports nothing attached. The wire refuses instead, naming the model.
    const conversation = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "blind", modelId: "blind-1" } }),
      })
    );

    const refused = await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({
        type: "input",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
      }),
    });
    expect(refused.status).toBe(400);
    const error = (await body(refused)).error as string;
    // The client shows this verbatim, so it has to name the model and the way out.
    expect(error).toContain("blind/blind-1");
    expect(error).toContain("does not accept images");
    // Nothing was queued or written: the refusal happens before the submission is placed.
    const list = await body(await api("/conversations"));
    expect(list.conversations.find((entry: any) => entry.id === conversation.id)?.busy).toBe(false);
    const queue = await body(await api("/queue"));
    expect(queue.sessions.find((entry: any) => Number(entry.sessionId) === conversation.id)).toBeUndefined();

    // The same provider still takes a text-only message: the check is about images, not the model.
    faux.setResponses([fauxAssistantMessage([fauxText("text is fine")])]);
    blind.setResponses([fauxAssistantMessage([fauxText("text is fine")])]);
    const accepted = await api(`/conversations/${conversation.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "just text" }),
    });
    expect(accepted.status).toBe(201);
  }, 30_000);

  test("the directory lists a registered agent with live status and omits a gone conversation", async () => {
    const target = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Directory target", model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const now = Date.now();
    await stack.harness.commit(async (tx) => {
      await registerAgent(tx, "Directory agent", {
        conversationId: target.id,
        host: "local",
        description: "helps with directories",
        pinned: true,
        createdAt: now,
        updatedAt: now,
      });
      await registerAgent(tx, "Gone agent", {
        conversationId: 987654321,
        host: "local",
        pinned: false,
        createdAt: now,
        updatedAt: now,
      });
    }, context);

    const listOf = async (): Promise<any[]> => (await body(await api("/directory"))).agents;
    const findAgent = async (name: string): Promise<any> =>
      (await listOf()).find((entry: any) => entry.name === name);

    expect(await findAgent("Directory agent")).toMatchObject({
      name: "Directory agent",
      conversationId: target.id,
      host: "local",
      title: "Directory target",
      description: "helps with directories",
      pinned: true,
      busy: false,
      needsInput: false,
    });
    // The registry row survives, but a conversation that is gone is not advertised.
    expect(await findAgent("Gone agent")).toBeUndefined();
    expect((await stack.harness.snapshot(AgentsDoc, context))?.entries["Gone agent"]).toBeDefined();

    // Busy comes from the live run, the same signal `/conversations` uses.
    faux.setResponses([
      toolCall("slowecho", { text: "directory busy" }),
      fauxAssistantMessage([fauxText("Busy done.")]),
    ]);
    await api(`/conversations/${target.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "be busy for the directory" }),
    });
    let sawBusy = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await findAgent("Directory agent"))?.busy) {
        sawBusy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sawBusy).toBe(true);
    await api(`/conversations/${target.id}/abort`, { method: "POST", body: "{}" });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!(await findAgent("Directory agent"))?.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // needsInput comes from the parked question, so the directory needs no second read.
    faux.setResponses([
      toolCall("ask", { question: "Directory question?" }),
      fauxAssistantMessage([fauxText("Thanks.")]),
    ]);
    await api(`/conversations/${target.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "ask the directory question" }),
    });
    let parked: any;
    let sawNeedsInput = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await findAgent("Directory agent"))?.needsInput) {
        sawNeedsInput = true;
        const questions = await body(await api("/questions"));
        parked = questions.questions.find((each: any) => Number(each.conversationId) === target.id);
        if (parked) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sawNeedsInput).toBe(true);
    expect(parked).toBeDefined();
    await api(`/questions/${target.id}/${parked.key}/reply`, {
      method: "POST",
      body: JSON.stringify({ answer: "answered" }),
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!(await findAgent("Directory agent"))?.needsInput) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, 30_000);

  test("the `agents` tool sends to a named agent and fails helpfully for an unknown name", async () => {
    const recipient = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Wire recipient", model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const now = Date.now();
    await stack.harness.commit(async (tx) => {
      await registerAgent(tx, "Wire recipient", {
        conversationId: recipient.id,
        host: "local",
        pinned: false,
        createdAt: now,
        updatedAt: now,
      });
    }, context);
    const operator = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Wire operator", model: { provider: "faux", modelId: "faux-1" } }),
      })
    );

    const toolText = async (id: number): Promise<string> => {
      const snapshot = await body(await api(`/conversations/${id}`));
      return snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
    };

    // Unknown names fail with the name and the policy, never a silent send.
    faux.setResponses([
      toolCall("agents", { action: "send", name: "Ghost", message: "hello" }),
      fauxAssistantMessage([fauxText("No such agent.")]),
    ]);
    await api(`/conversations/${operator.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "send to ghost" }),
    });
    let unknownText = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      unknownText = await toolText(operator.id);
      if (unknownText.includes("No agent named Ghost")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(unknownText).toContain("No agent named Ghost");
    // Only a human can register: the tool says so rather than offering a register action.
    expect(unknownText).toContain("Only a human");

    faux.setResponses([
      toolCall("agents", { action: "send", name: "Wire recipient", message: "PING_MARKER" }),
      fauxAssistantMessage([fauxText("Sent it.")]),
      fauxAssistantMessage([fauxText("Recipient reply.")]),
    ]);
    await api(`/conversations/${operator.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "send the ping" }),
    });
    let delivered = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = await body(await api(`/conversations/${recipient.id}`));
      delivered = snapshot.entries.some(
        (entry: any) => entry.kind === "pi.user" && entry.model?.[0]?.content === "PING_MARKER"
      );
      if (delivered) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(delivered).toBe(true);
    expect(await toolText(operator.id)).toContain("Sent to Wire recipient.");

    // Let both settle before the next test scripts the shared faux provider.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const list = await body(await api("/conversations"));
      const busy = list.conversations.some(
        (entry: any) => [operator.id, recipient.id].includes(entry.id) && entry.busy
      );
      if (!busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, 30_000);

  test("pin and unpin change the directory order and the mirrored agents.json", async () => {
    const now = Date.now();
    await stack.harness.commit(async (tx) => {
      await registerAgent(tx, "Pin Alpha", {
        conversationId: (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
        host: "local",
        pinned: false,
        createdAt: now - 5_000,
        updatedAt: now - 5_000,
      });
      await registerAgent(tx, "Pin Beta", {
        conversationId: (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
        host: "local",
        pinned: false,
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      });
    }, context);
    const operator = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const names = async (): Promise<string[]> =>
      (await body(await api("/directory"))).agents.map((entry: any) => entry.name);
    const order = async (): Promise<[number, number]> => {
      const listed = await names();
      return [listed.indexOf("Pin Alpha"), listed.indexOf("Pin Beta")];
    };
    const [alphaBefore, betaBefore] = await order();
    expect(betaBefore).toBeLessThan(alphaBefore);

    const toolText = async (): Promise<string> => {
      const snapshot = await body(await api(`/conversations/${operator.id}`));
      return snapshot.entries
        .filter((entry: any) => entry.kind === "pi.tool-result")
        .map((entry: any) => entry.model?.[0]?.content ?? "")
        .flatMap((content: any) => (Array.isArray(content) ? content.map((part: any) => part.text ?? "") : []))
        .join("\n");
    };

    faux.setResponses([
      toolCall("agents", { action: "pin", name: "Pin Alpha" }),
      fauxAssistantMessage([fauxText("Pinned.")]),
    ]);
    await api(`/conversations/${operator.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "pin alpha" }),
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await toolText()).includes("Pinned Pin Alpha.")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [alphaPinned, betaPinned] = await order();
    expect(alphaPinned).toBeLessThan(betaPinned);
    expect(readAgentsMirror(home)?.["Pin Alpha"].pinned).toBe(true);

    faux.setResponses([
      toolCall("agents", { action: "unpin", name: "Pin Alpha" }),
      fauxAssistantMessage([fauxText("Unpinned.")]),
    ]);
    await api(`/conversations/${operator.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "unpin alpha" }),
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await toolText()).includes("Unpinned Pin Alpha.")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [alphaUnpinned, betaUnpinned] = await order();
    expect(betaUnpinned).toBeLessThan(alphaUnpinned);
    expect(readAgentsMirror(home)?.["Pin Alpha"].pinned).toBe(false);
  }, 30_000);

  test("promotion forks a worker into a named ownerless peer and rejects bad requests", async () => {
    const leader = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Promote leader", model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    const worker = await body(
      await api("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Worker title", model: { provider: "faux", modelId: "faux-1" } }),
      })
    );
    await stack.harness.commit(async (tx) => {
      const meta = await tx.doc(MetaDoc, worker.id);
      meta.kind = "worker";
      meta.lead = { conversationId: leader.id, host: "local" };
      meta.delegates = true;
      const crew = await tx.doc(SessionsDoc, leader.id);
      crew.generation = 1;
      crew.items.wk = {
        kind: "worker",
        conversationId: worker.id,
        title: "Worker title",
        spawnedAt: Date.now(),
        state: "reported",
        generation: 1,
        briefRequestId: "brief",
      };
      await tx.appendEntry(worker.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "worker history", timestamp: Date.now() } as any],
      });
    }, context);

    // Only a worker can be promoted.
    const notWorker = await api(`/conversations/${leader.id}/promote`, {
      method: "POST",
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(notWorker.status).toBe(400);

    // A busy worker must be waited for or stopped first.
    faux.setResponses([
      toolCall("slowecho", { text: "promotion busy" }),
      fauxAssistantMessage([fauxText("Slow done.")]),
    ]);
    await api(`/conversations/${worker.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ type: "input", content: "be busy while promoted" }),
    });
    let busy = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const list = await body(await api("/conversations"));
      if (list.conversations.find((entry: any) => entry.id === worker.id)?.busy) {
        busy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(busy).toBe(true);
    const refusedBusy = await api(`/conversations/${worker.id}/promote`, {
      method: "POST",
      body: JSON.stringify({ name: "Wire improver" }),
    });
    expect(refusedBusy.status).toBe(409);
    expect((await body(refusedBusy)).error).toContain("wait or stop it first");
    await api(`/conversations/${worker.id}/abort`, { method: "POST", body: "{}" });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = await body(await api("/conversations"));
      if (!list.conversations.find((entry: any) => entry.id === worker.id)?.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const promoted = await api(`/conversations/${worker.id}/promote`, {
      method: "POST",
      body: JSON.stringify({ name: "Wire improver", description: "Improves the harness", pinned: true }),
    });
    expect(promoted.status).toBe(201);
    const fork = await body(promoted);
    expect(fork.id).not.toBe(worker.id);
    expect(fork.kind).toBe("peer");
    expect(fork.lead).toEqual({ conversationId: leader.id, host: "local" });
    expect(fork.delegates).toBe(true);
    expect(fork.title).toBe("Wire improver");
    expect(fork.owner).toBeUndefined();

    // The worker itself stays a worker (hidden history), linked to its fork.
    const workerMeta = await stack.harness.snapshot(MetaDoc, worker.id, context);
    expect(workerMeta?.kind).toBe("worker");
    expect(workerMeta?.promotedTo).toBe(fork.id);
    expect(workerMeta?.archived).toBeUndefined();
    const crew = await stack.harness.snapshot(SessionsDoc, leader.id, context);
    expect(crew?.items.wk.promotedTo).toBe(fork.id);

    // The fork is a normal peer in the list; the worker is still there as a worker.
    const list = await body(await api("/conversations"));
    const listedFork = list.conversations.find((entry: any) => entry.id === fork.id);
    const listedWorker = list.conversations.find((entry: any) => entry.id === worker.id);
    expect(listedFork?.kind).toBe("peer");
    expect(listedWorker?.kind).toBe("worker");
    expect(listedWorker?.promotedTo).toBe(fork.id);

    // The registry and the passive mirror both name the peer.
    const directory = await body(await api("/directory"));
    expect(directory.agents.find((entry: any) => entry.name === "Wire improver")).toMatchObject({
      conversationId: fork.id,
      host: "local",
      title: "Wire improver",
      description: "Improves the harness",
      pinned: true,
    });
    expect(readAgentsMirror(home)?.["Wire improver"].conversationId).toBe(fork.id);

    // A local duplicate name is rejected before it can fork anything.
    const duplicate = await api(`/conversations/${worker.id}/promote`, {
      method: "POST",
      body: JSON.stringify({ name: "Wire improver" }),
    });
    expect(duplicate.status).toBe(400);
    expect((await body(duplicate)).error).toContain("already registered");
  }, 30_000);
});
