import { createHash } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import { InboxDoc, LiveDoc, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import { ApprovalsDoc, type ApprovalsState } from './approvals';
import { QuestionsDoc, type QuestionsState } from './ask';
import { MetaDoc } from './meta';
import { SessionsDoc, isActiveWorker, contextAdvisoryIsCurrent, type CrewEntry, type SessionsState } from './sessions';
import { threadCompletionDue, threadNotice, threadTask } from './threadResults';

type Notice = { name: string; entry: CrewEntry; token: string; kind: 'result' | 'blocker' | 'deadline' | 'context'; text?: string; blockers?: string[] };

const pendingKeys = (entry: CrewEntry, approvals: ApprovalsState | undefined, questions: QuestionsState | undefined): string[] => [
  ...Object.values(approvals?.items ?? {}).filter((item) => item.status === 'pending').map((item) => `${threadTask(entry)}:approval:${item.key}`),
  ...Object.values(questions?.items ?? {}).filter((item) => item.status === 'pending' && item.mode !== 'async').map((item) => `${threadTask(entry)}:question:${item.key}`),
].sort();

/** Exactly one destination, based on durable terminal evidence, never mere idleness. */
export const continuationRecipient = async (
  readMeta: (id: ConversationId) => Promise<import('./meta').HearthMeta | undefined>,
  readLive: (id: ConversationId) => Promise<{ run?: unknown; runFailure?: unknown } | undefined>,
  readCrew: (id: ConversationId) => Promise<SessionsState | undefined>,
  destination: ConversationId, entries: readonly CrewEntry[]
): Promise<ConversationId | undefined> => {
  const meta = await readMeta(destination);
  const live = await readLive(destination);
  // Pre-creator crews may have no metadata on an ordinary root. Preserve that contract.
  if (!meta && !entries.some((entry) => entry.supervisorId !== undefined)) return destination;
  const explicitSupervisor = entries.find((entry) => entry.supervisorId !== undefined && entry.supervisorId !== destination)?.supervisorId;
  const fallback = explicitSupervisor ?? (meta?.lead?.host === 'local' ? meta.lead.conversationId as ConversationId : undefined);
  // Terminal evidence lives with the actual creator, not in the root's membership copy.
  // A legacy nested requester can also keep its old parent while new helpers belong to root.
  const taskOwner = meta?.creatorId !== undefined ? meta.creatorId as ConversationId
    : meta?.lead?.host === 'local' ? meta.lead.conversationId as ConversationId : undefined;
  const ownerCrew = taskOwner === undefined ? undefined : await readCrew(taskOwner);
  const stopped = Object.values(ownerCrew?.items ?? {}).some((entry) => !entry.taskOwner && entry.conversationId === destination && (entry.state === 'stopped' || entry.state === 'failed'));
  const retired = !meta || Boolean(meta.archived) || (!live?.run && Boolean(stopped || live?.runFailure));
  const recipient = retired ? fallback : destination;
  if (recipient === undefined || (retired && recipient === destination)) return undefined;
  const target = await readMeta(recipient);
  return target && !target.archived ? recipient : undefined;
};

/** One ordered writer: background outcomes wait for the foreground and its human inbox to clear.
 * The durable submission id closes the submit/receipt crash gap; receipts track delivered versions.
 */
export const resumeThreads = async (
  harness: Harness, leaderId: ConversationId, state: SessionsState, now: number, context: Context, destination?: ConversationId
): Promise<number> => {
  const allThreads = Object.entries(state.items).filter(([, entry]) => !entry.taskOwner && (entry.delivery === 'thread' || entry.contextAdvisory !== undefined));
  if (!allThreads.length) return 0;
  if (destination === undefined) {
    const destinations = new Set<ConversationId>();
    for (const [, entry] of allThreads) destinations.add(entry.continuationId ?? leaderId);
    let count = 0;
    for (const id of destinations) count += await resumeThreads(harness, leaderId, state, now, context, id);
    return count;
  }
  const threads = allThreads.filter(([, entry]) => (entry.continuationId ?? leaderId) === destination);
  const destinationMeta = await harness.snapshot(MetaDoc, destination, context);
  const recipientId = await continuationRecipient(
    (id) => harness.snapshot(MetaDoc, id, context), (id) => harness.snapshot(LiveDoc, id, context),
    (id) => harness.snapshot(SessionsDoc, id, context), destination, threads.map(([, entry]) => entry));
  if (recipientId === undefined) return 0;
  const notices: Notice[] = [];
  for (const [name, entry] of threads) {
    const advisory = entry.contextAdvisory;
    if (advisory && advisory.task === threadTask(entry) && entry.notifiedContextEpoch !== advisory.epoch) {
      notices.push({ name, entry, token: advisory.epoch, kind: 'context',
        text: `${name}: Kiln estimates ${advisory.tokens} current-context tokens, not lifetime usage. ` +
          `Review the handoff at [worker](/threads/${entry.conversationId}), answer entry ${advisory.answerEntryId}. ` +
          'Prefer a fresh Sol/Luna worker for substantial new work; small completion or explicit override can continue here. ' +
          'Do not automatically spawn or change models. Preserve pending directions and review progress, files, commits, tests, blockers and next steps. ' +
          'This is advisory, not a hard gate or proof the task succeeded.' });
    }
    if (entry.delivery === 'thread' && threadCompletionDue(entry)) {
      notices.push({ name, entry, token: entry.report!.requestId, kind: 'result' });
    }
    if (entry.delivery !== 'thread' || !isActiveWorker(entry)) continue;
    const approvals = await harness.snapshot(ApprovalsDoc, entry.conversationId, context);
    const questions = await harness.snapshot(QuestionsDoc, entry.conversationId, context);
    const pending = pendingKeys(entry, approvals, questions).filter((key) => !entry.notifiedBlockers?.includes(key));
    const token = pending.join(',');
    if (pending.length) {
      notices.push({ name, entry, token, kind: 'blocker', blockers: pending,
        text: `${name}: needs the human; conversation ${entry.conversationId}. Do not answer or approve on their behalf.` });
    } else if (entry.resumeTask === threadTask(entry) && state.deadlineAt !== undefined && now > state.deadlineAt && entry.notifiedDeadline !== threadTask(entry)) {
      notices.push({ name, entry, token: threadTask(entry), kind: 'deadline', text: `${name}: still running past its continuation deadline; conversation ${entry.conversationId}. Inspect status before deciding whether to continue or stop.` });
    }
  }
  // Blockers and failures precede routine results. Bounded batches coalesce nearby completions.
  notices.sort((a, b) => Number(b.kind === 'blocker' || b.entry.state === 'failed') - Number(a.kind === 'blocker' || a.entry.state === 'failed'));
  const batch = notices.slice(0, 32);
  if (!batch.length) return 0;
  if ((await harness.snapshot(LiveDoc, recipientId, context))?.run) return 0;
  if ((await harness.inspect(context)).submissions.some((item) => item.conversationId === recipientId)) return 0;
  const leader = await harness.conversation(recipientId, context);
  if (!leader) return 0;
  return await harness.commit(async (tx) => {
    // Check again inside admission: a human message or a foreground run arriving after the
    // snapshot gets the next turn. Never queue routine completion behind an active foreground.
    if ((await tx.doc(LiveDoc, recipientId)).run || (await tx.doc(InboxDoc, recipientId)).items.length) return 0;
    const doc = await tx.doc(SessionsDoc, leaderId);
    const currentRecipient = await continuationRecipient((id) => id === destination && !destinationMeta ? Promise.resolve(undefined) : tx.doc(MetaDoc, id), (id) => tx.doc(LiveDoc, id),
      (id) => tx.doc(SessionsDoc, id), destination, Object.values(doc.items));
    if (currentRecipient !== recipientId) return 0;
    const admitted: Notice[] = [];
    for (const notice of batch) {
      const entry = doc.items[notice.name];
      if (!entry || threadTask(entry) !== threadTask(notice.entry) || (entry.continuationId ?? leaderId) !== destination) continue;
      if (notice.kind === 'result') {
        if (threadCompletionDue(entry) && entry.report?.requestId === notice.token) admitted.push(notice);
      } else if (notice.kind === 'context') {
        // A summary/reset placed after the worker finished invalidates the old context advice.
        const head = await tx.latestHeadMarker(entry.conversationId);
        const epoch = head ? String(head.id) : 'initial';
        if (!await contextAdvisoryIsCurrent(tx, entry)) {
          // A direct/scheduled input need not pass through rearmWorker. Drop only its stale
          // advisory, never the new input, active task, or once-per-epoch delivery receipt.
          const advice = entry.contextAdvisory;
          if (advice && (await tx.latestEntryId(entry.conversationId) !== (advice.throughEntryId ?? advice.answerEntryId) ||
              (await tx.doc(InboxDoc, entry.conversationId)).items.some((item) => item.mode !== 'write'))) delete entry.contextAdvisory;
        } else if (entry.contextAdvisory?.epoch === notice.token &&
            epoch === notice.token && entry.notifiedContextEpoch !== notice.token &&
            // The same task/epoch can finish another directly submitted bounded assignment
            // between scan and admission. Never receipt the old handoff as the new one's notice.
            entry.contextAdvisory.answerEntryId === notice.entry.contextAdvisory?.answerEntryId &&
            entry.contextAdvisory.throughEntryId === notice.entry.contextAdvisory?.throughEntryId) admitted.push(notice);
      } else if (notice.kind === 'blocker' && isActiveWorker(entry)) {
        // A human may have answered since the scan. Only newly pending request ids need a wake;
        // resolving one of several requests must not re-deliver those already announced.
        const pending = pendingKeys(entry, await tx.doc(ApprovalsDoc, entry.conversationId), await tx.doc(QuestionsDoc, entry.conversationId))
          .filter((key) => !entry.notifiedBlockers?.includes(key));
        if (pending.length) admitted.push({ ...notice, token: pending.join(','), blockers: pending });
      } else if (notice.kind === 'deadline' && isActiveWorker(entry) && entry.resumeTask === threadTask(entry) && doc.deadlineAt !== undefined && now > doc.deadlineAt && entry.notifiedDeadline !== notice.token) admitted.push(notice);
    }
    if (!admitted.length) return 0;
    const key = admitted.map((notice) => `${notice.kind}:${notice.name}:${notice.token}`).sort().join('|');
    const content = threadNotice(admitted.filter((notice) => notice.kind === 'result').map(({ name, entry }) => [name, entry])) +
      '\n' + admitted.flatMap((notice) => notice.text ? [notice.text] : []).join('\n');
    await leader.submit(tx, { type: 'input', content, whenBusy: 'followUp',
      entry: { kind: 'hearth.thread-notice', data: { internal: true, outcomes: admitted.map(({ entry, kind, token }) => ({
        conversationId: String(entry.conversationId), task: threadTask(entry), kind, id: token, status: entry.state,
      })) } },
      requestId: `hearth.threads.resume:${leaderId}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}` });
    for (const notice of admitted) {
      const entry = doc.items[notice.name];
      if (!entry || threadTask(entry) !== threadTask(notice.entry) || (entry.continuationId ?? leaderId) !== destination) continue;
      if (notice.kind === 'result') entry.notifiedResult = notice.token;
      if (notice.kind === 'blocker') entry.notifiedBlockers = [...new Set([...(entry.notifiedBlockers ?? []), ...(notice.blockers ?? [])])];
      if (notice.kind === 'deadline') entry.notifiedDeadline = notice.token;
      if (notice.kind === 'context') entry.notifiedContextEpoch = notice.token;
    }
    for (const id of new Set([leaderId, recipientId])) {
      const waiting = await tx.doc(SessionsDoc, id);
      let pending = false;
      for (const item of Object.values(waiting.items)) {
        const actual = item.taskOwner ? (await tx.doc(SessionsDoc, item.taskOwner.conversationId)).items[item.taskOwner.key] : item;
        if (actual && (actual.continuationId ?? leaderId) === id && actual.resumeTask === threadTask(actual) &&
            (isActiveWorker(actual) || threadCompletionDue(actual))) pending = true;
      }
      waiting.suspended = pending;
    }
    doc.woke = true;
    doc.wokeAt = now;
    return 1;
  }, context);
};
