import type { QuoteSpan } from '../types';
import { quoteRangeSupported, quoteTextRuns } from './quoteDom';

/** Inverse of capture: the same renderer provenance, never a unique-word search. */
export const quoteRangeIn = (element: Element, span: QuoteSpan): Range | null => {
  if (span.text.slice(span.start, span.end) !== span.quote) return null;
  const runs = quoteTextRuns(element, span.text);
  if (!runs) return null;
  const first = runs.find(run => span.start >= run.start && span.start < run.end);
  const last = runs.find(run => span.end > run.start && span.end <= run.end);
  if (!first || !last) return null;
  const range = element.ownerDocument.createRange();
  range.setStart(first.node, span.start - first.start);
  range.setEnd(last.node, span.end - last.start);
  return quoteRangeSupported(element, range) ? range : null;
};
