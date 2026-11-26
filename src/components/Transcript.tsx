import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, CheckCheck, CircleAlert, History, Loader2, Wrench } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useStableCallback } from '@/lib/useStableCallback';
import { cn } from '@/lib/utils';
import { deriveActivityLabel } from '../lib/activityLabel';
import { galleryForConversation, sameGallery, type ViewerImage } from '../lib/gallery';
import { messageNavigationAction } from '../lib/messageNavigation';
import { entryOrdinal } from '../lib/piMapping';
import { quoteRangeIn } from '../lib/quoteHighlight';
import { validateQuoteAnchor } from '../lib/quoteLinks';
import { EMPTY_QUOTE_LINKS, quoteLinksForMessage, type MessageQuoteLink } from '../lib/quoteLinkScope';
import { isMessageRead } from '../lib/readState';
import { readReceiptDismissIn } from '../lib/readReceiptTimer';
import type { RepairHalt } from '../lib/repairBudget';
import { gestureLeavesBottom, scrollIntent } from '../lib/scrollIntent';
import { deriveSessionStatus } from '../lib/sessionStatus';
import { showUnreadNotifications } from '../lib/sessionUnread';
import { questionKey, type ThreadQuestion } from '../lib/threadQuestions';
import { bundleConsecutiveToolMessages, type ToolDisplay } from '../lib/toolDisplay';
import {
  createReadingGeometryScheduler,
  isHumanReadingMessage,
  type ReadingBounds,
  shouldOfferLastMessageJump,
} from '../lib/transcriptReadingGeometry';
import type { TranscriptNotice } from '../lib/transcriptStatus';
import { shouldShowTimeline, timelineTicksForItems } from '../lib/transcriptTimeline';
import { isTurnLive, outputSignature } from '../lib/turnActivity';
import { isUnreadEligible } from '../lib/unreadDigest';
import type {
  BallState,
  ChatMessage,
  MessagesStatus,
  PermissionReply,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  QuoteAnchor,
  QuoteLink,
  ReasoningDisplay,
  Session,
  SessionReadMark,
} from '../types';
import SessionStatusLine from './SessionStatusLine';
import TranscriptTimeline from './TranscriptTimeline';
import { DIFF_INITIAL_LINE_CAP, DiffView } from './transcript/DiffView';
import { ExpansionContext, spring } from './transcript/expansion';
import {
  cacheSummary,
  formatCost,
  isAssistantTurnEnd,
  MessageFooter,
  relativeTimeAgo,
  tokensPerSecond,
} from './transcript/MessageMetadata';
import { ActivityLabel, MessageRow } from './transcript/MessageRow';
import { PermissionCard, QuestionCard } from './transcript/PromptCards';

export {
  cacheSummary,
  DIFF_INITIAL_LINE_CAP,
  DiffView,
  formatCost,
  isAssistantTurnEnd,
  MessageFooter,
  PermissionCard,
  relativeTimeAgo,
  tokensPerSecond,
};

type Props = {
  findRequest?: number;
  quoteLinks?: QuoteLink[];
  quoteSessionKey?: string | null;
  onNavigateQuote?: (link: QuoteLink, direction: 'source' | 'destination') => void;
  quoteFocus?: QuoteAnchor | null;
  messages: ChatMessage[];
  messagesStatus: MessagesStatus;
  /**
   * What the fetch state should say. Decided by `src/lib/transcriptStatus.ts` so that a fetch Ember
   * retries reads as waiting, and only a settled failure is presented as one.
   */
  fetchNotice?: TranscriptNotice;
  /**
   * True once a full read of this session has landed, so the tail window is known to sit on top of
   * real history. False means the text above may simply not have been fetched yet.
   */
  historyComplete?: boolean;
  /**
   * Fetch the rest of a history the client knows it has not fully loaded. Without it the missing
   * history line is a fact with no way out; the button only appears when the caller can act.
   */
  onLoadEarlier?: () => void | Promise<void>;
  /**
   * Set when Ember has stopped repairing this session by itself (see `lib/repairBudget`), because a
   * full read cannot succeed for it. The missing-history line then says so and offers the one thing
   * that still works — the host's own compaction — instead of a "Load them" that retries a request
   * that is already known to fail.
   */
  repairHalt?: RepairHalt | null;
  /** Compact the session on the host, which is what actually shrinks a history past the cap. */
  onCompact?: () => void;
  compacting?: boolean;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  threadQuestions?: ThreadQuestion[];
  onOpenThread?: (source: Session) => void;
  state: BallState;
  sending: boolean;
  /** The session's title, as the column header shows it; names the chat in the activity line. */
  sessionTitle?: string;
  /** The instance's label, so an unanswered status can say which host went quiet. */
  instanceLabel?: string;
  /** Stable conversation key used to reset scrolling and ephemeral reading feedback. */
  seed: string;
  /** Drop tool-call rows from every message. */
  hideToolCalls: boolean;
  /** How thinking blocks render: open, collapsed, or dropped. */
  reasoningDisplay: ReasoningDisplay;
  /** Show the question & answer (`ask`) blocks. */
  showQuestions: boolean;
  /** Open tool rows expanded instead of on click. */
  expandToolCalls: boolean;
  /** `collapsed` folds a turn's tool calls behind one line; `list` draws a row per group. */
  toolDisplay: ToolDisplay;
  /** Whether this host reports spend; false hides every cost in the footer. */
  showCost?: boolean;
  /** Explicit per-message read state. Navigation never changes it. */
  readMark?: SessionReadMark;
  /** Hide unread prompts and read receipts, not messages or explicit read-state evidence. */
  notificationsMuted?: boolean;
  /** Mark only the message whose bubble was pressed. */
  onMarkRead?: (message: ChatMessage) => void;
  onUndoMarkRead?: (message: ChatMessage) => void;
  /**
   * Put a reply back in front of the reader: that reply and everything after it become unread again.
   * The inverse of `onMarkRead`, offered from the message's right-click menu.
   */
  onMarkUnread?: (message: ChatMessage) => void;
  /**
   * Whether this conversation manages unread state at all.
   *
   * A worker thread has none: its unread state is invisible everywhere (the rail hides workers, the
   * digest skips them), so the read controls are not passed to it. This says so explicitly rather
   * than inferring it from a missing callback, because "Mark as unread" must also be withheld from
   * a draft, where the message does not exist on a host yet.
   */
  canManageUnread?: boolean;
  /** Mark the entire session read, including older unloaded messages. */
  onMarkAllRead?: () => void;
  /** Quote this message in the composer's existing reply context. */
  onReply?: (message: ChatMessage) => void;
  /** The per-turn footer metadata (model, duration, tokens, cost, time). */
  showMessageDetails: boolean;
  /** A leader's crew workers; the status line reports a wait on the ones still in flight. */
  crew?: Session[];
  /** Their ball states, from the instance status poll. */
  workerState?: (worker: Session) => BallState;
  /** The scrub rail down the transcript's edge (hidden automatically on short chats). */
  showActivityRail: boolean;
  compactSpacing: boolean;
  /** Pin to the bottom while a reply streams. */
  autoFollow: boolean;

  focusMessageId: string | null;
  focusRequest: number;
  /** Re-send an optimistic message the server never confirmed, with its original input. */
  onRetryPendingSend?: (message: ChatMessage) => void;
  /** Remove an optimistic message the server never confirmed. */
  onDiscardPendingSend?: (message: ChatMessage) => void;
  /**
   * A new agent's session is still being created, so there is nothing but the draft's one message
   * to show. The activity line says so, and the bubble's note names the message that is waiting.
   */
  creating?: boolean;
  /**
   * The failed bubble's two ways out, when they are not the usual ones. The draft's failed create
   * keeps the message exactly as a failed send does, but "Send again" is the wrong verb for
   * starting a session and "Discard" is the wrong one for putting the draft back in the composer.
   */
  pendingSendLabels?: { retry?: string; discard?: string };
  onPermission: (request: PermissionRequest, reply: PermissionReply) => Promise<boolean>;
  /** `null` answers means the user dismissed the question. */
  onQuestion: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
};

