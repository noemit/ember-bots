import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Session } from '../types';

export default function ArchiveSessionDialog({
  session,
  crewCount = 0,
  statusUnknown = false,
  instanceLabel,
  onCancel,
  onConfirm,
}: {
  session: Session;
  /** How many crew workers archive with this leader (they are hidden, and running ones stop). */
  crewCount?: number;
  /**
   * The confirmation was asked for because the session's status is unknown, not because something
   * was seen running. The reason has to say which of the two it is: "has ongoing work" would be a
   * claim Ember cannot make here.
   */
  statusUnknown?: boolean;
  /** The instance that did not answer, when it has a name. */
  instanceLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const keepRef = React.useRef<HTMLButtonElement>(null);
  const why = statusUnknown
    ? `“${session.title ?? session.id}” may be working — ${instanceLabel?.trim() || 'its host'} hasn't answered, so Ember can't tell.`
    : `“${session.title ?? session.id}” has ongoing work, queued messages, or a pending request.`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        role="alertdialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Archive active session?</DialogTitle>
          <DialogDescription>
            {why}
            Archiving hides it from active sessions. Ember will not send a stop command.
            You can restore it from the archive or use Undo.
            {crewCount > 0
              ? ` This leader's ${crewCount === 1 ? 'worker' : `${crewCount} workers`} archive with it, and any that are working stop first.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keepRef} variant="secondary" onClick={onCancel}>Keep session</Button>
          <Button onClick={onConfirm}>Archive anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
