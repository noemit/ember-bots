import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEEPINFRA_BASE_URL,
  deepinfraCost,
  deepinfraInputs,
  deepinfraIsChat,
  deepinfraLimit,
  deepinfraModel,
  deepinfraModels,
  deepinfraName,
} from "../src/deepinfra";
import { FileCredentialStore, PROVIDER_ENV_VARS, hasEnvCredential } from "../src/credentials";
import { deepinfraProvider, hearthModels } from "../src/models";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.DEEPINFRA_API_KEY;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const storeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-deepinfra-"));
  dirs.push(dir);
  return join(dir, "auth.json");
};

/** The live `/models` shape, trimmed to the fields Hearth reads (verified against the endpoint). */
const CHAT = {
  id: "anthropic/claude-opus-4-7",
  object: "model",
  owned_by: "deepinfra",
  metadata: {
    context_length: 1_000_000,
    max_tokens: 1_000_000,
    // Dollars per million tokens, as the endpoint reports them.
    pricing: { input_tokens: 5, output_tokens: 25 },
    tags: ["chat", "reasoning", "reasoning_effort", "vision"],
  },
};
const EMBED = {
  id: "BAAI/bge-m3-multi-8k",
  metadata: { context_length: 8192, pricing: { input_tokens: 0.01 }, tags: ["embed"] },
};

