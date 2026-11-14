import { expect, test } from 'bun:test';
import { createModels, InMemoryCredentialStore, type OAuthCredential } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { antigravityOAuth } from '../src/antigravity-oauth';
import { importCredentials } from '../src/alignment';

registerBunOAuthFlows();
const signal = new AbortController().signal;
const jwt = (accountId: string) => 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url') + '.fake-signature';

test('actual Codex refresh rotates copied hosts independently and rebuilds account metadata', async () => {
  const source = new InMemoryCredentialStore();
  const dest = new InMemoryCredentialStore();
  const initial: OAuthCredential = { type: 'oauth', access: jwt('fake-account'), refresh: 'fake-shared-refresh', expires: 1, accountId: 'fake-account', extra: 'copied-metadata' };
  await source.modify('openai-codex', async () => initial);
  await importCredentials(dest, [{ providerId: 'openai-codex', experimental: true, credential: initial }]);
  expect(await dest.read('openai-codex')).toEqual(initial);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const flow = openaiCodexProvider().auth!.oauth!;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe('https://auth.openai.com/oauth/token');
    expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('fake-shared-refresh');
    calls++;
    if (calls > 1) return Response.json({ error: 'fake-rotated-token' }, { status: 400 });
    return Response.json({ access_token: jwt('fake-next-account'), refresh_token: 'fake-rotated-refresh', expires_in: 3600 });
  }) as typeof fetch;
  try {
    await source.modify('openai-codex', async current => flow.refresh(current as OAuthCredential, signal));
    expect(await source.read('openai-codex')).toMatchObject({ refresh: 'fake-rotated-refresh', accountId: 'fake-next-account' });
    expect((await source.read('openai-codex') as OAuthCredential).extra).toBeUndefined();
    expect(await dest.read('openai-codex')).toEqual(initial);
    await expect(dest.modify('openai-codex', async current => flow.refresh(current as OAuthCredential, signal))).rejects.toThrow();
    expect(await dest.read('openai-codex')).toEqual(initial);
    expect(calls).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test('actual Antigravity copied refresh retains project/email/unknown metadata and supports nonrotating response', async () => {
  const source = new InMemoryCredentialStore();
  const dest = new InMemoryCredentialStore();
  const initial: OAuthCredential = { type: 'oauth', access: 'fake-access', refresh: 'fake-shared-refresh', expires: 1, projectId: 'fake-project', email: 'fake@example.test', extra: { preserved: true } };
  await source.modify('antigravity', async () => initial);
  await importCredentials(dest, [{ providerId: 'antigravity', experimental: true, credential: initial }]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('fake-shared-refresh');
    calls++;
    return Response.json({ access_token: 'fake-new-access-' + calls, expires_in: 3600, ...(calls === 1 ? { refresh_token: 'fake-rotated-refresh' } : {}) });
  }) as typeof fetch;
  try {
    await source.modify('antigravity', async current => antigravityOAuth.refresh(current as OAuthCredential, signal));
    expect(await dest.read('antigravity')).toEqual(initial);
    await dest.modify('antigravity', async current => antigravityOAuth.refresh(current as OAuthCredential, signal));
    expect(await source.read('antigravity')).toMatchObject({ ...initial, access: 'fake-new-access-1', refresh: 'fake-rotated-refresh', expires: expect.any(Number) });
    expect(await dest.read('antigravity')).toMatchObject({ ...initial, access: 'fake-new-access-2', expires: expect.any(Number) });
    expect(calls).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test('actual Codex refresh rejects missing replacement refresh token without destroying stored credential', async () => {
  const store = new InMemoryCredentialStore();
  const initial: OAuthCredential = { type: 'oauth', access: jwt('fake-account'), refresh: 'fake-refresh', expires: 1, accountId: 'fake-account' };
  await store.modify('openai-codex', async () => initial);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown) => Response.json({ access_token: jwt('fake-account'), expires_in: 3600 })) as typeof fetch;
  try {
    const flow = openaiCodexProvider().auth!.oauth!;
    await expect(store.modify('openai-codex', async current => flow.refresh(current as OAuthCredential, signal))).rejects.toThrow();
    expect(await store.read('openai-codex')).toEqual(initial);
  } finally { globalThis.fetch = originalFetch; }
});

test('SDK getAuth cancellation returns promptly but persists a Codex token rotated by an in-flight refresh', async () => {
  const store = new InMemoryCredentialStore();
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: jwt('fake-account'), refresh: 'fake-old-refresh', expires: 1, accountId: 'fake-account' }));
  const models = createModels({ credentials: store });
  models.setProvider(openaiCodexProvider());
  const caller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let finishRefresh!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finishRefresh = resolve; });
  let refreshSignal: AbortSignal | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe('https://auth.openai.com/oauth/token');
    refreshSignal = init.signal as AbortSignal;
    markStarted();
    return response;
  }) as typeof fetch;
  try {
    // Attach both handlers immediately: cancellation is an expected SDK result, not an unhandled rejection.
    const result = models.getAuth('openai-codex', { signal: caller.signal }).then(
      () => ({ cancelled: false }),
      () => ({ cancelled: true }),
    );
    await started;
    caller.abort(new Error('fake-caller-cancelled'));
    expect(await result).toEqual({ cancelled: true });
    expect(refreshSignal).not.toBe(caller.signal);
    expect(refreshSignal?.aborted).toBe(false);
    finishRefresh(Response.json({ access_token: jwt('fake-account'), refresh_token: 'fake-new-refresh', expires_in: 3600 }));
    // A second modify waits behind the SDK's refresh lock, proving persistence completed before release.
    const persisted = await store.modify('openai-codex', async () => undefined);
    expect(persisted).toMatchObject({ type: 'oauth', refresh: 'fake-new-refresh', accountId: 'fake-account' });
    expect((await models.getAuth('openai-codex'))?.auth.apiKey).toBe(jwt('fake-account'));
  } finally {
    finishRefresh?.(Response.json({ access_token: jwt('fake-account'), refresh_token: 'fake-new-refresh', expires_in: 3600 }));
    globalThis.fetch = originalFetch;
  }
});
