import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import { FileCredentialStore } from "../src/credentials";
import { deepinfraProvider, hearthModels } from "../src/models";

/**
 * A key saved for either of these must show up as models in the picker. pi-ai owns both refreshes:
 * OpenRouter's shipped catalog is filtered by `GET /models/user`, DeepInfra's is read from
 * `GET /models`. These pin the part Hearth controls — that the provider resolves the key, reads
 * the account's list with it, and publishes into the store the picker is served from.
 */

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
const storeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-provider-keys-"));
  dirs.push(dir);
  return join(dir, "auth.json");
};
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a saved key reaches the picker", () => {
  test("OpenRouter filters its shipped catalog with the account's own list", async () => {
    // Boot probes local runtimes on loopback; only the provider's own request is interesting.
    const requests: { url: string; authorization?: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      if (String(input).includes("openrouter")) requests.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
      return new Response(
        JSON.stringify({
          data: [
            { id: "anthropic/claude-sonnet-5.5", context_length: 1_000_000, pricing: { prompt: "0.000002", completion: "0.00001" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const { models } = await hearthModels(storeFile());
    const openrouter = models.getProviders().find((provider) => provider.id === "openrouter")!;
    const personalized = await personalizeOpenRouterCatalog(openrouter.getModels(), {
      credential: { type: "api_key", key: "sk-or-test" },
      publish: async () => true,
      allowNetwork: true,
      signal: new AbortController().signal,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/models/user");
    expect(requests[0]?.authorization).toBe("Bearer sk-or-test");
    expect(personalized.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-5.5"]);
    // The personalized entry keeps a usable model shape, which is what the composer sends.
    expect(personalized[0]).toMatchObject({ provider: "openrouter", api: "anthropic-messages", contextWindow: 1_000_000 });
  });

  test("DeepInfra publishes its models through the same store OpenRouter's fallback lives in", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "Qwen/Qwen3-32B",
              metadata: { context_length: 40_960, max_tokens: 40_960, pricing: { input_tokens: 0.08, output_tokens: 0.28 }, tags: ["chat"] },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const models = createModels();
    models.setProvider(deepinfraProvider());
    expect((await models.getAuth("deepinfra"))?.auth).toBeUndefined();

    const store = new FileCredentialStore(storeFile());
    await store.modify("deepinfra", async () => ({ type: "api_key", key: "sk-deepinfra" }));
    const withKey = createModels({ credentials: store });
    withKey.setProvider(deepinfraProvider());
    expect((await withKey.getAuth("deepinfra"))?.auth.apiKey).toBe("sk-deepinfra");

    // pi-ai runs the provider refresh itself; the published models are the ones it then serves.
    let persisted: readonly { id: string; provider: string }[] | undefined;
    await withKey.getProviders()[0]!.refreshModels?.({
      credential: { type: "api_key", key: "sk-deepinfra" },
      publish: async (publication) => {
        persisted = publication.persist?.models as unknown as { id: string; provider: string }[] | undefined;
        publication.update?.();
        return true;
      },
      allowNetwork: true,
      signal: new AbortController().signal,
    });
    expect(persisted?.map((model) => model.id)).toEqual(["Qwen/Qwen3-32B"]);
    expect(persisted?.[0]?.provider).toBe("deepinfra");
  });
});
