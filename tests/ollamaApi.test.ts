import { expect, test } from 'bun:test';
import { piOllamaSettings } from '../src/piApi';

test('Ollama discovery and URL edits go through the selected Kiln, including remote-host loopback', async () => {
  const previous = (globalThis as { window?: unknown }).window;
  const calls: { host: string; path: string; init: unknown }[] = [];
  (globalThis as { window?: unknown }).window = { ember: { piRequest: async (host: string, path: string, init: unknown) => {
    calls.push({ host, path, init });
    return { ok: true, status: 200, data: { baseUrl: 'http://127.0.0.1:11434', defaultBaseUrl: 'http://127.0.0.1:11434', customAddress: false, running: true, hasModels: false, models: [] } };
  } } };
  try {
    await piOllamaSettings('pi:local');
    await piOllamaSettings('pi:remote-tower', 'PUT', 'http://127.0.0.1:11434');
    await piOllamaSettings('pi:remote-tower', 'PUT', 'http://ollama-container:11434');
    await piOllamaSettings('pi:remote-tower', 'DELETE');
    expect(calls).toEqual([
      { host: 'pi:local', path: '/local-runtimes/ollama', init: { method: 'GET' } },
      { host: 'pi:remote-tower', path: '/local-runtimes/ollama', init: { method: 'PUT', body: { baseUrl: 'http://127.0.0.1:11434' } } },
      { host: 'pi:remote-tower', path: '/local-runtimes/ollama', init: { method: 'PUT', body: { baseUrl: 'http://ollama-container:11434' } } },
      { host: 'pi:remote-tower', path: '/local-runtimes/ollama', init: { method: 'DELETE' } },
    ]);
  } finally { if (previous === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = previous; }
});

test('Ollama client rejects malformed host status instead of claiming setup succeeded', async () => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { ember: { piRequest: async () => ({ ok: true, status: 200, data: { models: null } }) } };
  try { await expect(piOllamaSettings('pi:remote')).rejects.toThrow(/Kiln.*Test \/ Refresh/); }
  finally { if (previous === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = previous; }
});
