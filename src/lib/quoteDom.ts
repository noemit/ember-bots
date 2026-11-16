/** Renderer-owned source snapshots: stale DOM must never be projected onto newer text. */
const markdownSources = new WeakMap<Element, string>();
export const registerQuoteMarkdown = (element: Element, source: string): void => { markdownSources.set(element, source); };
export type QuoteTextRun = { node: Text; start: number; end: number };

/** Exact text leaves carry parser offsets. Plain Linkify/live prose is lossless as a whole. */
export const quoteTextRuns = (element: Element, source: string): QuoteTextRun[] | null => {
  const markdown = element.matches('[data-quote-markdown]') ? element : element.querySelector('[data-quote-markdown]');
  if (markdown && markdownSources.get(markdown) !== source) return null;
  if (!markdown && element.textContent !== source) return null;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const runs: QuoteTextRun[] = [];
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (markdown) {
      const leaf = node.parentElement?.closest('[data-quote-start]');
      if (!leaf || leaf.childNodes.length !== 1 || leaf.firstChild !== node || !markdown.contains(leaf)) continue;
      const start = Number(leaf.getAttribute('data-quote-start'));
      const end = Number(leaf.getAttribute('data-quote-end'));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || source.slice(start, end) !== node.data) return null;
      runs.push({ node, start, end });
    } else {
      runs.push({ node, start: offset, end: offset + node.length });
      offset += node.length;
    }
  }
  return runs;
};

export const quoteRangeSupported = (element: Element, range: Range): boolean =>
  ![...element.querySelectorAll('pre, code:not(:has([data-quote-start])), img, input, button, [data-quote-unsupported]')].some(node => range.intersectsNode(node));

/** Normalized boundaries must belong to an exact renderer text run. */
export const quoteBoundary = (runs: QuoteTextRun[], container: Node, offset: number): number | null => {
  const run = runs.find(candidate => candidate.node === container);
  return run && offset >= 0 && offset <= run.node.length ? run.start + offset : null;
};

/** Native triple-click may end at an empty sibling control or the next paragraph boundary.
 * Trim only selected whitespace/empty DOM boundaries, never selected non-whitespace content.
 * This is DOM normalization, not a search in the Markdown source.
 */
export const trimQuoteRange = (range: Range): Range | null => {
  const root = range.commonAncestorContainer;
  const document = root.ownerDocument!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
  let first: { node: Text; offset: number } | null = null;
  let last: { node: Text; offset: number } | null = null;
  while (node) {
    if (range.intersectsNode(node)) {
      const text = node as Text;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : text.length;
      const selected = text.data.slice(start, end);
      const leading = selected.search(/\S/u);
      if (leading >= 0) {
        first ??= { node: text, offset: start + leading };
        last = { node: text, offset: start + selected.trimEnd().length };
      }
    }
    node = walker.nextNode();
  }
  if (!first || !last) return null;
  const trimmed = document.createRange();
  trimmed.setStart(first.node, first.offset); trimmed.setEnd(last.node, last.offset);
  return trimmed;
};
