import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { defineDoc, type ContextView, type Harness, type ConversationId } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';

/** Latest applicable usage plus trailing estimates. A newer summary invalidates old prefix usage. */
export const currentContextOf = (view: Pick<ContextView, 'head' | 'messages'>) => ({
  currentContextTokens: estimateContextTokens(view.messages).tokens,
  currentContextEpoch: view.head === undefined ? 'initial' : String(view.head.id),
});
export const CurrentContextDoc = defineDoc<{
  currentContextTokens?: number;
  currentContextEpoch?: string;
  /** Newest visible entry incorporated by this derivation; readers must reject mismatched anchors. */
  sourceEntryId?: number;
}>({ kind: 'hearth.current-context', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({}), checkpointWhen: () => true });

/** Maintain a tiny durable summary on context-entry commits, never on session-list polls or
 * streaming progress. Existing untouched conversations stay unknown until their next change.
 * Derivation runs off the commit observer, serialized/coalesced per host. Newer entry commits
 * invalidate an in-flight derivation before it can publish stale data.
 */
export const attachCurrentContextTracking = (harness: Harness, context: Context) => {
  const dirty = new Map<ConversationId, number>();
  let revision = 0;
  let closed = false;
  let pending: Promise<void> | undefined;
  const run = async () => {
    while (!closed && dirty.size) {
      const [id, version] = dirty.entries().next().value!;
      const conversation = await harness.conversation(id, context);
      const view = await conversation?.context(context);
      if (view && !closed) {
        const snapshot = currentContextOf(view);
        await harness.commit(async (tx) => {
          if (closed || dirty.get(id) !== version) return;
          Object.assign(await tx.doc(CurrentContextDoc, id), snapshot, {
            sourceEntryId: view.entries.reduce((last, entry) => Math.max(last, entry.id), 0),
          });
        }, context);
      }
      if (dirty.get(id) === version) dirty.delete(id);
    }
  };
  const kick = () => {
    if (closed || pending) return;
    pending = Promise.resolve().then(run).catch((error: unknown) => {
      // A snapshot failure must not fail a turn or manufacture a current size.
      console.error('[kiln] current context snapshot did not refresh:', error instanceof Error ? error.message : error);
      dirty.clear();
    }).finally(() => { pending = undefined; if (dirty.size) kick(); });
  };
  const observation = harness.observeCommits({
    advance(publication) {
      for (const change of publication.changes) {
        // Include metadata-only entries in the anchor so newest-entry comparison stays cheap.
        if (change.type === 'entry') {
          dirty.set(change.value.conversationId, ++revision);
        }
      }
      if (dirty.size) kick();
    },
    end() { closed = true; dirty.clear(); },
  });
  return {
    async drain() { while (pending) await pending; },
    async close() { closed = true; dirty.clear(); observation.detach(); if (pending) await pending; },
  };
};
