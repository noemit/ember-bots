import * as React from 'react';
import { motion } from 'motion/react';
import { MailOpen, Reply } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { ActivityLabel as ActivityLabelValue } from '../../lib/activityLabel';
import { parseCrewReport } from '../../lib/crew';
import type { ViewerImage } from '../../lib/gallery';
import { hasMarkdownToCopy, messageMarkdown } from '../../lib/messageMarkdown';
import { EMPTY_QUOTE_LINKS, type MessageQuoteLink } from '../../lib/quoteLinkScope';
import { foldsIntoRollup, toolRollupIdentity, type ToolDisplay } from '../../lib/toolDisplay';
import type { ChatMessage, QuoteAnchor, QuoteLink, ReasoningDisplay } from '../../types';
import { useImageViewer } from '../imageViewerContext';
import Linkify from '../Linkify';
import MessageReadButton from '../MessageReadButton';
import { formatElapsed, visibleBlocks, type Block, type ToolBlock } from './blocks';
import { DeliveryRow } from './DeliveryStatus';
import { Markdown, MarkdownFallback, spring } from './expansion';
import AskRecord from '../AskRecord';
import { CopyAsMarkdown, CrewReportCard, MessageFooter, QuoteBacklinks } from './MessageMetadata';
import { FileBlock, MessageError, ReasoningRow } from './MessageParts';
import { ToolGroupRow, ToolImages, ToolRollup } from './ToolBlocks';

