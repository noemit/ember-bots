import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineDoc, type ConversationId, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { Context } from '@earendil-works/chord';
import { sessionEnv } from './scratch';

/** Only host construction can attest accounting requirements; never inferred from private fields. */
type PermissionCapability = { home: string; scopeRequired: boolean };
const permissionEnvironments = new WeakMap<NodeExecutionEnv, PermissionCapability>();
const permissionHosts = new WeakMap<object, PermissionCapability>();
export const attestPermissionHost = (host: object, options: PermissionCapability): void => { permissionHosts.set(host, { ...options }); };
export const permissionHostCapability = (host: object): PermissionCapability | undefined => permissionHosts.get(host);
export const attestPermissionEnvironment = (env: NodeExecutionEnv, options: { home: string; scopeRequired: boolean }): NodeExecutionEnv => {
  permissionEnvironments.set(env, { ...options });
  return env;
};

export type PermissionPolicy = { kind: 'exact-argv-v1'; maxTimeoutSeconds: 30; argv: string[]; cwd: string; executable: string; environment: 'clean-v1' };
export type PermissionPreview = { supported: boolean; reason: string; policy?: PermissionPolicy };
export type PermissionRule = PermissionPolicy & { id: string; conversationId: string; createdAt: number };
type Identity = { cwdIdentity: string; executableIdentity: string; executionHome: string };
export type BoundPermission = PermissionPolicy & Identity;
export type StoredPermissionRule = PermissionRule & Identity;
export const PermissionRulesDoc = defineDoc<{ rules: StoredPermissionRule[] }>({
  kind: 'hearth.permission-rules', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ rules: [] }), checkpointWhen: () => true,
});
const identity = (path: string): string => {
  const s = statSync(path);
  return `${s.dev}:${s.ino}`;
};

/** A recognizer, NOT a shell parser. Nothing here evaluates or launches a command. */
export const permissionArgv = (command: unknown): string[] | undefined => {
  if (typeof command !== 'string' || command.length > 2048 || !/^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/.test(command)) return;
  const argv = command.split(' ');
  const [program, ...args] = argv;
  if (program === 'pwd') return args.length === 0 || (args.length === 1 && args[0] === '-P') ? argv : undefined;
  const flags = program === 'ls' ? ['-a', '-l', '-la', '-al', '-1'] : program === 'wc' ? ['-l', '-w', '-c'] : undefined;
  if (!flags || args.length > 32) return;
  if (args.some((arg) => arg.startsWith('-') && !flags.includes(arg))) return;
  return argv;
};

/** Only trusted system binaries: never PATH, cwd programs, scripts, or user-writable ancestors. */
const executableBinding = (program: string): { executable: string; executableIdentity: string } => {
  const executable = realpathSync(`/usr/bin/${program}`);
  let path = executable;
  for (;;) {
    const s = statSync(path);
    if (s.uid !== 0 || (s.mode & 0o022) !== 0) throw new Error('System executable is writable outside the administrator account.');
    if (path === '/') break;
    path = dirname(path);
  }
  const s = statSync(executable);
  if (!s.isFile() || (s.mode & 0o111) === 0) throw new Error('System executable is unavailable.');
  const bytes = readFileSync(executable);
  // Linux ELF only; reject scripts even in a trusted directory.
  if (bytes[0] !== 0x7f || bytes.subarray(1, 4).toString() !== 'ELF') throw new Error('Only system ELF executables are supported.');
  return { executable, executableIdentity: `${identity(executable)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${createHash('sha256').update(bytes).digest('hex')}` };
};
export const bindPermission = (command: unknown, cwd: string, home = cwd): BoundPermission | undefined => {
  if (process.platform !== 'linux') return;
  const argv = permissionArgv(command);
  if (!argv) return;
  try {
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) return;
    // Linux hosts without procfs cannot offer the pinned-cwd execution contract.
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (identity('/proc/' + process.pid + '/fd/' + fd) !== identity(canonical)) return;
    } finally { closeSync(fd); }
    return { kind: 'exact-argv-v1', maxTimeoutSeconds: 30, argv, cwd: canonical, cwdIdentity: identity(canonical), executionHome: realpathSync(home), ...executableBinding(argv[0]), environment: 'clean-v1' };
  } catch { return; }
};
export const isBoundPermission = (value: unknown): value is BoundPermission => {
  if (!value || typeof value !== 'object') return false;
  const v = value as BoundPermission;
  return v.kind === 'exact-argv-v1' && v.maxTimeoutSeconds === 30 && v.environment === 'clean-v1' &&
    typeof v.cwd === 'string' && typeof v.cwdIdentity === 'string' && typeof v.executionHome === 'string' && typeof v.executable === 'string' && typeof v.executableIdentity === 'string' &&
    Array.isArray(v.argv) && v.argv.every((part) => typeof part === 'string') && permissionArgv(v.argv.join(' ')) !== undefined;
};
export const samePermission = (a: BoundPermission, b: BoundPermission): boolean =>
  isBoundPermission(a) && isBoundPermission(b) && a.kind === b.kind && a.environment === b.environment && a.cwd === b.cwd && a.cwdIdentity === b.cwdIdentity && a.executionHome === b.executionHome &&
  a.executable === b.executable && a.executableIdentity === b.executableIdentity && JSON.stringify(a.argv) === JSON.stringify(b.argv);
