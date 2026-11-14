import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  wrapTool,
  type ConversationId,
  type Harness,
  type JsonObject,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createViewTool } from "./view";
import { withAbortRace } from "./interrupt";
import { createHash } from "node:crypto";
import { PermissionRulesDoc, storedRules, permissionHostCapability, bindingForCall, bindPermission, samePermission, validBinding, publicPolicy, publicRule, executePermission, ruleFor, type BoundPermission, type PermissionPreview } from "./permissionRules";

export type ApprovalDecision = "once" | "always" | "reject" | "similar";
export type ApprovalStatus = "pending" | ApprovalDecision;

/** One parked approval request, keyed by the calling tool task's id (a stable string). */
export type ApprovalRequest = {
  conversationId: string;
  /** The tool task id, as a string; a crash rerun finds the same parked request under it. */
  key: string;
  callId: string;
  tool: string;
  arguments: JsonObject;
  status: ApprovalStatus;
  permissionBinding?: BoundPermission;
  permissionRuleId?: string;
  /** Exact future command saved by a similar reply; distinct from the original once approval. */
  permissionSavedCommand?: string;
};

export type ApprovalsState = { items: Record<string, ApprovalRequest> };

/** One conversation's approval requests. */
export const ApprovalsDoc = defineDoc<ApprovalsState>({
  kind: "hearth.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: () => true,
});

/** Server-side auto-accept ("YOLO"): consulted by the gate, so it holds while Ember is closed. */
export const AutoAcceptDoc = defineDoc<{ enabled: boolean; allowed: string[] }>({
  kind: "hearth.auto-accept",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ enabled: false, allowed: [] }),
  checkpointWhen: () => true,
});

const POLL_MS = 200;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The gate: park the request durably, then wait for the human (or auto-accept) to answer.
 * Parking is idempotent per tool task id, so a crash rerun resumes the same wait instead of
 * duplicating the request, and the decision — a document — survives restarts.
 */
const gateTool = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api: ToolExecutionApi, context: Context) => {
    const key = String(api.taskId);
    const binding = tool.name === "bash" ? bindingForCall(args, api) : undefined;
    // A fresh read at admission, never a cached rule list. Forks/workers start with an empty doc.
    const prior = (await api.snapshot(ApprovalsDoc, api.conversationId, context))?.items[key];
    if (prior?.status === "similar" && prior.permissionBinding && prior.permissionRuleId) {
      if (!binding || !samePermission(binding, prior.permissionBinding)) throw new Error("Kiln cannot verify this command’s current execution environment. Request a new approval.");
      return executePermission(prior.permissionBinding, args, api, context, prior.permissionRuleId, true);
    }

    const decide = (
      status: ApprovalStatus | undefined,
      auto: { enabled: boolean; allowed: string[] } | null | undefined
    ): ApprovalDecision | "auto" | undefined => {
      if (status === "once" || status === "always" || status === "similar") return status;
      if (status === "reject") return "reject";
      if (auto?.enabled || auto?.allowed.includes(tool.name)) return "auto";
      return undefined;
    };

    let decision = decide(
      (await api.snapshot(ApprovalsDoc, api.conversationId, context))?.items[key]?.status,
      await api.snapshot(AutoAcceptDoc, api.conversationId, context)
    );
    // Existing once/always/YOLO decisions retain their original execution semantics.
    if (decision === undefined && binding) {
      const rule = ruleFor((await api.snapshot(PermissionRulesDoc, api.conversationId, context))?.rules ?? [], binding, api.conversationId);
      if (rule) return executePermission(binding, args, api, context, rule.id);
    }
    if (decision === undefined) {
      await api.commit(async (tx) => {
        const doc = await tx.doc(ApprovalsDoc, api.conversationId);
        doc.items[key] ??= {
          conversationId: String(api.conversationId),
          key,
          callId: String(api.callId),
          tool: tool.name,
          arguments: (args ?? {}) as JsonObject,
          status: "pending",
          ...(binding ? { permissionBinding: binding } : {}),
        };
      }, context);
      for (;;) {
        // A stopped run must not leave the gate waiting forever: `Conversation.abort()` marks this
        // task and its context signal fires, so without this check a parked approval deadlocks stop.
        if (context.abortSignal?.aborted) {
          return {
            output: [{ type: "text", text: "The agent was stopped before this tool ran." }],
            isError: true,
          };
        }
        let parked: ApprovalRequest | undefined;
        // Re-read auto-accept every tick, not once before parking: turning YOLO on has to release an
        // already-parked request, otherwise it waits for a reply the user no longer expects to give.
        let auto: { enabled: boolean; allowed: string[] } | null | undefined;
        try {
          parked = (await api.snapshot(ApprovalsDoc, api.conversationId, context))?.items[key];
          auto = await api.snapshot(AutoAcceptDoc, api.conversationId, context);
        } catch {
          parked = undefined; // the context was aborted mid-read
          auto = undefined;
        }
        decision = decide(parked?.status, auto);
        if (decision !== undefined) break;
        await sleep(POLL_MS);
      }
      // Resolved by auto-accept while parked (the user turned YOLO on after it parked): drop the
      // request so it stops counting as pending — the client polls `/approvals` and would otherwise
      // keep showing a card for a tool that already ran.
      if (decision === "auto") {
        await api.commit(async (tx) => {
          const doc = await tx.doc(ApprovalsDoc, api.conversationId);
          delete doc.items[key];
        }, context);
      }
    }

    if (decision === "similar") {
      const item = (await api.snapshot(ApprovalsDoc, api.conversationId, context))?.items[key];
      if (!item?.permissionBinding || !item.permissionRuleId || !binding || !samePermission(binding, item.permissionBinding)) throw new Error("Kiln cannot verify this approval. Ask for approval again.");
      return executePermission(item.permissionBinding, args, api, context, item.permissionRuleId, true);
    }
    if (decision === "reject") {
      return {
        output: [{ type: "text", text: "The user rejected this tool call." }],
        isError: true,
      };
    }
    if (decision === "always") {
      // "Always allow" turns on server-side auto-accept for the conversation — the previous
      // behaviour: every later tool runs without parking, not just this one.
      await api.commit(async (tx) => {
        (await tx.doc(AutoAcceptDoc, api.conversationId)).enabled = true;
      }, context);
    }
    return tool.execute(args, api, context);
  },
});

