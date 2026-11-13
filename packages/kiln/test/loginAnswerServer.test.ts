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
 * A browser sign-in over the real wire: the client declares it can carry a question, the flow asks,
 * the answer comes back through a second request, and the credential is stored.
 *
 * This is the one path in the sign-in code that spans three requests, so it is the one where a
 * mistake cannot be seen in a unit test of any single piece: the question has to reach the client
 * inside a poll, the answer has to land while the flow is still parked, and a client that declares
 * nothing has to be refused *without* being left polling a sign-in nothing will answer.
 */

const context = BACKGROUND_CONTEXT;
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://localhost:51121/oauth-callback';

type Flow = {
  answers: string[];
  aborted: () => boolean;
};

/** A browser-shaped provider: announce the link, then park on a question. */
const browserProvider = (id: string, label: string) => {
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
        login: async (interaction: { signal: AbortSignal; notify: (event: unknown) => void; ask?: (prompt: unknown) => Promise<string> }) => {
          interaction.notify({ type: 'auth_url', url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' });
          let aborted = false;
          const answers: string[] = [];
          flows.push({ answers, aborted: () => aborted });
          const answer = await new Promise<string>((resolve, reject) => {
            if (!interaction.ask) {
              reject(new Error('this host did not offer a way to ask'));
              return;
            }
            interaction.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('the host cancelled the flow'));
            });
            void interaction.ask({ type: 'manual_code', message: 'Paste the redirect URL', placeholder: REDIRECT }).then(
              (value) => {
                answers.push(value);
                resolve(value);
              },
              reject
            );
          });
          void answer;
          return { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 60_000 } satisfies Credential;
        },
        refresh: async (credential: unknown) => credential,
        toAuth: async () => ({ headers: {} }),
      },
    } as never,
  });
  return { provider, flows };
};

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
let antigravity: ReturnType<typeof browserProvider>;

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'hearth-login-question-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  antigravity = browserProvider('antigravity', 'Google (Antigravity)');
  models.setProvider(antigravity.provider);
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
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
});

describe('a sign-in that asks a question over the wire', () => {
  test('the answer reaches the parked flow and the credential is stored once', async () => {
    antigravity.flows.length = 0;
    const started = await api('/providers/antigravity/login', {
      method: 'POST',
      body: JSON.stringify({ prompt: { capable: true } }),
    });
    expect(started.status).toBe(200);
    const pending = (await started.json()) as Record<string, any>;
    expect(pending.status).toBe('pending');
    // The link is there for the person to open...
    expect(pending.events.some((event: any) => event.type === 'auth_url')).toBe(true);
    // ...and so is the question, with the address the answer is checked against.
    const question = pending.events.find((event: any) => event.type === 'question');
    expect(question?.message).toBe('Paste the redirect URL');
    expect(question?.placeholder).toBe(REDIRECT);
    expect(store.writes).toEqual([]);

    const answered = await api('/providers/antigravity/login/answer', {
      method: 'POST',
      body: JSON.stringify({ answer: `${REDIRECT}?state=abc&code=4/0AX4Xf` }),
    });
    expect(answered.status).toBe(200);
    await waitFor(() => store.writes.length === 1);
    expect(antigravity.flows[0]?.answers).toEqual([`${REDIRECT}?state=abc&code=4/0X4Xf`.replace('0X4Xf', '0AX4Xf')]);

    const polled = (await (await api('/providers/antigravity/login')).json()) as Record<string, any>;
    expect(polled.status).toBe('complete');
    expect(JSON.stringify(polled)).not.toContain('access-1');
    const onDisk = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Record<string, any>;
    expect(onDisk.antigravity.type).toBe('oauth');
  });

  test('an answer with nothing waiting is refused, and says to start again', async () => {
    const orphan = await api('/providers/antigravity/login/answer', {
      method: 'POST',
      body: JSON.stringify({ answer: `${REDIRECT}?code=abc` }),
    });
    expect(orphan.status).toBe(400);
    const body = (await orphan.json()) as Record<string, any>;
    expect(String(body.error)).toContain('waiting for an answer');
  });

  test('an empty answer is refused before it can resolve a question', async () => {
    const empty = await api('/providers/antigravity/login/answer', { method: 'POST', body: JSON.stringify({ answer: '   ' }) });
    expect(empty.status).toBe(400);
  });

  test('a client that cannot carry a question is refused, and never left polling', async () => {
    antigravity.flows.length = 0;
    // Older Ember sends no body at all; the refusal has to be immediate and explain itself.
    const started = await api('/providers/antigravity/login', { method: 'POST', body: '' });
    expect(started.status).toBe(200);
    const body = (await started.json()) as Record<string, any>;
    // Antigravity is offered to every client, so the flow itself reports the question it could not
    // ask rather than the route pretending it will progress.
    expect(body.status).toBe('failed');
    expect(String(body.error)).toContain('Paste the redirect URL');
    const polled = (await (await api('/providers/antigravity/login')).json()) as Record<string, any>;
    expect(polled.status).toBe('failed');
    // The flow did start — it could not know a question was coming — but it asked nothing and got no
    // answer, so nothing was stored and the client is not left waiting.
    expect(antigravity.flows).toHaveLength(1);
    expect(antigravity.flows[0]?.answers).toEqual([]);
  });
});
