import YoloLabel from './YoloLabel';
import MessageReadButton from './MessageReadButton';
import { isUnreadEligible } from '../lib/unreadDigest';
import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  Ban,
  Brain,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  FileText,
  History,
  Loader2,
  Megaphone,
  MessageCircleQuestion,
  Reply,
  ShieldAlert,
  Wrench,
  Zap,
} from 'lucide-react';
import Linkify from './Linkify';
import CopyButton from './CopyButton';
import Blob from '../blob/Blob';
import { isTurnLive, outputSignature } from '../lib/turnActivity';
import { parseCrewReport } from '../lib/crew';
import { deriveActivityLabel } from '../lib/activityLabel';
import type { ActivityLabel as ActivityLabelValue } from '../lib/activityLabel';
import { deriveSessionStatus } from '../lib/sessionStatus';
import { modelLabel } from '../lib/modelLabel';
import SessionStatusLine from './SessionStatusLine';
import { galleryForConversation, isRenderableImage, type ViewerImage } from '../lib/gallery';
import TranscriptTimeline from './TranscriptTimeline';
import { shouldShowTimeline, timelineTicks } from '../lib/transcriptTimeline';
import { useImageViewer } from './imageViewerContext';
import { cn } from '@/lib/utils';
import {
  bundleConsecutiveToolMessages,
  countToolCalls,
  foldedToolsLabel,
  foldsIntoRollup,
  type ToolDisplay,
} from '../lib/toolDisplay';
import { isMessageRead } from '../lib/readState';
import { entryOrdinal } from '../lib/piMapping';
import { copyText } from '@/lib/clipboard';
import { useStableCallback } from '@/lib/useStableCallback';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  AvatarIdentity,
  BallMood,
  BallState,
  BlobStyle,
  ChatMessage,
  FileAttachment,
  MessagePart,
  MessagesStatus,
  NestedToolCall,
  PermissionReply,
  PermissionRequest,
  QuestionAnswers,
  QuestionInfo,
  QuestionRequest,
  ReasoningDisplay,
  Session,
  SessionReadMark,
  TokenUsage,
  ToolCall,
} from '../types';
import type { TranscriptNotice } from '../lib/transcriptStatus';
import type { RepairHalt } from '../lib/repairBudget';
import { UNCONFIRMED_SEND_MS } from '../lib/sendDelivery';
import { liveOutputTail } from '../lib/toolTail';
import { hasMarkdownToCopy, messageMarkdown } from '../lib/messageMarkdown';
import { gestureLeavesBottom, scrollIntent } from '../lib/scrollIntent';

const Markdown = React.lazy(() => import('./Markdown'));
const MarkdownFallback = ({ text }: { text: string }) => (
  <span className="whitespace-pre-wrap break-words">{text}</span>
);

type Props = {
  findRequest?: number;
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
  onLoadEarlier?: () => void;
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
  state: BallState;
  sending: boolean;
  /** The session's title, as the column header shows it; names the chat in the activity line. */
  sessionTitle?: string;
  /** The instance's label, so an unanswered status can say which host went quiet. */
  instanceLabel?: string;
  /** The session's blob, shown beside the last message and as the live activity indicator. */
  blobStyle: BlobStyle;
  seed: string;
  identity: AvatarIdentity;
  mood: BallMood;
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
  /** Mark only the message whose bubble was pressed. */
  onMarkRead?: (message: ChatMessage) => void;
  /** Mark the entire session read, including older unloaded messages. */
  onMarkAllRead?: () => void;
  /** Quote this message in the composer's existing reply context. */
  onReply?: (message: ChatMessage) => void;
  /** The per-turn footer metadata (model, duration, tokens, cost, time). */
  showMessageDetails: boolean;
  /** The session blob beside the latest turn. */
  showAvatars: boolean;
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

const spring = { type: 'spring', stiffness: 420, damping: 32 } as const;

const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
};

/** Consecutive text (or reasoning) parts collapse into one block; files and tools stay separate. */
type Block =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'file'; id: string; file: FileAttachment }
  | { type: 'ask'; id: string; call: ToolCall }
  | ToolBlock;

type ToolBlock = { type: 'tools'; id: string; tool: string; calls: ToolCall[] };

const toBlocks = (parts: MessagePart[]): Block[] => {
  const blocks: Block[] = [];
  parts.forEach((part) => {
    const last = blocks[blocks.length - 1];
    if ((part.type === 'text' || part.type === 'reasoning') && last?.type === part.type) {
      last.text += part.type === 'reasoning' ? `\n\n${part.text}` : part.text;
    } else if (part.type === 'text' || part.type === 'reasoning') {
      blocks.push({ type: part.type, id: part.id, text: part.text });
    } else if (part.type === 'file') {
      blocks.push({ type: 'file', id: part.id, file: part.file });
    } else if (part.call.tool === 'ask') {
      // The `ask` tool is the agent's question. Keep it its own block so the Q&A survives being
      // answered (and tool-call hiding), instead of a generic tool row that vanishes.
      blocks.push({ type: 'ask', id: part.id, call: part.call });
    } else if (last?.type === 'tools' && last.tool === part.call.tool) {
      last.calls.push(part.call);
    } else {
      blocks.push({ type: 'tools', id: part.id, tool: part.call.tool, calls: [part.call] });
    }
  });
  return blocks;
};

/** The blocks that survive the current display prefs (hidden thinking/tools drop out). */
const visibleBlocks = (
  message: ChatMessage,
  hideToolCalls: boolean,
  reasoningDisplay: ReasoningDisplay,
  showQuestions: boolean
): Block[] =>
  toBlocks(message.parts).filter(
    (block) =>
      (block.type !== 'tools' || !hideToolCalls || block.calls.some((call) => Boolean(call.images?.length))) &&
      (block.type !== 'reasoning' || reasoningDisplay !== 'hidden') &&
      (block.type !== 'ask' || showQuestions)
  );

const metaString = (metadata: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
};

/** The one thing worth showing for a permission: the command, the file, or the URL. */
const permissionDetail = (request: PermissionRequest): string => {
  const tool = request.permission.toLowerCase();
  const { metadata } = request;
  if (tool === 'bash' || tool === 'shell') return metaString(metadata, ['command', 'cmd', 'script']);
  if (tool === 'webfetch' || tool === 'fetch') return metaString(metadata, ['url', 'uri']);
  const path = metaString(metadata, ['filePath', 'file_path', 'path', 'filename']);
  if (path) return path;
  return request.patterns.join('\n');
};

/** A tool's input as a one-liner when it's a command, otherwise compact JSON. */
const describeInput = (input: Record<string, unknown>): string => {
  const command = input.command;
  if (typeof command === 'string') return command;
  return JSON.stringify(input, null, 2);
};

/** One nested call of a `codemode` script; the shape the host reports per script step. */
type NestedCall = NestedToolCall;

