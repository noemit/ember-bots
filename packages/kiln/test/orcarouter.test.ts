import { afterEach, describe, expect, test } from "bun:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  IMAGE_INPUT_LIMITS,
  KIMI_COMPAT,
  KIMI_THINKING_LEVELS,
  VERIFIED_LIMITS,
  alwaysReasons,
  orcarouterModel,
  orcarouterOptions,
  routerInputs,
  routerLimit,
  routerLimits,
  routerReasoning,
  routerReasoningMode,
} from "../src/orcarouter";
import { orcarouterProvider } from "../src/models";

const MOONSHOT = "https://api.moonshot.ai/v1";

const base = orcarouterOptions({});

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env.ORCAROUTER_BASE_URL;
  delete process.env.ORCAROUTER_API_KEY;
  delete process.env.ORCAROUTER_REASONING;
  delete process.env.ORCAROUTER_INPUT;
  delete process.env.ORCAROUTER_CONTEXT_WINDOW;
  delete process.env.ORCAROUTER_MAX_TOKENS;
  globalThis.fetch = originalFetch;
});

describe("env parsing", () => {
  test("no env at all asks for auto reasoning, text input and no fallbacks", () => {
    expect(base).toEqual({ reasoning: "auto", input: ["text"], contextWindow: undefined, maxTokens: undefined });
  });

  test("ORCAROUTER_REASONING takes on/off spellings and defaults to auto", () => {
    for (const on of ["1", "true", "TRUE", " yes ", "on"]) expect(routerReasoningMode(on)).toBe("on");
    for (const off of ["0", "false", "no", "off", "OFF"]) expect(routerReasoningMode(off)).toBe("off");
    for (const auto of [undefined, "", "auto", "maybe"]) expect(routerReasoningMode(auto)).toBe("auto");
  });

  test("ORCAROUTER_INPUT always includes text and only adds image when asked", () => {
    expect(routerInputs(undefined)).toEqual(["text"]);
    expect(routerInputs("")).toEqual(["text"]);
    expect(routerInputs("text")).toEqual(["text"]);
    expect(routerInputs("text,image")).toEqual(["text", "image"]);
    expect(routerInputs("image")).toEqual(["text", "image"]);
    expect(routerInputs("text,image,audio,video")).toEqual(["text", "image"]);
  });

  test("ORCAROUTER_CONTEXT_WINDOW/ORCAROUTER_MAX_TOKENS take positive whole numbers only", () => {
    expect(routerLimit("1000000")).toBe(1_000_000);
    expect(routerLimit(" 262144 ")).toBe(262_144);
    expect(routerLimit(1_048_576)).toBe(1_048_576);
    for (const junk of [undefined, "", "0", "-1", "12.5", "1e6", "lots", 0, -5, 1.5, null]) {
      expect(routerLimit(junk)).toBeUndefined();
    }
  });

  test("a configured fallback survives into the options", () => {
    expect(
      orcarouterOptions({
        ORCAROUTER_REASONING: "0",
        ORCAROUTER_INPUT: "text,image",
        ORCAROUTER_CONTEXT_WINDOW: "262144",
        ORCAROUTER_MAX_TOKENS: "131072",
      })
    ).toEqual({ reasoning: "off", input: ["text", "image"], contextWindow: 262_144, maxTokens: 131_072 });
  });
});

describe("reasoning", () => {
  test("Kimi K3 and K3.1 always reason, and the model record says so", () => {
    for (const id of ["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) expect(alwaysReasons(id)).toBe(true);
    for (const id of ["kimi-k2.6", "kimi-k2.7-code", "gpt-5", "deepseek-chat"]) expect(alwaysReasons(id)).toBe(false);
    expect(routerReasoning("kimi-k3.1-pro", base)).toBe(true);
    expect(routerReasoning("kimi-k2.6", base)).toBe(false);
  });

  test("ORCAROUTER_REASONING on and off override what the model does anyway", () => {
    expect(routerReasoning("kimi-k3.1-pro", { ...base, reasoning: "off" })).toBe(false);
    expect(routerReasoning("kimi-k2.6", { ...base, reasoning: "on" })).toBe(true);
    expect(orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, { ...base, reasoning: "off" }).reasoning).toBe(false);
  });

  test("a Kimi K3.1 model reasons with no env at all, and carries the effort field, level map and echo", () => {
    const model = orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, base);
    expect(model.reasoning).toBe(true);
    expect(model.compat).toEqual(KIMI_COMPAT);
    expect(model.compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: "openai" });
    expect(model.thinkingLevelMap).toEqual(KIMI_THINKING_LEVELS);
    // K3.1 always thinks, so "off" cannot be requested and only low/high/max reach the wire.
    expect(model.thinkingLevelMap).toMatchObject({ off: null, low: "low", high: "high", max: "max" });
    expect(model.thinkingLevelMap?.medium).toBeNull();
  });

  test("the shape follows the model id, not the endpoint, so a gateway keeps it", () => {
    expect(orcarouterModel({ id: "kimi-k3.1-pro" }, "https://gateway.example.com/v1", base).compat).toEqual(KIMI_COMPAT);
    expect(orcarouterModel({ id: "kimi-k2.6" }, MOONSHOT, base).reasoning).toBe(false);
  });

  test("a non-reasoning model with the old env names alone is described exactly as 0.22.0 did", () => {
    const model = orcarouterModel({ id: "some-model" }, "https://gw.example.com/v1", base);
    expect(model).toEqual({
      provider: "orcarouter",
      id: "some-model",
      name: "some-model",
      api: "openai-completions",
      baseUrl: "https://gw.example.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    expect(model.compat).toBeUndefined();
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(model.inputLimits).toBeUndefined();
  });

  test("reasoning on for a non-Kimi model sends the plain OpenAI effort field and standard thinking levels", () => {
    const model = orcarouterModel({ id: "some-reasoner" }, "https://gateway.example.com/v1", {
      ...base,
      reasoning: "on",
    });
    expect(model.reasoning).toBe(true);
    expect(model.compat).toEqual({ supportsReasoningEffort: true, thinkingFormat: "openai" });
    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: "high",
    });
  });
});

