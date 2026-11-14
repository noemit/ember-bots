import type { PermissionRequest } from '../types';

/** Policy is produced and enforced by Kiln, never inferred from command text in Ember. */
export type PermissionPolicy = { kind: 'exact-argv-v1'; maxTimeoutSeconds: 30; argv: string[]; cwd: string; executable: string; environment: 'clean-v1' };
export type PermissionRule = PermissionPolicy & { id: string; conversationId: string; createdAt: number };
export type PermissionRulePreview = { supported: boolean; reason: string; policy?: PermissionPolicy };
export const permissionRuleError = (status: number): string => status === 404 || status === 501
  ? 'This Kiln does not offer remembered permission rules. You can still Allow once, Deny, or switch to YOLO mode.'
  : 'Kiln could not update permission rules. Try again here, or cancel and use Allow once or Deny.';
async function request<T>(instanceId: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  let response;
  try { response = await window.ember.piRequest?.<T>(instanceId, path, { method, body }); }
  catch { throw new Error(permissionRuleError(0)); }
  if (!response?.ok) throw new Error(permissionRuleError(response?.status ?? 0));
  return response.data;
}
const rulesPath = (sessionId: string) => `/conversations/${encodeURIComponent(sessionId)}/permission-rules`;
const approvalPath = (approval: PermissionRequest) => {
  const key = approval.id.slice(approval.sessionId.length + 1);
  return `/approvals/${encodeURIComponent(approval.sessionId)}/${encodeURIComponent(key)}`;
};
function validPolicy(value: PermissionPolicy | undefined): boolean {
  return Boolean(value && value.kind === 'exact-argv-v1' && value.maxTimeoutSeconds === 30 && Array.isArray(value.argv) && value.argv.length && value.argv.every((arg) => typeof arg === 'string') && typeof value.cwd === 'string' && typeof value.executable === 'string' && value.environment === 'clean-v1');
}
export async function loadPermissionRules(instanceId: string, sessionId: string) {
  const result = await request<{ rules: PermissionRule[] }>(instanceId, rulesPath(sessionId));
  if (!result || !Array.isArray(result.rules) || !result.rules.every((rule) => validPolicy(rule) && typeof rule.id === 'string')) throw new Error(permissionRuleError(0));
  return result;
}
export async function previewPermissionRule(approval: PermissionRequest, command?: string) {
  const result = await request<PermissionRulePreview>(approval.instanceId, `${approvalPath(approval)}/preview`, 'POST', command === undefined ? {} : { command });
  if (!result || typeof result.supported !== 'boolean' || typeof result.reason !== 'string' || (result.supported && !validPolicy(result.policy))) throw new Error(permissionRuleError(0));
  return result;
}
async function mutation(instanceId: string, path: string, method: string, body?: unknown): Promise<void> {
  const result = await request<{ ok?: boolean }>(instanceId, path, method, body);
  if (result?.ok !== true) throw new Error(permissionRuleError(0));
}
export const savePermissionRule = (approval: PermissionRequest, command: string) => mutation(approval.instanceId, `${approvalPath(approval)}/reply`, 'POST', { decision: 'similar', command });
export const revokePermissionRule = (instanceId: string, sessionId: string, id?: string) => mutation(instanceId, `${rulesPath(sessionId)}${id ? `/${encodeURIComponent(id)}` : ''}`, 'DELETE');
export function approvalCommand(approval: PermissionRequest): string {
  const args = approval.metadata.arguments as Record<string, unknown> | undefined;
  return typeof args?.command === 'string' ? args.command : '';
}
