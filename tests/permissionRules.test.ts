import { describe, expect, test } from 'bun:test';
import { approvalCommand, loadPermissionRules, permissionRuleError, previewPermissionRule, revokePermissionRule, savePermissionRule, type PermissionPolicy } from '../src/lib/permissionRules';
import type { PermissionRequest } from '../src/types';

const approval: PermissionRequest = { id: '12:approval/key', sessionId: '12', instanceId: 'pi:test', permission: 'bash', metadata: { arguments: { command: 'pwd' } }, patterns: [] };
const policy: PermissionPolicy = { kind: 'exact-argv-v1', maxTimeoutSeconds: 30, argv: ['pwd', '-P'], cwd: '/real/project', executable: '/usr/bin/pwd', environment: 'clean-v1' };

describe('remembered permission rule API', () => {
  test('sends only the reviewed exact command, preserving the host policy', async () => {
    const calls: Array<{ path: string; init: unknown }> = [];
    const previous = globalThis.window;
    globalThis.window = { ember: { piRequest: async (_id: string, path: string, init: unknown) => {
      calls.push({ path, init });
      return { ok: true, status: 200, data: path.endsWith('/preview') ? { supported: true, reason: 'Exact command', policy } : path.endsWith('/permission-rules') && (init as { method: string }).method === 'GET' ? { rules: [] } : { ok: true } };
    } } } as unknown as Window & typeof globalThis;
    try {
      expect(approvalCommand(approval)).toBe('pwd');
      const preview = await previewPermissionRule(approval, 'pwd -P');
      expect(preview.policy).toEqual(policy);
      await savePermissionRule(approval, 'pwd -P');
      await loadPermissionRules('pi:test', '12');
      await revokePermissionRule('pi:test', '12', 'rule/key');
      await revokePermissionRule('pi:test', '12');
      expect(calls).toEqual([
        { path: '/approvals/12/approval%2Fkey/preview', init: { method: 'POST', body: { command: 'pwd -P' } } },
        { path: '/approvals/12/approval%2Fkey/reply', init: { method: 'POST', body: { decision: 'similar', command: 'pwd -P' } } },
        { path: '/conversations/12/permission-rules', init: { method: 'GET', body: undefined } },
        { path: '/conversations/12/permission-rules/rule%2Fkey', init: { method: 'DELETE', body: undefined } },
        { path: '/conversations/12/permission-rules', init: { method: 'DELETE', body: undefined } },
      ]);
    } finally { globalThis.window = previous; }
  });
  test('mutation acknowledgements must explicitly confirm success', async () => {
    const previous = globalThis.window;
    let data: unknown;
    globalThis.window = { ember: { piRequest: async () => ({ ok: true, status: 200, data }) } } as unknown as Window & typeof globalThis;
    try {
      for (const payload of [{ ok: false }, {}, undefined, null]) {
        data = payload;
        await expect(savePermissionRule(approval, 'pwd -P')).rejects.toThrow(/Kiln.*Try again/);
        await expect(revokePermissionRule('pi:test', '12', 'rule')).rejects.toThrow(/Kiln.*Try again/);
        await expect(revokePermissionRule('pi:test', '12')).rejects.toThrow(/Kiln.*Try again/);
      }
    } finally { globalThis.window = previous; }
  });
  test('malformed policies and interrupted connections fail closed', async () => {
    const previous = globalThis.window;
    let data: unknown = { supported: true, reason: 'unsupported policy shape', policy: { kind: 'prefix' } };
    let interrupted = false;
    globalThis.window = { ember: { piRequest: async () => {
      if (interrupted) throw new Error('fetch failed');
      return { ok: true, status: 200, data };
    } } } as unknown as Window & typeof globalThis;
    try {
      await expect(previewPermissionRule(approval)).rejects.toThrow(/Kiln.*Try again/);
      data = { rules: [{ id: 'malformed' }] };
      await expect(loadPermissionRules('pi:test', '12')).rejects.toThrow(/Kiln.*Try again/);
      interrupted = true;
      await expect(savePermissionRule(approval, 'pwd')).rejects.toThrow(/Kiln.*Try again/);
    } finally { globalThis.window = previous; }
  });
  test('old hosts fail closed with an actor and recovery, never a dead-end code', async () => {
    const previous = globalThis.window;
    globalThis.window = { ember: { piRequest: async () => ({ ok: false, status: 404, data: {} }) } } as unknown as Window & typeof globalThis;
    try { await expect(previewPermissionRule(approval)).rejects.toThrow(/Kiln.*Allow once/); }
    finally { globalThis.window = previous; }
    for (const status of [0, 400, 404, 409, 500, 501]) {
      const copy = permissionRuleError(status);
      expect(copy).toMatch(/Kiln/);
      expect(copy).toMatch(/Allow once|Try again/);
      expect(copy).not.toMatch(/HTTP|undefined|null|stack|!/);
    }
  });
});