const gate = (tool: ToolRegistration) => wrapTool(withAbortRace(tool), gateTool);

/**
 * Gate every coding tool behind approval. Wraps match by tool name, wherever they come from.
 * Each tool is first made abort-interruptible (`withAbortRace`): a step that ignores the run's
 * cancellation can no longer pin `POST /abort`, so stopping is immediate.
 */
export const Approvals = defineExtension({
  name: "approvals",
  wraps: [gate(createReadTool()), gate(createViewTool()), gate(createWriteTool()), gate(createEditTool()), gate(createBashTool())],
});

// ---- Wire helpers -------------------------------------------------------------------

/** The reads and the commit a caller needs: a `Harness`, or a tool's execution API. */
export type ApprovalHost = Pick<Harness, "snapshot" | "commit">;

/** Every pending approval among `conversationIds`, in list order. */
export const pendingApprovals = async (
  harness: ApprovalHost,
  conversationIds: readonly ConversationId[],
  context: Context = BACKGROUND_CONTEXT
): Promise<ApprovalRequest[]> => {
  const pending: ApprovalRequest[] = [];
  for (const id of conversationIds) {
    const doc = await harness.snapshot(ApprovalsDoc, id, context);
    if (!doc) continue;
    for (const item of Object.values(doc.items)) {
      if (item.status === "pending") pending.push(item);
    }
  }
  return pending;
};

/** Drop a conversation's pending approvals; used when the run is stopped so no card lingers. */
export const clearPendingApprovals = async (
  harness: ApprovalHost,
  conversationId: ConversationId,
  context: Context = BACKGROUND_CONTEXT
): Promise<void> => {
  const doc = await harness.snapshot(ApprovalsDoc, conversationId, context);
  if (!doc || !Object.values(doc.items).some((item) => item.status === "pending")) return;
  await harness.commit(async (tx) => {
    const live = await tx.doc(ApprovalsDoc, conversationId);
    for (const [key, item] of Object.entries(live.items)) {
      if (item.status === "pending") delete live.items[key];
    }
  }, context);
};

/** Record the human's decision; the gate observing the doc proceeds (or blocks). */
export const replyApproval = async (
  harness: Harness,
  conversationId: ConversationId,
  key: string,
  decision: ApprovalDecision,
  context: Context = BACKGROUND_CONTEXT
): Promise<boolean> => {
  let found = false;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ApprovalsDoc, conversationId);
    const item = doc.items[key];
    if (!item || item.status !== "pending" || decision === "similar") return;
    found = true;
    doc.items[key] = { ...item, status: decision };
  }, context);
  return found;
};

/** Set a conversation's server-side auto-accept. */
export const setAutoAccept = async (
  harness: ApprovalHost,
  conversationId: ConversationId,
  enabled: boolean,
  context: Context = BACKGROUND_CONTEXT
): Promise<void> => {
  await harness.commit(async (tx) => {
    (await tx.doc(AutoAcceptDoc, conversationId)).enabled = enabled;
  }, context);
};

