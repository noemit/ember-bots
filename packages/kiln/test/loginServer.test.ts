import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createProvider, type Credential, type CredentialInfo, type CredentialStore } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { hearthConfig } from '../src/config';
import { FileCredentialStore } from '../src/credentials';
import { startHearthServer, type HearthServer } from '../src/server';

/**
 * The sign-in route, end to end: what a client is told, and whether the host actually kept the
 * result. The bug these tests close was not in the flow (pi-ai's own) nor in the state machine's
 * bookkeeping (see ./login.test.ts), but in the seam between them and the credential store — the
 * credential was handed to a client that threw it away, and the store was written only if the flow
 * happened to finish inside the first request.
 */

const context = BACKGROUND_CONTEXT;
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const deviceCode = { type: 'device_code' as const, userCode: 'WXYZ-9876', verificationUri: 'https://example.test/device' };

type Flow = {
  complete: (credential: Credential) => void;
  aborted: () => boolean;
};

/**
 * A pi-ai provider whose OAuth flow emits a device code and then waits for the test. It honours its
 * signal, as the real ones do, so an abort settles it the way a live sign-in would.
 */
const oauthProvider = (id: string, label: string) => {
  const flows: Flow[] = [];
  const provider = createProvider({
    id,
    name: label,
    baseUrl: 'https://example.test/v1',
    models: [],
    api: { stream: async () => { throw new Error('not a model provider'); } } as never,
    auth: {
      oauth: {
        name: label,
        loginLabel: label,
        login: async (interaction: { signal: AbortSignal; notify: (event: unknown) => void }) => {
          interaction.notify(deviceCode);
          let aborted = false;
          const promise = new Promise<Credential>((resolve, reject) => {
            flows.push({ complete: (credential) => resolve(credential), aborted: () => aborted });
            interaction.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('the host cancelled the flow'));
            });
          });
          return promise;
        },
        refresh: async (credential: unknown) => credential,
        toAuth: async () => ({ headers: {} }),
      },
    } as never,
  });
  return { provider, flows };
};

/** A credential store that counts writes per provider, so "exactly once" is observable. */
class CountingStore implements CredentialStore {
  readonly writes: string[] = [];
  constructor(private readonly inner: FileCredentialStore) {}
  read(providerId: string, options?: never): Promise<Credential | undefined> {
    return this.inner.read(providerId, options);
  }
  list(options?: never): Promise<readonly CredentialInfo[]> {
    return this.inner.list(options);
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: never) {
    return this.inner.modify(providerId, async (current) => {
      const next = await fn(current);
      if (next !== undefined) this.writes.push(providerId);
      return next;
    }, options);
  }
  delete(providerId: string, options?: never): Promise<void> {
    return this.inner.delete(providerId, options);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle();
  }
  throw new Error('condition did not become true');
};

let home: string;
let harness: Harness;
let server: HearthServer;
let store: CountingStore;
let xai: ReturnType<typeof oauthProvider>;
let openai: ReturnType<typeof oauthProvider>;

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'hearth-login-wire-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // "xai" is a flow Hearth can finish; "openai" is the one pi-ai ships that needs hooks Hearth
  // cannot supply, so the wire must not offer it.
  xai = oauthProvider('xai', 'Sign in with SuperGrok or X Premium');
  openai = oauthProvider('openai', 'Sign in with ChatGPT');
  models.setProvider(xai.provider);
  models.setProvider(openai.provider);
  const storage = await openNodeSqliteStorage(join(home, 'hearth.sqlite'));
  harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    context
  );
  store = new CountingStore(new FileCredentialStore(join(home, 'auth.json')));
  server = startHearthServer({
    config: hearthConfig({ home, port: 0, workspace: home }),
    token: TOKEN,
    storage,
    harness,
    models,
    defaultAgent: { model: { provider: 'faux', modelId: 'faux-1' } },
    store,
    version: '9.9.9',
  });
});

