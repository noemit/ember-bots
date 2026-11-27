import { randomUUID } from "node:crypto";
import {
  AgentDoc,
  configure,
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  type CompactionResult,
  type Conversation,
  type ConversationId,
  type EntryId,
  type InboxItem,
  type Submission,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import { AgentsDoc, DuplicateAgentError, promoteAgent, writeAgentsMirror } from "../../agents";
import { AutoAcceptDoc, setAutoAccept } from "../../approvals";
import { injectContextForInput } from "../../context";
import { markWorkerStopped } from "../../crew";
import { blindModelReason, contentPreviewOf, inputTextOf } from "../../images";
import { MetaDoc } from "../../meta";
import { parkInputs, parkedInputs, parkRequestId, reorderQueuedInputs } from "../../parking";
import {
  QueueConfigDoc,
  applyRunQueueConfigsInTx,
  effectiveSubmissionModel,
  removeQueueConfigInTx,
} from "../../queueConfig";
import {
  CREW_DEADLINE_MS,
  explicitSettled,
  isSpawnedWorkerInstructions,
  nextRoleIndex,
  pruneSpawns,
  rearmWorker,
  SessionsDoc,
  spawnSupervisor,
  WORKER_INSTRUCTIONS,
  workerAssignment,
  workerTitle,
} from "../../sessions";
import {
  StopQueueDoc,
  prepareStopQueueHandoff,
  resumeStopQueueHandoff,
  settleStopStateOnInputInTx,
} from "../../stopQueueHandoff";
import {
  ABORT_FAST_RETURN_MS,
  badRequest,
  brief,
  decodeSegment,
  HttpFailure,
  idOf,
  json,
  LARGE_BODY_MAX_BYTES,
  notFound,
  readBody,
  serverContext,
  string,
} from "../http";
import {
  answerOf,
  attemptOf,
  busyRefusal,
  clearPendingPrompts,
  neverPlaced,
  parseAgentChange,
  parseSubmission,
  queueSessionOf,
  SUBMIT_ATTEMPT_LIMIT,
  summaryOf,
} from "../summary";
import type { RouteContext } from "../types";

const context = serverContext;

export const handleConversationAction = async (
  ctx: RouteContext,
  conversationId: ConversationId,
  conversation: Conversation,
  action: string
): Promise<Response | null> => {
  const { request, runtime } = ctx;
  const { config, storage, harness, models, defaultAgent } = runtime.deps;

  if (action === "submit" && request.method === "POST") {
    const body = await readBody(request, LARGE_BODY_MAX_BYTES);
    const parsed = parseSubmission(body);
    if ("error" in parsed) return badRequest(parsed.error);
    const draft = parsed.draft;
    const sendConfig = parsed.sendConfig;
    const attempt =
      draft.type === "input" && draft.requestId !== undefined
        ? await attemptOf(storage, conversationId, draft.requestId)
        : undefined;
    const mode = draft.type === "write" ? "write" : draft.whenBusy ?? "followUp";
    const admitted = attempt?.newest;
    if (admitted !== undefined && !neverPlaced(admitted)) {
      return json(answerOf(admitted, mode, sendConfig !== undefined), 201);
    }
    if (attempt !== undefined && attempt.key === undefined) {
      return json(
        {
          error: `requestId "${brief(draft.requestId ?? "", 100)}" has been retried ${SUBMIT_ATTEMPT_LIMIT} times and never reached the transcript; send it with a new requestId`,
        },
        409
      );
    }
    if (draft.type === "input") {
      const [agent, inbox, queueConfig] = await Promise.all([
        harness.snapshot(AgentDoc, conversationId, context),
        harness.snapshot(InboxDoc, conversationId, context),
        harness.snapshot(QueueConfigDoc, conversationId, context),
      ]);
      const chosen = effectiveSubmissionModel(sendConfig, agent, inbox, queueConfig, defaultAgent.model);
      const refusal = blindModelReason(draft.content, models.getModel(chosen.provider, chosen.modelId));
      if (refusal) return badRequest(refusal);
    }
    if (draft.type === "input" && draft.whenBusy === "reject") {
      if ((await harness.snapshot(LiveDoc, conversationId, context))?.run !== undefined) {
        return busyRefusal(conversationId);
      }
    }
    if (draft.type === "input") {
      const text = inputTextOf(draft.content);
      if (text.trim()) await injectContextForInput(harness, conversationId, text, context);
    }
    const toPlace = attempt?.key === undefined ? draft : { ...draft, requestId: attempt.key };
    let submission: Submission;
    try {
      const finishHandoff = new Error("Finish the pending stop before admitting an idle input");
      const admit = () =>
        harness.commit(async (tx) => {
          const prior =
            toPlace.requestId === undefined ? undefined : await tx.submissionByRequest(conversationId, toPlace.requestId);
          const stopQueue = await tx.doc(StopQueueDoc, conversationId);
          const meta = await tx.doc(MetaDoc, conversationId);
          const liveBefore = await tx.doc(LiveDoc, conversationId);
          const inboxBefore = await tx.doc(InboxDoc, conversationId);
          const wasBusy = liveBefore.run !== undefined;
          const wasFailed = Boolean(liveBefore.runFailure);
          if (
            draft.type === "input" &&
            !prior &&
            stopQueue.pending &&
            !wasBusy &&
            meta.stoppedAt === stopQueue.pending.stoppedAt
          ) {
            throw finishHandoff;
          }
          if (draft.type === "input" && !prior) {
            const assignment = await workerAssignment((id) => tx.doc(SessionsDoc, id), conversationId, meta);
            if (
              assignment &&
              (explicitSettled(assignment.entry) ||
                (assignment.entry.taskLifecycle === "explicit" &&
                  (assignment.entry.state === "failed" || assignment.entry.state === "stopped")))
            ) {
              await rearmWorker(tx, assignment.owner, assignment.key, conversationId, Date.now());
            }
          }
          const applyImmediately =
            draft.type === "input" && !prior && sendConfig !== undefined && !wasBusy && inboxBefore.items.length === 0;
          if (applyImmediately) {
            await configure(tx, conversationId, sendConfig);
          }
          const submissionId = await conversation.submit(tx, toPlace);
          if (draft.type === "input" && !prior && sendConfig !== undefined && !applyImmediately) {
            const queueConfig = await tx.doc(QueueConfigDoc, conversationId);
            queueConfig.items[String(submissionId)] = sendConfig;
          }
          if (
            draft.type === "input" &&
            !prior &&
            !wasBusy &&
            (await tx.doc(LiveDoc, conversationId)).run !== undefined
          ) {
            await applyRunQueueConfigsInTx(tx, conversationId);
          }
          if (draft.type === "input" && !prior) {
            await settleStopStateOnInputInTx(tx, conversationId, {
              submissionId,
              wasBusy,
              wasFailed,
              sendConfig,
            });
          }
          return submissionId;
        }, context);
      let submissionId: SubmissionId;
      try {
        submissionId = await admit();
      } catch (error) {
        if (error !== finishHandoff) throw error;
        await resumeStopQueueHandoff(harness, conversationId, context);
        try {
          submissionId = await admit();
        } catch (retryError) {
          if (retryError === finishHandoff) throw new ConversationBusy(conversationId);
          throw retryError;
        }
      }
      submission = (await harness.submission(submissionId, context))!;
    } catch (error) {
      if (!(error instanceof ConversationBusy)) throw error;
      return busyRefusal(conversationId);
    }
    return json(answerOf(await submission.status(context), mode, sendConfig !== undefined), 201);
  }

  if (action === "abort" && request.method === "POST") {
    const continueQueue = (await readBody(request)).continueQueue === true;
    const note = await clearPendingPrompts(harness, conversationId);
    const [inboxBefore, queueConfigBefore] = await Promise.all([
      harness.snapshot(InboxDoc, conversationId, context),
      harness.snapshot(QueueConfigDoc, conversationId, context),
    ]);
    const prepared = await harness.commit(async (tx) => {
      await markWorkerStopped(tx, conversationId);
      return prepareStopQueueHandoff(tx, conversationId, randomUUID(), continueQueue);
    }, context);
    const first = prepared ?? parkedInputs(inboxBefore?.items ?? [], queueConfigBefore?.items);
    const seen = new Set(first.map((item) => item.id));
    let continued = 0;
    const requeue =
      prepared !== undefined
        ? resumeStopQueueHandoff(harness, conversationId, context).then((count) => {
            continued = count;
            return first;
          })
        : conversation.abort(context).then(async () => {
            const [latest, latestQueueConfig] = await Promise.all([
              harness.snapshot(InboxDoc, conversationId, context),
              harness.snapshot(QueueConfigDoc, conversationId, context),
            ]);
            const late = parkedInputs(latest?.items ?? [], latestQueueConfig?.items).filter(
              (item) => !seen.has(item.id)
            );
            const parked = [...first, ...late];
            await parkInputs((change) => conversation.commit(change, context), conversationId, parked);
            return parked;
          });
    const settled = await Promise.race([
      requeue.then((parked) => ({ done: true as const, parked })),
      new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), ABORT_FAST_RETURN_MS)),
    ]);
    void requeue.catch((error: unknown) => {
      console.error("[hearth] parking the queue across a stop failed", error instanceof Error ? error.message : error);
    });
    if (!settled.done) console.log(`[hearth] abort for conversation ${conversationId} is still winding down`);
    const parked = settled.done ? settled.parked : first;
    return json({
      ok: true,
      ...(prepared !== undefined && (settled.done ? continued > 0 : parked.length > 0) ? { continuing: true } : {}),
      ...(note.length > 0 ? { cleared: note } : {}),
      ...(parked.length > 0
        ? { parked: parked.length, parkedText: parked.map((item) => contentPreviewOf(item.content)) }
        : {}),
    });
  }

  const compactionMatch = /^compact\/(\d+)$/.exec(action);
  if (compactionMatch && request.method === "GET") {
    const taskId = idOf<TaskId<CompactionResult>>(compactionMatch[1]);
    const task = taskId ? await harness.getTask(taskId, context) : undefined;
    if (!task || task.conversationId !== conversationId || task.kind !== "pi.compaction") {
      return notFound(`there is no compaction ${compactionMatch[1]} in conversation ${conversationId}`);
    }
    if (task.state.status !== "terminal") return json({ taskId: task.id, status: "running" });
    const outcome = task.state.outcome;
    if (outcome.status !== "completed") {
      return json({
        taskId: task.id,
        status: outcome.status === "aborted" ? "aborted" : "failed",
        error: outcome.error?.message ?? outcome.reason ?? "Compaction did not finish",
      });
    }
    const { entryId, submissionId } = outcome.result;
    if (entryId !== undefined) return json({ taskId: task.id, status: "landed" });
    if (submissionId === undefined) return json({ taskId: task.id, status: "nothing" });
    const submission = await harness.submission(submissionId, context);
    const placed = await submission?.status(context);
    if (placed?.status === "done") return json({ taskId: task.id, status: "landed" });
    if (placed?.status === "queued") return json({ taskId: task.id, status: "pending" });
    return json({
      taskId: task.id,
      status: "failed",
      error: "The summary could not be placed. Try compacting again.",
    });
  }

  if (action === "compact" && request.method === "POST") {
    const body = await readBody(request);
    const instructions = string(body.instructions, 2_000);
    const taskId = await conversation.compact(instructions, context);
    return json({ taskId }, 202);
  }

  if (action === "queue/order" && request.method === "PUT") {
    const body = await readBody(request);
    const ids = Array.isArray(body.itemIds) ? body.itemIds.map((value) => String(value)) : null;
    if (!ids || ids.length === 0) return badRequest("itemIds is required");
    const result = await reorderQueuedInputs(
      (change) => conversation.commit(change, context),
      conversationId,
      ids
    );
    if (!result.ok) return badRequest(result.error);
    return json({
      revision: Date.now(),
      session: await queueSessionOf(harness, conversationId),
      replacements: result.replacements,
    });
  }

  if (action === "fork" && request.method === "POST") {
    const body = await readBody(request);
    const rawAt = body.at === undefined ? undefined : String(body.at);
    const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
    const boundary = (rawAt !== undefined ? idOf<EntryId>(rawAt) : undefined) ?? newest?.id;
    if (rawAt !== undefined && boundary === undefined) {
      throw new HttpFailure(400, `at must be a whole entry id; "${brief(rawAt)}" is not`);
    }
    if (boundary === undefined) return badRequest("nothing to fork");
    if (rawAt !== undefined) {
      const at = (await conversation.entries({ minEntryId: boundary, maxEntryId: boundary }, 1, undefined, context))
        .items[0];
      if (!at) {
        return badRequest(
          `entry ${boundary} is not part of conversation ${conversationId}; fork at one of its own entries, or omit at for the newest`
        );
      }
    }
    const fork = await conversation.fork(boundary, { ownership: { kind: "ownerless" } }, context);
    return json(await summaryOf(harness, { id: fork.id }, storage), 201);
  }

  if (action === "btw" && request.method === "POST") {
    const body = await readBody(request);
    const question = string(body.question, 10_000)?.trim();
    if (!question) return badRequest("question is required");
    const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
    const autoAccept = await harness.snapshot(AutoAcceptDoc, conversationId, context);
    const leaderAgent = await harness.snapshot(AgentDoc, conversationId, context);
    const now = Date.now();
    const role = "Aside";
    const spawned = await harness.commit(async (tx) => {
      const placement = await spawnSupervisor((id) => tx.doc(MetaDoc, id), conversationId);
      if (!placement) return undefined;
      const supervisor = placement.supervisor;
      const crew = await tx.doc(SessionsDoc, conversationId);
      const supervisoryCrew = await tx.doc(SessionsDoc, supervisor);
      const roleIndex = nextRoleIndex(supervisoryCrew.items, role);
      const title = workerTitle(role, roleIndex);
      const key = `btw-${roleIndex}-${now}`;
      const briefRequestId = `hearth.crew.brief:${conversationId}:${key}:${now}`;
      const generation = crew.woke ? crew.generation + 1 : Math.max(crew.generation, 1);
      const child = newest
        ? await tx.forkConversation(conversationId, newest.id, { ownership: { kind: "ownerless" } })
        : await tx.createConversation({
            ownership: { kind: "ownerless" },
            ...(leaderAgent
              ? {
                  agent: {
                    ...(leaderAgent.cwd ? { cwd: leaderAgent.cwd } : {}),
                    ...(leaderAgent.model ? { model: leaderAgent.model } : {}),
                    ...(leaderAgent.thinkingLevel ? { thinkingLevel: leaderAgent.thinkingLevel } : {}),
                    instructions: WORKER_INSTRUCTIONS,
                  },
                }
              : { agent: { instructions: WORKER_INSTRUCTIONS } }),
          });
      const meta = await tx.doc(MetaDoc, child.id);
      meta.title = title;
      meta.kind = "worker";
      meta.lead = { conversationId: supervisor as number, host: "local" };
      meta.creatorId = conversationId;
      meta.delegates = false;
      (await tx.doc(AutoAcceptDoc, child.id)).enabled = autoAccept?.enabled ?? false;
      crew.generation = generation;
      crew.woke = false;
      delete crew.wokeAt;
      crew.deadlineAt = now + CREW_DEADLINE_MS;
      crew.spawnedAt = [...pruneSpawns(crew.spawnedAt, now), now];
      crew.items[key] = {
        creatorId: conversationId,
        supervisorId: supervisor,
        kind: "worker",
        conversationId: child.id,
        title,
        role,
        roleIndex,
        spawnedAt: now,
        taskAt: now,
        ...(newest ? { answerFrom: newest.id as number } : {}),
        state: "starting",
        generation,
        briefRequestId,
        sideQuestion: question.slice(0, 300),
      };
      if (supervisor !== conversationId) {
        supervisoryCrew.items["requester:" + conversationId + ":" + key] = {
          ...crew.items[key],
          taskOwner: { conversationId, key },
        };
      }
      return { id: child.id, briefRequestId };
    }, context);
    if (!spawned) {
      return badRequest(
        "Kiln cannot verify this worker's supervisor chain. Repair its membership before asking a side question."
      );
    }
    const childHandle = await harness.conversation(spawned.id, context);
    if (childHandle) {
      const prompt =
        `[Side question from the user — answer concisely using the conversation context above. ` +
        `Your final message will be reported back to the main session.]\n\n${question}`;
      await childHandle.submit({ type: "input", content: prompt, requestId: spawned.briefRequestId }, context);
    }
    return json(await summaryOf(harness, { id: spawned.id }, storage), 201);
  }

  if (action === "promote" && request.method === "POST") {
    const body = await readBody(request);
    const meta = await harness.snapshot(MetaDoc, conversationId, context);
    if (meta?.kind !== "worker") {
      return badRequest("only a worker can be promoted; this conversation is not a worker");
    }
    if ((await harness.snapshot(LiveDoc, conversationId, context))?.run) {
      return json({ error: "conversation is busy; wait or stop it first" }, 409);
    }
    const name = string(body.name, 200)?.trim();
    if (!name) return badRequest("name is required");
    const description = string(body.description, 2_000)?.trim();
    const pinned = body.pinned === false ? false : true;
    const workerNumericId = Number(conversationId);
    const existingEntries = (await harness.snapshot(AgentsDoc, context))?.entries ?? {};
    if (Object.hasOwn(existingEntries, name) && existingEntries[name]?.conversationId !== workerNumericId) {
      return badRequest(`bot name already registered: ${name}`);
    }
    const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
    if (!newest) return badRequest("nothing to fork");
    let forkId: ConversationId;
    try {
      forkId = await harness.commit(async (tx) => {
        const agents = await tx.doc(AgentsDoc);
        if (Object.hasOwn(agents.entries, name) && agents.entries[name]?.conversationId !== workerNumericId) {
          throw new DuplicateAgentError(name);
        }
        const worker = await tx.doc(MetaDoc, conversationId);
        const workerAgent = await tx.doc(AgentDoc, conversationId);
        const fork = await tx.forkConversation(conversationId, newest.id, {
          ownership: { kind: "ownerless" },
        });
        const nextInstructions =
          workerAgent.instructions && !isSpawnedWorkerInstructions(workerAgent.instructions)
            ? workerAgent.instructions
            : null;
        const forkAgent = await tx.doc(AgentDoc, fork.id);
        if ((forkAgent.instructions ?? null) !== nextInstructions) {
          await configure(tx, fork.id, { instructions: nextInstructions });
        }
        const forkMeta = await tx.doc(MetaDoc, fork.id);
        forkMeta.kind = "peer";
        if (worker.lead) forkMeta.lead = worker.lead;
        forkMeta.delegates = true;
        forkMeta.title = name;
        const now = Date.now();
        await promoteAgent(tx, workerNumericId, name, {
          conversationId: fork.id as number,
          host: "local",
          ...(description ? { description } : {}),
          pinned,
          createdAt: now,
          updatedAt: now,
        });
        worker.promotedTo = fork.id as number;
        if (worker.lead?.host === "local") {
          const crew = await tx.doc(SessionsDoc, worker.lead.conversationId as ConversationId);
          for (const entry of Object.values(crew.items)) {
            if (entry.kind === "worker" && entry.conversationId === conversationId) {
              entry.promotedTo = fork.id as number;
              if (entry.taskOwner) {
                const actual = (await tx.doc(SessionsDoc, entry.taskOwner.conversationId)).items[entry.taskOwner.key];
                if (actual) actual.promotedTo = fork.id as number;
              }
            }
          }
        }
        return fork.id;
      }, context);
    } catch (error) {
      if (error instanceof DuplicateAgentError) return badRequest(error.message);
      throw error;
    }
    writeAgentsMirror(config.home, await harness.snapshot(AgentsDoc, context));
    return json(await summaryOf(harness, { id: forkId }, storage), 201);
  }

  if (action === "reset" && request.method === "POST") {
    const body = await readBody(request);
    await conversation.reset(string(body.handoff, 20_000), context);
    return json({ ok: true });
  }

  if (action === "configure" && request.method === "POST") {
    const body = await readBody(request);
    const change = parseAgentChange(body);
    if (!change) return badRequest("invalid agent change");
    await conversation.configure(change, context);
    return json({ ok: true });
  }

  const receiptMatch = /^submissions\/([^/]+)$/.exec(action);
  if (receiptMatch && request.method === "GET") {
    const submissionId = idOf<SubmissionId>(decodeSegment(receiptMatch[1]));
    if (!submissionId) return badRequest("invalid submission id");
    let record = await storage.submission(submissionId, context);
    if (!record || record.conversationId !== conversationId) {
      return notFound("This conversation has no such submission.");
    }
    for (let depth = 0; depth < 20 && record.status === "unanswered" && record.entry === undefined; depth += 1) {
      const parked = await storage.submissionByRequest(
        conversationId,
        parkRequestId(conversationId as unknown as number, String(record.id)),
        context
      );
      if (!parked) break;
      record = parked;
    }
    return json(answerOf(record, record.type === "input" ? "followUp" : "write"));
  }

  const submissionMatch = /^submissions\/([^/]+)\/abort$/.exec(action);
  if (submissionMatch && request.method === "POST") {
    const submissionId = idOf<SubmissionId>(decodeSegment(submissionMatch[1]));
    if (!submissionId) return badRequest("invalid submission id");
    const result = await harness.abortSubmission(submissionId, context, conversationId);
    if (result === "not_found") {
      return notFound(`conversation ${conversationId} has no submission ${submissionId} to withdraw`);
    }
    if (result === "aborted") {
      await harness.commit((tx) => removeQueueConfigInTx(tx, conversationId, submissionId), context);
    }
    return json({ ok: result === "aborted", result });
  }

  if (action === "auto-accept" && (request.method === "PUT" || request.method === "POST")) {
    const body = await readBody(request);
    if (typeof body.enabled !== "boolean") return badRequest("enabled must be boolean");
    await setAutoAccept(harness, conversationId, body.enabled, context);
    return json({ ok: true });
  }

  return null;
};
