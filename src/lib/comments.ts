/** Small display/keyboard utilities shared by the floating annotation composer. */
/** How much of a selection is quoted; a giant selection must not dominate the message. */
export const QUOTE_LIMIT = 200;

/**
 * Collapse a selection into readable text: CRLF to LF, runs of spaces/tabs to one space, and no
 * blank-line runs. Selections copied across rendered paragraphs, list items and code blocks arrive
 * with arbitrary indentation, which reads badly once quoted.
 */
export const normaliseSelection = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0\u200b ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * The quote that goes into the message: one line, at most `limit` characters, cut on a word
 * boundary and marked with an ellipsis. A selection that crosses message boundaries arrives as
 * several lines; quoting the whole thing inline is what makes the "Re: …" line readable.
 */
export const shortenQuote = (text: string, limit: number = QUOTE_LIMIT): string => {
  const flat = normaliseSelection(text).replace(/\s*\n\s*/g, ' ');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  // Never cut back further than half the limit, or a long unbroken token would empty the quote.
  const body = boundary > limit / 2 ? cut.slice(0, boundary) : cut;
  return `${body.trimEnd()}…`;
};

/**
 * The shortcut that comments on the current selection. Alt is deliberate: Mod+K (palette),
 * Mod+Enter (save note), Mod+F (find) and Mod+1-9 (columns) are all taken, and Mod+Alt+C is free
 * on every platform Ember runs on.
 */
export const COMMENT_SHORTCUT = 'Mod+Alt+C';

export const isCommentShortcut = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean =>
  (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c';
