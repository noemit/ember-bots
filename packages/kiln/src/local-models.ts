import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { customBaseUrl } from "./custom-providers";

/**
 * Models running on the machine the harness is on: **Ollama** and **LM Studio**.
 *
 * Both speak the OpenAI chat-completions wire on loopback and, crucially, both need **no
 * credential**. That makes them the one provider family that can be offered to someone who has
 * signed up for nothing — which is why they belong in first-run more than anywhere else.
 *
 * pi-ai ships neither: its provider list is the cloud services, and a local runtime is not one. So
 * this builds them the same way the dynamic `orcarouter` slot is built — `createProvider` with a
 * fetched catalogue — with two differences that matter:
 *
 * - **Keyless auth.** `auth` is required on every provider, but a local runtime has nothing to
 *   resolve. The SDK client accepts a placeholder key, with its Authorization header explicitly
 *   removed. No credential is requested or transmitted.
 * - **A model list read from the runtime.** Ollama's `/api/tags` and LM Studio's `/v1/models` are
 *   both cheap and local, so the catalogue is fetched on demand rather than guessed. What each
 *   model can do (context window, tools) is reported where the runtime knows it and defaulted
 *   conservatively where it does not.
 *
 * Neither provider is registered unless something is actually listening: probing is part of boot
 * (see `probeLocalRuntimes`), so an install with neither running sees no dead provider rows in the
 * picker. That probe is also what lets the UI say "Ollama is running but has no models yet" instead
 * of showing an empty list with no explanation.
 */

