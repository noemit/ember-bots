import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { hearthConfig } from "../src/config";
import { deepinfraProvider, kimiProviders } from "../src/models";
import { hearthRegistry } from "../src/registry";
import {
  anthropicWithDiscovery,
  createModelsDevCache,
  deepseekWithDiscovery,
  fireworksWithDiscovery,
  githubCopilotWithDiscovery,
  googleWithDiscovery,
  openaiCodexWithDiscovery,
  openaiWithDiscovery,
  openrouterWithDiscovery,
  xaiWithDiscovery,
} from "../src/provider-discovery";
import { startHearthServer, type HearthServer } from "../src/server";

const realFetch = globalThis.fetch;
const tempDirs: string[] = [];
const servers: HearthServer[] = [];
const harnesses: Harness[] = [];

const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-provider-discovery-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env.HEARTH_DISCOVER_MODELS;
  for (const server of servers.splice(0)) await server.close();
  for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dynamic provider catalog discovery", () => {
  test("ModelsDevCache coalesces concurrent forced refreshes onto one fetch and falls back from v2 to v1", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/experimental/v2.0/")) {
        return new Response("upstream unavailable", { status: 503 });
      }
      return Response.json({
        openai: {
          models: {
            "gpt-6.5-nova": {
              id: "gpt-6.5-nova",
              name: "GPT-6.5 Nova",
              tool_call: true,
              reasoning: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 512_000, output: 128_000 },
              cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 0 },
            },
          },
        },
        anthropic: {
          models: {
            "claude-opus-6": {
              id: "claude-opus-6",
              name: "Claude Opus 6",
              tool_call: true,
              reasoning: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 1_000_000, output: 128_000 },
              cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const cache = createModelsDevCache();
    const [first, second, third] = await Promise.all([
      cache.get(undefined, true),
      cache.get(undefined, true),
      cache.get(undefined, true),
    ]);

    expect(calls).toHaveLength(2); // 1 failed v2 + 1 shared v1 fallback
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first?.get("openai")?.get("gpt-6.5-nova")).toMatchObject({
      name: "GPT-6.5 Nova",
      toolCall: true,
      reasoning: true,
      imageInput: true,
      contextWindow: 512_000,
    });
  });

  test("OpenAI, Anthropic, Google, xAI, and DeepSeek discover minute-zero models while filtering non-chat endpoints", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("models.dev")) {
        return Response.json({
          anthropic: {
            models: {
              "claude-sonnet-6": {
                id: "claude-sonnet-6",
                type: "chat",
                name: "Claude Sonnet 6",
                modalities: { input: ["text", "image"], output: ["text"] },
                capabilities: {
                  tools: { supported: true },
                  reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] },
                },
                limit: { context: 1_000_000, output: 128_000 },
                cost: { text: { input: { price: 3, cache: { read: 0.3, write: 3.75 } }, output: { price: 15 } } },
                api: { anthropic: { base_url: "https://api.anthropic.com" } },
              },
            },
          },
        });
      }
      if (url.startsWith("https://api.openai.com/v1/models")) {
        return Response.json({
          data: [
            { id: "gpt-6.2-omni" },
            { id: "o5-pro" },
            { id: "whisper-1" },
            { id: "text-embedding-3-large" },
            { id: "dall-e-3" },
            { id: "gpt-realtime-2.1" },
            { id: "gpt-6.2-omni-2026-11-17" },
          ],
        });
      }
      if (url.startsWith("https://api.anthropic.com/v1/models")) {
        return Response.json({
          data: [
            {
              id: "claude-opus-6",
              display_name: "Claude Opus 6",
              max_input_tokens: 1_000_000,
              max_tokens: 128_000,
              capabilities: { image_input: { supported: true }, thinking: { supported: true } },
            },
          ],
        });
      }
      if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
        return Response.json({
          models: [
            {
              name: "models/gemini-4.2-pro",
              displayName: "Gemini 4.2 Pro",
              inputTokenLimit: 2_097_152,
              outputTokenLimit: 65_536,
              thinking: true,
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/imagen-4.0-generate",
              supportedGenerationMethods: ["predict"],
            },
            {
              name: "models/text-embedding-005",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        });
      }
      if (url.startsWith("https://api.x.ai/v1/models")) {
        return Response.json({
          data: [{ id: "grok-5" }, { id: "grok-2-image-1212" }],
        });
      }
      if (url.startsWith("https://api.deepseek.com/models")) {
        return Response.json({
          data: [{ id: "deepseek-v4.5" }, { id: "deepseek-embed" }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-openai" }));
    await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-anthropic" }));
    await credentials.modify("google", async () => ({ type: "api_key", key: "sk-google" }));
    await credentials.modify("xai", async () => ({ type: "api_key", key: "sk-xai" }));
    await credentials.modify("deepseek", async () => ({ type: "api_key", key: "sk-deepseek" }));

    const modelsStore = new InMemoryModelsStore();
    const models = createModels({ credentials, modelsStore });
    const cache = createModelsDevCache();
    models.setProvider(openaiWithDiscovery(cache));
    models.setProvider(anthropicWithDiscovery(cache));
    models.setProvider(googleWithDiscovery(cache));
    models.setProvider(xaiWithDiscovery(cache));
    models.setProvider(deepseekWithDiscovery(cache));

    await models.refresh({ allowNetwork: true, force: true });

    // All five providers shared one models.dev v2 fetch.
    expect(urls.filter((u) => u.includes("models.dev"))).toHaveLength(1);

    const openaiIds = models.getModels("openai").map((m) => m.id);
    expect(openaiIds).toContain("gpt-6.2-omni");
    expect(openaiIds).toContain("o5-pro");
    expect(openaiIds).not.toContain("whisper-1");
    expect(openaiIds).not.toContain("text-embedding-3-large");
    expect(openaiIds).not.toContain("dall-e-3");
    expect(openaiIds).not.toContain("gpt-realtime-2.1");
    expect(openaiIds).not.toContain("gpt-6.2-omni-2026-11-17");

    const opus6 = models.getModel("anthropic", "claude-opus-6");
    expect(opus6).toMatchObject({
      name: "Claude Opus 6",
      api: "anthropic-messages",
      contextWindow: 1_000_000,
      compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
    });
    expect(models.getModel("anthropic", "claude-sonnet-6")).toMatchObject({
      name: "Claude Sonnet 6",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });

    const gemini = models.getModel("google", "gemini-4.2-pro");
    expect(gemini).toMatchObject({
      name: "Gemini 4.2 Pro",
      api: "google-generative-ai",
      contextWindow: 2_097_152,
      reasoning: true,
    });
    expect(models.getModel("google", "imagen-4.0-generate")).toBeUndefined();
    expect(models.getModel("google", "text-embedding-005")).toBeUndefined();

    expect(models.getModel("xai", "grok-5")).toMatchObject({ api: "openai-responses" });
    expect(models.getModel("xai", "grok-2-image-1212")).toBeUndefined();

    expect(models.getModel("deepseek", "deepseek-v4.5")).toMatchObject({
      api: "openai-completions",
      compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    });
  });

  test("OpenRouter, Codex, and GitHub Copilot synthesize newly released chat models from their live catalogs", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/models/user")) {
        return Response.json({
          data: [
            {
              id: "anthropic/claude-opus-6",
              name: "Anthropic: Claude Opus 6",
              supported_parameters: ["tools", "reasoning"],
              architecture: { modality: "text+image->text" },
              context_length: 1_000_000,
              top_provider: { max_completion_tokens: 128_000 },
              pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005", input_cache_write: "0.00000625" },
              reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high", "max"] },
            },
            {
              id: "qwen/qwen-4-coder",
              name: "Qwen 4 Coder",
              supported_parameters: ["tools"],
              architecture: { modality: "text->text" },
              context_length: 262_144,
              pricing: { prompt: "0.0000004", completion: "0.0000012" },
            },
            {
              id: "black-forest-labs/flux-2",
              name: "Flux 2",
              supported_parameters: [],
              architecture: { modality: "text->image" },
            },
          ],
        });
      }
      if (url.endsWith("/codex/models")) {
        return Response.json({
          models: [{ slug: "gpt-6.3-codex", display_name: "GPT-6.3 Codex", context_window: 500_000 }],
        });
      }
      if (url.includes("githubcopilot.com/models")) {
        return Response.json({
          data: [
            {
              id: "claude-opus-5.8",
              name: "Claude Opus 5.8",
              capabilities: {
                type: "chat",
                supports: { tool_calls: true, vision: true, thinking: true },
                limits: { max_context_window_tokens: 400_000, max_output_tokens: 64_000 },
              },
            },
          ],
        });
      }
      if (url.includes("models.dev")) return Response.json({});
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: "sk-or" }));
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "codex-token",
      refresh: "codex-refresh",
      expires: Date.now() + 3600_000,
      accountId: "acct-1",
    }));
    await credentials.modify("github-copilot", async () => ({
      type: "oauth",
      access: "tid=1;proxy-ep=proxy.individual.githubcopilot.com",
      refresh: "gh-refresh",
      expires: Date.now() + 3600_000,
      availableModelIds: ["gpt-5.3-codex"],
    }));

    const models = createModels({ credentials });
    const cache = createModelsDevCache();
    models.setProvider(openrouterWithDiscovery());
    models.setProvider(openaiCodexWithDiscovery());
    models.setProvider(githubCopilotWithDiscovery(cache));

    await models.refresh({ allowNetwork: true, force: true });

    const orAnthropic = models.getModel("openrouter", "anthropic/claude-opus-6");
    expect(orAnthropic).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://openrouter.ai/api",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", max: "max" },
    });
    const orQwen = models.getModel("openrouter", "qwen/qwen-4-coder");
    expect(orQwen).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      compat: { thinkingFormat: "openrouter", supportsDeveloperRole: false },
    });
    expect(models.getModel("openrouter", "black-forest-labs/flux-2")).toBeUndefined();

    expect(models.getModel("openai-codex", "gpt-6.3-codex")).toMatchObject({
      api: "openai-codex-responses",
      contextWindow: 500_000,
    });

    const copilotAvailable = await models.getAvailable("github-copilot");
    expect(copilotAvailable.map((m) => m.id)).toContain("claude-opus-5.8");
  });

  test("POST /models/refresh updates connected providers dynamically over the Hearth HTTP wire and skips unkeyed ones", async () => {
    let releaseNum = 1;
    const calledHosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      calledHosts.push(url);
      if (url.startsWith("https://api.openai.com/v1/models")) {
        return Response.json({ data: [{ id: `gpt-6.${releaseNum}-live` }] });
      }
      if (url.includes("models.dev")) return Response.json({});
      return new Response("unexpected upstream call", { status: 500 });
    }) as unknown as typeof fetch;

    const home = makeDir();
    const config = hearthConfig({
      home,
      port: 0,
      workspace: home,
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-openai-live" }));
    // xai has NO credential: Refresh must skip it without hitting api.x.ai.
    const cache = createModelsDevCache();
    const models = createModels({ credentials });
    models.setProvider(openaiWithDiscovery(cache));
    models.setProvider(xaiWithDiscovery(cache));

    const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
    const harness = await Harness.open(
      storage,
      { models, registry: hearthRegistry(home), env: () => new NodeExecutionEnv({ cwd: home }) },
      BACKGROUND_CONTEXT
    );
    harnesses.push(harness);

    const server = startHearthServer({
      config,
      token: "test-secret",
      storage,
      harness,
      models,
      defaultAgent: { model: { provider: "openai", modelId: "gpt-5.4" } },
      store: credentials,
    });
    servers.push(server);

    const authHeaders = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

    // Before refresh, GET /models returns only the shipped catalog.
    const before = (await (await realFetch(`${server.url}/models`, { headers: authHeaders })).json()) as {
      models: Array<{ id: string; provider: string }>;
    };
    expect(before.models.some((m) => m.id === "gpt-6.1-live")).toBe(false);

    // Clicking Refresh calls POST /models/refresh and discovers gpt-6.1-live without restarting Kiln.
    const firstRefresh = (await (
      await realFetch(`${server.url}/models/refresh`, { method: "POST", headers: authHeaders, body: "{}" })
    ).json()) as { models: Array<{ id: string; provider: string }> };
    expect(firstRefresh.models.some((m) => m.id === "gpt-6.1-live")).toBe(true);
    expect(calledHosts.some((u) => u.includes("api.x.ai"))).toBe(false);

    // Another upstream release lands later while Kiln stays running; Refresh picks it up immediately.
    releaseNum = 2;
    const secondRefresh = (await (
      await realFetch(`${server.url}/models/refresh`, { method: "POST", headers: authHeaders, body: "{}" })
    ).json()) as { models: Array<{ id: string; provider: string }> };
    expect(secondRefresh.models.some((m) => m.id === "gpt-6.2-live")).toBe(true);

    // Malformed provider list returns a clean 400 JSON error.
    const bad = await realFetch(`${server.url}/models/refresh`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ providers: [123] }),
    });
    expect(bad.status).toBe(400);
  });

  test("POST /alignment/import makes zero outbound calls, registers conditional providers, and scoped POST /models/refresh populates shared API-key catalogs without rotating OAuth", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      calledUrls.push(url);
      if (url.includes("api.deepinfra.com")) {
        return Response.json({
          data: [
            {
              id: "Qwen/Qwen3-Coder-480B",
              object: "model",
              metadata: {
                tags: ["chat"],
                context_length: 262_144,
                max_tokens: 32_768,
                pricing: { input_tokens: 0.4, output_tokens: 1.6 },
              },
            },
          ],
        });
      }
      if (url.includes("api.moonshot.ai")) {
        return Response.json({
          data: [{ id: "kimi-k3.5-live", context_length: 262_144 }],
        });
      }
      if (url.includes("api.fireworks.ai")) {
        return Response.json({
          data: [{ id: "accounts/fireworks/models/deepseek-v4", supports_tools: true, context_length: 163_840 }],
        });
      }
      if (url.includes("models.dev")) return Response.json({});
      return new Response("unexpected upstream call: " + url, { status: 500 });
    }) as unknown as typeof fetch;

    const home = makeDir();
    const config = hearthConfig({ home, port: 0, workspace: home });
    const credentials = new InMemoryCredentialStore();
    const cache = createModelsDevCache();
    const models = createModels({ credentials });
    models.setProvider(deepinfraProvider());
    models.setProvider(fireworksWithDiscovery(cache));
    models.setProvider(openaiCodexWithDiscovery());
    // Start with empty storedIds so moonshotai is NOT initially registered until alignment import.
    for (const provider of kimiProviders([], {}, cache)) models.setProvider(provider);
    expect(models.getProvider("moonshotai")).toBeUndefined();

    const storage = await openNodeSqliteStorage(join(home, "hearth.sqlite"));
    const harness = await Harness.open(
      storage,
      { models, registry: hearthRegistry(home), env: () => new NodeExecutionEnv({ cwd: home }) },
      BACKGROUND_CONTEXT
    );
    harnesses.push(harness);

    const server = startHearthServer({
      config,
      token: "test-secret",
      storage,
      harness,
      models,
      defaultAgent: { model: { provider: "deepinfra", modelId: "Qwen/Qwen3-Coder-480B" } },
      store: credentials,
    });
    servers.push(server);

    const authHeaders = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

    // Import API keys (including alias fireworks-ai) + an expired experimental Codex OAuth token.
    const importRes = await realFetch(`${server.url}/alignment/import`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        peers: [],
        credentials: [
          { providerId: "deepinfra", credential: { type: "api_key", key: "di-shared-key" } },
          { providerId: "moonshotai", credential: { type: "api_key", key: "ms-shared-key" } },
          { providerId: "fireworks-ai", credential: { type: "api_key", key: "fw-shared-key" } },
          {
            providerId: "openai-codex",
            experimental: true,
            credential: {
              type: "oauth",
              access: "expired-codex-access",
              refresh: "shared-codex-refresh",
              expires: 1,
              accountId: "acct-shared",
            },
          },
        ],
      }),
    });
    expect(importRes.status).toBe(200);
    expect(await importRes.json()).toEqual({ connections: 0, keys: 4 });
    // Alignment import itself makes ZERO outbound network requests.
    expect(calledUrls).toEqual([]);
    // Conditional provider moonshotai was registered in-memory without network I/O.
    expect(models.getProvider("moonshotai")).toBeDefined();

    const afterImport = (await (await realFetch(`${server.url}/models`, { headers: authHeaders })).json()) as {
      models: Array<{ id: string; provider: string }>;
    };
    expect(afterImport.models.some((m) => m.provider === "moonshotai")).toBe(true);
    expect(afterImport.models.some((m) => m.provider === "openai-codex")).toBe(true);
    expect(afterImport.models.some((m) => m.provider === "deepinfra")).toBe(false);
    expect(calledUrls).toEqual([]);

    // Client-triggered scoped POST /models/refresh refreshes shared API-key catalogs (including alias normalization)
    // while leaving the expired openai-codex OAuth token untouched.
    const refreshed = (await (
      await realFetch(`${server.url}/models/refresh`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ providers: ["deepinfra", "moonshotai", "fireworks-ai"] }),
      })
    ).json()) as { models: Array<{ id: string; provider: string }> };

    expect(refreshed.models.some((m) => m.provider === "deepinfra" && m.id === "Qwen/Qwen3-Coder-480B")).toBe(true);
    expect(refreshed.models.some((m) => m.provider === "moonshotai" && m.id === "kimi-k3.5-live")).toBe(true);
    expect(refreshed.models.some((m) => m.provider === "fireworks" && m.id === "accounts/fireworks/models/deepseek-v4")).toBe(true);
    expect(refreshed.models.some((m) => m.provider === "openai-codex")).toBe(true);
    expect(calledUrls.some((u) => u.includes("openai.com") || u.includes("chatgpt.com"))).toBe(false);
  });
});
