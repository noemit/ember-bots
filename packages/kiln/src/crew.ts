/**
 * Durable worker settlement and archive lifecycle. New background threads keep outcomes in
 * SessionsDoc and emit content-free completion references; threadSupervisor owns subscriptions
 * and foreground-safe continuations. Legacy workers retain report cards and generation digests.
 */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  LiveDoc,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryRecord,
  type Extension,
  type Harness,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import { threadTask } from "./threadResults";
import { resumeThreads, continuationRecipient } from "./threadSupervisor";
import { MetaDoc } from "./meta";
import { ApprovalsDoc, clearPendingApprovals } from "./approvals";
import { QuestionsDoc, clearPendingQuestions } from "./ask";
import { resumeQuestions } from "./questions";
import {
  DELEGATION_OFF,
  REPORT_CAP,
  SessionsDoc,
  crewOutcome,
  isActiveWorker,
  spawnRefusal,
  spawnRefusalText,
  type SessionsState,
} from "./sessions";

// Re-exported so `crew.test.ts` has one import for the pure crew helpers.
export {
  depthOf,
  pruneSpawns,
  rateLimited,
  spawnRefusal,
  spawnRefusalText,
  MAX_DEPTH,
  SPAWN_BUDGET,
  SPAWN_RATE_LIMIT,
} from "./sessions";

/** Give a freshly spawned worker this long to start before "no run" means "settled". */
const START_GRACE_MS = 10_000;
const SCAN_PAGE = 200;

/** Every conversation record, scanned page by page from storage (mirrors `server.ts`). */
export const allConversations = async (storage: Storage, context: Context): Promise<ConversationRecord[]> => {
  const records: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanConversations({}, SCAN_PAGE, cursor, context);
    records.push(...page.items);
    if (!page.next) return records;
    cursor = page.next;
  }
};

/**
 * The wake digest: one line per entry in `generation`, `name (state): first 300 chars
 * (conversation <id>)`. A crew with a failure in it starts with `FINISHED WITH FAILURES`, so the
 * wake cannot be read as a report of success. Pure so it can be unit-tested.
 */
export const digestOf = (state: SessionsState, generation = state.generation): string => {
  const entries = Object.entries(state.items).filter(([, entry]) => entry.generation === generation);
  if (entries.length === 0) return "no crew entries";
  const lines = entries.map(([name, entry]) => {
    const body =
      entry.report?.text ??
      (entry.state === "failed"
        ? "FAILED — ended without a report. Do not wait for it."
        : entry.state === "stopped"
          ? "STOPPED — ended early; no report."
          : "(no report yet)");
    const prefix = entry.sideQuestion ? `You asked: "${entry.sideQuestion}"\n` : "";
    return `${prefix}${name} (${entry.state}): ${body.slice(0, 300)} (conversation ${entry.conversationId})`;
  });
  const outcome = crewOutcome(Object.fromEntries(entries));
  const heading = outcome === "failed" ? "FINISHED WITH FAILURES\n" : "";
  return heading + lines.join("\n");
};

const wakeTextOf = (state: SessionsState, generation = state.generation): string => {
  const entries = Object.entries(state.items).filter(([, entry]) => entry.generation === generation);
  const allSideQuestions = entries.length > 0 && entries.every(([, entry]) => Boolean(entry.sideQuestion));
  if (allSideQuestions) {
    return `[crew] Side question:\n${digestOf(state, generation)}`;
  }
  return `[crew] Crew report (generation ${generation}):\n${digestOf(state, generation)}`;
};

/**
 * True when a worker can be proved never to run: its conversation has no assistant turn, no user
 * turn, and no live submission. That is a worker whose brief never landed — stopped before it
 * started, or withdrawn — so the supervisor should report the failure now rather than treat it as
 * "still starting" until the grace window runs out.
 *
 * Deliberately conservative. `inspect()` lists only queued/placed submissions, so "not live" alone
 * cannot tell settled-`done` from settled-`unanswered`; requiring an empty transcript as well means
 * only a worker that never got going at all qualifies. A false negative merely delays the report by
 * the grace window; a false positive would cut a live worker short.
 */
