// Exercise the same provider registry as Kiln in a standalone binary, from an empty cwd.
import '../../src/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createLoginSupervisor } from '../../src/login';
import { FileCredentialStore } from '../../src/credentials';
import type { Credential } from '@earendil-works/pi-ai';
import { resolve } from 'node:path';

const calls: string[] = [];
const access = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'fixture', user_code: 'TEST-CODE', interval: 1 });
  if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'fixture-code', code_verifier: 'fixture-verifier' });
  if (url.endsWith('/oauth/token')) return Response.json({ access_token: access, refresh_token: 'fixture-refresh', expires_in: 3600 });
  throw new Error(`Unexpected network request: ${new URL(url).origin}`);
}) as typeof fetch;
const provider = openaiCodexProvider();
// Match Kiln's absolute data path; Bun on Windows cannot recursively mkdir '.'.
const store = new FileCredentialStore(resolve('auth.json'));
const supervisor = createLoginSupervisor(() => ({ id: provider.id, oauth: provider.auth.oauth }),
  async (id, credential) => { await store.modify(id, async () => credential as Credential); });
await supervisor.start(provider.id);
const deadline = Date.now() + 10000;
while (supervisor.poll(provider.id)?.status === 'pending' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
const result = await supervisor.settled(provider.id);
if (result?.status !== 'complete') throw new Error(JSON.stringify(result));
if (!result.events.some(event => event.type === 'device_code' && event.userCode === 'TEST-CODE')) throw new Error('No device code reached the client.');
if (!(await store.list()).some(entry => entry.providerId === provider.id && entry.type === 'oauth')) throw new Error('Credential was not saved.');
if (calls.length !== 3) throw new Error('The complete device-code exchange did not run.');
console.log('Compiled OAuth device-code exchange and credential persistence passed.');