/** How close to the bottom (px) still counts as "following" the conversation. */
const FOLLOW_THRESHOLD = 48;
/** How long after wheel/touch/key input a scroll away from the bottom still counts as the reader's. */
const USER_SCROLL_WINDOW = 600;


function Transcript({
  findRequest = 0,
  quoteLinks = [],
  quoteSessionKey,
  onNavigateQuote,
  quoteFocus,
  messages,
  messagesStatus,
  fetchNotice,
  historyComplete = false,
  onLoadEarlier,
  repairHalt = null,
  onCompact,
  compacting = false,
  permissions,
  questions,
  threadQuestions = [],
  onOpenThread,
  state,
  sending,
  sessionTitle,
  instanceLabel,
  seed,
  hideToolCalls,
  reasoningDisplay,
  showQuestions,
  expandToolCalls,
  toolDisplay,
  showCost = true,
  readMark,
  notificationsMuted = false,
  onMarkRead,
  onUndoMarkRead,
  onMarkUnread,
  canManageUnread = false,
  onMarkAllRead,
  onReply,
  showMessageDetails,
  crew = [],
  workerState,
  showActivityRail,
  compactSpacing,
  autoFollow,
  focusMessageId,
  focusRequest,
  onRetryPendingSend,
  onDiscardPendingSend,
  creating = false,
  pendingSendLabels,
  onPermission,
  onQuestion,
}: Props) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const messageRefs = React.useRef(new Map<string, HTMLDivElement>());
  const followRef = React.useRef(true);
  const [following, setFollowing] = React.useState(true);
  /**
   * Whether this opened session has had its one opening scroll.
   *
   * Opening a conversation should land on its latest turn. Every *other* scroll is decided by
   * `followRef` (the reader is at the bottom) and `autoFollow` (the setting) — a message arriving
   * must never move a reader who scrolled back, which is what used to happen: the pin effect
   * depended on `scrollToBottom`, whose identity changed with `items.length`, so every arrival
   * re-ran the effect and scrolled unconditionally.
   */
  const openedRef = React.useRef(false);
  /** Read through refs so `scrollToBottom` keeps one identity across appends. */
  const itemsCountRef = React.useRef(0);
  const virtualizedRef = React.useRef(false);
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<string | null>(null);
  const [highlightRequest, setHighlightRequest] = React.useState(0);
  const previousPendingCountRef = React.useRef(0);
  const expansion = React.useRef(new Map<string, boolean>());
  const [find, setFind] = React.useState<string | null>(null);
  const [findIndex, setFindIndex] = React.useState(0);
  const findInput = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!findRequest) return;
    setFind((current) => current ?? '');
    const frame = requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, [findRequest]);
  const previousBundledByIdRef = React.useRef(new Map<string, { base: ChatMessage; message: ChatMessage }>());
  const items = React.useMemo(() => {
    const visible = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) =>
        message.role === 'user' || message.error ||
        message.parts.some(
          (part) =>
            (part.type === 'text' && Boolean(part.text.trim())) ||
            part.type === 'file' ||
            (part.type === 'tool' &&
              (part.call.tool === 'ask'
                ? showQuestions
                : !hideToolCalls || Boolean(part.call.images?.length))) ||
            (part.type === 'reasoning' && Boolean(part.text.trim()) && reasoningDisplay !== 'hidden')
        )
      );
    const bundled = bundleConsecutiveToolMessages(visible, {
      toolDisplay,
      hideToolCalls,
      reasoningHidden: reasoningDisplay === 'hidden',
      showQuestions,
    });
    const nextBundled = new Map<string, { base: ChatMessage; message: ChatMessage }>();
    const stabilized = bundled.map((item) => {
      const base = messages[item.index];
      if (!base || item.message === base) return item;
      const prev = previousBundledByIdRef.current.get(item.message.id);
      const reused =
        prev &&
        prev.base === base &&
        prev.message.parts.length === item.message.parts.length &&
        prev.message.parts.every((part, partIndex) => part === item.message.parts[partIndex])
          ? prev.message
          : item.message;
      nextBundled.set(item.message.id, { base, message: reused });
      return reused === item.message ? item : { ...item, message: reused };
    });
    previousBundledByIdRef.current = nextBundled;
    return stabilized;
  }, [messages, hideToolCalls, reasoningDisplay, showQuestions, toolDisplay]);
  // Preserve row identity between polls so read controls and measured heights stay stable.
  const [readAll, setReadAll] = React.useState(false);
  /**
   * The column opens on a tail read (the last ~10 messages and their tool calls) rather than the
   * whole transcript, so a long session paints immediately. When the full read is still in flight
   * the text above the window is genuinely missing, and a transcript that just *starts* mid-way
   * reads as data loss. The flag says so out loud, in the space where the older messages will land.
   */
  /**
   * Whether the text above the window is still missing.
   *
   * This used to require `messagesStatus !== 'ready'`, which was wrong: a *tail* read commits as
   * ready, so on a reopen the transcript rendered its last twenty entries with no indication that
   * the rest was absent — it simply looked like the conversation started there. The honest signal is
   * whether a full read has landed for this session, which the caller knows (see `historyComplete`),
   * falling back to the status while no full read has happened at all.
   */
  const hasOlderHistory = messages.length > 0 && !historyComplete;
  const findOpen = find !== null;
  const loadEarlierTriggeredRef = React.useRef(false);
  React.useEffect(() => {
    if (!findOpen || !hasOlderHistory) {
      loadEarlierTriggeredRef.current = false;
      return;
    }
    if (messagesStatus !== 'loading' && !loadEarlierTriggeredRef.current && onLoadEarlier) {
      loadEarlierTriggeredRef.current = true;
      onLoadEarlier();
    }
  }, [findOpen, hasOlderHistory, messagesStatus, onLoadEarlier]);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const focusedIndex = items.findIndex(({ message }) => message.id === focusedId);
  const highlightedIndex = highlightedMessageId ? items.findIndex(({ message }) => message.id === highlightedMessageId) : -1;
  const virtualized = items.length > 80 && !readAll;
  // Kept in refs for the scroll helpers: a dependency on the count would give `scrollToBottom` a new
  // identity per message, and the pin effect would re-install (and scroll) on every append.
  itemsCountRef.current = items.length;
  virtualizedRef.current = virtualized;
  const previousItemKeys = React.useRef<string[]>([]);
  const itemKeys = React.useMemo(() => {
    const keys = items.map(({ message }) => message.id);
    if (keys.length === previousItemKeys.current.length && keys.every((key, index) => key === previousItemKeys.current[index])) return previousItemKeys.current;
    previousItemKeys.current = keys;
    return keys;
  }, [items]);
  const itemKey = React.useCallback((index: number) => itemKeys[index], [itemKeys]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 110,
    getItemKey: itemKey,
    overscan: 8,
    rangeExtractor: React.useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = defaultRangeExtractor(range);
      const extras = [focusedIndex, highlightedIndex].filter((index) => index >= 0);
      return extras.length === 0 ? indices : [...new Set([...indices, ...extras])].sort((a, b) => a - b);
    }, [focusedIndex, highlightedIndex]),
    enabled: virtualized,
  });
  const latestUserIndex = React.useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) if (isHumanReadingMessage(items[index].message)) return index;
    return -1;
  }, [items]);
  const previousUserIds = React.useRef<string[]>([]);
  const userMessageIdList = React.useMemo(() => {
    const ids = items.filter(({ message }) => isHumanReadingMessage(message)).map(({ message }) => message.id);
    if (ids.length === previousUserIds.current.length && ids.every((id, index) => id === previousUserIds.current[index])) {
      return previousUserIds.current;
    }
    previousUserIds.current = ids;
    return ids;
  }, [items]);
  const [showLastMessageJump, setShowLastMessageJump] = React.useState(false);
  const updateReadingGeometry = useStableCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const viewport = scroller.getBoundingClientRect();
    const latestId = userMessageIdList[userMessageIdList.length - 1];
    let bounds: ReadingBounds | undefined;
    const users: ReadingBounds[] = [];
    for (const id of userMessageIdList) {
      const node = messageRefs.current.get(id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      users.push(rect);
      if (id === latestId) bounds = rect;
    }
    const latest = items[latestUserIndex];
    if (!bounds && virtualized && latest) {
      const measurement = virtualizer.measurementsCache[latestUserIndex];
      const history = contentRef.current?.querySelector('[data-message-history]');
      if (measurement && history) {
        const origin = history.getBoundingClientRect().top;
        bounds = { top: origin + measurement.start, bottom: origin + measurement.end };
      }
    }
    setShowLastMessageJump(shouldOfferLastMessageJump(viewport, bounds, users));
  });
  const readingGeometryScheduler = React.useMemo(
    () => createReadingGeometryScheduler(updateReadingGeometry),
    [updateReadingGeometry]
  );
  React.useLayoutEffect(() => {
    readingGeometryScheduler.flush();
  }, [seed, items.length, userMessageIdList, virtualized, compactSpacing, readingGeometryScheduler]);
  React.useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return () => readingGeometryScheduler.cancel();
    const schedule = () => readingGeometryScheduler.schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(content);
    scroller.addEventListener('scroll', schedule, { passive: true });
    return () => {
      readingGeometryScheduler.cancel();
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
    };
  }, [readingGeometryScheduler]);
  // Marks for the scrub rail, derived from the same visible items the list renders (so a tick's
  // index is directly a `jumpToIndex` argument).
  const railTicks = React.useMemo(
    () => (showActivityRail ? timelineTicksForItems(items, messages) : []),
    [items, messages, showActivityRail]
  );
  const railVisible = showActivityRail && shouldShowTimeline(railTicks);
  const railActiveIndex = focusedIndex >= 0 ? focusedIndex : highlightedIndex >= 0 ? highlightedIndex : null;

  // One gallery for the whole conversation: the viewer's next/previous cross message boundaries.
  const previousGalleryRef = React.useRef<ViewerImage[]>([]);
  const conversationGallery = React.useMemo(() => {
    const next = galleryForConversation(messages);
    if (sameGallery(previousGalleryRef.current, next)) return previousGalleryRef.current;
    previousGalleryRef.current = next;
    return next;
  }, [messages]);
  const getQuoteLinksForMessage = React.useMemo(() => {
    if (!quoteSessionKey || quoteLinks.length === 0) {
      return () => EMPTY_QUOTE_LINKS;
    }
    const cache = new Map<string, readonly MessageQuoteLink[]>();
    return (messageId: string): readonly MessageQuoteLink[] => {
      const cached = cache.get(messageId);
      if (cached) return cached;
      const computed = quoteLinksForMessage(quoteLinks, quoteSessionKey, messageId);
      cache.set(messageId, computed);
      return computed;
    };
  }, [quoteLinks, quoteSessionKey]);
  const findMatches = React.useMemo(() => find?.trim() ? items.flatMap((item, index) =>
    (item.sourceIndices ?? [item.index]).some(source => {
      const message = messages[source];
      const reasoning = message.parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join('\n');
      const tools = message.parts
        .filter((part): part is Extract<typeof part, { type: 'tool' }> => part.type === 'tool')
        .map((part) => `${part.call.title ?? ''} ${part.call.output ?? ''}`)
        .join('\n');
      return `${message.text}\n${reasoning}\n${tools}\n${message.error ?? ''}`.toLowerCase().includes(find.toLowerCase());
    }) ? [index] : []
  ) : [], [find, items, messages]);
  const jumpToIndex = useStableCallback((index: number, align: 'start' | 'center' = 'center') => {
    if (!items[index]) return;
    followRef.current = false;
    setFollowing(false);
    setHighlightedMessageId(items[index].message.id);
    setHighlightRequest(request => request + 1);
    const positionMessage = () => {
      const message = messageRefs.current.get(items[index].message.id);
      const scroller = scrollRef.current;
      if (align === 'start' && message && scroller) {
        scroller.scrollTop += message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 28;
      } else message?.scrollIntoView({ block: 'center' });
    };
    if (virtualized) {
      virtualizer.scrollToIndex(index, { align });
      window.requestAnimationFrame(() => {
        virtualizer.scrollToIndex(index, { align });
        positionMessage();
      });
    } else {
      positionMessage();
    }
  });
  const findSignature = findMatches.join(',');
  const jumpToMatch = useStableCallback(() => {
    if (findMatches.length) jumpToIndex(findMatches[findIndex % findMatches.length]);
    else setHighlightedMessageId(null);
  });
  React.useEffect(() => { jumpToMatch(); }, [find, findSignature, findIndex, jumpToMatch]);

  /**
   * Scroll to the end of the transcript.
   *
   * Deliberately stable across renders: the count and the virtualiser flag are read through refs, so
   * this callback's identity does not change when a message arrives. It used to depend on
   * `items.length`, which gave the pin effect below a new dependency every append and made it re-run
   * — and its body scrolled unconditionally, so a reader who had scrolled up was pulled to the
   * bottom by every message that landed.
   */
  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'auto') => {
    const count = itemsCountRef.current;
    if (virtualizedRef.current && count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end' });
    }
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, [virtualizer]);

  // Clicking a thinking block: stop auto-following and nudge the block into view only as far as it
  // needs, so expanding it never yanks the reader down to the bottom.
  const ensureReasoningVisible = React.useCallback((element: HTMLElement | null) => {
    if (!element) return;
    followRef.current = false;
    setFollowing(false);
    window.requestAnimationFrame(() =>
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    );
  }, []);

  const pendingCount = permissions.length + questions.length + threadQuestions.length;
  React.useEffect(() => {
    if (pendingCount > previousPendingCountRef.current) {
      // A new approval or question has to be seen, so it gets one scroll — but it does not re-arm
      // following: a reader who had scrolled back was then dragged along by the rest of the stream.
      window.requestAnimationFrame(() => scrollToBottom('smooth'));
    }
    previousPendingCountRef.current = pendingCount;
  }, [pendingCount, scrollToBottom]);

  const pendingFocus = React.useRef<{ id: string; request: number; attempts: number; loading: boolean; jumped: boolean } | null>(null);
  const [navigationRetry, setNavigationRetry] = React.useState(0);
  const [navigationUnavailable, setNavigationUnavailable] = React.useState(false);
  React.useEffect(() => {
    if (!focusMessageId || !focusRequest) return;
    let pending = pendingFocus.current;
    if (!pending || pending.id !== focusMessageId || pending.request !== focusRequest) {
      pending = { id: focusMessageId, request: focusRequest, attempts: 0, loading: false, jumped: false };
      pendingFocus.current = pending;
      setNavigationUnavailable(false);
    }
    if (pending.jumped) return;
    const index = items.findIndex(({ message, sourceIndices }) => message.id === pending.id || sourceIndices?.some(source => messages[source]?.id === pending.id));
    const action = messageNavigationAction({ found: index >= 0, loading: pending.loading || messagesStatus === 'loading', complete: historyComplete === true, attempts: pending.attempts, canLoad: Boolean(onLoadEarlier) });
    if (action === 'jump') { pending.jumped = true; setNavigationUnavailable(false); jumpToIndex(index); return; }
    if (action === 'unavailable') { setNavigationUnavailable(true); return; }
    if (action !== 'load' || !onLoadEarlier) return;
    pending.loading = true;
    pending.attempts += 1;
    const request = pending;
    void Promise.resolve().then(onLoadEarlier).catch(() => {}).finally(() => {
      if (pendingFocus.current !== request) return;
      request.loading = false;
      // A completed read is a retry boundary even when it returned the same window. New
      // messages also re-run this effect, so the target is mounted and highlighted once found.
      setNavigationRetry((value) => value + 1);
    });
  }, [focusMessageId, focusRequest, items, messages, messagesStatus, historyComplete, onLoadEarlier, jumpToIndex, navigationRetry]);
  const quoteFocusValid = React.useMemo(
    () => Boolean(quoteFocus && validateQuoteAnchor(quoteFocus, messages, quoteSessionKey ?? undefined).valid),
    [quoteFocus, quoteSessionKey, messages]
  );
  React.useEffect(() => {
    const region = scrollRef.current;
    if (!region || !quoteFocus || !quoteFocusValid) return;
    const highlightApi = globalThis.CSS?.highlights;
    const HighlightConstructor = globalThis.Highlight;
    if (!highlightApi || typeof HighlightConstructor !== 'function') return;
    const targetIds = new Set(quoteFocus.spans.map((span) => span.messageId));
    const apply = () => {
      const ranges: Range[] = [];
      for (const span of quoteFocus.spans) {
        const row =
          messageRefs.current.get(span.messageId) ??
          [...region.querySelectorAll('[data-message-id]')].find((element) => element.getAttribute('data-message-id') === span.messageId);
        const element = row ? [...row.querySelectorAll('[data-quote-part-id]')].find((part) => part.getAttribute('data-quote-part-id') === span.partId) : undefined;
        if (!element) continue;
        const range = quoteRangeIn(element, span);
        if (range) { ranges.push(range); element.setAttribute('data-quote-highlighted', 'true'); }
      }
      if (ranges.length) highlightApi.set('ember-quote', new HighlightConstructor(...ranges));
    };
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.target === region || (record.target instanceof Element && record.target.hasAttribute('data-message-history'))) {
          return true;
        }
        const row = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-message-id]');
        return Boolean(row && targetIds.has(row.getAttribute('data-message-id') ?? ''));
      });
      if (relevant) apply();
    });
    observer.observe(region, { childList: true, subtree: true });
    const timer = window.setTimeout(apply, 100);
    apply();
    return () => { observer.disconnect(); window.clearTimeout(timer); highlightApi.delete('ember-quote'); region.querySelectorAll('[data-quote-highlighted]').forEach((element) => element.removeAttribute('data-quote-highlighted')); };
  }, [quoteFocus, quoteFocusValid, focusRequest]);

  React.useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 5000);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId, highlightRequest]);

  // A session opens on its latest turn, once — and switching sessions in the same column opens the
  // new one the same way, with following re-armed (this conversation starts at its end).
  React.useEffect(() => {
    openedRef.current = false;
    followRef.current = true;
    setFollowing(true);
  }, [seed]);

  React.useEffect(() => {
    if (openedRef.current || items.length === 0) return;
    openedRef.current = true;
    scrollToBottom();
    // The virtualiser measures as it paints; one more pass after that frame reaches the true end.
    window.requestAnimationFrame(() => scrollToBottom());
  }, [items.length, scrollToBottom]);

  // Stay pinned **while the reader is at the bottom**; growth from streaming text, tool rows or
  // enter animations all land here via the ResizeObserver rather than per-update effects. Nothing
  // in this effect scrolls on its own: it installs once and asks a question per resize.
  React.useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return;
    const pin = () => {
      if (autoFollow && followRef.current) scrollToBottom();
    };
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    // A smooth scroll still in flight wins over scrollTo calls made during it; re-pin once it settles
    // — but only for a reader who is still following. `pin` already asks that, and `followRef` is
    // false from the moment an upward wheel arrives, so a scroll that *stopped* following is not
    // undone by the event that reports it finished.
    scroller.addEventListener('scrollend', pin);
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scrollend', pin);
    };
  }, [scrollToBottom, autoFollow]);

  // Only the reader can stop following. The virtualizer corrects scrollTop as rows measure and
  // content growth clamps it; those programmatic scrolls must not read as "scrolled up".
  const userScrollAt = React.useRef(0);
  const gestureDirection = React.useRef<'up' | 'down' | null>(null);
  const pointerDown = React.useRef(false);
  const lastScrollTopRef = React.useRef(0);
  /**
   * The viewport and content sizes as of the last scroll event.
   *
   * A scrollTop that falls while these change is the browser clamping a shorter scroll range — the
   * tray folding or an image decoding — and must never be read as the reader
   * scrolling back (`lib/scrollIntent`). Measured before this: 42 messages at ~230ms left the
   * transcript at the top of an 8,428px list with "Jump to latest" showing.
   */
  const lastSizeRef = React.useRef<{ height: number; scroll: number } | null>(null);
  /**
   * Stop following the moment the reader asks to go up, not one scroll event later.
   *
   * `handleScroll` can only decide from a *finished* scroll event, and while a turn is streaming the
   * next chunk's ResizeObserver pin fires in between: measured, a 100px wheel up moved the reader
   * 40px and then pinned for 2.4s until they cleared `FOLLOW_THRESHOLD`, which is what "it is hard
   * to scroll up when you are at the bottom" is. A wheel or touch that pushes upward is unambiguous
   * — nothing else scrolls that way — so it disengages here, before any content can grow.
   */
  const leaveOnUpwardGesture = (deltaY: number | undefined) => {
    userScrollAt.current = Date.now();
    gestureDirection.current = deltaY === undefined || deltaY === 0 ? null : deltaY < 0 ? 'up' : 'down';
    if (deltaY === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    if (!gestureLeavesBottom({ deltaY, following: followRef.current, scrollTop: el.scrollTop })) return;
    followRef.current = false;
    setFollowing(false);
  };
  const noteUserScroll = () => {
    userScrollAt.current = Date.now();
    gestureDirection.current = null;
  };
  const handleScrollKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Editing a question or operating a tool/control is not navigation of this history. Keep this
    // handler local to the scroller so another column's composer cannot release its pin.
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="combobox"], [role="menu"], [role="listbox"]')) return;
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey)) {
      leaveOnUpwardGesture(-1);
    } else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End' || event.key === ' ') {
      leaveOnUpwardGesture(1);
    }
  };
  const lastTouchY = React.useRef<number | null>(null);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const previousSize = lastSizeRef.current;
    const resized =
      previousSize !== null &&
      (previousSize.height !== el.clientHeight || previousSize.scroll !== el.scrollHeight);
    lastSizeRef.current = { height: el.clientHeight, scroll: el.scrollHeight };
    const intent = scrollIntent({
      following: followRef.current,
      gestureDirection: gestureDirection.current,
      previousTop: lastScrollTopRef.current,
      top: el.scrollTop,
      distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
      threshold: FOLLOW_THRESHOLD,
      gestureAgeMs: Date.now() - userScrollAt.current,
      userGesturing: pointerDown.current,
      resized,
      gestureWindowMs: USER_SCROLL_WINDOW,
    });
    lastScrollTopRef.current = el.scrollTop;
    const next = intent === 'follow';
    if (intent === 'ignore') return;
    if (next !== followRef.current) {
      followRef.current = next;
      setFollowing(next);
    }
  };

  const jumpToLatest = () => {
    followRef.current = true;
    setFollowing(true);
    scrollToBottom(virtualized ? 'auto' : 'smooth');
  };

  const showUnreadControls = showUnreadNotifications(notificationsMuted, Boolean(onMarkRead));
  // Presentation rows may combine tool steps. Read eligibility still belongs to the original entry.
  const unreadIndices = React.useMemo(() => items.flatMap(({ message, index: sourceIndex }, index) =>
    isUnreadEligible(messages[sourceIndex]) &&
    !isMessageRead(readMark, entryOrdinal(message.id), message.completedAt ?? message.createdAt ?? 0, message.id)
      ? [index] : []
  ), [items, messages, readMark]);
  const unreadIds = React.useMemo(() => new Set(unreadIndices.map((index) => items[index].message.id)), [items, unreadIndices]);
  /**
   * The read receipt currently on screen, and which way it went.
   *
   * `read` is the "Marked read" receipt with Undo; `unread` is "Marked unread", which has no Undo
   * because the inverse action (marking that reply read again) is a click away on the reply itself.
   * Both share one timer and one appearance time.
   */
  const [receipt, setReceipt] = React.useState<{ message: ChatMessage; version: number; appearedAt: number; kind: 'read' | 'unread' } | null>(null);
  const [readHighlight, setReadHighlight] = React.useState(false);
  const receiptVersion = React.useRef(0);
  const [toastHovered, setToastHovered] = React.useState(false);
  const [toastFocused, setToastFocused] = React.useState(false);
  // Whether this receipt has ever been held. A pointer or focus that arrives and leaves turns a
  // receipt into a *released* one, which goes on the short grace instead of the plain second.
  const [toastReleased, setToastReleased] = React.useState(false);
  React.useEffect(() => {
    setReceipt(null);
    setReadHighlight(false);
  }, [seed, notificationsMuted]);
  React.useEffect(() => {
    if (!receipt) return;
    const highlightTimer = window.setTimeout(() => setReadHighlight(false), 1100);
    return () => window.clearTimeout(highlightTimer);
  }, [receipt]);
  /**
   * When the receipt leaves, as one timer, driven by `readReceiptTimer`'s policy.
   *
   * The previous rule was a flat 5s, reset whenever the pointer moved off — which meant a receipt sat
   * in front of the transcript long after the reader had moved on, and a keyboard user got no hold at
   * all. The policy itself is pure (`readReceiptDismissIn`) and tested; this effect only arms the
   * `setTimeout` it asks for, re-armed whenever the answer can change. No CSS delay is involved, so
   * reduced motion behaves identically.
   */
  React.useEffect(() => {
    if (!receipt) { setToastHovered(false); setToastFocused(false); setToastReleased(false); return; }
    const dismissIn = readReceiptDismissIn({ appearedAt: receipt.appearedAt, now: Date.now(), hovered: toastHovered, focused: toastFocused, released: toastReleased });
    if (dismissIn === 0) {
      // The cap is absolute. Everything else is armed below.
      setReceipt(null);
      return;
    }
    const timer = window.setTimeout(() => setReceipt(null), dismissIn);
    return () => window.clearTimeout(timer);
  }, [receipt, toastHovered, toastFocused, toastReleased]);
  /** Hold while the pointer is over it, or focus is inside it — and remember that it happened. */
  const holdReceipt = (held: boolean) => {
    if (held) { setToastReleased(false); setToastHovered(true); return; }
    setToastHovered(false);
    setToastReleased(true);
  };
  const markMessageRead = useStableCallback((message: ChatMessage) => {
    const original = messages.find((entry) => entry.id === message.id);
    if (showUnreadControls && original && isUnreadEligible(original) && unreadIds.has(original.id) && onMarkRead) {
      onMarkRead(original);
      // A click waits for the selection grace period. Search may have moved to another
      // message meanwhile; clear only this reply's jump styling, not the newer destination.
      setHighlightedMessageId(current => current === original.id ? null : current);
      // One appearance time for the whole receipt: the 5s cap counts from here, not from the last
      // hover, so a resting pointer cannot keep it up for ever.
      setReceipt({ message: original, version: ++receiptVersion.current, appearedAt: Date.now(), kind: 'read' });
      setToastReleased(false);
      setReadHighlight(true);
    }
  });
  /**
   * "Mark as unread": the inverse receipt. The message it acts on does not have to be unread-eligible
   * in the *forward* sense (that gate is about what can be marked read), only that it is a real
   * assistant reply the host owns — which is exactly what the menu offers it for.
   */
  const markMessageUnread = useStableCallback((message: ChatMessage) => {
    const original = messages.find((entry) => entry.id === message.id);
    if (!original || original.role !== 'assistant' || !onMarkUnread) return;
    onMarkUnread(original);
    if (notificationsMuted) return;
    setHighlightedMessageId(current => current === original.id ? null : current);
    setReceipt({ message: original, version: ++receiptVersion.current, appearedAt: Date.now(), kind: 'unread' });
    setToastReleased(false);
    // The receipt's own fade, not the read highlight: nothing was acknowledged, the opposite was.
    setReadHighlight(false);
  });

  const last = messages[messages.length - 1];
  const busy = isTurnLive({ sending, state, last });

  /**
   * How long the live turn has produced nothing.
   *
   * A wedged run and a model reasoning hard look identical from here — both are a live turn with no
   * new output — so the only honest signal is elapsed silence. The signature therefore has to cover
   * *every* part that can produce new output, not just the message's text: reasoning grows one
   * `reasoning` part in place and a tool streams into its own `call.output`, so a signature over
   * `text.length` and the block count alone sat still while minutes of reasoning arrived on screen
   * and reported the run as stuck. `outputSignature` folds the per-part lengths in, as lengths only
   * (never a hash of the message), because this is recomputed on every render of a live turn.
   */
  const liveSignature = busy ? outputSignature(last) : 'idle';
  const quiet = React.useRef({ signature: liveSignature, since: Date.now() });
  if (quiet.current.signature !== liveSignature) {
    quiet.current = { signature: liveSignature, since: Date.now() };
  }
  // A clock, so the status line can age while nothing else re-renders. Five seconds is fine for a
  // message measured in tens of seconds, and costs one interval per open column that is working.
  const [stallClock, setStallClock] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!busy) return;
    setStallClock(Date.now());
    const timer = setInterval(() => setStallClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [busy, liveSignature]);
  const runningTool = last?.role === 'assistant'
    ? [...last.parts]
        .reverse()
        .find((part) => part.type === 'tool' && (part.call.status === 'running' || part.call.status === 'pending'))
    : undefined;
  const blocked = permissions.length > 0 || questions.length > 0;
  const turnPending = busy || blocked;
  const activeSince = last?.createdAt ?? last?.completedAt;

  // The running tool row above already shows the command; this line just says what phase we're in.
  const activityLabel = deriveActivityLabel({
    busy,
    sending,
    lastRole: last?.role,
    lastDelivery: last?.delivery,
    runningTool: runningTool?.type === 'tool' ? runningTool.call.tool : null,
    runningCall: runningTool?.type === 'tool' ? runningTool.call : null,
    prompt: permissions.length ? 'permission' : questions.length ? 'question' : null,
    title: sessionTitle,
    statusUnknown: state === 'unknown',
    creating,
    instanceLabel,
  });
  const waitingOnHistory = messages.length === 0 && messagesStatus !== 'ready';
  const activity = activityLabel && !waitingOnHistory
    ? activityLabel
    : null;
  // The live activity line above already names the running step, so only the states it can't show
  // (an idle session waiting on its crew) get the extra line. A visible prompt card says
  // "needs your reply" far more clearly than a status row would, so it suppresses that state too.
  const derivedStatus = waitingOnHistory
    ? null
    : deriveSessionStatus({
        state,
        busy,
        sending,
        instanceLabel,
        workers: crew,
        workerStateFor: workerState,
        pendingPrompt: permissions.length ? 'permission' : questions.length ? 'question' : null,
        promptCardVisible: blocked,
        quietSince: busy ? quiet.current.since : undefined,
        now: busy ? stallClock : undefined,
      });
  const statusLine = derivedStatus && derivedStatus.kind !== 'working' ? derivedStatus : null;

  const registerNode = React.useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) messageRefs.current.set(id, node);
    else messageRefs.current.delete(id);
  }, []);

  return (
    <ExpansionContext.Provider value={expansion.current}>
    <div className="relative flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFind((current) => current ?? '');
        requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
      }
    }}>
      {items.length > 80 ? <button type="button" className={readAll ? 'p-2 text-left text-xs text-muted-foreground' : 'sr-only focus:not-sr-only focus:p-2'} onClick={() => setReadAll((value) => !value)}>
        {readAll ? 'Return to windowed history' : 'Read all messages without virtualization'}
      </button> : null}
      {find !== null ? <div className="flex items-center gap-2 border-b p-2">
        <Input ref={findInput} autoFocus aria-label="Find in conversation" value={find} onChange={(event) => { setFind(event.target.value); setFindIndex(0); }} onKeyDown={(event) => {
          if (event.key === 'Escape') { setFind(null); setHighlightedMessageId(null); }
          if (event.key === 'Enter') setFindIndex((index) => index + (event.shiftKey ? Math.max(1, findMatches.length - 1) : 1));
        }} />
        {hasOlderHistory ? (
          <span className="whitespace-nowrap text-[11px] text-muted-foreground" role="status">
            {messagesStatus === 'loading' ? 'Searching loaded messages…' : 'Earlier messages not loaded'}
          </span>
        ) : null}
        <span className="whitespace-nowrap text-xs">{findMatches.length ? (findIndex % findMatches.length) + 1 : 0}/{findMatches.length}</span>
        <Button size="xs" variant="ghost" disabled={findMatches.length === 0} aria-label="Previous match" onClick={() => setFindIndex((index) => index + Math.max(1, findMatches.length - 1))}>Prev</Button>
        <Button size="xs" variant="ghost" disabled={findMatches.length === 0} aria-label="Next match" onClick={() => setFindIndex((index) => index + 1)}>Next</Button>
        <Button size="xs" variant="ghost" onClick={() => { setFind(null); setHighlightedMessageId(null); }}>Close</Button>
      </div> : null}
      {navigationUnavailable ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Ember could not find this linked message in the available history. Use Refresh in the session menu to try again, or select an available passage for a new annotation.</p> : null}
      {showUnreadControls && unreadIndices.length > 0 ? (
        <div data-unread-navigation="" className="flex flex-none flex-wrap items-center justify-between gap-x-2 border-b border-highlight/20 bg-highlight/5 px-3 py-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-highlight"
            onClick={() => jumpToIndex(unreadIndices[unreadIndices.length - 1], 'start')}
            title="Go to the newest unread reply without marking it as read"
          >
            New unread messages
            <span className="text-xs tabular-nums text-muted-foreground">{unreadIndices.length}{hasOlderHistory ? '+' : ''}</span>
          </Button>
          {onMarkAllRead && unreadIndices.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={onMarkAllRead}>
              <CheckCheck aria-hidden="true" />
              Mark all as read
            </Button>
          ) : null}
        </div>
      ) : null}
        {hasOlderHistory ? (
          <div
            // **Above the scroller, not inside it.** As the first child of the scrolling pane this line
            // was scrolled out of view whenever a session's kept tail happened to fit on screen — the
            // exact case where a reader has no other clue that history is missing. It is now a slim strip
            // between the Find bar and the transcript, so it is visible at every scroll position and at
            // every content height, which is what the fact needs to be.
            className="flex flex-none flex-wrap items-center justify-center gap-1.5 border-b bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground"
            role="status"
          >
            <History className="size-3 flex-none" aria-hidden="true" />
            {/* A spinner here claimed progress the client could not verify, and spun for ever when
                the full read could not land. Say what is true — this part is not loaded — and give
                the reader the one action that can change it. When the breaker has stopped repairing
                the session, "Load them" would be that same futile request, so the line says why and
                offers the host's compaction instead: it is the only thing that makes the read fit. */}
            {repairHalt ? (
              <>
                <span>
                  {repairHalt.reason === 'too-large'
                    ? "Earlier messages can't be loaded: the full history is larger than Ember reads at once."
                    : "Earlier messages can't be loaded: the read kept failing."}
                </span>
                {onLoadEarlier ? (
                  <Button size="xs" variant="ghost" className="h-5 px-1.5 text-[11px]" onClick={onLoadEarlier}>
                    Load them
                  </Button>
                ) : null}
                {onCompact ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-5 px-1.5 text-[11px]"
                    onClick={onCompact}
                    disabled={compacting}
                    aria-label="Compact context for the model"
                  >
                    {compacting ? 'Compacting…' : 'Compact'}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <span>Earlier messages aren't loaded yet.</span>
                {onLoadEarlier ? (
                  <Button size="xs" variant="ghost" className="h-5 px-1.5 text-[11px]" onClick={onLoadEarlier}>
                    Load them
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {showLastMessageJump ? <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
        <Button size="xs" variant="secondary" className="pointer-events-auto rounded-full shadow-sm" onClick={() => jumpToIndex(latestUserIndex, 'start')}>↑ Jump to your last message</Button>
      </div> : null}
      {!notificationsMuted && receipt ? <div data-read-toast=""
        // Pointer and keyboard are the same hold (see `readReceiptTimer`): either one keeps the
        // receipt up to its cap, and leaving either starts the short grace.
        onPointerEnter={() => holdReceipt(true)} onPointerLeave={() => holdReceipt(false)}
        onFocusCapture={() => { setToastReleased(false); setToastFocused(true); }}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setToastFocused(false); setToastReleased(true); } }}
        className={cn(
          'absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-secondary px-3 py-1 text-xs text-secondary-foreground shadow-sm',
          following ? 'bottom-3' : 'bottom-12'
        )}>
        <span role="status" key={receipt.version}>{receipt.kind === 'read' ? 'Marked read' : 'Marked unread'}</span>
        {/* Undo belongs to the read receipt: it restores the acknowledgement. "Marked unread" needs
            no undo — the control that reverses it is the reply's own mark-as-read dot. */}
        {receipt.kind === 'read' && onUndoMarkRead ? <button type="button" className="rounded px-1 py-1 underline underline-offset-2 focus-visible:outline-2" onClick={() => {
          onUndoMarkRead(receipt.message);
          setReceipt(null);
          setReadHighlight(false);
        }}>Undo</button> : null}
      </div> : null}
      <div ref={scrollRef} tabIndex={0} aria-label="Conversation history" onScroll={handleScroll}
        onWheel={(event) => { if (!event.defaultPrevented && !event.ctrlKey) leaveOnUpwardGesture(event.deltaY); }}
        onTouchMove={(event) => {
          // A finger travelling down the screen pulls the content up: the same intent as a wheel,
          // and the same moment to disengage.
          const y = event.touches[0]?.clientY ?? null;
          const previous = lastTouchY.current;
          lastTouchY.current = y;
          if (y !== null && previous !== null) leaveOnUpwardGesture(previous - y);
          else noteUserScroll();
        }}
        onTouchStart={(event) => {
          lastTouchY.current = event.touches[0]?.clientY ?? null;
          noteUserScroll();
        }}
        onTouchEnd={() => { lastTouchY.current = null; }}
        onKeyDown={handleScrollKey}
        onPointerDown={() => { pointerDown.current = true; noteUserScroll(); }}
        onPointerUp={() => { pointerDown.current = false; noteUserScroll(); }}
        onPointerCancel={() => { pointerDown.current = false; }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pt-7 pb-3 sm:px-5 sm:pb-4" data-transcript-scroll>
        <div
          ref={contentRef}
          data-conversation=""
          role="log"
          aria-label="Conversation"
          aria-live={virtualized || readAll ? 'off' : 'polite'}
          aria-relevant="additions text"
          aria-busy={busy && !blocked}
          className={cn('flex w-full flex-col', compactSpacing ? 'gap-1' : 'gap-2.5')}
        >
          <AnimatePresence initial={false}>
            <div key="history" data-message-history="" style={virtualized ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
            {(virtualized ? virtualizer.getVirtualItems() : items.map((_, index) => ({ index, start: 0 }))).map((row) => {
              const { message, index } = items[row.index];
              return <div key={message.id} role="article" aria-label={`${message.role} message ${index + 1} of ${messages.length}`} data-index={row.index} ref={virtualized ? virtualizer.measureElement : undefined}
                onFocusCapture={() => setFocusedId(message.id)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }}
                className={compactSpacing ? 'pb-1.5' : 'pb-2.5'} style={virtualized ? { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` } : undefined}>
              <MessageRow
                key={message.id}
                message={message}
                quoteLinks={getQuoteLinksForMessage(message.id)}
                onNavigateQuote={onNavigateQuote}
                quoteFocus={quoteFocus}
                readConfirmed={!notificationsMuted && receipt?.message.id === message.id && readHighlight}
                highlighted={highlightedMessageId === message.id}
                highlightRequest={highlightRequest}
                showMetadata={isAssistantTurnEnd(messages, index, turnPending)}
                hideToolCalls={hideToolCalls}
                reasoningDisplay={reasoningDisplay}
                showQuestions={showQuestions}
                expandToolCalls={expandToolCalls}
                toolDisplay={toolDisplay}
                showCost={showCost}
                unread={unreadIds.has(message.id)}
                onMarkRead={showUnreadControls ? markMessageRead : undefined}
                onMarkUnread={canManageUnread && onMarkUnread ? markMessageUnread : undefined}
                onReply={onReply}
                showMessageDetails={showMessageDetails}
                streaming={turnPending && index === messages.length - 1}
                rollupStreaming={turnPending && (items[row.index].sourceIndices ?? [index]).includes(messages.length - 1)}
                gallery={conversationGallery}
                onRetryPendingSend={onRetryPendingSend}
                onDiscardPendingSend={onDiscardPendingSend}
                pendingSendLabels={pendingSendLabels}
                onReasoningToggle={ensureReasoningVisible}
                registerNode={registerNode}
              />
              </div>;
            })}
            </div>

            {permissions.map((request) => (
              <PermissionCard
                key={request.id}
                request={request}
                onReply={(reply) => onPermission(request, reply)}
              />
            ))}

            {questions.map((request) => (
              <QuestionCard
                key={questionKey(request)}
                request={request}
                onAnswer={(answers) => onQuestion(request, answers)}
              />
            ))}

            {threadQuestions.map(({ request, source }) => (
              <section key={questionKey(request)} data-testid="thread-question" aria-label={`Question from thread ${source.title?.trim() || source.id}`}>
                <QuestionCard request={request} source={source} onOpenThread={onOpenThread}
                  onAnswer={(answers) => onQuestion(request, answers)} />
              </section>
            ))}

            {activity ? (
              <motion.div
                key="activity"
                layout="position"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring}
                className="flex max-w-full min-w-0 items-center gap-2 self-start px-1 text-[11.5px] text-muted-foreground"
              >
                {runningTool ? <Wrench className="size-3 flex-none" /> : null}
                <ActivityLabel label={activity} since={activeSince} />
                <span className="animate-pulse">…</span>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <SessionStatusLine status={statusLine} className="-mt-0.5 pl-9 pr-5 sm:pl-10 sm:pr-7" />

          {messages.length === 0 && !blocked && !activity ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-[12px] text-muted-foreground">
              {messagesStatus === 'loading' ? (
                <div className="flex w-full max-w-md flex-col items-center gap-3">
                  <Skeleton className="h-16 w-3/4 self-end rounded-2xl" />
                  <Skeleton className="h-24 w-5/6 self-start rounded-2xl" />
                  <Skeleton className="h-12 w-2/3 self-start rounded-2xl" />
                </div>
              ) : fetchNotice?.kind === 'failed' ? (
                // Only a settled failure (an explicit Refresh that gave up) earns the destructive
                // treatment; the header's Refresh button is the way out.
                <Alert variant="destructive" className="max-w-sm">
                  <CircleAlert className="size-4" />
                  <AlertDescription>{fetchNotice.text}</AlertDescription>
                </Alert>
              ) : fetchNotice?.kind === 'waiting' ? (
                // Expected and transient: neutral wording, a spinner, and no accusation.
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" />
                  {fetchNotice.text}
                </span>
              ) : (
                <span>No messages yet — say hi.</span>
              )}
            </div>
          ) : null}
        </div>
      </div>

      </div>

      {railVisible ? (
        <TranscriptTimeline
          ticks={railTicks}
          total={items.length}
          activeIndex={railActiveIndex}
          onJump={jumpToIndex}
        />
      ) : null}

      {/* Bottom navigation remains separate from explicit read acknowledgement. */}
      <AnimatePresence>
        {!following ? (
          <motion.div
            key="float-row"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            data-float-row=""
            className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-wrap items-center justify-center gap-1.5 px-3"
          >
            {!following ? (
              <Button
                size="xs"
                variant="secondary"
                className="pointer-events-auto rounded-full shadow-md"
                onClick={jumpToLatest}
              >
                <ArrowDown />
                Jump to latest
              </Button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
    </ExpansionContext.Provider>
  );
}

export default React.memo(Transcript);