afterAll(async () => {
  await server.close();
  await harness.close(context);
  // Windows can hold the sqlite file for a moment after close (the EBUSY that makes three other
  // test files fail on this platform); a leftover temp directory is not worth a red run.
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe('provider sign-in over the wire', () => {
  test('a flow that completes while the client polls is stored, and the poll never carries the secret', async () => {
    const started = await api('/providers/xai/login', { method: 'POST' });
    expect(started.status).toBe(200);
    const pending = (await started.json()) as Record<string, any>;
    expect(pending.status).toBe('pending');
    expect(pending.events[0]).toEqual(deviceCode);
    expect(store.writes).toEqual([]);

    // The human approves after the POST returned — the normal path, and the one that used to sign
    // in and store nothing.
    xai.flows[0]!.complete({ type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 60_000 });
    await waitFor(() => store.writes.length === 1);

    const polled = await api('/providers/xai/login');
    const completed = (await polled.json()) as Record<string, any>;
    expect(completed.status).toBe('complete');
    expect(completed.credentialType).toBe('oauth');
    // The secret is not on the wire at all, in any request or answer.
    expect(JSON.stringify(completed)).not.toContain('access-1');
    expect(completed.credential).toBeUndefined();

    // Polling again stores nothing more, and the store really holds it.
    await api('/providers/xai/login');
    await settle();
    expect(store.writes).toEqual(['xai']);
    const onDisk = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Record<string, any>;
    expect(onDisk.xai.access).toBe('access-1');
    const providers = (await (await api('/providers')).json()) as Record<string, any>;
    expect(providers.providers.find((provider: any) => provider.id === 'xai')?.credential).toBe('oauth');
  });

  test('a second start does not corrupt the flow, and the newer credential is the one stored', async () => {
    xai.flows.length = 0;
    await api('/providers/xai/login', { method: 'POST' });
    const second = await api('/providers/xai/login', { method: 'POST' });
    expect(((await second.json()) as Record<string, any>).status).toBe('pending');

    // The replaced flow honours its abort and rejects; that rejection must not land on the new one.
    await waitFor(() => xai.flows[0]?.aborted() === true);
    await settle();
    const polled = (await (await api('/providers/xai/login')).json()) as Record<string, any>;
    expect(polled.status).toBe('pending');

    const before = store.writes.length;
    xai.flows[1]!.complete({ type: 'oauth', access: 'access-2', refresh: 'refresh-2', expires: Date.now() + 60_000 });
    await waitFor(() => store.writes.length === before + 1);
    const onDisk = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Record<string, any>;
    expect(onDisk.xai.access).toBe('access-2');
    const after = (await (await api('/providers/xai/login')).json()) as Record<string, any>;
    expect(after.status).toBe('complete');
    expect(after.error).toBeUndefined();
  });

  test('a flow Hearth cannot finish is neither advertised nor startable, and the refusal says why', async () => {
    const providers = (await (await api('/providers')).json()) as Record<string, any>;
    const listed = (id: string) => providers.providers.find((provider: any) => provider.id === id);
    expect(listed('xai')?.signIn?.label).toBe('Sign in with SuperGrok or X Premium');
    expect(listed('openai')?.signIn).toBeNull();

    const refused = await api('/providers/openai/login', { method: 'POST' });
    expect(refused.status).toBe(400);
    const reason = ((await refused.json()) as Record<string, any>).error as string;
    expect(reason).toContain('installation id');
    expect(reason.toLowerCase()).toContain('api key');
    // Nothing ran, so the failed flow did not even start.
    expect(openai.flows).toEqual([]);
  });

  test('a cancelled flow reports the cancel and stores nothing', async () => {
    xai.flows.length = 0;
    await api('/providers/xai/login', { method: 'POST' });
    const before = store.writes.length;
    const cancelled = (await (await api('/providers/xai/login', { method: 'DELETE' })).json()) as Record<string, any>;
    expect(cancelled).toEqual({ ok: true, cancelled: true });
    await settle();
    const state = (await (await api('/providers/xai/login')).json()) as Record<string, any>;
    expect(state.status).toBe('failed');
    expect(state.error).toBe('login cancelled');
    expect(store.writes.length).toBe(before);
  });
});
