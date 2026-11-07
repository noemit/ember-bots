import { createHash } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import { InboxDoc, LiveDoc, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import { ApprovalsDoc, type ApprovalsState } from './approvals';
import { QuestionsDoc, type QuestionsState } from './ask';
import { MetaDoc } from './meta';
import { SessionsDoc, isActiveWorker, type CrewEntry, type SessionsState } from './sessions';
import { threadCompletionDue, threadNotice, threadTask } from './threadResults';

type Notice = { name: string; entry: CrewEntry; token: string; kind: 'result' | 'blocker' | 'deadline'; text?: string; blockers?: string[] };

const pendingKeys = (entry: CrewEntry, approvals: ApprovalsState | undefined, questions: QuestionsState | undefined): string[] => [
  ...Object.values(approvals?.items ?? {}).filter((item) => item.status === 'pending').map((item) => `${threadTask(entry)}:approval:${item.key}`),
  ...Object.values(questions?.items ?? {}).filter((item) => item.status === 'pending').map((item) => `${threadTask(entry)}:question:${item.key}`),
].sort();

/** One ordered writer: background outcomes wait for the foreground and its human inbox to clear.
 * The durable submission id closes the submit/receipt crash gap; receipts track delivered versions.
 */
export const resumeThreads = async (
  harness: Harness, leaderId: ConversationId, state: SessionsState, now: number, context: Context
): Promise<number> => {
  const threads = Object.entries(state.items).filter(([, entry]) => entry.delivery === 'thread');
  if (!threads.length || (await harness.snapshot(MetaDoc, leaderId, context))?.archived) return 0;
  const notices: Notice[] = [];
  for (const [name, entry] of threads) {
    if (threadCompletionDue(entry)) {
      notices.push({ name, entry, token: entry.report!.requestId, kind: 'result' });
    }
    if (!isActiveWorker(entry)) continue;
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
  if ((await harness.snapshot(LiveDoc, leaderId, context))?.run) return 0;
  if ((await harness.inspect(context)).submissions.some((item) => item.conversationId === leaderId)) return 0;
  const leader = await harness.conversation(leaderId, context);
  if (!leader) return 0;
  return await harness.commit(async (tx) => {
    // Check again inside admission: a human message or a foreground run arriving after the
    // snapshot gets the next turn. Never queue routine completion behind an active foreground.
    if ((await tx.doc(LiveDoc, leaderId)).run || (await tx.doc(InboxDoc, leaderId)).items.length) return 0;
    const doc = await tx.doc(SessionsDoc, leaderId);
    const admitted: Notice[] = [];
    for (const notice of batch) {
      const entry = doc.items[notice.name];
      if (!entry || threadTask(entry) !== threadTask(notice.entry)) continue;
      if (notice.kind === 'result') {
        if (threadCompletionDue(entry) && entry.report?.requestId === notice.token) admitted.push(notice);
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
      if (!entry || threadTask(entry) !== threadTask(notice.entry)) continue;
      if (notice.kind === 'result') entry.notifiedResult = notice.token;
      if (notice.kind === 'blocker') entry.notifiedBlockers = [...new Set([...(entry.notifiedBlockers ?? []), ...(notice.blockers ?? [])])];
      if (notice.kind === 'deadline') entry.notifiedDeadline = notice.token;
    }
    doc.suspended = false;
    doc.woke = true;
    doc.wokeAt = now;
    return 1;
  }, context);
};
