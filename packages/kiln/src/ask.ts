import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { arr, bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { createQuestion, listQuestions, withdrawQuestion } from "./questions";
import {
  defineDoc,
  defineTool,
  type ConversationId,
  type Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

export type QuestionStatus = "pending" | "answered" | "cancelled" | "withdrawn" | "superseded";
export type QuestionOrigin = { conversationId: string; toolTaskId: string; kind?: "root" | "worker"; assignmentMissing?: boolean; taskOwnerId?: string; taskKey?: string; assignmentVersion?: string; supervisorId?: string };
export type QuestionReceipt = { requestId: string; answer: string; at: number; revision: number };
/** Admission is not proof of placement, model execution, or human acknowledgement. */
export type QuestionDelivery = {
  requestId: string; status: "held" | "admitted"; holdReason?: string; admittedAt?: number; submissionId?: string;
  placement?: "unknown" | "queued" | "placed" | "unplaced";
  sdkStatus?: string; entryId?: number; failureReason?: string; attempt?: number;
};

/** One parked question, keyed by the asking tool task's id (a stable string). */
export type ParkedQuestion = {
  conversationId: string;
  key: string;
  question: string;
  options: string[];
  status: QuestionStatus;
  answer?: string;
  mode?: "async";
  resumeRequired?: boolean;
  decision?: string;
  context?: string;
  recommendation?: string;
  freeText?: boolean;
  source?: string;
  origin?: QuestionOrigin;
  ancestry?: Array<{ conversationId: string; title?: string }>;
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
  receipt?: QuestionReceipt;
  delivery?: QuestionDelivery;
  /** Immutable earlier admission identities, including confirmed withdrawals before placement. */
  deliveryAttempts?: QuestionDelivery[];
  supersedes?: string;
  supersededBy?: string;
  mutation?: { action: "withdraw" | "resume"; requestId: string; revision: number };

};

export type QuestionsState = {
  items: Record<string, ParkedQuestion>;
  /** Immutable response receipts; request IDs are payload-bound, unlike SDK submission dedup. */
  operations?: Record<string, { key: string; action: string; revision: number; answer?: string; question: ParkedQuestion }>;
};

export const QuestionsDoc = defineDoc<QuestionsState>({
  kind: "hearth.questions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: () => true,
});

const POLL_MS = 200;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The "ask" tool: parks a question for the human and waits for the answer, durably — a
 * crash rerun finds the same parked question and keeps waiting. This is where OpenCode's
 * forms map in the transition.
 */
export const AskTool = defineTool({
  name: "ask",
  description:
    "Use explicit action=create to put a decision in the human Questions inbox and return immediately with its stable ID, not an answer. Continue independent work. action=list lists your question history; action=withdraw withdraws your own question with key and revision. Missing action is the legacy blocking ask. Never infer an answer.",
  parameters: obj({
    action: opt(str({ description: "create, list, or withdraw. Omitted means legacy blocking ask." })),
    question: opt(str({ description: "The question to ask, one sentence." })),
    decision: opt(str()), context: opt(str()), recommendation: opt(str()),
    source: opt(str()), freeText: opt(bool()), key: opt(str()), revision: opt(num()), supersedes: opt(str()),
    options: opt(
      arr(str(), {
        description: "Answer options the user can pick from, when the question has a fixed set.",
      })
    ),
  }),
  replay: "safe",
  execute: async (args, api: ToolExecutionApi, context: Context) => {
    // Runtime dispatch matters: replayed/recovered arguments without action stay legacy.
    if (args.action === "list") return { output: [{ type: "text", text: JSON.stringify(await listQuestions(api, [api.conversationId], context)) }] };
    if (args.action === "withdraw") {
      const result = await withdrawQuestion(api, api.conversationId, args.key ?? "", args.revision ?? -1, String(api.taskId), context, api.conversationId);
      return { output: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok };
    }
    if (args.action === "create") {
      if (!args.question?.trim()) throw new Error("A question is required for action=create.");
      const result = await createQuestion(api, args, context);
      return { output: [{ type: "text", text: JSON.stringify({ id: result.key, key: result.key, conversationId: result.conversationId, revision: 1, created: true }) }] };
    }
    if (args.action !== undefined) throw new Error("Choose ask action=create, list, or withdraw.");
    if (!args.question?.trim()) throw new Error("A question is required.");
    const question = args.question;
    const key = String(api.taskId);
    await api.commit(async (tx) => {
      const doc = await tx.doc(QuestionsDoc, api.conversationId);
      doc.items[key] ??= {
        conversationId: String(api.conversationId),
        key,
        question,
        options: args.options ?? [],
        status: "pending",
      };
    }, context);
    for (;;) {
      // Stopping the agent marks this task and aborts its context; without this the question
      // would wait forever and the conversation abort could never complete.
      if (context.abortSignal?.aborted) {
        return {
          output: [{ type: "text", text: "The agent was stopped; this question was dismissed." }],
          isError: true,
        };
      }
      let parked: ParkedQuestion | undefined;
      try {
        parked = (await api.snapshot(QuestionsDoc, api.conversationId, context))?.items[key];
      } catch {
        parked = undefined; // the context was aborted mid-read
      }
      if (parked?.status === "answered") {
        return { output: [{ type: "text", text: `The user answered: ${parked.answer}` }] };
      }
      if (parked?.status === "cancelled") {
        return {
          output: [{ type: "text", text: "The user dismissed this question." }],
          isError: true,
        };
      }
      await sleep(POLL_MS);
    }
  },
});

/** The reads and the commit a caller needs: a `Harness`, or a tool's execution API. */
export type QuestionHost = Pick<Harness, "snapshot" | "commit">;

/** Every pending question among `conversationIds`, in list order. */
export const pendingQuestions = async (
  harness: QuestionHost,
  conversationIds: readonly ConversationId[],
  context: Context = BACKGROUND_CONTEXT
): Promise<ParkedQuestion[]> => {
  const pending: ParkedQuestion[] = [];
  for (const id of conversationIds) {
    const doc = await harness.snapshot(QuestionsDoc, id, context);
    if (!doc) continue;
    for (const item of Object.values(doc.items)) {
      if (item.status === "pending" && item.mode !== "async") pending.push(item);
    }
  }
  return pending;
};

/** Drop a conversation's pending questions; used when the run is stopped so no card lingers. */
export const clearPendingQuestions = async (
  harness: QuestionHost,
  conversationId: ConversationId,
  context: Context = BACKGROUND_CONTEXT
): Promise<void> => {
  const doc = await harness.snapshot(QuestionsDoc, conversationId, context);
  if (!doc) return;
  await harness.commit(async (tx) => {
    const live = await tx.doc(QuestionsDoc, conversationId);
    for (const [key, item] of Object.entries(live.items)) {
      if (item.mode === "async") continue;
      if (item.status === "pending") delete live.items[key];
    }
  }, context);
};

/** Answer (or dismiss) a parked question; the waiting tool returns the answer. */
export const replyQuestion = async (
  harness: Harness,
  conversationId: ConversationId,
  key: string,
  answer: string | null,
  context: Context = BACKGROUND_CONTEXT
): Promise<boolean> => {
  let found = false;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(QuestionsDoc, conversationId);
    const item = doc.items[key];
    if (!item || item.mode === "async" || item.status !== "pending") return;
    found = true;
    doc.items[key] =
      answer === null ? { ...item, status: "cancelled" } : { ...item, status: "answered", answer };
  }, context);
  return found;
};