const neverStarted = async (
  harness: Harness,
  workerId: ConversationId,
  context: Context
): Promise<boolean> => {
  let inspection;
  try {
    inspection = await harness.inspect(context);
  } catch {
    return false;
  }
  if (inspection.submissions.some((submission) => submission.conversationId === workerId)) return false;
  const conversation = await harness.conversation(workerId, context);
  if (!conversation) return true; // the conversation is gone: it can never answer
  const entries = await conversation.entries({}, 50, undefined, context);
  return !entries.items.some((entry) => entry.kind === "pi.assistant" || entry.kind === "pi.user");
};

/** The first text part of an assistant entry's message, or `""` when it carries none. */
const firstTextOf = (entry: EntryRecord): string => {
  const message = entry.model?.[0] as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
};

/** The newest visible entry of a conversation, or undefined when it is gone. */
const newestEntry = async (
  harness: Harness,
  id: ConversationId,
  context: Context
): Promise<EntryRecord | undefined> => {
  const conversation = await harness.conversation(id, context);
  if (!conversation) return undefined;
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await conversation.entries({}, cursor === undefined ? 1 : 32, cursor, context);
    const newest = page.items.find((entry) => entry.kind !== "hearth.thread-result");
    if (newest || !page.next) return newest;
    cursor = page.next;
  }
};

/** Abort any of `ids` with a run in flight, so an archived crew stops spending. */
const abortRunning = async (harness: Harness, ids: readonly ConversationId[], context: Context): Promise<void> => {
  for (const id of ids) {
    const live = await harness.snapshot(LiveDoc, id, context);
    if (!live?.run) continue;
    const conversation = await harness.conversation(id, context);
    if (conversation) await conversation.abort(context);
  }
};

/** Every `kind: "worker"` descendant of `root` from its crew doc, recursively (no peers). */
export const collectWorkerIds = async (
  harness: Harness,
  root: ConversationId,
  context: Context = BACKGROUND_CONTEXT
): Promise<ConversationId[]> => {
  const found: ConversationId[] = [];
  const seen = new Set<number>([root as number]);
  const queue: ConversationId[] = [root];
  while (queue.length > 0) {
    const leader = queue.shift() as ConversationId;
    const doc = await harness.snapshot(SessionsDoc, leader, context);
    if (!doc) continue;
    for (const entry of Object.values(doc.items)) {
      // Never cascade to peers; a promoted worker is detached from the cascade.
      if (entry.kind !== "worker" || entry.promotedTo !== undefined) continue;
      const id = entry.conversationId;
      const meta = await harness.snapshot(MetaDoc, id, context);
      if (meta?.promotedTo !== undefined || (meta?.lead && meta.lead.conversationId !== leader)) continue;
      if (seen.has(id as number)) continue;
      seen.add(id as number);
      found.push(id);
      queue.push(id);
    }
  }
  return found;
};

/** Persist a human stop on the authoritative membership, separate from ordinary idleness. */
export const markWorkerStopped = async (tx: Tx, id: ConversationId): Promise<void> => {
  const meta = await tx.doc(MetaDoc, id);
  meta.stoppedAt = Date.now();
  const questions = await tx.doc(QuestionsDoc, id);
  for (const q of Object.values(questions.items)) if (q.mode === "async") { q.resumeRequired = true; if (q.mutation?.action === "resume") delete q.mutation; }
  if (meta.kind !== "worker" || !meta.lead || meta.lead.host !== "local") return;
  const owner = (meta.creatorId ?? meta.lead.conversationId) as ConversationId;
  const doc = await tx.doc(SessionsDoc, owner);
  for (const entry of Object.values(doc.items)) {
    if (entry.conversationId !== id || entry.taskOwner) continue;
    entry.state = "stopped";
    delete entry.followUpAt;
    if (entry.delivery === "thread") entry.report = { status: "aborted",
      text: "This thread was stopped before finishing its outcome.", at: Date.now(),
      requestId: "hearth.thread.stopped:" + threadTask(entry) };
  }
};

