/**
 * `@`-mentions in the composer.
 *
 * The trigger is a `@` at the start of a word, and the query runs to the caret — so "mail me at
 * a@b" never opens a popup, while "@Stu" does. A space ends the query: mentionable names contain
 * spaces, so the popup chooses the name rather than the user typing it out.
 *
 * Everything here is pure and offset-based, so the behaviour can be pinned without a DOM and the
 * caret arithmetic lives somewhere testable.
 */

export type MentionQuery = {
  /** Offset of the `@` itself. */
  start: number;
  /** Offset of the caret, i.e. where the query ends. */
  end: number;
  /** What has been typed after the `@`, empty for a bare `@`. */
  query: string;
};

/**
 * Longest query worth matching. A name is short; without a cap, a stray `@` followed by a pasted
 * paragraph would scan and filter the whole thing on every keystroke.
 */
const MAX_QUERY = 40;

/** True when `index` begins a word, i.e. the character before it is absent or whitespace. */
const startsWord = (text: string, index: number): boolean =>
  index === 0 || /\s/.test(text[index - 1] ?? '');

/**
 * The mention being typed at `cursor`, or null.
 *
 * Returns null when the `@` is inside a word (`a@b`), when the query already contains whitespace, or
 * when the query is longer than {@link MAX_QUERY} — in all of those the user is not naming an agent.
 */
export const mentionQueryAt = (text: string, cursor: number): MentionQuery | null => {
  if (cursor < 0 || cursor > text.length) return null;
  for (let index = cursor - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '@') {
      if (!startsWord(text, index)) return null;
      const query = text.slice(index + 1, cursor);
      if (query.length > MAX_QUERY || /\s/.test(query)) return null;
      return { start: index, end: cursor, query };
    }
    // A space cannot appear before the `@` we are looking for.
    if (/\s/.test(char ?? '')) return null;
  }
  return null;
};

/**
 * Names to offer for `query`, best first.
 *
 * A prefix match outranks a word-boundary match, which outranks a substring — so typing "@bl" puts
 * "Blog Updater" above "Studio Blog Updater" above "Old Blog Archive". Ties fall back to alphabetical
 * order so the list does not reshuffle between keystrokes.
 */
export const matchMentions = (
  names: readonly string[],
  query: string,
  limit = 8
): string[] => {
  const needle = query.trim().toLowerCase();
  const scored: Array<{ name: string; rank: number }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const haystack = name.toLowerCase();
    if (!needle) {
      scored.push({ name, rank: 3 });
      continue;
    }
    if (haystack.startsWith(needle)) {
      scored.push({ name, rank: 0 });
      continue;
    }
    // A word start anywhere in the name: "Blog" in "Studio Blog Updater".
    const wordStart = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack);
    if (wordStart) {
      scored.push({ name, rank: 1 });
      continue;
    }
    if (haystack.includes(needle)) scored.push({ name, rank: 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((entry) => entry.name);
};

/**
 * The text and caret position after accepting `name` for `mention`.
 *
 * A trailing space is added so typing continues naturally, and the caret lands after it — without
 * that, the popup would immediately reopen on the just-inserted name.
 */
export const applyMention = (
  text: string,
  mention: MentionQuery,
  name: string
): { text: string; cursor: number } => {
  const inserted = `@${name} `;
  const next = text.slice(0, mention.start) + inserted + text.slice(mention.end);
  return { text: next, cursor: mention.start + inserted.length };
};