export const publicPolicy = (bound: BoundPermission): PermissionPolicy => ({
  kind: bound.kind, maxTimeoutSeconds: 30, argv: bound.argv, cwd: bound.cwd, executable: bound.executable, environment: bound.environment,
});
export const publicRule = (rule: StoredPermissionRule): PermissionRule => ({ ...publicPolicy(rule), id: rule.id, conversationId: rule.conversationId, createdAt: rule.createdAt });
export const validBinding = (bound: BoundPermission): boolean => {
  if (!isBoundPermission(bound)) return false;
  const current = bindPermission(bound.argv.join(' '), bound.cwd, bound.executionHome);
  return current !== undefined && samePermission(bound, current);
};
export const bindingForCall = (args: unknown, api: ToolExecutionApi): BoundPermission | undefined => {
  // Unknown execution environments cannot attest a local cwd. Never trust caller-supplied cwd/env.
  if (!(api.env instanceof NodeExecutionEnv) || Object.getPrototypeOf(api.env) !== NodeExecutionEnv.prototype) return;
  const capability = permissionEnvironments.get(api.env);
  if (!capability || capability.scopeRequired) return;
  if (!args || typeof args !== 'object') return;
  const input = args as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'command' && key !== 'timeout')) return;
  if (input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 30)) return;
  return bindPermission(input.command, api.env.cwd, capability.home);
};

/** Direct argv, clean environment; no shell startup files/functions/PATH lookup. Pin cwd by fd. */
export const executePermission = async (bound: BoundPermission, args: unknown, api: ToolExecutionApi, context: Context, ruleId: string, originalApproval = false) => {
  if (!validBinding(bound)) throw new Error('Kiln found that the command or folder changed. Ask for approval again.');
  const fd = openSync(bound.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (`${s.dev}:${s.ino}` !== bound.cwdIdentity) throw new Error('Kiln found that the folder changed. Ask for approval again.');
    const timeout = (args as { timeout?: number }).timeout ?? 30;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30) throw new Error('Kiln limits remembered commands to 30 seconds. Use Allow for a longer command.');
    api.diagnostic({ severity: 'info', code: 'permission_rule', message: originalApproval
      ? `Original command allowed once while saving conversation permission rule ${ruleId}.`
      : `Allowed by conversation permission rule ${ruleId}.` });
    const managedEnv = sessionEnv(bound.executionHome, Number(api.conversationId));
    if (!managedEnv.TMPDIR) throw new Error('Kiln could not prepare this conversation’s temporary folder. Use Allow once or retry after the host folder is writable.');
    const env = new NodeExecutionEnv({ cwd: `/proc/${process.pid}/fd/${fd}` });
    const result = await env.exec([bound.executable, ...bound.argv.slice(1)], {
      inheritEnv: false, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...managedEnv },
      timeout, onOutput: (text, _context, info) => api.output(text, info.skipped),
      spill: { afterBytes: 50 * 1024, afterLines: 2000 },
      ...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
    }, context);
    if (!result.ok) throw result.error;
    const retained = api.retainedOutput();
    return { structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: result.value.exitCode,
      ...(result.value.spillPath ? { fullOutputPath: result.value.spillPath } : {}) },
      ...(result.value.exitCode ? { isError: true, diagnostics: [{ severity: 'error' as const, code: 'exit_code', message: `Command exited with code ${result.value.exitCode}` }] } : {}) };
  } finally { closeSync(fd); }
};

export const isStoredPermissionRule = (value: unknown): value is StoredPermissionRule => {
  if (!isBoundPermission(value)) return false;
  const rule = value as StoredPermissionRule;
  return typeof rule.id === 'string' && /^[a-f0-9]{32}$/.test(rule.id) && typeof rule.conversationId === 'string' &&
    /^[1-9][0-9]*$/.test(rule.conversationId) && typeof rule.createdAt === 'number' && Number.isFinite(rule.createdAt) && rule.createdAt > 0;
};
export const storedRules = (value: unknown): StoredPermissionRule[] => Array.isArray(value) ? value.filter(isStoredPermissionRule) : [];
export const ruleFor = (rules: StoredPermissionRule[], binding: BoundPermission, conversationId: ConversationId): StoredPermissionRule | undefined =>
  storedRules(rules).find((rule) => rule.conversationId === String(conversationId) && samePermission(rule, binding));