/**
 * Cascade-archive `root` and every worker descendant under one `archiveBatch`. Running workers
 * are aborted first. When `title` is provided it lands on the root in the same commit.
 */
export const archiveCrew = async (
  harness: Harness,
  root: ConversationId,
  archivedAt: number,
  title: string | null | undefined,
  context: Context = BACKGROUND_CONTEXT
): Promise<void> => {
  const descendants = await collectWorkerIds(harness, root, context);
  const batch = randomUUID();
  if (descendants.length > 0) await abortRunning(harness, descendants, context);
  // Their runs are over, so nothing they parked can still be answered. Clearing the prompts here,
  // and not only in `POST /abort`, is what keeps a worker from being left `needsInput` on a card
  // nobody can act on after its leader is archived.
  for (const id of descendants) {
    if ((await harness.snapshot(ApprovalsDoc, id, context)) !== undefined) {
      await clearPendingApprovals(harness, id, context).catch(() => undefined);
    }
    if ((await harness.snapshot(QuestionsDoc, id, context)) !== undefined) {
      await clearPendingQuestions(harness, id, context).catch(() => undefined);
    }
  }
  await harness.commit(async (tx) => {
    const doc = await tx.doc(MetaDoc, root);
    for (const q of Object.values((await tx.doc(QuestionsDoc, root)).items)) if (q.mode === "async") { q.resumeRequired = true; if (q.mutation?.action === "resume") delete q.mutation; }
    doc.archived = archivedAt;
    doc.archiveBatch = batch;
    if (title === null) delete doc.title;
    else if (title !== undefined) doc.title = title;
    // The workers are archived in the same commit that records their leaders' decision, and they
    // are marked `stopped` with it: left `starting | running`, the supervisor would see no run, no
    // answer and — after the grace window — report them `failed` into their leader's transcript,
    // writing a failure nobody asked to read into a conversation that was just put away.
    for (const id of descendants) {
      const worker = await tx.doc(MetaDoc, id);
      for (const q of Object.values((await tx.doc(QuestionsDoc, id)).items)) if (q.mode === "async") { q.resumeRequired = true; if (q.mutation?.action === "resume") delete q.mutation; }
      worker.archived = archivedAt;
      worker.archiveBatch = batch;
      const lead = worker.lead;
      if (!lead || lead.host !== "local") continue;
      const crew = await tx.doc(SessionsDoc, lead.conversationId as ConversationId);
      for (const entry of Object.values(crew.items)) {
        if (entry.kind !== "worker" || entry.conversationId !== id) continue;
        const actual = entry.taskOwner
          ? (await tx.doc(SessionsDoc, entry.taskOwner.conversationId)).items[entry.taskOwner.key] : entry;
        if (!actual) continue;
        if (actual.state === "starting" || actual.state === "running") actual.state = "stopped";
        delete actual.followUpAt;
        delete entry.followUpAt;
      }
    }
  }, context);
};

/**
 * Unarchive `root` and only those rows whose `archiveBatch` matches it. A worker archived
 * individually (with its own batch) is left alone.
 */
export const unarchiveCrew = async (
  harness: Harness,
  root: ConversationId,
  title: string | null | undefined,
  context: Context = BACKGROUND_CONTEXT
): Promise<void> => {
  const rootMeta = await harness.snapshot(MetaDoc, root, context);
  const batch = rootMeta?.archiveBatch;
  const candidates = await collectWorkerIds(harness, root, context);
  const restore: ConversationId[] = [];
  for (const id of candidates) {
    const meta = await harness.snapshot(MetaDoc, id, context);
    if (batch !== undefined && meta?.archiveBatch === batch) restore.push(id);
  }
  await harness.commit(async (tx) => {
    const doc = await tx.doc(MetaDoc, root);
    delete doc.archived;
    delete doc.archiveBatch;
    if (title === null) delete doc.title;
    else if (title !== undefined) doc.title = title;
    for (const id of restore) {
      const worker = await tx.doc(MetaDoc, id);
      if (batch !== undefined && worker.archiveBatch !== batch) continue;
      delete worker.archived;
      delete worker.archiveBatch;
    }
  }, context);
};

