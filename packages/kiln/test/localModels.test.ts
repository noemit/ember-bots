import { afterEach, describe, expect, test } from "bun:test";
import { lmStudioProvider, localRuntimeBaseUrl, ollamaProvider, probeLocalRuntime } from "../src/local-models";

/**
 * Local runtimes: Ollama and LM Studio.
 *
 * They are the only provider family with no account, which is why they matter most on a first run —
 * and why every failure here is a first impression. The rules pinned below are the ones that turn a
 * confusing empty list into a sentence someone can act on.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const respond = (body: unknown, status = 200) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
};

const refuse = () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
};

describe('where a local runtime listens', () => {
  test('the documented default when nothing is configured', () => {
    expect(localRuntimeBaseUrl('ollama', {})).toBe('http://127.0.0.1:11434');
    expect(localRuntimeBaseUrl('lmstudio', {})).toBe('http://127.0.0.1:1234');
  });

  test('OLLAMA_HOST may be a bare host:port or a URL, and trailing slashes never double up', () => {
    expect(localRuntimeBaseUrl('ollama', { OLLAMA_HOST: 'localhost:11434' })).toBe('http://localhost:11434');
    expect(localRuntimeBaseUrl('ollama', { OLLAMA_HOST: 'http://10.0.0.5:11434/' })).toBe('http://10.0.0.5:11434');
    expect(localRuntimeBaseUrl('lmstudio', { LMSTUDIO_BASE_URL: 'http://host:4321/' })).toBe('http://host:4321');
  });
});

describe('probing a runtime', () => {
  test('Ollama: a running runtime with models reports them', async () => {
    respond({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5-coder:7b' }] });
    const probe = await probeLocalRuntime('ollama');
    expect(probe.running).toBe(true);
    expect(probe.hasModels).toBe(true);
    expect(probe.models).toEqual(['llama3.2:latest', 'qwen2.5-coder:7b']);
    expect(probe.problem).toBeUndefined();
  });

  test('Ollama: running with nothing pulled is not "not running"', async () => {
    respond({ models: [] });
    const probe = await probeLocalRuntime('ollama');
    expect(probe.running).toBe(true);
    // The distinction the UI needs: install a model, versus start the app.
    expect(probe.hasModels).toBe(false);
  });

  test('LM Studio: the OpenAI shape', async () => {
    respond({ data: [{ id: 'qwen/qwen3-8b' }] });
    const probe = await probeLocalRuntime('lmstudio');
    expect(probe.running).toBe(true);
    expect(probe.models).toEqual(['qwen/qwen3-8b']);
  });

  test('a refused connection says which app is not answering', async () => {
    refuse();
    const probe = await probeLocalRuntime('lmstudio');
    expect(probe.running).toBe(false);
    expect(probe.problem).toContain('LM Studio');
    expect(probe.problem).toContain('is it running?');
  });

  test('something else on the port is named as such, not as "empty"', async () => {
    respond({ hello: 'not a model list' });
    const probe = await probeLocalRuntime('ollama');
    expect(probe.running).toBe(true);
    expect(probe.hasModels).toBe(false);
    expect(probe.problem).toContain('not with an Ollama model list');
  });

  test('a non-2xx answer reports the status rather than pretending it is up', async () => {
    respond({}, 500);
    const probe = await probeLocalRuntime('ollama');
    expect(probe.running).toBe(false);
    expect(probe.problem).toContain('500');
  });
});

describe('the providers need no credential', () => {
  test('auth resolves to a model auth with no key, so requests carry no Authorization', () => {
    for (const provider of [ollamaProvider({ baseUrl: 'http://127.0.0.1:11434' }), lmStudioProvider({ baseUrl: 'http://127.0.0.1:1234' })]) {
      const auth = provider.auth.apiKey;
      expect(auth).toBeDefined();
      expect(typeof auth?.resolve).toBe('function');
    }
  });

  test('auth is declared the way pi-ai requires, and resolves without a key', async () => {
    const provider = ollamaProvider({ baseUrl: 'http://127.0.0.1:11434' });
    const resolved = await provider.auth.apiKey?.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: AbortSignal.timeout(1000),
    });
    expect(resolved).toBeDefined();
    expect(resolved?.auth.apiKey).toBeUndefined();
    // The source is what stops the picker hiding a provider with no stored credential.
    expect(resolved?.source).toBe('local');
  });
});

/**
 * NVIDIA's NIM catalogue.
 *
 * It is a keyed provider like any other — but the models it offers change without notice (a free
 * model appears for a while and is retired), so the thing worth pinning is not the list: it is that
 * the provider is *registered* and reads the credential from the variable NVIDIA actually documents.
 * Registering it always is what lets a key added later light up without a restart, and what keeps
 * the picker honest when the catalogue rotates.
 */
describe('NVIDIA is registered and keyed', () => {
  test('the env var is the documented one, so a key in the environment is found', async () => {
    const { PROVIDER_ENV_VARS, hasEnvCredential } = await import("../src/credentials");
    expect(PROVIDER_ENV_VARS.nvidia).toEqual(["NVIDIA_API_KEY"]);
    expect(hasEnvCredential("nvidia", { NVIDIA_API_KEY: "nvapi-x" })).toBe(true);
    expect(hasEnvCredential("nvidia", { NVIDIA_API_KEY: "   " })).toBe(false);
    expect(hasEnvCredential("nvidia", { OPENAI_API_KEY: "nope" })).toBe(false);
  });

  test('pi-ai ships the provider, so Hearth serves its catalogue rather than inventing one', async () => {
    const { nvidiaProvider } = await import("@earendil-works/pi-ai/providers/nvidia");
    const provider = nvidiaProvider();
    expect(provider.id).toBe("nvidia");
    expect(provider.auth.apiKey).toBeDefined();
    // The endpoint the provider is pinned to; a change here is a change of service, not a typo.
    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });
});