/**
 * The first line of a `codemode` script that actually does something.
 *
 * The header of a codemode row would otherwise read as the raw input JSON, and JSON escaping turns a
 * script into one unreadable line of `\n`s. A leading comment or blank line says nothing about what
 * the script does, so the summary skips them.
 */
const firstScriptLine = (code: string, limit = 80): string => {
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) continue;
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return '';
};

/** A nested call's arguments as a compact preview: one line, cut at a word-ish boundary. */
const nestedArgsPreview = (args: string, limit = 110): string => {
  const flat = args.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
};

const nestedCalls = (call: ToolCall): NestedCall[] => call.nestedCalls ?? [];

const countLabel = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * What a `codemode` or `scratchpad` call should say in its header.
 *
 * Both tools carry their meaning in `input` rather than in a host-provided `title`, so without this
 * they render as `{"code":"..."}` or `{"action":"get","key":"matched"}`. Returns `null` for every
 * other tool, which keeps falling back to the server's title.
 */
const toolSummary = (call: ToolCall): string | null => {
  const nested = nestedCalls(call);
  const code = typeof call.input?.code === 'string' ? firstScriptLine(call.input.code) : '';

  if (call.tool === 'codemode') {
    if (nested.length > 0) {
      const running = nested.find((entry) => entry.status === 'running');
      if (running) return `running ${running.name} (${countLabel(nested.length, 'call')})`;
      const settled = `${nested.length} tool ${nested.length === 1 ? 'call' : 'calls'}`;
      return code ? `${settled} · ${code}` : settled;
    }
    return code || null;
  }

  if (call.tool === 'scratchpad') {
    const action = typeof call.input?.action === 'string' ? call.input.action.trim() : '';
    const key = typeof call.input?.key === 'string' ? call.input.key.trim() : '';
    if (action && key) return `${action} "${key}"`;
    if (action) return action;
    return key ? `"${key}"` : null;
  }

  return null;
};

/** A script, shown as the JavaScript it is rather than as an escaped JSON string. */
const ScriptView = ({ code }: { code: string }) => (
  <div className="flex flex-col gap-1 rounded-md bg-background/70 px-2.5 py-2">
    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">Script</span>
    <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
      {code}
    </pre>
  </div>
);

/** The status glyph for one nested call, matching the tool row's own vocabulary. */
const NestedStatusIcon = ({ status }: { status: NestedCall['status'] }) => {
  if (status === 'ok') return <Check className="size-3 flex-none text-success" />;
  if (status === 'error') return <CircleAlert className="size-3 flex-none text-destructive" />;
  if (status === 'cancelled') return <Ban className="size-3 flex-none text-warning" />;
  return <Loader2 className="size-3 flex-none animate-spin text-muted-foreground" />;
};

const NestedCallRow = ({ call }: { call: NestedCall }) => {
  const args = nestedArgsPreview(call.args);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <NestedStatusIcon status={call.status} />
        <span className="flex-none font-mono text-[11px] text-foreground/90">{call.name}</span>
        {args ? (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/80">{args}</span>
        ) : null}
        {call.durationMs !== undefined ? (
          <span className="ml-auto flex-none tabular-nums text-[10.5px] text-muted-foreground/70">
            {formatDuration(call.durationMs)}
          </span>
        ) : null}
      </div>
      {call.error ? <div className="pl-[1.25rem] text-destructive">{call.error}</div> : null}
    </div>
  );
};

const NestedCallsSection = ({ calls }: { calls: NestedCall[] }) => (
  <div className="flex flex-col gap-1 rounded-md bg-background/70 px-2.5 py-2">
    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      Nested calls ({calls.length})
    </span>
    {calls.map((nested, index) => (
      <NestedCallRow key={`${nested.id}:${index}`} call={nested} />
    ))}
  </div>
);

const panelClass =
  'max-h-64 overflow-auto rounded-md bg-background/70 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all';

const DiffView = ({ diff }: { diff: string }) => (
  <pre className={panelClass}>
    {diff.split('\n').map((line, index) => (
      <span
        key={index}
        className={cn(
          'block',
          line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/15 text-diff-add',
          line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/15 text-diff-del',
          line.startsWith('@@') && 'text-muted-foreground'
        )}
      >
        {line || ' '}
      </span>
    ))}
  </pre>
);

const ExpansionContext = React.createContext<Map<string, boolean> | null>(null);
const useExpansion = (key: string, initial: boolean) => {
  const saved = React.useContext(ExpansionContext);
  const [open, setOpen] = React.useState(() => saved?.get(key) ?? initial);
  const set = (value: boolean | ((previous: boolean) => boolean)) => setOpen((previous) => {
    const next = typeof value === 'function' ? value(previous) : value;
    saved?.set(key, next);
    return next;
  });
  return [open, set] as const;
};

/** Images a tool result returned, rendered inline (also on their own when tool rows are hidden). */
const ToolImages = ({
  calls,
  className,
  onOpen,
}: {
  calls: ToolCall[];
  className?: string;
  onOpen?: (image: ViewerImage) => void;
}) => {
  const images = calls.flatMap((call) =>
    (call.images ?? []).map((file, index) => ({ file, id: `${call.id}:${index}`, tool: call.tool }))
  );
  if (images.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {images.map(({ file, id, tool }) =>
        onOpen ? (
          <button
            key={id}
            type="button"
            onClick={() => onOpen({ id, url: file.url, filename: file.filename, mime: file.mime, tool })}
            className="cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Open ${file.filename}`}
            title={`Open ${file.filename}`}
          >
            <img src={file.url} alt={file.filename} className="max-h-64 max-w-full rounded-xl border" />
          </button>
        ) : (
          <img
            key={id}
            src={file.url}
            alt={file.filename}
            title={file.filename}
            className="max-h-64 max-w-[70%] rounded-xl border"
          />
        )
      )}
    </div>
  );
};

/**
 * The tail of a **running** call's output, shown under its row without being asked.
 *
 * The whole output is already one click away — and that click is the problem: a command that waits
 * for a file, or greps a growing log for minutes, showed a spinner and nothing else while its
 * output arrived behind the expand affordance. Hearth streams it (`api.output()` → the `pi.live`
 * tool slot → `tool_execution_update`), Ember maps it onto the call, so this is only a rendering
 * decision. It is deliberately quiet (muted, monospace, clipped to a few lines): it is evidence that
 * something is happening, not a second transcript.
 *
 * Only while running. A settled call's output belongs in the expanded body, and `call.output` is
 * the same field the live slot fills, so the block is replaced in place by the result rather than
 * blinking away.
 */
const LiveOutputTail = ({ output }: { output?: string }) => {
  const lines = liveOutputTail(output ?? '');
  if (lines.length === 0) return null;
  return (
    <pre
      data-live-tail=""
      className="ml-6 mt-0.5 max-h-16 overflow-hidden rounded-md bg-muted/40 px-2 py-1 font-mono text-[10.5px] leading-snug break-all whitespace-pre-wrap text-muted-foreground"
    >
      {lines.join('\n')}
    </pre>
  );
};

