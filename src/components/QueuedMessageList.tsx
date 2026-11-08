import * as React from 'react';
import { motion } from 'motion/react';
import { ArrowUp, ChevronDown, ChevronUp, Merge, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { springTransition } from '@/lib/animation';
import { cn } from '@/lib/utils';
import { mergeAllPlan, mergeUpPlan, queuedItemText, type QueueReplaceRequest } from '../lib/queueMerge';
import { modelLabel } from '../lib/modelLabel';
import EditQueuedMessageDialog from './EditQueuedMessageDialog';
import TrayItemDialog from './TrayItemDialog';
import TrayRow from './TrayRow';
import type { MessageQueueSession, ModelOption, QueuedMessage } from '../types';

type Props = {
  queue: MessageQueueSession | null;
  models: ModelOption[];
  instanceId?: string;
  defaultModelId?: string | null;
  instanceDefaultModelId?: string | null;
  onSetInstanceDefault?: (model: ModelOption) => void;
  onModelsRefresh?: () => Promise<unknown> | void;
  onSendQueued: (itemId: string) => Promise<boolean>;
  onMoveQueued: (itemId: string, direction: -1 | 1) => Promise<boolean>;
  onRemoveQueued: (itemId: string) => Promise<boolean>;
  onParkQueued: (itemId: string) => Promise<boolean>;
  /** Replace queued rows with one item: the edit dialog's Save, or a merge. */
  onReplaceQueued: (request: QueueReplaceRequest) => Promise<boolean>;
  onRetryQueued: (itemId: string) => Promise<boolean>;
  onDiscardQueued: (itemId: string) => boolean;
};

const ICON_BUTTON = 'size-5 rounded text-muted-foreground hover:bg-muted hover:text-foreground';

/**
 * When the row was queued, in words. A host that sends no timestamp (or a clock that disagrees) gets
 * no line at all rather than "queued 20,761 days ago".
 */
const queuedWhen = (at: number | undefined): string | null => {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 * 7) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

/**
 * The queue, as the open shelf section: one line per message, click to read it, actions on hover.
 *
 * Two things changed from the card this replaced. Rows no longer repeat the word "Queue" (the tab
 * above them says it), and reading is separated from editing: a row opens a read-only view, because
 * the queue has no edit operation and the editor's Save re-enqueues the row under a new id. The rare
 * actions — park it as a note, merge into the row above, withdraw — live behind "…" so a row is a
 * sentence and its frequent verbs, not six words of chrome.
 */
export default function QueuedMessageList({
  queue,
  models,
  instanceId,
  defaultModelId,
  instanceDefaultModelId,
  onSetInstanceDefault,
  onModelsRefresh,
  onSendQueued,
  onMoveQueued,
  onRemoveQueued,
  onParkQueued,
  onReplaceQueued,
  onRetryQueued,
  onDiscardQueued,
}: Props) {
  // Queue mutations round-trip to the server; lock the row so a double-click can't fire two.
  const [busyQueueItemId, setBusyQueueItemId] = React.useState<string | null>(null);
  // The row the edit dialog is open on. Editing is a replace, so the dialog owns the text and the
  // list only hands it the row. `pinned` records that the row was still queueing when the dialog
  // opened: it then lands under a server id, and the dialog keeps the row it was opened with rather
  // than closing under the person's typing.
  const [editing, setEditing] = React.useState<{ item: QueuedMessage; pinned: boolean } | null>(null);
  const [readingId, setReadingId] = React.useState<string | null>(null);
  const setEditingItem = (item: QueuedMessage) => setEditing({ item, pinned: Boolean(item.pending) });
  const runQueueAction = async (itemId: string, action: () => Promise<boolean>) => {
    if (busyQueueItemId) return;
    setBusyQueueItemId(itemId);
    try {
      await action();
    } finally {
      setBusyQueueItemId((current) => (current === itemId ? null : current));
    }
  };

  const queueItems = queue?.items ?? [];
  const editingItem = editing
    ? queueItems.find((item) => item.id === editing.item.id) ?? (editing.pinned ? editing.item : null)
    : null;
  const readingItem = readingId ? queueItems.find((item) => item.id === readingId) ?? null : null;

  // The same `provider / model · level` the transcript footer shows, built by the same helper so the
  // row and the footer cannot drift.
  const queuedModelLabel = (item: QueuedMessage): string => {
    const option = models.find(
      (candidate) =>
        candidate.providerID === item.sendConfig.providerID &&
        candidate.modelID === item.sendConfig.modelID
    );
    return modelLabel({
      providerID: item.sendConfig.providerID,
      modelID: option?.details.name ?? item.sendConfig.modelID,
      variant: item.sendConfig.variant,
    });
  };

  if (queueItems.length === 0) return null;

  const mergeAllTargets = queueItems.filter((item) => item.mode !== 'steer');

  return (
    <>
      <ol className="flex max-h-28 min-w-0 flex-col gap-0.5 overflow-y-auto" aria-label="Queued messages">
          {queueItems.map((item, index) => {
            const sendingItem = queue?.sendingId === item.id;
            const pending = Boolean(item.pending);
            const failed = Boolean(item.error);
            const busy = sendingItem || busyQueueItemId === item.id || pending;
            const reorderLocked = Boolean(queue?.sendingId) || busyQueueItemId !== null;
            // A steer is a real inbox item too: it waits for the running turn to pause, then joins
            // it. It is not a follow-up, so it is withdrawn (Cancel) rather than sent again, edited,
            // parked or merged — every one of those would either duplicate it or change what the
            // host already agreed to do with it.
            const steer = item.mode === 'steer';
            const preview =
              item.text.trim() ||
              item.content.trim() ||
              `${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}`;
            // One line, but it must still say what rides with the message: an attachment on a queued
            // row is invisible until it is sent, and that is exactly when it is too late to notice.
            // A steer row keeps its attachments count (they ride with it) and nothing else: the
            // trailing spinner says it is held, and a sentence here would take the line away from
            // the message itself.
            const modelNote = steer ? null : pending ? 'queueing…' : queuedModelLabel(item);
            const meta =
              item.attachments.length > 0 || modelNote ? (
                <span className="flex items-center gap-1.5">
                  {item.attachments.length > 0 ? (
                    <span>
                      {item.attachments.length} file{item.attachments.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  {modelNote ? <span>{modelNote}</span> : null}
                </span>
              ) : null;
            const canEdit =
              !steer &&
              !sendingItem &&
              busyQueueItemId === null &&
              Boolean(item.text.trim() || item.content.trim());
            const mergeUp = () => {
              const plan = mergeUpPlan(queueItems, index);
              return plan
                ? onReplaceQueued({ itemIds: plan.ids, survivorId: plan.survivorId })
                : Promise.resolve(false);
            };

            return (
              <motion.li
                key={item.id}
                layout="position"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={springTransition}
                data-queued-id={item.id}
                className={failed ? 'rounded-md bg-destructive/10' : undefined}
              >
                <TrayRow
                  text={preview}
                  meta={meta}
                  busy={pending || sendingItem}
                  waiting={steer && !failed}
                  waitingLabel={steer ? 'Waiting for the turn to pause' : undefined}
                  detail={item.error}
                  openLabel={`Read queued message: ${preview.slice(0, 60)}`}
                  onOpen={() => setReadingId(item.id)}
                  actions={
                    failed ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => void runQueueAction(item.id, () => onRetryQueued(item.id))}
                          aria-label={`Retry queueing this message: ${preview.slice(0, 60)}`}
                          title="Retry queueing this message"
                          className="px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Retry
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onDiscardQueued(item.id)}
                          aria-label={`Discard this message: ${preview.slice(0, 60)}`}
                          title="Discard this message"
                          className="px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        {pending ? null : (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={reorderLocked || index === 0}
                              onClick={() => void runQueueAction(item.id, () => onMoveQueued(item.id, -1))}
                              aria-label={`Move queued message up: ${preview.slice(0, 60)}`}
                              title="Move up"
                              className={ICON_BUTTON}
                            >
                              <ChevronUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={reorderLocked || index === queueItems.length - 1}
                              onClick={() => void runQueueAction(item.id, () => onMoveQueued(item.id, 1))}
                              aria-label={`Move queued message down: ${preview.slice(0, 60)}`}
                              title="Move down"
                              className={ICON_BUTTON}
                            >
                              <ChevronDown />
                            </Button>
                            {steer ? null : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                disabled={busy}
                                onClick={() => void runQueueAction(item.id, () => onSendQueued(item.id))}
                                aria-label={`Send queued message now: ${preview.slice(0, 60)}`}
                                title="Send now and steer the current turn"
                                className={`${ICON_BUTTON} hover:text-highlight`}
                              >
                                <ArrowUp />
                              </Button>
                            )}
                          </>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={!canEdit}
                          onClick={() => setEditingItem(item)}
                          aria-label={`Edit queued message: ${preview.slice(0, 60)}`}
                          title={pending ? 'Edit this message; the change applies once it has queued' : 'Edit this message'}
                          className={ICON_BUTTON}
                        >
                          <Pencil />
                        </Button>
                        {/* Withdrawing is the common queue action, so it stays on the row; parking and
                            merging are the rare ones and live behind "…". A row that is still being
                            enqueued has no server id yet, so it has no withdraw — and offering one
                            would put two "Cancel" rows on screen for one message while the host
                            answers. */}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={busy || pending}
                          onClick={() => void runQueueAction(item.id, () => onRemoveQueued(item.id))}
                          aria-label={`${
                            steer
                              ? 'Withdraw the message waiting for the turn to pause'
                              : 'Cancel queued message'
                          }: ${preview.slice(0, 60)}`}
                          title={steer ? 'Withdraw it from the conversation' : 'Cancel this message'}
                          className={cn(ICON_BUTTON, 'hover:text-destructive', pending && 'hidden')}
                        >
                          <Trash2 />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`More actions for queued message: ${preview.slice(0, 60)}`}
                              title="More actions"
                              className={ICON_BUTTON}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            {steer ? null : (
                              <DropdownMenuItem
                                onSelect={() => void runQueueAction(item.id, () => onParkQueued(item.id))}
                              >
                                <Send className="size-3.5" />
                                Park it as a note
                              </DropdownMenuItem>
                            )}
                            {/* Merging the first row would have nothing to merge into. */}
                            {pending || index === 0 ? null : (
                              <DropdownMenuItem onSelect={() => void runQueueAction(item.id, mergeUp)}>
                                <Merge className="size-3.5" />
                                Merge into the one above
                              </DropdownMenuItem>
                            )}

                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )
                  }
                />
              </motion.li>
            );
          })}
      </ol>
      {mergeAllTargets.length > 3 ? (
        <div className="mt-0.5 flex items-center gap-2 px-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busyQueueItemId !== null || Boolean(queue?.sendingId)}
            onClick={() => {
              const plan = mergeAllPlan(mergeAllTargets);
              if (!plan) return;
              void runQueueAction(plan.leader.id, () =>
                onReplaceQueued({ itemIds: plan.ids, survivorId: plan.survivorId })
              );
            }}
            aria-label={`Merge all ${mergeAllTargets.length} queued messages into one`}
            title="Merge every queued follow-up into one (keeps the first one's model and mode)"
            className="px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Merge />
            Merge all queued messages
          </Button>
        </div>
      ) : null}
      {readingItem ? (
        <TrayItemDialog
          open
          title="Queued message"
          text={queuedItemText(readingItem)}
          warning={readingItem.error}
          facts={[
            {
              label: 'Sends as',
              value:
                readingItem.mode === 'steer'
                  ? 'A steer — when the turn pauses'
                  : 'A follow-up — after this turn',
            },
            { label: 'Model', value: queuedModelLabel(readingItem) },
            ...(queuedWhen(readingItem.createdAt)
              ? [{ label: 'Queued', value: queuedWhen(readingItem.createdAt) }]
              : []),
          ]}
          attachments={readingItem.attachments.map((file) => ({
            filename: file.filename,
            detail: file.size ? `${Math.round(file.size / 1024)} KB` : undefined,
          }))}
          actions={
            readingItem.mode === 'steer' ? null : (
              <Button
                variant="outline"
                disabled={Boolean(readingItem.pending) || busyQueueItemId !== null}
                onClick={() => {
                  const target = readingItem;
                  setReadingId(null);
                  setEditing({ item: target, pinned: Boolean(target.pending) });
                }}
              >
                <Pencil />
                Edit
              </Button>
            )
          }
          onClose={() => setReadingId(null)}
        />
      ) : null}
      {editingItem ? (
        <EditQueuedMessageDialog
          item={editingItem}
          models={models} instanceId={instanceId} directory={queue?.directory} defaultModelId={defaultModelId} instanceDefaultModelId={instanceDefaultModelId} onSetInstanceDefault={onSetInstanceDefault} onModelsRefresh={onModelsRefresh}
          modelLabel={queuedModelLabel(editingItem)}
          busy={busyQueueItemId !== null}
          onCancel={() => setEditing(null)}
          onSave={(next, modelSelection) => {
            // Close first: the replacement is in flight and a second Save would enqueue twice.
            const target = editingItem.id;
            setEditing(null);
            void runQueueAction(target, () =>
              onReplaceQueued({ itemIds: [target], text: next, survivorId: target, modelSelection })
            );
          }}
        />
      ) : null}
    </>
  );
}