describe("limits", () => {
  test("Kimi K3's verified 1,048,576-token window does not fall back to 128k", () => {
    for (const id of ["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
      expect(orcarouterModel({ id }, MOONSHOT, base).contextWindow).toBe(1_048_576);
    }
    expect(VERIFIED_LIMITS).toEqual([{ match: /^kimi-k3/i, contextWindow: 1_048_576 }]);
  });

  test("the catalog wins, then the operator, then the verified window, then the default", () => {
    const reported = orcarouterModel({ id: "kimi-k3.1-pro", context_window: 262_144, max_tokens: 65_536 }, MOONSHOT, {
      ...base,
      contextWindow: 4_096,
      maxTokens: 4_096,
    });
    expect([reported.contextWindow, reported.maxTokens]).toEqual([262_144, 65_536]);

    // An operator's number is a deliberate choice, and the verified table is only a fallback.
    const configured = orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, { ...base, contextWindow: 262_144 });
    expect(configured.contextWindow).toBe(262_144);

    expect(orcarouterModel({ id: "small" }, MOONSHOT, base).contextWindow).toBe(128_000);
    expect(orcarouterModel({ id: "small" }, MOONSHOT, { ...base, contextWindow: 32_768 }).contextWindow).toBe(32_768);
  });

  test("image input on and off", () => {
    const withImages = orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, { ...base, input: ["text", "image"] });
    expect(withImages.input).toEqual(["text", "image"]);
    expect(withImages.inputLimits).toEqual(IMAGE_INPUT_LIMITS);
    expect(orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, base).input).toEqual(["text"]);
    expect(orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, base).inputLimits).toBeUndefined();
  });

  test("a reasoning model is not silently capped at the 8k that suits a non-reasoning one", () => {
    expect(orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, base).maxTokens).toBe(32_768);
    expect(orcarouterModel({ id: "small" }, MOONSHOT, base).maxTokens).toBe(8_192);
    // An explicit cap still wins, and the catalog still wins over both.
    expect(orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, { ...base, maxTokens: 65_536 }).maxTokens).toBe(65_536);
    expect(orcarouterModel({ id: "kimi-k3.1-pro", max_tokens: 8_192 }, MOONSHOT, { ...base, maxTokens: 65_536 }).maxTokens).toBe(
      8_192
    );
  });

  test("limits report what fell through to a default, not what was configured or verified", () => {
    expect(routerLimits({ id: "m" }, base).guessed).toEqual(["contextWindow", "maxTokens"]);
    expect(routerLimits({ id: "m", context_window: 1, max_tokens: 2 }, base).guessed).toEqual([]);
    expect(routerLimits({ id: "m", context_window: 1 }, base).guessed).toEqual(["maxTokens"]);
    expect(routerLimits({ id: "m" }, { ...base, contextWindow: 4_096 }).guessed).toEqual(["maxTokens"]);
    expect(routerLimits({ id: "kimi-k3.1-pro", max_tokens: 1 }, base).guessed).toEqual([]);
  });

  test("cost stays at zero whatever is configured", () => {
    for (const options of [base, { ...base, reasoning: "on" as const, input: ["text", "image"] as const }]) {
      expect(orcarouterModel({ id: "m" }, MOONSHOT, { ...options, input: [...options.input] }).cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });
});

