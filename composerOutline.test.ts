import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The composer's focus outline must be **one edge**, not two.
 *
 * This is the third time it has been got wrong, so the rule is pinned here rather than left to
 * whoever next reaches for `ring` or `outline`.
 *
 * What went wrong each time:
 *
 *  1. A wide ring keyed on `:focus-visible`. Chromium sets `:focus-visible` for a *clicked* text
 *     field too (it takes keyboard input), so a second, offset outline painted for the whole of
 *     normal writing.
 *  2. A 1px **inset** ring, to read as the border thickening. Subtler, still wrong: the border and
 *     the inset ring are two concentric arcs 1px apart, and at a 14px radius they round to
 *     different pixel columns — measured on the rendered box, the hairline carried a gap across the
 *     top (`#+#` in rows 17-18 of the corner), which is the "weird pixeliness" it looked like.
 *
 * The fix is a single border that gets thicker: one shape, one set of pixels to round.
 */
const source = fs.readFileSync(path.join(import.meta.dir, 'src/components/ChatView.tsx'), 'utf8');

/** The composer's own class list — the only element in the file with this exact marker. */
const composerClassName = (): string => {
  const match = source.match(/className="(flex flex-col rounded-xl border bg-background[^"]*)"/);
  if (!match) throw new Error('composer class not found in ChatView.tsx');
  return match[1]!;
};

describe('the composer outline', () => {
  test('focus thickens the border rather than adding a ring', () => {
    const cls = composerClassName();
    // One edge, thicker. `!border-2` beats the base `border` on the same element.
    expect(cls).toContain('has-focus-visible:!border-2');
    expect(cls).toContain('has-focus-visible:border-ring');
  });

  test('nothing draws a second shape around or inside the border', () => {
    const cls = composerClassName();
    // An inset ring is the failure this file documents at length; a plain ring/outline is the one
    // before it. Either would put a second curve next to the border's.
    expect(cls).not.toContain('inset-ring');
    expect(cls).not.toMatch(/\bhas-focus-visible:ring-/);
    expect(cls).not.toMatch(/\bhas-focus-visible:outline\b/);
  });

  test('a plain click still differs from a keyboard focus, by weight', () => {
    // `focus-within` (any focus, including a row control clicked) tints the border; only
    // `:focus-visible` thickens it. That distinction is the one part of the earlier attempts that
    // was right and is deliberately kept.
    const cls = composerClassName();
    expect(cls).toContain('focus-within:border-ring/55');
    expect(cls).toContain('has-focus-visible:border-ring');
  });
});
