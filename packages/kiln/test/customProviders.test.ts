import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CustomProviders, customBaseUrl, discoverCustomModels } from "../src/custom-providers";
import { FileCredentialStore } from "../src/credentials";
import { hearthConfig } from "../src/config";
import { startHearthServer, type HearthServer } from "../src/server";

const home = mkdtempSync(join(tmpdir(), "kiln-custom-"));
const store = new FileCredentialStore(join(home, "auth.json"));
const models = createModels({ credentials: store });
const custom = new CustomProviders(home, store, models);
const requests: { path: string; authorization: string | null; body?: Record<string, unknown> }[] = [];
const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push({ path, authorization: request.headers.get("authorization"), ...(request.method === "POST" ? { body: await request.json() as Record<string, unknown> } : {}) });
  if (path === "/broken/models") return Response.json({ models: ["wrong shape"] });
  if (path === "/refused/models") return new Response("secret-upstream-diagnostic", { status: 401 });
  if (path === "/redirect/models") return Response.redirect("http://127.0.0.1:1/steal", 302);
  if (path.endsWith("/models")) return Response.json({ data: [{ id: "deepseek-v4.1-flash" }] });
  if (path.endsWith("/chat/completions")) return new Response('data: {"id":"mock","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  return new Response("not found", { status: 404 });
} });
const baseUrl = `http://127.0.0.1:${upstream.port}/api/v1`;
const TOKEN = "custom-test-0123456789abcdef0123456789abcdef";
let server: HearthServer;
let harness: Awaited<ReturnType<typeof Harness.open>>;
const api = (path: string, method = "GET", body?: unknown) => fetch(`${server.url}${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeAll(async () => {
  const storage = await openNodeSqliteStorage(join(home, "test.sqlite"));
  harness = await Harness.open(storage, { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? home }) }, BACKGROUND_CONTEXT);
  server = startHearthServer({ config: hearthConfig({ home, port: 0, workspace: home }), token: TOKEN, storage, harness, models, store, customProviders: custom,
    defaultAgent: { model: { provider: "existing", modelId: "unchanged" } } });
});
afterAll(async () => {
  await server?.close(); await harness?.close(BACKGROUND_CONTEXT); upstream.stop(true); rmSync(home, { recursive: true, force: true });
});

describe("custom OpenAI-compatible providers", () => {
  test("URL validation permits LAN hosts, IPv6 and API paths, not credentials or unsafe schemes", () => {
    for (const url of ["http://spark:8000/v1", "https://inference.example/api/openai", "http://192.168.1.2:3000/v1", "http://[::1]:8000/v1"]) expect(customBaseUrl(url)).toBe(url);
    for (const url of ["file:///etc/passwd", "ftp://spark/v1", "http://user:password@spark/v1", "https://spark/v1?key=secret", "https://spark/v1#secret", "/relative"]) expect(() => customBaseUrl(url)).toThrow();
  });
  test("discovery uses the exact API path, optional bearer key, and no redirects", async () => {
    expect((await discoverCustomModels(baseUrl)).modelIds).toEqual(["deepseek-v4.1-flash"]);
    expect(requests.at(-1)).toMatchObject({ path: "/api/v1/models", authorization: null });
    expect((await discoverCustomModels(baseUrl, "test-secret")).error).toBeUndefined();
    expect(requests.at(-1)?.authorization).toBe("Bearer test-secret");
    const failure = await discoverCustomModels(`http://127.0.0.1:${upstream.port}/broken`);
    expect(failure.error).toContain("answered"); expect(failure.error).toContain("OpenAI"); expect(failure.error).toContain("manually");
    const refused = await discoverCustomModels(`http://127.0.0.1:${upstream.port}/refused`, "test-secret");
    expect(refused.error).not.toContain("secret-upstream"); expect(refused.error).toContain("key");
    expect((await discoverCustomModels("http://127.0.0.1:1/v1")).error).toContain("could not reach");
    expect((await discoverCustomModels(`http://127.0.0.1:${upstream.port}/redirect`, "test-secret")).modelIds).toEqual([]);
    expect(requests.some(request => request.path === "/steal")).toBe(false);
  });
  test("authenticated CRUD, manual fallback, private persistence, stable editing and removal", async () => {
    expect((await fetch(`${server.url}/custom-providers`)).status).toBe(401);
    const discovered = await api("/custom-providers/discover", "POST", { baseUrl: `http://127.0.0.1:${upstream.port}/broken` });
    expect((await discovered.json() as { error: string }).error).toContain("manually");
    const response = await api("/custom-providers", "POST", { name: "Spark", baseUrl, modelIds: ["deepseek-v4.1-flash"], apiKey: "private-key" });
    expect(response.status).toBe(200);
    const saved = await response.json() as { id: string; hasApiKey: boolean };
    expect(saved.id).toMatch(/^custom-/); expect(saved.hasApiKey).toBe(true);
    const metadata = await (await api("/custom-providers")).text(); expect(metadata).not.toContain("private-key"); expect(metadata).not.toContain('"apiKey"');
    const file = readFileSync(join(home, "custom-providers.json"), "utf8"); expect(file).not.toContain("private-key");
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "custom-providers.json")).mode & 0o777).toBe(0o600);
    const restartedModels = createModels({ credentials: store });
    const restarted = new CustomProviders(home, store, restartedModels);
    expect((await restarted.list())[0]?.id).toBe(saved.id);
    expect((await restartedModels.getAvailable()).map(model => model.id)).toContain("deepseek-v4.1-flash");
    const edit = await api(`/custom-providers/${saved.id}`, "PUT", { name: "Spark renamed", baseUrl, modelIds: ["manual-new"] });
    expect(edit.status).toBe(200); expect((await edit.json() as { id: string }).id).toBe(saved.id);
    expect(models.getModel(saved.id, "deepseek-v4.1-flash")).toBeUndefined(); expect(models.getModel(saved.id, "manual-new")).toBeDefined();
    expect((await api(`/custom-providers/${saved.id}`, "PUT", { name: "Spark", baseUrl: baseUrl + "/other", modelIds: ["manual-new"] })).status).toBe(400);
    const denied = await api("/custom-providers/discover", "POST", { id: saved.id, baseUrl: `http://127.0.0.1:${upstream.port}/other` });
    expect(denied.status).toBe(200); expect(requests.at(-1)?.authorization).toBeNull();
    const defaultBefore = await (await api("/models")).json() as { default: unknown };
    expect(defaultBefore.default).toEqual({ provider: "existing", modelId: "unchanged" });
    expect((await api(`/custom-providers/${saved.id}`, "DELETE")).status).toBe(200);
    expect(models.getProvider(saved.id)).toBeUndefined(); expect(await store.read(saved.id)).toBeUndefined();
    expect((await (await api("/models")).json() as { default: unknown }).default).toEqual(defaultBefore.default);
    expect(JSON.parse(readFileSync(join(home, "custom-providers.json"), "utf8"))).toEqual([]);
  });
  test("invalid configuration and failed persistence leave the existing provider and key intact", async () => {
    const config = await custom.save({ name: "Spark", baseUrl, modelIds: ["old-model"], apiKey: "old-key" });
    const path = `/custom-providers/${config.id}`;
    for (const patch of [{ baseUrl: "file:///secret" }, { modelIds: [] }, { apiKey: "bad\r\nheader" }, { name: "" }]) {
      expect((await api(path, "PUT", { name: "Spark", baseUrl, modelIds: ["old-model"], ...patch })).status).toBe(400);
    }
    mkdirSync(join(home, "custom-providers.json.tmp"));
    try {
      const failure = await api(path, "PUT", { name: "Changed", baseUrl, modelIds: ["new-model"], apiKey: "new-key" });
      expect(failure.status).toBe(400); expect(await failure.text()).not.toContain("new-key");
      expect((await store.read(config.id))?.type).toBe("api_key"); expect(await custom.key(config.id)).toBe("old-key");
      expect(models.getModel(config.id, "old-model")).toBeDefined(); expect(models.getModel(config.id, "new-model")).toBeUndefined();
    } finally { rmSync(join(home, "custom-providers.json.tmp"), { recursive: true, force: true }); }
    await custom.remove(config.id);
  });
  test("keyed and keyless inference construct standard chat-completions requests without account calls", async () => {
    for (const key of ["inference-secret", ""]) {
      const config = await custom.save({ name: "Spark", baseUrl, modelIds: ["deepseek-v4.1-flash"], apiKey: key });
      const model = models.getModel(config.id, "deepseek-v4.1-flash")!;
      expect((await models.getAuth(model))?.auth.apiKey).toBe(key || "unused");
      const result = await models.streamSimple(model, { messages: [{ role: "user", content: "Test request", timestamp: Date.now() }] }, { maxTokens: 32 }).result();
      expect(result.errorMessage).toBeUndefined(); expect(result.stopReason).toBe("stop");
      const request = requests.at(-1)!;
      expect(request.path).toBe("/api/v1/chat/completions"); expect(request.body?.model).toBe("deepseek-v4.1-flash");
      expect(request.body?.stream).toBe(true); expect(request.authorization).toBe(key ? `Bearer ${key}` : null);
      expect(request.body?.max_tokens).toBe(32); expect(request.body).not.toHaveProperty("max_completion_tokens");
      expect(request.body).not.toHaveProperty("store"); expect(request.body).not.toHaveProperty("reasoning_effort");
      expect((await models.getAvailable()).some(model => model.provider === config.id)).toBe(true);
      await models.refresh(); expect(models.getModel(config.id, "deepseek-v4.1-flash")).toBeDefined();
      await custom.remove(config.id);
    }
  });
});
