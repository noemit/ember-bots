import * as React from 'react';
import { motion } from 'motion/react';
import { CircleAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { UNCONFIRMED_SEND_MS, unconfirmedSendMessage } from '../../lib/sendDelivery';
import type { ChatMessage } from '../../types';

const SLOW_SEND_MS = 10_000;

const useSince = (since: number | undefined, after: number): boolean => {
  const elapsed = since !== undefined && Date.now() - since >= after;
  const [shown, setShown] = React.useState(elapsed);
  React.useEffect(() => {
    if (shown || since === undefined) return;
    const remaining = after - (Date.now() - since);
    if (remaining <= 0) {
      setShown(true);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), remaining);
    return () => window.clearTimeout(timer);
  }, [shown, since, after]);
  return shown;
};

const SlowSendNote = ({ since }: { since?: number }) => {
  const shown = useSince(since, SLOW_SEND_MS);
  if (!shown) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="flex items-center gap-1.5 self-end px-1 text-[11px] text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-3 flex-none animate-spin" />
      Still sending…
    </motion.div>
  );
};

const UnconfirmedNote = ({
  message,
  onRetry,
  onDiscard,
}: {
  message: ChatMessage;
  onRetry?: (message: ChatMessage) => void;
  onDiscard?: (message: ChatMessage) => void;
}) => {
  const shown = useSince(message.createdAt, UNCONFIRMED_SEND_MS);
  if (!shown) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 self-end rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground"
    >
      <CircleAlert className="size-3 flex-none text-muted-foreground" />
      <span className="min-w-0">{unconfirmedSendMessage()}</span>
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant="secondary"
          onClick={() => onRetry?.(message)}
          title="The host may already hold this message, so sending it again can leave two copies"
        >
          Send again
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void copyText(message.text)}>
          Copy
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onDiscard?.(message)}>
          Discard
        </Button>
      </div>
    </motion.div>
  );
};

export const DeliveryRow = ({
  message,
  onRetry,
  onDiscard,
  labels,
}: {
  message: ChatMessage;
  onRetry?: (message: ChatMessage) => void;
  onDiscard?: (message: ChatMessage) => void;
  labels?: { retry?: string; discard?: string };
}) => {
  if (!message.delivery) return null;
  if (message.delivery === 'sending') {
    if (message.deliveryNote) {
      return (
        <div className="flex items-center gap-2 self-end px-1 text-[11px] text-muted-foreground" role="status">
          <span>{message.deliveryNote}</span>
        </div>
      );
    }
    return <SlowSendNote since={message.createdAt} />;
  }
  if (message.delivery === 'unconfirmed') {
    return <UnconfirmedNote message={message} onRetry={onRetry} onDiscard={onDiscard} />;
  }
  if (message.delivery === 'queued') {
    return (
      <div className="flex items-center gap-2 self-end px-1 text-[11px] text-muted-foreground" role="status">
        <span>Waiting for the turn to pause.</span>
        {onDiscard ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onDiscard(message)}
            title="Withdraw this message from the host"
            aria-label={`Withdraw this message: ${message.text.slice(0, 60)}`}
          >
            Discard
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 self-end rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[11px] text-foreground"
    >
      <CircleAlert className="size-3 flex-none text-destructive" />
      <span className="min-w-0" title={message.deliveryError}>
        Not sent{message.deliveryError ? `. ${message.deliveryError}` : '.'}
      </span>
      <div className="flex items-center gap-1">
        <Button size="xs" variant="secondary" onClick={() => onRetry?.(message)}>
          {labels?.retry ?? 'Send again'}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void copyText(message.text)}>
          Copy
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onDiscard?.(message)}>
          {labels?.discard ?? 'Discard'}
        </Button>
      </div>
    </div>
  );
};
