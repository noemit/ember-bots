import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { createModels } from '@earendil-works/pi-ai';
import { customBaseUrl } from './custom-providers';
import { LOCAL_RUNTIME_DEFAULTS, localRuntimeBaseUrl, ollamaProvider, probeLocalRuntime, type LocalRuntimeProbe } from './local-models';

/** A root service address, not the OpenAI /v1 endpoint. Shares custom endpoint URL safety rules. */
export function ollamaAddress(value: unknown): string {
  const address = customBaseUrl(value);
  const path = new URL(address).pathname;
  if (path !== '/') throw new Error('Use the Ollama service address without an API path, for example http://127.0.0.1:11434. Kiln adds the model and chat paths.');
  return address;
}

/** Host-owned, keyless configuration; the built-in provider ID never changes or duplicates. */
export class OllamaSettings {
  private override?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  readonly ready: Promise<void>;
  private controller?: AbortController;
  constructor(private readonly home: string, private readonly models: ReturnType<typeof createModels>, private readonly probes: LocalRuntimeProbe[]) {
    this.file = join(home, 'ollama.json');
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { baseUrl?: unknown };
      if (saved.baseUrl !== undefined) this.override = ollamaAddress(saved.baseUrl);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Kiln could not read its Ollama address. Restore ollama.json from a backup, then restart Kiln.'); }
    this.ready = this.refresh().then(() => {});
    this.chain = this.ready;
  }
  private defaultAddress() {
    try { return ollamaAddress(localRuntimeBaseUrl('ollama')); }
    catch { return LOCAL_RUNTIME_DEFAULTS.ollama.baseUrl; }
  }
  private address() { return this.override ?? this.defaultAddress(); }
  state() {
    return { ...this.probes.find(probe => probe.id === 'ollama')!, baseUrl: this.address(), customAddress: Boolean(this.override), defaultBaseUrl: this.defaultAddress() };
  }
  private async refresh() {
    this.controller?.abort();
    this.models.deleteProvider('ollama');
    let invalidEnvironment = false;
    if (!this.override) {
      try { ollamaAddress(localRuntimeBaseUrl('ollama')); } catch { invalidEnvironment = true; }
    }
    const probe: LocalRuntimeProbe = invalidEnvironment
      ? { id: 'ollama', name: 'Ollama', baseUrl: this.address(), running: false, hasModels: false, models: [], problem: 'Kiln’s Ollama environment address is unusable. Choose Change address, enter an Ollama service address, then Test / Refresh.' }
      : await probeLocalRuntime('ollama', { baseUrl: this.address() });
    const index = this.probes.findIndex(entry => entry.id === 'ollama');
    if (index < 0) this.probes.push(probe); else this.probes[index] = probe;
    if (probe.hasModels && !probe.problem) {
      const controller = this.controller = new AbortController();
      const provider = ollamaProvider({ baseUrl: probe.baseUrl, modelIds: probe.models });
      // A held model must not silently keep using an address after the person edits it.
      const stream = provider.stream;
      const simple = provider.streamSimple;
      const guard = <T extends { signal?: AbortSignal } | undefined>(options: T) => {
        if (controller.signal.aborted) throw new Error('Kiln’s Ollama address changed. Refresh models and send again.');
        return { ...options, signal: AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]) };
      };
      provider.stream = (model, context, options) => stream(model, context, guard(options));
      provider.streamSimple = (model, context, options) => simple(model, context, guard(options));
      this.models.setProvider(provider);
    }
    return this.state();
  }
  save(value: unknown, reset = false) {
    const next = this.chain.then(async () => {
      const address = reset ? undefined : ollamaAddress(value);
      mkdirSync(this.home, { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(address ? { baseUrl: address } : {}) + '\n', { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      this.override = address;
      return this.refresh();
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
