import { defineDoc, defineExtension, defineTask, GenerationTask, hook, runEndTask, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { currentContextOf } from "./currentContext";
import { MetaDoc } from "./meta";
import { SessionsDoc } from "./sessions";
import { threadTask } from "./threadResults";

export const WORKER_CONTEXT_LIMIT = 100_000;
export const WORKER_CONTEXT_ADVICE =
  "Kiln worker context policy: this worker has reached approximately 100k current-context tokens, not lifetime usage. " +
  "Finish the active bounded task; do not start substantial new assignments by default. Small completion work or an explicit human/leader override is allowed. " +
  "Never discard queued messages or leave an active task stranded: acknowledge new directions and explain any deferral. " +
  "Before finishing, write a concise handoff with progress, files, commits, tests, blockers and next steps (say none or not run when appropriate). " +
  "Recommend a fresh Sol/Luna worker to the leader; do not automatically spawn one or change models. This is advisory guidance, not a hard execution gate.";

export type WorkerContextState = {
  currentContextTokens?: number;
  currentContextEpoch?: string;
  recommendation?: "fresh-worker";
  handoff?: { answerEntryId: number; text: string; at: number };
};
export const WorkerContextDoc = defineDoc<WorkerContextState>({
  kind: "hearth.worker-context", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({}), checkpointWhen: () => true,
});

/** A generation child, not a polling loop or model call. Only durable metadata is written;
 * the existing supervisor admits notices after the leader's foreground and human inbox clear.
 */
export const WorkerContextTask = defineTask<{ answer: number; through: number; task: string }, { phase: "record" }, null>({
  name: "hearth.worker-context", version: 1, initial: () => ({ phase: "record" }),
  phases: {
    record: async (task, runtime, context) => {
      const view = await runtime.context(runtime.conversationId, context);
      const measured = currentContextOf(view);
      const answer = await runtime.entry(task.input.answer as EntryId, context);
      const text = (answer?.model ?? []).flatMap((message) => message.role === "assistant"
        ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n").slice(0, 6000);
      await runtime.commit(async (tx) => {
        const meta = await tx.doc(MetaDoc, runtime.conversationId);
        const head = await tx.latestHeadMarker(runtime.conversationId);
        const epoch = head ? String(head.id) : "initial";
        if (meta.kind === "worker" && epoch === measured.currentContextEpoch) {
          const doc = await tx.doc(WorkerContextDoc, runtime.conversationId);
          doc.currentContextTokens = measured.currentContextTokens;
          doc.currentContextEpoch = measured.currentContextEpoch;
          if (measured.currentContextTokens >= WORKER_CONTEXT_LIMIT) {
            doc.recommendation = "fresh-worker";
            doc.handoff = { answerEntryId: task.input.answer, text, at: runtime.now() };
          } else delete doc.recommendation;
          if (meta.lead?.host === "local") {
            const crew = await tx.doc(SessionsDoc, meta.lead.conversationId as ConversationId);
            const entry = Object.values(crew.items).find((item) => item.conversationId === runtime.conversationId);
            // A newly queued/reassigned task must not receive an advisory for the previous answer.
            if (entry && threadTask(entry) === task.input.task) {
              if (doc.recommendation) entry.contextAdvisory = {
                epoch: measured.currentContextEpoch, task: task.input.task,
                tokens: measured.currentContextTokens, answerEntryId: task.input.answer, throughEntryId: task.input.through,
              };
              else delete entry.contextAdvisory;
            }
          }
        }
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

export const WorkerContext = defineExtension({
  name: "worker-context",
  tasks: [WorkerContextTask],
  hooks: [hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const meta = await api.snapshot(MetaDoc, api.conversationId, context);
      if (meta?.kind !== "worker") return;
      if (meta.lead?.host === "local") {
        const crew = await api.snapshot(SessionsDoc, meta.lead.conversationId as ConversationId, context);
        const entry = Object.values(crew?.items ?? {}).find((item) => item.conversationId === api.conversationId);
        if (entry) await api.memo("worker-context-task", threadTask(entry), context);
      }
      if (estimateContextTokens(messages).tokens < WORKER_CONTEXT_LIMIT) return;
      return { messages: [...messages, { role: "user", content: WORKER_CONTEXT_ADVICE, timestamp: Date.now() }] };
    },
    afterRun: async (run, api, context) => {
      const meta = await api.snapshot(MetaDoc, api.conversationId, context);
      if (meta?.kind !== "worker" || meta.lead?.host !== "local") return;
      const task = await api.memo<string>("worker-context-task", context);
      if (!task) return;
      return { tasks: [runEndTask(WorkerContextTask, { answer: Number(run.answer), through: Number(run.last), task })] };
    },
  })],
});
