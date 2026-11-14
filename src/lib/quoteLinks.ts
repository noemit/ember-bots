import { quoteBoundary, quoteRangeSupported, quoteTextRuns, trimQuoteRange } from './quoteDom';
import { randomId } from './randomId';
import { type ChatMessage, type MessagePart, type QuoteAnchor, type QuoteSpan, sessionKey as makeSessionKey } from '../types';

export type { QuoteAnchor, QuoteSpan } from '../types';

/** Durable, Ember-local links between quoted transcript text and its destination. */
export type QuoteDestination =
  | { kind: 'message'; sessionKey: string; id: string }
  | { kind: 'queue'; sessionKey: string; id: string }
  | { kind: 'note'; sessionKey: string; id: string };
export type QuoteLink = { id: string; source: QuoteAnchor; destination: QuoteDestination };
export type QuoteAnchorResult = { ok: true; anchor: QuoteAnchor } | { ok: false; reason: 'outside-transcript' | 'unsupported-content' | 'multi-message' | 'invalid-range' | 'empty-selection' | 'source-too-long' };
export type QuoteAnchorValidation = { valid: true; spans: QuoteSpan[] } | { valid: false; reason: 'source-missing' | 'part-missing' | 'source-changed' | 'range-invalid' };
export const MAX_QUOTE_SOURCE_LENGTH = 20_000;
export const MAX_QUOTE_SELECTION_LENGTH = 4_000;

export const quoteSessionKey = (instanceId: string, sessionId: string): string =>
  makeSessionKey({ instanceId, sessionId });

export const createQuoteLinkId = (): string => `quote-${randomId()}`;
export const normaliseSelection = (text: string): string => text
  .replace(/\r\n?/g, '\n')
  .split('\n').map((line) => line.replace(/[\t\u00a0\u200b ]+/g, ' ').trim())
  .join('\n').replace(/\n{3,}/g, '\n\n').trim();
export const annotationMessage = (quote: string, annotation: string): string =>
  `Re: “${quote}”\n\n${annotation.trim()}`;

/** Non-overlapping exact matches; useful for diagnostics, never for choosing a saved anchor. */
export const occurrencesOf = (text: string, quote: string): number[] => {
  if (!quote) return [];
  const found: number[] = [];
  let from = 0;
  while (from <= text.length - quote.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    found.push(index);
    from = index + Math.max(1, quote.length);
  }
  return found;
};

const textPart = (message: ChatMessage, partId: string): MessagePart | undefined =>
  message.parts.find((part) => part.id === partId && (part.type === 'text' || part.type === 'reasoning'));

const closestElement = (node: Node): Element | null => node instanceof Element ? node : node.parentElement;

/**
 * Capture only a single message's visible prose/reasoning text. DOM boundary offsets are projected
 * onto the source part's text nodes and persisted as exact part-local offsets, never as DOM offsets.
 * Selections spanning messages or unsupported renderers are refused instead of approximated.
 */
export const captureQuoteAnchor = (input: {
  range: Range;
  /** Native Selection text preserves rendered line breaks/collapsed whitespace; never used for offsets. */
  selectedText?: string;
  transcript: Element;
  sessionKey: string;
  messages: readonly ChatMessage[];
}): QuoteAnchorResult => {
  const { transcript, sessionKey, messages } = input;
  if (!transcript.contains(input.range.commonAncestorContainer)) return { ok: false, reason: 'outside-transcript' };
  const range = trimQuoteRange(input.range);
  if (!range) return { ok: false, reason: 'empty-selection' };
  const startPart = closestElement(range.startContainer)?.closest('[data-quote-part-id]');
  const endPart = closestElement(range.endContainer)?.closest('[data-quote-part-id]');
  const startMessage = closestElement(range.startContainer)?.closest('[data-message-id]');
  const endMessage = closestElement(range.endContainer)?.closest('[data-message-id]');
  if (!startPart || !endPart || startPart !== endPart || !transcript.contains(startPart)) {
    return startMessage && endMessage && startMessage !== endMessage
      ? { ok: false, reason: 'multi-message' }
      : { ok: false, reason: 'unsupported-content' };
  }
  // Message identity lives only on the transcript row. Never add it to an inner quote part: other
  // transcript selectors rely on there being exactly one `[data-message-id]` per row.
  const messageId = startMessage?.getAttribute('data-message-id');
  const partId = startPart.getAttribute('data-quote-part-id');
  if (!messageId || !partId || startMessage !== endMessage) {
    return startMessage && endMessage && startMessage !== endMessage
      ? { ok: false, reason: 'multi-message' }
      : { ok: false, reason: 'unsupported-content' };
  }
  const message = messages.find((entry) => entry.id === messageId);
  const part = message && textPart(message, partId);
  if (!message || !part || (part.type !== 'text' && part.type !== 'reasoning')) return { ok: false, reason: 'unsupported-content' };
  if (!quoteRangeSupported(startPart, input.range)) return { ok: false, reason: 'unsupported-content' };
  const runs = quoteTextRuns(startPart, part.text);
  if (!runs) return { ok: false, reason: 'invalid-range' };
  const start = quoteBoundary(runs, range.startContainer, range.startOffset);
  const end = quoteBoundary(runs, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start || end > part.text.length) return { ok: false, reason: 'invalid-range' };
  const quote = part.text.slice(start, end);
  const selected = normaliseSelection(input.selectedText ?? range.toString());
  if (!selected) return { ok: false, reason: 'empty-selection' };
  if (part.text.length > MAX_QUOTE_SOURCE_LENGTH || quote.length > MAX_QUOTE_SELECTION_LENGTH) return { ok: false, reason: 'source-too-long' };
  const span: QuoteSpan = { messageId, partId, start, end, quote, text: part.text };
  return { ok: true, anchor: { sessionKey, spans: [span], quote: selected } };
};

/** Validate stable offsets against the exact current source. Changed or missing text never relocates. */
export const validateQuoteAnchor = (
  anchor: QuoteAnchor,
  messages: readonly ChatMessage[],
  currentSessionKey?: string
): QuoteAnchorValidation => {
  if (currentSessionKey && anchor.sessionKey !== currentSessionKey) return { valid: false, reason: 'source-missing' };
  if (!anchor.spans.length || anchor.spans.length > 20 || anchor.quote.length > MAX_QUOTE_SELECTION_LENGTH) {
    return { valid: false, reason: 'range-invalid' };
  }
  const resolved: QuoteSpan[] = [];
  for (const span of anchor.spans) {
    const message = messages.find((entry) => entry.id === span.messageId);
    if (!message) return { valid: false, reason: 'source-missing' };
    const part = textPart(message, span.partId);
    if (!part) return { valid: false, reason: 'part-missing' };
    if (part.type !== 'text' && part.type !== 'reasoning') return { valid: false, reason: 'part-missing' };
    if (part.text !== span.text) return { valid: false, reason: 'source-changed' };
    if (span.text.length > MAX_QUOTE_SOURCE_LENGTH || span.quote.length > MAX_QUOTE_SELECTION_LENGTH || !span.quote || !anchor.quote.trim()) {
      return { valid: false, reason: 'range-invalid' };
    }
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > part.text.length || span.end - span.start !== span.quote.length || part.text.slice(span.start, span.end) !== span.quote) {
      return { valid: false, reason: 'range-invalid' };
    }
    resolved.push(span);
  }
  return { valid: true, spans: resolved };
};
