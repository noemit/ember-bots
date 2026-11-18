import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context, JsonValue } from '@earendil-works/chord';
import { defineDoc, InboxDoc, LiveDoc, type ConversationId, type Harness, type SubmissionId, type Tx } from '@earendil-works/pi-durable';
import { MetaDoc } from './meta';
import { parkedInputs, parkInputs } from './parking';
import { applyRunQueueConfigsInTx, QueueConfigDoc, type QueueSendConfig } from './queueConfig';

type SavedInput = { id: string; mode: 'steer' | 'followUp'; content: JsonValue; sendConfig?: QueueSendConfig };
type Handoff = { token: string; stoppedAt: number; ready: boolean; items: SavedInput[] };
/** Ember's submitted human messages use the SDK's plain user input. Custom input entries are
 * host/agent messages with their own delivery contracts, never permission to restart a chat. */
const humanInputs = (
  items: Parameters<typeof parkedInputs>[0],
  queueConfigs?: Readonly<Record<string, QueueSendConfig>>
): SavedInput[] =>
  parkedInputs(items.filter(item => item.mode !== 'write' && !item.entry), queueConfigs) as SavedInput[];
/** A desktop Stop means “end this reply, then take my waiting directions”. Its handoff is
 * durable, unlike the request's background promise. Full stops and worker cancellation do not
 * create this intent. A newer stop or an explicit new submission invalidates the old intent. */
export const StopQueueDoc = defineDoc<{ pending?: Handoff }>({
  kind: 'hearth.stop-queue', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({}), checkpointWhen: () => true,
});

/** Called in the same commit as markWorkerStopped, before abort can finish. */
export const prepareStopQueueHandoff = async (tx: Tx, id: ConversationId, token: string, requested: boolean): Promise<SavedInput[] | undefined> => {
  const doc = await tx.doc(StopQueueDoc, id);
  const meta = await tx.doc(MetaDoc, id);
  const previous = doc.pending;
  delete doc.pending;
  if (!requested || meta.kind === 'worker' || meta.archived || !meta.stoppedAt) return;
  const items = [...(previous?.items ?? [])];
  const seen = new Set(items.map(item => item.id));
  const queueConfigs = (await tx.doc(QueueConfigDoc, id)).items;
  items.push(...humanInputs((await tx.doc(InboxDoc, id)).items, queueConfigs).filter(item => !seen.has(item.id)));
  doc.pending = { token, stoppedAt: meta.stoppedAt, ready: false, items };
  return items;
};

const running = new WeakMap<Harness, Map<ConversationId, { token: string; promise: Promise<number> }>>();

/** One durable stop operation; the server races this against its short response deadline.
 * The supervisor can resume it after a crash without waiting for a provider or inventing input.
 * Per-conversation single flight prevents its callback and the supervisor from aborting twice. */
export const resumeStopQueueHandoff = async (harness: Harness, id: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<number> => {
  const snapshot = (await harness.snapshot(StopQueueDoc, id, context))?.pending;
  if (!snapshot) return 0;
  let map = running.get(harness);
  if (!map) { map = new Map(); running.set(harness, map); }
  const prior = map.get(id);
  if (prior) {
    if (prior.token === snapshot.token) return prior.promise;
    // Let the older abort settle before touching the next operation. Its token gates every write.
    return prior.promise.then(() => resumeStopQueueHandoff(harness, id, context));
  }
  const promise = finish(harness, id, snapshot.token, context).finally(() => {
    if (map.get(id)?.token === snapshot.token) map.delete(id);
  });
  map.set(id, { token: snapshot.token, promise });
  return promise;
};

const finish = async (harness: Harness, id: ConversationId, token: string, context: Context): Promise<number> => {
  const conversation = await harness.conversation(id, context);
  if (!conversation) return 0;
  const intent = await harness.commit(async tx => {
    const doc = await tx.doc(StopQueueDoc, id);
    const meta = await tx.doc(MetaDoc, id);
    const pending = doc.pending;
    if (pending?.token !== token) return;
    if (meta.stoppedAt !== pending.stoppedAt || meta.archived || meta.kind === 'worker') { delete doc.pending; return; }
    return JSON.parse(JSON.stringify(pending)) as Handoff;
  }, context);
  if (!intent) return 0;
  if (!intent.ready) {
    await conversation.abort(context);
    await harness.commit(async tx => {
      const doc = await tx.doc(StopQueueDoc, id);
      if (doc.pending?.token !== token) return;
      const seen = new Set(doc.pending.items.map(item => item.id));
      const queueConfigs = (await tx.doc(QueueConfigDoc, id)).items;
      doc.pending.items.push(...humanInputs((await tx.doc(InboxDoc, id)).items, queueConfigs).filter(item => !seen.has(item.id)));
      doc.pending.ready = true;
    }, context);
  }
  const pending = (await harness.snapshot(StopQueueDoc, id, context))?.pending;
  if (pending?.token !== token) return 0;
  // A snapshot taken just before Stop may already have been placed at a boundary. Never replay
  // that input. Already parked request ids are deduplicated by parkInputs across recovery.
  const unplaced: SavedInput[] = [];
  for (const item of pending.items) {
    const submission = await harness.submission(Number(item.id) as SubmissionId, context);
    const receipt = await submission?.status(context);
    if (receipt?.conversationId === id && receipt.type === 'input' && receipt.status === 'unanswered' && receipt.entry === undefined && receipt.reason === 'aborted') unplaced.push(item);
  }
  const superseded = new Error('The stop was superseded');
  try {
    await parkInputs(change => harness.commit(async tx => {
      const doc = await tx.doc(StopQueueDoc, id);
      const meta = await tx.doc(MetaDoc, id);
      if (doc.pending?.token !== token || meta.stoppedAt !== doc.pending.stoppedAt) throw superseded;
      return change(tx);
    }, context), id, unplaced);
  } catch (error) { if (error === superseded) return 0; throw error; }
  return harness.commit(async tx => {
    const doc = await tx.doc(StopQueueDoc, id);
    const meta = await tx.doc(MetaDoc, id);
    const live = await tx.doc(LiveDoc, id);
    const inbox = await tx.doc(InboxDoc, id);
    if (doc.pending?.token !== token) return 0;
    if (meta.stoppedAt !== doc.pending.stoppedAt || meta.archived || meta.kind === 'worker') { delete doc.pending; return 0; }
    if (live.run) return 0;
    const human = inbox.items.filter(item => item.mode !== 'write' && !item.entry);
    if (!human.length) { delete doc.pending; return 0; }
    // Internal answers have a separate hold/receipt lifecycle. A handoff must never admit one
    // alongside the human input. Normally abort has already withdrawn all such SDK inputs.
    if (inbox.items.some(item => item.mode !== 'write' && item.entry)) return 0;
    // The old turn has no tool boundary left for a pending steer. Treat it as the next normal
    // human turn; normal SDK FIFO then places one message at each subsequent turn boundary.
    for (const item of inbox.items) if (item.mode === 'steer') item.mode = 'followUp';
    const count = human.length;
    await conversation.submit(tx, { type: 'continue', requestId: `hearth.stop-queue:${token}` });
    await applyRunQueueConfigsInTx(tx, id);
    delete meta.stoppedAt;
    delete doc.pending;
    return count;
  }, context);
};