/** Where each runtime listens by default, overridable for a container or a non-standard port. */
export const LOCAL_RUNTIME_DEFAULTS = {
  ollama: { baseUrl: "http://127.0.0.1:11434", env: "OLLAMA_HOST" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234", env: "LMSTUDIO_BASE_URL" },
} as const;

export type LocalRuntimeId = keyof typeof LOCAL_RUNTIME_DEFAULTS;

export type LocalRuntimeProbe = {
  id: LocalRuntimeId;
  name: string;
  baseUrl: string;
  /** Something answered. */
  running: boolean;
  /** At least one model is installed, so the provider is worth registering. */
  hasModels: boolean;
  /** Installed model ids, for the "N models" line and for a probe we already did. */
  models: string[];
  /**
   * Why the last probe could not be used, in words a person can act on. Absent when `running`.
   * Distinguishes "nothing is listening" (start the app) from "it answered oddly" (upgrade or
   * check whether something else took the port).
   */
  problem?: string;
};

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

/** The base URL for a runtime: env override, else the documented default. */
export const localRuntimeBaseUrl = (
  id: LocalRuntimeId,
  env: Record<string, string | undefined> = process.env
): string => {
  const { baseUrl, env: envName } = LOCAL_RUNTIME_DEFAULTS[id];
  const configured = env[envName]?.trim();
  if (!configured) return baseUrl;
  // `OLLAMA_HOST` is a host:port (no scheme) as often as it is a URL; accept both.
  return trimSlash(/^https?:\/\//i.test(configured) ? configured : `http://${configured}`);
};

type OllamaTag = { name?: string; model?: string; details?: { parameter_size?: string } };
type OpenAiModel = { id?: string };

/**
 * Probe one runtime. Never throws: a runtime that is not running is the normal state, not an error,
 * and the caller needs to tell "down" from "up but empty".
 */
export const probeLocalRuntime = async (
  id: LocalRuntimeId,
  options: { baseUrl?: string; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<LocalRuntimeProbe> => {
  const name = id === 'ollama' ? 'Ollama' : 'LM Studio';
  let baseUrl: string;
  try { baseUrl = customBaseUrl(options.baseUrl ?? localRuntimeBaseUrl(id)); }
  catch {
    return { id, name, baseUrl: LOCAL_RUNTIME_DEFAULTS[id].baseUrl, running: false, hasModels: false, models: [],
      problem: name + ' has an unusable address on this Kiln. Correct its address, then refresh models.' };
  }
  const budget = options.timeoutMs ?? 1_500;
  const signal = options.signal ?? AbortSignal.timeout(budget);
  /**
   * `running` answers "did something occupy this port", not "did it answer correctly".
   *
   * That distinction is the whole point of the probe: a port answering with the wrong shape is
   * almost always the app running a version we cannot read, and the fix is "upgrade it" — whereas
   * nothing answering means "start it". Collapsing both into `running: false` would have offered
   * "is it running?" to someone who is looking at a running app.
   */
  const result = (running: boolean, models: string[], problem?: string): LocalRuntimeProbe => ({
    id,
    name,
    baseUrl,
    running,
    hasModels: models.length > 0,
    models,
    ...(problem ? { problem } : {}),
  });

  try {
    if (id === 'ollama') {
      const response = await fetch(baseUrl + '/api/tags', { signal, redirect: 'error' });
      if (!response.ok) return result(true, [], response.status === 401 || response.status === 403
        ? 'Ollama refused access. Use a keyless Ollama address, or add an authenticated server as a custom provider.'
        : 'The service refused the Ollama model list. Check that this is an Ollama address, then Test / Refresh again.');
      // Do not let a wrong service return an unbounded catalogue or reflect its diagnostics.
      let body: { models?: OllamaTag[] } | null = null;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let bytes = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 1_000_000) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch { /* The recovery below names an unreadable service, never its raw response. */ }
      if (!body || !Array.isArray(body.models)) {
        // It answered: something is there, we just cannot read it.
        return result(true, [], 'The service answered, but not with an Ollama model list. Check the address and Test / Refresh again.');
      }
      if (body.models.length > 500 || body.models.some(entry => !entry || typeof entry !== 'object' ||
          typeof (entry.name ?? entry.model) !== 'string' || !(entry.name ?? entry.model)?.trim() ||
          (entry.name ?? entry.model)!.length > 256)) {
        return result(true, [], "Ollama returned an unreadable model list. Check the address or update Ollama, then Test / Refresh again.");
      }
      const models = [...new Set(body.models.map(entry => (entry.name ?? entry.model)!.trim()))];
      return result(true, models);
    }
    const response = await fetch(`${baseUrl}/v1/models`, { signal });
    if (!response.ok) return result(false, [], `${baseUrl}/v1/models answered ${response.status}.`);
    const body = (await response.json().catch(() => null)) as { data?: OpenAiModel[] } | null;
    if (!body || !Array.isArray(body.data)) {
      return result(true, [], `${baseUrl} answered, but not with an OpenAI model list.`);
    }
    const models = body.data
      .map((entry) => entry.id)
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return result(true, models);
  } catch (error) {
    // A refused connection is the overwhelmingly common case and deserves a plain sentence; a
    // timeout reads differently from a refusal, so say which happened.
    const aborted = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return result(
      false,
      [],
      aborted
        ? `${name} did not answer at ${baseUrl} within ${budget / 1000}s.`
        : `${name} is not answering at ${baseUrl} — is it running?`
    );
  }
};

/** Probe every runtime in parallel; the harness logs this once at boot. */
export const probeLocalRuntimes = (options: { env?: Record<string, string | undefined> } = {}): Promise<LocalRuntimeProbe[]> =>
  Promise.all(
    (Object.keys(LOCAL_RUNTIME_DEFAULTS) as LocalRuntimeId[]).map((id) =>
      probeLocalRuntime(id, { baseUrl: localRuntimeBaseUrl(id, options.env ?? process.env) })
    )
  );

/**
 * The auth a local runtime uses: none.
 *
 * Every pi-ai provider must carry `auth`. A placeholder satisfies the SDK client while an explicit
 * null header prevents transmission. It reports a source so a status screen can say
 * *why* this provider counts as configured (`local`, not "no credential"), which is also what stops
 * the model picker from hiding it — the picker skips providers whose credential does not resolve.
 */
const localAuth = (name: string) => ({
  apiKey: {
    name: `${name} (no key needed)`,
    async resolve() {
      return { auth: { apiKey: "unused", headers: { Authorization: null } }, source: "local" };
    },
  },
});

/** A chat model on a local runtime, described conservatively where the runtime tells us nothing. */
const localModel = (
  runtime: LocalRuntimeId,
  baseUrl: string,
  id: string,
  reported?: { contextWindow?: number; maxTokens?: number }
): Model<'openai-completions'> => ({
  type: "chat",
  id,
  name: id,
  provider: runtime,
  api: "openai-completions",
  baseUrl,
  // Local inference is free at the point of use; reporting a cost would invent a number.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // 8k is below every modern local model's real window, and a wrong-high window is worse: the
  // harness would send a prompt the runtime silently truncates.
  contextWindow: reported?.contextWindow ?? 8_192,
  maxTokens: reported?.maxTokens ?? 4_096,
  // Local runtimes are text-in by default. A vision model exists (llava and relatives), but the
  // runtime does not report it, and claiming image input we cannot verify would offer to attach a
  // file that then fails at generation time.
  input: ["text"],
  reasoning: false,
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
});

/** The chat models a runtime currently has, from its own `/models`. */
export const fetchLocalModels = async (
  runtime: LocalRuntimeId,
  baseUrl: string,
  signal?: AbortSignal
): Promise<Model<'openai-completions'>[]> => {
  const probe = await probeLocalRuntime(runtime, { baseUrl, ...(signal ? { signal } : {}) });
  if (!probe.running) return [];
  return probe.models.map((id) => localModel(runtime, trimSlash(baseUrl) + '/v1', id));
};

/**
 * Ollama as a Hearth provider.
 *
 * Registered only when something is listening (see `models.ts`), so the picker never offers a dead
 * runtime. `fetchModels` re-reads the list on refresh: installing a model in Ollama should show up
 * without restarting the harness.
 */
export const ollamaProvider = (options: { baseUrl?: string; modelIds?: string[] } = {}) => {
  const baseUrl = customBaseUrl(options.baseUrl ?? localRuntimeBaseUrl('ollama'));
  const apiBaseUrl = baseUrl + '/v1';
  let catalogue = (options.modelIds ?? []).map(id => localModel('ollama', apiBaseUrl, id));
  const provider = createProvider({
    id: 'ollama', name: 'Ollama', baseUrl: apiBaseUrl, auth: localAuth('Ollama'),
    models: [] as Model<'openai-completions'>[], api: openAICompletionsApi(),
  });
  // Local discovery is cheap and already ran at boot. Never restore a previous destination's
  // stored catalogue, and never merge installed IDs into the SDK's permanent baseline.
  provider.getModels = () => [...catalogue];
  provider.getAllModels = () => [...catalogue];
  provider.refreshModels = async context => {
    if (!context.allowNetwork || context.signal.aborted) return;
    const fetched = await fetchLocalModels('ollama', baseUrl, context.signal);
    if (context.signal.aborted) return;
    await context.publish({ persist: { models: fetched, checkedAt: Date.now() }, update: () => { catalogue = fetched; } });
  };
  const stream = provider.stream;
  const simple = provider.streamSimple;
  const guard = <T extends { signal?: AbortSignal; fetch?: typeof fetch } | undefined>(model: { baseUrl: string; id: string }, options: T) => {
    const changed = 'Kiln’s Ollama address or installed models changed. Refresh models and send again.';
    if (model.baseUrl !== apiBaseUrl || !catalogue.some(entry => entry.id === model.id)) throw new Error(changed);
    const send = options?.fetch ?? globalThis.fetch;
    return { ...options, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      if (request.url !== apiBaseUrl + '/chat/completions' || request.headers.has('authorization') || !catalogue.some(entry => entry.id === model.id)) throw new Error(changed);
      request.signal.throwIfAborted();
      return send(request, { redirect: 'error' });
    }) as typeof fetch };
  };
  provider.stream = (model, context, options) => stream(model, context, guard(model, options));
  provider.streamSimple = (model, context, options) => simple(model, context, guard(model, options));
  return provider;
};

/** LM Studio as a Hearth provider, on the same terms as Ollama. */
export const lmStudioProvider = (options: { baseUrl?: string } = {}) => {
  const baseUrl = options.baseUrl ?? localRuntimeBaseUrl('lmstudio');
  return createProvider({
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: trimSlash(baseUrl) + '/v1',
    auth: localAuth("LM Studio"),
    models: [],
    api: openAICompletionsApi(),
    fetchModels: ({ signal }) => fetchLocalModels('lmstudio', baseUrl, signal),
  });
};
