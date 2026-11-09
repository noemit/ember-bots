import * as React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** One labelled fact about the item: which model, when it was queued, how big the file is. */
export type TrayItemFact = { label: string; value: React.ReactNode };

type Props = {
  open: boolean;
  title: string;
  /** Everything the row truncates, verbatim: newlines kept, wrapped, scrollable. */
  text: string;
  facts?: TrayItemFact[];
  /** Files that ride with the item, by name and size. */
  attachments?: Array<{ filename: string; detail?: string }>;
  /** A reason the item is stuck (a failed enqueue) — shown above the text, not instead of it. */
  warning?: string;
  /** Extra actions beside Close (Edit, Send now, …). Reading itself never changes anything. */
  actions?: React.ReactNode;
  onClose: () => void;
};

/**
 * The read-only view of one tray item.
 *
 * It carries a title and no description. The description used to promise "nothing here changes what
 * will be sent", which stopped being true the moment a note's dialog became an editor — and a
 * promise that has to be qualified per tray is worse than none.
 *
 * Clicking a queued message used to offer nothing but its editor, whose Save enqueues the new text
 * and withdraws the original — so reading a long message meant opening an operation you did not
 * want. This shows the whole thing and changes nothing; editing is a separate button that opens the
 * editor on the same item.
 */
const TrayItemDialog = ({ open, title, text, facts, attachments, warning, actions, onClose }: Props) => (
  <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
    <DialogContent className="w-[620px] sm:max-w-[620px]">
      <DialogHeader>
        {/* The title is the dialog's accessible name: no description is rendered, so there is no
            empty element for a screen reader to announce. */}
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {warning ? (
        <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">{warning}</p>
      ) : null}
      <pre className="max-h-[46vh] overflow-auto rounded-md bg-muted/40 px-3 py-2 font-sans text-[12.5px] leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
      {attachments && attachments.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-[11.5px] text-muted-foreground">
          {attachments.map((file) => (
            <li key={file.filename} className="truncate">
              {file.filename}
              {file.detail ? ` · ${file.detail}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {facts && facts.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
          {facts.map((fact) => (
            <React.Fragment key={fact.label}>
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 truncate text-foreground">{fact.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      <DialogFooter>
        {actions}
        <Button variant="ghost" onClick={onClose}>
          <X />
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default TrayItemDialog;
