import { canonicalVariant } from './modelSelection';
import { modelRefKey } from '../types';
import type {
  FileAttachment,
  ModelOption,
  QueuedMessageSendConfig,
  QueuedMessage,
  QueuedMessageContext,
} from '../types';

/**
 * The server-owned queue has no edit: any change to a queued row is "enqueue the new text, then
 * remove the old row(s)". These helpers work out what the replacement says and which row's
 * send config (agent/model/variant) and queue position it inherits, so the UI and the hook agree.
 */

/** A queued row's readable text: OpenChamber sends both, Hearth only `text`. */
export const queuedItemText = (item: QueuedMessage): string =>
  item.text.trim() || item.content.trim();

/**
 * Whether two queued rows are the same message.
 *
 * The queue has no edit, so a replacement is enqueued first and the original withdrawn after; between
 * those two moments the optimistic local row and the host's row for the same message can both be on
 * screen — measured in the pi mock: the new text drawn twice for ~200ms, in 3 of 40 samples, on a
 * plain enqueue and on an edit alike. A poll cannot recognise the local row by id (it has none until
 * the host answers), so this is how it recognises it: same text, same mode, same number of files.
 *
 * Deliberately not a fuzzy match: two identical messages queued back to back must stay two rows, which
 * is why the caller consumes **one** local row per served row rather than dropping every match.
 */
export const sameQueuedMessage = (a: QueuedMessage, b: QueuedMessage): boolean =>
  queuedItemText(a) === queuedItemText(b) &&
  queuedItemMode(a) === queuedItemMode(b) &&
  a.attachments.length === b.attachments.length;

/** Join two texts with a blank line, dropping empty sides. */
export const mergeTexts = (a: string, b: string): string => {
  const joined = [a.trim(), b.trim()].filter((part) => part.length > 0);
  return joined.join('\n\n');
};

/** Combine every item's text in queue order. */
export const mergeAll = (items: readonly QueuedMessage[]): string =>
  items.reduce((merged, item) => mergeTexts(merged, queuedItemText(item)), '');

/** What the UI asks the queue hook to replace: an edit (one id) or a merge (two or more). */
export type QueueReplaceRequest = {
  itemIds: readonly string[];
  /** Absent keeps the original config; an empty variant explicitly clears the old effort. */
  modelSelection?: { modelId: string; variant: string };
  /** Overrides the joined text (the edit dialog's Save); omit to merge the rows. */
  text?: string;
  /** The row whose queue position the replacement keeps. Defaults to the upper item. */
  survivorId?: string;
};

export type QueueMergePlan = {
  /** The merged text, one paragraph per item, in queue order. */
  text: string;
  /**
   * The upper (or, for a merge-all, the first) item. The replacement takes its mode, model,
   * variant and agent mention, so a merge never silently changes who answers or how.
   */
  leader: QueuedMessage;
  /** Every row the merge consumes, in queue order. All of them are removed after the enqueue. */
  ids: string[];
  /** The row whose queue position the replacement keeps. */
  survivorId: string;
  /** Attachments from all merged rows that still carry their payload (the rest cannot be resent). */
  attachments: FileAttachment[];
  /** Context from all merged rows, in queue order. */
  queuedContext: QueuedMessageContext[];
};

/**
 * Resolve a merge of `ids` against the queue as it currently stands. `survivorId` picks which row's
 * position the replacement keeps (the lower row for "merge up"); it defaults to the upper item.
 * A single id is the edit case: one row replaced by its own new text. Returns null when the ids do
 * not name distinct queued rows.
 */
export const planQueueMerge = (
  items: readonly QueuedMessage[],
  ids: readonly string[],
  survivorId?: string
): QueueMergePlan | null => {
  if (ids.length === 0 || new Set(ids).size !== ids.length) return null;
  const ordered = items.filter((item) => ids.includes(item.id));
  if (ordered.length !== ids.length) return null;
  const leader = ordered[0];
  const survivor = survivorId && ordered.some((item) => item.id === survivorId)
    ? survivorId
    : leader.id;
  return {
    text: mergeAll(ordered),
    leader,
    ids: ordered.map((item) => item.id),
    survivorId: survivor,
    attachments: ordered.flatMap((item) =>
      item.attachments.flatMap((file) =>
        file.dataUrl ? [{ filename: file.filename, mime: file.mimeType, url: file.dataUrl }] : []
      )
    ),
    queuedContext: ordered.flatMap((item) => item.context),
  };
};

/** Merge the row at `index` into the row above it, keeping the lower row's position. */
export const mergeUpPlan = (
  items: readonly QueuedMessage[],
  index: number
): QueueMergePlan | null => {
  if (index <= 0 || index >= items.length) return null;
  return planQueueMerge(items, [items[index - 1].id, items[index].id], items[index].id);
};

/** Merge the whole queue into one row at the first item's position. */
export const mergeAllPlan = (items: readonly QueuedMessage[]): QueueMergePlan | null => {
  if (items.length < 2) return null;
  return planQueueMerge(items, items.map((item) => item.id), items[0].id);
};

/**
 * How an instance will dispatch a queued row when the running turn ends. Hearth tags steers in its
 * inbox; a queue row without a reported mode is a follow-up, which is what the queue is for.
 */
export const queuedItemMode = (item: QueuedMessage): 'follow-up' | 'steer' =>
  item.mode === 'steer' ? 'steer' : 'follow-up';

/** The dispatch mode as the edit dialog prints it. */
export const queuedModeLabel = (item: QueuedMessage): string =>
  queuedItemMode(item) === 'steer' ? 'steer, sends immediately' : 'follow-up';

/**
 * The queue's id order after the replacement lands: the rows the merge consumed are gone and the
 * new item sits where `survivorId` was, so a merge does not reshuffle the queue.
 */
export const queueOrderAfterMerge = (
  items: readonly QueuedMessage[],
  plan: QueueMergePlan,
  newId: string
): string[] => {
  const consumed = new Set(plan.ids);
  const survivorIndex = items.findIndex((item) => item.id === plan.survivorId);
  const before = items
    .slice(0, Math.max(survivorIndex, 0))
    .filter((item) => !consumed.has(item.id)).length;
  const kept = items.map((item) => item.id).filter((id) => !consumed.has(id));
  return [...kept.slice(0, before), newId, ...kept.slice(before)];
};

/** Validate an explicit edit against this host's catalogue without substituting a model or effort. */
export const queueReplacementConfig = (
  original: QueuedMessageSendConfig,
  selection: QueueReplaceRequest['modelSelection'],
  models: readonly ModelOption[]
): { config: QueuedMessageSendConfig; error: string | null } => {
  const key = selection?.modelId ?? modelRefKey(original);
  const model = models.find((entry) => modelRefKey(entry) === key);
  if (!model) return { config: original, error: `Selected model ${key} is unavailable. Refresh models or choose another model; Ember will not substitute one.` };
  const variant = selection ? selection.variant : original.variant ?? '';
  const canonical = canonicalVariant(model.details.variants, variant);
  if (canonical === undefined) return { config: original, error: `Selected reasoning level ${variant} is unavailable for ${key}. Choose a supported level; Ember will not change it automatically.` };
  return { config: selection ? { ...original, providerID: model.providerID, modelID: model.modelID, variant: canonical } : original, error: null };
};
