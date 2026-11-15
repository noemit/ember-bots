import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import { InboxDoc, LiveDoc, type ConversationId, type TaskId, type EntryId, type Harness, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable';
import { QuestionsDoc, type ParkedQuestion, type QuestionHost, type QuestionOrigin, type QuestionsState } from './ask';
import { MetaDoc } from './meta';
import { explicitDone, explicitSettled, SessionsDoc, type CrewEntry } from './sessions';

const assignment = (entry: CrewEntry): string => `${entry.conversationId}:${entry.taskAt ?? entry.spawnedAt}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validMutation = (revision: number, requestId: string): boolean => Number.isSafeInteger(revision) && revision >= 1 && typeof requestId === 'string' && Boolean(requestId.trim()) && requestId.length <= 200;
export type QuestionResult = { ok: boolean; question?: ParkedQuestion; error?: string };
const replayOperation = (doc: QuestionsState, key: string, requestId: string, action: string, revision: number, answer?: string): QuestionResult | undefined => {
  const old = doc.operations?.[JSON.stringify([key, requestId])];
  if (!old) return undefined;
  return old.action === action && old.revision === revision && old.answer === answer ? { ok: true, question: clone(old.question) } : { ok: false, error: 'conflict' };
};
const receiptOperation = (doc: QuestionsState, question: ParkedQuestion, requestId: string, action: string, revision: number, answer?: string): QuestionResult => {
  const result = clone(question);
  doc.operations ??= {};
  doc.operations[JSON.stringify([question.key, requestId])] = { key: question.key, action, revision, ...(answer === undefined ? {} : { answer }), question: result };
  return { ok: true, question: result };
};


/** Follow durable tool-task provenance, including nested codemode calls. Never parse model prose
 * or guess that a task id is a transcript entry. Old questions without this evidence stay unlinked. */
const sourceMessageIn = async (tx: Tx, id: ConversationId, toolTaskId: string): Promise<string | undefined> => {
  let taskId = Number(toolTaskId);
  const seen = new Set<number>();
  for (let depth = 0; depth < 32 && Number.isSafeInteger(taskId) && taskId > 0 && !seen.has(taskId); depth++) {
    seen.add(taskId);
    const task = await tx.task(taskId as TaskId);
    if (!task || task.conversationId !== id || task.kind !== 'pi.tool') return;
    const input = task.input as { kind?: unknown; assistant?: unknown; parent?: unknown };
    if (input.kind === 'model' && typeof input.assistant === 'number' && Number.isSafeInteger(input.assistant)) {
      const entry = await tx.entry(input.assistant as EntryId);
      return entry?.conversationId === id && entry.kind === 'pi.assistant' ? `e${entry.id}` : undefined;
    }
    if (input.kind !== 'nested' || typeof input.parent !== 'number') return;
    taskId = input.parent;
  }
};

/** Resolve actual creator/task ownership, not supervisory aliases. */
const originIn = async (tx: Tx, id: ConversationId, toolTaskId: string): Promise<QuestionOrigin> => {
  const sourceMessageId = await sourceMessageIn(tx, id, toolTaskId);
  const origin: QuestionOrigin = { conversationId: String(id), toolTaskId, ...(sourceMessageId ? { sourceMessageId } : {}) };
  const meta = await tx.doc(MetaDoc, id);
  origin.kind = meta.kind === 'worker' ? 'worker' : 'root';
  if (origin.kind === 'worker') origin.assignmentMissing = true;
  if (meta.kind !== 'worker' || meta.lead?.host !== 'local') return origin;
  const requester = (meta.creatorId ?? meta.lead.conversationId) as ConversationId;
  origin.taskOwnerId = String(requester); origin.supervisorId = String(meta.lead.conversationId);
  // Ownership aliases are independent of supervision depth. Follow references to the actual
  // task document rather than assuming either requester or supervisory lead stores its state.
  for (const initial of new Set([requester, meta.lead.conversationId as ConversationId])) {
    let owner = initial;
    let member = Object.entries((await tx.doc(SessionsDoc, owner)).items).find(([, e]) => e.conversationId === id);
    const seen = new Set<string>();
    while (member && member[1].conversationId === id) {
      const token = JSON.stringify([owner, member[0]]);
      if (seen.has(token)) break;
      seen.add(token);
      const ref = member[1].taskOwner;
      if (!ref) return { ...origin, assignmentMissing: false, taskOwnerId: String(owner), taskKey: member[0], assignmentVersion: assignment(member[1]) };
      owner = ref.conversationId;
      const actual = (await tx.doc(SessionsDoc, owner)).items[ref.key];
      member = actual ? [ref.key, actual] : undefined;
    }
  }
  return origin;
};

export const createQuestion = async (
  api: ToolExecutionApi,
  args: { question?: string; options?: string[]; decision?: string; context?: string; recommendation?: string; source?: string; freeText?: boolean; supersedes?: string; revision?: number },
  context: Context
): Promise<ParkedQuestion> => api.commit(async (tx) => {
  for (const value of [args.question, args.decision, args.context, args.recommendation, args.source]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 16000)) throw new Error('Question fields must be text up to 16,000 characters. Shorten the question and try again.');
  }
  if (!args.question?.trim()) throw new Error('Write a question before creating it.');
  if (args.options && (args.options.length > 50 || args.options.some(value => typeof value !== 'string' || value.length > 2000))) throw new Error('Use at most 50 answer options, each up to 2,000 characters.');
  const key = String(api.taskId);
  const doc = await tx.doc(QuestionsDoc, api.conversationId);
  // Reuse the original item on replay. AskTool emits an immutable ID-only creation receipt,
  // never this item's potentially newer answer.
  if (doc.items[key]) return clone(doc.items[key]);
  const origin = await originIn(tx, api.conversationId, key);
  const previous = args.supersedes === undefined ? undefined : doc.items[args.supersedes];
  if (args.supersedes !== undefined && (!previous || previous.mode !== 'async' || previous.status !== 'pending' || previous.revision !== args.revision)) {
    throw new Error('The question changed. List questions and review its current revision before superseding it.');
  }
  const now = Date.now();
  const item: ParkedQuestion = {
    conversationId: String(api.conversationId), key, question: args.question!, options: args.options ?? [],
    mode: 'async', status: 'pending', revision: 1, createdAt: now, updatedAt: now, origin,
    freeText: args.freeText ?? true,
    ...(args.decision === undefined ? {} : { decision: args.decision }),
    ...(args.context === undefined ? {} : { context: args.context }),
    ...(args.recommendation === undefined ? {} : { recommendation: args.recommendation }),
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
  };
  if (previous && (previous.origin?.assignmentMissing || origin.assignmentMissing || previous.origin?.assignmentVersion !== origin.assignmentVersion)) throw new Error('This question belongs to a different assignment. Ask the human to review or withdraw it.');
  if (previous) { previous.status = 'superseded'; previous.supersededBy = key; previous.revision!++; previous.updatedAt = now; }
  doc.items[key] = item;
  return clone(item);
}, context);

/** Reconcile the SDK record, not the admission receipt. A terminal input without an entry
 * was never placed. Its requestId is permanently consumed in the SDK and must not be reused.
 * Missing evidence is unknown, never proof of either placement or safe automatic retry.
 */
const reconcileDeliveryIn = async (tx: Tx, id: ConversationId, q: ParkedQuestion): Promise<void> => {
  if (q.mode !== 'async' || q.status !== 'answered' || q.delivery?.status !== 'admitted') return;
  const delivery = q.delivery;
  const before = JSON.stringify(delivery);
  const record = await tx.submissionByRequest(id, delivery.requestId);
  if (record?.type === 'input' && record.entry !== undefined) {
    delivery.placement = 'placed'; delivery.entryId = Number(record.entry); delivery.sdkStatus = record.status;
  } else if (record?.type === 'input' && record.status === 'queued') {
    delivery.placement = 'queued'; delivery.sdkStatus = record.status; delete delivery.entryId;
  } else {
    delivery.status = 'held'; delivery.placement = record?.type === 'input' && record.status === 'unanswered' ? 'unplaced' : 'unknown';
    delete delivery.entryId;
    if (record) delivery.sdkStatus = record.status; else delete delivery.sdkStatus;
    if (record?.status === 'unanswered') delivery.failureReason = record.reason;
    delivery.holdReason = delivery.placement === 'unplaced'
      ? 'Kiln stopped delivery before placing this answer in the conversation. Open the source chat to review how to continue; the answer stays here.'
      : 'Kiln cannot verify where this admission landed. The answer is held for human review; do not resend it without resolving the missing submission evidence.';
    q.resumeRequired = true;
    if (q.mutation?.action === 'resume') delete q.mutation;
  }
  if (JSON.stringify(delivery) !== before) { q.updatedAt = Date.now(); q.revision = (q.revision ?? 1) + 1; }
};

export const reconcileQuestions = async (host: QuestionHost, id: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<void> => {
  const snapshot = await host.snapshot(QuestionsDoc, id, context);
  if (!Object.values(snapshot?.items ?? {}).some(q => q.mode === 'async' && q.status === 'answered' && q.delivery?.status === 'admitted')) return;
  await host.commit(async tx => {
    const doc = await tx.doc(QuestionsDoc, id);
    for (const q of Object.values(doc.items)) await reconcileDeliveryIn(tx, id, q);
  }, context);
};

/** Async history is independent of session-summary pagination; legacy remains pending-only. */
export const listQuestions = async (host: QuestionHost, ids: readonly ConversationId[], context: Context = BACKGROUND_CONTEXT): Promise<ParkedQuestion[]> => {
  const rows: ParkedQuestion[] = [];
  for (const id of ids) {
    await reconcileQuestions(host, id, context);
    const doc = await host.snapshot(QuestionsDoc, id, context);
    for (const item of Object.values(doc?.items ?? {})) {
      if (item.mode !== 'async') { if (item.status === 'pending') rows.push(item); continue; }
      const ancestry: Array<{ conversationId: string; title?: string }> = [];
      const seen = new Set<string>([String(id)]);
      let meta = await host.snapshot(MetaDoc, id, context);
      const sourceTitle = meta?.title;
      while (meta?.lead?.host === 'local' && !seen.has(String(meta.lead.conversationId))) {
        const parent = meta.lead.conversationId as ConversationId;
        seen.add(String(parent));
        meta = await host.snapshot(MetaDoc, parent, context);
        ancestry.push({ conversationId: String(parent), ...(meta?.title ? { title: meta.title } : {}) });
      }
      rows.push({ ...item, ancestry, ...(sourceTitle ? { sourceTitle } : {}) });
    }
  }
  return rows;
};

export const withdrawQuestion = async (host: QuestionHost, id: ConversationId, key: string, revision: number, requestId: string,
  context: Context = BACKGROUND_CONTEXT, actor: ConversationId | 'human' = 'human'): Promise<QuestionResult> => host.commit(async (tx) => {
  if (!validMutation(revision, requestId)) return { ok: false, error: 'invalid' };
  const doc = await tx.doc(QuestionsDoc, id);
  const item = doc.items[key];
  if (!item || item.mode !== 'async') return { ok: false, error: 'missing' };
  if (actor !== 'human') {
    const origin = await originIn(tx, actor, '');
    if (String(actor) !== item.origin?.conversationId || origin.assignmentMissing || item.origin?.assignmentMissing || origin.assignmentVersion !== item.origin?.assignmentVersion) return { ok: false, error: 'forbidden' };
  }
  const replay = replayOperation(doc, key, requestId, 'withdraw', revision); if (replay) return replay;
  if (item.status !== 'pending' || item.revision !== revision) return { ok: false, error: 'conflict' };
  item.status = 'withdrawn'; item.revision++; item.updatedAt = Date.now();
  item.mutation = { action: 'withdraw', requestId, revision };
  return receiptOperation(doc, item, requestId, 'withdraw', revision);
}, context);

export const answerQuestion = async (host: QuestionHost, id: ConversationId, key: string, answer: string, revision: number, requestId: string,
  context: Context = BACKGROUND_CONTEXT): Promise<QuestionResult> => host.commit(async (tx) => {
  if (!validMutation(revision, requestId)) return { ok: false, error: 'invalid' };
  const doc = await tx.doc(QuestionsDoc, id);
  const item = doc.items[key];
  if (!item || item.mode !== 'async') return { ok: false, error: 'missing' };
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 32000) return { ok: false, error: 'invalid' };
  const replay = replayOperation(doc, key, requestId, 'answer', revision, answer); if (replay) return replay;
  if (item.status !== 'pending' || item.revision !== revision) return { ok: false, error: 'conflict' };
  const now = Date.now();
  item.status = 'answered'; item.answer = answer; item.revision++; item.updatedAt = now;
  item.receipt = { requestId, answer, revision, at: now };
  item.delivery = { requestId: `hearth.question.answer:${id}:${key}:${requestId}`, status: 'held', holdReason: 'Waiting for the conversation and its human inbox to clear.' };
  return receiptOperation(doc, item, requestId, 'answer', revision, answer);
}, context);

/** Original answers are immutable. Every addition has its own admission and retry identity,
 * follows the original assignment boundary, and can never restart a stopped or settled worker. */
export const appendQuestionContext = async (host: QuestionHost, id: ConversationId, key: string, answer: string, revision: number, requestId: string,
  context: Context = BACKGROUND_CONTEXT): Promise<QuestionResult> => host.commit(async tx => {
  if (!validMutation(revision, requestId) || typeof answer !== 'string' || !answer.trim() || answer.length > 32000) return { ok: false, error: 'invalid' };
  const doc = await tx.doc(QuestionsDoc, id);
  const parent = doc.items[key];
  if (!parent || parent.mode !== 'async') return { ok: false, error: 'missing' };
  const replay = replayOperation(doc, key, requestId, 'context', revision, answer); if (replay) return replay;
  if (parent.replyTo || parent.status !== 'answered' || revision > (parent.revision ?? 1)) return { ok: false, error: 'conflict' };
  const previous = Object.values(doc.items).filter(item => item.replyTo === key);
  if (previous.length >= 100) return { ok: false, error: 'limit' };
  // Delivery receipts can advance the parent revision while the human writes. Appending never
  // overwrites the original answer, so concurrent additions need no parent-delivery CAS.
  const contextSequence = Math.max(0, ...previous.map(item => item.contextSequence ?? 0)) + 1;
  const now = Date.now();
  const childKey = `context:${JSON.stringify([key, requestId])}`;
  if (doc.items[childKey]) return { ok: false, error: 'conflict' };
  doc.items[childKey] = {
    conversationId: String(id), key: childKey, replyTo: key, contextSequence, question: parent.question, options: [], mode: 'async',
    status: 'answered', answer, revision: 1, createdAt: now, updatedAt: now, ...(parent.origin ? { origin: clone(parent.origin) } : {}),
    ...(parent.resumeRequired ? { resumeRequired: true } : {}),
    receipt: { requestId, answer, revision, at: now },
    delivery: { requestId: `hearth.question.context:${id}:${JSON.stringify([key, requestId])}`, status: 'held', holdReason: 'Waiting for the conversation and its human inbox to clear.' },
  };
  parent.revision = (parent.revision ?? 1) + 1; parent.updatedAt = now;
  return receiptOperation(doc, parent, requestId, 'context', revision, answer);
}, context);

/** Human resume never changes assignment, visibility or stop state. It only reconsiders delivery. */
export const authorizeQuestionResume = async (host: QuestionHost, id: ConversationId, key: string, revision: number, requestId: string,
  context: Context = BACKGROUND_CONTEXT): Promise<QuestionResult> => host.commit(async (tx) => {
  if (!validMutation(revision, requestId)) return { ok: false, error: 'invalid' };
  const doc = await tx.doc(QuestionsDoc, id); const item = doc.items[key];
  if (!item || item.mode !== 'async') return { ok: false, error: 'missing' };
  const replay = replayOperation(doc, key, requestId, 'resume', revision); if (replay) return replay;
  if (item.status !== 'answered' || item.revision !== revision || item.delivery?.status !== 'held') return { ok: false, error: 'conflict' };
  if (item.delivery.placement === 'unplaced') {
    // Confirm terminal, never-placed evidence again inside authorization. A new attempt is a
    // human decision, not a timer-based replay of an SDK terminal requestId.
    const previous = await tx.submissionByRequest(id, item.delivery.requestId);
    if (previous?.type !== 'input' || previous.status !== 'unanswered' || previous.entry !== undefined) return { ok: false, error: 'conflict' };
    item.deliveryAttempts ??= [];
    item.deliveryAttempts.push(clone(item.delivery));
    const attempt = item.deliveryAttempts.length;
    item.delivery = { requestId: `hearth.question.answer:${id}:${key}:${item.receipt!.requestId}:attempt:${attempt}`, attempt, status: 'held', placement: 'unknown', holdReason: 'Waiting for the conversation and its human inbox to clear.' };
  } else if ((item.delivery.submissionId !== undefined || item.delivery.admittedAt !== undefined) && item.delivery.placement === 'unknown') {
    return { ok: false, error: 'unknown-admission' };
  }
  item.mutation = { action: 'resume', requestId, revision }; item.revision++; item.updatedAt = Date.now();
  return receiptOperation(doc, item, requestId, 'resume', revision);
}, context);

/** One correlated idle turn, admitted together with its receipt. Never steer a running turn.
 * SDK admitSubmission reads tables (request dedup, boundary) before writing. Do ALL reads before
 * submit, and mutate documents only after it. No appendEntry/rearmWorker before admission.
 */
export const resumeQuestions = async (harness: Harness, id: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<number> => {
  await reconcileQuestions(harness, id, context);
  const snapshot = await harness.snapshot(QuestionsDoc, id, context);
  if (!Object.values(snapshot?.items ?? {}).some(q => q.mode === 'async' && (q.status === 'pending' || (q.status === 'answered' && q.delivery?.status === 'held')))) return 0;
  const conversation = await harness.conversation(id, context);
  let admitted = 0;
  // One admission per transaction: SDK disallows table reads after the first admission writes.
  for (const key of Object.keys(snapshot!.items)) {
    admitted += await harness.commit(async tx => {
      const doc = await tx.doc(QuestionsDoc, id); const q = doc.items[key];
      if (q?.mode !== 'async' || (q.status !== 'pending' && (q.status !== 'answered' || q.delivery?.status !== 'held'))) return 0;
      const meta = await tx.doc(MetaDoc, id);
      const live = await tx.doc(LiveDoc, id);
      const inbox = await tx.doc(InboxDoc, id);
      const origin = q.origin;
      const owner = origin?.taskOwnerId === undefined ? undefined : await tx.doc(SessionsDoc, Number(origin.taskOwnerId) as ConversationId);
      const entry = origin?.taskKey === undefined ? undefined : owner?.items[origin.taskKey];
      // Watermark read before submit; continuing a settled assignment preserves its prior result.
      const newest = await tx.latestEntryId(id);
      const unsafe = !conversation ? 'The origin conversation is missing.' : meta.archived ? 'The origin conversation is hidden. Restore the source chat to review how to continue; this answer stays held.' :
        meta.stoppedAt ? 'The origin conversation was stopped. Open the source chat to decide how to continue; this answer stays held.' :
        live.runFailure ? 'The origin conversation failed. Open the source chat to review the failure; this answer stays held.' :
        (origin?.kind === 'worker' || meta.kind === 'worker') && (origin?.assignmentMissing || !origin?.assignmentVersion || !entry) ? 'The origin worker assignment is missing. This answer remains here for human review.' :
        origin?.assignmentVersion !== undefined && (!entry || entry.taskOwner || assignment(entry) !== origin.assignmentVersion) ? 'The origin assignment changed. This answer remains here for human review.' :
        entry && explicitSettled(entry) ? (explicitDone(entry) ? 'The origin task is Done.' : 'The origin task has paused with unfinished work.') + ' Its coordinator or human must explicitly reopen it before this answer can continue work.' :
        entry && (entry.state === 'stopped' || entry.state === 'failed') ? 'The origin worker was stopped or failed. This answer remains here for human review.' :
        undefined;
      const hold = unsafe ?? (live.run || inbox.items.length ? 'Waiting for the conversation and its human inbox to clear.' : undefined);
      // Unsafe targets require a human resume even after visibility/failure is repaired.
      if (hold) {
        if (unsafe) { q.resumeRequired = true; if (q.mutation?.action === 'resume') delete q.mutation; }
        if (q.delivery) q.delivery.holdReason = hold;
        return 0;
      }
      if (q.status !== 'answered' || !q.receipt || !q.delivery) return 0;
      if (q.replyTo) {
        const parent = doc.items[q.replyTo];
        const earlier = Object.values(doc.items).filter(item => item.replyTo === q.replyTo && (item.contextSequence ?? 0) < (q.contextSequence ?? 0));
        if (!parent || [parent, ...earlier].some(item => item.status !== 'answered' || item.delivery?.status !== 'admitted')) {
          q.delivery.holdReason = 'An earlier answer or context message is held. Open the source chat to review how to continue.';
          return 0;
        }
      }
      if (q.resumeRequired && q.mutation?.action !== 'resume') return 0;
      // SDK requestId dedup checks only the submission TYPE. Do not let an unrelated input
      // occupying this ID become a false delivery receipt for the Question's answer.
      const prior = await tx.submissionByRequest(id, q.delivery.requestId);
      if (prior) {
        const placed = prior.type === 'input' && prior.entry !== undefined ? await tx.entry(prior.entry) : undefined;
        const data = placed?.data as { questionId?: unknown; origin?: { toolTaskId?: unknown }; receipt?: { requestId?: unknown; answer?: unknown; revision?: unknown } } | undefined;
        const matches = placed?.kind === 'hearth.question-answer' && data?.questionId === q.key && data.origin?.toolTaskId === q.origin?.toolTaskId &&
          data.receipt?.requestId === q.receipt.requestId && data.receipt.answer === q.receipt.answer && data.receipt.revision === q.receipt.revision;
        q.delivery.submissionId = String(prior.id); q.delivery.admittedAt ??= Date.now();
        if (matches) {
          q.delivery.status = 'admitted'; q.delivery.placement = 'placed'; q.delivery.entryId = Number(prior.entry); q.delivery.sdkStatus = prior.status;
        } else {
          q.delivery.placement = 'unknown'; q.delivery.holdReason = 'Kiln found conflicting or incomplete submission evidence for this answer. The answer is held for human review rather than resending it.';
          q.resumeRequired = true; if (q.mutation?.action === 'resume') delete q.mutation;
        }
        q.updatedAt = Date.now(); q.revision = (q.revision ?? 1) + 1;
        return 0;
      }
      const submission = await conversation!.submit(tx, {
        type: 'input', whenBusy: 'followUp', requestId: q.delivery.requestId,
        content: `${q.replyTo ? 'Additional human context for async question ' + q.replyTo : 'Human answer to async question ' + q.key}:\n${q.question}\n\n${q.receipt.answer}\n\nThis is a correlated Questions inbox answer, not a new task assignment. Continue the original task only where this answer applies.`,
        entry: { kind: 'hearth.question-answer', data: { internal: true, questionId: q.key, ...(q.replyTo ? { replyTo: q.replyTo } : {}), origin: q.origin ?? null, receipt: q.receipt } },
      });
      // Admitted is not a claim of execution or even human-visible placement.
      q.delivery = { requestId: q.delivery.requestId, ...(q.delivery.attempt === undefined ? {} : { attempt: q.delivery.attempt }), status: 'admitted', placement: 'unknown', admittedAt: Date.now(), submissionId: String(submission) };
      q.updatedAt = Date.now(); q.revision = (q.revision ?? 1) + 1;
      if (entry && entry.state === 'reported' && !explicitSettled(entry)) {
        entry.questionContinuations ??= [];
        entry.questionContinuations.push({ questionId: q.key, requestId: q.delivery.requestId, assignmentVersion: origin!.assignmentVersion!, at: Date.now(), ...(entry.report ? { priorReport: clone(entry.report) } : {}), ...(entry.silentReport ? { priorSilentReport: clone(entry.silentReport) } : {}) });
        entry.state = 'starting'; entry.answerFrom = newest; delete entry.followUpAt;
      }
      return 1;
    }, context);
  }
  return admitted;
};