const renderBlock = (
  message: ChatMessage,
  block: Block,
  reasoningExpanded: boolean,
  expandToolCalls: boolean,
  hideToolCalls: boolean,
  streaming?: boolean,
  overlay?: React.ReactNode,
  onReasoningToggle?: (element: HTMLElement | null) => void,
  onOpenImage?: (image: ViewerImage) => void,
  unreadBadge?: React.ReactNode,
  quoteLinks: readonly MessageQuoteLink[] = EMPTY_QUOTE_LINKS,
  onNavigateQuote?: (link: QuoteLink, direction: 'source' | 'destination') => void,
  quoteFocus?: QuoteAnchor | null
) => {
  const mine = message.role === 'user';
  if (block.type === 'text') {
    const crewReport = mine ? parseCrewReport(block.text) : null;
    if (crewReport) {
      return (
        <motion.div
          key={block.id}
          layout={false}
          initial={false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={spring}
          className="relative self-center"
        >
          <CrewReportCard summary={crewReport.summary} kind={crewReport.kind} />
          {overlay}
        </motion.div>
      );
    }
    return (
      <motion.div
        key={block.id}
        layout={false}
        initial={false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring}
        className={cn(
          'conversation-prose relative',
          mine
            ? 'max-w-[85%] self-end whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-2 text-user-bubble-foreground'
            : 'w-full self-start py-2 text-foreground'
        )}
      >
        <span data-quote-part-id={block.id} className={mine ? 'whitespace-pre-wrap break-words' : undefined}>
          {mine ? (
            <Linkify text={block.text} />
          ) : (
            <React.Suspense fallback={<MarkdownFallback text={block.text} />}>
              <Markdown text={block.text} streaming={streaming} />
            </React.Suspense>
          )}
        </span>
        {unreadBadge}
        {overlay}
        <QuoteBacklinks links={quoteLinks} onNavigate={onNavigateQuote} quoteFocus={quoteFocus} message={message} />
      </motion.div>
    );
  }
  return (
    <motion.div
      key={block.id}
      layout={false}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="flex flex-col"
    >
      {block.type === 'tools' ? (
        hideToolCalls ? (
          <ToolImages calls={block.calls} onOpen={onOpenImage} />
        ) : (
          <ToolGroupRow tool={block.tool} calls={block.calls} defaultOpen={expandToolCalls} onOpen={onOpenImage} />
        )
      ) : block.type === 'ask' ? (
        <AskRecord call={block.call} />
      ) : block.type === 'reasoning' ? (
        <div className="whitespace-pre-wrap break-words">
          <ReasoningRow
            storageKey={`reasoning:${message.id}:${block.id}`}
            partId={block.id}
            text={block.text}
            defaultOpen={reasoningExpanded}
            onToggle={onReasoningToggle}
            streaming={streaming}
          />
        </div>
      ) : (
        <FileBlock
          file={block.file}
          mine={mine}
          onOpen={
            onOpenImage
              ? () =>
                  onOpenImage({
                    id: block.id,
                    url: block.file.url,
                    filename: block.file.filename,
                    mime: block.file.mime,
                  })
              : undefined
          }
        />
      )}
    </motion.div>
  );
};

export type MessageRowProps = {
  message: ChatMessage;
  quoteLinks?: readonly MessageQuoteLink[];
  onNavigateQuote?: (link: QuoteLink, direction: 'source' | 'destination') => void;
  quoteFocus?: QuoteAnchor | null;
  highlighted: boolean;
  readConfirmed: boolean;
  highlightRequest: number;
  showMetadata: boolean;
  hideToolCalls: boolean;
  reasoningDisplay: ReasoningDisplay;
  showQuestions: boolean;
  expandToolCalls: boolean;
  toolDisplay: ToolDisplay;
  showCost: boolean;
  unread?: boolean;
  onMarkRead?: (message: ChatMessage) => void;
  onMarkUnread?: (message: ChatMessage) => void;
  onReply?: (message: ChatMessage) => void;
  showMessageDetails: boolean;
  streaming: boolean;
  rollupStreaming: boolean;
  gallery: ViewerImage[];
  onRetryPendingSend?: (message: ChatMessage) => void;
  onDiscardPendingSend?: (message: ChatMessage) => void;
  pendingSendLabels?: { retry?: string; discard?: string };
  onReasoningToggle: (element: HTMLElement | null) => void;
  registerNode: (id: string, node: HTMLDivElement | null) => void;
};

export const MessageRow = React.memo(function MessageRow({
  message,
  quoteLinks = EMPTY_QUOTE_LINKS,
  onNavigateQuote,
  quoteFocus,
  highlighted,
  readConfirmed,
  highlightRequest,
  showMetadata,
  hideToolCalls,
  reasoningDisplay,
  showQuestions,
  expandToolCalls,
  toolDisplay,
  showCost,
  unread = false,
  onMarkRead,
  onMarkUnread,
  onReply,
  showMessageDetails,
  streaming,
  rollupStreaming,
  gallery,
  onRetryPendingSend,
  onDiscardPendingSend,
  pendingSendLabels,
  onReasoningToggle,
  registerNode,
}: MessageRowProps) {
  const blocks = React.useMemo(
    () => visibleBlocks(message, hideToolCalls, reasoningDisplay, showQuestions),
    [message, hideToolCalls, reasoningDisplay, showQuestions]
  );
  const viewer = useImageViewer();
  const imageGallery = gallery;
  const openImage = React.useCallback(
    (image: ViewerImage) => {
      if (!viewer) return;
      const index = imageGallery.findIndex((entry) => entry.id === image.id);
      if (index >= 0) viewer.open(imageGallery, index);
      else viewer.openOne(image);
    },
    [imageGallery, viewer]
  );
  const ref = React.useCallback(
    (node: HTMLDivElement | null) => registerNode(message.id, node),
    [registerNode, message.id]
  );
  const readGesture = React.useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const menuAllowed = React.useRef(false);
  const selectionAtPress = React.useRef<boolean | null>(null);
  const [, setMenuRefresh] = React.useState(0);
  const setMenuAllowed = React.useCallback((allowed: boolean) => {
    if (menuAllowed.current === allowed) return;
    menuAllowed.current = allowed;
    setMenuRefresh((n) => n + 1);
  }, []);
  const readClickTimer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(readClickTimer.current), [onMarkRead]);
  const isInteractive = (target: EventTarget | null, row: HTMLElement) => {
    const control =
      target instanceof Element
        ? target.closest(
            'a, button, input, textarea, select, option, label, summary, audio, video, img, [data-quote-link], [draggable="true"], [role], [tabindex], [contenteditable]:not([contenteditable="false"])'
          )
        : null;
    return Boolean(control && row.contains(control));
  };
  if (blocks.length === 0 && !message.error) return null;
  const textBlockIndex = blocks.findIndex((block) => block.type === 'text');
  const folding = toolDisplay === 'collapsed' && !hideToolCalls;
  const folded: ToolBlock[] = folding ? (blocks.filter(foldsIntoRollup) as ToolBlock[]) : [];
  const blocksToDraw = folding
    ? blocks.filter((block) => !(block.type === 'tools' && foldsIntoRollup(block)))
    : blocks;
  const copyable = hasMarkdownToCopy(message);

  const unreadBadge =
    message.role === 'assistant' && onMarkRead ? (
      <MessageReadButton unread={unread} onRead={() => onMarkRead(message)} />
    ) : undefined;

  const renderGutter = (horizontalClass: string) =>
    copyable ? (
      <div className={cn('absolute top-2 flex flex-col gap-1', horizontalClass)}>
        <CopyAsMarkdown message={message} />
      </div>
    ) : null;

  const menuEnabled = message.role === 'assistant' && Boolean(onMarkUnread);
  const menuContent = (
    <ContextMenuContent>
      {copyable ? (
        <>
          <ContextMenuItem
            onSelect={() => {
              void copyText(messageMarkdown(message));
            }}
          >
            Copy as Markdown
          </ContextMenuItem>
          {onReply ? (
            <ContextMenuItem onSelect={() => onReply(message)}>
              <Reply aria-hidden="true" />
              Reply
            </ContextMenuItem>
          ) : null}
        </>
      ) : null}
      {menuAllowed.current && onMarkUnread ? (
        <>
          {copyable ? <ContextMenuSeparator /> : null}
          <ContextMenuItem onSelect={() => onMarkUnread(message)}>
            <MailOpen aria-hidden="true" />
            Mark as unread
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );

  const rowBody = (
    <motion.div
      ref={ref}
      layout={false}
      data-message-id={message.id}
      data-read-highlighted={readConfirmed || undefined}
      style={readConfirmed ? { backgroundColor: 'color-mix(in srgb, var(--highlight) 10%, transparent)' } : undefined}
      data-highlighted={highlighted ? 'true' : undefined}
      onPointerDown={(event) => {
        window.clearTimeout(readClickTimer.current);
        readGesture.current =
          event.button === 0 && !isInteractive(event.target, event.currentTarget)
            ? { x: event.clientX, y: event.clientY, dragged: false }
            : null;
        if (event.button === 2) {
          selectionAtPress.current = Boolean(window.getSelection()?.isCollapsed);
          setMenuAllowed(selectionAtPress.current);
        }
      }}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        const remembered = selectionAtPress.current;
        selectionAtPress.current = null;
        setMenuAllowed(remembered ?? Boolean(window.getSelection()?.isCollapsed));
      }}
      onPointerMove={(event) => {
        const gesture = readGesture.current;
        if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) {
          gesture.dragged = true;
        }
      }}
      onPointerCancel={() => {
        readGesture.current = null;
      }}
      onClick={(event) => {
        const gesture = readGesture.current;
        readGesture.current = null;
        if (
          !unread ||
          streaming ||
          !gesture ||
          gesture.dragged ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.detail !== 1 ||
          isInteractive(event.target, event.currentTarget) ||
          !window.getSelection()?.isCollapsed
        )
          return;
        readClickTimer.current = window.setTimeout(() => {
          if (window.getSelection()?.isCollapsed) onMarkRead?.(message);
        }, 300);
      }}
      onDoubleClick={() => window.clearTimeout(readClickTimer.current)}
      className={cn(
        'group/message relative isolate mx-auto flex w-full flex-col gap-1.5 rounded-xl px-5 sm:px-7'
      )}
    >
      {highlighted ? <span key={highlightRequest} aria-hidden="true" className="message-jump-highlight" /> : null}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          message.delivery === 'failed' && 'opacity-60'
        )}
      >
        {blocksToDraw.map((block) => {
          const index = blocks.indexOf(block);
          return renderBlock(
            message,
            block,
            reasoningDisplay === 'expanded' || streaming,
            expandToolCalls,
            hideToolCalls,
            streaming,
            index === textBlockIndex ? renderGutter('-left-6') : undefined,
            onReasoningToggle,
            viewer ? openImage : undefined,
            index === textBlockIndex ? unreadBadge : undefined,
            quoteLinks,
            onNavigateQuote,
            quoteFocus
          );
        })}
        {folded.length > 0 ? (
          <ToolRollup
            key={toolRollupIdentity(message)}
            messageId={toolRollupIdentity(message)}
            blocks={folded}
            expandToolCalls={expandToolCalls}
            onOpen={viewer ? openImage : undefined}
            streaming={rollupStreaming}
          />
        ) : null}
        {message.error ? <MessageError error={message.error} /> : null}
        <DeliveryRow
          message={message}
          onRetry={onRetryPendingSend}
          onDiscard={onDiscardPendingSend}
          labels={pendingSendLabels}
        />
        <MessageFooter
          message={message}
          showMetadata={showMetadata && showMessageDetails}
          showCost={showCost}
          onReply={onReply}
        />
      </div>
      {textBlockIndex < 0 ? (
        <>
          {renderGutter('left-0')}
          {unreadBadge}
        </>
      ) : null}
    </motion.div>
  );

  if (!menuEnabled) return rowBody;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowBody}</ContextMenuTrigger>
      {menuContent}
    </ContextMenu>
  );
});

export const ActivityLabel = ({ label, since }: { label: ActivityLabelValue; since?: number }) => {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {label.title ? <span className="truncate">{label.title}</span> : null}
      <span className="flex-none whitespace-nowrap">
        {label.text}
        {since ? ` · ${formatElapsed(now - since)}` : ''}
      </span>
    </span>
  );
};
