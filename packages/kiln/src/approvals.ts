import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
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

export type ApprovalDecision = "once" | "always" | "reject";
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

    const decide = (
      status: ApprovalStatus | undefined,
      auto: { enabled: boolean; allowed: string[] } | null | undefined
    ): ApprovalDecision | "auto" | undefined => {
      if (status === "once" || status === "always") return status;
      if (status === "reject") return "reject";
      if (auto?.enabled || auto?.allowed.includes(tool.name)) return "auto";
      return undefined;
    };

    let decision = decide(
      (await api.snapshot(ApprovalsDoc, api.conversationId, context))?.items[key]?.status,
      await api.snapshot(AutoAcceptDoc, api.conversationId, context)
    );
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
    if (!item || item.status !== "pending") return;
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
