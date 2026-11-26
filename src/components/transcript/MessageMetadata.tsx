import * as React from 'react';
import { MessageCircleQuestion, Reply, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hasMarkdownToCopy, messageMarkdown } from '../../lib/messageMarkdown';
import { modelLabel } from '../../lib/modelLabel';
import { validateQuoteAnchor } from '../../lib/quoteLinks';
import type { MessageQuoteLink } from '../../lib/quoteLinkScope';
import type { ChatMessage, QuoteAnchor, QuoteLink, TokenUsage } from '../../types';
import CopyButton from '../CopyButton';
import Linkify from '../Linkify';
import { formatDuration, formatTokens } from './blocks';

export const cacheSummary = (tokens: TokenUsage | undefined): string | null => {
  if (!tokens) return null;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (tokens.cacheRead > 0 && prompt > 0) {
    return `${Math.round((tokens.cacheRead / prompt) * 100)}% cached`;
  }
  if (tokens.cacheWrite > 0) return `cache written ${formatTokens(tokens.cacheWrite)}`;
  return null;
};

export const tokensPerSecond = (message: ChatMessage): number | null => {
  if (!message.tokens || message.createdAt === undefined || message.completedAt === undefined) return null;
  const seconds = (message.completedAt - message.createdAt) / 1000;
  if (seconds <= 0 || message.tokens.output <= 0) return null;
  return message.tokens.output / seconds;
};

export const formatCost = (cost: number): string => {
  if (!(cost > 0)) return '$0';
  const decimals = cost < 0.1 ? 4 : cost < 1 ? 3 : 2;
  return `$${cost.toFixed(decimals)}`;
};

export const relativeTimeAgo = (timestamp: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const ReceivedTime = ({ timestamp }: { timestamp: number }) => {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="flex-none text-muted-foreground" title={new Date(timestamp).toLocaleString()}>
      · {relativeTimeAgo(timestamp, now)}
    </span>
  );
};

export const isAssistantTurnEnd = (
  messages: ChatMessage[],
  index: number,
  turnPending: boolean
): boolean => {
  const message = messages[index];
  if (message?.role !== 'assistant' || messages[index + 1]?.role === 'assistant') return false;
  return index < messages.length - 1 || !turnPending;
};

export const CopyAsMarkdown = ({ message }: { message: ChatMessage }) => (
  <CopyButton text={() => messageMarkdown(message)} done="Copied as Markdown" />
);

export const MessageFooter = ({
  message,
  showMetadata,
  showCost = true,
  onReply,
}: {
  message: ChatMessage;
  showMetadata: boolean;
  showCost?: boolean;
  onReply?: (message: ChatMessage) => void;
}) => {
  const duration =
    showMetadata &&
    message.createdAt !== undefined &&
    message.completedAt !== undefined &&
    message.completedAt > message.createdAt
      ? formatDuration(message.completedAt - message.createdAt)
      : null;
  const model = showMetadata ? modelLabel(message.model) : null;
  const cache = showMetadata ? cacheSummary(message.tokens) : null;
  const tokens = message.tokens;
  const tps = showMetadata ? tokensPerSecond(message) : null;
  const cost = showMetadata && showCost && message.cost !== undefined ? message.cost : null;
  const rawReceived = showMetadata ? message.completedAt ?? message.createdAt : undefined;
  const received = rawReceived !== undefined && rawReceived > 0 ? rawReceived : undefined;
  if (!model && !duration && !cache && tps === null && cost === null && received === undefined) {
    return null;
  }

  return (
    <div
      data-message-footer=""
      className={cn(
        'group/footer flex max-w-[85%] flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[10.5px] text-muted-foreground',
        message.role === 'user' ? 'self-end' : 'self-start'
      )}
    >
      {model ? (
        <span className="min-w-0 truncate" title="Model and thinking level recorded for this reply">
          {model}
        </span>
      ) : null}
      {duration ? <span className="flex-none">· {duration}</span> : null}
      {cache && tokens ? (
        <span
          className="flex flex-none items-center gap-0.5"
          title={`Prompt: ${formatTokens(tokens.input)} fresh, ${formatTokens(tokens.cacheRead)} read from cache, ${formatTokens(tokens.cacheWrite)} written · Output: ${formatTokens(tokens.output)}`}
        >
          <Zap className="size-2.5" aria-hidden="true" />
          {cache}
        </span>
      ) : null}
      {tps !== null ? (
        <span className="flex-none" title="Output tokens per second">
          · {tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s
        </span>
      ) : null}
      {cost !== null ? <span className="flex-none">{`· ${formatCost(cost)}`}</span> : null}
      {received !== undefined ? <ReceivedTime timestamp={received} /> : null}
      {hasMarkdownToCopy(message) ? (
        <span
          data-footer-actions=""
          className="inline-flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover/footer:opacity-100 group-focus-within/footer:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <CopyButton text={() => messageMarkdown(message)} label="Copy message" done="Copied as Markdown" alwaysVisible />
          {onReply ? (
            <button
              type="button"
              aria-label="Reply to this message"
              title="Reply to this message"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onReply(message)}
            >
              <Reply className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

export const SideQuestionCard = ({ summary }: { summary: string }) => (
  <div className="flex max-w-[85%] flex-col gap-1 self-center rounded-lg border border-highlight/30 bg-highlight/[0.04] px-3.5 py-2.5 text-[12.5px]">
    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <MessageCircleQuestion className="size-3.5 flex-none text-highlight" />
      <span>Side question</span>
    </div>
    <p className="whitespace-pre-wrap break-words">
      <Linkify text={summary} />
    </p>
  </div>
);

export const QuoteBacklinks = ({
  links,
  onNavigate,
  message,
}: {
  links: readonly MessageQuoteLink[];
  onNavigate?: (link: QuoteLink, direction: 'source' | 'destination') => void;
  quoteFocus?: QuoteAnchor | null;
  message: ChatMessage;
}) => {
  if (!links.length) return null;
  const controls = links.map(({ link, source }, index) => {
    const stale = source && !validateQuoteAnchor(link.source, [message]).valid;
    return (
      <button
        key={link.id}
        type="button"
        data-quote-link=""
        className="rounded px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted"
        onClick={(event) => {
          event.stopPropagation();
          onNavigate?.(link, source ? 'destination' : 'source');
        }}
        aria-label={
          source
            ? 'Open linked ' + link.destination.kind + ': ' + link.source.quote
            : 'Open quoted source: ' + link.source.quote
        }
      >
        {links.length > 1 ? String(index + 1) + '. ' : ''}
        {source ? 'Open ' + link.destination.kind + ' annotation' : 'Open quoted source'}
        {stale ? ' · source changed' : ''}
      </button>
    );
  });
  return links.length === 1 ? (
    <div data-quote-link="" aria-label="Quote links">
      {controls}
    </div>
  ) : (
    <details data-quote-link="" className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{links.length} linked annotations</summary>
      <div className="flex flex-col" role="group" aria-label="Choose an annotation">
        {controls}
      </div>
    </details>
  );
};