/** Validate the original once approval and the separately editable exact future rule. */
export const previewPermission = async (harness: ApprovalHost, conversationId: ConversationId, key: string, command: unknown, context: Context = BACKGROUND_CONTEXT): Promise<PermissionPreview> => {
  const item = (await harness.snapshot(ApprovalsDoc, conversationId, context))?.items[key];
  const unsupported = (reason: string): PermissionPreview => ({ supported: false, reason });
  if (!item || item.status !== "pending") return unsupported("Kiln no longer has this approval waiting. Refresh the conversation.");
  const capability = permissionHostCapability(harness);
  if (!capability) return unsupported("Kiln has not enabled verified direct command execution on this host. Use Allow once.");
  if (capability.scopeRequired) return unsupported("Kiln runs commands in a managed host scope here. Remembered direct commands cannot preserve that scope yet; use Allow once.");
  const binding = item.permissionBinding;
  if (item.tool !== "bash" || !binding) return unsupported("Kiln supports only exact simple pwd, ls and wc commands on Linux. Shell syntax, Git and code runners such as bun test need Allow each time; code runners execute arbitrary project code.");
  const agent = await harness.snapshot(AgentDoc, conversationId, context);
  const current = bindPermission(item.arguments.command, agent?.cwd ?? process.cwd(), capability.home);
  if (!current || !samePermission(binding, current) || !validBinding(binding)) return unsupported("Kiln found that the executable or folder changed. Use Allow once or request a new approval.");
  const timeout = item.arguments.timeout;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30)) return unsupported("Kiln limits remembered commands to 30 seconds. Use Allow once for this command.");
  const future = bindPermission(command === undefined ? item.arguments.command : command, binding.cwd, binding.executionHome);
  if (!future || future.cwd !== binding.cwd || future.cwdIdentity !== binding.cwdIdentity) return unsupported("Kiln cannot remember this edited command. Use only exact simple pwd, ls or wc arguments, without shell syntax, or use Allow once.");
  return { supported: true, reason: "Kiln will run the pending original once and remember only the displayed future argv in this conversation and folder, using a clean environment without a shell. This is permission reuse, not a safety guarantee.", policy: publicPolicy(future) };
};

const sameSavedCommand = (item: ApprovalRequest, command: unknown): boolean =>
  (command === undefined ? item.arguments.command : command) === (item.permissionSavedCommand ?? item.arguments.command);

export const replySimilarApproval = async (harness: ApprovalHost, conversationId: ConversationId, key: string, command: unknown, context: Context = BACKGROUND_CONTEXT): Promise<boolean> => {
  // Repeated identical replies are successful, but must never resurrect a revoked rule.
  const prior = (await harness.snapshot(ApprovalsDoc, conversationId, context))?.items[key];
  if (prior?.status === "similar" && sameSavedCommand(prior, command)) return true;
  const preview = await previewPermission(harness, conversationId, key, command, context);
  if (!preview.supported) {
    // Another identical reply may have committed between our first read and preview.
    const latest = (await harness.snapshot(ApprovalsDoc, conversationId, context))?.items[key];
    if (latest?.status === "similar" && sameSavedCommand(latest, command)) return true;
    throw new Error(preview.reason);
  }
  const capability = permissionHostCapability(harness);
  const reviewedFuture = capability && preview.policy ? bindPermission(preview.policy.argv.join(' '), preview.policy.cwd, capability.home) : undefined;
  if (!reviewedFuture || !preview.policy || JSON.stringify(publicPolicy(reviewedFuture)) !== JSON.stringify(preview.policy)) throw new Error("Kiln found that the future command changed. Preview it again before saving.");
  let found = false;
  await harness.commit(async (tx) => {
    const approvals = await tx.doc(ApprovalsDoc, conversationId);
    const item = approvals.items[key];
    if (item?.status === "similar" && sameSavedCommand(item, command)) { found = true; return; }
    if (!item || item.status !== "pending" || !item.permissionBinding || !validBinding(item.permissionBinding)) return;
    const agent = await tx.doc(AgentDoc, conversationId);
    const capability = permissionHostCapability(harness);
    if (!capability || capability.scopeRequired) return;
    const current = bindPermission(item.arguments.command, agent.cwd ?? process.cwd(), capability.home);
    if (!current || !samePermission(item.permissionBinding, current)) return;
    const futureCommand = command === undefined ? item.arguments.command : command;
    const future = bindPermission(futureCommand, item.permissionBinding.cwd, item.permissionBinding.executionHome);
    if (!future || !samePermission(reviewedFuture, future) || future.cwd !== current.cwd || future.cwdIdentity !== current.cwdIdentity) return;
    const id = createHash("sha256").update(JSON.stringify([String(conversationId), key, future])).digest("hex").slice(0, 32);
    const rules = await tx.doc(PermissionRulesDoc, conversationId);
    rules.rules = storedRules(rules.rules);
    const existing = ruleFor(rules.rules, future, conversationId);
    if (!existing) rules.rules.push({ ...future, id, conversationId: String(conversationId), createdAt: Date.now() });
    item.status = "similar";
    item.permissionRuleId = existing?.id ?? id;
    item.permissionSavedCommand = future.argv.join(' ');
    found = true;
  }, context);
  return found;
};

export const listPermissionRules = async (harness: ApprovalHost, conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) =>
  storedRules((await harness.snapshot(PermissionRulesDoc, conversationId, context))?.rules).filter((rule) => rule.conversationId === String(conversationId)).map(publicRule);
export const revokePermissionRules = async (harness: ApprovalHost, conversationId: ConversationId, ruleId?: string, context: Context = BACKGROUND_CONTEXT): Promise<void> => {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PermissionRulesDoc, conversationId);
    doc.rules = ruleId === undefined ? [] : storedRules(doc.rules).filter((rule) => rule.id !== ruleId);
  }, context);
};
