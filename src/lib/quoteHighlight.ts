import type { QuoteSpan } from '../types';

/** Exact canonical text only. Rendered Markdown that changed its source is never approximated. */
export const quoteRangeIn = (element: Element, span: QuoteSpan): Range | null => {
  if (span.text.slice(span.start, span.end) !== span.quote) return null;
  const rendered = element.textContent ?? '';
  let start = span.start;
  let finish = span.end;
  if (rendered !== span.text) {
    const first = rendered.indexOf(span.quote);
    if (first < 0 || rendered.indexOf(span.quote, first + 1) >= 0) return null;
    start = first; finish = first + span.quote.length;
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  const range = document.createRange();
  let started = false;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const end = offset + node.length;
    if (!started && start >= offset && start < end) { range.setStart(node, start - offset); started = true; }
    if (started && finish > offset && finish <= end) { range.setEnd(node, finish - offset); return range; }
    offset = end;
  }
  return null;
};
