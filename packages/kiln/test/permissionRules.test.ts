import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { AgentDoc, createRegistry, Harness, MemoryStorage, type JsonObject } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Approvals, ApprovalsDoc, pendingApprovals, previewPermission, replyApproval, replySimilarApproval, listPermissionRules, revokePermissionRules } from '../src/approvals';
import { attestPermissionEnvironment, attestPermissionHost, bindPermission, permissionArgv, PermissionRulesDoc, ruleFor, samePermission, validBinding, bindingForCall } from '../src/permissionRules';
import { Sessions, SessionsDoc } from '../src/sessions';
import { hearthCodemodeExtensions } from '../src/codemode';
import { hearthConfig } from '../src/config';
import { startHearthServer } from '../src/server';
import { FileCredentialStore } from '../src/credentials';

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const done = () => fauxAssistantMessage([fauxText('done')]);
const linux = process.platform === 'linux';
const temp = () => mkdtempSync(join(tmpdir(), 'kiln-rules-'));
const poll = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  for (let i = 0; i < 150; i++) { const result = await read(); if (ready(result)) return result; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('test approval did not arrive');
};
const setup = async (cwd: string, database?: string, scopeRequired = false) => {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(); const codemode = hearthCodemodeExtensions();
  for (const ext of codemode.extensions) registry.install(ext);
  registry.install(CodingTools); registry.install(Approvals); registry.install(Sessions);
  const storage = database ? await openNodeSqliteStorage(database) : new MemoryStorage();
  const harness = await Harness.open(storage, { registry, models, env: ({ cwd: dir }) => attestPermissionEnvironment(new NodeExecutionEnv({ cwd: dir ?? cwd, shellEnv: { BASH_ENV: join(cwd, 'startup'), LD_PRELOAD: join(cwd, 'evil.so'), PATH: cwd } }), { home: cwd, scopeRequired }) }, context);
  attestPermissionHost(harness, { home: cwd, scopeRequired });
  const create = () => harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { cwd, model: { provider: 'faux', modelId: 'faux-1' } } }, context);
  return { faux, harness, models, storage, create, close: async () => { codemode.close(); await harness.close(context); } };
};

