import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { promotionNameFor } from '../lib/crew';
import type { Session } from '../types';

/**
 * Human promotion: a worker can't be addressable in place, so promotion
 * forks it into a new ownerless conversation (kind `peer` on the wire) registered under a local
 * name and leaves the worker as history with a `promotedTo` link. The interface calls that result
 * a persistent bot; only the wire keeps saying peer. `busy` mirrors Hearth's 409 gate: a running worker must settle
 * (or be stopped) first, so the confirm stays disabled and the copy says why.
 */
export default function PromoteWorkerDialog({
  worker,
  busy,
  onCancel,
  onConfirm,
}: {
  worker: Session;
  /** The worker is running; Hearth would refuse the promotion with a 409. */
  busy: boolean;
  onCancel: () => void;
  onConfirm(input: { name: string; description?: string; pinned: boolean }): void;
}) {
  const [name, setName] = React.useState(() => promotionNameFor(worker));
  const [description, setDescription] = React.useState('');
  const [pinned, setPinned] = React.useState(true);
  const workerTitle = promotionNameFor(worker);
  const trimmedName = name.trim();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !trimmedName) return;
    const trimmedDescription = description.trim();
    onConfirm({
      name: trimmedName,
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      pinned,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Promote to a persistent bot</DialogTitle>
            <DialogDescription>
              “{workerTitle}” becomes its own bot that others can message by name and that keeps
              running whether or not its parent does.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="promote-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="promote-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Harness improver"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="promote-description" className="text-sm font-medium">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="promote-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this bot is for"
              autoComplete="off"
            />
          </div>
          <label className="flex items-start justify-between gap-3 rounded-md border p-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Pin so other bots can find it</span>
              <span className="text-xs text-muted-foreground">
                Pinned bots stay in the directory permanently; unpinned ones fall out after a day.
              </span>
            </span>
            <Switch checked={pinned} onCheckedChange={setPinned} aria-label="Pin so other bots can find it" />
          </label>
          <p className="text-xs text-muted-foreground">
            This thread stays in its parent’s crew as history; the persistent bot is a new session in the rail.
          </p>
          {busy ? (
            <p id="promotion-blocked-reason" role="status" className="rounded-md bg-muted p-3 text-sm">
              This thread is still working — wait for it to finish, or stop it first.
              Kiln copies saved history into a new bot; it cannot transfer a running turn.
              Choose Back to thread to wait or use its Stop button, then reopen Promote.
            </p>
          ) : !trimmedName ? (
            <p id="promotion-blocked-reason" role="status" className="text-sm text-muted-foreground">
              Enter a name above so other bots can find this bot.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onCancel}>
              {busy ? 'Back to thread' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={busy || !trimmedName} aria-describedby={busy || !trimmedName ? 'promotion-blocked-reason' : undefined}>
              Make persistent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