const ToolRow = ({
  call,
  defaultOpen = false,
  onOpen,
}: {
  call: ToolCall;
  defaultOpen?: boolean;
  onOpen?: (image: ViewerImage) => void;
}) => {
  const [open, setOpen] = useExpansion(`tool:${call.id}`, defaultOpen);
  const nested = nestedCalls(call);
  const script = call.tool === 'codemode' && typeof call.input?.code === 'string' ? call.input.code : null;
  const hasDetail = Boolean(call.input || call.output || call.diff || call.error || nested.length > 0);
  const interrupted = call.status === 'interrupted';
  // A codemode/scratchpad call carries its meaning in `input`, so its own summary beats whatever
  // title (often the raw JSON) the host sent.
  const summary = toolSummary(call) ?? call.title;

  return (
    <div className="flex max-w-[85%] flex-col self-start">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground',
          hasDetail && 'hover:bg-muted/60 hover:text-foreground',
          call.status === 'error' && 'text-destructive'
        )}
        title={interrupted ? 'This step was interrupted by the stop' : call.error ?? summary}
      >
        {call.status === 'completed' ? (
          <Check className="size-3 flex-none text-success" />
        ) : call.status === 'error' ? (
          <CircleAlert className="size-3 flex-none" />
        ) : interrupted ? (
          <Ban className="size-3 flex-none text-warning" />
        ) : (
          <Loader2 className="size-3 flex-none animate-spin" />
        )}
        <span className="flex-none font-mono text-[11px]">{call.tool}</span>
        {interrupted ? (
          <span className="flex-none font-normal italic">[step interrupted]</span>
        ) : summary ? (
          <span className="min-w-0 truncate font-mono">{summary}</span>
        ) : null}
        {/* The exit status, when the host reported one. A non-zero exit is often the *answer*
            (`grep` exiting 1 means "no match"), so it is named rather than left to the red dot. */}
        {call.exitCode !== undefined && call.exitCode !== 0 ? (
          <span
            className="flex-none rounded-sm bg-destructive/15 px-1 font-mono text-[10px] leading-4 text-destructive"
            title={`The command exited with code ${call.exitCode}`}
          >
            exit {call.exitCode}
          </span>
        ) : null}
        {hasDetail ? (
          <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
        ) : null}
      </button>

      <ToolImages calls={[call]} className="ml-6 mt-1" onOpen={onOpen} />

      {/* While the call runs, its output as it arrives — no click needed. Expanded, the body below
          already shows all of it. */}
      {!open && call.status === 'running' ? <LiveOutputTail output={call.output} /> : null}

      {open ? (
        <div className="ml-6 mt-1 flex flex-col gap-1.5 text-[11px]">
          {script ? <ScriptView code={script} /> : null}
          {call.input && !call.diff && script === null ? (
            <pre className={panelClass}>{describeInput(call.input)}</pre>
          ) : null}
          {nested.length > 0 ? <NestedCallsSection calls={nested} /> : null}
          {call.diff ? <DiffView diff={call.diff} /> : null}
          {/* Why it failed, one line; the output below it is the whole retained log either way. */}
          {call.error ? <pre className={cn(panelClass, 'text-destructive')}>{call.error}</pre> : null}
          {/* The host keeps a tail (2 000 lines / 50 KB) and says so; without this a short log reads
              as a whole one. */}
          {call.truncated ? (
            <div className="px-1 text-[10.5px] text-muted-foreground/70">
              Earlier output was dropped — this is the tail the host kept.
            </div>
          ) : null}
          {call.output ? <pre className={panelClass}>{call.output}</pre> : null}
          {/* A script's output is cut to the host's token budget; the rest is on disk, so say where
              rather than leaving a truncated log with no way to read the end of it. */}
          {call.fullOutputPath ? (
            <div className="min-w-0 px-1 text-[10.5px] text-muted-foreground/70">
              Full output:{" "}
              <span className="break-all font-mono text-muted-foreground">{call.fullOutputPath}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Every tool call in a turn, folded behind one line.
 *
 * A long agentic turn is mostly tools, and a reader following the prose has to scroll past all of
 * them to find the next sentence. This draws the whole turn as "Using tools (3)…" — the count grows
 * as the turn runs — and puts the usual rows behind a click, so the detail is deferred rather than
 * lost. Images are never folded in: a picture shown by a tool belongs on screen, and `visibleBlocks`
 * keeps those blocks out of here (see `foldsIntoRollup`).
 *
 * The open state is per message and per session (through `useExpansion`), so opening one turn's
 * tools does not open the next turn's, and it survives a re-render or a resize.
 */
const ToolRollup = ({
  messageId,
  blocks,
  expandToolCalls,
  onOpen,
  streaming,
}: {
  messageId: string;
  blocks: ToolBlock[];
  expandToolCalls: boolean;
  onOpen?: (image: ViewerImage) => void;
  streaming: boolean;
}) => {
  const count = countToolCalls(blocks);
  const [open, setOpen] = useExpansion(`rollup:${messageId}`, false);
  const label = foldedToolsLabel(count, { live: streaming });
  // A turn with no tools, or with tool use hidden, draws nothing at all — not an empty line.
  if (count === 0) return null;
  const status = blocks.some((block) => block.calls.some((call) => call.status === 'error'))
    ? 'error'
    : blocks.some((block) => block.calls.some((call) => call.status === 'running' || call.status === 'pending'))
      ? 'running'
      : blocks.some((block) => block.calls.some((call) => call.status === 'interrupted'))
        ? 'interrupted'
        : 'completed';
  return (
    <div className="flex flex-col self-start">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          status === 'error' && 'text-destructive'
        )}
      >
        {status === 'completed' ? (
          <Check className="size-3 flex-none text-success" />
        ) : status === 'error' ? (
          <CircleAlert className="size-3 flex-none" />
        ) : status === 'interrupted' ? (
          <Ban className="size-3 flex-none text-warning" />
        ) : (
          <Loader2 className="size-3 flex-none animate-spin" />
        )}
        <span>{label}</span>
        <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l pl-2">
          {blocks.map((block) => (
            <ToolGroupRow
              key={block.id}
              tool={block.tool}
              calls={block.calls}
              defaultOpen={expandToolCalls}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const groupedToolTitle = (tool: string, count: number): string => {
  const normalized = tool.toLowerCase();
  if (normalized === 'read') return `Read ${count} files`;
  if (normalized === 'edit' || normalized === 'write') return `Edited ${count} files`;
  if (normalized === 'grep' || normalized === 'glob') return `Ran ${count} searches`;
  if (normalized === 'webfetch') return `Fetched ${count} pages`;
  return `${tool} × ${count}`;
};

const ToolGroupRow = ({
  tool,
  calls,
  defaultOpen = false,
  onOpen,
}: {
  tool: string;
  calls: ToolCall[];
  defaultOpen?: boolean;
  onOpen?: (image: ViewerImage) => void;
}) => {
  const [open, setOpen] = useExpansion(`group:${calls[0]?.id}`, defaultOpen);
  if (calls.length === 1) return <ToolRow call={calls[0]} defaultOpen={defaultOpen} onOpen={onOpen} />;
  const status = calls.some((call) => call.status === 'error')
    ? 'error'
    : calls.some((call) => call.status === 'running' || call.status === 'pending')
      ? 'running'
      : calls.some((call) => call.status === 'interrupted')
        ? 'interrupted'
        : 'completed';

  return (
    <div className="flex max-w-[85%] flex-col self-start">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          status === 'error' && 'text-destructive'
        )}
      >
        {status === 'completed' ? (
          <Check className="size-3 flex-none text-success" />
        ) : status === 'error' ? (
          <CircleAlert className="size-3 flex-none" />
        ) : status === 'interrupted' ? (
          <Ban className="size-3 flex-none text-warning" />
        ) : (
          <Loader2 className="size-3 flex-none animate-spin" />
        )}
        <span>{groupedToolTitle(tool, calls.length)}</span>
        {status === 'interrupted' ? (
          <span className="flex-none font-normal italic">[step interrupted]</span>
        ) : null}
        <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l pl-2">
          {calls.map((call) => (
            <ToolRow key={call.id} call={call} defaultOpen={defaultOpen} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The last line or so of a streaming thought, for the collapsed header. Newlines collapse and a
 * long tail is trimmed at a word boundary, so the label reads as a sentence rather than a fragment
 * starting mid-word.
 */
const reasoningTail = (text: string, limit = 90): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(-limit);
  const space = cut.indexOf(' ');
  return `…${space >= 0 ? cut.slice(space + 1) : cut}`;
};

const ReasoningRow = ({
  text,
  storageKey,
  defaultOpen,
  onToggle,
  streaming = false,
}: {
  text: string;
  storageKey: string;
  defaultOpen: boolean;
  onToggle?: (element: HTMLElement | null) => void;
  /** This block is being written right now, not read back from history. */
  streaming?: boolean;
}) => {
  const [open, updateOpen] = useExpansion(storageKey, defaultOpen);
  const setOpen = useStableCallback(updateOpen);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const previousDefault = React.useRef(defaultOpen);
  React.useEffect(() => {
    if (previousDefault.current !== defaultOpen) setOpen(defaultOpen);
    previousDefault.current = defaultOpen;
  }, [defaultOpen, setOpen]);
  return (
    <div ref={rootRef} className="flex max-w-[85%] flex-col self-start">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Expanding can push the block out of view; let the transcript nudge it back minimally.
          if (next) onToggle?.(rootRef.current);
        }}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <Brain className={cn('size-3 flex-none', streaming && 'animate-pulse text-highlight')} />
        <span className="flex-none">{streaming ? 'Thinking…' : 'Thinking'}</span>
        {/* While it is being written, show the end of the sentence: the header becomes a live
            ticker, so a collapsed block still tells you what it is working on instead of sitting
            there as a static label until the turn ends. */}
        {streaming && !open ? (
          <span className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground/70">
            {reasoningTail(text)}
          </span>
        ) : null}
        <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="ml-6 mt-1 rounded-md bg-background/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          {/* Reasoning streams in as raw text, so it is rendered as plain prose while live: parsing
              a growing Markdown document on every delta re-flows the whole block and makes the text
              jump under the reader. It is rendered as Markdown once the turn settles. */}
          <React.Suspense fallback={<MarkdownFallback text={text} />}>
            {streaming ? (
              <span className="whitespace-pre-wrap break-words">{text}</span>
            ) : (
              <Markdown text={text} />
            )}
          </React.Suspense>
          {streaming ? (
            <span aria-hidden="true" className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-highlight align-middle" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const FileBlock = ({
  file,
  mine,
  onOpen,
}: {
  file: FileAttachment;
  mine: boolean;
  onOpen?: () => void;
}) =>
  isRenderableImage(file) ? (
    onOpen ? (
      <button
        type="button"
        onClick={onOpen}
        className={cn('cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-ring', mine ? 'self-end' : 'self-start')}
        aria-label={`Open ${file.filename}`}
        title={`Open ${file.filename}`}
      >
        <img src={file.url} alt={file.filename} className="max-h-64 max-w-full rounded-xl border" />
      </button>
    ) : (
      <img
        src={file.url}
        alt={file.filename}
        title={file.filename}
        className={cn('max-h-64 max-w-[70%] rounded-xl border', mine ? 'self-end' : 'self-start')}
      />
    )
  ) : (
    <span
      title={file.filename}
      className={cn(
        'flex max-w-[70%] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px]',
        mine ? 'self-end' : 'self-start'
      )}
    >
      <FileText className="size-3.5 flex-none text-muted-foreground" />
      <span className="truncate">{file.filename}</span>
    </span>
  );

/**
 * A failed turn. The title *is* the failure ("Rate limited (429)"), so the banner answers the only
 * question worth asking at a glance — what went wrong — and the provider's own sentence follows
 * underneath with the identifiers redacted. `describeTurnFailure` supplies both, newline-separated:
 * a summary line, the reason, then what to do about it.
 */
const MessageError = ({ error }: { error: string }) => {
  const [title, ...rest] = error.split('\n');
  return (
    <Alert variant="destructive" className="max-w-[85%] self-start px-3.5 py-2.5 text-[12.5px]">
      <CircleAlert className="mt-0.5 size-4 flex-none" />
      <AlertTitle className="text-[12.5px]">{title}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words text-foreground">
        {rest.join('\n')}
      </AlertDescription>
    </Alert>
  );
};

const PermissionCard = ({
  request,
  onReply,
}: {
  request: PermissionRequest;
  onReply: (reply: PermissionReply) => Promise<boolean>;
}) => {
  const [busy, setBusy] = React.useState<PermissionReply | null>(null);
  const detail = permissionDetail(request);
  const description = metaString(request.metadata, ['description']);

  const reply = async (value: PermissionReply) => {
    setBusy(value);
    if (!(await onReply(value))) setBusy(null);
  };

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
    >
      <Card className="border-warning/40 bg-warning/5 text-[13px]">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 flex-none text-warning" />
            <span className="font-medium">Approval needed</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {request.permission}
            </span>
          </div>
          {description ? <p className="text-[12px] text-muted-foreground">{description}</p> : null}
          {detail ? (
            <pre className="max-h-48 overflow-auto rounded-md bg-background/80 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">
              {detail}
            </pre>
          ) : null}
          <div className="flex items-center gap-1.5 pt-0.5">
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void reply('reject')}>
              {busy === 'reject' ? <Loader2 className="animate-spin" /> : null}
              Deny
            </Button>
            <div className="flex-1" />
            <Button size="xs" variant="secondary" className="border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20" title="Automatically approve all tools in this conversation, even while Ember is closed" disabled={busy !== null} onClick={() => void reply('always')}>
              {busy === 'always' ? <Loader2 className="animate-spin" /> : null}
              Switch to <YoloLabel /> mode
            </Button>
            <Button size="xs" disabled={busy !== null} onClick={() => void reply('once')}>
              {busy === 'once' ? <Loader2 className="animate-spin" /> : <Check />}
              Allow
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
};

/** Answer state for one question: chosen option labels, plus optional free text. */
type Draft = { picked: string[]; custom: string };

const QuestionCard = ({
  request,
  onAnswer,
}: {
  request: QuestionRequest;
  onAnswer: (answers: QuestionAnswers | null) => Promise<boolean>;
}) => {
  const [busy, setBusy] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Draft[]>(() =>
    request.questions.map(() => ({ picked: [], custom: '' }))
  );

  const update = (index: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));

  const toggle = (index: number, question: QuestionInfo, label: string) => {
    const draft = drafts[index];
    const picked = question.multiple
      ? draft.picked.includes(label)
        ? draft.picked.filter((entry) => entry !== label)
        : [...draft.picked, label]
      : [label];
    update(index, { picked, custom: '' });
  };

  // Free text replaces the picks for that question, mirroring OpenChamber's card.
  const answerFor = (draft: Draft): string[] =>
    draft.custom.trim() ? [draft.custom.trim()] : draft.picked;
  const complete = drafts.every((draft) => answerFor(draft).length > 0);

  const submit = async () => {
    if (!complete) return;
    setBusy(true);
    if (!(await onAnswer(drafts.map(answerFor)))) setBusy(false);
  };

  const dismiss = async () => {
    setBusy(true);
    if (!(await onAnswer(null))) setBusy(false);
  };

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
    >
      <Card className="border-highlight/40 bg-highlight/5 text-[13px]">
        <CardContent className="flex flex-col gap-3 p-3.5">
          <div className="flex items-center gap-2">
            <MessageCircleQuestion className="size-4 flex-none text-highlight" />
            <span className="font-medium">The agent has a question</span>
          </div>

          {request.questions.map((question, index) => {
            const draft = drafts[index];
            return (
              <div key={index} className="flex flex-col gap-1.5">
                {request.questions.length > 1 && question.header ? (
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </span>
                ) : null}
                <p className="whitespace-pre-wrap">
                  <Linkify text={question.question} />
                </p>
                <div className="flex flex-col gap-1">
                  {question.options.map((option) => {
                    const picked = draft.picked.includes(option.label) && !draft.custom.trim();
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, question, option.label)}
                        aria-pressed={picked}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                          picked ? 'border-highlight/60 bg-highlight/10' : 'border-border hover:bg-muted/60'
                        )}
                      >
                        <span
                          className={cn(
                            'mt-[3px] flex size-3.5 flex-none items-center justify-center border',
                            question.multiple ? 'rounded-[3px]' : 'rounded-full',
                            picked ? 'border-highlight bg-highlight text-highlight-foreground' : 'border-muted-foreground/50'
                          )}
                        >
                          {picked ? <Check className="size-2.5" /> : null}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[12.5px]">{option.label}</span>
                          {option.description ? (
                            <span className="text-[11.5px] text-muted-foreground">{option.description}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {question.custom !== false ? (
                  <Input
                    value={draft.custom}
                    disabled={busy}
                    aria-label={question.header ? `${question.header} custom answer` : 'Custom answer'}
                    placeholder="Or type your own answer…"
                    onChange={(event) => update(index, { custom: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                    className="h-8 text-xs shadow-none"
                  />
                ) : null}
              </div>
            );
          })}

          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void dismiss()}
            >
              Dismiss
            </Button>
            <div className="flex-1" />
            <Button size="xs" disabled={busy || !complete} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              Answer
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
};

const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
};

const formatTokens = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : String(count);

/**
 * One phrase about prompt caching for the footer, or null when the provider reported none.
 * Prefer the hit rate (what people care about); mention a write only when nothing was read,
 * which is the first turn after the context changed.
 */
export const cacheSummary = (tokens: TokenUsage | undefined): string | null => {
  if (!tokens) return null;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (tokens.cacheRead > 0 && prompt > 0) {
    return `${Math.round((tokens.cacheRead / prompt) * 100)}% cached`;
  }
  if (tokens.cacheWrite > 0) return `cache written ${formatTokens(tokens.cacheWrite)}`;
  return null;
};

/** Output tokens per second for a finished turn, or null when there's not enough to say. */
export const tokensPerSecond = (message: ChatMessage): number | null => {
  if (!message.tokens || message.createdAt === undefined || message.completedAt === undefined) return null;
  const seconds = (message.completedAt - message.createdAt) / 1000;
  if (seconds <= 0 || message.tokens.output <= 0) return null;
  return message.tokens.output / seconds;
};

/** Compact USD amount: enough precision to distinguish small per-turn costs. */
export const formatCost = (cost: number): string => {
  if (!(cost > 0)) return '$0';
  const decimals = cost < 0.1 ? 4 : cost < 1 ? 3 : 2;
  return `$${cost.toFixed(decimals)}`;
};

/** "when was this received", in words ("just now", "10 min ago", "2 hours ago"). */
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

/** Self-ticking so "x min ago" stays honest without re-rendering the whole transcript. */
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

/** The original gutter shortcut stays available independently of the details row. */
const CopyAsMarkdown = ({ message }: { message: ChatMessage }) => (
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
  /**
   * Whether this host reports spend. Off for OpenChamber, whose per-message figure is an estimate
   * from the model's rate rather than a ledger — see `hostReportsCost`.
   */
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
  const received = showMetadata ? message.completedAt ?? message.createdAt : undefined;
  // Details off still hides this row; the original copy shortcut remains on the message.
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
      {model ? <span className="min-w-0 truncate" title="Model and thinking level recorded for this reply">{model}</span> : null}
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
        <span data-footer-actions="" className="inline-flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover/footer:opacity-100 group-focus-within/footer:opacity-100 [@media(hover:none)]:opacity-100">
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

/**
 * The agent's `ask` and the human's answer, kept in the transcript. The tool call and result are
 * durable entries, so unlike the transient pending card this survives being answered — and it is
 * shown even when tool calls are hidden, because the question is not a tool row to the reader.
 * While the question is still open the interactive `QuestionCard` owns it, so this returns nothing.
 */
const AskRecord = ({ call }: { call: ToolCall }) => {
  const input = call.input ?? {};
  const question = typeof input.question === 'string' ? input.question : '';
  // The result carries the answer; until it exists the question is open and the interactive
  // QuestionCard owns it (an unanswered `ask` maps as a completed call with no output).
  const detail = ((call.output ?? '').trim() || (call.error ?? '').trim());
  if (!question || !detail) return null;
  const options = Array.isArray(input.options)
    ? (input.options as unknown[]).filter((option): option is string => typeof option === 'string')
    : [];
  const answered = /^The user answered:\s*([\s\S]+)$/.exec(detail);
  const answer = answered?.[1]?.trim() || null;
  const dismissed = !answer && /dismiss/i.test(detail);
  return (
    <div className="flex max-w-[85%] flex-col gap-1.5 self-start rounded-lg border border-highlight/30 bg-highlight/[0.04] px-3.5 py-2.5 text-[12.5px]">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <MessageCircleQuestion className="size-3.5 flex-none text-highlight" />
        <span>The agent asked</span>
      </div>
      <p className="whitespace-pre-wrap">
        <Linkify text={question} />
      </p>
      {options.length ? (
        <div className="flex flex-wrap gap-1">
          {options.map((option) => (
            <span
              key={option}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11.5px]',
                answer === option
                  ? 'border-highlight/60 bg-highlight/10 font-medium text-foreground'
                  : 'border-border text-muted-foreground'
              )}
            >
              {option}
            </span>
          ))}
        </div>
      ) : null}
      <p className="text-[11.5px] text-muted-foreground">
        {answer ? (
          <>
            You answered:{' '}
            <span className="font-medium text-foreground">
              <Linkify text={answer} />
            </span>
          </>
        ) : dismissed ? (
          'You dismissed this question.'
        ) : call.status === 'interrupted' ? (
          'The question was interrupted.'
        ) : (
          detail.slice(0, 200)
        )}
      </p>
    </div>
  );
};

/**
 * A server-generated crew wake (`[crew] …`) or side-question answer (`[crew] Side question: …`)
 * rendered as a system card, not a user bubble.
 */
const CrewReportCard = ({
  summary,
  kind = 'crew',
}: {
  summary: string;
  kind?: 'crew' | 'side-question';
}) => (
  <div className="flex max-w-[85%] flex-col gap-1 self-center rounded-lg border border-highlight/30 bg-highlight/[0.04] px-3.5 py-2.5 text-[12.5px]">
    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {kind === 'side-question' ? (
        <>
          <MessageCircleQuestion className="size-3.5 flex-none text-highlight" />
          <span>Side question</span>
        </>
      ) : (
        <>
          <Megaphone className="size-3.5 flex-none text-highlight" />
          <span>Crew report</span>
        </>
      )}
    </div>
    <p className="whitespace-pre-wrap break-words">
      <Linkify text={summary} />
    </p>
  </div>
);

const renderBlock = (
  message: ChatMessage,
  block: Block,
  reasoningExpanded: boolean,
  expandToolCalls: boolean,
  hideToolCalls: boolean,
  /** The turn is still being written, so a reasoning block is live rather than history. */
  streaming?: boolean,
  overlay?: React.ReactNode,
  onReasoningToggle?: (element: HTMLElement | null) => void,
  onOpenImage?: (image: ViewerImage) => void,
  /** An unread badge pinned to this bubble's top-right corner (assistant messages only). */
  unreadBadge?: React.ReactNode
) => {
  const mine = message.role === 'user';
  if (block.type === 'text') {
    // A crew wake (`[crew] …`) is server-generated: render it as a system line, not a user bubble.
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
            : 'w-full max-w-[780px] self-start py-2 text-foreground'
        )}
      >
        {mine ? (
          <Linkify text={block.text} />
        ) : (
          <React.Suspense fallback={<MarkdownFallback text={block.text} />}>
            <Markdown text={block.text} />
          </React.Suspense>
        )}
        {unreadBadge}
        {overlay}
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
          // Tool rows are hidden, but this block carries images: show those on their own.
          <ToolImages calls={block.calls} onOpen={onOpenImage} />
        ) : (
          <ToolGroupRow tool={block.tool} calls={block.calls} defaultOpen={expandToolCalls} onOpen={onOpenImage} />
        )
      ) : block.type === 'ask' ? (
        <AskRecord call={block.call} />
      ) : block.type === 'reasoning' ? (
        <ReasoningRow
          storageKey={`reasoning:${message.id}:${block.id}`}
          text={block.text}
          defaultOpen={reasoningExpanded}
          onToggle={onReasoningToggle}
          streaming={streaming}
        />
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

type MessageRowProps = {
  message: ChatMessage;
  highlighted: boolean;
  highlightRequest: number;
  showMetadata: boolean;
  hideToolCalls: boolean;
  reasoningDisplay: ReasoningDisplay;
  showQuestions: boolean;
  expandToolCalls: boolean;
  /** `collapsed` folds the whole turn's tool calls behind one line (see `ToolRollup`). */
  toolDisplay: ToolDisplay;
  /** Whether this host reports spend at all; false hides the footer's cost. */
  showCost: boolean;
  unread?: boolean;
  onMarkRead?: (message: ChatMessage) => void;
  onReply?: (message: ChatMessage) => void;
  showMessageDetails: boolean;
  /** Render the session's blob tucked beside this message. */
  showBuddy: boolean;
  /** This message is the turn currently streaming, so its reasoning follows the stream. */
  streaming: boolean;
  /** Every image in the conversation, so the viewer can walk between messages. */
  gallery: ViewerImage[];
  blobStyle: BlobStyle;
  seed: string;
  identity: AvatarIdentity;
  mood: BallMood;
  onRetryPendingSend?: (message: ChatMessage) => void;
  onDiscardPendingSend?: (message: ChatMessage) => void;
  pendingSendLabels?: { retry?: string; discard?: string };
  onReasoningToggle: (element: HTMLElement | null) => void;
  registerNode: (id: string, node: HTMLDivElement | null) => void;
};

/**
 * One message. Memoized so a 3s poll that only appends or updates the tail doesn't re-render
 * (and re-measure for layout animation) every earlier bubble in a long transcript.
 */
/**
 * Delivery state for an optimistic user message. `sending` is the request in flight. `queued` is a
 * message the host holds and will place at the turn's next boundary — a settled fact, never a doubt.
 * `unconfirmed` is a message the host said it placed but whose echo has not appeared: quiet at
 * first, because that echo usually lands in under a second, and honest after `UNCONFIRMED_SEND_MS`.
 * `failed` is a definite failure (a transport error, a non-2xx response, or a refused submission),
 * with the ways out of it.
 */
/** How long a send may take before it says so. Under this, it simply looks sent — because it is. */
const SLOW_SEND_MS = 10_000;

/**
 * True once `since` is at least `after` old (and from then on).
 *
 * Used to keep a delivery note quiet for as long as the thing it describes is normal: a send in
 * flight, or a placed message whose echo is still on its way. Nothing is announced that has not
 * happened yet.
 */
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

/**
 * The note a message keeps while its request is still in flight.
 *
 * Nothing for the first ten seconds: the request is out and the bubble is where it will stay, so a
 * send that is merely slow should look exactly like a send that landed. Past that, a quiet line that
 * fades in — enough to say "this is still going" without ever making the message look doubtful. Only
 * a definite failure dims a message or colours it (see the caller).
 */
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

/**
 * A message the host said it placed, but which never appeared in the conversation.
 *
 * Silent while the echo is plausibly on its way — that is the normal case and it takes under a
 * second. Past `UNCONFIRMED_SEND_MS` the bubble says the one true thing left to say: the host took
 * the message and has not shown it back. It is not called "not sent" (the host may well be holding
 * it), and the ways out are the ones that keep the text: send it again, copy it, or drop it.
 */
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
      <span className="min-w-0">
        Not confirmed. The host took this message but has not shown it in the conversation — it may
        not have arrived.
      </span>
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

const DeliveryRow = ({
  message,
  onRetry,
  onDiscard,
  labels,
}: {
  message: ChatMessage;
  onRetry?: (message: ChatMessage) => void;
  onDiscard?: (message: ChatMessage) => void;
  /** The ways out, when this bubble's are not the usual Send again / Discard. */
  labels?: { retry?: string; discard?: string };
}) => {
  if (!message.delivery) return null;
  if (message.delivery === 'sending') {
    // A held message is waiting for a conversation, not for the host to take it: say which, and
    // never let the generic "Still sending…" turn a known wait into a doubtful send.
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
    // A settled fact, not work in progress: the host holds the message and will place it at the
    // turn's next boundary. So no spinner — a spinner here read as "not sent yet", which is
    // exactly what it is not. Only a queued *steer* reaches the transcript with this state (a plain
    // follow-up's home is the queue), and Discard withdraws it from the host, which is the only
    // honest way to take back a message that is already waiting to run.
    return (
      <div
        className="flex items-center gap-2 self-end px-1 text-[11px] text-muted-foreground"
        role="status"
      >
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

const MessageRow = React.memo(function MessageRow({
  message,
  highlighted,
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
  onReply,
  showMessageDetails,
  showBuddy,
  streaming,
  gallery,
  blobStyle,
  seed,
  identity,
  mood,
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
  // The viewer lives above the transcript; a thumbnail finds itself in this message's gallery so
  // ←/→ walks the images the message carried. No provider → thumbnails stay inert.
  const viewer = useImageViewer();
  // The conversation's images, not this message's: ←/→ (and the viewer's buttons) cross turns.
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
  // A row whose every block is hidden (thinking/tools off) shouldn't leave a gap behind.
  if (blocks.length === 0 && !message.error) return null;
  // Anchor the controls to the message's text card rather than the full-width row, so a
  // left-aligned reply's gutter sits at the card's top-right instead of out in the empty margin.
  const textBlockIndex = blocks.findIndex((block) => block.type === 'text');
  /**
   * Tool display, split into what the list draws and what one line stands in for.
   *
   * `collapsed` folds every foldable tool block in this message into a single `ToolRollup`; `list`
   * leaves `folded` empty and every block draws itself. Hidden tool use folds nothing — there is no
   * line to show for something the reader asked not to see.
   */
  const folding = toolDisplay === 'collapsed' && !hideToolCalls;
  const folded: ToolBlock[] = folding ? (blocks.filter(foldsIntoRollup) as ToolBlock[]) : [];
  const blocksToDraw = folding
    ? blocks.filter((block) => !(block.type === 'tools' && foldsIntoRollup(block)))
    : blocks;
  const copyable = hasMarkdownToCopy(message);

  // Keep the control mounted after the read mark changes so its confirmation can finish.
  const unreadBadge = message.role === 'assistant' && onMarkRead ? (
    <MessageReadButton unread={unread} onRead={() => onMarkRead(message)} />
  ) : undefined;

  const renderGutter = (horizontalClass: string) =>
    copyable ? (
      <div className={cn('absolute top-1 flex translate-x-0.5 flex-col gap-1', horizontalClass)}>
        <CopyAsMarkdown message={message} />
      </div>
    ) : null;

  return (
    <motion.div
      ref={ref}
      layout={false}
      data-message-id={message.id}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'group/message relative isolate mx-auto flex w-full max-w-[760px] flex-col gap-1.5 rounded-xl px-5 sm:px-7'
      )}
    >
      {highlighted ? <span key={highlightRequest} aria-hidden="true" className="message-jump-highlight" /> : null}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          // Only a definite failure dims. A message that is still on its way looks sent, because it
          // is: the request is out, and dimming it read as doubt the client does not have.
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
            index === textBlockIndex ? renderGutter('-right-6') : undefined,
            onReasoningToggle,
            viewer ? openImage : undefined,
            index === textBlockIndex ? unreadBadge : undefined
          );
        })}
        {/* Folded tool display: every foldable call in this message becomes one line, with the usual
            rows behind a click. Blocks carrying images stay where they are — a picture shown by a
            tool belongs on screen, and folding it into a count would lose it rather than defer it. */}
        {folded.length > 0 ? (
          <ToolRollup
            messageId={message.id}
            blocks={folded}
            expandToolCalls={expandToolCalls}
            onOpen={viewer ? openImage : undefined}
            streaming={streaming}
          />
        ) : null}
        {message.error ? <MessageError error={message.error} /> : null}
        <DeliveryRow
          message={message}
          onRetry={onRetryPendingSend}
          onDiscard={onDiscardPendingSend}
          labels={pendingSendLabels}
        />
        <MessageFooter message={message} showMetadata={showMetadata && showMessageDetails} showCost={showCost} onReply={onReply} />
      </div>
      {showBuddy ? (
        // One anchor for the whole message, whichever block is last: the row's own bottom-right
        // gutter, level with the metadata line. Nothing to re-parent on a block boundary, so a turn
        // that streams reasoning → text → tool → text cannot teleport it, and the block growing
        // under it just carries it down. The gutter is already empty because every block is
        // `self-start` with a max width (text 85%, files 70%), so the free right margin clears the
        // 30px blob without covering a tool row or a file row.
        <div className="pointer-events-none absolute bottom-1 right-0 z-10 sm:right-2">
          <Blob style={blobStyle} seed={seed} identity={identity} size={30} mood={mood} interactive={false} />
        </div>
      ) : null}
      {textBlockIndex < 0 ? <>{renderGutter('right-0')}{unreadBadge}</> : null}
    </motion.div>
  );
});

const ActivityLabel = ({ label, since }: { label: ActivityLabelValue; since?: number }) => {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    // The chat's name truncates; the phase and elapsed time never do, so the line stays one line
    // and never pushes the composer.
    <span className="flex min-w-0 items-center gap-1">
      {label.title ? <span className="truncate">{label.title}</span> : null}
      <span className="flex-none whitespace-nowrap">
        {label.text}{since ? ` · ${formatElapsed(now - since)}` : ''}
      </span>
    </span>
  );
};

function Transcript({
  findRequest = 0,
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
  state,
  sending,
  sessionTitle,
  instanceLabel,
  blobStyle,
  seed,
  identity,
  mood,
  hideToolCalls,
  reasoningDisplay,
  showQuestions,
  expandToolCalls,
  toolDisplay,
  showCost = true,
  readMark,
  onMarkRead,
  onMarkAllRead,
  onReply,
  showMessageDetails,
  showAvatars,
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
    setFind('');
    const frame = requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, [findRequest]);
  const items = React.useMemo(() => {
    const visible = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) =>
        message.error ||
        message.parts.some(
          (part) =>
            part.type === 'text' ||
            part.type === 'file' ||
            (part.type === 'tool' &&
              (part.call.tool === 'ask'
                ? showQuestions
                : !hideToolCalls || Boolean(part.call.images?.length))) ||
            (part.type === 'reasoning' && reasoningDisplay !== 'hidden')
        )
      );
    return bundleConsecutiveToolMessages(visible, {
      toolDisplay,
      hideToolCalls,
      reasoningHidden: reasoningDisplay === 'hidden',
      showQuestions,
    });
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
  // Marks for the scrub rail, derived from the same visible items the list renders (so a tick's
  // index is directly a `jumpToIndex` argument).
  const railTicks = React.useMemo(
    () => (showActivityRail ? timelineTicks(items.map(({ message }) => message)) : []),
    [items, showActivityRail]
  );
  const railVisible = showActivityRail && shouldShowTimeline(railTicks);
  const railActiveIndex = focusedIndex >= 0 ? focusedIndex : highlightedIndex >= 0 ? highlightedIndex : null;

  // One gallery for the whole conversation: the viewer's next/previous cross message boundaries.
  const conversationGallery = React.useMemo(() => galleryForConversation(messages), [messages]);
  const findMatches = React.useMemo(() => find?.trim() ? items.flatMap(({ message }, index) =>
    `${message.text}\n${message.parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join('\n')}`.toLowerCase().includes(find.toLowerCase()) ? [index] : []
  ) : [], [find, items]);
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

  const pendingCount = permissions.length + questions.length;
  React.useEffect(() => {
    if (pendingCount > previousPendingCountRef.current) {
      // A new approval or question has to be seen, so it gets one scroll — but it does not re-arm
      // following: a reader who had scrolled back was then dragged along by the rest of the stream.
      window.requestAnimationFrame(() => scrollToBottom('smooth'));
    }
    previousPendingCountRef.current = pendingCount;
  }, [pendingCount, scrollToBottom]);

  const focusById = useStableCallback((id: string) => {
    const index = items.findIndex(({ message }) => message.id === id);
    if (index >= 0) {
      jumpToIndex(index);
    } else if (hasOlderHistory && onLoadEarlier) {
      onLoadEarlier();
    }
  });
  React.useEffect(() => {
    if (!focusMessageId || focusRequest === 0) return;
    focusById(focusMessageId);
  }, [focusMessageId, focusRequest, focusById, items.length]);
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
    if (deltaY === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    if (!gestureLeavesBottom({ deltaY, following: followRef.current, scrollTop: el.scrollTop })) return;
    followRef.current = false;
    setFollowing(false);
  };
  const noteUserScroll = () => { userScrollAt.current = Date.now(); };
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

  // Folded rows borrow tool parts from earlier steps. Read status belongs to the original reply.
  const unreadIndices = React.useMemo(() => items.flatMap(({ message, index: sourceIndex }, index) =>
    isUnreadEligible(messages[sourceIndex]) &&
    !isMessageRead(readMark, entryOrdinal(message.id), message.createdAt ?? 0)
      ? [index] : []
  ), [items, messages, readMark]);
  const unreadIds = React.useMemo(() => new Set(unreadIndices.map((index) => items[index].message.id)), [items, unreadIndices]);
  const markMessageRead = useStableCallback((message: ChatMessage) => {
    const original = messages.find((entry) => entry.id === message.id);
    if (original) onMarkRead?.(original);
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
  // The last assistant message that actually renders something, so the buddy can settle beside it.
  const lastAssistantId = React.useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      if (message.error || visibleBlocks(message, hideToolCalls, reasoningDisplay, showQuestions).length > 0) {
        return message.id;
      }
    }
    return null;
  }, [messages, hideToolCalls, reasoningDisplay, showQuestions]);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setFind(''); }
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
        <Button size="xs" variant="ghost" onClick={() => { setFind(null); setHighlightedMessageId(null); }}>Close</Button>
      </div> : null}
      {onMarkRead && unreadIndices.length > 0 ? (
        <div data-unread-navigation="" className="flex flex-none flex-wrap items-center justify-between gap-x-2 border-b border-highlight/20 bg-highlight/5 px-3 py-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-highlight"
            onClick={() => jumpToIndex(unreadIndices[unreadIndices.length - 1], 'start')}
            title="Go to the newest unread reply without marking it as read"
          >
            <ArrowDown aria-hidden="true" />
            Go to new messages
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
      <div ref={scrollRef} tabIndex={0} aria-label="Conversation history" onScroll={handleScroll}
        onWheel={(event) => leaveOnUpwardGesture(event.deltaY)}
        onTouchMove={(event) => {
          // A finger travelling down the screen pulls the content up: the same intent as a wheel,
          // and the same moment to disengage.
          const y = event.touches[0]?.clientY ?? null;
          const previous = lastTouchY.current;
          lastTouchY.current = y;
          if (y !== null && previous !== null) leaveOnUpwardGesture(y - previous);
          else noteUserScroll();
        }}
        onTouchStart={(event) => {
          lastTouchY.current = event.touches[0]?.clientY ?? null;
          noteUserScroll();
        }}
        onTouchEnd={() => { lastTouchY.current = null; }}
        onKeyDown={noteUserScroll}
        onPointerDown={() => { pointerDown.current = true; noteUserScroll(); }}
        onPointerUp={() => { pointerDown.current = false; noteUserScroll(); }}
        onPointerCancel={() => { pointerDown.current = false; }}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-7 pb-3 sm:px-5 sm:pb-4">
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
            <div key="history" style={virtualized ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
            {(virtualized ? virtualizer.getVirtualItems() : items.map((_, index) => ({ index, start: 0 }))).map((row) => {
              const { message, index } = items[row.index];
              return <div key={message.id} role="article" aria-label={`${message.role} message ${index + 1} of ${messages.length}`} data-index={row.index} ref={virtualized ? virtualizer.measureElement : undefined}
                onFocusCapture={() => setFocusedId(message.id)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }}
                className={compactSpacing ? 'pb-1.5' : 'pb-2.5'} style={virtualized ? { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` } : undefined}>
              <MessageRow
                key={message.id}
                message={message}
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
                onMarkRead={onMarkRead ? markMessageRead : undefined}
                onReply={onReply}
                showMessageDetails={showMessageDetails}
                showBuddy={showAvatars && !turnPending && message.id === lastAssistantId}
                streaming={turnPending && index === items.length - 1}
                gallery={conversationGallery}
                blobStyle={blobStyle}
                seed={seed}
                identity={identity}
                mood={!turnPending && message.id === lastAssistantId ? mood : 'idle'}
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
                key={request.id}
                request={request}
                onAnswer={(answers) => onQuestion(request, answers)}
              />
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
                <div className="flex-none">
                  <Blob style={blobStyle} seed={seed} identity={identity} size={30} mood={mood} />
                </div>
                {runningTool ? <Wrench className="size-3 flex-none" /> : null}
                <ActivityLabel label={activity} since={activeSince} />
                <span className="animate-pulse">…</span>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <SessionStatusLine status={statusLine} className="-mt-0.5" />

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
