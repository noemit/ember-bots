import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import {
  defineDoc,
  defineTool,
  type ConversationId,
  type Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

export type QuestionStatus = "pending" | "answered" | "cancelled";

/** One parked question, keyed by the asking tool task's id (a stable string). */
export type ParkedQuestion = {
  conversationId: string;
  key: string;
  question: string;
  options: string[];
  status: QuestionStatus;
  answer?: string;
};

export type QuestionsState = { items: Record<string, ParkedQuestion> };

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
    "Ask the user a question and wait for their answer. Use this whenever you need a decision or clarification from the human; do not guess.",
  parameters: obj({
    question: str({ description: "The question to ask, one sentence." }),
    options: opt(
      arr(str(), {
        description: "Answer options the user can pick from, when the question has a fixed set.",
      })
    ),
  }),
  replay: "safe",
  execute: async (args, api: ToolExecutionApi, context: Context) => {
    const key = String(api.taskId);
    await api.commit(async (tx) => {
      const doc = await tx.doc(QuestionsDoc, api.conversationId);
      doc.items[key] ??= {
        conversationId: String(api.conversationId),
        key,
        question: args.question,
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
      if (item.status === "pending") pending.push(item);
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
  if (!doc || !Object.values(doc.items).some((item) => item.status === "pending")) return;
  await harness.commit(async (tx) => {
    const live = await tx.doc(QuestionsDoc, conversationId);
    for (const [key, item] of Object.entries(live.items)) {
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
    if (!item || item.status !== "pending") return;
    found = true;
    doc.items[key] =
      answer === null ? { ...item, status: "cancelled" } : { ...item, status: "answered", answer };
  }, context);
  return found;
};