/**
 * The identity of one wake: the generation plus every report it would carry, sorted. A wake is due
 * whenever this differs from the `wokeKey` stored on the crew doc, which is what makes a report that
 * lands *after* the generation's wake produce a second wake while a rerun of the same tick (or a
 * restart) sends nothing. Pure, so it can be unit-tested.
 */
export const wakeKeyOf = (state: SessionsState, generation = state.generation): string => {
  const delivered = Object.entries(state.items)
    // Only finished entries of this generation: an active worker's answer is exactly what the wake
    // is still waiting for, and an entry from an earlier generation is not in this digest at all.
    .filter(([, entry]) => entry.generation === generation && !isActiveWorker(entry))
    .map(([name, entry]) => `${name}:${entry.state}:${entry.report?.requestId ?? "-"}`)
    .sort();
  return `${generation}|${delivered.join(",")}`;
};

/**
 * Whether this generation has a report the leader is meant to read.
 *
 * A worker that settled under `delivery: "on-failure"` and succeeded carries no `report` — only a
 * `silentReport` — so a generation made entirely of those has nothing to wake anyone for. Pure, and
 * deliberately blind to `state`: "reported" is how `list` draws it, not a reason to interrupt.
 */
export const hasVisibleReport = (state: SessionsState, generation = state.generation): boolean =>
  Object.values(state.items).some(
    (entry) => entry.generation === generation && entry.report !== undefined
  );

/**
 * The submission id of one wake: a digest of its key, so it is stable across a restart (a crash
 * between the submit and the commit reacquires the same submission) and distinct for every later
 * report set.
 */