describe('permission rule recognizer', () => {
  test('only conservative exact bare tokens, never shell/code/wrapper/Git prefixes', () => {
    for (const command of ['pwd', 'pwd -P', 'ls -la src', 'wc -l README.md', 'ls ../other']) expect(permissionArgv(command)).toEqual(command.split(' '));
    for (const command of ['', ' pwd', 'pwd ', 'ls  src', 'ls\tsrc', 'ls\nsrc', 'ls\r', 'ls\u00a0src', 'ls café', 'ls *', 'ls foo?', 'ls [ab]', 'ls ~', 'ls $HOME', 'ls `id`', 'ls $(id)', 'ls "src"', "ls 'src'", 'pwd;id', 'pwd && id', 'pwd || id', 'pwd | cat', 'pwd > out', 'pwd < in', 'pwd &', 'pwd # comment', 'ls \\x', 'ls --help', 'ls --color=always', 'ls -R', 'ls -Ifoo', 'ls --', 'wc --files0-from=foo', 'pwd -L', './ls', '/usr/bin/ls', 'env ls', 'PATH=/tmp ls', 'command ls', 'sudo ls', 'timeout 2 ls', 'bash -c pwd', 'python file.py', 'node app.js', 'bun test', 'npm test', 'git status', 'git -c core.fsmonitor=evil status', 'find . -exec x', 'xargs ls', 'ls src;pwd', 'ls\0src']) expect(permissionArgv(command)).toBeUndefined();
  });
  test('deterministic fuzz rejects every non-allowlisted ASCII character and Unicode', () => {
    const allowed = /[A-Za-z0-9_./-]/;
    for (let i = 0; i < 256; i++) {
      const c = String.fromCharCode(i);
      if (c !== ' ' && !allowed.test(c)) expect(permissionArgv(`ls a${c}b`)).toBeUndefined();
    }
    for (const c of ['\u2028', '\u202e', '\uff1b', '\uff0f', '\ud800', '💥']) expect(permissionArgv(`ls a${c}b`)).toBeUndefined();
  });
  test.skipIf(linux)('other platforms fail closed', () => { expect(bindPermission('pwd', process.cwd())).toBeUndefined(); });
  test.skipIf(!linux)('cwd real identity, symlink target changes, exact argv and malformed persisted values fail closed', () => {
    const dir = temp(); mkdirSync(join(dir, 'one')); mkdirSync(join(dir, 'two')); symlinkSync(join(dir, 'one'), join(dir, 'link'));
    try {
      const a = bindPermission('ls -l', join(dir, 'link'))!;
      expect(a.cwd).toBe(join(dir, 'one')); expect(validBinding(a)).toBe(true);
      expect(samePermission(a, bindPermission('ls -la', join(dir, 'one'))!)).toBe(false);
      expect(samePermission(a, bindPermission('ls -l', join(dir, 'two'))!)).toBe(false);
      renameSync(join(dir, 'one'), join(dir, 'old')); mkdirSync(join(dir, 'one'));
      expect(validBinding(a)).toBe(false);
      for (const bad of [null, {}, { argv: null }, { ...a, executable: '/tmp/ls' }, { ...a, executableIdentity: 'tampered' }, { ...a, environment: 'inherit' }]) {
        expect(validBinding(bad as never)).toBe(false);
        expect(ruleFor([bad] as never, a, 1 as never)).toBeUndefined();
      }
      expect(ruleFor({} as never, a, 1 as never)).toBeUndefined();
      expect(bindingForCall({ command: 'pwd', timeout: 31 }, { env: new NodeExecutionEnv({ cwd: dir }) } as never)).toBeUndefined();
      expect(bindingForCall({ command: 'pwd', env: {} }, { env: new NodeExecutionEnv({ cwd: dir }) } as never)).toBeUndefined();
      expect(bindingForCall({ command: 'pwd' }, { env: { cwd: dir } } as never)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(!linux)('host permission rules gates and routes', () => {
  test('atomic/idempotent similar, real argv execution, clean env, evidence, exact match, revoke, no inheritance and restart', async () => {
    const dir = temp(); const database = join(dir, 'host.sqlite');
    writeFileSync(join(dir, 'startup'), `echo shell-startup > ${join(dir, 'shell-ran')}`);
    let stack = await setup(dir, database);
    try {
      const conversation = await stack.create();
      const id = conversation.id;
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      const first = await conversation.submit({ type: 'input', content: 'run' }, context);
      const [pending] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      const preview = await previewPermission(stack.harness, id, pending.key, undefined);
      expect(preview.supported).toBe(true); expect(preview.policy?.cwd).toBe(dir); expect(preview.policy?.maxTimeoutSeconds).toBe(30);
      expect((await previewPermission(stack.harness, id, pending.key, 'pwd -P')).supported).toBe(true);
      expect((await previewPermission(stack.harness, id, pending.key, 'pwd ')).supported).toBe(false);
      expect(await Promise.all(Array.from({ length: 8 }, () => replySimilarApproval(stack.harness, id, pending.key, 'pwd')))).toEqual(Array(8).fill(true));
      await first.wait(context);
      let rules = await listPermissionRules(stack.harness, id); expect(rules).toHaveLength(1);
      const result = JSON.stringify((await conversation.entries({}, 30, undefined, context)).items);
      expect(result).toContain(dir); expect(result).toContain('permission_rule'); expect(result).toContain(rules[0].id);
      expect(result).not.toContain('evil.so');
      const latestEntry = (await conversation.entries({}, 1, undefined, context)).items[0];
      const fork = await conversation.fork(latestEntry.id, { ownership: { kind: 'ownerless' } }, context);
      expect(await listPermissionRules(stack.harness, fork.id)).toHaveLength(0);
      expect(await pendingApprovals(stack.harness, [fork.id])).toHaveLength(0);
      stack.faux.setResponses([call('session', { action: 'spawn', name: 'isolated-worker', brief: 'Return done. Do not run commands.' }), done(), done(), done()]);
      await (await conversation.submit({ type: 'input', content: 'spawn fixture worker' }, context)).wait(context);
      const crew = await stack.harness.snapshot(SessionsDoc, id, context);
      const workerId = crew!.items['isolated-worker'].conversationId;
      const worker = await stack.harness.conversation(workerId, context);
      await worker!.waitForIdle(context);
      expect(await listPermissionRules(stack.harness, workerId)).toHaveLength(0);
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      const workerSubmission = await worker!.submit({ type: 'input', content: 'worker scope' }, context);
      const [workerApproval] = await poll(() => pendingApprovals(stack.harness, [workerId]), (p) => p.length === 1);
      await replyApproval(stack.harness, workerId, workerApproval.key, 'reject'); await workerSubmission.wait(context);

      // Exact argv, not a program prefix; a changed folder cannot use the original grant either.
      for (const [command, cwd] of [['pwd -P', dir], ['pwd', join(dir, 'other-folder')]]) {
        if (cwd !== dir) mkdirSync(cwd);
        await stack.harness.commit(async (tx) => { (await tx.doc(AgentDoc, id)).cwd = cwd; }, context);
        stack.faux.setResponses([call('bash', { command }), done()]);
        const changed = await conversation.submit({ type: 'input', content: 'changed scope' }, context);
        const [changedApproval] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
        expect(changedApproval.arguments.command).toBe(command);
        await replyApproval(stack.harness, id, changedApproval.key, 'reject'); await changed.wait(context);
      }
      await stack.harness.commit(async (tx) => { (await tx.doc(AgentDoc, id)).cwd = dir; }, context);

      expect(await Bun.file(join(dir, 'shell-ran')).exists()).toBe(false);
      expect((await import('node:fs')).existsSync(join(dir, 'tmp', 'conversation-' + id))).toBe(true);
      stack.faux.setResponses([call('codemode', { code: 'return await tools.bash({command:"pwd"})' }), done()]);
      const nested = await conversation.submit({ type: 'input', content: 'nested' }, context); await nested.wait(context);
      expect(await pendingApprovals(stack.harness, [id])).toHaveLength(0);
      // A code runner nested in codemode still parks: rules do not cover codemode wholesale.
      stack.faux.setResponses([call('codemode', { code: 'return await tools.bash({command:"bun test"})' }), done()]);
      const deniedNested = await conversation.submit({ type: 'input', content: 'unsupported' }, context);
      const [nestedApproval] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      expect(nestedApproval.arguments.command).toBe('bun test');
      expect((await previewPermission(stack.harness, id, nestedApproval.key, undefined)).supported).toBe(false);
      expect((await previewPermission(stack.harness, id, nestedApproval.key, 'pwd')).supported).toBe(false);
      await expect(replySimilarApproval(stack.harness, id, nestedApproval.key, 'pwd')).rejects.toThrow();
      await replyApproval(stack.harness, id, nestedApproval.key, 'reject'); await deniedNested.wait(context);
      // Another conversation in the identical folder has no grant.
      const other = await stack.create();
      expect(await listPermissionRules(stack.harness, other.id)).toHaveLength(0);
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      const foreign = await other.submit({ type: 'input', content: 'run' }, context);
      const [foreignApproval] = await poll(() => pendingApprovals(stack.harness, [other.id]), (p) => p.length === 1);
      await replyApproval(stack.harness, other.id, foreignApproval.key, 'reject'); await foreign.wait(context);
      await stack.close(); stack = await setup(dir, database);
      rules = await listPermissionRules(stack.harness, id); expect(rules).toHaveLength(1);
      const restored = await stack.harness.conversation(id, context);
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      await (await restored!.submit({ type: 'input', content: 'after restart' }, context)).wait(context);
      expect(await pendingApprovals(stack.harness, [id])).toHaveLength(0);
      await revokePermissionRules(stack.harness, id, rules[0].id);
      expect(await replySimilarApproval(stack.harness, id, pending.key, 'pwd')).toBe(true);
      expect(await listPermissionRules(stack.harness, id)).toHaveLength(0); // retry cannot resurrect
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      const revoked = await restored!.submit({ type: 'input', content: 'revoked' }, context);
      const [last] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      await replyApproval(stack.harness, id, last.key, 'reject'); await revoked.wait(context);
    } finally { await stack.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 25000);

  test('managed scope requirements fail closed and session home changes cannot reuse grants', async () => {
    const dir = temp(); const stack = await setup(dir, undefined, true);
    try {
      const conversation = await stack.create();
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      const submitted = await conversation.submit({ type: 'input', content: 'scope fixture' }, context);
      const [pending] = await poll(() => pendingApprovals(stack.harness, [conversation.id]), (p) => p.length === 1);
      const preview = await previewPermission(stack.harness, conversation.id, pending.key, undefined);
      expect(preview.supported).toBe(false); expect(preview.reason).toContain('managed host scope');
      await expect(replySimilarApproval(stack.harness, conversation.id, pending.key, 'ls -l')).rejects.toThrow();
      expect(await listPermissionRules(stack.harness, conversation.id)).toHaveLength(0);
      await replyApproval(stack.harness, conversation.id, pending.key, 'reject'); await submitted.wait(context);
      const otherHome = join(dir, 'other-home'); mkdirSync(otherHome);
      expect(samePermission(bindPermission('pwd', dir, dir)!, bindPermission('pwd', dir, otherHome)!)).toBe(false);
      const scoped = attestPermissionEnvironment(new NodeExecutionEnv({ cwd: dir }), { home: dir, scopeRequired: true });
      expect(bindingForCall({ command: 'pwd' }, { env: scoped } as never)).toBeUndefined();
      const enabled = attestPermissionEnvironment(new NodeExecutionEnv({ cwd: dir }), { home: dir, scopeRequired: false });
      expect(bindingForCall({ command: 'pwd' }, { env: enabled } as never)?.executionHome).toBe(dir);
    } finally { await stack.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 10000);

  test('edited future argv is independent from original once approval, exact, atomic and idempotent', async () => {
    const dir = temp(); const stack = await setup(dir);
    writeFileSync(join(dir, 'original.txt'), 'abc'); writeFileSync(join(dir, 'future.txt'), '1234567');
    try {
      const conversation = await stack.create(); const id = conversation.id;
      const original = 'wc -c original.txt'; const future = 'wc -c future.txt';
      stack.faux.setResponses([call('bash', { command: original }), done()]);
      const first = await conversation.submit({ type: 'input', content: 'original fixture' }, context);
      const [pending] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      for (const malformed of ['wc -c future.txt;pwd', 'bun test', 'wc  -c future.txt', 'wc -c $HOME', '', null, 7]) {
        expect((await previewPermission(stack.harness, id, pending.key, malformed)).supported).toBe(false);
        await expect(replySimilarApproval(stack.harness, id, pending.key, malformed)).rejects.toThrow();
      }
      expect(await listPermissionRules(stack.harness, id)).toHaveLength(0);
      const differentUtility = await previewPermission(stack.harness, id, pending.key, 'ls -l');
      expect(differentUtility.supported).toBe(true); expect(differentUtility.policy?.argv).toEqual(['ls', '-l']);
      const preview = await previewPermission(stack.harness, id, pending.key, future);
      expect(preview.supported).toBe(true); expect(preview.policy?.argv).toEqual(future.split(' '));
      expect(preview.policy?.cwd).toBe(dir);
      expect(await Promise.all(Array.from({ length: 8 }, () => replySimilarApproval(stack.harness, id, pending.key, future)))).toEqual(Array(8).fill(true));
      await first.wait(context);
      const evidence = JSON.stringify((await conversation.entries({}, 30, undefined, context)).items);
      expect(evidence).toContain('3 original.txt'); expect(evidence).not.toContain('7 future.txt');
      expect(evidence).toContain('Original command allowed once');
      const rules = await listPermissionRules(stack.harness, id);
      expect(rules).toHaveLength(1); expect(rules[0].argv).toEqual(future.split(' '));
      expect(await replySimilarApproval(stack.harness, id, pending.key, future)).toBe(true);
      await expect(replySimilarApproval(stack.harness, id, pending.key, original)).rejects.toThrow();
      await expect(replySimilarApproval(stack.harness, id, pending.key, undefined)).rejects.toThrow();
      expect((await stack.harness.snapshot(ApprovalsDoc, id, context))?.items[pending.key].permissionBinding?.argv).toEqual(original.split(' '));
      expect((await stack.harness.snapshot(ApprovalsDoc, id, context))?.items[pending.key].permissionSavedCommand).toBe(future);
      stack.faux.setResponses([call('bash', { command: future }), done()]);
      await (await conversation.submit({ type: 'input', content: 'future fixture' }, context)).wait(context);
      expect(await pendingApprovals(stack.harness, [id])).toHaveLength(0);
      expect(JSON.stringify((await conversation.entries({}, 30, undefined, context)).items)).toContain('7 future.txt');
      for (const command of [original, 'wc -l future.txt']) {
        stack.faux.setResponses([call('bash', { command }), done()]);
        const other = await conversation.submit({ type: 'input', content: 'not granted' }, context);
        const [approval] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
        expect(approval.arguments.command).toBe(command);
        await replyApproval(stack.harness, id, approval.key, 'reject'); await other.wait(context);
      }
      await revokePermissionRules(stack.harness, id, rules[0].id);
      expect(await replySimilarApproval(stack.harness, id, pending.key, future)).toBe(true);
      expect(await listPermissionRules(stack.harness, id)).toHaveLength(0);
    } finally { await stack.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 20000);

  test('authenticated routes preview unsupported, validate edited command, list/delete; rejection wins race', async () => {
    const dir = temp(); const stack = await setup(dir); const token = 'permission-rules-test-secret';
    const server = startHearthServer({ config: hearthConfig({ home: dir, port: 0, workspace: dir }), token, storage: stack.storage, harness: stack.harness, models: stack.models,
      defaultAgent: { model: { provider: 'faux', modelId: 'faux-1' } }, store: new FileCredentialStore(join(dir, 'auth.json')) });
    const request = (path: string, method = 'GET', body?: unknown, auth = true) => fetch(`${server.url}${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      const conversation = await stack.create(); const id = conversation.id;
      for (const [path, method] of [[`/conversations/${id}/permission-rules`, 'GET'], [`/conversations/${id}/permission-rules`, 'DELETE'], [`/approvals/${id}/x/preview`, 'POST']]) expect((await request(path, method, undefined, false)).status).toBe(401);
      stack.faux.setResponses([call('bash', { command: 'pwd', timeout: 31 }), done()]);
      let submission = await conversation.submit({ type: 'input', content: 'long timeout' }, context);
      let [pending] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      expect((await (await request(`/approvals/${id}/${pending.key}/preview`, 'POST', {})).json() as { supported: boolean }).supported).toBe(false);
      expect((await request(`/approvals/${id}/${pending.key}/reply`, 'POST', { decision: 'similar' })).status).toBe(400);
      await replyApproval(stack.harness, id, pending.key, 'reject'); await submission.wait(context);
      stack.faux.setResponses([call('bash', { command: 'ls -l' }), done()]);
      submission = await conversation.submit({ type: 'input', content: 'rule' }, context);
      [pending] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      expect((await request(`/approvals/${id}/${pending.key}/reply`, 'POST', { decision: 'similar', command: 'ls -la;pwd' })).status).toBe(400);
      expect((await request(`/approvals/${id}/${pending.key}/reply`, 'POST', { decision: 'similar', command: 'ls -la' })).status).toBe(200);
      await submission.wait(context);
      const listed = await (await request(`/conversations/${id}/permission-rules`)).json() as { rules: { id: string; argv: string[] }[] };
      expect(listed.rules).toHaveLength(1); expect(listed.rules[0].argv).toEqual(['ls', '-la']);
      expect((await request(`/conversations/${id}/permission-rules/${listed.rules[0].id}`, 'DELETE')).status).toBe(200);
      expect((await request(`/conversations/${id}/permission-rules`, 'DELETE')).status).toBe(200);
      stack.faux.setResponses([call('bash', { command: 'pwd' }), done()]);
      submission = await conversation.submit({ type: 'input', content: 'race' }, context);
      [pending] = await poll(() => pendingApprovals(stack.harness, [id]), (p) => p.length === 1);
      await replyApproval(stack.harness, id, pending.key, 'reject');
      expect((await request(`/approvals/${id}/${pending.key}/reply`, 'POST', { decision: 'similar' })).status).toBe(400);
      expect(await listPermissionRules(stack.harness, id)).toHaveLength(0); await submission.wait(context);
      const doc = await stack.harness.snapshot(ApprovalsDoc, id, context); expect(doc?.items[pending.key].status).toBe('reject');
      expect((await stack.harness.snapshot(PermissionRulesDoc, id, context))?.rules ?? []).toHaveLength(0);
    } finally { await server.close(); await stack.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});
