import { expect, test } from 'bun:test';
import { piLoadProviders, piRemoveProvider, piSetProviderKey } from '../src/piApi';

const calls: Array<{ method: string; path: string; body?: unknown }> = [];
let credentials: Record<string, 'api_key' | 'oauth' | null> = {};

const providerList = () => ({
  providers: [
    { id: 'opencode-go', name: 'OpenCode Go', credential: credentials['opencode-go'] ?? null },
    {
      id: 'xai',
      name: 'xAI',
      credential: credentials['xai'] ?? null,
      signIn: { label: 'Sign in with SuperGrok or X Premium', pending: false },
    },
  ],
  default: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
});

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body });
      if (path === '/providers' && method === 'GET') return { ok: true, status: 200, data: providerList() };
      const match = /^\/providers\/(.+)$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (method === 'DELETE') {
          credentials[id] = null;
          return { ok: true, status: 200, data: { ok: true, provider: id, credential: null } };
        }
        credentials[id] = 'api_key';
        return { ok: true, status: 200, data: { ok: true, provider: id, credential: 'api_key' } };
      }
      return { ok: false, status: 404, data: null };
    },
  },
};

test('piLoadProviders maps the Hearth provider catalog and credential types', async () => {
  credentials = { 'opencode-go': 'api_key' };
  const catalog = await piLoadProviders('pi:test');
  expect(catalog?.providers).toEqual([
    // A provider without OAuth reports no sign-in affordance at all.
    { id: 'opencode-go', name: 'OpenCode Go', credential: 'api_key', signIn: null },
    {
      id: 'xai',
      name: 'xAI',
      credential: null,
      signIn: { label: 'Sign in with SuperGrok or X Premium', pending: false },
    },
  ]);
  expect(catalog?.default).toEqual({ provider: 'opencode-go', modelId: 'glm-5.3-flash' });
});

test('piSetProviderKey posts an api_key credential to the provider id', async () => {
  calls.length = 0;
  const result = await piSetProviderKey('pi:test', 'deepseek', 'sk-deep');
  expect(result.ok).toBe(true);
  expect(calls).toEqual([{ method: 'POST', path: '/providers/deepseek', body: { type: 'api_key', key: 'sk-deep' } }]);
});

test('piRemoveProvider deletes the provider credential', async () => {
  calls.length = 0;
  const result = await piRemoveProvider('pi:test', 'opencode-go');
  expect(result.ok).toBe(true);
  expect(calls).toEqual([{ method: 'DELETE', path: '/providers/opencode-go', body: undefined }]);
});

test('a failed set surfaces the host error text', async () => {
  const previous = (globalThis as { window: { ember: { piRequest: unknown } } }).window.ember.piRequest;
  (globalThis as { window: { ember: { piRequest: unknown } } }).window.ember.piRequest = async () => ({
    ok: false,
    status: 400,
    data: { error: 'expected a credential' },
  });
  const result = await piSetProviderKey('pi:test', 'deepseek', 'sk');
  expect(result).toEqual({ ok: false, status: 400, error: 'expected a credential' });
  (globalThis as { window: { ember: { piRequest: unknown } } }).window.ember.piRequest = previous;
});


test('a provider sign-in starts, polls and cancels over the expected routes', async () => {
  calls.length = 0;
  const {
    piStartProviderLogin,
    piPollProviderLogin,
    piCancelProviderLogin,
  } = await import('../src/piApi');

  const deviceCode = {
    events: [
      {
        type: 'device_code' as const,
        userCode: 'ABCD-1234',
        verificationUri: 'https://x.ai/device',
        expiresInSeconds: 1800,
      },
    ],
  };
  let state: { status: string; events: unknown[]; error?: string } = { status: 'pending', events: deviceCode.events };

  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: async (_endpointId: string, path: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, path });
        if (method === 'DELETE') return { ok: true, status: 200, data: { ok: true, cancelled: true } };
        if (path.endsWith('/login')) return { ok: true, status: 200, data: state };
        return { ok: false, status: 404, data: null };
      },
    },
  };

  const started = await piStartProviderLogin('pi:test', 'xai');
  expect(started.ok).toBe(true);
  expect(started.state?.status).toBe('pending');
  expect(started.state?.events[0]).toMatchObject({ type: 'device_code', userCode: 'ABCD-1234' });

  // The poll that completes the flow is the one that carries the credential.
  state = { status: 'complete', events: deviceCode.events };
  const polled = await piPollProviderLogin('pi:test', 'xai');
  expect(polled.state?.status).toBe('complete');

  await piCancelProviderLogin('pi:test', 'xai');
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    'POST /providers/xai/login',
    'GET /providers/xai/login',
    'DELETE /providers/xai/login',
  ]);
});