const wakeRequestId = (leader: ConversationId, key: string): string =>
  `hearth.crew.wake:${leader}:${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;

/**
 * One supervisor tick: report settled workers, then wake the leader on quiescence or deadline - and
 * again whenever a report it has not been shown yet arrives (`wakeKeyOf`). Returns how many
 * updates/wakes it made.
 */
export const tick = async (
  harness: Harness,
  storage: Storage,
  context: Context = BACKGROUND_CONTEXT
): Promise<number> => {
  let actions = 0;
  const now = Date.now();
  for (const record of await allConversations(storage, context)) {
    try { actions += await resumeQuestions(harness, record.id, context); }
    catch (error) { console.error("[hearth] question continuation failed:", error); }
    const snapshot = await harness.snapshot(SessionsDoc, record.id, context);
    if (!snapshot) continue;
    // The cheap signal first: a crew with nobody owing an answer can neither report nor be due a
    // wake, so such a conversation costs this tick exactly one snapshot read.
    const active = Object.entries(snapshot.items).filter(([, entry]) => !entry.taskOwner && isActiveWorker(entry));
    if (active.length === 0 && !Object.values(snapshot.items).some((entry) =>
      !entry.taskOwner && (entry.delivery === "thread" || (entry.contextAdvisory?.task === threadTask(entry) &&
        entry.notifiedContextEpoch !== entry.contextAdvisory?.epoch)))) continue;

    for (const [name, entry] of active) {
      const live = await harness.snapshot(LiveDoc, entry.conversationId, context);
      if (live?.run) {
        if (entry.state !== "running") {
          await harness.commit(async (tx) => {
            const doc = await tx.doc(SessionsDoc, record.id);
            const item = doc.items[name];
            if (item) item.state = "running";
          }, context);
          actions += 1;
        }
        continue;
      }
      // When this worker was handed the task it is answering: its spawn, or the later message that
      // put it back to work. The grace counts from here, so a re-tasked worker is not judged settled
      // by a spawn time it has outlived.
      const since = entry.taskAt ?? entry.spawnedAt;
      const newest = await newestEntry(harness, entry.conversationId, context);
      // An assistant turn that predates the task is the *previous* answer: the leader has already
      // read it, and reporting it again would claim the new task was done. `answerFrom` is the
      // transcript watermark taken when the new task was handed over.
      const answered =
        newest?.kind === "pi.assistant" &&
        (entry.answerFrom === undefined || (newest.id as number) > entry.answerFrom);
      // A thread can itself be a foreground coordinator. Its nonblocking wait intentionally
      // ends the run while durable child work continues; that is not a failed worker. A later
      // substantive final answer can still settle it even if an old suspension flag remains.
      if (!answered && !live?.runFailure && (await harness.snapshot(SessionsDoc, entry.conversationId, context))?.suspended) continue;
      // A follow-up queued behind this worker's in-flight answer is not answered by that answer: the
      // worker owes one more turn, and reporting the first one would claim the queued task was done
      // (see `rearmWorker`). The wait is bounded by the normal deadline, so a follow-up whose boundary
      // never came still produces a report rather than a worker that is "starting" for ever.
      const owesFollowUp = entry.followUpAt !== undefined;
      // A worker can die before it ever runs: its brief is withdrawn (a stop), it fails to answer, or
      // its conversation was archived and never took the brief. Those are failures, not "still
      // starting", and the grace below would otherwise keep them `starting` for its whole length —
      // which is exactly how a leader ends up polling a worker that will never answer. `briefGone`
      // is the proof: the brief's submission settled without ever being placed, and no assistant turn
      // exists. Only asked for when the cheap signals are inconclusive, so the common path pays nothing.
      const brieflyDead = newest === undefined && now - since < START_GRACE_MS &&
        (await neverStarted(harness, entry.conversationId, context));
      // "Settled" only once it has genuinely run (an assistant turn since it was handed this task,
      // previously observed running), the start grace has passed, or we can prove it never will.
      const settled = answered || entry.state === "running" || now - since >= START_GRACE_MS || brieflyDead;
      if (!settled) continue;
      if (owesFollowUp && entry.state === "starting") continue;

      let status: "ok" | "failed" = "failed";
      let text = "No answer.";
      if (answered && newest !== undefined) {
        const message = newest.model?.[0] as { stopReason?: string; errorMessage?: string } | undefined;
        const said = firstTextOf(newest).slice(0, REPORT_CAP);
        status = message?.stopReason === "error" ? "failed" : "ok";
        // A failure is a message: say what went wrong, not just "No answer.", so the leader's report
        // is something to act on rather than a shrug.
        text =
          status === "failed"
            ? `This worker failed: ${said || message?.errorMessage || "the model returned an error"}`.slice(0, REPORT_CAP)
            : said || "No answer.";
      } else if (brieflyDead) {
        text = "This worker never started: its brief was withdrawn or its session ended first. Do not wait for it.";
      }
      const report = {
        status: status as "ok" | "failed",
        text,
        at: Date.now(),
        // One report per (worker, task): a re-tasked worker's new answer has to be a new report, or
        // the wake key below cannot tell it from the answer the leader has already read.
        requestId: `hearth.crew.report:${record.id}:${name}:${since}` + (entry.questionContinuations?.length ? `:question:${entry.questionContinuations.length}` : ""),
        ...(answered && newest ? { entryId: newest.id as number } : {}),
      };
      /**
       * Whether the leader is shown this one.
       *
       * `delivery: "on-failure"` is the leader saying, at brief time, that this worker's expected
       * answer is "done, nothing to say" — so a success costs no transcript entry, no digest line and
       * no leader turn. Everything is still *recorded*: the state moves to `reported`, which is what
       * `list` and the crew strip draw, and the text is kept for `results`. A failure is always
       * shown: that is the whole point of asking to hear only when something is wrong.
       */
      const shown = entry.delivery !== "on-failure" || status === "failed";
      await harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc, record.id);
        const item = doc.items[name];
        if (!item || threadTask(item) !== threadTask(entry) || item.answerFrom !== entry.answerFrom || item.questionContinuations?.length !== entry.questionContinuations?.length || !isActiveWorker(item)) return;
        item.state = status === "ok" ? "reported" : "failed";
        // The queued task's answer has now been settled; the next tick must not re-settle it.
        delete item.followUpAt;
        if (shown) {
          item.report = report;
          // A shown report replaces any earlier silent one: `results` should read the answer the
          // leader was actually given, not a success from two tasks ago.
          delete item.silentReport;
          if (item.delivery === "thread") await tx.appendEntry(record.id, {
            kind: "hearth.thread-result",
            data: { at: report.at, resultId: report.requestId, task: threadTask(item), status,
              conversationId: String(item.conversationId), ...(report.entryId === undefined ? {} : { entryId: report.entryId }) },
          });
          if (item.delivery !== "thread") await tx.appendEntry(record.id, {
            kind: "hearth.crew-report",
            data: {
              generation: item.generation,
              name,
              status,
              text,
              conversationId: String(entry.conversationId),
            },
          });
        } else {
          // No `report` at all: that is what keeps it out of the wake digest (`wakeKeyOf` reads
          // `report?.requestId`). The text is kept beside it so `results` can still answer.
          item.silentReport = { text, at: report.at };
        }
      }, context);
      actions += 1;
    }

    // Quiescence and the deadline are evaluated on every tick that has active workers, never only on
    // the ticks that changed something. A worker that hangs changes nothing for fifteen minutes, and
    // that is exactly the case the deadline exists for; the cost is one extra snapshot read per
    // conversation with an active crew - the read this tick was already paying whenever a worker
    // reported.
    const snapshotAfter = await harness.snapshot(SessionsDoc, record.id, context);
    if (!snapshotAfter) continue;
    try {
      const resumed = await resumeThreads(harness, record.id, snapshotAfter, now, context);
      actions += resumed;
      if (resumed) continue;
    } catch (error) {
      console.error("[hearth] thread continuation failed:", error instanceof Error ? error.message : error);
      continue;
    }
    // Old workers retain their delivery contract; new threads never enter the report/digest path.
    const legacyItems = Object.fromEntries(Object.entries(snapshotAfter.items).filter(([, item]) => !item.taskOwner && item.delivery !== "thread"));
    if (Object.keys(legacyItems).length === 0) continue;
    const fresh = { ...snapshotAfter, items: legacyItems };
    const generation = fresh.generation;
    const key = wakeKeyOf(fresh, generation);
    // This exact digest was already delivered: a rerun of the tick, a restart, or nothing new. (A
    // doc woken before `wokeKey` existed has no key and is woken once more, which is the safe
    // direction: a duplicate report is not a lost one.)
    if (fresh.wokeKey === key) continue;
    const stillActive = Object.values(fresh.items).some(isActiveWorker);
    if (stillActive && (fresh.deadlineAt === undefined || now <= fresh.deadlineAt)) continue;
    /**
     * A crew that finished with nothing to *show* does not wake its leader.
     *
     * `delivery: "on-failure"` exists so a routine success does not interrupt. Quiescence used to
     * wake regardless, which would have delivered a digest of "(no report yet)" for every worker —
     * the interruption the option was meant to spare, now carrying no information at all. The
     * deadline still wakes (that is what ends a hung crew), and any worker that failed is in
     * `generation` with a report, so a failure is never swallowed by this.
     */
    if (stillActive === false && !hasVisibleReport(fresh, generation)) {
      // Recorded as delivered so the next tick does not re-evaluate it; nothing was sent.
      await harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc, record.id);
        doc.wokeKey = key;
      }, context);
      continue;
    }
    const recipient = await continuationRecipient((id) => harness.snapshot(MetaDoc, id, context),
      (id) => harness.snapshot(LiveDoc, id, context), (id) => harness.snapshot(SessionsDoc, id, context),
      record.id, Object.values(legacyItems));
    if (recipient === undefined) continue;
    const leader = await harness.conversation(recipient, context);
    if (!leader) continue;
    try {
      await leader.submit(
        {
          type: "input",
          content: wakeTextOf(fresh, generation),
          whenBusy: "followUp",
          // Derived from the wake key, not from the generation: pi-durable reacquires a known
          // requestId without writing, so a per-generation id would swallow every later wake of the
          // same generation as a duplicate of the first.
          requestId: wakeRequestId(record.id, key),
        },
        context
      );
    } catch (error) {
      console.error("[hearth] crew wake failed:", error instanceof Error ? error.message : error);
      continue;
    }
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SessionsDoc, record.id);
      doc.woke = true;
      // What this wake delivered: the next one is the first whose reports differ from it.
      doc.wokeKey = key;
      // The spawn window counts from here: a wake is when a model is most likely to answer a
      // report by delegating again, which is how a report-back loop becomes a spawn loop.
      doc.wokeAt = Date.now();
    }, context);
    actions += 1;
  }
  return actions;
};

export type CrewSupervisor = { stop(): void; runOnce(): Promise<number> };

/**
 * The spawn guard: delegation off, the post-wake window, and the hourly budget, in one `beforeTool`
 * hook.
 *
 * `delegates` is the one switch that means "this conversation may not start workers": Ember's
 * plain-chat sessions set it false, and a leader whose user turned crews off does too. Merely
 * recording `delegates: false` on the summary — what the wire had always done — left every
 * conversation free to spawn, which is how a plain chat, or a leader the user had silenced, could
 * still build a crew.
 *
 * The hook is how none of it can be bypassed: pi offers extensions' hooks per task and runs them
 * before a call, so a refused spawn never creates a conversation, whatever tool set the transcript
 * rebuilt. The `session` tool carries the same rules itself (see `spawnRefusal` in `./sessions`) so
 * a caller reaching it another way is refused the same way, and the tool's in-commit copy closes
 * the last race (two spawns of one turn committing back to back).
 */
export const SPAWN_GUARD = "hearth-spawn-guard";

type GuardApi = {
  readonly conversationId: ConversationId;
  snapshot(token: typeof MetaDoc, id: ConversationId, context: Context): Promise<{ delegates?: boolean } | undefined>;
  snapshot(
    token: typeof SessionsDoc,
    id: ConversationId,
    context: Context
  ): Promise<SessionsState | undefined>;
};

export const spawnGuard: Extension = ({
  name: SPAWN_GUARD,
  tools: [],
  hooks: [
    {
      task: "tool",
      handlers: {
        beforeTool: async (call: { readonly name: string; readonly arguments?: unknown }, api: GuardApi, context: Context) => {
          if (call.name !== "session") return undefined;
          // `arguments` is already validated against the tool's schema by the time hooks run, so a
          // missing `action` cannot happen here, but this stays total anyway.
          const args = (call.arguments ?? {}) as { action?: unknown; kind?: unknown };
          if (args.action !== "spawn") return undefined;
          const meta = await api.snapshot(MetaDoc, api.conversationId, context);
          if (meta?.delegates === false) return { block: DELEGATION_OFF };
          // Only a worker counts against the loop guards; a peer is an explicit, visible session.
          if (args.kind === "peer") return undefined;
          const state = (await api.snapshot(SessionsDoc, api.conversationId, context)) ?? {
            generation: 0,
            items: {},
            spawnedAt: [],
          };
          const refusal = spawnRefusal(state, Date.now());
          return refusal === undefined ? undefined : { block: spawnRefusalText(refusal) };
        },
      },
    },
  ],
});

/** Tick now then on an interval; overlapping ticks are skipped; errors are logged, not thrown. */
export const startCrewSupervisor = (
  harness: Harness,
  storage: Storage,
  intervalMs = 2_000
): CrewSupervisor => {
  let busy = false;
  const runOnce = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      return await tick(harness, storage);
    } catch (error) {
      console.error("[hearth] crew supervisor tick failed:", error instanceof Error ? error.message : error);
      return 0;
    } finally {
      busy = false;
    }
  };
  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce };
};
