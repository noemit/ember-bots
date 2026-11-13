// Exercise the same provider registry as Kiln in a standalone binary, from an empty cwd.
import '../../src/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { antigravityProvider } from '../../src/antigravity';
import { createLoginSupervisor } from '../../src/login';
import { FileCredentialStore } from '../../src/credentials';
import type { Credential } from '@earendil-works/pi-ai';
import { resolve } from 'node:path';

/**
 * Two flows, because there are two kinds of thing that can break in a compiled binary: pi-ai's own
 * modules (loaded through its registered static loaders) and Hearth's own flow, which imports
 * `node:http` for its loopback callback. Antigravity is the second — the one a bundler could quietly
 * drop, and the one whose callback server is what makes a browser sign-in work at all.
 */

const calls: string[] = [];
const access = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`;
// The Antigravity question carries the address the flow expects, not the state it minted — that is
// an anti-forgery check, not something the human is told. So the answer is built from the authorize
// URL the flow announced, which is where a person's browser got both values from.

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'fixture', user_code: 'TEST-CODE', interval: 1 });
  if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'fixture-code', code_verifier: 'fixture-verifier' });
  if (url.endsWith('/oauth/token')) return Response.json({ access_token: access, refresh_token: 'fixture-refresh', expires_in: 3600 });
  // Antigravity: token exchange, account lookup and project discovery.
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'antigravity-access', refresh_token: 'antigravity-refresh', expires_in: 3600 });
  }
  if (url.includes('oauth2/v1/userinfo')) return Response.json({ email: 'fixture@example.test' });
  if (url.endsWith('/v1internal:loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'fixture-project' });
  throw new Error(`Unexpected network request: ${new URL(url).origin}${new URL(url).pathname}`);
}) as typeof fetch;

// Match Kiln's absolute data path; Bun on Windows cannot recursively mkdir '.'.
const store = new FileCredentialStore(resolve('auth.json'));

const codexProvider = openaiCodexProvider();
const codex = createLoginSupervisor(() => ({ id: codexProvider.id, oauth: codexProvider.auth.oauth }),
  async (id, credential) => { await store.modify(id, async () => credential as Credential); });
await codex.start(codexProvider.id);
const deadline = Date.now() + 10000;
while (codex.poll(codexProvider.id)?.status === 'pending' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
const result = await codex.settled(codexProvider.id);
if (result?.status !== 'complete') throw new Error(JSON.stringify(result));
if (!result.events.some(event => event.type === 'device_code' && event.userCode === 'TEST-CODE')) throw new Error('No device code reached the client.');
if (!(await store.list()).some(entry => entry.providerId === codexProvider.id && entry.type === 'oauth')) throw new Error('Credential was not saved.');

const antigravityFlow = antigravityProvider();
const antigravity = createLoginSupervisor(() => ({ id: antigravityFlow.id, oauth: antigravityFlow.auth.oauth }),
  async (id, credential) => { await store.modify(id, async () => credential as Credential); });
const started = await antigravity.start(antigravityFlow.id, { prompt: true });
if (started.status !== 'pending') throw new Error(`Antigravity did not park on its question: ${JSON.stringify(started)}`);
const question = started.events.find((event): event is Extract<typeof event, { type: 'question' }> => event.type === 'question');
if (!question?.placeholder) throw new Error(`The redirect address never reached the client: ${JSON.stringify(started.events)}`);
// Answer exactly as a person would: with the address their browser landed on, carrying the code
// and the state the browser had.
const link = started.events.find((event): event is Extract<typeof event, { type: 'auth_url' }> => event.type === 'auth_url');
if (!link) throw new Error('The sign-in link never reached the client.');
const state = new URL(link.url).searchParams.get('state') ?? '';
if (!state) throw new Error('The sign-in link carried no state for the browser to return.');
for (let attempt = 0; attempt < 200; attempt += 1) {
  if (antigravity.answer(antigravityFlow.id, `http://localhost:51121/oauth-callback?code=fixture-code&state=${state}`)) break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
const settled = await (async () => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = await antigravity.settled(antigravityFlow.id);
    if (current && current.status !== 'pending') return current;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return antigravity.poll(antigravityFlow.id);
})();
if (settled?.status !== 'complete') throw new Error(`Antigravity sign-in did not finish: ${JSON.stringify(settled)}`);
const stored = await store.read(antigravityFlow.id);
if (stored?.type !== 'oauth' || stored['projectId'] !== 'fixture-project') {
  throw new Error(`Antigravity credential was not saved with its project: ${JSON.stringify(stored)}`);
}
console.log('Compiled OAuth device-code and browser-question exchanges, and credential persistence, passed.');
