import type { ChatMessage } from '../types';
import type { ToolPresentationItem } from './toolDisplay';

/**
 * The whisper timeline: one mark per assistant turn, sized and coloured by what happened, so a long
 * transcript can be skimmed ("where was the failure?") and jumped into. Pure: it takes the same
 * `items` array the transcript renders, so a tick's `index` is a valid `jumpToIndex` argument.
 */

export type TimelineKind = 'turn' | 'tool' | 'failure' | 'live';

export type TimelineTick = {
  /** Index into the transcript's visible items, ready for `jumpToIndex`. */
  index: number;
  at?: number;
  kind: TimelineKind;
  /** Tool names involved (deduped, at most three), for the tooltip. */
  tools: string[];
  /** One line for the tooltip, e.g. "18:41 · bash failed". */
  summary: string;
};

/** Below this many marks the rail is noise, so it isn't rendered at all. */
export const MIN_TIMELINE_TICKS = 8;
/**
 * Upper bound on rendered marks. At 120 the marks packed into a dashed line that read as a
 * scrollbar; ~40 across a full-height rail keeps them discrete (each mark ~20px apart).
 */
export const MAX_TIMELINE_TICKS = 40;

// One formatter, built once. `toLocaleTimeString` per mark cost about 80µs, and a 10k-message
// transcript has thousands of turns before sampling, which blocked the main thread for half a second
// on every poll.
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const clock = (at?: number): string => (at ? timeFormat.format(at) : '');

const classify = (message: ChatMessage): { kind: TimelineKind; tools: string[] } => {
  const tools = [
    ...new Set(
      message.parts.flatMap((part) => (part.type === 'tool' ? [part.call.tool] : []))
    ),
  ];
  const toolFailed = message.parts.some(
    (part) => part.type === 'tool' && part.call.status === 'error'
  );
  if (message.error || toolFailed) return { kind: 'failure', tools };
  if (!message.completed) return { kind: 'live', tools };
  if (tools.length > 0) return { kind: 'tool', tools };
  return { kind: 'turn', tools };
};

const classified = new WeakMap<ChatMessage, { kind: TimelineKind; tools: string[] }>();
const classifyCached = (message: ChatMessage): { kind: TimelineKind; tools: string[] } => {
  const hit = classified.get(message);
  if (hit) return hit;
  const result = classify(message);
  classified.set(message, result);
  return result;
};

const summarise = (tick: Omit<TimelineTick, 'summary'>): string => {
  const time = clock(tick.at);
  const lead = tick.kind === 'failure' ? `${tick.tools[0] ?? 'turn'} failed` : tick.kind === 'live' ? 'running now' : tick.tools.length ? tick.tools.slice(0, 2).join(', ') : 'turn';
  return time ? `${time} · ${lead}` : lead;
};

/**
 * Marks for the visible transcript. Turns are the unit — a user message starts one, the assistant
 * reply closes it — so the rail reads top-to-bottom as the conversation did.
 */
export const timelineTicks = (items: readonly ChatMessage[]): TimelineTick[] => {
  // Bare marks first: sampling happens before any text is built, so the summary cost applies to the
  // ~40 marks that survive rather than to every turn in the transcript.
  const marks: Array<Omit<TimelineTick, 'summary'>> = [];
  items.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const { kind, tools } = classifyCached(message);
    marks.push({ index, at: message.createdAt, kind, tools });
  });

  return sampleMarks(marks);
};

/** Live status belongs to every source in a merged row, not just its settled anchor.
 * Keep the presentation message untouched: its identity and read eligibility are independent.
 */
export const timelineTicksForItems = (
  items: readonly ToolPresentationItem<ChatMessage>[],
  sources: readonly ChatMessage[],
): TimelineTick[] => {
  const marks: Array<Omit<TimelineTick, 'summary'>> = [];
  items.forEach(({ message, sourceIndices }, index) => {
    if (message.role !== 'assistant') return;
    const classification = classifyCached(message);
    const liveSource = sourceIndices?.some(source => {
      const entry = sources[source];
      return entry?.role === 'assistant' && !entry.completed;
    });
    const kind = classification.kind !== 'failure' && liveSource ? 'live' : classification.kind;
    marks.push({ index, at: message.createdAt, kind, tools: classification.tools });
  });
  return sampleMarks(marks);
};

const sampleMarks = (marks: Array<Omit<TimelineTick, 'summary'>>): TimelineTick[] => {
  let kept = marks;
  if (marks.length > MAX_TIMELINE_TICKS) {
    // Sample evenly, but never drop a failure or the live tick: those are the marks you look for.
    const keep = new Set<Omit<TimelineTick, 'summary'>>();
    marks.forEach((mark) => {
      if (mark.kind === 'failure' || mark.kind === 'live') keep.add(mark);
    });
    const stride = Math.ceil(marks.length / MAX_TIMELINE_TICKS);
    marks.forEach((mark, position) => {
      if (position % stride === 0) keep.add(mark);
    });
    kept = marks.filter((mark) => keep.has(mark));
  }
  return kept.map((mark) => ({ ...mark, summary: summarise(mark) }));
};

/** True when the rail is worth the pixels (see MIN_TIMELINE_TICKS). */
export const shouldShowTimeline = (ticks: readonly TimelineTick[]): boolean =>
  ticks.length >= MIN_TIMELINE_TICKS;