describe("the catalog entry -> model mapping", () => {
  test("only chat models are Hearth models", () => {
    expect(deepinfraIsChat(CHAT)).toBe(true);
    for (const tags of [["embed"], ["image-gen"], ["tts"], ["stt"], ["video-gen"], ["rerank"], []]) {
      expect(deepinfraIsChat({ id: "x", metadata: { tags } })).toBe(false);
    }
    expect(deepinfraIsChat({ id: "x" })).toBe(false);
    expect(deepinfraModels([CHAT, EMBED]).map((model) => model.id)).toEqual([CHAT.id]);
  });

  test("limits, prices and modalities come from what the endpoint reported", () => {
    const mapped = deepinfraModel(CHAT)!;
    expect(mapped.guessed).toEqual([]);
    expect(mapped.model).toMatchObject({
      provider: "deepinfra",
      id: "anthropic/claude-opus-4-7",
      name: "claude-opus-4-7",
      api: "openai-completions",
      baseUrl: DEEPINFRA_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 1_000_000,
    });
    // Per-million-token prices pass through unconverted; an unpublished cache price is 0, not a guess.
    expect(mapped.model.cost).toEqual({ input: 5, output: 25, cacheRead: 0, cacheWrite: 0 });
    expect(mapped.model.inputLimits).toBeDefined();
  });

  test("an unpriced or uncached model reports no price rather than an invented one", () => {
    expect(deepinfraCost({ id: "x", metadata: { tags: ["chat"] } })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(deepinfraCost({ id: "x", metadata: { tags: ["chat"], pricing: null } })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(deepinfraCost({ id: "x", metadata: { tags: ["chat"], pricing: { input_tokens: 0.06, cache_read_tokens: 0.015 } } })).toEqual({
      input: 0.06,
      output: 0,
      cacheRead: 0.015,
      cacheWrite: 0,
    });
    // Junk, negative and infinite prices are not prices.
    expect(deepinfraCost({ id: "x", metadata: { pricing: { input_tokens: -1, output_tokens: Number.POSITIVE_INFINITY } } }).input).toBe(0);
  });

  test("pricing survives the granularity the endpoint uses (fractions of a cent)", () => {
    const cheap = deepinfraModel({
      id: "ibm-granite/granite-4.2-8b",
      metadata: { tags: ["chat"], pricing: { input_tokens: 0.06, output_tokens: 0.25 } },
    })!;
    expect(cheap.model.cost.input).toBe(0.06);
    expect(cheap.model.cost.output).toBe(0.25);
  });

  test("reasoning effort is only offered where the model is tagged for it", () => {
    const effort = deepinfraModel(CHAT)!.model;
    expect(effort.thinkingLevelMap).toMatchObject({ low: "low", high: "high", off: null });
    expect(effort.compat).toMatchObject({ supportsReasoningEffort: true });
    const plainReasoner = deepinfraModel({ id: "p/m", metadata: { tags: ["chat", "reasoning"] } })!.model;
    expect(plainReasoner.reasoning).toBe(true);
    expect(plainReasoner.thinkingLevelMap).toBeUndefined();
    expect(plainReasoner.compat).toBeUndefined();
    const plain = deepinfraModel({ id: "p/m", metadata: { tags: ["chat"] } })!.model;
    expect(plain.reasoning).toBe(false);
    expect(plain.thinkingLevelMap).toBeUndefined();
  });

  test("a model that reports no limit is named as a guess instead of presenting a default as fact", () => {
    const mapped = deepinfraModel({ id: "p/m", metadata: { tags: ["chat"] } })!;
    expect(mapped.guessed).toEqual(["contextWindow", "maxTokens"]);
    expect([mapped.model.contextWindow, mapped.model.maxTokens]).toEqual([32_768, 8_192]);
    expect(deepinfraLimit(0)).toBeUndefined();
    expect(deepinfraLimit(-5)).toBeUndefined();
    expect(deepinfraLimit(1.5)).toBeUndefined();
    expect(deepinfraLimit("8192")).toBe(8192);
    expect(deepinfraLimit("junk")).toBeUndefined();
  });

  test("ids keep their publisher route; the display name drops it", () => {
    expect(deepinfraName(CHAT)).toBe("claude-opus-4-7");
    expect(deepinfraName({ id: "bare-model" })).toBe("bare-model");
    expect(deepinfraName({ id: "a/" })).toBe("a/");
    expect(deepinfraInputs(CHAT)).toEqual(["text", "image"]);
    expect(deepinfraInputs({ id: "x", metadata: { tags: ["chat"] } })).toEqual(["text"]);
  });
});

describe("registration and credentials", () => {
  test("DeepInfra is registered always, with a name, so its key field exists before a key does", async () => {
    const { models } = await hearthModels(storeFile());
    const provider = models.getProviders().find((entry) => entry.id === "deepinfra");
    expect(provider?.name).toBe("DeepInfra");
    expect(provider?.baseUrl).toBe(DEEPINFRA_BASE_URL);
    expect(provider?.auth.apiKey).toBeDefined();
    // A fresh install lists it with no credential, exactly like the other keyed providers.
    expect(await models.getAuth("deepinfra")).toBeUndefined();
  });

  test("DEEPINFRA_API_KEY resolves through the env fallback, and a stored key wins", async () => {
    process.env.DEEPINFRA_API_KEY = "env-key";
    expect(PROVIDER_ENV_VARS.deepinfra).toEqual(["DEEPINFRA_API_KEY"]);
    expect(hasEnvCredential("deepinfra")).toBe(true);

    const file = storeFile();
    const first = await hearthModels(file);
    expect((await first.models.getAuth("deepinfra"))?.auth.apiKey).toBe("env-key");

    const store = new FileCredentialStore(file);
    await store.modify("deepinfra", async () => ({ type: "api_key", key: "stored-key" }));
    const second = await hearthModels(file);
    expect((await second.models.getAuth("deepinfra"))?.auth.apiKey).toBe("stored-key");
  });

  test("OpenRouter is still registered with its own name and key, next to DeepInfra", async () => {
    const { models } = await hearthModels(storeFile());
    const ids = models.getProviders().map((provider) => provider.id);
    expect(ids).toContain("openrouter");
    expect(ids.indexOf("deepinfra")).toBe(ids.indexOf("openrouter") + 1);
    const openrouter = models.getProviders().find((provider) => provider.id === "openrouter")!;
    expect(openrouter.name).toBe("OpenRouter");
    // pi-ai's shipped catalogue is the offline list: a keyed OpenRouter account works without a
    // network read at boot, which is what made "key saved but no models" impossible to diagnose.
    expect(openrouter.getModels().length).toBeGreaterThan(0);
    expect(PROVIDER_ENV_VARS.openrouter).toEqual(["OPENROUTER_API_KEY"]);
  });
});

describe("the provider's catalog fetch", () => {
  const serve = (data: unknown, status = 200) => {
    const urls: string[] = [];
    const headers: unknown[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      headers.push(init?.headers);
      return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { urls, headers };
  };

  const context = (signal: AbortSignal) => ({
    credential: { type: "api_key" as const, key: "sk-test" },
    publish: async () => true,
    allowNetwork: true,
    signal,
  });

  test("reads /models with the resolved key and serves the chat models it lists", async () => {
    const { urls, headers } = serve({ object: "list", data: [CHAT, EMBED] });
    const provider = deepinfraProvider();
    const published: { id: string }[][] = [];
    await provider.refreshModels?.({
      ...context(new AbortController().signal),
      publish: async (publication) => {
        if (publication.persist) published.push(publication.persist.models as unknown as { id: string }[]);
        publication.update?.();
        return true;
      },
    });
    expect(urls).toEqual([`${DEEPINFRA_BASE_URL}/models`]);
    expect(headers).toEqual([{ Authorization: "Bearer sk-test" }]);
    // What is published is what the picker and the persisted store receive.
    expect(published).toHaveLength(1);
    expect(published[0]?.map((model) => model.id)).toEqual([CHAT.id]);
    const [model] = published[0]! as unknown as { cost: unknown; contextWindow: number }[];
    expect(model?.cost).toEqual({ input: 5, output: 25, cacheRead: 0, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(1_000_000);
  });

  test("a rejected key or a broken response fails the refresh and publishes nothing", async () => {
    for (const [status, body] of [[401, { error: "invalid api key" }], [500, "nope"]] as const) {
      serve(body, status);
      await expect(deepinfraProvider().refreshModels?.(context(new AbortController().signal))).rejects.toThrow(
        `deepinfra /models failed: ${status}`
      );
    }
    // A transport error (offline, DNS) is the same story: it never escapes as a boot failure.
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.deepinfra.com");
    }) as unknown as typeof fetch;
    await expect(deepinfraProvider().refreshModels?.(context(new AbortController().signal))).rejects.toThrow("ENOTFOUND");
  });

  test("an empty or non-chat catalogue lists no chat models and does not throw", async () => {
    const refresh = async (data: unknown) => {
      serve(data);
      const provider = deepinfraProvider();
      const published: { id: string }[][] = [];
      await provider.refreshModels?.({
        ...context(new AbortController().signal),
        publish: async (publication) => {
          if (publication.persist) published.push(publication.persist.models as unknown as { id: string }[]);
          return true;
        },
      });
      return published;
    };
    expect(await refresh({ data: [EMBED] })).toEqual([[]]);
    expect(await refresh({ object: "list" })).toEqual([[]]);
    expect(await refresh(["not", "a", "body"])).toEqual([[]]);
  });

  test("no network read until a refresh, so boot is offline-safe", async () => {
    const { urls } = serve({ data: [CHAT] });
    const provider = deepinfraProvider();
    expect(provider.getModels()).toEqual([]);
    expect(urls).toEqual([]);
    // An abort before the network is allowed (pi-ai's offline phase) reads nothing either.
    const aborted = new AbortController();
    aborted.abort();
    await provider.refreshModels?.({ ...context(aborted.signal), allowNetwork: false, publish: async () => true });
    expect(urls).toEqual([]);
  });
});