describe("the provider's catalog fetch", () => {
  const serve = (data: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return urls;
  };

  const refresh = async (
    provider: NonNullable<ReturnType<typeof orcarouterProvider>>,
    credential?: { type: "api_key"; key: string }
  ) => {
    await provider.refreshModels?.({
      credential,
      publish: async (publication) => {
        publication.update?.();
        return true;
      },
      allowNetwork: true,
      signal: new AbortController().signal,
    });
    return provider.getModels();
  };

  test("the old env names alone serve the endpoint's catalog, Kimi reasoning included", async () => {
    const urls = serve({
      data: [
        { id: "kimi-k3.1-pro", object: "model" },
        { id: "kimi-k3.1-pro-highspeed", object: "model" },
        { id: "small", context_window: 32_768, max_tokens: 4_096 },
      ],
    });
    process.env.ORCAROUTER_BASE_URL = `${MOONSHOT}/`;
    process.env.ORCAROUTER_API_KEY = "sk-test";

    const provider = orcarouterProvider(process.env);
    expect(urls).toEqual([]); // nothing fetched until refresh
    const models = await refresh(provider!);
    expect(urls).toEqual([`${MOONSHOT}/models`]);

    expect(models.map((model) => model.id)).toEqual(["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "small"]);
    for (const model of models.slice(0, 2)) {
      expect(model).toMatchObject({
        provider: "orcarouter",
        baseUrl: `${MOONSHOT}/`,
        reasoning: true,
        input: ["text"],
        contextWindow: 1_048_576,
        maxTokens: 32_768,
        compat: KIMI_COMPAT,
      });
    }
    // A model that does not always reason keeps 0.22.0's shape, and the catalog's limits win.
    expect(models[2]).toMatchObject({ reasoning: false, contextWindow: 32_768, maxTokens: 4_096 });
    expect(models[2]!.compat).toBeUndefined();
  });

  test("the resolved API key authenticates the catalog read", async () => {
    let headers: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers;
      return new Response(JSON.stringify({ data: [{ id: "kimi-k3.1-pro" }] }));
    }) as unknown as typeof fetch;
    process.env.ORCAROUTER_BASE_URL = MOONSHOT;
    process.env.ORCAROUTER_API_KEY = "sk-router-test";

    await refresh(orcarouterProvider(process.env)!, { type: "api_key", key: "sk-router-test" });
    expect(headers).toEqual({ Authorization: "Bearer sk-router-test" });
  });

  test("the env vars reach the fetched models", async () => {
    serve({ data: [{ id: "kimi-k3.1-pro" }] });
    process.env.ORCAROUTER_BASE_URL = MOONSHOT;
    process.env.ORCAROUTER_API_KEY = "sk-test";
    process.env.ORCAROUTER_REASONING = "0";
    process.env.ORCAROUTER_INPUT = "text,image";
    process.env.ORCAROUTER_CONTEXT_WINDOW = "262144";
    process.env.ORCAROUTER_MAX_TOKENS = "131072";

    const [model] = await refresh(orcarouterProvider(process.env)!);
    expect(model).toMatchObject({
      id: "kimi-k3.1-pro",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 131_072,
      inputLimits: IMAGE_INPUT_LIMITS,
    });
    expect(model!.compat).toBeUndefined();
  });

  test("no endpoint configured means no provider", () => {
    expect(orcarouterProvider({ ORCAROUTER_API_KEY: "sk-test" })).toBeUndefined();
    expect(orcarouterProvider({ ORCAROUTER_BASE_URL: MOONSHOT })).toBeUndefined();
  });
});

describe("the request the provider actually sends", () => {
  const sse = [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}',
    "",
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  /** One streamed turn against a stub transport; returns the JSON body pi-ai would post. */
  const bodyFor = async (
    options: Parameters<typeof orcarouterModel>[2],
    level?: string
  ): Promise<Record<string, unknown>> => {
    const bodies: Record<string, unknown>[] = [];
    const stub = (async (_url: unknown, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? "{}"));
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const stream = openAICompletionsApi().streamSimple(
      orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, options),
      normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
      { apiKey: "sk-test", fetch: stub, ...(level === undefined ? {} : { reasoning: level as never }) }
    );
    for await (const event of stream) void event;
    return bodies[0]!;
  };

  test("Kimi's reasoning_effort goes on the wire, and never the retracted thinking object", async () => {
    const body = await bodyFor(base, "high");
    expect(body).toMatchObject({ reasoning_effort: "high", max_tokens: 32_768 });
    expect(body.thinking).toBeUndefined();
  });

  test("a level the model does not name is clamped onto one it does", async () => {
    expect((await bodyFor(base, "medium")).reasoning_effort).toBe("high");
    expect((await bodyFor(base, "minimal")).reasoning_effort).toBe("low");
    expect((await bodyFor(base, "max")).reasoning_effort).toBe("max");
  });

  test("no level sends no field, so the provider's own default applies", async () => {
    expect((await bodyFor(base)).reasoning_effort).toBeUndefined();
  });

  test("reasoning off sends no reasoning field at all, as 0.22.0 did", async () => {
    const body = await bodyFor({ ...base, reasoning: "off" }, "high");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body).toMatchObject({ max_tokens: 8_192 });
  });

  test("the streamed reasoning_content becomes a thinking block", async () => {
    const stub = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const stream = openAICompletionsApi().streamSimple(
      orcarouterModel({ id: "kimi-k3.1-pro" }, MOONSHOT, base),
      normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
      { apiKey: "sk-test", fetch: stub }
    );
    let message: unknown;
    for await (const event of stream) if (event.type === "done") message = event.message;
    expect(message).toMatchObject({
      content: [
        { type: "thinking", thinking: "thinking" },
        { type: "text", text: "ok" },
      ],
    });
  });
});
